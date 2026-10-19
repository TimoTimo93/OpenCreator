import { spawn } from 'node:child_process';
import { REFERENCE_VIDEO_ENCODING } from './merge.js';

/**
 * Xử lý phụ đề tiếng Hoa in sẵn trong pixel (hardsub) của video nguồn:
 *
 * - `blur`: dò vùng hardsub (dải dưới khung hình) → boxblur mạnh + làm tối nhẹ
 *   dải đó để chữ Hoa mờ đi, rồi burn phụ đề mới bình thường.
 * - `cover`: che hẳn vùng hardsub bằng dải đen bán trong suốt (drawbox).
 * - `crop`: crop bỏ dải dưới chứa hardsub rồi scale lại đầy khung (tỉ lệ khung
 *   hình đổi nhẹ — UI có ghi chú).
 * - `none`: giữ nguyên (mặc định, tương thích ngược với job cũ).
 *
 * Dải hardsub biểu diễn bằng % chiều cao TỪ MÉP ĐÁY khung hình nên độc lập với
 * độ phân giải: mặc định 4% → 22% (tương đương dải 78% → 96% tính từ mép trên).
 */

export type HardsubHandlingMode = 'none' | 'blur' | 'cover' | 'crop';

export type HardsubBand = {
  /** Mép dưới của dải, % chiều cao tính từ mép đáy khung hình. */
  bottomPercent: number;
  /** Mép trên của dải, % chiều cao tính từ mép đáy khung hình. */
  topPercent: number;
};

export const HARDSUB_HANDLING_MODES: readonly HardsubHandlingMode[] = ['none', 'blur', 'cover', 'crop'];

/**
 * Dải hardsub mặc định: bottom 4% → top 22% tính từ mép đáy
 * (tức dải 78% → 96% chiều cao tính từ mép trên — vị trí hardsub của
 * các phim ngắn Hồng Qua).
 */
export const DEFAULT_HARDSUB_BAND: HardsubBand = { bottomPercent: 4, topPercent: 22 };

/** Đỉnh dải do người dùng chỉnh nằm trong khoảng này (% chiều cao từ mép đáy). */
export const HARDSUB_BAND_PERCENT_MIN = 8;
export const HARDSUB_BAND_PERCENT_MAX = 60;

/** Khung phân tích dò hardsub (tỉ lệ thật không quan trọng — dải tính theo %). */
const ANALYSIS_WIDTH = 320;
const ANALYSIS_HEIGHT = 180;
/** Lấy 1 khung mẫu mỗi 10 giây, tối đa 6 khung và chỉ phân tích 5 phút đầu. */
const ANALYSIS_FRAME_INTERVAL_SECONDS = 10;
const ANALYSIS_MAX_FRAMES = 6;
const ANALYSIS_DURATION_CAP_SECONDS = 300;

/** Đọc chế độ hardsub từ state job; giá trị lạ → 'none' (tương thích ngược). */
export function parseHardsubHandling(value: unknown): HardsubHandlingMode {
  return typeof value === 'string' && (HARDSUB_HANDLING_MODES as readonly string[]).includes(value)
    ? value as HardsubHandlingMode
    : 'none';
}

/**
 * Đỉnh dải do người dùng chỉnh; `null` = để pipeline tự dò.
 * Giá trị không hợp lệ (NaN, ngoài khoảng) → `null` (tự dò) thay vì lỗi.
 */
export function parseHardsubBandPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(
    HARDSUB_BAND_PERCENT_MAX,
    Math.max(HARDSUB_BAND_PERCENT_MIN, Math.round(value))
  );
}

/** Kẹp dải hợp lệ: mép trên phải cao hơn mép dưới tối thiểu 6% chiều cao. */
export function clampHardsubBand(band: HardsubBand): HardsubBand {
  const top = Math.min(HARDSUB_BAND_PERCENT_MAX, Math.max(6, band.topPercent));
  const bottom = Math.min(Math.max(0, band.bottomPercent), Math.max(0, top - 6));
  return { bottomPercent: Math.round(bottom * 10) / 10, topPercent: Math.round(top * 10) / 10 };
}

