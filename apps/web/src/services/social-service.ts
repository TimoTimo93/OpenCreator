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
  autoReplyEnabled: boolean;
  autoReplyPrompt: string;
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
  createdAt: string;
  updatedAt: string;
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
};

export type SocialEnqueueItem = {
  clusterId: string;
  path: string;
  title?: string;
  description?: string;
  thumbnailPath?: string | null;
  scheduledAt?: string;
};

export type SocialProxyCheckResult = {
  status: 'online' | 'dead' | 'no_proxy';
  detail: string | null;
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

export type SocialStatsOverview = {
  channels: SocialChannelStat[];
  videos: SocialVideoStat[];
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
    closeClusterBrowser(id: string): Promise<SocialOverview> {
      return client.post(`/social/clusters/${encodeURIComponent(id)}/close-browser`);
    },
    enqueue(items: SocialEnqueueItem[]): Promise<SocialEnqueueResult> {
      return client.post('/social/jobs', { items });
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
    }
  };
}

export type SocialService = ReturnType<typeof createSocialService>;
