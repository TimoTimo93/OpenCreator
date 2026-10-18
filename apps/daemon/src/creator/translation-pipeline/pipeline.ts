import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { CreatorArtifact, CreatorJob, CreatorJson } from '@opencreator/protocol';
import type { CreatorCommandDispatcher } from '../command-dispatcher.js';
import { validateMediaFile, type MediaProbe } from '../validators/media.js';
import { mergeVideoSegments, type SegmentSpec } from './merge.js';
/**
 * Hàng đợi tự động dịch video (chạy tuần tự, 1 video/lượt):
 *
 * 1. nạp các file video đã tải (web hoặc trợ lý AI gọi REST);
 * 2. lần lượt từng video: tạo job `video-translation`, gắn nguồn local, chạy
 *    subtitle → tts → render-horizontal;
 * 3. khi hàng đợi trống: ghép các phân đoạn "video ngang" theo THỨ TỰ TẬP
 *    (episodeIndex — không phải thứ tự hoàn thành) thành một video dài, kiểm
 *    tra tổng thời lượng rồi copy sang thư mục "chờ upload".
 *
 * Trạng thái lưu ở `<dataDir>/translation-pipeline/pipeline.json`, ghi nguyên
 * tử (tmp + rename). Daemon khởi động lại đưa mục "running" về `queued` và tái
 * dùng job cũ qua `creationKey` nên không làm trùng job.
 */

export type PipelineEpisodeStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled';

export type PipelineEpisode = {
  id: string;
  sourcePath: string;
  title: string;
  seriesKey: string | null;
  /** Thứ tự tập (vid_index) — quyết định thứ tự ghép; null xếp theo thứ tự nạp. */
  episodeIndex: number | null;
  addedAt: string;
  status: PipelineEpisodeStatus;
  jobId: string | null;
  error: string | null;
  outputVideoPath: string | null;
  durationSeconds: number | null;
  merged: boolean;
  mergeRunId: string | null;
};

export type TranslationPipelineMerge = {
  status: 'idle' | 'running' | 'completed' | 'failed';
  runId: string | null;
  outputPath: string | null;
  uploadReady: string | null;
  episodeCount: number | null;
  skipped: Array<{ title: string; episodeIndex: number | null; reason: string }>;
  error: string | null;
};

export type TranslationPipelineState = {
  items: PipelineEpisode[];
  paused: boolean;
  merge: TranslationPipelineMerge;
};

export type TranslationPipelineSummary = TranslationPipelineState & {
  uploadFolder: string;
  counts: { queued: number; running: number; completed: number; failed: number };
};

export type PipelineEnqueueRequest = {
  path: string;
  title?: string;
  seriesKey?: string | null;
  episodeIndex?: number | null;
};

export type TranslationPipelineService = {
  getSummary(): TranslationPipelineSummary;
  enqueue(requests: readonly PipelineEnqueueRequest[]): TranslationPipelineSummary;
  pause(): TranslationPipelineSummary;
  resume(): TranslationPipelineSummary;
  remove(episodeId: string): TranslationPipelineSummary;
  retry(episodeId: string): TranslationPipelineSummary;
  clearFinished(): { summary: TranslationPipelineSummary; removed: number };
  mergeNow(): TranslationPipelineSummary;
  recover(): Promise<void>;
  close(): Promise<void>;
};

