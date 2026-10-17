import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

/**
 * Tổng hợp giọng đọc bằng VieNeu-TTS v3 Turbo — bộ TTS tiếng Việt chất lượng cao
 * chạy hoàn toàn cục bộ trên CPU (ONNX Runtime, không cần GPU, không cần khóa API).
 *
 * Vì sao cần lớp này: giai đoạn lồng tiếng của Dịch video chạy bên trong CLI Go
 * `krillinai-cli.exe`, mà CLI chỉ biết gọi endpoint TTS kiểu OpenAI. VieNeu là một
 * SDK Python, không có trong CLI. Lớp này chạy một tiến trình Python phụ (sidecar)
 * phục vụ đúng `POST /v1/audio/speech` để cổng TTS cục bộ của daemon chuyển tiếp
 * sang, nhờ đó video được lồng giọng VieNeu thay vì Edge TTS máy móc.
 *
 * Thứ tự ưu tiên khi tìm runtime:
 * 1. Máy chủ VieNeu do người dùng tự cấu hình (`tts.vieneu.baseUrl` đang chạy).
 * 2. Biến môi trường `OPENCREATOR_VIENEU_PYTHON` / `OPENCREATOR_VIENEU_MODEL_DIR` /
 *    `OPENCREATOR_VIENEU_HF_HOME`.
 * 3. Runtime do OpenCreator quản lý tại `<runtimeDir>/vieneu`.
 * 4. Vài vị trí cài đặt VieNeu phổ biến trên máy (chỉ để tự nhận, có thể ghi đè).
 */

export type VieNeuSynthesisResult = {
  audio: Buffer;
  format: 'mp3' | 'wav';
};

export type VieNeuEngine = {
  /** Có sẵn sàng tổng hợp không (đã tìm thấy runtime hoặc máy chủ ngoài). */
  isAvailable(): Promise<boolean>;
  synthesize(input: {
    text: string;
    voice: string;
    speed?: number;
    timeoutMs?: number;
  }): Promise<VieNeuSynthesisResult>;
  close(): Promise<void>;
};

export type VieNeuRuntime = {
  python: string;
  modelDir: string;
  hfHome?: string;
};

/** Cấu hình VieNeu do người dùng đặt trong Cài đặt dịch vụ AI. */
export type VieNeuEngineConfig = {
  baseUrl?: string;
  defaultVoiceId?: string;
};

const DEFAULT_VOICE = 'Hải Đăng';
const MODEL_LOAD_TIMEOUT_MS = 180_000;
const SYNTHESIS_TIMEOUT_MS = 120_000;
const IDLE_CLOSE_MS = 5 * 60_000;
const FAILURE_COOLDOWN_MS = 60_000;
const HEALTH_POLL_MS = 500;

/** Tên file ONNX bắt buộc phải có để coi một thư mục là model v3 Turbo. */
const REQUIRED_MODEL_FILES = ['vieneu_prefill.onnx', 'vieneu_decode_step.onnx'];

/**
 * Giọng đọc dựng sẵn của VieNeu-TTS v3 Turbo (đồng bộ với SDK `vieneu`
 * `assets/voices_v3_turbo.json`, 25 giọng). Dùng để phân biệt giọng VieNeu với
 * giọng Edge TTS khi định tuyến tổng hợp.
 */
export const VIENEU_PRESET_VOICES = [
  'Adam bựa', 'Trúc Ly', 'Thiện Minh', 'Mai Anh', 'Hải Đăng', 'Thùy Dung',
  'Thiền Tâm Đức', 'Ngọc Huyền', 'Quang Sơn', 'Ngọc Trân',
  'Adam', 'Kim Thanh', 'Minh Triết', 'Minh Đức', 'Mỹ Duyên', 'Ngọc Linh',
  'Phạm Tuyên', 'Quốc Tuấn', 'Quỳnh Anh', 'Thanh Bình', 'Thái Sơn', 'Thục Đoan',
  'Xuân Vĩnh', 'Đoan Trang', 'Đức Trí'
] as const;

/** Có phải tên giọng dựng sẵn của VieNeu không. */
export function isVieNeuPresetVoice(voice: string): boolean {
  const name = voice.trim().toLowerCase();
  return VIENEU_PRESET_VOICES.some(candidate => candidate.toLowerCase() === name);
}

/**
 * Chọn giọng đọc cho VieNeu: giữ tên giọng yêu cầu nếu đúng là giọng dựng sẵn,
 * ngược lại dùng giọng mặc định (cũng phải là giọng dựng sẵn).
 *
 * Cần thiết vì giọng mặc định trong Cài đặt có thể là giọng của provider khác
 * (ví dụ `marin` của OpenAI) — VieNeu không đọc được và sẽ lỗi nếu truyền thẳng.
 */
