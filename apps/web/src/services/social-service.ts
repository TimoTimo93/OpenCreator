import type { RuntimeClient } from '../runtime/client.js';

/**
 * Dịch vụ frontend cho Mạng Lưới Đăng Đa Kênh (REST /social/* của daemon).
 * Kiểu phản hồi mô phỏng nghiêm ngặt cấu trúc trả về của apps/daemon/src/social —
 * chỉ dùng cho trình bày, không thay thế nguồn sự thật phía daemon.
 */

export type SocialPlatformStatuses = {
  status: 'pending' | 'running' | 'published' | 'scheduled' | 'failed' | 'skipped';
  attempts: number;
  videoId: string | null;
  error: string | null;
  publishedAt: string | null;
};

export type SocialClusterSummary = {
  id: string;
  name: string;
  seriesName: string;
  proxyServer: string;
  proxyStatus: 'unchecked' | 'checking' | 'online' | 'dead' | 'no_proxy';
  proxyDetail: string | null;
  fbMode: 'graph_api' | 'browser';
  fbPageId: string;
  fbPageTokenConfigured: boolean;
  defaultScheduleTimes: string[];
  defaultDescription: string;
  ytChannelUrl: string;
  tkProfileUrl: string;
  /** Tên kênh YouTube đã liên kết (đọc từ Studio sau khi đăng nhập tay). */
  ytAccountName?: string;
  /** ID kênh YouTube đã liên kết (UC...). */
  ytAccountId?: string;
  /** Tên tài khoản TikTok đã liên kết. */
  tkAccountName?: string;
  /** Tên tài khoản/Page Facebook đã liên kết. */
  fbAccountName?: string;
  /** Email Facebook dùng để đăng nhập tự động cho cụm. */
  fbLoginEmail?: string;
  /** Đã đăng nhập nhưng tài khoản chưa có kênh YouTube (cần tạo kênh). */
  needsChannel?: boolean;
  autoReplyEnabled: boolean;
  autoReplyPrompt: string;
  /** GĐ4: bật tự nạp đăng sau khi dịch xong (daemon hook, công tắc theo cụm). */
  autoPublishAfterTranslate: boolean;
  loginStatus: { youtube: string; tiktok: string; facebook: string };
  browserOpen: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SocialJobSummary = {
  id: string;
  clusterId: string;
  clusterName: string;
  videoPath: string;
  thumbnailPath: string | null;
  title: string;
  description: string;
  scheduledAt: string;
  status?: unknown;
  platforms: {
    youtube: SocialPlatformStatuses;
    tiktok: SocialPlatformStatuses;
    facebook: SocialPlatformStatuses;
  };
  /** Cài đặt riêng từng nền tảng của job (tùy chọn, trả về từ overview). */
  platformSettings?: SocialJobPlatformSettings;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Cài đặt riêng từng nền tảng khi soạn bài đăng đa kênh
// ---------------------------------------------------------------------------

export type SocialYoutubeSettings = {
  /** 'public' | 'unlisted' | 'private' */
  privacy: string;
  /** Mảng tags (daemon ghép và giới hạn tổng độ dài). */
  tags?: string[];
  madeForKids?: boolean;
};

export type SocialTiktokSettings = {
  /** 'public' | 'friends' | 'private' */
  privacy?: string;
  allowDuet?: boolean;
  allowStitch?: boolean;
  allowComments?: boolean;
  /** Đăng trực tiếp, bỏ màn hình soạn của TikTok. */
  directPost?: boolean;
};

export type SocialFacebookSettings = {
  /** 'post' | 'reel' | 'story' */
  postType?: string;
};

export type SocialJobPlatformSettings = {
  youtube?: SocialYoutubeSettings;
  tiktok?: SocialTiktokSettings;
  facebook?: SocialFacebookSettings;
};

export type SocialCounts = {
  pending: number;
  running: number;
  published: number;
  scheduled: number;
  failed: number;
  skipped: number;
};

export type SocialOverview = {
  queue: 'running' | 'paused';
  counts: SocialCounts;
  clusters: SocialClusterSummary[];
  jobs: SocialJobSummary[];
};

export type SocialEnqueueResult = {
  accepted: number;
  duplicates: string[];
  summary: SocialOverview;
};

export type SocialClusterInput = {
  name?: string;
  seriesName?: string;
  proxyServer?: string;
  fbMode?: 'graph_api' | 'browser';
  fbPageId?: string;
  /** null = xóa token đã lưu. */
  fbPageToken?: string | null;
  defaultScheduleTimes?: string[];
  defaultDescription?: string;
  /** GĐ3: URL kênh YouTube / profile TikTok để quét thống kê. */
  ytChannelUrl?: string;
  tkProfileUrl?: string;
  /** GĐ3: bật AI tự trả lời bình luận cho cụm. */
  autoReplyEnabled?: boolean;
  autoReplyPrompt?: string;
  /** GĐ4: bật tự nạp đăng sau khi dịch xong (daemon tự xếp khung giờ vàng). */
  autoPublishAfterTranslate?: boolean;
};

export type SocialEnqueueItem = {
  /** Nạp cho 1 cụm, hoặc dùng clusterIds để nạp cùng lúc nhiều cụm. */
  clusterId?: string;
  clusterIds?: string[];
  path: string;
  title?: string;
  description?: string;
  thumbnailPath?: string | null;
  scheduledAt?: string;
  platformSettings?: SocialJobPlatformSettings;
};

export type SocialProxyCheckResult = {
  status: 'online' | 'dead' | 'no_proxy';
  detail: string | null;
};

/** Nền tảng tài khoản trong cụm kênh. */
export type SocialPlatformName = 'youtube' | 'tiktok' | 'facebook';

export const SOCIAL_PLATFORM_NAMES: readonly SocialPlatformName[] = ['youtube', 'tiktok', 'facebook'];

// ---------------------------------------------------------------------------
// Video đã dịch xong — nguồn chọn media dành cho hàng đợi đăng đa kênh
// ---------------------------------------------------------------------------

/** Loại artifact là video hoàn chỉnh của job dịch video. */
export const TRANSLATED_VIDEO_KINDS: readonly string[] = ['horizontal_video', 'vertical_video', 'dubbed_video'];
/** templateId của luồng dịch video trên daemon. */
export const TRANSLATED_VIDEO_TEMPLATE_ID = 'video-translation';

export type SocialTranslatedVideo = {
  jobId: string;
  artifactId: string;
  /** Đường dẫn file trên đĩa (video hoàn chỉnh hoặc export). */
  path: string;
  title: string;
  kind: string;
  version: number;
  /** Thời điểm artifact hoàn tất (ISO). */
  completedAt: string;
};

export type SocialTranslatedVideosResult = { items: SocialTranslatedVideo[] };

/** Nguồn danh sách creator job trên web (đề phòng vòng import, dùng kiểu cấu trúc). */
export type SocialCreatorJobsProvider = {
  listJobs(projectId?: string): Promise<{ jobs: ReadonlyArray<{
    id: string;
    templateId: string;
    status: string;
    artifacts: ReadonlyArray<{
      id: string;
      kind: string;
      version: number;
      status: string;
      path: string | null;
      createdAt: string;
    }>;
  }> }>;
};

/** Lọc creator jobs đã hoàn tất của luồng dịch video → các video hoàn chỉnh sẵn sàng đăng đa kênh. */
export function translatedVideosFromCreatorJobs(
  jobs: ReadonlyArray<Awaited<ReturnType<SocialCreatorJobsProvider['listJobs']>>['jobs'][number]>
): SocialTranslatedVideo[] {
  const items: SocialTranslatedVideo[] = [];
  for (const job of jobs) {
    if (job.templateId !== TRANSLATED_VIDEO_TEMPLATE_ID) continue;
    if (job.status !== 'completed') continue;
    for (const artifact of job.artifacts) {
      // 'stale' vẫn là bản dịch hoàn thành đã từng có file trên đĩa — dùng
      // được để đăng; artifact chưa hoàn tất thì bỏ.
      if (artifact.status !== 'completed' && artifact.status !== 'stale') continue;
      if (!TRANSLATED_VIDEO_KINDS.includes(artifact.kind)) continue;
      const path = artifact.path;
      if (typeof path !== 'string' || path.trim() === '') continue;
      items.push({
        jobId: job.id,
        artifactId: artifact.id,
        path,
        title: fileNameOfPath(path),
        kind: artifact.kind,
        version: artifact.version,
        completedAt: artifact.createdAt
      });
    }
  }
  // Mới nhất trước, bỏ trùng đúng một đường dẫn (bản dịch xuất sau cùng).
  const dedupe = new Map<string, SocialTranslatedVideo>();
  for (const item of [...items].sort((left, right) => right.completedAt.localeCompare(left.completedAt))) {
    if (!dedupe.has(item.path)) dedupe.set(item.path, item);
  }
  return [...dedupe.values()];
}

/** Nạp danh sách video đã dịch xong qua creator service của web (bỏ qua khi không có). */
export async function listTranslatedVideos(
  creatorService: SocialCreatorJobsProvider,
  projectId?: string
): Promise<SocialTranslatedVideosResult> {
  const scoped = projectId === undefined || projectId.trim() === '' ? undefined : projectId;
  const response = await creatorService.listJobs(scoped);
  return { items: translatedVideosFromCreatorJobs(response.jobs) };
}

// ---------------------------------------------------------------------------
// Media picker — video đã tải trong thư mục downloads của daemon
// ---------------------------------------------------------------------------

export type SocialDownloadItem = {
  path: string;
  title: string;
  seriesName: string;
  downloadedAt: string;
  sizeBytes: number;
};

export type SocialDownloadsResult = {
  items: SocialDownloadItem[];
};

// ---------------------------------------------------------------------------
// GĐ3 — thống kê view/sub + bình luận
// ---------------------------------------------------------------------------

export type SocialMetricPoint = {
  value: number;
  capturedAt: string;
  previous: number | null;
};

export type SocialChannelStat = {
  clusterId: string;
  clusterName: string;
  platform: 'youtube' | 'tiktok' | 'facebook';
  metrics: {
    followers?: SocialMetricPoint;
    views?: SocialMetricPoint;
    likes?: SocialMetricPoint;
    videos?: SocialMetricPoint;
  };
};

export type SocialVideoStat = {
  jobId: string;
  clusterId: string;
  clusterName: string;
  title: string;
  platform: 'youtube' | 'tiktok' | 'facebook';
  externalVideoId: string;
  views: number | null;
  likes: number | null;
  commentsCount: number | null;
  capturedAt: string;
  previousViews: number | null;
};

export type SocialHistoryPoint = {
  value: number;
  capturedAt: string;
};

/** Chuỗi lịch sử cho sparkline (daemon gắn cho metrics followers/views). */
export type SocialMetricHistory = {
  clusterId: string;
  platform: string;
  metric: string;
  points: SocialHistoryPoint[];
};

export type SocialStatsOverview = {
  channels: SocialChannelStat[];
  videos: SocialVideoStat[];
  history?: SocialMetricHistory[];
  lastRefreshAt: string | null;
  refreshError: string | null;
};

export type SocialCommentSummary = {
  id: number;
  jobId: string | null;
  clusterId: string;
  clusterName: string;
  platform: 'youtube' | 'tiktok' | 'facebook';
  externalVideoId: string;
  externalCommentId: string;
  author: string;
  text: string;
  commentCreatedAt: string | null;
  createdAt: string;
  replyStatus: 'pending' | 'sent' | 'liked' | 'skipped' | 'failed';
  replyText: string | null;
  repliedAt: string | null;
  skippedReason: string | null;
};

export type SocialCommentScanResult = {
  clustersScanned: number;
  videosScanned: number;
  newComments: number;
  repliesAttempted: number;
  repliesSent: number;
  errors: string[];
};

// ---------------------------------------------------------------------------
// AI tích hợp sẵn (router nội bộ của daemon, không cần key)
// ---------------------------------------------------------------------------

export type SocialAiCompose = {
  title: string;
  description: string;
  hashtags: string;
};

export type SocialAiReplyTestResult = {
  reply: string;
  fallbackUsed: boolean;
};

export type SocialSelectorsResult = {
  selectors: string;
};

export function createSocialService(client: RuntimeClient) {
  return {
    getOverview(): Promise<SocialOverview> {
      return client.get('/social/overview');
    },
    createCluster(input: SocialClusterInput): Promise<SocialOverview> {
      return client.post('/social/clusters', input);
    },
    updateCluster(id: string, input: SocialClusterInput): Promise<SocialOverview> {
      return client.patch(`/social/clusters/${encodeURIComponent(id)}`, input);
    },
    deleteCluster(id: string): Promise<SocialOverview> {
      return client.delete(`/social/clusters/${encodeURIComponent(id)}`);
    },
    checkClusterProxy(id: string): Promise<SocialOverview> {
      return client.post(`/social/clusters/${encodeURIComponent(id)}/check-proxy`);
    },
    openClusterBrowser(id: string): Promise<SocialOverview> {
      return client.post(`/social/clusters/${encodeURIComponent(id)}/open-browser`);
    },
    /** Mở trang đăng nhập của nền tảng trong trình duyệt persistent của cụm (người dùng tự đăng nhập). */
    openClusterLogin(id: string, platform: SocialPlatformName): Promise<{ ok: boolean }> {
      if (!SOCIAL_PLATFORM_NAMES.includes(platform)) {
        return Promise.reject(new Error(`Nền tảng không hỗ trợ đăng nhập: ${platform}`));
      }
      return client.post(`/social/clusters/${encodeURIComponent(id)}/login/${platform}`) as Promise<{ ok: boolean }>;
    },
    /** Xác minh phiên đăng nhập (đọc cookie profile cụm) + cập nhật loginStatus. */
    verifyClusterLogin(id: string, platform: SocialPlatformName): Promise<{ ok: boolean; status: 'ok' | 'unknown' | 'expired'; needsChannel?: boolean; accountName?: string; channelId?: string; channelUrl?: string }> {
      if (!SOCIAL_PLATFORM_NAMES.includes(platform)) {
        return Promise.reject(new Error(`Nền tảng không hỗ trợ đăng nhập: ${platform}`));
      }
      return client.post(`/social/clusters/${encodeURIComponent(id)}/login/${platform}/verify`) as Promise<{ ok: boolean; status: 'ok' | 'unknown' | 'expired'; needsChannel?: boolean; accountName?: string; channelId?: string; channelUrl?: string }>;
    },
    /** Tạo kênh YouTube (Brand Account) khi tài khoản đã đăng nhập nhưng chưa có kênh. */
    createYoutubeChannel(id: string, name: string): Promise<{ ok: boolean; channelId?: string; channelName?: string; error?: string }> {
      return client.post(`/social/clusters/${encodeURIComponent(id)}/youtube/create-channel`, { name });
    },
    /** Tạo tài khoản/kênh: TikTok đăng ký bằng Google, Facebook tạo Page. */
    createSocialAccount(id: string, platform: SocialPlatformName, name: string): Promise<{ ok: boolean; needsManual?: boolean; message?: string; accountName?: string; accountUrl?: string }> {
      return client.post(`/social/clusters/${encodeURIComponent(id)}/accounts/${platform}/signup`, { name });
    },
    closeClusterBrowser(id: string): Promise<SocialOverview> {
      return client.post(`/social/clusters/${encodeURIComponent(id)}/close-browser`);
    },
    /** Đăng nhập Facebook tự động trong trình duyệt cụm (mở form + tự lưu phiên). */
    loginFacebook(id: string, email: string, password: string): Promise<{ ok: boolean; needsManual?: boolean; message?: string; accountName?: string }> {
      return client.post(`/social/clusters/${encodeURIComponent(id)}/login/facebook`, { email, password });
    },
    /** Lưu email + mật khẩu Facebook của cụm (mật khẩu được mã hóa ở daemon). */
    saveFacebookCredentials(id: string, email: string, password: string): Promise<{ ok: boolean; email: string }> {
      return client.put(`/social/clusters/${encodeURIComponent(id)}/login/facebook/credentials`, { email, password });
    },
    enqueue(items: SocialEnqueueItem[]): Promise<SocialEnqueueResult> {
      return client.post('/social/jobs', { items });
    },
    /** Đổi giờ đăng một job chưa công khai (PATCH body { scheduledAt }). */
    rescheduleJob(id: string, scheduledAt: string): Promise<SocialOverview> {
      return client.patch(`/social/jobs/${encodeURIComponent(id)}`, { scheduledAt });
    },
    /** Danh sách video đã tải (media picker cho composer đa kênh). */
    listDownloads(limit = 500): Promise<SocialDownloadsResult> {
      return client.get(`/social/downloads?limit=${limit}`);
    },
    removeJob(id: string): Promise<SocialOverview> {
      return client.delete(`/social/jobs/${encodeURIComponent(id)}`);
    },
    retryFailedPlatforms(id: string): Promise<SocialOverview> {
      return client.post(`/social/jobs/${encodeURIComponent(id)}/retry-failed`);
    },
    pauseQueue(): Promise<{ queue: 'running' | 'paused' }> {
      return client.post('/social/queue/pause');
    },
    resumeQueue(): Promise<{ queue: 'running' | 'paused' }> {
      return client.post('/social/queue/resume');
    },
    /** GĐ3: thống kê view/sub. */
    getStats(): Promise<SocialStatsOverview> {
      return client.get('/social/stats');
    },
    refreshStats(): Promise<SocialStatsOverview> {
      return client.post('/social/stats/refresh');
    },
    /** GĐ3: bình luận + AI auto-reply. */
    listComments(clusterId?: string, limit?: number): Promise<SocialCommentSummary[]> {
      const query = new URLSearchParams();
      if (clusterId !== undefined) query.set('clusterId', clusterId);
      if (limit !== undefined) query.set('limit', String(limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return client.get(`/social/comments${suffix}`);
    },
    scanComments(clusterId?: string): Promise<SocialCommentScanResult> {
      return client.post('/social/comments/scan', clusterId === undefined ? {} : { clusterId });
    },
    /** AI tích hợp sẵn: soạn tiêu đề + mô tả + hashtag chuẩn SEO. */
    aiCompose(videoTitle: string): Promise<SocialAiCompose> {
      return client.post('/social/ai/compose', { videoTitle, language: 'vi' });
    },
    /** AI tích hợp sẵn: thử phản hồi bình luận (không đăng thật). */
    aiReplyTest(prompt: string, comment: string): Promise<SocialAiReplyTestResult> {
      return client.post('/social/ai/reply-test', { prompt, comment });
    },
    /** Đọc selectors.json đang dùng (Sửa Selector Nóng). */
    getSelectors(): Promise<SocialSelectorsResult> {
      return client.get('/social/selectors');
    },
    /** Lưu selectors.json mới (daemon tự backup .bak). */
    saveSelectors(selectors: string): Promise<SocialSelectorsResult> {
      return client.put('/social/selectors', { selectors });
    },
    /** Ảnh chụp màn hình lỗi của job (chỉ khi nền tảng đã chụp; không có → null). */
    async getErrorScreenshot(jobId: string, platform: 'yt' | 'tk' | 'fb'): Promise<{ url: string } | null> {
      const response = await client.rawRequest(
        `/social/jobs/${encodeURIComponent(jobId)}/error-screenshot?platform=${platform}`,
        { method: 'GET' }
      );
      if (!response.ok) return null;
      const blob = await response.blob();
      return { url: URL.createObjectURL(blob) };
    }
  };
}

export type SocialService = ReturnType<typeof createSocialService>;

function fileNameOfPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path.trim();
}
