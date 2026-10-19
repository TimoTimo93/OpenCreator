import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnCreatorProcess } from '../process-tree.js';
import { CreatorExecutorError } from '../executor.js';

/**
 * Tách nhạc nền (music + SFX) khỏi giọng đọc gốc của video nguồn bằng model
 * UVR MDX-Net (ONNX, MIT license) rồi ghép lại sau bước lồng tiếng: giọng đọc
 * mới giữ nguyên âm lượng, nhạc nền giữ theo mức cấu hình (mặc định 80%),
 * giọng đọc cũ bị loại hoàn toàn.
 *
 * Môi trường chạy tự cấp dữ liệu (self-provisioning) lần chạy đầu tiên:
 * 1. Python nhúng (embeddable ${PYTHON_VERSION}) + pip + audio-separator + onnxruntime.
 * 2. Model UVR-MDX-NET-Inst_HQ_3.onnx (SHA256 pin cố định).
 * Toàn bộ nằm trong <runtime>/audio-separation trên đĩa cục bộ; trên máy mới
 * lần chạy lồng tiếng đầu tiên sẽ tự tải về (khoảng vài trăm MB, một lần).
 */

const PYTHON_VERSION = '3.11.9';
const PYTHON_EMBED_ZIP = `python-${PYTHON_VERSION}-embed-amd64.zip`;
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/${PYTHON_EMBED_ZIP}`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const PIP_PACKAGES = ['audio-separator==0.47.0', 'onnxruntime==1.31.0'] as const;

export const BGM_SEPARATION_MODEL = {
  fileName: 'UVR-MDX-NET-Inst_HQ_3.onnx',
  url: (
    'https://huggingface.co/notabilia/uvr5-models/resolve/main/' +
    'UVR-MDX-NET-Inst_HQ_3.onnx'
  ),
  sha256: '317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc',
  bytes: 66_759_214
} as const;

/** Cách lọc bom chữ cho cài đặt giữ nhạc nền của pipeline lồng tiếng. */
export type BackgroundMusicSettings = {
  enabled: boolean;
  /** 0..1 — mức âm lượng nhạc nền giữ lại so với bản gốc (mặc định 0.8). */
  retention: number;
};

export function resolveBackgroundMusicSettings(
  options: Record<string, unknown> | undefined
): BackgroundMusicSettings {
  const enabledRaw = options?.keepBackgroundAudio;
  const retentionRaw = options?.bgmRetention;
  const enabled = enabledRaw === undefined
    ? true
    : (enabledRaw !== false && enabledRaw !== 0 && enabledRaw !== 'false');
  const retention = typeof retentionRaw === 'number' && Number.isFinite(retentionRaw)
    ? Math.min(1, Math.max(0, retentionRaw))
    : 0.8;
  // Mức giữ 0 coi như tắt hẳn (hành vi cũ: audio chỉ còn giọng lồng).
  return enabled && retention > 0.001 ? { enabled: true, retention } : { enabled: false, retention: 0 };
}

export function resolveSeparationRuntimeRoot(): string {
  const runtimeDir = process.env.OPENCREATOR_RUNTIME_DIR;
  if (runtimeDir) return join(resolve(runtimeDir), 'audio-separation');
  const dataDir = process.env.OPENCREATOR_DATA_DIR;
  if (dataDir) return join(resolve(dirname(dataDir)), 'runtime', 'audio-separation');
  return join(resolve('.runtime'), 'audio-separation');
}

export function separationLayout(root: string) {
  return {
    root,
    pythonDir: join(root, 'python'),
    pythonExe: join(root, 'python', 'python.exe'),
    separatorExe: join(root, 'python', 'Scripts', 'audio-separator.exe'),
    modelsDir: join(root, 'models'),
    marker: join(root, 'provisioned.marker'),
    pythonEmbedZip: join(root, PYTHON_EMBED_ZIP),
    getPipeFile: join(root, 'get-pip.py'),
    modelFilePath: join(root, 'models', BGM_SEPARATION_MODEL.fileName)
  };
}

export function buildMixFilterGraph(retention: number): string {
  // amix mặc định chia đều hai luồng (mỗi luồng còn một nửa, tức giọng lồng bị
  // tụt ~6dB); `normalize=0` giữ nguyên âm lượng từng luồng nên nhạc nền đạt
  // đúng mức bù `volume=retention` và giọng lồng giữ mức gốc.
  // Giọng TTS (thường mono) được ép về stereo trước khi trộn để bản dub không
  // bị mono; loudnorm chuẩn hoá bản mix cuối về đích -16 LUFS (TP -1.5dB,
  // LRA 11) để cân với video nguồn.
  return (
    '[1:a]aformat=channel_layouts=stereo[voice];'
    + `[0:a]volume=${retention.toFixed(3)}[bgm];`
    + '[voice][bgm]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mix];'
    + '[mix]loudnorm=I=-16:TP=-1.5:LRA=11[aout]'
  );
}

function runProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnCreatorProcess(input.executable, input.args, {
      cwd: input.cwd,
      stdio: ['ignore', 'ignore', 'pipe']
    }, input.signal);
    let stderr = '';
    child.stderr?.on('data', chunk => {
      const text = String(chunk);
      stderr = `${stderr}${text}`.slice(-8_000);
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (input.signal.aborted) {
        reject(new CreatorExecutorError('creator_stage_canceled', 'Creator stage was canceled'));
        return;
      }
      if (code === 0) resolvePromise();
      else reject(new Error(stderr || `Process exited with code ${code ?? 'unknown'}: ${input.executable}`));
    });
  });
}

async function downloadFile(input: {
  url: string;
  destination: string;
  expectedSha256?: string;
  expectedBytes?: number;
}): Promise<void> {
  const response = await fetch(input.url, { redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new CreatorExecutorError(
      'bgm_runtime_download_failed',
      `Tải về thất bại (HTTP ${response.status}): ${input.url}`
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (input.expectedBytes !== undefined && buffer.length !== input.expectedBytes) {
    throw new CreatorExecutorError(
      'bgm_runtime_download_failed',
      `Kích thước file tải về sai: ${buffer.length} != ${input.expectedBytes}`
    );
  }
  if (input.expectedSha256 !== undefined) {
    const hash = createHash('sha256').update(buffer).digest('hex');
    if (hash !== input.expectedSha256) {
      throw new CreatorExecutorError(
        'bgm_runtime_download_failed',
        `SHA256 sai khớp: ${hash} != ${input.expectedSha256}`
      );
    }
  }
  await mkdir(dirname(input.destination), { recursive: true });
  await writeFile(input.destination, buffer);
}

/** Giải nén zip bằng PowerShell (Windows). */
function unzipFile(input: { zipPath: string; destination: string }): Promise<void> {
  if (process.platform !== 'win32') {
    return Promise.reject(
      new CreatorExecutorError('bgm_runtime_unsupported_platform', 'Chỉ hỗ trợ Windows (dùng PowerShell giải nén)')
    );
  }
  return new Promise((resolvePromise, reject) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${input.zipPath}' -DestinationPath '${input.destination}' -Force`],
      {},
      error => (error ? reject(error) : resolvePromise())
    );
  });
}

