import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { CreatorArtifact, CreatorJob, CreatorJson } from '@opencreator/protocol';
import type { CreatorCommandDispatcher } from '../command-dispatcher.js';
import { validateMediaFile, type MediaProbe } from '../validators/media.js';
import { parseEpisodeIndex } from './episode-index.js';
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
  /** GĐ4: project do A3 chỉ định khi nạp (routes.translation-batch passthrough). */
  projectId?: string | null;
  /**
   * GĐ4: thời điểm hook tự nạp đăng đã chạy thành công cho mục này — chống nạp
   * lặp khi daemon khởi động lại (recover chỉ đuổi mục CHƯA đánh dấu).
   */
  socialEnqueuedAt?: string | null;
  /**
   * v2 "dịch cả bộ": mục nạp theo cả bộ (DramaPanes "Thêm cả bộ vào dịch" /
   * composer). Mục batch KHÔNG tự nạp đăng từng tập — chờ ghép xong cả bộ rồi
   * hook `onMerged` nạp full movie (chống đăng dư tung tập).
   */
  batchMode?: boolean;
};

export type TranslationPipelineMerge = {
  status: 'idle' | 'running' | 'completed' | 'failed';
  /** Nhóm ghép theo bộ — mỗi seriesKey một trạng thái ghép riêng (không trộn 2 bộ). */
  seriesKey: string | null;
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
  /** Một mục ghép cho MỖI bộ (seriesKey) — cá biệt: null = nhóm lẻ (không thuộc bộ nào). */
  merges: TranslationPipelineMerge[];
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
  /** GĐ4: project đích (A3 gửi kèm khi nạp cả bộ); rỗng/không có → project mặc định. */
  projectId?: string;
  /** v2: nạp theo cả bộ → dịch xong toàn bộ mới ghép + nạp đăng full movie. */
  batchMode?: boolean;
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
  projects: {
    ensureDefaultProject(): { projectId: string };
    /**
     * GĐ4: kiểm project theo id (item.projectId do A3 nạp kèm). Không có →
     * translateEpisode fallback về project mặc định (không chết giữa chừng).
     * v2: trả thêm `name` để hook onMerged lấy tên phim cho full movie.
     */
    getProject?(projectId: string): { projectId: string; name?: string } | undefined;
  };
  ffmpegPath: string | undefined;
  ffprobePath: string | undefined;
  ensureRuntimeReady(): Promise<void>;
  /**
   * GĐ4 — hook tự nạp đăng sau dịch, cài ở server.ts (điều khiển từ DAEMON):
   * gọi mỗi khi một tập dịch xong; cài đặt sẽ thông báo trong app + xếp video
   * vào hàng đợi đăng của các cụm đang bật "autoPublishAfterTranslate".
   * Ném lỗi ở đây KHÔNG làm mục dịch thất bại — pipeline chỉ log cảnh báo và
   * giữ socialEnqueuedAt trống để lần chạy sau (recover) thử lại.
   */
  onEpisodeCompleted?(info: {
    projectId?: string;
    videoPath: string;
    title: string;
    episodeIndex?: number;
  }): Promise<void>;
  /**
   * v2 "dịch cả bộ" — hook chạy mỗi khi ghép CỘT không lỗi một bộ (uploadReady
   * nằm trong `<dataDir>/upload-pending`). server.ts dùng để THÔNG BÁO + tự nạp
   * FULL MOVIE vào hàng đợi đăng đa kênh. Lỗi ở đây không đổi trạng thái ghép.
   */
  onMerged?(info: {
    seriesKey: string | null;
    projectId: string | null;
    videoPath: string;
    title: string;
    episodeCount: number;
  }): Promise<void>;
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
  // v2: đảm bảo thư mục đợi upload tồn tại ngay khi pipeline lên — không chờ
  // tới lúc ghép xong mới tạo (web/luồng đa kênh cần xem trước thư mục này).
  void mkdir(uploadFolder, { recursive: true }).catch(() => undefined);

  function ensureTools(): void {
    if (input.ffmpegPath === undefined) {
      throw new Error('ffmpeg không khả dụng trong thành phần runtime');
    }
    if (input.ffprobePath === undefined) {
      throw new Error('ffprobe không khả dụng trong thành phần runtime');
    }
  }

  function defaultState(): TranslationPipelineState {
    return { items: [], paused: false, merges: [] };
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
    // Cast mở rộng cho state cũ (chứa `merge` đơn) — migration về `merges[]`.
    const state = parsed as TranslationPipelineState & { merge?: TranslationPipelineMerge };
    return {
      items: Array.isArray(state.items) ? state.items.filter(isEpisode) : [],
      paused: state.paused === true,
      // Migration: state cũ có 1 `merge` duy nhất → thành nhóm seriesKey null;
      // state mới đọc mảng `merges` (mỗi bộ một mục).
      merges: normalizeMerges(state.merges, state.merge)
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
        // Các bộ bị đụng tới trong lượt nạp này — nạp đợt mới → phiên ghép mới
        // cho CHÍNH nhóm đó (không xoá ghép của bộ khác).
        const touchedSeries = new Set<string | null>();
        for (const request of requests) {
          const path = normalizePath(request.path);
          if (path === '' || seen.has(path)) continue;
          if (draft.items.length >= MAX_SOURCE_ITEMS) break;
          seen.add(path);
          // Không truyền episodeIndex → tự trích số tập từ tiêu đề / tên file
          // ("Tập 01", "EP01", "S01E02", "第03集", số cuối) để ghép đúng thứ tự.
          const episodeIndex = typeof request.episodeIndex === 'number' && Number.isFinite(request.episodeIndex)
            ? Math.trunc(request.episodeIndex)
            : parseEpisodeIndex(request.title, baseName(request.path));
          const seriesKey = typeof request.seriesKey === 'string' && request.seriesKey.trim() !== ''
            ? request.seriesKey.trim()
            : null;
          touchedSeries.add(seriesKey);
          draft.items.push({
            id: randomUUID(),
            sourcePath: path,
            title: request.title !== undefined && request.title !== '' ? request.title : baseName(request.path),
            seriesKey,
            episodeIndex,
            addedAt: now(),
            status: 'queued',
            jobId: null,
            error: null,
            outputVideoPath: null,
            durationSeconds: null,
            merged: false,
            mergeRunId: null,
            projectId: typeof request.projectId === 'string' && request.projectId.trim() !== ''
              ? request.projectId.trim()
              : null,
            socialEnqueuedAt: null,
            batchMode: request.batchMode === true
          });
          accepted += 1;
        }
        // Nạp đợt mới → phiên ghép mới, không dính kết quả cũ (chỉ nhóm bị nạp).
        for (const seriesKey of touchedSeries) setMerge(draft, seriesKey, idleMerge(seriesKey));
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
        // Reset ghép của ĐÚNG nhóm của tập này (không đụng bộ khác).
        setMerge(draft, item.seriesKey, idleMerge(item.seriesKey));
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
        // Gỡ trạng thái ghép của nhóm không còn item nào.
        const remainingKeys = new Set(draft.items.map(item => item.seriesKey ?? null));
        draft.merges = draft.merges.filter(mergeState => remainingKeys.has(mergeState.seriesKey));
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
        // Ghép bị ngắt giữa chừng khi daemon tắt → đặt lại trạng thái (tự ghép lại sau).
        draft.merges = draft.merges.map(mergeState =>
          mergeState.status === 'running' ? idleMerge(mergeState.seriesKey) : mergeState
        );
      });
      void (async () => {
        // GĐ4: mục đã hoàn thành mà CHƯA nạp đăng (hook rớt giữa chừng trước
        // khi daemon tắt) → đuổi lại đúng 1 lần; mục đã đánh dấu thì bỏ qua
        // (chống nạp lặp khi khởi động lại).
        if (input.onEpisodeCompleted !== undefined) {
          await replayEpisodeCompletedCallbacks();
        }
        void pump();
      })();
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

  /**
   * Lấy/trạng thái ghép của 1 nhóm (theo seriesKey). Nhóm chưa từng ghép →
   * trạng thái idle tạm (không ghi đĩa) để web đọc phep tuyệt đối.
   */
  function mergeOf(state: TranslationPipelineState, seriesKey: string | null): TranslationPipelineMerge {
    return state.merges.find(mergeState => mergeState.seriesKey === seriesKey) ?? idleMerge(seriesKey);
  }

  /** Ghi/xoá trạng thái ghép của NHÓM chỉ định trong draft (upsert). */
  function setMerge(draft: TranslationPipelineState, seriesKey: string | null, value: TranslationPipelineMerge): void {
    const index = draft.merges.findIndex(mergeState => mergeState.seriesKey === seriesKey);
    if (index === -1) {
      draft.merges.push(value);
      return;
    }
    draft.merges[index] = value;
  }

  /**
   * Chọn tập kế tiếp: `episodeIndex` NHỎ NHẤT trước (dịch từ tập 1 đến tập cuối
   * bất kể thứ tự nạp). Tập không có số tập xếp sau; số tập bằng nhau hoà theo
   * thời điểm nạp. Đây chính là yêu cầu "dịch theo thứ tự từ bé đến lớn".
   */
  function findQueued(state: TranslationPipelineState): PipelineEpisode | undefined {
    let next: PipelineEpisode | undefined;
    for (const item of state.items) {
      if (item.status !== 'queued') continue;
      if (next === undefined) {
        next = item;
        continue;
      }
      const nextIndex = next.episodeIndex ?? Number.POSITIVE_INFINITY;
      const itemIndex = item.episodeIndex ?? Number.POSITIVE_INFINITY;
      if (itemIndex < nextIndex) next = item;
      else if (itemIndex === nextIndex && item.addedAt.localeCompare(next.addedAt) < 0) next = item;
    }
    return next;
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
    let usedProjectId = input.projects.ensureDefaultProject().projectId;
    if (job === undefined) {
      usedProjectId = resolveProjectId(item);
      job = await input.creator.createJob({
        projectId: usedProjectId,
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
    // Artifact "horizontal_video" được ghi sau khi stage báo xong (đôi lúc
    // stage chạy lại và artifact cũ bị đánh dấu "stale") ⇒ chờ artifact
    // completed có path thay vì đọc ảnh chụp một lần.
    let video: CreatorArtifact | undefined;
    for (let attempt = 0; attempt < 30 && video === undefined; attempt += 1) {
      video = requireJob(job.id).artifacts.find(artifact =>
        artifact.kind === 'horizontal_video'
        && artifact.status === 'completed'
        && artifact.path !== null
      );
      if (video === undefined) {
        await new Promise(resolve => setTimeout(resolve, 1_500));
      }
    }
    if (video === undefined || video.path === null) {
      throw new Error('Dịch xong nhưng không tìm thấy video ngang trong artifacts');
    }
    const probe = await probeSource(video.path);
    const outputPath = normalizePath(video.path);
    applyItem(item.id, {
      status: 'completed',
      outputVideoPath: outputPath,
      durationSeconds: Math.round(probe.duration),
      error: null
    });
    // GĐ4: báo daemon "tập này đã dịch xong" (thông báo + tự nạp đăng theo cụm).
    await afterEpisodeCompleted(item.id, {
      projectId: usedProjectId,
      videoPath: outputPath,
      title: item.title,
      episodeIndex: item.episodeIndex === null ? undefined : item.episodeIndex
    });
  }

  /** Dựng project cho job dịch: item.projectId còn tồn tại → dùng, không → mặc định. */
  function resolveProjectId(item: PipelineEpisode): string {
    const requested = item.projectId?.trim();
    if (requested !== undefined && requested !== '' && input.projects.getProject !== undefined) {
      const project = input.projects.getProject(requested);
      if (project !== undefined) return project.projectId;
      console.warn(`[translation-pipeline] project "${requested}" không còn — dùng project mặc định cho "${item.title}"`);
    }
    return input.projects.ensureDefaultProject().projectId;
  }

  /**
   * Gọi hook tự nạp đăng: bỏ qua nếu mục đã đánh dấu socialEnqueuedAt (chống nạp
   * lặp khi restart); thành công mới đánh dấu — thất bại giữ trống để lần chạy
   * sau (recover) thử lại. Lỗi hook không bao giờ làm mục dịch chuyển trạng thái.
   */
  async function afterEpisodeCompleted(episodeId: string, info: {
    projectId?: string;
    videoPath: string;
    title: string;
    episodeIndex?: number;
  }): Promise<void> {
    if (input.onEpisodeCompleted === undefined) return;
    const current = readState().items.find(candidate => candidate.id === episodeId);
    if (current === undefined) return;
    // v2 "dịch cả bộ": mục batch KHÔNG tự nạp đăng tung tập (mỗi tập chỉ 1-2
    // phút) — chờ ghép cả bộ xong, hook `onMerged` sẽ nạp full movie thay vào.
    if (current.batchMode === true && current.seriesKey !== null) return;
    if (current.socialEnqueuedAt !== undefined && current.socialEnqueuedAt !== null
      && current.socialEnqueuedAt !== '') return;
    try {
      await input.onEpisodeCompleted(info);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[translation-pipeline] tự nạp đăng sau dịch thất bại cho "${info.title}": ${message}`);
      return;
    }
    applyItem(episodeId, { socialEnqueuedAt: now() });
  }

  /** Đuổi lại hook cho các mục đã completed mà chưa đánh dấu (daemon rớt giữa hook). */
  async function replayEpisodeCompletedCallbacks(): Promise<void> {
    if (input.onEpisodeCompleted === undefined) return;
    for (const item of readState().items) {
      if (item.status !== 'completed' || item.outputVideoPath === null) continue;
      // Mục batch đợi ghép xong mới nạp (khoan đăng tung tập).
      if (item.batchMode === true && item.seriesKey !== null) continue;
      if (item.socialEnqueuedAt !== undefined && item.socialEnqueuedAt !== null
        && item.socialEnqueuedAt !== '') continue;
      await afterEpisodeCompleted(item.id, {
        projectId: item.projectId ?? undefined,
        videoPath: item.outputVideoPath,
        title: item.title,
        episodeIndex: item.episodeIndex === null ? undefined : item.episodeIndex
      });
    }
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

  /** Nhóm items theo seriesKey (null = nhóm lẻ) — chống trộn 2 bộ khi ghép. */
  function groupBySeries(state: TranslationPipelineState): Map<string | null, PipelineEpisode[]> {
    const groups = new Map<string | null, PipelineEpisode[]>();
    for (const item of state.items) {
      const key = item.seriesKey ?? null;
      let group = groups.get(key);
      if (group === undefined) {
        group = [];
        groups.set(key, group);
      }
      group.push(item);
    }
    return groups;
  }

  /** Tự ghép khi MỖI nhóm đủ điều kiện (queue rỗng + mọi phân đoạn xong). */
  async function runMergeAuto(): Promise<void> {
    if (mergeRunning) return;
    const groups = groupBySeries(readState());
    for (const [seriesKey, group] of groups) {
      // Còn tập chờ/đang dịch trong NHÓM này → chưa ghép nhóm đó.
      if (group.some(item => item.status === 'queued' || item.status === 'running')) continue;
      const completed = group.filter(item =>
        item.status === 'completed' && item.outputVideoPath !== null
      );
      if (completed.length === 0) continue;
      // Đã ghép hết (mọi phân đoạn đã dấu merged) → bỏ qua, chống ghép lại vô ích.
      if (completed.every(item => item.merged)) continue;
      await runMerge(false, seriesKey);
      if (closed) return;
    }
  }

  /**
   * Ghép các phân đoạn hoàn thành CỦA MỘT NHÓM (seriesKey). `force` = bấm nút
   * ngay cả khi hàng đợi còn việc (chỉ ghép phần đã xong). `seriesKey === null`
   * = nhóm lẻ; `seriesKey === undefined` = ghép tất cả các nhóm lần lượt.
   */
  async function runMerge(force: boolean, seriesKey?: string | null): Promise<void> {
    if (mergeRunning) return;
    const state = readState();
    if (state.merges.some(mergeState => mergeState.status === 'running')) return;
    const groups = groupBySeries(state);
    const targets = seriesKey === undefined ? [...groups.keys()] : [seriesKey];
    for (const target of targets) {
      const group = groups.get(target) ?? [];
      if (group.some(item => item.status === 'running') && !force) continue;
      const completed = group.filter(item =>
        item.status === 'completed' && item.outputVideoPath !== null
      );
      if (completed.length === 0) {
        if (force) {
          mutateSync(draft => {
            setMerge(draft, target, {
              status: 'failed',
              seriesKey: target ?? null,
              runId: null,
              outputPath: null,
              uploadReady: null,
              episodeCount: null,
              skipped: [],
              error: 'Chưa có phân đoạn nào đã dịch xong để ghép'
            });
          });
        }
        continue;
      }
      mergeRunning = true;
      try {
        await mergeGroup(target, group, completed);
      } finally {
        mergeRunning = false;
      }
    }
  }

  /** Ghép 1 nhóm: hiểu rõ mở trạng thái → ffmpeg (hoặc copy 1 tập) → nạp onMerged. */
  async function mergeGroup(
    seriesKey: string | null,
    group: PipelineEpisode[],
    completed: PipelineEpisode[]
  ): Promise<void> {
    ensureTools();
    const runId = randomUUID();
    const skipped = group
      .filter(item => item.status !== 'completed')
      .map(item => ({
        title: item.title,
        episodeIndex: item.episodeIndex,
        reason: item.error ?? `trạng thái ${item.status}`
      }));
    mutateSync(draft => {
      setMerge(draft, seriesKey, {
        status: 'running',
        seriesKey,
        runId,
        outputPath: null,
        uploadReady: null,
        episodeCount: null,
        skipped,
        error: null
      });
    });
    try {
      await mkdir(pipelineDir, { recursive: true });
      // Ghép theo THỨ TỰ TẬP (episodeIndex) — không lệch, không lộn xộn.
      const segments = [...completed].sort(compareMergeOrder).map((item, index): SegmentSpec => ({
        path: item.outputVideoPath!,
        episodeIndex: item.episodeIndex,
        positionHint: index + 1
      }));
      let report: { outputPath: string; durationSeconds: number };
      if (segments.length === 1) {
        // Bộ chỉ có 1 tập: mergeVideoSegments yêu cầu ≥2 phân đoạn — bỏ ffmpeg,
        // lấy thẳng phân đoạn đó làm full movie (công bằng, không báo lỗi).
        report = {
          outputPath: segments[0]!.path,
          durationSeconds: completed[0]!.durationSeconds ?? 0
        };
      } else {
        const outputPath = join(pipelineDir, `merged-${runId}.mp4`);
        const merged = (input.mergeSegments !== undefined
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
        report = { outputPath: merged.outputPath, durationSeconds: merged.durationSeconds };
      }
      if (!Number.isFinite(report.durationSeconds)) {
        throw new Error('Video ghép không đọc được thời lượng');
      }
      await mkdir(uploadFolder, { recursive: true });
      // Tên đầy đủ cho file full movie load vào hàng đợi đa kênh.
      const title = fullMovieTitle(seriesKey, group);
      const uploadPath = join(uploadFolder, `pending-full-${runId}.mp4`);
      await rm(uploadPath, { force: true });
      await copyFile(report.outputPath, uploadPath);
      mutateSync(draft => {
        for (const item of draft.items) {
          if ((item.seriesKey ?? null) !== seriesKey) continue;
          if (item.status === 'completed') {
            item.merged = true;
            item.mergeRunId = runId;
          }
        }
        setMerge(draft, seriesKey, {
          status: 'completed',
          seriesKey,
          runId,
          outputPath: report.outputPath,
          uploadReady: uploadPath,
          episodeCount: segments.length,
          skipped,
          error: null
        });
      });
      // v2: hook nạp full movie vào hàng đợi đăng đa kênh. Lỗi hook không đổi trạng thái ghép.
      if (input.onMerged !== undefined) {
        const projectId = representativeProjectId(seriesKey, group);
        try {
          await input.onMerged({
            seriesKey,
            projectId,
            videoPath: uploadPath,
            title,
            episodeCount: segments.length
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[translation-pipeline] tự nạp full movie thất bại: ${message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[translation-pipeline] ghép video thất bại: ${message}`);
      mutateSync(draft => {
        setMerge(draft, seriesKey, {
          status: 'failed',
          seriesKey,
          runId,
          outputPath: null,
          uploadReady: null,
          episodeCount: null,
          skipped,
          error: message
        });
      });
    }
  }

  /** projectId đại diện của nhóm (item đầu có projectId hợp lệ). */
  function representativeProjectId(seriesKey: string | null, group: PipelineEpisode[]): string | null {
    if (input.projects.getProject === undefined) return null;
    for (const item of group) {
      const requested = item.projectId?.trim();
      if (requested === undefined || requested === '') continue;
      const project = input.projects.getProject(requested);
      if (project !== undefined) return project.projectId;
    }
    return null;
  }

  /** Tên full movie: tên project của nhóm (server trả `name`) → tên item đầu. */
  function fullMovieTitle(seriesKey: string | null, group: PipelineEpisode[]): string {
    if (input.projects.getProject !== undefined) {
      for (const item of group) {
        const requested = item.projectId?.trim();
        if (requested === undefined || requested === '') continue;
        const project = input.projects.getProject(requested);
        if (project?.name !== undefined && project.name !== '') return project.name;
      }
    }
    const first = [...group].sort(compareMergeOrder)[0];
    return first?.title ?? `bộ-${seriesKey ?? 'lẻ'}`;
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

export function idleMerge(seriesKey: string | null = null): TranslationPipelineMerge {
  return {
    status: 'idle',
    seriesKey,
    runId: null,
    outputPath: null,
    uploadReady: null,
    episodeCount: null,
    skipped: [],
    error: null
  };
}

/** Chuẩn hoá mảng merges từ đĩa; legacy 1 `merge` → nhóm seriesKey null. */
export function normalizeMerges(
  value: unknown,
  legacy: unknown
): TranslationPipelineMerge[] {
  const normalized: TranslationPipelineMerge[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const mergeState = normalizeMergeEntry(entry);
      if (mergeState !== null) normalized.push(mergeState);
    }
  }
  // Chưa từng có dạng mới mà đĩa còn giữ dạng cũ → migrate giữ nguyên kết quả cũ.
  if (normalized.length === 0 && normalizeMergeEntry(legacy) !== null) {
    const mergeState = normalizeMergeEntry(legacy)!;
    normalized.push({ ...mergeState, seriesKey: mergeState.seriesKey ?? null });
  }
  return normalized;
}

function normalizeMergeEntry(value: unknown): TranslationPipelineMerge | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<TranslationPipelineMerge>;
  if (typeof candidate.status !== 'string') return null;
  return {
    status: candidate.status === 'running' || candidate.status === 'completed' || candidate.status === 'failed'
      ? candidate.status
      : 'idle',
    seriesKey: typeof candidate.seriesKey === 'string' ? candidate.seriesKey : null,
    runId: typeof candidate.runId === 'string' ? candidate.runId : null,
    outputPath: typeof candidate.outputPath === 'string' ? candidate.outputPath : null,
    uploadReady: typeof candidate.uploadReady === 'string' ? candidate.uploadReady : null,
    episodeCount: typeof candidate.episodeCount === 'number' ? candidate.episodeCount : null,
    skipped: Array.isArray(candidate.skipped) ? candidate.skipped : [],
    error: typeof candidate.error === 'string' ? candidate.error : null
  };
}

function isEpisode(value: unknown): value is PipelineEpisode {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PipelineEpisode>;
  return typeof candidate.id === 'string' && typeof candidate.sourcePath === 'string'
    && typeof candidate.status === 'string';
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
