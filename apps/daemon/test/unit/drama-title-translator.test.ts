import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDramaTitleTranslator,
  parseTranslationPayload
} from '../../src/creator/drama/title-translator.js';

let root = '';

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
  root = '';
});

function chatResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(payload) } }]
  }), { status, headers: { 'content-type': 'application/json' } });
}

const llm = {
  baseUrl: 'http://localhost:20128/v1',
  apiKey: '9router',
  model: 'ag/gemini-2.5-flash'
};

describe('drama title translator', () => {
  it('translates CJK titles through the configured model and caches the result', async () => {
    const fetchImpl = vi.fn(async () => chatResponse({ 京夜诱温: 'Kinh Dạ Dụ Ôn' }));
    const translator = createDramaTitleTranslator({ readLlmConfig: async () => llm, fetchImpl: fetchImpl as unknown as typeof fetch });

    const first = await translator.translate(['京夜诱温', 'Phim Hồng Quả'], 'vi');
    expect(first).toEqual({ 京夜诱温: 'Kinh Dạ Dụ Ôn' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:20128/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'ag/gemini-2.5-flash' });

    const second = await translator.translate(['京夜诱温'], 'vi');
    expect(second).toEqual({ 京夜诱温: 'Kinh Dạ Dụ Ôn' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the original title when the model fails instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const translator = createDramaTitleTranslator({ readLlmConfig: async () => llm, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(translator.translate(['惊悚'], 'vi')).resolves.toEqual({});
  });

  it('falls back to the Agnes AI key list when the primary endpoint is out of quota', async () => {
    const calls: string[] = [];
    const stub = vi.fn(async (url: string) => {
      calls.push(String(url));
      return String(url).includes('agnes-ai')
        ? chatResponse({ 志怪: 'Kỳ dị' })
        : new Response('quota', { status: 429 });
    });
    vi.stubGlobal('fetch', stub);
    try {
      const translator = createDramaTitleTranslator({
        readLlmConfig: async () => ({
          ...llm,
          agnesAi: { baseUrl: 'https://apihub.agnes-ai.com/v1', apiKeys: ['agnes-key-1'], model: 'agnes-3.0-pro' },
          failoverToAgnes: true
        })
      });

      await expect(translator.translate(['志怪'], 'vi')).resolves.toEqual({ 志怪: 'Kỳ dị' });
      expect(calls).toEqual([
        'http://localhost:20128/v1/chat/completions',
        'https://apihub.agnes-ai.com/v1/chat/completions'
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('persists the cache on disk and reuses it on the next run', async () => {
    root = await mkdtemp(join(tmpdir(), 'drama-titles-'));
    const cachePath = join(root, 'drama-title-cache.json');
    const fetchImpl = vi.fn(async () => chatResponse({ 剧情: 'Chính kịch' }));
    const first = createDramaTitleTranslator({ readLlmConfig: async () => llm, fetchImpl: fetchImpl as unknown as typeof fetch, cachePath });
    await expect(first.translate(['剧情'], 'vi')).resolves.toEqual({ 剧情: 'Chính kịch' });

    const stored = JSON.parse(await readFile(cachePath, 'utf8')) as { entries: Record<string, Record<string, string>> };
    expect(stored.entries.vi).toEqual({ 剧情: 'Chính kịch' });

    const offline = vi.fn(async () => new Response('down', { status: 503 }));
    const second = createDramaTitleTranslator({ readLlmConfig: async () => llm, fetchImpl: offline as unknown as typeof fetch, cachePath });
    await expect(second.translate(['剧情'], 'vi')).resolves.toEqual({ 剧情: 'Chính kịch' });
    expect(offline).not.toHaveBeenCalled();
  });

  it('parses fenced JSON and ignores keys that were not requested', () => {
    const parsed = parseTranslationPayload(
      '```json\n{"惊悚":"Giật gân","bịa":"sai"}\n```',
      ['惊悚']
    );
    expect(parsed).toEqual({ 惊悚: 'Giật gân' });
    expect(parseTranslationPayload('không phải json', ['惊悚'])).toEqual({});
  });
});
