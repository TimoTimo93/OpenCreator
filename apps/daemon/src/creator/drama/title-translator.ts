import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AgnesAiManager } from '../llm/agnes-ai.js';

/**
 * Dịch tên phim của các nguồn Hồng Quả / Tây Phạn / Hà Mã sang tiếng Việt.
 *
 * Tên phim gốc là tiếng Trung và được cố ý giữ nguyên ở biên dữ liệu (xem
 * GLOSSARY của thành phần Hồng Quả). Muốn hiển thị tiếng Việt thì phải dịch bằng
 * mô hình ngôn ngữ, nên phần này nằm ở daemon: dùng đúng cấu hình `llm` của
 * người dùng, gom theo lô và lưu đệm xuống đĩa để không gọi lại mỗi lần mở trang.
 *
 * Nguyên tắc an toàn: mọi lỗi mạng/mô hình đều bị nuốt và trả về bản đệm hiện
 * có — UI luôn giữ được tên gốc khi chưa dịch được.
 */

export type DramaTitleTargetLanguage = 'vi' | 'en';

export type DramaTitleTranslator = {
  translate(titles: readonly string[], language: DramaTitleTargetLanguage): Promise<Record<string, string>>;
};

export type DramaTitleTranslatorOptions = {
  /** Đọc cấu hình dịch vụ AI của người dùng (đã bỏ credential nếu cần). */
  readLlmConfig(): Promise<{
    baseUrl: string;
    apiKey: string;
    model: string;
    agnesAi?: { baseUrl: string; apiKeys: string[]; model: string };
    failoverToAgnes?: boolean;
  }>;
  /** Vị trí tệp đệm; bỏ trống thì chỉ đệm trong bộ nhớ. */
  cachePath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Số tên phim mỗi lượt gọi mô hình. */
  batchSize?: number;
  log?(message: string): void;
};

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CACHE_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BATCH_SIZE = 40;

type CacheFile = {
  version: number;
  entries: Record<string, Record<string, string>>;
};

export function createDramaTitleTranslator(options: DramaTitleTranslatorOptions): DramaTitleTranslator {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const cache = new Map<string, Map<string, string>>();
  let loaded = false;
  let pending: Promise<void> | null = null;

  async function load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    if (options.cachePath === undefined) return;
    try {
      const raw = JSON.parse(await readFile(options.cachePath, 'utf8')) as CacheFile;
      if (raw?.version !== CACHE_VERSION || typeof raw.entries !== 'object' || raw.entries === null) return;
      for (const [language, entries] of Object.entries(raw.entries)) {
        if (typeof entries !== 'object' || entries === null) continue;
        const bucket = new Map<string, string>();
        for (const [source, target] of Object.entries(entries)) {
          if (typeof target === 'string' && target !== '') bucket.set(source, target);
        }
        cache.set(language, bucket);
      }
    } catch {
      // Đệm hỏng/không tồn tại: bắt đầu lại từ đầu, không phải lỗi.
    }
  }

  function schedulePersist(): Promise<void> {
    if (options.cachePath === undefined) return Promise.resolve();
    const cachePath = options.cachePath;
    const previous = pending ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        const entries: Record<string, Record<string, string>> = {};
        for (const [language, bucket] of cache) entries[language] = Object.fromEntries(bucket);
        await mkdir(dirname(cachePath), { recursive: true });
        const temp = `${cachePath}.tmp`;
        await writeFile(temp, JSON.stringify({ version: CACHE_VERSION, entries }), 'utf8');
        await rename(temp, cachePath);
      } catch (error) {
        options.log?.(`drama title cache write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    pending = next;
    return next;
  }

  async function callModel(titles: string[], language: DramaTitleTargetLanguage): Promise<Record<string, string>> {
    const config = await options.readLlmConfig();
    const targetName = language === 'en' ? 'English' : 'Vietnamese';
    const prompt = [
      `You translate short-drama titles from Chinese into ${targetName}.`,
      `Return ONLY a JSON object mapping each original Chinese title (verbatim key) to its ${targetName} translation.`,
      'Keep translations short and natural for a streaming catalogue. Do not add explanations.',
      'Titles:',
      JSON.stringify(titles)
    ].join('\n');
    const payload = {
      model: config.model,
      temperature: 0,
      messages: [
        { role: 'system', content: `You are a professional subtitle translator. Reply with a JSON object only.` },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    };
    const agnesKeys = (config.agnesAi?.apiKeys ?? []).filter(key => key.trim() !== '');
    const useAgnes = config.failoverToAgnes === true && agnesKeys.length > 0;

    let response: Response | null = null;
    let primaryError: unknown;
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    if (baseUrl !== '') {
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey.trim() === '' ? {} : { Authorization: `Bearer ${config.apiKey.trim()}` })
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok && response.status !== 429 && response.status !== 402) response = null;
      } catch (error) {
        primaryError = error;
        response = null;
      }
    }

    if ((response === null || response.status === 429 || response.status === 402) && useAgnes) {
      try {
        const manager = new AgnesAiManager({ baseUrl: config.agnesAi?.baseUrl, apiKeys: agnesKeys });
        response = await manager.chatCompletion({
          ...payload,
          model: config.agnesAi?.model?.trim() || payload.model
        }, AbortSignal.timeout(timeoutMs));
      } catch (error) {
        primaryError = primaryError ?? error;
        response = null;
      }
    }

    if (response === null || !response.ok) {
      throw primaryError instanceof Error
        ? primaryError
        : new Error(`title translation request failed with HTTP ${response?.status ?? 'n/a'}`);
    }

    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') return {};
    return parseTranslationPayload(content, titles);
  }

  return {
    async translate(titles, language) {
      await load();
      const requested = [...new Set(titles.filter(title => typeof title === 'string' && title.trim() !== ''))];
      const result: Record<string, string> = {};
      if (requested.length === 0) return result;

      const bucket = cache.get(language) ?? new Map<string, string>();
      cache.set(language, bucket);

      const missing: string[] = [];
      for (const title of requested) {
        const cached = bucket.get(title);
        if (cached !== undefined) result[title] = cached;
        else if (CJK.test(title)) missing.push(title);
      }
      if (missing.length === 0) return result;

      for (let index = 0; index < missing.length; index += batchSize) {
        const batch = missing.slice(index, index + batchSize);
        try {
          const translated = await callModel(batch, language);
          for (const [source, target] of Object.entries(translated)) {
            const text = typeof target === 'string' ? target.trim() : '';
            if (text === '') continue;
            bucket.set(source, text);
            result[source] = text;
          }
        } catch (error) {
          options.log?.(`drama title translation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await schedulePersist();
      return result;
    }
  };
}

/** Bóc JSON ra khỏi phản hồi mô hình (chấp nhận cả trường hợp bọc trong ```json). */
export function parseTranslationPayload(content: string, requested: readonly string[]): Record<string, string> {
  const withoutFence = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const wanted = new Set(requested);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!wanted.has(key)) continue;
    const text = typeof value === 'string' ? value.trim() : '';
    if (text !== '') out[key] = text;
  }
  return out;
}
