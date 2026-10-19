/**
 * Worker Mạng Lưới Đăng Đa Kênh: vòng lặp tuần tự.
 *
 * - Chọn job đã đến giờ hẹn (scheduled_at <= now) có nền tảng cần đăng;
 *   chạy youtube → tiktok → facebook lần lượt trong một lượt.
 * - Trạng thái *từng nền tảng* atomic: thành công → `published`/`scheduled`;
 *   thất bại → `failed` + attempts + lỗi/ảnh chụp — lượt sau chỉ chạy lại
 *   nền tảng chưa xong, không đăng trùng platform đã thành công.
 * - Trình duyệt bọc trong `browserLauncher` — kiểm thử thay executor bằng
 *   hàm giả, launcher bằng stub; wiring thật (Patchright) gắn ở server.ts.
 */
import {
  getClusterRow,
  getJobRow,
  kvGet,
  listJobRows,
  mapCluster,
  mapJob,
  updateClusterRow,
  updateJobRow,
  type SocialDB,
  type SocialJobRow
} from './db.js';
import {
  MAX_SOCIAL_ATTEMPTS,
  type SocialCluster,
  type SocialJob,
  type SocialPlatform,
  type SocialPlatformStatus
} from './types.js';

export type SocialWorkerDeps = {
  db: SocialDB;
  screenshotDir: string;
  profileRoot: string;
  decryptToken(token: string | null): string;
};

export type SocialExecutionContext = {
  cluster: SocialCluster;
  job: SocialJob;
  /** Token Facebook đã giải mã (rỗng nếu chưa config). */
  fbToken: string;
  screenshotDir: string;
  /** Phiên trình duyệt của cụm (undefined nếu chưa mở / chỉ dùng Graph API). */
  browser?: SocialBrowserHandle;
  now(): string;
};

export type SocialExecutionResult = {
  status: Exclude<SocialPlatformStatus, 'pending' | 'running'>;
  videoId?: string;
  error?: string;
  screenshotPath?: string;
  loginStatus?: 'ok' | 'expired';
};

export type SocialExecutor = (context: SocialExecutionContext) => Promise<SocialExecutionResult>;

export type PlatformExecutors = Partial<Record<SocialPlatform, SocialExecutor>>;

export type SocialBrowserHandle = {
  /** Mở tab mới (và điều hướng nếu có url) cho automation — trả Page của Patchright. */
  newPage(url?: string): Promise<unknown>;
  close(): Promise<void>;
};

export type SocialBrowserLauncher = (
  clusterId: string,
  proxyServer: string,
  profileDir: string
) => Promise<SocialBrowserHandle>;

export type CreateSocialWorkerInput = {
  executors?: PlatformExecutors;
  browserLauncher?: SocialBrowserLauncher;
  /** 0/âm → không tick định kỳ, chỉ chạy theo kick(). */
  tickIntervalMs?: number;
  /** Giữ trình duyệt mở sau khi xong job (dùng khi thủ công mở browser). */
  keepBrowserOpenAfterJob?: boolean;
  maxAttempts?: number;
  log?: (message: string) => void;
};

export type SocialWorker = {
  bind(dependencies: SocialWorkerDeps): void;
  /** Đánh thức vòng lặp (enqueue xong gọi). */
  kick(): void;
  openClusterBrowser(clusterId: string, proxyServer: string): Promise<void>;
  closeClusterBrowser(clusterId: string): Promise<void>;
  openClusterIds(): string[];
  close(): Promise<void>;
};

const PLATFORM_PREFIXES: Array<readonly [SocialPlatform, string]> = [
  ['youtube', 'yt'],
  ['tiktok', 'tk'],
  ['facebook', 'fb']
];