function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/** Đổi dải % thành pixel (chẵn theo chiều ngang/vertical của chuẩn encode). */
export function hardsubBandPixels(
  band: HardsubBand,
  height: number
): { top: number; height: number } {
  const top = evenFloor(height * (100 - clampHardsubBand(band).topPercent) / 100);
  const bottom = evenFloor(height * (100 - clampHardsubBand(band).bottomPercent) / 100);
  return { top, height: Math.max(2, bottom - top) };
}

/**
 * Sinh chuỗi `-vf` xử lý hardsub (pure — unit test trực tiếp):
 *
 * - blur: `split` → crop đúng dải → boxblur mạnh → overlay ngược về vị trí cũ
 *   → drawbox đen mờ làm tối nhẹ dải (chữ Hoa nhòe, không đọc lại được).
 * - cover: drawbox đen alpha 0.85 phủ đặc dải hardsub.
 * - crop: crop bỏ phần dưới từ mép trên của dải rồi scale về full khung gốc.
 */
export function buildHardsubMaskFilterChain(input: {
  mode: Exclude<HardsubHandlingMode, 'none'>;
  band: HardsubBand;
  width: number;
  height: number;
}): string {
  const width = evenFloor(input.width);
  const height = evenFloor(input.height);
  const clamped = clampHardsubBand(input.band);
  if (input.mode === 'crop') {
    const keepHeight = evenFloor(height * (100 - clamped.topPercent) / 100);
    return `crop=iw:${keepHeight}:0:0,scale=${width}:${height}:flags=lanczos,format=yuv420p`;
  }
  const bandBox = hardsubBandPixels(clamped, height);
  if (input.mode === 'cover') {
    return 'drawbox=x=0:y={Y}:w=iw:h={H}:color=black@0.85:t=fill,format=yuv420p'
      .replace('{Y}', String(bandBox.top))
      .replace('{H}', String(bandBox.height));
  }
  // blur: bán kính boxblur giới hạn theo cạnh ngắn của dải (ràng buộc ffmpeg).
  const radius = Math.min(30, Math.max(5, Math.floor(Math.min(width, bandBox.height) / 8)));
  return [
    `split[hsbase][hsband]`,
    `[hsband]crop=iw:${bandBox.height}:0:${bandBox.top},` +
      `boxblur=luma_radius=${radius}:luma_power=2:chroma_radius=${radius}:chroma_power=2:alpha_radius=${radius}:alpha_power=2` +
      `[hsbandblurred]`,
    `[hsbase][hsbandblurred]overlay=0:${bandBox.top},` +
      `drawbox=x=0:y=${bandBox.top}:w=iw:h=${bandBox.height}:color=black@0.25:t=fill,` +
      `format=yuv420p`
  ].join(';');
}

/** Args ffmpeg đầy đủ cho bước pre-process hardsub (chạy 1 lần, không đè file gốc). */
export function buildHardsubPreprocessArgs(input: {
  mode: Exclude<HardsubHandlingMode, 'none'>;
  band: HardsubBand;
  width: number;
  height: number;
  sourcePath: string;
  outputPath: string;
}): string[] {
  return [
    '-y',
    '-i', input.sourcePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', buildHardsubMaskFilterChain(input),
    '-c:v', REFERENCE_VIDEO_ENCODING.codec,
    '-preset', REFERENCE_VIDEO_ENCODING.preset,
    '-crf', String(REFERENCE_VIDEO_ENCODING.crf),
    '-c:a', 'copy',
    '-movflags', '+faststart',
    input.outputPath
  ];
}

// ---------------------------------------------------------------------------
// Dò dải hardsub từ khung hình mẫu
// ---------------------------------------------------------------------------

/**
 * Phân tích các khung grayscale đã xuất sẵn (pure): đánh dấu các hàng pixel
 * có nhiều biến đổi sáng/tối mạnh (cạnh chữ) + nhiều pixel sáng (chữ trắng
 * viền đen) rồi bỏ phiếu đa số giữa các khung. Trả về dải % từ mép đáy, hoặc
 * `undefined` nếu không tìm thấy cụm chữ nào đáng tin (người gọi sẽ dùng dải
 * mặc định).
 */
