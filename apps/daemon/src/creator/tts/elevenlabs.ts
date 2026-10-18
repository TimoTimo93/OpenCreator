import crypto from 'node:crypto';

export type ElevenLabsVoice = {
  id: string;
  name: string;
  gender: 'female' | 'male';
  label: string;
  genderLabel: string;
  language: string;
  description: string;
  recommended?: boolean;
};

export const VIETNAMESE_VOICES: Record<string, ElevenLabsVoice> = {
  Giang: {
    id: 'f5q6kePPoQAjCPYG6moa',
    name: 'Giang',
    gender: 'female',
    label: 'Giang (Nữ)',
    genderLabel: 'Nữ',
    language: 'Vietnamese',
    description: 'Giang - Giọng đọc nữ, tự nhiên, rõ ràng',
    recommended: true
  },
  Tham: {
    id: '0ggMuQ1r9f9jqBu50nJn',
    name: 'Thắm',
    gender: 'female',
    label: 'Thắm (Nữ)',
    genderLabel: 'Nữ',
    language: 'Vietnamese',
    description: 'Thắm - Giọng đọc nữ, sâu ấm, phù hợp cho audiobooks, narration'
  },
  Hien: {
    id: 'jdlxsPOZOHdGEfcItXVu',
    name: 'Hiền',
    gender: 'female',
    label: 'Hiền (Nữ)',
    genderLabel: 'Nữ',
    language: 'Vietnamese',
    description: 'Hiền - Giọng đọc nữ, nhẹ nhàng, thân thiện'
  },
  Duc: {
    id: 'XBDAUT8ybuJTTCoOLSUj',
    name: 'Đức',
    gender: 'male',
    label: 'Đức (Nam)',
    genderLabel: 'Nam',
    language: 'Vietnamese',
    description: 'Đức - Giọng đọc nam, rõ ràng, phù hợp cho narration, bài thuyết trình'
  },
  Tung: {
    id: '3VnrjnYrskPMDsapTr8X',
    name: 'Tùng',
    gender: 'male',
    label: 'Tùng (Nam)',
    genderLabel: 'Nam',
    language: 'Vietnamese',
    description: 'Tùng - Giọng đọc nam, tự nhiên, khỏe khoắn'
  },
  Ninh: {
    id: 'aN7cv9yXNrfIR87bDmyD',
    name: 'Ninh',
    gender: 'male',
    label: 'Ninh (Nam)',
    genderLabel: 'Nam',
    language: 'Vietnamese',
    description: 'Ninh - Giọng đọc nam, nghẹn nồng, phù hợp cho storytelling, video'
  }
};

export const VOICE_ID_MAP: Record<string, ElevenLabsVoice> = {};
for (const voice of Object.values(VIETNAMESE_VOICES)) {
  VOICE_ID_MAP[voice.id] = voice;
}

export const DEFAULT_MODELS = {
  eleven_multilingual_v2: { label: 'eleven_multilingual_v2 (Đa ngôn ngữ chất lượng cao)', stable: true },
  eleven_turbo_v2_5: { label: 'eleven_turbo_v2_5 (Tối ưu tốc độ cao)', stable: true },
  eleven_v4: { label: 'eleven_v4 (Cơ bản)', stable: true }
};

export const DEFAULT_OUTPUT_FORMATS = [
  { value: 'mp3_44100_128', label: 'MP3 44.1kHz 128kbps' },
  { value: 'mp3_44100_192', label: 'MP3 44.1kHz 192kbps' },
  { value: 'opus_48000_128', label: 'Opus 48kHz 128kbps' }
];

export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
export const ELEVENLABS_API_KEY_HEADER = 'xi-api-key';
export const QUOTA_ERROR_CODES = [429, 402, 456];
export const QUOTA_ERROR_KEYWORDS = ['quota_exceeded', 'rate_limit_exceeded', 'insufficient_quota', 'overloaded_error', 'resource_exhausted', 'rate_limit'];
export const KEY_EXHAUST_COOLDOWN_MS = 15 * 60 * 1000;