export function createSocialWorker(input: CreateSocialWorkerInput = {}): SocialWorker {
  const log = input.log ?? ((message: string): void => { console.log(`[social] ${message}`); });
  const executors: PlatformExecutors = input.executors ?? {};
  const maxAttempts = input.maxAttempts ?? MAX_SOCIAL_ATTEMPTS;

  let deps: SocialWorkerDeps | undefined;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const browsers = new Map<string, SocialBrowserHandle>();
  const busyClusters = new Set<string>();
  /** Cụm được người dùng mở trình duyệt thủ công (đăng nhập tay) — không tự đóng. */
  const manualOpen = new Set<string>();

  const worker: SocialWorker = {
    bind(dependencies: SocialWorkerDeps): void {
      deps = dependencies;
      const interval = input.tickIntervalMs ?? 30_000;
      if (timer === undefined && interval > 0) {
        timer = setInterval(() => { worker.kick(); }, interval);
        timer.unref?.();
      }
    },

    kick(): void {
      const snapshot = deps;
      if (snapshot === undefined || closed) return;
      chain = chain.then(() => pump(snapshot), () => undefined);
    },

    async openClusterBrowser(clusterId: string, proxyServer: string): Promise<void> {
      if (deps === undefined) throw new Error('Worker chưa bind database');
      manualOpen.add(clusterId);
      await ensureBrowser(deps, clusterId, proxyServer);
    },

    async closeClusterBrowser(clusterId: string): Promise<void> {
      manualOpen.delete(clusterId);
      const handle = browsers.get(clusterId);
      if (handle === undefined) return;
      browsers.delete(clusterId);
      await handle.close().catch(() => undefined);
    },

    openClusterIds(): string[] {
      return [...browsers.keys()];
    },

    async close(): Promise<void> {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await chain.catch(() => undefined);
      manualOpen.clear();
      for (const handle of browsers.values()) {
        await handle.close().catch(() => undefined);
      }
      browsers.clear();
    }
  };

  return worker;

  // -------------------------------------------------------------------------
  // Lượt chạy: xử lý lần lượt từng job đến hạn.
  // -------------------------------------------------------------------------

  async function pump(depsNow: SocialWorkerDeps): Promise<void> {
    if (kvGet(depsNow.db, 'queue_state') === 'paused') return;
    let nowISO = new Date().toISOString();
    let due = pickDueJob(depsNow.db, nowISO);
    let guard = 0;
    while (!closed && due !== undefined && guard < 500
      && kvGet(depsNow.db, 'queue_state') !== 'paused') {
      guard += 1;
      const row = due;
      const job = mapJob(row);
      const clusterRow = getClusterRow(depsNow.db, job.clusterId);
      const cluster = clusterRow === undefined ? undefined : mapCluster(clusterRow);
      if (cluster === undefined) {
        await skipJob(depsNow, job.id, 'Cụm kênh đã bị xóa');
      } else if (!busyClusters.has(cluster.id)) {
        busyClusters.add(cluster.id);
        try {
          if (jobNeedsBrowser(cluster, job)) {
            await ensureBrowser(depsNow, cluster.id, cluster.proxyServer);
          }
          for (const [platform, prefix] of PLATFORM_PREFIXES) {
            if (closed) break;
            const state = job.platforms[platform]!;
            if (!platformEligible(state.status, state.attempts)) continue;
            await runPlatform(depsNow, cluster, job, platform, prefix);
          }
        } catch (error) {
          // Không mở được trình duyệt (và các lỗi nền tảng chạy chung lượt):
          // đánh dấu các nền tảng còn lượt chạy thành failed (attempts+1) để
          // vòng lặp hội tụ về cap thay vì quay lại vô hạn.
          const message = error instanceof Error ? error.message : String(error);
          const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
          for (const [platform, prefix] of PLATFORM_PREFIXES) {
            const state = job.platforms[platform]!;
            if (platformEligible(state.status, state.attempts)) {
              patch[`${prefix}_status`] = 'failed';
              patch[`${prefix}_attempts`] = state.attempts + 1;
              patch[`${prefix}_error`] = message;
            }
          }
          updateJobRow(depsNow.db, job.id, patch);
          log(`Job ${job.title} dừng: ${message}`);
        } finally {
          busyClusters.delete(cluster.id);
          // Nhả RAM: đóng trình duyệt sau mỗi lượt nếu không cấu hình "giữ mở".
          if (input.keepBrowserOpenAfterJob !== true) {
            const handle = browsers.get(cluster.id);
            if (handle !== undefined && !manualOpen.has(cluster.id)) {
              browsers.delete(cluster.id);
              await handle.close().catch(() => undefined);
            }
          }
        }
      }
      nowISO = new Date().toISOString();
      due = pickDueJob(depsNow.db, nowISO);
    }
  }

  function jobNeedsBrowser(cluster: SocialCluster, job: SocialJob): boolean {
    // Facebook Graph API không cần trình duyệt; còn lại cần.
    return PLATFORM_PREFIXES.some(([platform]) => {
      if (platform === 'facebook' && cluster.fbMode === 'graph_api') return false;
      return platformEligible(job.platforms[platform]!.status, job.platforms[platform]!.attempts);
    });
  }

  async function runPlatform(
    depsNow: SocialWorkerDeps,
    cluster: SocialCluster,
    job: SocialJob,
    platform: SocialPlatform,
    prefix: string
  ): Promise<void> {
    const nowISO = new Date().toISOString();
    updateJobRow(depsNow.db, job.id, {
      [`${prefix}_status`]: 'running',
      [`${prefix}_last_attempt_at`]: nowISO,
      updated_at: nowISO
    });
    const currentRow = getJobRow(depsNow.db, job.id);
    if (currentRow === undefined) return; // job vừa bị xóa thủ công
    const refreshed = mapJob(currentRow);
    const executor = executors[platform];
    let result: SocialExecutionResult;
    if (executor === undefined) {
      result = { status: 'skipped', error: 'Nền tảng chưa cấu hình trong runtime này' };
    } else {
      const context: SocialExecutionContext = {
        cluster,
        job: refreshed,
        fbToken: depsNow.decryptToken(cluster.fbPageTokenEncrypted),
        screenshotDir: depsNow.screenshotDir,
        browser: browsers.get(cluster.id),
        now: () => new Date().toISOString()
      };
      try {
        result = await executor(context);
      } catch (error) {
        result = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (result.loginStatus !== undefined) {
      const loginPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      loginPatch[`${prefix}_login`] = result.loginStatus;
      updateClusterRow(depsNow.db, cluster.id, loginPatch);
    }
    commitPlatformResult(depsNow.db, job.id, prefix, result, refreshed.platforms[platform]!.attempts);
    if (result.status === 'failed' && result.error !== undefined) {
      log(`Đăng ${platform} cho cụm "${cluster.name}" (${job.title}) thất bại: ${result.error}`);
    } else if (result.status === 'published' || result.status === 'scheduled') {
      log(`Đăng ${platform} cho cụm "${cluster.name}" (${job.title}) OK${result.videoId ? ` — id ${result.videoId}` : ''}`);
    }
  }

  function commitPlatformResult(
    db: SocialDB,
    jobId: string,
    prefix: string,
    result: SocialExecutionResult,
    previousAttempts: number
  ): void {
    const nowISO = new Date().toISOString();
    const patch: Record<string, unknown> = { updated_at: nowISO };
    if (result.status === 'failed') {
      patch[`${prefix}_status`] = 'failed';
      patch[`${prefix}_attempts`] = previousAttempts + 1;
      patch[`${prefix}_error`] = result.error ?? null;
      patch[`${prefix}_screenshot`] = result.screenshotPath ?? null;
    } else if (result.status === 'skipped') {
      patch[`${prefix}_status`] = 'skipped';
      patch[`${prefix}_error`] = result.error ?? null;
    } else {
      patch[`${prefix}_status`] = result.status; // 'published' hoặc 'scheduled'
      patch[`${prefix}_video_id`] = result.videoId ?? null;
      patch[`${prefix}_error`] = null;
    }
    updateJobRow(db, jobId, patch);
  }

  async function skipJob(depsNow: SocialWorkerDeps, jobId: string, reason: string): Promise<void> {
    const nowISO = new Date().toISOString();
    const patch: Record<string, unknown> = { updated_at: nowISO };
    for (const prefix of ['yt', 'tk', 'fb']) {
      patch[`${prefix}_status`] = 'skipped';
      patch[`${prefix}_error`] = reason;
    }
    updateJobRow(depsNow.db, jobId, patch);
  }

  function pickDueJob(db: SocialDB, nowISO: string): SocialJobRow | undefined {
    const nowTime = new Date(nowISO).getTime();
    const rows = listJobRows(db).filter(row => {
      if (row.yt_status === 'running' || row.tk_status === 'running' || row.fb_status === 'running') return false;
      if (new Date(row.scheduled_at).getTime() > nowTime) return false;
      // Chỉ chọn job còn ÍT NHẤT MỘT nền tảng đủ điều kiện chạy (pending, hoặc
      // failed còn lượt retry) — nếu không, pump sẽ quay lại vô hạn một job
      // failed đã hết lượt.
      return PLATFORM_PREFIXES.some(([platform, prefix]) => {
        const record = row as unknown as Record<string, unknown>;
        const status = record[`${prefix}_status`] as SocialPlatformStatus;
        const attempts = record[`${prefix}_attempts`] as number;
        return platformEligible(status, attempts);
      });
    });
    if (rows.length === 0) return undefined;
    rows.sort((left, right) => new Date(left.scheduled_at).getTime() - new Date(right.scheduled_at).getTime());
    return rows[0];
  }

  function platformEligible(status: SocialPlatformStatus, attempts: number): boolean {
    return status === 'pending' || (status === 'failed' && attempts < maxAttempts);
  }

  async function ensureBrowser(depsNow: SocialWorkerDeps, clusterId: string, proxyServer: string): Promise<void> {
    if (browsers.has(clusterId)) return;
    const launcher = input.browserLauncher;
    if (launcher === undefined) {
      return; // Không cấu hình trình duyệt thật (kiểm thử hoặc mode API)
    }
    try {
      const handle = await launcher(clusterId, proxyServer, `${depsNow.profileRoot}/${clusterId}`);
      browsers.set(clusterId, handle);
    } catch (error) {
      throw new Error(
        `Mở trình duyệt thất bại: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