export function analyzeHardsubFrames(
  pixels: Buffer,
  width: number,
  height: number,
  frameCount: number
): HardsubBand | undefined {
  const frameSize = width * height;
  const frames = Math.min(frameCount, Math.floor(pixels.length / frameSize));
  if (frames < 1 || width < 2 || height < 4) return undefined;
  // Hardsub luôn nằm ở nửa dưới khung hình — chỉ xét từ 55% chiều cao trở xuống.
  const searchStart = Math.ceil(height * 0.55);
  const votesNeeded = Math.max(1, Math.ceil(frames / 2));
  const flagged: number[] = [];
  for (let y = searchStart; y < height; y += 1) {
    let votes = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      if (isTextRow(pixels, frame * frameSize, width, y)) votes += 1;
    }
    if (votes >= votesNeeded) flagged.push(y);
  }
  // Cần ít nhất một cụm ~2% chiều cao mới đủ tin (tránh dính nhiễu nền).
  if (flagged.length < Math.max(3, Math.floor(height * 0.02))) return undefined;
  const pad = Math.max(1, Math.round(height * 0.01));
  const minY = Math.max(0, (flagged[0] ?? searchStart) - pad);
  const maxY = Math.min(height - 1, (flagged[flagged.length - 1] ?? height - 1) + pad);
  const band = clampHardsubBand({
    bottomPercent: ((height - 1 - maxY) / height) * 100,
    topPercent: ((height - minY) / height) * 100
  });
  // Hardsub ngoài khoảng hợp lý (ví dụ dò nhúng cả nước LOGO giữa màn hình) → bỏ.
  if (band.topPercent > 45) return undefined;
  return band;
}

/** Một hàng là "hàng chữ" khi có đủ nhiều cạnh chữ mạnh và pixel sáng (chữ trắng). */
function isTextRow(pixels: Buffer, frameOffset: number, width: number, y: number): boolean {
  const row = frameOffset + y * width;
  let edges = 0;
  let bright = 0;
  for (let x = 1; x < width; x += 1) {
    const value = pixels[row + x]!;
    if (value >= 190) bright += 1;
    if (Math.abs(value - pixels[row + x - 1]!) >= 50) edges += 1;
  }
  return edges / width >= 0.05 && bright / width >= 0.008;
}

/**
 * Dò dải hardsub bằng cách xuất tối đa 6 khung grayscale rải đều 5 phút đầu
 * (ffmpeg `-f rawvideo` ra stdout) rồi phân tích pixel. Không dò được (ffmpeg
 * lỗi, video hỏng, không thấy cụm chữ) → trả về dải mặc định, không bao giờ
 * làm chết stage dịch.
 */
export async function detectHardsubBand(input: {
  ffmpegPath: string;
  videoPath: string;
  signal?: AbortSignal;
  runFfmpeg?: (args: string[]) => Promise<Buffer>;
}): Promise<{ band: HardsubBand; detected: boolean }> {
  try {
    const args = [
      '-y',
      '-i', input.videoPath,
      '-t', String(ANALYSIS_DURATION_CAP_SECONDS),
      '-vf', `fps=1/${ANALYSIS_FRAME_INTERVAL_SECONDS},scale=${ANALYSIS_WIDTH}:${ANALYSIS_HEIGHT},format=gray`,
      '-frames:v', String(ANALYSIS_MAX_FRAMES),
      '-f', 'rawvideo',
      '-'
    ];
    const run = input.runFfmpeg ?? ((args: string[]) => runFfmpegToBuffer({
      ffmpegPath: input.ffmpegPath,
      args,
      signal: input.signal
    }));
    const pixels = await run(args);
    const band = analyzeHardsubFrames(pixels, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, ANALYSIS_MAX_FRAMES);
    return band === undefined
      ? { band: { ...DEFAULT_HARDSUB_BAND }, detected: false }
      : { band, detected: true };
  } catch {
    return { band: { ...DEFAULT_HARDSUB_BAND }, detected: false };
  }
}

function runFfmpegToBuffer(input: {
  ffmpegPath: string;
  args: string[];
  signal?: AbortSignal;
}): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(input.ffmpegPath, input.args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    const abort = () => child.kill();
    input.signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.once('error', rejectPromise);
    child.once('exit', code => {
      input.signal?.removeEventListener('abort', abort);
      if (input.signal?.aborted) {
        rejectPromise(new Error('Hardsub detection canceled'));
        return;
      }
      const pixels = Buffer.concat(chunks);
      if (code !== 0 || pixels.length === 0) {
        rejectPromise(new Error(stderr || `ffmpeg exited with code ${code ?? 'unknown'}`));
        return;
      }
      resolvePromise(pixels);
    });
  });
}
