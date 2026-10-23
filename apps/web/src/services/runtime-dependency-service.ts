import type {
  CreatorRuntimeComponent,
  CreatorRuntimeComponentsResponse,
  CreatorYtDlpStatusResponse,
  HongguoComponentStatusResponse,
  HongguoDramaBatchRequest,
  HongguoDramaBatchResponse,
  HongguoDramaBrowseResponse,
  HongguoDramaCategoriesResponse,
  HongguoDramaDownloadTasksResponse,
  HongguoDramaMediaSourcesResponse,
  HongguoDramaSearchResponse,
  HongguoDramaSeriesResponse,
  HongguoDramaStatusResponse,
  HongguoDramaTitleTranslationResponse
} from '@opencreator/protocol';

type ClientLike = {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  patch?(path: string, body?: unknown): Promise<unknown>;
};

/** Trạng thái một tập trong hàng đợi "dịch cả bộ" (daemon translation-pipeline). */
export type TranslationBatchEpisode = {
  id: string;
  sourcePath: string;
  title: string;
  seriesKey: string | null;
  episodeIndex: number | null;
  addedAt: string;
  status: string;
  jobId: string | null;
  error: string | null;
  outputVideoPath: string | null;
  durationSeconds: number | null;
  merged: boolean;
  mergeRunId: string | null;
};

export type TranslationBatchMergeState = {
  /** Nhóm bộ (seriesKey) — mỗi bộ một trạng thái ghép riêng. */
  seriesKey: string | null;
  status: string;
  runId?: string | null;
  outputPath: string | null;
  uploadReady: string | null;
  episodeCount: number | null;
  error: string | null;
};

export type TranslationBatchStatus = {
  items: TranslationBatchEpisode[];
  paused: boolean;
  /**
   * v2.6 — chế độ ghép 2 chế độ: 'auto' (pipeline tự kiểm & ghép nhóm đủ tập)
   * / 'manual' (pipeline chỉ xếp hiện trạng 'waiting', chờ người dùng xác nhận).
   * Daemon cũ không có field → coi như 'auto'.
   */
  mergeMode?: 'auto' | 'manual';
  counts: { queued: number; running: number; completed: number; failed: number };
  /** Một trạng thái ghép cho mỗi bộ — chống trộn 2 bộ khi ghép. */
  merges: TranslationBatchMergeState[];
  progress: {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    canceled: number;
    allDone: boolean;
    percent: number;
  };
  fullMovie?: {
    status: string;
    outputPath: string | null;
    episodeCount: number | null;
    seriesName: string | null;
    error: string | null;
  };
  uploadFolder: string;
};

export type TranslationBatchEnqueueRequest = {
  items: Array<{
    path: string;
    title?: string;
    episodeIndex?: number;
    /** v2 — định danh bộ để ghép đúng bộ, đúng thứ tự; bỏ trống = nhóm lẻ. */
    seriesKey?: string;
    /** v2 — nạp theo cả bộ: chờ ghép xong rồi mới nạp đăng full movie. */
    batchMode?: boolean;
  }>;
  seriesName?: string;
};