/** Lấy lý do từ chối trong JSON lỗi của ElevenLabs (ví dụ "Invalid API key"). */
export function elevenLabsRejectReason(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as { detail?: { message?: string } | string };
    const message = typeof parsed.detail === 'string' ? parsed.detail : parsed.detail?.message;
    if (typeof message === 'string' && message.trim()) return ` — ElevenLabs: “${message.trim()}”`;
  } catch {
    if (trimmed.length <= 160 && /[A-Za-z]/.test(trimmed)) return ` — ElevenLabs: “${trimmed}”`;
  }
  return '';
}

export type KeyStatus = {
  status: 'active' | 'exhausted';
  expiresAt: number;
};

export class ElevenLabsTTS {
  private apiKeys: string[] = [];
  private keyStatuses: Map<number, KeyStatus> = new Map();
  private currentKeyIndex = 0;
  private baseUrl: string;
  private defaultModel: string;
  private defaultVoiceId: string;
  private cooldownTimer: NodeJS.Timeout | null = null;

  constructor(config: {
    baseUrl?: string;
    apiKeys?: string[];
    model?: string;
    defaultVoiceId?: string;
  } = {}) {
    this.baseUrl = config.baseUrl || ELEVENLABS_API_BASE;
    this.defaultModel = config.model || 'eleven_multilingual_v2';
    this.defaultVoiceId = config.defaultVoiceId || 'f5q6kePPoQAjCPYG6moa';
    this.updateApiKeys(config.apiKeys || []);
  }

  public normalizeApiKeys(keys: unknown): string[] {
    if (!keys) return [];
    if (Array.isArray(keys)) {
      return keys.map(k => String(k).trim()).filter(k => k.length > 0);
    }
    return String(keys).split(/[\n,]/).map(k => k.trim()).filter(k => k.length > 0);
  }

