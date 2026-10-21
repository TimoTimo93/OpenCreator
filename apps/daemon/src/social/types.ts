/**
 * Kiểu dữ liệu cho module Mạng Lưới Đăng Đa Kênh (Social Automation).
 *
 * - Cluster = 1 cụm kênh (1 bộ phim/nội dung): profile trình duyệt cách ly,
 *   proxy tĩnh, khung giờ đăng mặc định.
 * - Job = 1 video cần đăng lên các nền tảng của cụm; trạng thái lưu riêng
 *   từng nền tảng (atomic) nên retry chỉ chạy lại đúng platform lỗi.
 */

export type SocialPlatform = 'youtube' | 'tiktok' | 'facebook';

/**
 * Trang đăng nhập từng nền tảng — chỉ MỞ TRANG cho người dùng tự điền thông tin
 * đăng nhập trong trình duyệt persistent của cụm (không tự động điền mật khẩu).
 */
export const SOCIAL_PLATFORM_LOGIN_URLS: Record<SocialPlatform, string> = {
  youtube: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F',
  tiktok: 'https://www.tiktok.com/login',
  facebook: 'https://www.facebook.com/login'
};

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
  /** Tên kênh YouTube đã liên kết (đọc từ Studio sau khi đăng nhập tay). */
  ytAccountName: string;
  /** ID kênh YouTube đã liên kết (UC...). */
  ytAccountId: string;
  /** Đã đăng nhập nhưng tài khoản chưa có kênh YouTube (cần tạo kênh). */
  needsChannel: boolean;
  /** GĐ3: URL profile TikTok (dùng để quét thống kê). */
  tkProfileUrl: string;
  /** Tên tài khoản TikTok đã liên kết (đọc từ trang profile sau khi đăng nhập). */
  tkAccountName: string;
  /** Tên tài khoản/Page Facebook đã liên kết. */
  fbAccountName: string;
  /** GĐ3: bật tự động trả lời bình luận bằng AI. */
  autoReplyEnabled: boolean;
  /** GĐ3: chỉ dẫn riêng cho AI khi soạn câu trả lời. */
  autoReplyPrompt: string;
  /** GĐ4: bật tự nạp đăng sau khi dịch xong (pipeline hook của daemon). */
  autoPublishAfterTranslate: boolean;
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
  /** Cấu hình riêng từng nền tảng cho lần đăng này (Postiz-style). */
  platformSettings: SocialPlatformSettings;
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

export type SocialHistoryPoint = {
  value: number;
  capturedAt: string;
};

/** Một chuỗi lịch sử (sparkline): N điểm gần nhất tăng dần theo capturedAt. */
export type SocialMetricHistory = {
  clusterId: string;
  platform: SocialPlatform;
  /** Hiện chỉ gắn 2 metric chính: 'followers' | 'views'. */
  metric: string;
  points: SocialHistoryPoint[];
};

export type SocialStatsOverview = {
  channels: SocialChannelStat[];
  videos: SocialVideoStat[];
  /** Lịch sử đo cho sparkline (tùy chọn — server cũ không trả). */
  history?: SocialMetricHistory[];
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
  /** Cấu hình riêng từng nền tảng (privacy/tags/toggles...). */
  platformSettings?: SocialPlatformSettings;
};

// -------------------------------------------------------------------------
// Settings riêng từng nền tảng (mô hình Postiz: 1 job — nhiều cấu hình).
// -------------------------------------------------------------------------

export type SocialYouTubeSettings = {
  /** Quyền xem video trên YouTube Studio. */
  privacy?: 'public' | 'unlisted' | 'private';
  /** Thẻ (tags) — tổng độ dài sau khi nối ≤ SOCIAL_YT_TAGS_MAX_LENGTH. */
  tags?: string[];
  /** Bật "Dành cho trẻ em" (mặc định luồng cũ là "Không dành cho trẻ em"). */
  madeForKids?: boolean;
};

export type SocialTikTokSettings = {
  /** Ai có thể xem: mọi người / bạn bè / riêng tư. */
  privacy?: 'public' | 'friends' | 'private';
  allowDuet?: boolean;
  allowStitch?: boolean;
  allowComments?: boolean;
  /** "Đăng trực tiếp" (direct post) nếu form hỗ trợ. */
  directPost?: boolean;
};

export type SocialFacebookSettings = {
  /** Loại bài đăng (chỉ áp dụng chế độ browser; graph_api hiện chỉ đăng video thường). */
  postType?: 'post' | 'reel' | 'story';
};

export type SocialPlatformSettings = {
  youtube?: SocialYouTubeSettings;
  tiktok?: SocialTikTokSettings;
  facebook?: SocialFacebookSettings;
};

/** Tổng độ dài tối đa của toàn bộ tags YouTube (giới hạn của Studio ~500 ký tự). */
export const SOCIAL_YT_TAGS_MAX_LENGTH = 500;

const YT_PRIVACY = new Set(['public', 'unlisted', 'private']);
const TK_PRIVACY = new Set(['public', 'friends', 'private']);
const FB_POST_TYPE = new Set(['post', 'reel', 'story']);

/**
 * Làm sạch settings từng nền tảng từ đầu vào không tin cậy: chỉ giữ khóa/enum
 * đúng kiểu, cắt tags vượt giới hạn tổng độ dài. Không bao giờ ném lỗi —
 * đầu vào rác trở thành `{}`.
 */
export function sanitizePlatformSettings(value: unknown): SocialPlatformSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const result: SocialPlatformSettings = {};

  const youtube = sanitizeYoutubeSettings(raw['youtube']);
  if (youtube !== undefined) result.youtube = youtube;
  const tiktok = sanitizeTikTokSettings(raw['tiktok']);
  if (tiktok !== undefined) result.tiktok = tiktok;
  const facebook = sanitizeFacebookSettings(raw['facebook']);
  if (facebook !== undefined) result.facebook = facebook;
  return result;
}

function sanitizeYoutubeSettings(value: unknown): SocialYouTubeSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: SocialYouTubeSettings = {};
  if (typeof raw['privacy'] === 'string' && YT_PRIVACY.has(raw['privacy'])) {
    result.privacy = raw['privacy'] as SocialYouTubeSettings['privacy'];
  }
  if (Array.isArray(raw['tags'])) {
    const tags: string[] = [];
    let total = 0;
    for (const item of raw['tags']) {
      if (typeof item !== 'string') continue;
      const tag = item.trim();
      if (tag === '') continue;
      if (total + tag.length > SOCIAL_YT_TAGS_MAX_LENGTH) break;
      tags.push(tag);
      total += tag.length;
    }
    if (tags.length > 0) result.tags = tags;
  }
  if (typeof raw['madeForKids'] === 'boolean') result.madeForKids = raw['madeForKids'];
  return Object.keys(result).length === 0 ? undefined : result;
}

function sanitizeTikTokSettings(value: unknown): SocialTikTokSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: SocialTikTokSettings = {};
  if (typeof raw['privacy'] === 'string' && TK_PRIVACY.has(raw['privacy'])) {
    result.privacy = raw['privacy'] as SocialTikTokSettings['privacy'];
  }
  for (const key of ['allowDuet', 'allowStitch', 'allowComments', 'directPost'] as const) {
    if (typeof raw[key] === 'boolean') result[key] = raw[key];
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function sanitizeFacebookSettings(value: unknown): SocialFacebookSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw['postType'] === 'string' && FB_POST_TYPE.has(raw['postType'])) {
    return { postType: raw['postType'] as SocialFacebookSettings['postType'] };
  }
  return undefined;
}

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
