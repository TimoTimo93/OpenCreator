import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

/**
 * Tổng hợp giọng đọc bằng Edge TTS (Read Aloud) — miễn phí, không cần khóa API.
 *
 * Dùng khi provider TTS mà người dùng cấu hình không chạy được và tuyến Edge TTS
 * của gateway cục bộ cũng hỏng: nhờ vậy video dịch vẫn có lồng tiếng. Giọng neural
 * của Microsoft, hỗ trợ sẵn tiếng Việt (vi-VN-HoaiMyNeural / vi-VN-NamMinhNeural).
 *
 * Mọi yêu cầu dùng chung một kết nối WebSocket và được xếp hàng tuần tự: dịch vụ
 * đọc của Microsoft giới hạn tần suất nếu mở quá nhiều kết nối, mà giai đoạn lồng
 * tiếng lại gọi tổng hợp cho từng đoạn phụ đề.
 */

export type EdgeTtsEngine = {
  synthesize(input: {
    text: string;
    voice: string;
    /** Tốc độ tương đối, ví dụ 1.1 = nhanh hơn 10%. */
    speed?: number;
    timeoutMs?: number;
  }): Promise<Buffer>;
  close(): Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2;
const IDLE_CLOSE_MS = 60_000;

export function createEdgeTtsEngine(options?: {
  /** Số lần thử lại khi tổng hợp lỗi (mặc định 2). */
  retries?: number;
  /** Đóng kết nối sau khi rảnh bao lâu (mặc định 60 giây). */
  idleCloseMs?: number;
}): EdgeTtsEngine {
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const idleCloseMs = options?.idleCloseMs ?? IDLE_CLOSE_MS;
  let client: MsEdgeTTS | undefined;
  let currentVoice: string | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const dropClient = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    const previous = client;
    client = undefined;
    currentVoice = undefined;
    previous?.close();
  };

  const scheduleIdleClose = (): void => {
    if (idleCloseMs <= 0) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(dropClient, idleCloseMs);
    idleTimer.unref?.();
  };

  const synthesizeOnce = async (input: {
    text: string;
    voice: string;
    speed?: number;
    timeoutMs: number;
  }): Promise<Buffer> => {
    const active = client ?? new MsEdgeTTS({
      connectionTimeoutMs: 15_000,
      synthesisTimeoutMs: input.timeoutMs
    });
    client = active;
    if (currentVoice !== input.voice) {
      await active.setMetadata(input.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      currentVoice = input.voice;
    }
    const { audioStream } = active.toStream(input.text, prosodyOptions(input.speed));
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Edge TTS tổng hợp quá lâu')),
        input.timeoutMs
      );
      audioStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      audioStream.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      audioStream.on('error', (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    const audio = Buffer.concat(chunks);
    if (audio.length === 0) throw new Error('Edge TTS không trả về dữ liệu âm thanh');
    return audio;
  };

  return {
    async synthesize(input) {
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const run = queue.then(async () => {
        let lastError: unknown;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          try {
            const audio = await synthesizeOnce({ ...input, timeoutMs });
            scheduleIdleClose();
            return audio;
          } catch (error) {
            lastError = error;
            // Kết nối có thể đã hỏng: đóng để lần sau mở lại từ đầu.
            dropClient();
            if (attempt < retries) {
              await delay(400 * (attempt + 1));
            }
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
    async close() {
      dropClient();
      await queue.catch(() => undefined);
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Đổi hệ số tốc độ kiểu OpenAI (`speed`) sang cú pháp prosody của SSML. */
export function rateOption(speed: number | undefined): string | undefined {
  if (speed === undefined || !Number.isFinite(speed) || speed <= 0) return undefined;
  const percent = Math.round((speed - 1) * 100);
  if (percent === 0) return undefined;
  const clamped = Math.max(-50, Math.min(100, percent));
  return `${clamped >= 0 ? '+' : ''}${clamped}%`;
}

/**
 * Tham số prosody gửi cho Edge TTS. Phải bỏ hẳn khóa khi không dùng: thư viện nội
 * suy giá trị vào SSML nên `rate: undefined` sẽ thành `rate="undefined"` và máy
 * chủ đóng kết nối giữa chừng.
 */
export function prosodyOptions(speed: number | undefined): { rate?: string } | undefined {
  const rate = rateOption(speed);
  return rate === undefined ? undefined : { rate };
}

/**
 * Tổng hợp thử một câu rất ngắn để biết Edge TTS có thật sự dùng được không
 * (dịch vụ đọc của Microsoft có lúc chặn theo IP/token).
 */
export function createEdgeTtsProbe(
  engine: EdgeTtsEngine,
  voice = 'vi-VN-HoaiMyNeural'
): () => Promise<boolean> {
  return async () => {
    try {
      const audio = await engine.synthesize({ text: 'Xin chào.', voice, timeoutMs: 20_000 });
      return audio.length > 0;
    } catch {
      return false;
    }
  };
}
