import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RuntimeErrorCode } from '@opencreator/protocol';
import type {
  PipelineEnqueueRequest,
  TranslationPipelineService
} from '../creator/translation-pipeline/pipeline.js';
import { ProjectManagerError, type ProjectManager } from '../projects/types.js';
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
 *                                              + projectId/thư mục project đang dùng
 * - POST /creator/translation-batch/enqueue  → nạp cả bộ (tự trích số tập, xếp tăng dần);
 *                                              có `seriesName` → resolve/tạo project
 *                                              theo tên phim rồi gắn `projectId`
 *                                              vào từng item trước khi nạp
 * - POST /creator/translation-batch/merge    → ghép toàn bộ tập đã dịch thành
 *                                              `<Tên phim>-full.mp4` trong Exports
 *                                              của project đích (projectId ưu tiên,
 *                                              kế đến seriesName, rồi mặc định);
 *                                              có `seriesKey` → chỉ ghép đúng bộ đó
 * - POST /creator/translation-batch/retry    → dịch lại 1 tập failed/canceled
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
  /**
   * Quản lý project — dùng resolve/tạo project THEO TÊN PHIM cho batch:
   * `ensureProjectByName(seriesName)` (enqueue) và `getProject(projectId)`
   * (merge). Thiếu → các request mang seriesName/projectId bị từ chối 503.
   */
  projects?: Pick<ProjectManager, 'ensureProjectByName' | 'getProject'>;
  /**
   * Thư mục dự án sẽ chứa `<Tên phim>-full.mp4` (Exports của project). Khi
   * route resolve được project đích (projectId/seriesName) nó truyền project
   * vào đây để nhận đúng Exports của project ĐÓ (`<outputRoot>/<tên>-<id>`);
   * không truyền project → Exports mặc định như cũ.
   */
  resolveProjectFolder?(project?: { id: string; name: string; cwd: string }): {
    folder: string;
    projectName: string;
  };
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
  // Project đang gắn với batch (theo tên phim) — resolve lần đầu (enqueue hoặc
  // merge) rồi GET trả lại để web biết projectId/thư mục xuất đang dùng.
  let batchProject: { id: string; name: string; folder: string } | undefined;

  const unavailable = (reply: FastifyReply) => reply.code(503).send(apiError(
    'creator_pipeline_unavailable',
    'Hàng đợi tự động dịch chưa được cắm vào runtime này'
  ));

  /** Thư mục Exports của project đích; không cấu hình resolver → dùng cwd project. */
  const exportsFolderOf = (project: { id: string; name: string; cwd: string }): string =>
    input.resolveProjectFolder?.(project)?.folder ?? project.cwd;

  /** Project đích cho batch: projectId ưu tiên → seriesName → mặc định. */
  const resolveTargetProject = (
    body: Record<string, unknown>
  ): { ok: true; project?: { id: string; name: string; cwd: string } }
    | { ok: false; code: number; errorCode: RuntimeErrorCode; message: string } => {
    const projectId = typeof body.projectId === 'string' && body.projectId.trim() !== ''
      ? body.projectId.trim()
      : undefined;
    const seriesName = typeof body.seriesName === 'string' && body.seriesName.trim() !== ''
      ? body.seriesName.trim()
      : undefined;
    if (projectId === undefined && seriesName === undefined) return { ok: true };
    if (input.projects === undefined) {
      // Dùng mã lỗi có sẵn trong RuntimeErrorCode (không mở rộng union của
      // protocol); thông điệp nêu rõ thiếu quản lý project.
      return {
        ok: false,
        code: 503,
        errorCode: 'creator_pipeline_unavailable',
        message: 'Quản lý project chưa được cắm vào runtime này'
      };
    }
    if (projectId !== undefined) {
      const project = input.projects.getProject(projectId);
      if (project === undefined) {
        return {
          ok: false,
          code: 404,
          errorCode: 'PROJECT_NOT_FOUND',
          message: 'Project not found'
        };
      }
      return { ok: true, project: { id: project.id, name: project.name, cwd: project.cwd } };
    }
    try {
      const ensured = input.projects.ensureProjectByName(seriesName!);
      return {
        ok: true,
        project: { id: ensured.id, name: ensured.name, cwd: ensured.folder }
      };
    } catch (error) {
      if (!(error instanceof ProjectManagerError)) throw error;
      const errorCode: RuntimeErrorCode = error.code === 'PROJECT_NAME_INVALID'
        ? 'PROJECT_NAME_INVALID'
        : error.code === 'PROJECT_NOT_FOUND'
          ? 'PROJECT_NOT_FOUND'
          : error.code === 'PROJECT_DIRECTORY_UNAVAILABLE'
            ? 'PROJECT_DIRECTORY_UNAVAILABLE'
            : 'PROJECT_DIRECTORY_CONFLICT';
      const code = error.code === 'PROJECT_NAME_INVALID'
        ? 400
        : error.code === 'PROJECT_NOT_FOUND'
          ? 404
          : error.code === 'PROJECT_DIRECTORY_UNAVAILABLE'
            ? 422
            : 409;
      return { ok: false, code, errorCode, message: error.message };
    }
  };

  server.get('/creator/translation-batch', async (_request, reply) => {
    if (pipeline === undefined) return unavailable(reply);
    const summary = pipeline.getSummary();
    return {
      ...summary,
      progress: batchProgress(summary.items),
      fullMovie: { ...fullMovie },
      // Project đang dùng cho batch (null khi chưa resolve theo tên phim).
      projectId: batchProject?.id ?? null,
      folder: batchProject?.folder ?? null,
      projectName: batchProject?.name ?? null
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
    const parsed: Array<PipelineEnqueueRequest & { projectId?: string }> = [];
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
          : {}),
        // v2: seriesKey định danh bộ phim (để dashboard/ghép nhóm đúng bộ) +
        // batchMode = nạp theo cả bộ → chỉ ghép xong mới nạp đăng (full movie).
        ...(typeof candidate.seriesKey === 'string' && candidate.seriesKey.trim() !== ''
          ? { seriesKey: candidate.seriesKey.trim() }
          : {}),
        ...(candidate.batchMode === true ? { batchMode: true } : {}),
        // projectId mang theo từng item (web đã resolve) — pipeline giữ nguyên
        // item fields khi lưu state; không có → route tự gắn theo seriesName dưới.
        ...(typeof candidate.projectId === 'string' && candidate.projectId.trim() !== ''
          ? { projectId: candidate.projectId }
          : {})
      });
    }
    // seriesName chỉ mang ý nghĩa gắn project của cả bộ: route resolve/tạo
    // project theo tên phim rồi gắn projectId vào TỪNG item trước khi nạp
    // hàng đợi; số tập vẫn tự trích từ title/tên file nếu web không gửi sẵn.
    const rawSeriesName = (body as { seriesName?: unknown }).seriesName;
    const seriesName = typeof rawSeriesName === 'string' ? rawSeriesName.trim() : '';
    if (seriesName !== '') {
      const target = resolveTargetProject({ seriesName });
      if (!target.ok) {
        return reply.code(target.code).send(apiError(target.errorCode, target.message));
      }
      const project = target.project!;
      batchProject = { id: project.id, name: project.name, folder: exportsFolderOf(project) };
      // Project theo tên phim thắng projectId rời rạc của từng item — cả bộ
      // thuộc về một project.
      for (const item of parsed) item.projectId = project.id;
    }
    const summary = pipeline.enqueue(parsed);
    return {
      ...summary,
      progress: batchProgress(summary.items),
      fullMovie: { ...fullMovie },
      projectId: batchProject?.id ?? null,
      folder: batchProject?.folder ?? null,
      projectName: batchProject?.name ?? null
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
    // Project đích: projectId (ưu tiên) → seriesName → Exports mặc định.
    const target = resolveTargetProject(body);
    if (!target.ok) {
      return reply.code(target.code).send(apiError(target.errorCode, target.message));
    }
    const targetProject = target.project;
    const seriesName = (
      typeof body.seriesName === 'string' && body.seriesName.trim() !== ''
        ? body.seriesName
        : targetProject?.name ?? input.resolveProjectFolder?.().projectName
    );
    if (seriesName === undefined || seriesName.trim() === '') {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'seriesName is required'));
    }
    const summary = pipeline.getSummary();
    // v2: chỉ ghép phân đoạn của ĐÚNG bộ khi web gửi seriesKey — chống trộn 2 bộ.
    const bodySeriesKey = typeof body.seriesKey === 'string' && body.seriesKey.trim() !== ''
      ? body.seriesKey.trim()
      : undefined;
    const completed = summary.items
      .filter(item => item.status === 'completed' && item.outputVideoPath !== null)
      .filter(item => bodySeriesKey === undefined || (item.seriesKey ?? null) === bodySeriesKey)
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
    // Full movie ghi vào Exports của project đích (hoặc mặc định khi không
    // resolve được project); không còn thư mục nào → rơi về upload folder.
    const targetDirectory = targetProject !== undefined
      ? exportsFolderOf(targetProject)
      : input.resolveProjectFolder?.()?.folder ?? summary.uploadFolder;
    if (targetProject !== undefined) {
      batchProject = {
        id: targetProject.id,
        name: targetProject.name,
        folder: targetDirectory
      };
    }
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
      seriesName: fullMovie.seriesName,
      projectId: batchProject?.id ?? null,
      folder: batchProject?.folder ?? null
    };
  });

  /** v2 — Dịch lại 1 tập lỗi/canceled trong hàng đợi (per-episode retry). */
  server.post<{ Body: unknown }>('/creator/translation-batch/retry', async (request, reply) => {
    if (pipeline === undefined) return unavailable(reply);
    const body = typeof request.body === 'object' && request.body !== null
      ? request.body as Record<string, unknown>
      : {};
    if (typeof body.id !== 'string' || body.id.trim() === '') {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'body.id (episode id) is required'));
    }
    const summary = pipeline.retry(body.id.trim());
    return {
      ...summary,
      progress: batchProgress(summary.items)
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
      // Exports của project đang gắn với batch (resolve theo tên phim).
      batchProject?.folder,
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
    // explorer.exe luôn trả exit code khác 0 kể cả khi đã mở cửa sổ — bỏ qua
    // exit code (tệp không tồn tại đã được kiểm tra trước đó).
    try {
      await execFileAsync('explorer', [input.mode === 'file' ? `/select,${input.absolutePath}` : input.absolutePath]);
    } catch {
      // ignore — launch lỗi chỉ xảy ra khi Explorer chưa sẵn sàng, hiếm.
    }
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
