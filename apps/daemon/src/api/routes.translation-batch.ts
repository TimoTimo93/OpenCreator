import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TranslationPipelineService } from '../creator/translation-pipeline/pipeline.js';
import {
  batchProgress,
  mergeEpisodesToFullMovie
} from '../creator/translation-pipeline/batch-merge.js';
import { apiError } from './errors.js';

const execFileAsync = promisify(execFile);

/**
 * REST cho lượt "dịch cả bộ" (nhiều tập của cùng một phim) nằm trên hàng đợi
 * tự động dịch (`/creator/translation-pipeline`):
 *
 * - GET  /creator/translation-batch          → trạng thái + tiến độ x/y tập + ghép
 * - POST /creator/translation-batch/enqueue  → nạp cả bộ (tự trích số tập, xếp tăng dần)
 * - POST /creator/translation-batch/merge    → ghép toàn bộ tập đã dịch thành
 *                                              `<Tên phim>-full.mp4` trong thư mục dự án
 * - POST /creator/translation-batch/reveal   → mở thư mục / chọn file trong Explorer
 *                                              (file xuất, video ghép...)
 *
 * Hàng đợi chạy TUẦN TỰ (1 tập/lượt) trong translation-pipeline; route này chỉ
 * điều khiển và tổng hợp trạng thái, không chạy song song phần dịch.
 */

