/**
 * Service Mạng Lưới Đăng Đa Kênh: hợp nhất db + Auto-Slot + kiểm tra proxy +
 * worker upload. API bám kiểu TranslationPipelineService cho routes/tools dùng.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeSocialDatabase,
  createClusterRow,
  deleteClusterRow,
  deleteJobRow,
  findActiveDuplicateJob,
  getClusterRow,
  getJobRow,
  insertJobRow,
  kvGet,
  kvSet,
  listClusterRows,
  listJobRows,
  mapCluster,
  mapJob,
  openSocialDatabase,
  recoverRunningJobs,
  updateClusterRow,
  updateJobRow,
  type SocialDB,
  type SocialJobRow
} from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { nextAvailableSlot } from './scheduler.js';
import { checkProxy } from './proxy-check.js';
import { createSocialAnalytics } from './analytics.js';
import { createSocialComments, type SocialLlmConfig } from './comments.js';
import { listDownloadedVideos, type SocialDownloadItem } from './downloads.js';
import type { SocialWorker } from './worker.js';
import {
  sanitizePlatformSettings,
  type SocialCluster,
  type SocialClusterView,
  type SocialComment,
  type SocialCommentScanResult,
  type SocialEnqueueRequest,
  type SocialJob,
  type SocialOverview,
  type SocialPlatform,
  type SocialPlatformState,
  type SocialQueueState,
  type SocialStatsOverview
} from './types.js';

export type SocialServiceInput = {
  dataDir: string;
  worker: SocialWorker;
  /** Đè khi kiểm thử (mặc định đo proxy thật). */
  checkProxyFn?: typeof checkProxy;
  /** GĐ3: cấu hình LLM để tự trả lời bình luận (không có → mẫu mặc định). */
  readLlmConfig?: () => Promise<SocialLlmConfig | null>;
  /**
   * Nguồn thư mục gốc chứa video đã tải về (media picker): trả về downloadRoot
   * người dùng cấu hình hoặc mặc định. Không cấu hình → danh sách downloads rỗng.
   */
  readDownloadsRoot?: () => Promise<string | undefined>;
  /** GĐ3: khoảng quét thống kê/bình luận; 0/âm → chỉ chạy khi gọi thủ công. */
  analyticsRefreshIntervalMs?: number;
  commentsScanIntervalMs?: number;
  now?: () => string;
};

export type SocialClusterPatch = {
  name?: string;
  seriesName?: string;
  proxyServer?: string;
  fbMode?: 'graph_api' | 'browser';
  fbPageId?: string;
  fbPageToken?: string | null;
  defaultScheduleTimes?: string[];
  defaultDescription?: string;
  ytChannelUrl?: string;
  tkProfileUrl?: string;
  autoReplyEnabled?: boolean;
  autoReplyPrompt?: string;
};

export type SocialService = {
  getOverview(): SocialOverview;
  createCluster(patch: SocialClusterPatch & { name: string }): SocialOverview;
  updateCluster(clusterId: string, patch: SocialClusterPatch): SocialOverview;
  deleteCluster(clusterId: string): SocialOverview;
  checkClusterProxy(clusterId: string): Promise<SocialOverview>;
  openClusterBrowser(clusterId: string): Promise<SocialOverview>;
  closeClusterBrowser(clusterId: string): Promise<SocialOverview>;
  /** Nạp video vào hàng đợi; trả summary + số nạp + danh sách path bị bỏ qua. */
  enqueue(requests: readonly SocialEnqueueRequest[]): { summary: SocialOverview; accepted: number; duplicates: string[] };
  pause(): SocialOverview;
  resume(): SocialOverview;
  removeJob(jobId: string): SocialOverview;
  /** Đổi giờ công khai của job chưa đăng xong; xong luôn đánh thức worker xếp lại slot. */
  rescheduleJob(jobId: string, scheduledAt: string): SocialOverview;
  /** Video đã tải về trong thư mục gốc downloads (media picker; chỉ đọc). */
  listDownloads(limit?: number): Promise<{ items: SocialDownloadItem[] }>;
  retryFailedPlatforms(jobId: string): SocialOverview;
  /** GĐ3: thống kê view/sub đã lưu + quét ngay khi cần. */
  getStats(): SocialStatsOverview;
  refreshStats(): Promise<SocialStatsOverview>;
  /** GĐ3: bình luận gần đây + quét/AI trả lời theo yêu cầu. */
  listComments(clusterId?: string, limit?: number): SocialComment[];
  scanComments(clusterId?: string): Promise<SocialCommentScanResult>;
  close(): Promise<void>;
};