export function createRuntimeDependencyService(client: ClientLike) {
  return {
    getComponentsStatus(): Promise<CreatorRuntimeComponentsResponse> {
      return client.get('/creator/components/status') as Promise<CreatorRuntimeComponentsResponse>;
    },
    downloadComponents(componentId?: CreatorRuntimeComponent['id']): Promise<CreatorRuntimeComponentsResponse> {
      return client.post('/creator/components/download', componentId === undefined ? undefined : { componentId }) as Promise<CreatorRuntimeComponentsResponse>;
    },
    getYtDlpStatus(): Promise<CreatorYtDlpStatusResponse> {
      return client.get('/creator/yt-dlp/status') as Promise<CreatorYtDlpStatusResponse>;
    },
    checkYtDlpUpdate(force = true): Promise<CreatorYtDlpStatusResponse> {
      return client.post(
        '/creator/yt-dlp/check',
        { force }
      ) as Promise<CreatorYtDlpStatusResponse>;
    },
    updateYtDlp(): Promise<CreatorYtDlpStatusResponse> {
      return client.post('/creator/yt-dlp/update') as Promise<CreatorYtDlpStatusResponse>;
    },
    getHongguoStatus(): Promise<HongguoComponentStatusResponse> {
      return client.get('/creator/hongguo/status') as Promise<HongguoComponentStatusResponse>;
    },
    checkHongguoUpdate(force = true): Promise<HongguoComponentStatusResponse> {
      return client.post(
        '/creator/hongguo/check',
        { force }
      ) as Promise<HongguoComponentStatusResponse>;
    },
    updateHongguo(): Promise<HongguoComponentStatusResponse> {
      return client.post('/creator/hongguo/update') as Promise<HongguoComponentStatusResponse>;
    },
    /** Lưu kênh phát hành (channel) của component Hồng Quá — rỗng ⇒ xoá kênh. */
    setHongguoChannel(url: string): Promise<HongguoComponentStatusResponse> {
      return client.post('/creator/hongguo/channel', { url }) as Promise<HongguoComponentStatusResponse>;
    },
    // -------------------------------------------------------------------------
    // Drama discovery (Khám phá phim / Gợi ý hot) - proxied to the component's
    // loopback API; the daemon launches the component on the first call.
    // -------------------------------------------------------------------------
    getDramaStatus(): Promise<HongguoDramaStatusResponse> {
      return client.get('/creator/drama/status') as Promise<HongguoDramaStatusResponse>;
    },
    getDramaMediaSources(): Promise<HongguoDramaMediaSourcesResponse> {
      return client.get('/creator/drama/media-sources') as Promise<HongguoDramaMediaSourcesResponse>;
    },
    getDramaCategories(): Promise<HongguoDramaCategoriesResponse> {
      return client.get('/creator/drama/categories') as Promise<HongguoDramaCategoriesResponse>;
    },
    browseDrama(query: {
      source?: string;
      category?: string;
      genre?: string;
      page?: number;
      forceRefresh?: boolean;
    }): Promise<HongguoDramaBrowseResponse> {
      const params = new URLSearchParams();
      if (query.source !== undefined && query.source !== '') params.set('source', query.source);
      if (query.category !== undefined && query.category !== '') params.set('category', query.category);
      if (query.genre !== undefined && query.genre !== '') params.set('genre', query.genre);
      if (query.page !== undefined) params.set('page', String(query.page));
      if (query.forceRefresh === true) params.set('forceRefresh', 'true');
      const suffix = params.toString();
      return client.get(`/creator/drama/browse${suffix === '' ? '' : `?${suffix}`}`) as Promise<HongguoDramaBrowseResponse>;
    },
    searchDrama(keyword: string, options?: { source?: string; page?: number }): Promise<HongguoDramaSearchResponse> {
      const params = new URLSearchParams({ keyword });
      if (options?.source !== undefined && options.source !== '') params.set('source', options.source);
      if (options?.page !== undefined) params.set('page', String(options.page));
      return client.get(`/creator/drama/search?${params.toString()}`) as Promise<HongguoDramaSearchResponse>;
    },
    getDramaSeries(seriesId: string): Promise<HongguoDramaSeriesResponse> {
      return client.get(`/creator/drama/series?seriesId=${encodeURIComponent(seriesId)}`) as Promise<HongguoDramaSeriesResponse>;
    },
    getDramaSeriesEpisodes(seriesId: string): Promise<HongguoDramaSeriesResponse> {
      return client.get(`/creator/drama/series-episodes?seriesId=${encodeURIComponent(seriesId)}`) as Promise<HongguoDramaSeriesResponse>;
    },
    downloadDramaBatch(body: HongguoDramaBatchRequest): Promise<HongguoDramaBatchResponse> {
      return client.post('/creator/drama/download-batch', body) as Promise<HongguoDramaBatchResponse>;
    },
    getDramaDownloadTasks(): Promise<HongguoDramaDownloadTasksResponse> {
      return client.get('/creator/drama/download-tasks') as Promise<HongguoDramaDownloadTasksResponse>;
    },
    /** Dịch tên phim tiếng Trung sang ngôn ngữ giao diện (daemon gọi mô hình). */
    translateDramaTitles(titles: readonly string[], language?: string): Promise<HongguoDramaTitleTranslationResponse> {
      return client.post('/creator/drama/translate-titles', {
        titles: [...titles],
        language
      }) as Promise<HongguoDramaTitleTranslationResponse>;
    },
    // -------------------------------------------------------------------------
    // Dịch cả bộ (batch translation): hàng đợi tự động + ghép full movie.
    // -------------------------------------------------------------------------
    getTranslationBatch(): Promise<TranslationBatchStatus> {
      return client.get('/creator/translation-batch') as Promise<TranslationBatchStatus>;
    },
    enqueueTranslationBatch(request: TranslationBatchEnqueueRequest): Promise<TranslationBatchStatus> {
      return client.post('/creator/translation-batch/enqueue', request) as Promise<TranslationBatchStatus>;
    },
    mergeTranslationBatch(
      seriesName?: string,
      seriesKey?: string
    ): Promise<{ status: string; outputPath: string | null; episodeCount: number | null; seriesName: string | null }> {
      return client.post('/creator/translation-batch/merge', {
        ...(seriesName === undefined ? {} : { seriesName }),
        ...(seriesKey === undefined ? {} : { seriesKey })
      }) as Promise<{ status: string; outputPath: string | null; episodeCount: number | null; seriesName: string | null }>;
    },
    /** v2 — dịch lại 1 tập failed/canceled trong hàng đợi dịch cả bộ. */
    retryTranslationBatchItem(episodeId: string): Promise<TranslationBatchStatus> {
      return client.post('/creator/translation-batch/retry', { id: episodeId }) as Promise<TranslationBatchStatus>;
    },
    /** v2.2 — tạm dừng hàng đợi dịch (sau khi tập đang dịch chạy xong). */
    pauseTranslationBatch(): Promise<TranslationBatchStatus> {
      return client.post('/creator/translation-pipeline/pause', {}) as Promise<TranslationBatchStatus>;
    },
    /** v2.2 — tiếp tục hàng đợi dịch sau khi tạm dừng. */
    resumeTranslationBatch(): Promise<TranslationBatchStatus> {
      return client.post('/creator/translation-pipeline/resume', {}) as Promise<TranslationBatchStatus>;
    },
    /** v2.6 — đổi chế độ ghép: 'auto' tự ghép nhóm đủ tập / 'manual' xếp 'waiting' chờ xác nhận. */
    setTranslationMergeMode(mode: 'auto' | 'manual'): Promise<TranslationBatchStatus> {
      return client.post('/creator/translation-pipeline/merge-mode', { mode }) as Promise<TranslationBatchStatus>;
    },
    /** v2.6 — xác nhận ghép 1 bộ (chỉ xác nhận được khi đủ tập; thiếu tập daemon trả 409). */
    confirmTranslationMerge(seriesKey: string): Promise<TranslationBatchStatus> {
      return client.post('/creator/translation-pipeline/merge-confirm', { seriesKey }) as Promise<TranslationBatchStatus>;
    },
    /** Mở thư mục chứa file (Windows: Explorer chọn file). */
    revealTranslationBatch(path: string, mode: 'file' | 'directory' = 'file'): Promise<{ ok: boolean }> {
      return client.post('/creator/translation-batch/reveal', { path, mode }) as Promise<{ ok: boolean }>;
    },
    /** Đặt lại tên project ("Tên phim / bộ" trong workspace). */
    renameProject(projectId: string, name: string): Promise<{ project: { id: string; name: string } }> {
      if (client.patch === undefined) {
        return Promise.reject(new Error('project_rename_unavailable'));
      }
      return client.patch(`/projects/${encodeURIComponent(projectId)}`, { name }) as Promise<{ project: { id: string; name: string } }>;
    }
  };
}

export type RuntimeDependencyService = ReturnType<typeof createRuntimeDependencyService>;
