export const AGNES_AI_DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com/v1';
export const AGNES_AI_MODELS = [
  { id: 'agnes-3.0-pro', label: 'Agnes 3.0 Pro (Mô hình chính, tối ưu dịch thuật video)', recommended: true },
  { id: 'agnes-2.5-pro', label: 'Agnes 2.5 Pro (Tốc độ cao)' }
];

export const ROUTER_LOCAL_BASE_URL = 'http://localhost:20128/v1';

export class AgnesAiManager {
  private apiKeys: string[] = [];
  private keyStatuses: Map<number, { status: 'active' | 'exhausted'; expiresAt: number }> = new Map();
  private currentIndex = 0;
  private baseUrl: string;

  constructor(config: { baseUrl?: string; apiKeys?: string[] } = {}) {
    this.baseUrl = (config.baseUrl || AGNES_AI_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.updateApiKeys(config.apiKeys || []);
  }

  public normalizeApiKeys(keys: unknown): string[] {
    if (!keys) return [];
    if (Array.isArray(keys)) {
      return keys.map(k => String(k).trim()).filter(k => k.length > 0);
    }
    return String(keys).split(/[\n,]/).map(k => k.trim()).filter(k => k.length > 0);
  }

  public updateApiKeys(keys: unknown): void {
    const raw = this.normalizeApiKeys(keys);
    this.apiKeys = Array.from(new Set(raw));
    this.currentIndex = 0;
    this.keyStatuses.clear();
    for (let i = 0; i < this.apiKeys.length; i++) {
      this.keyStatuses.set(i, { status: 'active', expiresAt: 0 });
    }
  }

  public getNextActiveKey(): { key: string; index: number } {
    if (this.apiKeys.length === 0) {
      throw new Error('Chưa có API Key Agnes AI nào được cấu hình trong danh sách.');
    }
    const now = Date.now();
    const total = this.apiKeys.length;
    for (let i = 0; i < total; i++) {
      const idx = (this.currentIndex + i) % total;
      const status = this.keyStatuses.get(idx);
      if (status) {
        if (status.status === 'exhausted' && status.expiresAt <= now) {
          status.status = 'active';
        }
        if (status.status === 'active' && this.apiKeys[idx]) {
          this.currentIndex = (idx + 1) % total;
          return { key: this.apiKeys[idx], index: idx };
        }
      }
    }
    throw new Error('Toàn bộ API Key Agnes AI trong pool đều đã hết hạn mức (Quota Exhausted).');
  }

  public markKeyExhausted(index: number): void {
    const status = this.keyStatuses.get(index);
    if (status) {
      status.status = 'exhausted';
      status.expiresAt = Date.now() + 15 * 60 * 1000; // 15 mins cooldown
    }
  }

  public static async testApiKey(apiKey: string, baseUrl: string = AGNES_AI_DEFAULT_BASE_URL): Promise<{ valid: boolean; error?: string }> {
    const trimmed = apiKey.trim();
    if (!trimmed) return { valid: false, error: 'API Key trống' };
    const cleanBase = baseUrl.replace(/\/+$/, '');
    try {
      const response = await fetch(`${cleanBase}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmed}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (response.ok) {
        return { valid: true };
      }
      if (response.status === 429 || response.status === 402) {
        return { valid: false, error: `Hết hạn mức API (HTTP ${response.status})` };
      }
      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: `API Key không hợp lệ (HTTP ${response.status})` };
      }
      return { valid: false, error: `Lỗi kết nối (HTTP ${response.status})` };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public async chatCompletion(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const maxAttempts = Math.min(this.apiKeys.length, 5);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let keyInfo: { key: string; index: number };
      try {
        keyInfo = this.getNextActiveKey();
      } catch (err) {
        throw lastError ?? err;
      }

      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${keyInfo.key}`
          },
          body: JSON.stringify(payload),
          signal
        });

        if (response.status === 429 || response.status === 402) {
          this.markKeyExhausted(keyInfo.index);
          lastError = new Error(`Agnes AI key #${keyInfo.index + 1} hết quota: HTTP ${response.status}`);
          continue; // Failover to next key
        }

        return response;
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error('Không thể hoàn thành yêu cầu qua Agnes AI pool.');
  }
}

let sharedAgnesAi: AgnesAiManager | null = null;
export function getSharedAgnesAiManager(config?: { baseUrl?: string; apiKeys?: string[] }): AgnesAiManager {
  if (!sharedAgnesAi) {
    sharedAgnesAi = new AgnesAiManager(config);
  } else if (config?.apiKeys) {
    sharedAgnesAi.updateApiKeys(config.apiKeys);
  }
  return sharedAgnesAi;
}