export type TranslationPipelineServiceInput = {
  dataDir: string;
  creator: {
    createJob(request: {
      projectId: string;
      templateId: string;
      creationKey?: string;
    }): CreatorJob | Promise<CreatorJob>;
    getJob(jobId: string): CreatorJob | undefined;
    /** Gắn nguồn video local vào job (giống source-upload). */
    registerSourceVideo(jobId: string, request: {
      expectedRevision: number;
      path: string;
      fileName: string;
      mimeType: string;
      size: number;
      sha256: string;
      lastModified: number | null;
      media: MediaProbe;
    }): { job: CreatorJob; artifact: CreatorArtifact; deduplicated: boolean };
  };
  dispatcher: Pick<CreatorCommandDispatcher, 'dispatchWorkflow'>;
  projects: { ensureDefaultProject(): { projectId: string } };
  ffmpegPath: string | undefined;
  ffprobePath: string | undefined;
  ensureRuntimeReady(): Promise<void>;
  /** Đè kiểm tra media khi kiểm thử (mặc định: ffprobe thật). */
  probeSourceMedia?(path: string): Promise<MediaProbe>;
  /** Đè logic ghép video khi kiểm thử (mặc định: ffmpeg thật). */
  mergeSegments?(request: {
    ffmpegPath: string;
    ffprobePath: string;
    segments: readonly SegmentSpec[];
    outputPath: string;
  }): Promise<{ outputPath: string; durationSeconds: number; segmentDurations: number[]; reencodedSegments: number[] }>;
  /** Gọi mỗi khi state đổi (web Streaming update). */
  onUpdate?(summary: TranslationPipelineSummary): void;
  now?: () => string;
};

const MAX_SOURCE_ITEMS = 500;
const STAGE_POLL_INTERVAL_MS = 1_000;
/** Stage run mới dispatch có thể chưa thấy ngay — chờ tối đa 15s trước khi báo mất. */
const STAGE_APPEAR_TIMEOUT_MS = 15_000;
/** Dịch một video có thể chạy hàng giờ — chờ tối đa 6 giờ để bắt treo. */
const STAGE_WAIT_TIMEOUT_MS = 6 * 60 * 60_000;
/** Chênh lệch thời lượng cho phép giữa video ghép với tổng phân đoạn. */
// (hằng số MERGE_DURATION_TOLERANCE_RATIO nằm trong merge.js)

