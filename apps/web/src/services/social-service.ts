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
    }
  };
}

export type SocialService = ReturnType<typeof createSocialService>;