  public updateApiKeys(newKeys: unknown): void {
    const raw = this.normalizeApiKeys(newKeys);
    // Deduplicate keys
    this.apiKeys = Array.from(new Set(raw));
    this.currentKeyIndex = 0;
    this.keyStatuses.clear();
    for (let i = 0; i < this.apiKeys.length; i++) {
      this.keyStatuses.set(i, { status: 'active', expiresAt: 0 });
    }
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  public hasValidKeys(): boolean {
    const now = Date.now();
    for (const [idx, status] of this.keyStatuses.entries()) {
      if (status.status === 'exhausted' && status.expiresAt <= now) {
        status.status = 'active';
      }
      if (status.status === 'active' && this.apiKeys[idx]) return true;
    }
    return false;
  }

  public getNextActiveKey(): { key: string; index: number } {
    if (this.apiKeys.length === 0) {
      throw new Error('Chưa cấu hình API Key ElevenLabs nào. Vui lòng thêm ít nhất 1 key trong Cài đặt Dịch vụ AI.');
    }
    const now = Date.now();
    const totalKeys = this.apiKeys.length;
    for (let attempt = 0; attempt < totalKeys; attempt++) {
      const idx = (this.currentKeyIndex + attempt) % totalKeys;
      const status = this.keyStatuses.get(idx);
      if (status) {
        if (status.status === 'exhausted' && status.expiresAt <= now) {
          status.status = 'active';
        }
        if (status.status === 'active' && this.apiKeys[idx]) {
          this.currentKeyIndex = (idx + 1) % totalKeys;
          return { key: this.apiKeys[idx], index: idx };
        }
      }
    }
    throw new Error('Tất cả API Key ElevenLabs trong danh sách đều đã hết hạn mức (Quota Exhausted).');
  }

  public isQuotaError(status: number, message: string = ''): boolean {
    if (QUOTA_ERROR_CODES.includes(status)) return true;
    const lower = message.toLowerCase();
    return QUOTA_ERROR_KEYWORDS.some(kw => lower.includes(kw));
  }

  public markKeyExhausted(index: number): void {
    const status = this.keyStatuses.get(index);
    if (status) {
      status.status = 'exhausted';
      status.expiresAt = Date.now() + KEY_EXHAUST_COOLDOWN_MS;
    }
  }

  public static async testApiKey(apiKey: string, baseUrl: string = ELEVENLABS_API_BASE): Promise<{ valid: boolean; error?: string; remainingQuota?: number }> {
    const trimmed = apiKey.trim();
    if (!trimmed) return { valid: false, error: 'API Key trống' };    try {
      const url = `${baseUrl.replace(/\/+$/, '')}/v1/user`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { [ELEVENLABS_API_KEY_HEADER]: trimmed },
        signal: AbortSignal.timeout(10000)
      });
      if (response.ok) {
        const data = await response.json() as { subscription?: { character_count?: number; character_limit?: number } };
        const used = data.subscription?.character_count ?? 0;
        const limit = data.subscription?.character_limit ?? 0;
        const remaining = Math.max(0, limit - used);
        return { valid: true, remainingQuota: remaining };
      }
      if (QUOTA_ERROR_CODES.includes(response.status)) {
        return { valid: false, error: `Hết hạn mức (HTTP ${response.status})` };
      }
      // Trả kèm lý do từ ElevenLabs (ví dụ "Invalid API key") để người dùng tự kiểm
      // tra được key trong khi máy chủ chỉ nói chung chung HTTP 40x.
      return { valid: false, error: `Lỗi xác thực (HTTP ${response.status})${elevenLabsRejectReason(await response.text())}` };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public async generateAudio(text: string, options: {
    voiceId?: string;
    model?: string;
    speed?: number;
    format?: 'mp3' | 'wav';
    signal?: AbortSignal;
  } = {}): Promise<{ content: Buffer; format: 'mp3' | 'wav' }> {
    const resolvedVoiceId = options.voiceId || this.defaultVoiceId || 'f5q6kePPoQAjCPYG6moa';
    const resolvedModel = options.model || this.defaultModel || 'eleven_multilingual_v2';
    const outputFormat = options.format === 'wav' ? 'pcm_44100' : 'mp3_44100_128';

    let lastError: Error | null = null;
    const maxAttempts = Math.min(this.apiKeys.length, 5);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let keyInfo: { key: string; index: number };
      try {
        keyInfo = this.getNextActiveKey();
      } catch (err) {
        throw lastError ?? err;
      }

      const url = new URL(`v1/text-to-speech/${resolvedVoiceId}`, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
      url.searchParams.set('output_format', outputFormat);

      try {
        const body: Record<string, unknown> = {
          text,
          model_id: resolvedModel,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true
          }
        };

        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [ELEVENLABS_API_KEY_HEADER]: keyInfo.key
          },
          body: JSON.stringify(body),
          signal: options.signal
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          if (this.isQuotaError(response.status, errText)) {
            this.markKeyExhausted(keyInfo.index);
            lastError = new Error(`ElevenLabs key #${keyInfo.index + 1} hết quota: HTTP ${response.status}`);
            continue; // Rotate to next key
          }
          throw new Error(`ElevenLabs HTTP ${response.status}: ${errText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const content = Buffer.from(arrayBuffer);
        return { content, format: options.format === 'wav' ? 'wav' : 'mp3' };
      } catch (err) {
        if (options.signal?.aborted) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error('Không thể tạo audio từ ElevenLabs với các API Key hiện có.');
  }

  public getVietnameseVoices(): ElevenLabsVoice[] {
    return Object.values(VIETNAMESE_VOICES);
  }
}

let sharedElevenLabs: ElevenLabsTTS | null = null;
export function getSharedElevenLabsTTS(config?: {
  baseUrl?: string;
  apiKeys?: string[];
  model?: string;
  defaultVoiceId?: string;
}): ElevenLabsTTS {
  if (!sharedElevenLabs) {
    sharedElevenLabs = new ElevenLabsTTS(config);
  } else if (config) {
    if (config.apiKeys) sharedElevenLabs.updateApiKeys(config.apiKeys);
  }
  return sharedElevenLabs;
}
