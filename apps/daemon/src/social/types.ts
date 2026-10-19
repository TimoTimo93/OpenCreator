/**
 * Kiểu dữ liệu cho module Mạng Lưới Đăng Đa Kênh (Social Automation).
 *
 * - Cluster = 1 cụm kênh (1 bộ phim/nội dung): profile trình duyệt cách ly,
 *   proxy tĩnh, khung giờ đăng mặc định.
 * - Job = 1 video cần đăng lên các nền tảng của cụm; trạng thái lưu riêng
 *   từng nền tảng (atomic) nên retry chỉ chạy lại đúng platform lỗi.
 */

export type SocialPlatform = 'youtube' | 'tiktok' | 'facebook';

export type SocialPlatformStatus =
  | 'pending'
  | 'running'
  | 'published'
  | 'scheduled'
  | 'failed'
  | 'skipped';

export type SocialPlatformState = {
  status: SocialPlatformStatus;
  attempts: number;
  /** Mã video/đăng sau khi đăng xong (để tra cứu sau). */
  videoId: string | null;
  error: string | null;
  /** Đường dẫn ảnh chụp màn hình lỗi (nếu có). */
  screenshotPath: string | null;
  lastAttemptAt: string | null;
};

export type SocialFacebookMode = 'graph_api' | 'browser';

export type SocialClusterLoginStatus = 'unknown' | 'ok' | 'expired';

export type SocialCluster = {
  id: string;
  name: string;
  seriesName: string;
  proxyServer: string;
  proxyStatus: 'unchecked' | 'online' | 'dead' | 'no_proxy';
  proxyDetail: string | null;
  loginStatus: Record<'youtube' | 'tiktok' | 'facebook', SocialClusterLoginStatus>;
  fbMode: SocialFacebookMode;
  fbPageId: string;
  /** Token được mã hóa trước khi lưu; không bao giờ trả về raw qua API. */
  fbPageTokenEncrypted: string | null;
  /** Khung giờ vàng trong ngày, HH:mm (múi giờ máy). */
  defaultScheduleTimes: string[];
  defaultDescription: string;
  /** GĐ3: URL kênh YouTube (dùng để quét thống kê). */
  ytChannelUrl: string;
  /** GĐ3: URL profile TikTok (dùng để quét thống kê). */
  tkProfileUrl: string;
  /** GĐ3: bật tự động trả lời bình luận bằng AI. */
  autoReplyEnabled: boolean;
  /** GĐ3: chỉ dẫn riêng cho AI khi soạn câu trả lời. */
  autoReplyPrompt: string;
  createdAt: string;
  updatedAt: string;
};

/** Cluster trả về client (đã bỏ token nhị phân). */
export type SocialClusterView = Omit<SocialCluster, 'fbPageTokenEncrypted'> & {
  fbPageTokenConfigured: boolean;
};

export type SocialJob = {
  id: string;
  clusterId: string;
  clusterName: string;
  videoPath: string;
  thumbnailPath: string | null;
  title: string;
  description: string;
  /** Thời điểm công khai (ISO UTC). */
  scheduledAt: string;
  platforms: Record<SocialPlatform, SocialPlatformState>;
  createdAt: string;
  updatedAt: string;
};

export type SocialQueueState = 'idle' | 'running' | 'paused';

export type SocialOverviewCounts = {
  pending: number;
  running: number;
  scheduled: number;
  published: number;
  failed: number;
};

export type SocialOverview = {
  queue: SocialQueueState;
  counts: SocialOverviewCounts;
  clusters: SocialClusterView[];
  jobs: SocialJob[];
  screenshotDir: string;
  browserOpenClusters: string[];
};

// -------------------------------------------------------------------------
// GĐ3 — Thống kê (view/sub) + bình luận
// -------------------------------------------------------------------------

export type SocialMetricName = 'followers' | 'views' | 'likes' | 'videos';

export type SocialMetricPoint = {
  value: number;
  capturedAt: string;
  /** Giá trị của lần đo trước đó (so sánh chênh lệch). */
  previous: number | null;
};

export type SocialChannelStat = {
  clusterId: string;
  clusterName: string;
  platform: SocialPlatform;
  metrics: Partial<Record<SocialMetricName, SocialMetricPoint>>;
};

export type SocialVideoStat = {
  jobId: string;
  clusterId: string;
  clusterName: string;
  title: string;
  platform: SocialPlatform;
  externalVideoId: string;
  views: number | null;
  likes: number | null;
  commentsCount: number | null;
  capturedAt: string;
  previousViews: number | null;
};

export type SocialStatsOverview = {
  channels: SocialChannelStat[];
  videos: SocialVideoStat[];
  lastRefreshAt: string | null;
  refreshError: string | null;
};

export type SocialStatsRefreshResult = {
  clustersScanned: number;
  channelSnapshots: number;
  videoSnapshots: number;
  errors: string[];
};

export type SocialCommentReplyStatus = 'pending' | 'sent' | 'liked' | 'skipped' | 'failed';

export type SocialComment = {
  id: number;
  jobId: string | null;
  clusterId: string;
  clusterName: string;
  platform: SocialPlatform;
  externalVideoId: string;
  externalCommentId: string;
  author: string;
  text: string;
  commentCreatedAt: string | null;
  createdAt: string;
  replyStatus: SocialCommentReplyStatus;
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

export type SocialEnqueueRequest = {
  clusterId: string;
  path: string;
  title?: string;
  description?: string;
  thumbnailPath?: string | null;
  /** Bỏ trống → tự xếp khung giờ trống tiếp theo của cụm. */
  scheduledAt?: string | null;
};

export const MAX_SOCIAL_ATTEMPTS = 3;

export function emptyPlatformState(): SocialPlatformState {
  return {
    status: 'pending',
    attempts: 0,
    videoId: null,
    error: null,
    screenshotPath: null,
    lastAttemptAt: null
  };
}

export function emptyPlatforms(): Record<SocialPlatform, SocialPlatformState> {
  return {
    youtube: emptyPlatformState(),
    tiktok: emptyPlatformState(),
    facebook: emptyPlatformState()
  };
}

export function publishedPlatforms(platforms: Record<SocialPlatform, SocialPlatformState>): SocialPlatform[] {
  return (Object.keys(platforms) as SocialPlatform[])
    .filter(platform => platforms[platform]!.status === 'published' || platforms[platform]!.status === 'scheduled');
}