export function resolveVieNeuVoice(requested: string, configuredDefault: string | undefined): string {
  const name = requested.trim();
  if (isVieNeuPresetVoice(name)) return name;
  const fallback = configuredDefault?.trim() ?? '';
  return isVieNeuPresetVoice(fallback) ? fallback : DEFAULT_VOICE;
}

export function createVieNeuEngine(options: {
  /** Thư mục dữ liệu của daemon, dùng cho runtime do OpenCreator quản lý. */
  runtimeDir: string;
  /** Đọc cấu hình TTS VieNeu của người dùng (máy chủ ngoài, giọng mặc định). */
  readConfig?: () => Promise<VieNeuEngineConfig | undefined>;
  /** Ghi đè đường dẫn Python (thường lấy từ biến môi trường). */
  python?: string;
  /** Ghi đè thư mục model ONNX. */
  modelDir?: string;
  /** Ghi đè thư mục cache HuggingFace. */
  hfHome?: string;
}): VieNeuEngine {
  let runtime: VieNeuRuntime | undefined;
  let runtimeResolved = false;
  let externalCache: { value: string | undefined; at: number } | undefined;

  let child: ChildProcess | undefined;
  let baseUrl: string | undefined;
  let starting: Promise<string> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let cooldownUntil = 0;
  let lastError: string | undefined;

  const resolveRuntime = (): VieNeuRuntime | undefined => {
    if (runtimeResolved) return runtime;
    runtimeResolved = true;
    runtime = discoverVieNeuRuntime({
      runtimeDir: options.runtimeDir,
      python: options.python,
      modelDir: options.modelDir,
      hfHome: options.hfHome
    });
    return runtime;
  };

  const readUserConfig = async (): Promise<VieNeuEngineConfig | undefined> => {
    if (options.readConfig === undefined) return undefined;
    try {
      return await options.readConfig();
    } catch {
      return undefined;
    }
  };

  const resolveVoice = async (requested: string): Promise<string> => {
    const config = await readUserConfig();
    return resolveVieNeuVoice(requested, config?.defaultVoiceId);
  };

  /**
   * Máy chủ VieNeu ngoài do người dùng cấu hình (nếu có và đang chạy). Kết quả
   * được nhớ tạm để không dội health-check mỗi lần tổng hợp.
   */
  const resolveExternalBaseUrl = async (): Promise<string | undefined> => {
    if (externalCache !== undefined && Date.now() - externalCache.at < 30_000) {
      return externalCache.value;
    }
    const config = await readUserConfig();
    const candidate = normalizeBaseUrl(config?.baseUrl);
    let resolved: string | undefined;
    if (candidate !== undefined && await isReachable(candidate)) resolved = candidate;
    externalCache = { value: resolved, at: Date.now() };
    return resolved;
  };

  const dropChild = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    const previous = child;
    child = undefined;
    baseUrl = undefined;
    if (previous !== undefined) {
      try {
        previous.kill();
      } catch {
        // Bỏ qua: tiến trình có thể đã thoát.
      }
    }
  };

  const scheduleIdleClose = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(dropChild, IDLE_CLOSE_MS);
    idleTimer.unref?.();
  };

  const ensureServer = async (): Promise<string> => {
    const external = await resolveExternalBaseUrl();
    if (external !== undefined) return external;
    if (baseUrl !== undefined && child !== undefined && child.exitCode === null) return baseUrl;
    if (starting !== undefined) return starting;
    starting = startSidecar();
    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  };

  const startSidecar = async (): Promise<string> => {
    const resolved = resolveRuntime();
    if (resolved === undefined) {
      throw new Error('Không tìm thấy runtime VieNeu-TTS trên máy này.');
    }
    const port = await findFreePort();
    const scriptDir = join(options.runtimeDir, 'vieneu');
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, 'vieneu_server.py');
    writeFileSync(scriptPath, VIENEU_SERVER_SCRIPT, 'utf8');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VIENEU_HOST: '127.0.0.1',
      VIENEU_PORT: String(port),
      VIENEU_ONNX_DIR: resolved.modelDir,
      ...(resolved.hfHome === undefined ? {} : { HF_HOME: resolved.hfHome }),
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1'
    };
    const logs: string[] = [];
    const record = (chunk: Buffer): void => {
      logs.push(chunk.toString('utf8'));
      if (logs.length > 40) logs.shift();
    };
    const spawned = spawn(resolved.python, [scriptPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    spawned.stdout?.on('data', record);
    spawned.stderr?.on('data', record);
    spawned.on('exit', code => {
      if (child === spawned) {
        child = undefined;
        baseUrl = undefined;
      }
      lastError = `VieNeu sidecar thoát với mã ${code ?? 'null'}: ${logs.join('').slice(-600)}`;
    });

    const origin = `http://127.0.0.1:${port}`;
    child = spawned;
    baseUrl = origin;
    try {
      await waitForHealth(origin, MODEL_LOAD_TIMEOUT_MS, () => spawned.exitCode);
    } catch (error) {
      dropChild();
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    return origin;
  };

  const markFailure = (): void => {
    // Chỉ nghỉ và đóng sidecar khi tiến trình đã chết hoặc chưa từng lên được;
    // nếu sidecar còn sống thì để đoạn phụ đề kế tiếp thử lại ngay.
    if (child === undefined || child.exitCode !== null) {
      dropChild();
      cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
    }
  };

  return {
    async isAvailable() {
      if (Date.now() < cooldownUntil) return false;
      if (await resolveExternalBaseUrl() !== undefined) return true;
      return resolveRuntime() !== undefined;
    },
    async synthesize(input) {
      const text = input.text.trim();
      if (text === '') throw new Error('Văn bản tổng hợp rỗng.');
      if (Date.now() < cooldownUntil) {
        throw new Error(lastError ?? 'VieNeu-TTS đang tạm nghỉ sau lỗi trước đó.');
      }
      const voice = await resolveVoice(input.voice);
      const timeoutMs = input.timeoutMs ?? SYNTHESIS_TIMEOUT_MS;
      try {
        const origin = await ensureServer();
        const audio = await requestSpeech(origin, {
          text,
          voice,
          speed: input.speed,
          timeoutMs
        });
        scheduleIdleClose();
        return audio;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        markFailure();
        throw error;
      }
    },
    async close() {
      dropChild();
      if (starting !== undefined) await starting.catch(() => undefined);
    }
  };
}

async function requestSpeech(
  origin: string,
  input: { text: string; voice: string; speed?: number; timeoutMs: number }
): Promise<VieNeuSynthesisResult> {
  const response = await fetch(`${origin}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'vieneu-v3-turbo',
      input: input.text,
      voice: input.voice,
      ...(input.speed === undefined ? {} : { speed: input.speed })
    }),
    signal: AbortSignal.timeout(input.timeoutMs)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`VieNeu-TTS trả về HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw new Error('VieNeu-TTS không trả về dữ liệu âm thanh.');
  return { audio, format: contentType.includes('mpeg') ? 'mp3' : 'wav' };
}

async function waitForHealth(
  origin: string,
  timeoutMs: number,
  exitCode: () => number | null
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitCode() !== null) throw new Error('Tiến trình VieNeu-TTS đã thoát khi đang nạp model.');
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const body = await response.json().catch(() => undefined) as { ready?: boolean } | undefined;
        if (body?.ready === true) return;
      }
    } catch {
      // Chưa lên: thử lại.
    }
    await delay(HEALTH_POLL_MS);
  }
  throw new Error('VieNeu-TTS không sẵn sàng kịp thời.');
}