export function createTranslationPipelineService(
  input: TranslationPipelineServiceInput
): TranslationPipelineService {
  const now = input.now ?? (() => new Date().toISOString());
  const pipelineDir = join(input.dataDir, 'translation-pipeline');
  const statePath = join(pipelineDir, 'pipeline.json');
  const uploadFolder = join(input.dataDir, 'upload-pending');
  let closed = false;
  let pumpRunning = false;
  let mergeRunning = false;

  function ensureTools(): void {
    if (input.ffmpegPath === undefined) {
      throw new Error('ffmpeg không khả dụng trong thành phần runtime');
    }
    if (input.ffprobePath === undefined) {
      throw new Error('ffprobe không khả dụng trong thành phần runtime');
    }
  }

  function defaultState(): TranslationPipelineState {
    return { items: [], paused: false, merge: idleMerge() };
  }

  /** Đọc state từ đĩa; state hỏng → bắt đầu mới (không chặn daemon). */
  function readState(): TranslationPipelineState {
    // Bản nháp chưa flush là state mới nhất.
    if (inMemory !== undefined) return inMemory;
    let text: string;
    try {
      text = readFileSync(statePath, 'utf8');
    } catch {
      return defaultState();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return defaultState();
    }
    if (typeof parsed !== 'object' || parsed === null) return defaultState();
    const state = parsed as TranslationPipelineState;
    return {
      items: Array.isArray(state.items) ? state.items.filter(isEpisode) : [],
      paused: state.paused === true,
      merge: isMerge(state.merge) ? state.merge : idleMerge()
    };
  }

  /** Ghi state nguyên tử: tmp + rename (bên trong chuỗi serialized). */
  async function writeState(state: TranslationPipelineState): Promise<void> {
    await mkdir(pipelineDir, { recursive: true });
    const tmpPath = `${statePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmpPath, statePath);
  }

  // State "chưa flush" giữ trong bộ nhớ; đĩa được ghi tuần tự phía sau.
  let inMemory: TranslationPipelineState | undefined;
  // Chuỗi ghi đĩa serialized để không ghi chồng lấn.
  let stateChain: Promise<void> = Promise.resolve();

  function mutateSync(fn: (draft: TranslationPipelineState) => void): void {
    // Bản nháp chưa flush trong bộ nhớ là state mới nhất — đĩa luôn chậm hơn.
    const draft = inMemory ?? readState();
    fn(draft);
    inMemory = draft;
    const snapshot = draft;
    stateChain = stateChain.then(async () => {
      try {
        await writeState(snapshot);
      } catch (error) {
        // Ghi state thất bại không được làm chết chuỗi — daemon vẫn phải hoạt động.
        console.warn(`[translation-pipeline] ghi state thất bại: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (inMemory === snapshot) inMemory = undefined;
      input.onUpdate?.(summarize(snapshot));
    }, () => undefined);
  }

  return {
    getSummary(): TranslationPipelineSummary {
      return summarize(readState());
    },
    enqueue(requests: readonly PipelineEnqueueRequest[]): TranslationPipelineSummary {
      ensureTools();
      let accepted = 0;
      let summary: TranslationPipelineSummary | undefined;
      mutateSync(draft => {
        const seen = new Set(draft.items.map(item => item.sourcePath));
        for (const request of requests) {
          const path = normalizePath(request.path);
          if (path === '' || seen.has(path)) continue;
          if (draft.items.length >= MAX_SOURCE_ITEMS) break;
          seen.add(path);
          draft.items.push({
            id: randomUUID(),
            sourcePath: path,
            title: request.title !== undefined && request.title !== '' ? request.title : baseName(request.path),
            seriesKey: request.seriesKey ?? null,
            episodeIndex: typeof request.episodeIndex === 'number' && Number.isFinite(request.episodeIndex)
              ? Math.trunc(request.episodeIndex)
              : null,
            addedAt: now(),
            status: 'queued',
            jobId: null,
            error: null,
            outputVideoPath: null,
            durationSeconds: null,
            merged: false,
            mergeRunId: null
          });
          accepted += 1;
        }
        // Nạp đợt mới → phiên ghép mới, không dính kết quả cũ.
        if (accepted > 0) draft.merge = idleMerge();
        summary = summarize(draft);
      });
      void accepted;
      void wake();
      return summary ?? summarize(readState());
    },
    pause(): TranslationPipelineSummary {
      mutateSync(draft => { draft.paused = true; });
      return summarize(readState());
    },
    resume(): TranslationPipelineSummary {
      mutateSync(draft => { draft.paused = false; });
      void pump();
      return summarize(readState());
    },
    remove(episodeId: string): TranslationPipelineSummary {
      mutateSync(draft => {
        const index = draft.items.findIndex(item => item.id === episodeId);
        if (index === -1) return;
        const item = draft.items[index]!;
        if (item.status === 'running') {
          item.status = 'canceled';
          item.error = 'Đã hủy khỏi hàng đợi tự động dịch';
          return;
        }
        draft.items.splice(index, 1);
      });
      return summarize(readState());
    },
    retry(episodeId: string): TranslationPipelineSummary {
      ensureTools();
      mutateSync(draft => {
        const item = draft.items.find(candidate => candidate.id === episodeId);
        if (item === undefined || (item.status !== 'failed' && item.status !== 'canceled')) return;
        item.status = 'queued';
        item.error = null;
        item.jobId = null;
        item.outputVideoPath = null;
        item.durationSeconds = null;
        item.merged = false;
        item.mergeRunId = null;
        draft.merge = idleMerge();
      });
      void pump();
      return summarize(readState());
    },
    clearFinished(): { summary: TranslationPipelineSummary; removed: number } {
      let removed = 0;
      mutateSync(draft => {
        const before = draft.items.length;
        draft.items = draft.items.filter(item =>
          item.status === 'queued' || item.status === 'running'
        );
        removed = before - draft.items.length;
        if (draft.items.length === 0) draft.merge = idleMerge();
      });
      return { summary: summarize(readState()), removed };
    },
    mergeNow(): TranslationPipelineSummary {
      ensureTools();
      void (async () => {
        await pump();
        await runMerge(true);
      })();
      return summarize(readState());
    },
    recover(): Promise<void> {
      mutateSync(draft => {
        for (const item of draft.items) {
          if (item.status === 'running') item.status = 'queued';
        }
        if (draft.merge.status === 'running') draft.merge = idleMerge();
      });
      void pump();
      return Promise.resolve();
    },
    close(): Promise<void> {
      closed = true;
      return Promise.resolve();
    }
  };

  function summarize(state: TranslationPipelineState): TranslationPipelineSummary {
    return {
      ...state,
      uploadFolder,
      counts: {
        queued: state.items.filter(item => item.status === 'queued').length,
        running: state.items.filter(item => item.status === 'running').length,
        completed: state.items.filter(item => item.status === 'completed').length,
        failed: state.items.filter(item => item.status === 'failed').length
      }
    };
  }

  function findQueued(state: TranslationPipelineState): PipelineEpisode | undefined {
    return state.items.find(item => item.status === 'queued');
  }

  async function pump(): Promise<void> {
    if (pumpRunning) return;
    await stateChain;
    pumpRunning = true;
    try {
      while (!closed && !readState().paused) {
        const next = findQueued(readState());
        if (next === undefined) break;
        applyItem(next.id, { status: 'running', error: null });
        try {
          await translateEpisode(next);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[translation-pipeline] dịch "${next.title}" thất bại: ${message}`);
          applyItem(next.id, { status: 'failed', error: message });
        }
        if (closed) return;
        await stateChain;
      }
      if (!closed && !readState().paused) await runMergeAuto();
    } finally {
      pumpRunning = false;
      void wake();
    }
  }

  async function wake(): Promise<void> {
    if (closed) return;
    await stateChain;
    if (readState().paused) return;
    if (findQueued(readState()) === undefined) return;
    await pump();
  }

  async function translateEpisode(item: PipelineEpisode): Promise<void> {
    ensureTools();
    await input.ensureRuntimeReady();
    // Tái dùng job cũ nếu lần trước bị nửa chừng (creationKey ổn định).
    const existing = item.jobId === null ? undefined : input.creator.getJob(item.jobId);
    let job = existing;
    if (job === undefined) {
      job = await input.creator.createJob({
        projectId: input.projects.ensureDefaultProject().projectId,
        templateId: 'video-translation',
        creationKey: `translation-pipeline:${item.id}`
      });
      applyItem(item.id, { jobId: job.id });
    }
    if (job.artifacts.find(artifact =>
      artifact.kind === 'source_video' && artifact.status === 'completed'
    ) === undefined) {
      const probe = await probeSource(item.sourcePath);
      const sha256 = await hashFile(item.sourcePath);
      const info = await stat(item.sourcePath);
      input.creator.registerSourceVideo(job.id, {
        expectedRevision: requireJob(job.id).revision,
        path: item.sourcePath,
        fileName: baseName(item.sourcePath),
        mimeType: 'video/mp4',
        size: info.size,
        sha256,
        lastModified: Math.trunc(info.mtimeMs),
        media: probe
      });
      applyItem(item.id, { durationSeconds: Math.round(probe.duration) });
    }
    // Cấu hình tự động dịch: bật lồng tiếng (schema mặc định targetLanguage 'vi',
    // keepBackgroundAudio true — giữ nhạc nền 80%).
    await dispatchSettings(job.id, { dubbing: true as const, sourceType: 'file' as const });
    await runStageWait(job.id, 'subtitle');
    await runStageWait(job.id, 'tts');
    await runStageWait(job.id, 'render-horizontal');
    const video = requireJob(job.id).artifacts.find(artifact =>
      artifact.kind === 'horizontal_video'
      && artifact.status === 'completed'
      && artifact.path !== null
    );
    if (video === undefined || video.path === null) {
      throw new Error('Dịch xong nhưng không tìm thấy video ngang trong artifacts');
    }
    const probe = await probeSource(video.path);
    applyItem(item.id, {
      status: 'completed',
      outputVideoPath: normalizePath(video.path),
      durationSeconds: Math.round(probe.duration),
      error: null
    });
  }

  async function dispatchSettings(jobId: string, patch: Record<string, CreatorJson>): Promise<void> {
    const job = requireJob(jobId);
    if (Object.entries(patch).every(([key, value]) => job.state[key] === value)) return;
    await input.dispatcher.dispatchWorkflow(jobId, {
      action: 'update-settings',
      expectedRevision: job.revision,
      idempotencyKey: `translation-pipeline:settings:${jobId}:${job.revision}`,
      input: { patch }
    }, { scopeKey: 'translation-pipeline' });
  }

  async function runStageWait(jobId: string, stageId: string): Promise<void> {
    const job = requireJob(jobId);
    const previous = job.stages.find(candidate => candidate.stageId === stageId);
    if (previous !== undefined && terminal(previous.status)) {
      if (previous.status === 'succeeded') return;
      throw new Error(previous.errorMessage ?? `Giai đoạn ${stageId} ở trạng thái ${previous.status}`);
    }
    const result = input.dispatcher.dispatchWorkflow(jobId, {
      action: 'run-stage',
      expectedRevision: job.revision,
      idempotencyKey: `translation-pipeline:stage:${jobId}:${stageId}`,
      input: { stageId }
    }, { scopeKey: 'translation-pipeline' });
    const receipt = result.commandReceipt;
    if (receipt.stageRunId === null) {
      throw new Error(`Giai đoạn ${stageId} không trả stageRunId (status ${receipt.status})`);
    }
    await waitForTerminal(jobId, stageId, receipt.stageRunId);
  }

  async function waitForTerminal(jobId: string, stageId: string, stageRunId: string): Promise<void> {
    const started = Date.now();
    let missingSince = Date.now();
    while (!closed) {
      const run = requireJob(jobId).stages.find(candidate => candidate.id === stageRunId);
      if (run === undefined) {
        // Stage run có thể chưa được ghi (log dispatch chậm) — nhẫn nại một khoảng ngắn rồi mới báo lỗi.
        if (Date.now() - missingSince <= STAGE_APPEAR_TIMEOUT_MS) {
          await delay(STAGE_POLL_INTERVAL_MS);
          continue;
        }
        throw new Error(`Stage run của ${stageId} biến mất`);
      }
      missingSince = Date.now();
      if (terminal(run.status)) {
        if (run.status === 'succeeded') return;
        throw new Error(run.errorMessage ?? `Giai đoạn ${stageId} ${run.status}`);
      }
      if (Date.now() - started > STAGE_WAIT_TIMEOUT_MS) {
        throw new Error(`Chờ giai đoạn ${stageId} quá ${Math.round(STAGE_WAIT_TIMEOUT_MS / 3_600_000)} giờ`);
      }
      await delay(STAGE_POLL_INTERVAL_MS);
    }
  }

  function requireJob(jobId: string): CreatorJob {
    const job = input.creator.getJob(jobId);
    if (job === undefined) throw new Error(`Creator job ${jobId} không tồn tại`);
    return job;
  }

  async function probeSource(path: string): Promise<MediaProbe> {
    ensureTools();
    await input.ensureRuntimeReady();
    if (input.probeSourceMedia !== undefined) {
      return await input.probeSourceMedia(path);
    }
    return await validateMediaFile(path, input.ffprobePath!);
  }

  async function hashFile(path: string): Promise<string> {
    const bytes = await readFile(path);
    return createHash('sha256').update(bytes).digest('hex');
  }

  /** Tự ghép khi hàng đợi trống (MERGE_ON_QUEUE_DRAIN). */
  async function runMergeAuto(): Promise<void> {
    if (mergeRunning) return;
    const state = readState();
    if (state.merge.status === 'completed') return;
    if (state.items.filter(item => item.status === 'completed').length < 1) return;
    await runMerge(false);
  }

  /**
   * Ghép các phân đoạn hoàn thành; `force` = bấm nút ngay cả khi hàng đợi còn
   * việc (chỉ ghép phần đã xong). Merge chạy rồi thì trả về nguyên cũ.
   */
  async function runMerge(force: boolean): Promise<void> {
    if (mergeRunning) return;
    const state = readState();
    if (state.merge.status === 'running') return;
    if (state.items.some(item => item.status === 'running') && !force) return;
    const completed = state.items
      .filter(item => item.status === 'completed' && item.outputVideoPath !== null);
    if (completed.length === 0) {
      if (force) {
        mutateSync(draft => {
          draft.merge = {
            status: 'failed',
            runId: null,
            outputPath: null,
            uploadReady: null,
            episodeCount: null,
            skipped: [],
            error: 'Chưa có phân đoạn nào đã dịch xong để ghép'
          };
        });
      }
      return;
    }
    mergeRunning = true;
    const runId = randomUUID();
    const skipped = state.items
      .filter(item => item.status !== 'completed')
      .map(item => ({
        title: item.title,
        episodeIndex: item.episodeIndex,
        reason: item.error ?? `trạng thái ${item.status}`
      }));
    mutateSync(draft => {
      draft.merge = {
        status: 'running',
        runId,
        outputPath: null,
        uploadReady: null,
        episodeCount: null,
        skipped,
        error: null
      };
    });
    try {
      await mkdir(pipelineDir, { recursive: true });
      // Ghép theo THỨ TỰ TẬP (episodeIndex) — không lệch, không lộn xộn.
      const segments = [...completed].sort(compareMergeOrder).map((item, index): SegmentSpec => ({
        path: item.outputVideoPath!,
        episodeIndex: item.episodeIndex,
        positionHint: index + 1
      }));
      const outputPath = join(pipelineDir, `merged-${runId}.mp4`);
      const report = (input.mergeSegments !== undefined
        ? await input.mergeSegments({
            ffmpegPath: input.ffmpegPath!,
            ffprobePath: input.ffprobePath!,
            segments,
            outputPath
          })
        : await mergeVideoSegments({
            ffmpegPath: input.ffmpegPath!,
            ffprobePath: input.ffprobePath!,
            segments,
            outputPath
          }));
      if (!Number.isFinite(report.durationSeconds)) {
        throw new Error('Video ghép không đọc được thời lượng');
      }
      await mkdir(uploadFolder, { recursive: true });
      const uploadPath = join(uploadFolder, `pending-${baseName(outputPath)}`);
      await rm(uploadPath, { force: true });
      await copyFile(report.outputPath, uploadPath);
      mutateSync(draft => {
        for (const item of draft.items) {
          if (item.status === 'completed') {
            item.merged = true;
            item.mergeRunId = runId;
          }
        }
        draft.merge = {
          status: 'completed',
          runId,
          outputPath: report.outputPath,
          uploadReady: uploadPath,
          episodeCount: segments.length,
          skipped,
          error: null
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[translation-pipeline] ghép video thất bại: ${message}`);
      mutateSync(draft => {
        draft.merge = {
          status: 'failed',
          runId,
          outputPath: null,
          uploadReady: null,
          episodeCount: null,
          skipped,
          error: message
        };
      });
    } finally {
      mergeRunning = false;
    }
  }

  function compareMergeOrder(left: PipelineEpisode, right: PipelineEpisode): number {
    const leftIndex = left.episodeIndex ?? Number.POSITIVE_INFINITY;
    const rightIndex = right.episodeIndex ?? Number.POSITIVE_INFINITY;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.addedAt.localeCompare(right.addedAt);
  }

  function applyItem(episodeId: string, patch: Partial<Omit<PipelineEpisode, 'id'>>): void {
    mutateSync(draft => {
      const item = draft.items.find(candidate => candidate.id === episodeId);
      if (item !== undefined) Object.assign(item, patch);
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers dùng chung (export để test)
// ---------------------------------------------------------------------------

export function idleMerge(): TranslationPipelineMerge {
  return {
    status: 'idle',
    runId: null,
    outputPath: null,
    uploadReady: null,
    episodeCount: null,
    skipped: [],
    error: null
  };
}

export function baseName(path: string): string {
  const slash = path.replace(/\\/g, '/').lastIndexOf('/');
  return path.replace(/\\/g, '/').slice(slash + 1);
}

export function terminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'interrupted';
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '') return '';
  return normalize(trimmed);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function isEpisode(value: unknown): value is PipelineEpisode {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PipelineEpisode>;
  return typeof candidate.id === 'string' && typeof candidate.sourcePath === 'string'
    && typeof candidate.status === 'string';
}

function isMerge(value: unknown): value is TranslationPipelineMerge {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as TranslationPipelineMerge;
  return typeof candidate.status === 'string';
}