export type FullMovieMergeState = {
  status: 'idle' | 'running' | 'completed' | 'failed';
  outputPath: string | null;
  episodeCount: number | null;
  seriesName: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type TranslationBatchRouteInput = {
  pipeline?: TranslationPipelineService;
  /** Đường dẫn ffmpeg/ffprobe trong thành phần runtime (dev: .runtime/build/...). */
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Thư mục dự án sẽ chứa `<Tên phim>-full.mp4` (Exports của project). */
  resolveProjectFolder?(): { folder: string; projectName: string };
  /** Thư mục gốc khác được phép mở (vd: work root của creator jobs). */
  extraAllowedRoots?: ReadonlyArray<string>;
  /** Đè logic ghép khi kiểm thử. */
  mergeFullMovie?(input: Parameters<typeof mergeEpisodesToFullMovie>[0]): Promise<{
    outputPath: string;
    durationSeconds: number;
    segmentCount: number;
    reencodedPositions: number[];
  }>;
  /** Đè hành vi mở thư mục khi kiểm thử. */
  reveal?(request: { absolutePath: string; mode: 'file' | 'directory' }): Promise<void>;
};

function idleFullMovie(): FullMovieMergeState {
  return {
    status: 'idle',
    outputPath: null,
    episodeCount: null,
    seriesName: null,
    error: null,
    startedAt: null,
    finishedAt: null
  };
}

export async function registerTranslationBatchRoutes(
  server: FastifyInstance,
  input: TranslationBatchRouteInput
): Promise<void> {
  const pipeline = input.pipeline;
  const fullMovie: FullMovieMergeState = { ...idleFullMovie() };
  let mergeRunning = false;

  const unavailable = (reply: FastifyReply) => reply.code(503).send(apiError(
    'creator_pipeline_unavailable',
    'Hàng đợi tự động dịch chưa được cắm vào runtime này'
  ));

  server.get('/creator/translation-batch', async (_request, reply) => {
    if (pipeline === undefined) return unavailable(reply);
    const summary = pipeline.getSummary();
    return {
      ...summary,
      progress: batchProgress(summary.items),
      fullMovie: { ...fullMovie }
    };
  });

  server.post<{ Body: unknown }>('/creator/translation-batch/enqueue', async (request, reply) => {
    if (pipeline === undefined) return unavailable(reply);
    const body = request.body;
    if (typeof body !== 'object' || body === null) {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'body must be an object'));
    }
    const items = (body as { items?: unknown }).items;
    if (!Array.isArray(items) || items.length === 0) {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'body.items must be a non-empty array'));
    }
    const parsed: Array<{ path: string; title?: string; episodeIndex?: number }> = [];
    for (const item of items) {
      if (typeof item !== 'object' || item === null) {
        return reply.code(400).send(apiError('VALIDATION_FAILED', 'each item must be an object'));
      }
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.path !== 'string' || candidate.path.trim() === '') {
        return reply.code(400).send(apiError('VALIDATION_FAILED', 'item.path (file path) is required'));
      }
      parsed.push({
        path: candidate.path,
        ...(typeof candidate.title === 'string' && candidate.title !== '' ? { title: candidate.title } : {}),
        ...(typeof candidate.episodeIndex === 'number' && Number.isFinite(candidate.episodeIndex)
          ? { episodeIndex: Math.trunc(candidate.episodeIndex) }
          : {})
      });
    }
    // seriesName chỉ mang ý nghĩa hiển thị/gắn nhãn ở tầng web; hàng đợi nhận
    // từng file (số tập tự trích từ title/tên file nếu web không gửi sẵn).
    const summary = pipeline.enqueue(parsed.map(item => ({
      path: item.path,
      ...(item.title === undefined ? {} : { title: item.title }),
      ...(item.episodeIndex === undefined ? {} : { episodeIndex: item.episodeIndex })
    })));
    return {
      ...summary,
      progress: batchProgress(summary.items),
      fullMovie: { ...fullMovie }
    };
  });

  server.post<{ Body: unknown }>('/creator/translation-batch/merge', async (request, reply) => {
    if (pipeline === undefined) return unavailable(reply);
    if (input.ffmpegPath === undefined || input.ffprobePath === undefined) {
      return reply.code(503).send(apiError(
        'creator_runtime_unavailable',
        'ffmpeg/ffprobe không khả dụng trong thành phần runtime'
      ));
    }
    if (mergeRunning) {
      return reply.code(409).send(apiError(
        'creator_batch_merge_running',
        'Một lượt ghép full movie đang chạy, vui lòng đợi'
      ));
    }
    const body = typeof request.body === 'object' && request.body !== null
      ? request.body as Record<string, unknown>
      : {};
    const seriesName = typeof body.seriesName === 'string' && body.seriesName.trim() !== ''
      ? body.seriesName
      : input.resolveProjectFolder?.().projectName;
    if (seriesName === undefined || seriesName.trim() === '') {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'seriesName is required'));
    }
    const summary = pipeline.getSummary();
    const completed = summary.items
      .filter(item => item.status === 'completed' && item.outputVideoPath !== null)
      .sort((left, right) => {
        const leftIndex = left.episodeIndex ?? Number.POSITIVE_INFINITY;
        const rightIndex = right.episodeIndex ?? Number.POSITIVE_INFINITY;
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
        return left.addedAt.localeCompare(right.addedAt);
      });
    if (completed.length === 0) {
      return reply.code(409).send(apiError(
        'creator_batch_merge_empty',
        'Chưa có tập nào đã dịch xong để ghép full movie'
      ));
    }
    const projectFolder = input.resolveProjectFolder?.();
    const targetDirectory = projectFolder?.folder ?? summary.uploadFolder;
    const mergeInput = {
      ffmpegPath: input.ffmpegPath,
      ffprobePath: input.ffprobePath,
      segments: completed.map((item, index) => ({
        path: item.outputVideoPath!,
        episodeIndex: item.episodeIndex,
        positionHint: index + 1
      })),
      targetDirectory,
      seriesName: seriesName.trim()
    };
    mergeRunning = true;
    fullMovie.status = 'running';
    fullMovie.outputPath = null;
    fullMovie.error = null;
    fullMovie.seriesName = seriesName.trim();
    fullMovie.startedAt = new Date().toISOString();
    fullMovie.finishedAt = null;
    void (async () => {
      try {
        await mkdir(targetDirectory, { recursive: true });
        const report = input.mergeFullMovie !== undefined
          ? await input.mergeFullMovie(mergeInput)
          : await mergeEpisodesToFullMovie(mergeInput);
        fullMovie.status = 'completed';
        fullMovie.outputPath = report.outputPath;
        fullMovie.episodeCount = report.segmentCount;
      } catch (cause) {
        fullMovie.status = 'failed';
        fullMovie.error = cause instanceof Error ? cause.message : String(cause);
        console.warn(`[translation-batch] ghép full movie thất bại: ${fullMovie.error}`);
      } finally {
        mergeRunning = false;
        fullMovie.finishedAt = new Date().toISOString();
      }
    })();
    return {
      status: fullMovie.status,
      outputPath: fullMovie.outputPath,
      episodeCount: completed.length,
      seriesName: fullMovie.seriesName
    };
  });

  server.post<{ Body: unknown }>('/creator/translation-batch/reveal', async (request, reply) => {
    const body = typeof request.body === 'object' && request.body !== null
      ? request.body as Record<string, unknown>
      : {};
    if (typeof body.path !== 'string' || body.path.trim() === '') {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'body.path is required'));
    }
    const mode = body.mode === 'directory' ? 'directory' : 'file';
    const absolutePath = resolve(body.path.trim());
    // Chỉ mở đường dẫn thuộc thư mục dự án / runtime của OpenCreator.
    const allowedRoots = [
      ...input.extraAllowedRoots ?? [],
      input.resolveProjectFolder?.().folder,
      pipeline?.getSummary().uploadFolder
    ].filter((root): root is string => typeof root === 'string');
    if (
      allowedRoots.length > 0
      && !allowedRoots.some(root => insideRoot(root, absolutePath))
    ) {
      return reply.code(403).send(apiError(
        'creator_batch_reveal_forbidden',
        'Chỉ được mở thư mục xuất của dự án'
      ));
    }
    if (!existsSync(absolutePath)) {
      // Backward-compat: bản cũ ghi file xuất ở GỐC thư mục phiên bản (trước
      // khi chia video//audio//sub). Thử đúng vị trí cũ trước khi báo lỗi.
      const legacy = legacyLayoutCandidate(absolutePath);
      if (legacy !== null && existsSync(legacy)) {
        return await revealResolved(input, { absolutePath: legacy, mode }, reply);
      }
      return reply.code(404).send(apiError(
        'creator_batch_path_not_found',
        'Không tìm thấy tệp hoặc thư mục'
      ));
    }
    return await revealResolved(input, { absolutePath, mode }, reply);
  });
}