/** Bật cách đọc site-packages cho python nhúng (để pip hoạt động). */
async function patchPythonPathsFile(layout: ReturnType<typeof separationLayout>): Promise<void> {
  const pthPath = join(layout.pythonDir, `python${PYTHON_VERSION.replace('.', '').slice(0, 3)}._pth`);
  const pth = await readFile(pthPath, 'utf8');
  await writeFile(pthPath, `${pth.replace(/^import site$/m, '#import site')}\nLib/site-packages\n.`);
}

let provisionInFlight: Promise<void> | undefined;

/**
 * Cấp dữ liệu môi trường tách giọng (python nhúng + thư viện + model).
 * Lần chạy đầu mới tải về; có marker để bỏ qua các lần sau.
 */
export function ensureSeparationRuntime(
  input: {
    root: string;
    reportProgress?: (progress: Record<string, unknown>) => void;
    signal?: AbortSignal;
  }
): Promise<void> {
  const layout = separationLayout(input.root);
  const markerText = `${PYTHON_VERSION}|${BGM_SEPARATION_MODEL.sha256}`;
  const report = (phase: string, extra: Record<string, unknown> = {}) => {
    input.reportProgress?.({ phase, ...extra });
  };

  const runProvision = async (): Promise<void> => {
    let marker: string | undefined;
    try {
      marker = await readFile(layout.marker, 'utf8');
    } catch {
      marker = undefined;
    }
    if (marker === markerText) return;

    report('bgm_setup_python');
    await rm(layout.root, { recursive: true, force: true });
    await mkdir(layout.modelsDir, { recursive: true });
    await downloadFile({ url: PYTHON_EMBED_URL, destination: layout.pythonEmbedZip });
    await unzipFile({ zipPath: layout.pythonEmbedZip, destination: layout.pythonDir });
    await patchPythonPathsFile(layout);

    report('bgm_setup_pip');
    await downloadFile({ url: GET_PIP_URL, destination: layout.getPipeFile });
    await runProcess({
      executable: layout.pythonExe,
      args: [layout.getPipeFile, '--no-warn-script-location'],
      cwd: layout.root,
      signal: input.signal ?? new AbortController().signal
    });
    await runProcess({
      executable: layout.pythonExe,
      args: ['-m', 'pip', 'install', '--no-warn-script-location', ...PIP_PACKAGES],
      cwd: layout.root,
      signal: input.signal ?? new AbortController().signal
    });

    report('bgm_setup_model');
    await downloadFile({
      url: BGM_SEPARATION_MODEL.url,
      destination: layout.modelFilePath,
      expectedSha256: BGM_SEPARATION_MODEL.sha256,
      expectedBytes: BGM_SEPARATION_MODEL.bytes
    });
    await mkdir(layout.root, { recursive: true });
    await writeFile(layout.marker, markerText, 'utf8');
  };

  provisionInFlight ??= runProvision().catch(error => {
    provisionInFlight = undefined;
    throw error;
  });
  return provisionInFlight;
}

