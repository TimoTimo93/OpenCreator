export type VieNeuVoice = {
  id: string;
  name: string;
  label: string;
  gender: 'female' | 'male';
  model: string;
  recommended?: boolean;
};

export const VIENEU_VOICES: VieNeuVoice[] = [
  { id: 'Mai Anh', name: 'Mai Anh', label: 'Mai Anh (Nữ trẻ - v3 Turbo)', gender: 'female', model: 'v3turbo', recommended: true },
  { id: 'Kim Thanh', name: 'Kim Thanh', label: 'Kim Thanh (Nữ ấm áp - v3 Turbo)', gender: 'female', model: 'v3turbo' },
  { id: 'Adam', name: 'Adam', label: 'Adam (Nam trầm - v3 Turbo)', gender: 'male', model: 'v3turbo' },
  { id: 'Minh Triết', name: 'Minh Triết', label: 'Minh Triết (Nam dõng dạc - v3 Turbo)', gender: 'male', model: 'v3turbo' },
  { id: 'Mỹ Duyên', name: 'Mỹ Duyên', label: 'Mỹ Duyên (Nữ truyền cảm - v3 Turbo)', gender: 'female', model: 'v3turbo' },
  { id: 'default_female', name: 'Nữ trẻ chuẩn', label: 'Nữ trẻ chuẩn (v2)', gender: 'female', model: 'v2' },
  { id: 'default_male', name: 'Nam trung niên chuẩn', label: 'Nam trung niên chuẩn (v2)', gender: 'male', model: 'v2' }
];

export const DEFAULT_VIENEU_BASE_URL = 'http://127.0.0.1:7860';

export class VieNeuTTS {
  private baseUrl: string;
  private defaultVoiceId: string;
  private defaultModel: string;

  constructor(config: {
    baseUrl?: string;
    defaultVoiceId?: string;
    model?: string;
  } = {}) {
    this.baseUrl = (config.baseUrl || DEFAULT_VIENEU_BASE_URL).replace(/\/+$/, '');
    this.defaultVoiceId = config.defaultVoiceId || 'Mai Anh';
    this.defaultModel = config.model || 'v3turbo';
  }

  public static async testConnection(baseUrl: string = DEFAULT_VIENEU_BASE_URL): Promise<{ available: boolean; error?: string }> {
    try {
      const cleanUrl = baseUrl.replace(/\/+$/, '');
      const response = await fetch(`${cleanUrl}/`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      return { available: response.status < 500 };
    } catch (err) {
      return { available: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public async generateAudio(text: string, options: {
    voiceId?: string;
    model?: string;
    speed?: number;
    signal?: AbortSignal;
  } = {}): Promise<{ content: Buffer; format: 'wav' | 'mp3' }> {
    const voiceId = options.voiceId || this.defaultVoiceId;
    const cleanBase = this.baseUrl;

    // First attempt: try OpenAI-compatible /v1/audio/speech endpoint (LMDeploy or VieNeu fast server)
    try {
      const response = await fetch(`${cleanBase}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model || this.defaultModel,
          input: text,
          voice: voiceId,
          speed: options.speed ?? 1.0
        }),
        signal: options.signal
      });
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        return { content: Buffer.from(arrayBuffer), format: 'mp3' };
      }
    } catch {
      // Fallback to Gradio / custom endpoint
    }

    // Second attempt: Gradio API v5 wrapper
    try {
      const data = [text, voiceId, null, '', 'preset_mode', 'Standard', true, 32, 0.8, 256, true, null];
      const started = await fetch(`${cleanBase}/gradio_api/call/wrapper`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
        signal: options.signal
      });

      if (started.ok) {
        const startedJson = await started.json() as { event_id?: string };
        const eventId = startedJson.event_id;
        if (eventId) {
          const streamed = await fetch(`${cleanBase}/gradio_api/call/wrapper/${encodeURIComponent(eventId)}`, {
            signal: options.signal
          });
          const streamText = await streamed.text();
          const matches = [...streamText.matchAll(/event:\s*(?:generating|complete)\s*\r?\ndata:\s*(\[[\s\S]*?\])/g)];
          for (let i = matches.length - 1; i >= 0; i--) {
            try {
              const rawData = matches[i]?.[1];
              if (!rawData) continue;
              const parsed = JSON.parse(rawData);
              const audioObj = parsed?.[0];
              if (audioObj?.url || audioObj?.path) {
                const audioUrl = audioObj.url || `${cleanBase}/gradio_api/file=${encodeURIComponent(audioObj.path)}`;
                const audioRes = await fetch(audioUrl, { signal: options.signal });
                if (audioRes.ok) {
                  const buf = Buffer.from(await audioRes.arrayBuffer());
                  return { content: buf, format: 'wav' };
                }
              }
            } catch {}
          }
        }
      }
    } catch {
      // ignore
    }

    throw new Error(
      `Không thể kết nối với VieNeu-TTS tại ${cleanBase}. Vui lòng kiểm tra dịch vụ VieNeu-TTS (python serve.py) đã được khởi chạy.`
    );
  }

  public getVoices(): VieNeuVoice[] {
    return VIENEU_VOICES;
  }
}

let sharedVieNeu: VieNeuTTS | null = null;
export function getSharedVieNeuTTS(config?: { baseUrl?: string; defaultVoiceId?: string }): VieNeuTTS {
  if (!sharedVieNeu) {
    sharedVieNeu = new VieNeuTTS(config);
  }
  return sharedVieNeu;
}