async function revealResolved(
  input: TranslationBatchRouteInput,
  request: { absolutePath: string; mode: 'file' | 'directory' },
  reply: FastifyReply
): Promise<void> {
  try {
    if (input.reveal !== undefined) {
      await input.reveal(request);
    } else {
      await revealPath(request);
    }
    return reply.code(200).send({ ok: true });
  } catch (cause) {
    return reply.code(500).send(apiError(
      'creator_batch_reveal_failed',
      cause instanceof Error ? cause.message : 'Không mở được thư mục'
    ));
  }
}

/**
 * Fallback lookup: `<...>/V1/video/Tập 01.mp4` không tồn tại mà bản cũ từng ghi
 * `<...>/V1/Tập 01.mp4` → trả về đường dẫn gốc tương ứng (ngược lại null).
 */
function legacyLayoutCandidate(absolutePath: string): string | null {
  const parent = dirname(absolutePath);
  const category = basename(parent);
  if (category !== 'video' && category !== 'audio' && category !== 'sub') return null;
  // Bỏ bậc thư mục loại: <...>/V1/video/file.mp4 → <...>/V1/file.mp4.
  return join(dirname(parent), basename(absolutePath));
}

function insideRoot(root: string, target: string): boolean {
  const normalize = (value: string) => value.endsWith(sep) ? value : value + sep;
  const rootReal = normalize(resolve(root)).toLowerCase();
  const targetReal = resolve(target).toLowerCase();
  return targetReal.startsWith(rootReal);
}

/** Mở file/thư mục trong trình quản lý file của hệ điều hành (Windows: Explorer). */
async function revealPath(input: { absolutePath: string; mode: 'file' | 'directory' }): Promise<void> {
  if (platform() === 'win32') {
    if (input.mode === 'file') {
      await execFileAsync('explorer.exe', ['/select,', input.absolutePath]);
      return;
    }
    await execFileAsync('explorer.exe', [input.absolutePath]);
    return;
  }
  if (platform() === 'darwin') {
    const args = input.mode === 'file'
      ? ['-R', input.absolutePath]
      : [input.absolutePath];
    await execFileAsync('open', args);
    return;
  }
  await execFileAsync('xdg-open', [input.absolutePath]);
}