/**
 * Tách stems từ file audio WAV. Trả về đường dẫn stem Instrumental (nhạc nền,
 * không giọng) và stem Vocals (giọng bị tách ra — không dùng khi lồng tiếng).
 */
export async function separateBackgroundStem(input: {
  separatorExe: string;
  modelsDir: string;
  audioPath: string;
  outputDir: string;
  reportProgress?: (progress: Record<string, unknown>) => void;
  signal?: AbortSignal;
}): Promise<{ instrumentalPath: string; vocalsPath: string }> {
  const stemBase = basename(input.audioPath).replace(/\.(wav|mp3|m4a|aac|mp4)$/i, '');
  const instrumentalPath = join(input.outputDir, `${stemBase}_(Instrumental)_${BGM_SEPARATION_MODEL.fileName.replace(/\.onnx$/i, '')}.wav`);
  const vocalsPath = join(input.outputDir, `${stemBase}_(Vocals)_${BGM_SEPARATION_MODEL.fileName.replace(/\.onnx$/i, '')}.wav`);
  await mkdir(input.outputDir, { recursive: true });

  input.reportProgress?.({ phase: 'bgm_separating', percent: 35 });
  try {
    await runProcess({
      executable: input.separatorExe,
      args: [
        input.audioPath,
        '--model_filename', BGM_SEPARATION_MODEL.fileName,
        '--model_file_dir', input.modelsDir,
        '--output_dir', input.outputDir,
        '--output_format', 'WAV',
        '--mdx_overlap', '0.10',
        '--mdx_segment_size', '256'
      ],
      cwd: dirname(input.separatorExe),
      signal: input.signal ?? new AbortController().signal
    });
  } catch (error) {
    throw new CreatorExecutorError(
      'bgm_separation_failed',
      `Tách nhạc nền thất bại: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  for (const path of [instrumentalPath, vocalsPath]) {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || info.size < 4096) {
      throw new CreatorExecutorError('bgm_separation_failed', `Không sinh được stem: ${basename(path)}`);
    }
  }
  return { instrumentalPath, vocalsPath };
}

/** Trích xuất audio gốc (44.1kHz stereo WAV) ra thư mục công việc. */
export async function extractSourceAudio(input: {
  ffmpegPath: string;
  videoPath: string;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<string> {
  await rm(input.outputPath, { force: true });
  await runProcess({
    executable: input.ffmpegPath,
    args: ['-y', '-v', 'error', '-i', input.videoPath, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', input.outputPath],
    cwd: dirname(input.outputPath),
    signal: input.signal ?? new AbortController().signal
  });
  const info = await stat(input.outputPath).catch(() => undefined);
  if (info === undefined || info.size < 1024) {
    throw new CreatorExecutorError('bgm_separation_failed', `Video nguồn không có sẵn audio: ${input.videoPath}`);
  }
  return input.outputPath;
}

/** Ghép: giọng lồng mới (âm lượng gốc, ép stereo) + nhạc nền (volume = retention),
 * rồi chuẩn hoá loudness cả bản mix về -16 LUFS qua loudnorm. */
export async function mixDubVoiceWithBackground(input: {
  ffmpegPath: string;
  backgroundPath: string;
  dubAudioPath: string;
  outputPath: string;
  retention: number;
  signal?: AbortSignal;
}): Promise<void> {
  await rm(input.outputPath, { force: true });
  await runProcess({
    executable: input.ffmpegPath,
    args: [
      '-y', '-v', 'error',
      '-i', input.backgroundPath,
      '-i', input.dubAudioPath,
      '-filter_complex', buildMixFilterGraph(input.retention),
      '-map', '[aout]',
      '-ac', '2', '-ar', '44100',
      '-c:a', 'pcm_s16le',
      input.outputPath
    ],
    cwd: dirname(input.outputPath),
    signal: input.signal ?? new AbortController().signal
  });
  const info = await stat(input.outputPath).catch(() => undefined);
  if (info === undefined || info.size < 1024) {
    throw new CreatorExecutorError('bgm_mix_failed', 'Không trộn được audio lồng tiếng với nhạc nền');
  }
}

/**
 * Tham số ffmpeg ghi đè audio của video dub. Không dùng `-shortest` trần (từng
 * cắt mất đuôi video khi audio dub ngắn hơn video): `apad` đệm im vô hạn cho
 * audio ngắn hơn và `-t` cắt bản xuất đúng bằng thời lượng video đích. Khi
 * không đo được thời lượng video, hạ về `apad` + `-shortest` — audio luôn được
 * đệm nên `-shortest` dừng ở cuối video, không cắt mất đuôi.
 */
export function buildReplaceDubbedAudioArgs(videoDurationSeconds: number | undefined): string[] {
  return [
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
    '-af', 'apad',
    '-movflags', '+faststart',
    ...(videoDurationSeconds === undefined
      ? ['-shortest']
      : ['-t', videoDurationSeconds.toFixed(3)])
  ];
}

/** Đo thời lượng media (giây) bằng ffprobe; trả về undefined nếu không đo được. */
export async function probeMediaDuration(
  ffprobePath: string,
  mediaPath: string,
  signal?: AbortSignal
): Promise<number | undefined> {
  try {
    const stdout = await new Promise<string>((resolvePromise, reject) => {
      execFile(
        ffprobePath,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', mediaPath],
        { signal, windowsHide: true, maxBuffer: 1_048_576 },
        (error, output, errorText) => {
          if (error) reject(error instanceof Error ? error : new Error(String(errorText || error)));
          else resolvePromise(output);
        }
      );
    });
    const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
    const duration = Number(parsed.format?.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : undefined;
  } catch {
    return undefined;
  }
}

/** Ghi đè audio của video lồng tiếng, giữ nguyên video stream (copy). */
export async function replaceDubbedVideoAudio(input: {
  ffmpegPath: string;
  /** ffprobe (cùng bộ runtime với ffmpeg) để đo thời lượng trước khi mux. */
  ffprobePath?: string;
  dubbedVideoPath: string;
  mixedAudioPath: string;
  reportProgress?: (progress: Record<string, unknown>) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const temporaryPath = `${input.dubbedVideoPath}.bgm-restore.mp4`;
  await rm(temporaryPath, { force: true });
  input.reportProgress?.({ phase: 'bgm_remuxing', percent: 85 });
  const videoDuration = input.ffprobePath === undefined
    ? undefined
    : await probeMediaDuration(input.ffprobePath, input.dubbedVideoPath, input.signal);
  if (input.ffprobePath !== undefined) {
    const audioDuration = await probeMediaDuration(input.ffprobePath, input.mixedAudioPath, input.signal);
    if (videoDuration !== undefined && audioDuration !== undefined) {
      const difference = Math.abs(videoDuration - audioDuration);
      if (difference > 1) {
        const warning = `BGM restore: thời lượng audio dub (${audioDuration.toFixed(3)}s) lệch `
          + `${difference.toFixed(3)}s so với video đích (${videoDuration.toFixed(3)}s)`;
        console.warn(`[creator] ${warning}`);
        input.reportProgress?.({ phase: 'bgm_duration_mismatch', percent: 84, message: warning });
      }
    }
  }
  await runProcess({
    executable: input.ffmpegPath,
    args: [
      '-y', '-v', 'error',
      '-i', input.dubbedVideoPath,
      '-i', input.mixedAudioPath,
      ...buildReplaceDubbedAudioArgs(videoDuration),
      temporaryPath
    ],
    cwd: dirname(input.dubbedVideoPath),
    signal: input.signal ?? new AbortController().signal
  });
  const info = await stat(temporaryPath).catch(() => undefined);
  if (info === undefined || info.size < 4096) {
    throw new CreatorExecutorError('bgm_remux_failed', 'Video không hợp lệ sau khi ghép nhạc nền');
  }
  await rm(input.dubbedVideoPath, { force: true });
  await rename(temporaryPath, input.dubbedVideoPath);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolvePromise());
  });
  return hash.digest('hex');
}