export function discoverVieNeuRuntime(input: {
  runtimeDir: string;
  python?: string;
  modelDir?: string;
  hfHome?: string;
}): VieNeuRuntime | undefined {
  const managedRoot = join(input.runtimeDir, 'vieneu');
  const python = firstExistingFile([
    input.python,
    process.env.OPENCREATOR_VIENEU_PYTHON,
    join(managedRoot, '.venv', 'Scripts', 'python.exe'),
    'D:\\Program Files\\AutoEditVideo\\TimoAIStudio\\.venv\\Scripts\\python.exe',
    'D:\\program\\AutoEditVideo\\VieNeu-TTS\\.venv\\Scripts\\python.exe',
    'D:\\Agnes AI\\VieNeu-TTS\\.venv\\Scripts\\python.exe'
  ]);
  if (python === undefined) return undefined;

  const modelDir = firstVieNeuModelDir([
    input.modelDir,
    process.env.OPENCREATOR_VIENEU_MODEL_DIR,
    join(managedRoot, 'models', 'vieneu_v3_turbo'),
    'D:\\Program Files\\AutoEditVideo\\TimoAIStudio\\models\\vieneu_v3_turbo',
    'D:\\program\\AutoEditVideo\\VieNeu-TTS\\models\\vieneu_v3_turbo'
  ]);
  if (modelDir === undefined) return undefined;

  const hfHome = firstExistingDir([
    input.hfHome,
    process.env.OPENCREATOR_VIENEU_HF_HOME,
    process.env.HF_HOME,
    'D:\\program\\DevCaches\\huggingface'
  ]);

  return { python, modelDir, ...(hfHome === undefined ? {} : { hfHome }) };
}

function firstExistingFile(candidates: Array<string | undefined>): string | undefined {
  return candidates.find(value => typeof value === 'string' && value.trim() !== '' && existsSync(value));
}

function firstExistingDir(candidates: Array<string | undefined>): string | undefined {
  return firstExistingFile(candidates);
}