export class SocialError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SocialError';
  }
}

export function createSocialService(input: SocialServiceInput): SocialService {
  const now = input.now ?? ((): string => new Date().toISOString());
  const db: SocialDB = openSocialDatabase(join(input.dataDir, 'social.sqlite'));
  const screenshotDir = join(input.dataDir, 'social', 'screenshots');
  const profileRoot = join(input.dataDir, 'social', 'profiles');
  const secretKeyPath = join(input.dataDir, 'social', 'secret.key');
  mkdirSync(screenshotDir, { recursive: true });
  const worker = input.worker;

  // Daemon vừa khởi động lại: platform "running" → "pending".
  recoverRunningJobs(db);
  const decryptToken = (token: string | null): string => decryptSecret(token, secretKeyPath);
  worker.bind({ db, screenshotDir, profileRoot, decryptToken });

  // GĐ3: quét thống kê + bình luận định kỳ.
  const analytics = createSocialAnalytics({
    db,
    worker,
    decryptToken,
    refreshIntervalMs: input.analyticsRefreshIntervalMs ?? 6 * 60 * 60_000,
    log: message => { console.log(`[social] ${message}`); }
  });
  const comments = createSocialComments({
    db,
    worker,
    decryptToken,
    readLlmConfig: input.readLlmConfig ?? (async (): Promise<SocialLlmConfig | null> => null),
    scanIntervalMs: input.commentsScanIntervalMs ?? 3 * 60 * 60_000,
    log: message => { console.log(`[social] ${message}`); }
  });

  function snapshotQueueState(): SocialQueueState {
    return kvGet(db, 'queue_state') === 'paused' ? 'paused' : 'running';
  }

  function clusterView(cluster: SocialCluster): SocialClusterView {
    const fbPageTokenEncrypted = cluster.fbPageTokenEncrypted;
    return {
      id: cluster.id,
      name: cluster.name,
      seriesName: cluster.seriesName,
      proxyServer: cluster.proxyServer,
      proxyStatus: cluster.proxyStatus,
      proxyDetail: cluster.proxyDetail,
      loginStatus: cluster.loginStatus,
      fbMode: cluster.fbMode,
      fbPageId: cluster.fbPageId,
      defaultScheduleTimes: cluster.defaultScheduleTimes,
      defaultDescription: cluster.defaultDescription,
      ytChannelUrl: cluster.ytChannelUrl,
      tkProfileUrl: cluster.tkProfileUrl,
      autoReplyEnabled: cluster.autoReplyEnabled,
      autoReplyPrompt: cluster.autoReplyPrompt,
      fbPageTokenConfigured: fbPageTokenEncrypted !== null && fbPageTokenEncrypted !== '',
      createdAt: cluster.createdAt,
      updatedAt: cluster.updatedAt
    };
  }

  function overview(): SocialOverview {
    const jobs = listJobRows(db).map(row => mapJob(row));
    return {
      queue: snapshotQueueState(),
      counts: summarizeCounts(jobs, now()),
      clusters: listClusterRows(db).map(row => clusterView(mapCluster(row))),
      jobs,
      screenshotDir,
      browserOpenClusters: worker.openClusterIds()
    };
  }

  return {
    getOverview(): SocialOverview {
      return overview();
    },

    createCluster(patch: SocialClusterPatch & { name: string }): SocialOverview {
      createClusterRow(db, {
        id: `cluster_${randomUUID().slice(0, 8)}`,
        name: patch.name.trim() || 'Cụm kênh mới',
        seriesName: patch.seriesName?.trim() ?? '',
        proxyServer: patch.proxyServer?.trim() ?? '',
        fbMode: patch.fbMode ?? 'graph_api',
        fbPageId: patch.fbPageId?.trim() ?? '',
        fbPageTokenEncrypted: patch.fbPageToken !== undefined && patch.fbPageToken !== null && patch.fbPageToken.trim() !== ''
          ? encryptSecret(patch.fbPageToken.trim(), secretKeyPath)
          : null,
        defaultScheduleTimes: patch.defaultScheduleTimes !== undefined
          ? patch.defaultScheduleTimes.filter(time => /^\d{1,2}:\d{2}$/.test(time))
          : ['19:30'],
        defaultDescription: patch.defaultDescription ?? '',
        ytChannelUrl: patch.ytChannelUrl?.trim() ?? '',
        tkProfileUrl: patch.tkProfileUrl?.trim() ?? '',
        autoReplyEnabled: patch.autoReplyEnabled ?? false,
        autoReplyPrompt: patch.autoReplyPrompt ?? '',
        nowISO: now()
      });
      return overview();
    },

    updateCluster(clusterId: string, patch: SocialClusterPatch): SocialOverview {
      const update: Record<string, unknown> = { updated_at: now() };
      if (patch.name !== undefined) update.name = patch.name.trim();
      if (patch.seriesName !== undefined) update.series_name = patch.seriesName.trim();
      if (patch.proxyServer !== undefined) {
        update.proxy_server = patch.proxyServer.trim();
        // Đổi proxy → cần kiểm tra lại trạng thái.
        update.proxy_status = patch.proxyServer.trim() === '' ? 'no_proxy' : 'unchecked';
        update.proxy_detail = null;
      }
      if (patch.fbMode !== undefined) update.fb_mode = patch.fbMode;
      if (patch.fbPageId !== undefined) update.fb_page_id = patch.fbPageId.trim();
      if (patch.fbPageToken !== undefined) {
        update.fb_page_token_encrypted = patch.fbPageToken === null || patch.fbPageToken.trim() === ''
          ? null
          : encryptSecret(patch.fbPageToken.trim(), secretKeyPath);
      }
      if (patch.defaultScheduleTimes !== undefined) {
        update.default_schedule_times = JSON.stringify(
          patch.defaultScheduleTimes.filter(time => /^\d{1,2}:\d{2}$/.test(time))
        );
      }
      if (patch.defaultDescription !== undefined) update.default_description = patch.defaultDescription;
      if (patch.ytChannelUrl !== undefined) update.yt_channel_url = patch.ytChannelUrl.trim();
      if (patch.tkProfileUrl !== undefined) update.tk_profile_url = patch.tkProfileUrl.trim();
      if (patch.autoReplyEnabled !== undefined) update.auto_reply_enabled = patch.autoReplyEnabled ? 1 : 0;
      if (patch.autoReplyPrompt !== undefined) update.auto_reply_prompt = patch.autoReplyPrompt;
      const updated = updateClusterRow(db, clusterId, update);
      if (updated === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      return overview();
    },

    deleteCluster(clusterId: string): SocialOverview {
      if (getClusterRow(db, clusterId) === undefined) {
        throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      }
      deleteClusterRow(db, clusterId);
      void worker.closeClusterBrowser(clusterId);
      return overview();
    },

    async checkClusterProxy(clusterId: string): Promise<SocialOverview> {
      const row = getClusterRow(db, clusterId);
      if (row === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      const result = await (input.checkProxyFn ?? checkProxy)(row.proxy_server);
      updateClusterRow(db, clusterId, {
        proxy_status: result.status,
        proxy_detail: result.detail,
        updated_at: now()
      });
      return overview();
    },

    async openClusterBrowser(clusterId: string): Promise<SocialOverview> {
      const row = getClusterRow(db, clusterId);
      if (row === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      await worker.openClusterBrowser(clusterId, row.proxy_server);
      return overview();
    },

    async closeClusterBrowser(clusterId: string): Promise<SocialOverview> {
      const row = getClusterRow(db, clusterId);
      if (row === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      await worker.closeClusterBrowser(clusterId);
      return overview();
    },

    enqueue(requests: readonly SocialEnqueueRequest[]): { summary: SocialOverview; accepted: number; duplicates: string[] } {
      const duplicates: string[] = [];
      let accepted = 0;
      // Bản đồ "muộn nhất đang hẹn" theo cụm — để Auto-Slot không xếp trùng.
      const lastScheduledByCluster = new Map<string, string | null>();
      for (const row of listJobRows(db)) {
        const current = lastScheduledByCluster.get(row.cluster_id) ?? null;
        const time = new Date(row.scheduled_at).getTime();
        if (!Number.isNaN(time) && (current === null || time > new Date(current).getTime())) {
          lastScheduledByCluster.set(row.cluster_id, row.scheduled_at);
        }
      }
      for (const request of requests) {
        const cluster = getClusterRow(db, request.clusterId);
        if (cluster === undefined) {
          duplicates.push(request.path.trim());
          continue;
        }
        const videoPath = request.path.trim();
        if (videoPath === '') continue;
        if (findActiveDuplicateJob(db, request.clusterId, videoPath) !== undefined) {
          duplicates.push(videoPath);
          continue;
        }
        const clusterModel = mapCluster(cluster);
        let scheduledAt: string;
        const requested = request.scheduledAt?.trim() ?? '';
        if (requested !== '' && normalizeISO(requested) !== null) {
          scheduledAt = requested;
          // Job hẹn quá khứ/ís ít hơn 10 phút → coi như đăng ngay tại thời điểm đã chỉ.
        } else {
          const lastScheduled = lastScheduledByCluster.get(request.clusterId) ?? null;
          scheduledAt = nextAvailableSlot({
            nowISO: now(),
            scheduleTimes: clusterModel.defaultScheduleTimes,
            lastScheduledISO: lastScheduled
          });
          // Tận dụng Auto-Slot: cập nhật bản đồ để mục sau không đội đầu.
          lastScheduledByCluster.set(request.clusterId, scheduledAt);
        }
        insertJobRow(db, {
          id: `socialjob_${randomUUID().slice(0, 12)}`,
          clusterId: request.clusterId,
          clusterName: clusterModel.name,
          videoPath,
          thumbnailPath: request.thumbnailPath ?? null,
          title: request.title !== undefined && request.title.trim() !== '' ? request.title.trim() : fileName(videoPath),
          description: request.description !== undefined && request.description.trim() !== ''
            ? request.description.trim()
            : clusterModel.defaultDescription,
          scheduledAt,
          platformSettings: sanitizePlatformSettings(request.platformSettings ?? {}),
          nowISO: now()
        });
        accepted += 1;
      }
      if (accepted > 0) worker.kick();
      return { summary: overview(), accepted, duplicates };
    },

    pause(): SocialOverview {
      kvSet(db, 'queue_state', 'paused');
      return overview();
    },

    resume(): SocialOverview {
      kvSet(db, 'queue_state', 'running');
      worker.kick();
      return overview();
    },

    removeJob(jobId: string): SocialOverview {
      const row = getJobRow(db, jobId);
      if (row === undefined) throw new SocialError('social_job_not_found', 'Không tìm thấy job trong hàng đợi');
      if (row.yt_status !== 'running' && row.tk_status !== 'running' && row.fb_status !== 'running') {
        deleteJobRow(db, jobId);
      }
      return overview();
    },

    rescheduleJob(jobId: string, scheduledAt: string): SocialOverview {
      const row = getJobRow(db, jobId);
      if (row === undefined) throw new SocialError('social_job_not_found', 'Không tìm thấy job trong hàng đợi');
      const normalized = normalizeISO(scheduledAt.trim());
      if (normalized === null) {
        throw new SocialError('social_job_schedule_invalid', 'Giờ hẹn phải là chuỗi ISO hợp lệ (UTC)');
      }
      // Job đã đăng/xuất bản (bất kỳ nền tảng nào) thì không được đổi lịch nữa —
      // tránh lệch trạng thái giữa hàng đợi và nền tảng đã nhận video.
      for (const prefix of ['yt', 'tk', 'fb'] as const) {
        const status = row[`${prefix}_status`];
        if (status === 'published' || status === 'scheduled') {
          throw new SocialError(
            'social_job_not_reschedulable',
            'Job đã được đăng hoặc đã hẹn giờ trên nền tảng — không thể đổi lịch'
          );
        }
      }
      updateJobRow(db, jobId, { scheduled_at: normalized, updated_at: now() });
      // Scheduler đọc lại scheduled_at mỗi lượt pump — kick để job dời lên sớm chạy ngay.
      worker.kick();
      return overview();
    },

    async listDownloads(limit?: number): Promise<{ items: SocialDownloadItem[] }> {
      const readRoot = input.readDownloadsRoot;
      if (readRoot === undefined) return { items: [] };
      const root = await readRoot();
      if (root === undefined || root.trim() === '') return { items: [] };
      return { items: await listDownloadedVideos({ root, limit }) };
    },

    retryFailedPlatforms(jobId: string): SocialOverview {
      const row = getJobRow(db, jobId);
      if (row === undefined) throw new SocialError('social_job_not_found', 'Không tìm thấy job trong hàng đợi');
      const patch: Record<string, unknown> = { updated_at: now() };
      const prefixByPlatform: Record<SocialPlatform, string> = { youtube: 'yt', tiktok: 'tk', facebook: 'fb' };
      for (const [platform, prefix] of Object.entries(prefixByPlatform) as Array<[SocialPlatform, string]>) {
        const statusKey = `${prefix}_status`;
        const attemptsKey = `${prefix}_attempts`;
        const errorKey = `${prefix}_error`;
        const attempts = row[attemptsKey as keyof SocialJobRow] as number;
        if (row[statusKey as keyof SocialJobRow] === 'failed' && attempts < 3) {
          patch[statusKey] = 'pending';
          patch[errorKey] = null;
        }
      }
      updateJobRow(db, jobId, patch);
      worker.kick();
      return overview();
    },

    getStats(): SocialStatsOverview {
      return analytics.getStats();
    },

    async refreshStats(): Promise<SocialStatsOverview> {
      await analytics.refresh();
      return analytics.getStats();
    },

    listComments(clusterId?: string, limit?: number): SocialComment[] {
      return comments.list(clusterId, limit);
    },

    async scanComments(clusterId?: string): Promise<SocialCommentScanResult> {
      return comments.scan(clusterId);
    },

    async close(): Promise<void> {
      analytics.close();
      comments.close();
      await worker.close();
      closeSocialDatabase(db);
    }
  };
}

function normalizeISO(value: string): string | null {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function fileName(path: string): string {
  const slash = path.replace(/\\/g, '/').lastIndexOf('/');
  return path.replace(/\\/g, '/').slice(slash + 1);
}

/** Đếm theo trạng thái từng nền tảng: số nền tảng trong từng trạng thái. */
function summarizeCounts(jobs: SocialJob[], nowISO: string): SocialOverview['counts'] {
  const nowTime = new Date(nowISO).getTime();
  const counts = { pending: 0, running: 0, scheduled: 0, published: 0, failed: 0 };
  for (const job of jobs) {
    for (const platform of Object.keys(job.platforms) as SocialPlatform[]) {
      const state: SocialPlatformState = job.platforms[platform]!;
      switch (state.status) {
        case 'running': counts.running += 1; break;
        case 'published': counts.published += 1; break;
        case 'scheduled': counts.published += 1; break;
        case 'failed': counts.failed += 1; break;
        case 'skipped': break;
        case 'pending': {
          const due = new Date(job.scheduledAt).getTime() <= nowTime;
          counts[due ? 'pending' : 'scheduled'] += 1;
          break;
        }
      }
    }
  }
  return counts;
}