function firstVieNeuModelDir(candidates: Array<string | undefined>): string | undefined {
  return candidates.find(value => {
    if (typeof value !== 'string' || value.trim() === '' || !existsSync(value)) return false;
    try {
      const files = readdirSync(value);
      return REQUIRED_MODEL_FILES.every(file => files.includes(file));
    } catch {
      return false;
    }
  });
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

/** Kiểm tra một máy chủ VieNeu ngoài có đang phản hồi không. */
async function isReachable(origin: string): Promise<boolean> {
  for (const path of ['/health', '/v1/models']) {
    try {
      const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return true;
    } catch {
      // Thử đường dẫn kế tiếp.
    }
  }
  return false;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sidecar Python: nạp VieNeu v3 Turbo (ONNX/CPU) và phục vụ `POST /v1/audio/speech`
 * tương thích OpenAI. Trả MP3 nếu libsndfile hỗ trợ, ngược lại trả WAV.
 */
const VIENEU_SERVER_SCRIPT = `import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ONNX_DIR = os.environ.get("VIENEU_ONNX_DIR") or None
PRECISION = os.environ.get("VIENEU_PRECISION") or "fp32"
THREADS = int(os.environ.get("VIENEU_THREADS") or "0")
HOST = os.environ.get("VIENEU_HOST") or "127.0.0.1"
PORT = int(os.environ.get("VIENEU_PORT") or "0")

_state = {"tts": None, "error": None, "voices": []}
_lock = threading.Lock()
# ONNX session của VieNeu không an toàn khi suy luận song song: xếp hàng tuần tự.
_synth_lock = threading.Lock()


def _load():
    with _lock:
        if _state["tts"] is not None:
            return _state["tts"]
        from vieneu import Vieneu
        kwargs = {"mode": "v3turbo", "backend": "onnx", "device": "cpu", "precision": PRECISION}
        if ONNX_DIR:
            kwargs["onnx_dir"] = ONNX_DIR
        if THREADS:
            kwargs["threads"] = THREADS
        tts = Vieneu(**kwargs)
        try:
            voices = tts.list_preset_voices()
            _state["voices"] = list(voices.keys()) if isinstance(voices, dict) else list(voices)
        except Exception:
            _state["voices"] = []
        _state["tts"] = tts
        return tts


def _warm():
    try:
        _load()
    except Exception as exc:
        _state["error"] = repr(exc)


def _synth(text, voice):
    import numpy as np
    import soundfile as sf
    with _synth_lock:
        tts = _load()
        # VieNeu là TTS tiếng Việt: văn bản không phải tiếng Việt (còn sót chữ Hán)
        # có thể sinh mảng rỗng. Thử lại vài lần rồi báo lỗi để lớp trên rơi về Edge TTS.
        for _ in range(2):
            wav = tts.infer(text, voice=voice) if voice else tts.infer(text)
            sr = int(getattr(tts, "sample_rate", 48000) or 48000)
            arr = np.asarray(wav, dtype="float32")
            if arr.ndim > 1:
                arr = arr.mean(axis=1)
            if arr.size < int(sr * 0.05):
                continue
            buf = io.BytesIO()
            try:
                sf.write(buf, arr, sr, format="MP3")
                data = buf.getvalue()
                if data:
                    return data, "audio/mpeg"
            except Exception:
                pass
            buf = io.BytesIO()
            sf.write(buf, arr, sr, format="WAV", subtype="PCM_16")
            data = buf.getvalue()
            if data:
                return data, "audio/wav"
        raise RuntimeError("VieNeu khong tao duoc am thanh (len=%d)" % len(text))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        return

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            body = json.dumps({"ok": True, "ready": _state["tts"] is not None, "error": _state["error"]})
            self._send(200, body.encode("utf-8"))
        elif self.path.startswith("/v1/models"):
            body = json.dumps({"object": "list", "data": [{"id": "vieneu-v3-turbo", "object": "model"}]})
            self._send(200, body.encode("utf-8"))
        elif self.path.startswith("/v1/voices"):
            self._send(200, json.dumps({"data": _state["voices"]}, ensure_ascii=False).encode("utf-8"))
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        if not self.path.startswith("/v1/audio/speech"):
            self._send(404, b'{"error":"not found"}')
            return
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._send(400, b'{"error":"invalid json"}')
            return
        text = (body.get("input") or "").strip()
        voice = (body.get("voice") or "").strip()
        if not text:
            self._send(400, b'{"error":"input is required"}')
            return
        try:
            data, ctype = _synth(text, voice)
        except Exception as exc:
            _state["error"] = repr(exc)
            print("vieneu synth error:", repr(exc), file=sys.stderr, flush=True)
            self._send(500, json.dumps({"error": repr(exc)}).encode("utf-8"))
            return
        self._send(200, data, ctype)


def main():
    threading.Thread(target=_warm, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
`;
