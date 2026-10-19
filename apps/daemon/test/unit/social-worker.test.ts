import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeSocialDatabase,
  createClusterRow,
  getJobRow,
  insertJobRow,
  kvSet,
  mapJob,
  openSocialDatabase
} from '../../src/social/db.js';
import { createSocialWorker, type SocialExecutor } from '../../src/social/worker.js';
import type { SocialPlatformStatus } from '../../src/social/types.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

type Harness = Awaited<ReturnType<typeof setupWorker>>;

async function setupWorker(options: {
  executors?: Record<string, SocialExecutor>;
  browserLauncher?: Parameters<typeof createSocialWorker>[0]['browserLauncher'];
  maxAttempts?: number;
  paused?: boolean;
}) {
  const dir = await mkdtemp(join(tmpdir(), 'social-worker-'));
  const db = openSocialDatabase(join(dir, 'social.sqlite'));
  cleanup = async () => {
    closeSocialDatabase(db);
    await rm(dir, { recursive: true, force: true });
  };
  createClusterRow(db, {
    id: 'cluster_a', name: 'Cụm A', seriesName: 'L-', proxyServer: '',
    fbMode: 'graph_api', fbPageId: '', fbPageTokenEncrypted: null,
    defaultScheduleTimes: ['19:30'], defaultDescription: '',
    nowISO: '2026-03-15T00:00:00.000Z'
  });
  insertJobRow(db, {
    id: 'job_1', clusterId: 'cluster_a', clusterName: 'Cụm A',
    videoPath: 'D:/v.mp4', thumbnailPath: null, title: 'Tập 1',
    description: '', scheduledAt: '2026-03-15T09:00:00.000Z', // quá khứ → đến hạn
    nowISO: '2026-03-15T00:00:00.000Z'
  });
  if (options.paused === true) kvSet(db, 'queue_state', 'paused');
  const worker = createSocialWorker({
    executors: options.executors as never,
    browserLauncher: options.browserLauncher,
    tickIntervalMs: 0,
    maxAttempts: options.maxAttempts ?? 3
  });
  cleanup = async () => {
    await worker.close();
    closeSocialDatabase(db);
    await rm(dir, { recursive: true, force: true });
  };
  worker.bind({
    db,
    screenshotDir: join(dir, 'shots'),
    profileRoot: join(dir, 'profiles'),
    decryptToken: () => ''
  });
  const status = (platform: 'yt' | 'tk' | 'fb'): SocialPlatformStatus | undefined => {
    const row = getJobRow(db, 'job_1');
    if (row === undefined) return undefined;
    return mapJob(row).platforms[
      platform === 'yt' ? 'youtube' : platform === 'tk' ? 'tiktok' : 'facebook'
    ]!.status;
  };
  return { db, worker, status, dir };
}

/** Đợi đến khi điều kiện thỏa (worker chạy đè nền). */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('social worker — vòng lặp đăng tuần tự', () => {
  it('chạy cả 3 platform thành công và lưu videoId', async () => {
    const calls: string[] = [];
    const harness = await setupWorker({
      executors: {
        youtube: async context => {
          calls.push(`yt:${context.job.title}`);
          return { status: 'published', videoId: 'yt-1', loginStatus: 'ok' };
        },
        tiktok: async () => ({ status: 'published', videoId: 'tk-1' }),
        facebook: async context => ({ status: 'published', videoId: context.fbToken === '' ? 'fb-tokenless' : 'fb-1' })
      }
    });
    harness.worker.kick();
    await waitFor(() =>
      harness.status('yt') === 'published' && harness.status('tk') === 'published' && harness.status('fb') === 'published'
    );
    expect(calls).toEqual(['yt:Tập 1']);
    const row = getJobRow(harness.db, 'job_1')!;
    expect(mapJob(row).platforms.youtube).toMatchObject({ status: 'published', videoId: 'yt-1', attempts: 0 });
    expect(mapJob(row).platforms.facebook.videoId).toBe('fb-tokenless');
    void harness.dir;
  });

  it('failed platform + attempts, không đụng platform đã thành công (atomic)', async () => {
    const harness = await setupWorker({
      maxAttempts: 1,
      executors: {
        youtube: async () => ({ status: 'failed', error: 'Studio đổi giao diện' }),
        tiktok: async () => ({ status: 'published', videoId: 'tk-1' }),
        facebook: async () => ({ status: 'scheduled' })
      }
    });
    harness.worker.kick();
    await waitFor(() => harness.status('fb') === 'scheduled' && (harness.status('yt') === 'failed' || harness.status('yt') === 'published'));
    const job = mapJob(getJobRow(harness.db, 'job_1')!);
    expect(job.platforms.youtube.status).toBe('failed');
    expect(job.platforms.youtube.attempts).toBe(1);
    expect(job.platforms.youtube.error).toBe('Studio đổi giao diện');
    expect(job.platforms.tiktok).toMatchObject({ status: 'published', videoId: 'tk-1' });
    expect(job.platforms.facebook.status).toBe('scheduled');
  });

  it('executor ném exception → failed kèm thông điệp, worker vẫn chạy nốt nền tảng còn lại', async () => {
    const harness = await setupWorker({
      maxAttempts: 1,
      executors: {
        youtube: async () => {
          throw new Error('mạng rớt giữa chừng');
        },
        tiktok: async () => ({ status: 'published', videoId: 'tk-1' })
      }
    });
    harness.worker.kick();
    await waitFor(() => harness.status('yt') === 'failed' && harness.status('tk') === 'published');
    expect(mapJob(getJobRow(harness.db, 'job_1')!).platforms.youtube.error).toBe('mạng rớt giữa chừng');
  });

  it('executor chưa cắm → skipped, giữ nguyên các platform khác', async () => {
    const harness = await setupWorker({
      executors: { youtube: async () => ({ status: 'published', videoId: 'yt-1' }) }
    });
    harness.worker.kick();
    await waitFor(() => harness.status('yt') === 'published' && harness.status('tk') === 'skipped');
    const job = mapJob(getJobRow(harness.db, 'job_1')!);
    expect(job.platforms.tiktok.error).toContain('chưa cấu hình');
    expect(job.platforms.facebook.status).toBe('skipped');
  });

  it('browser launcher lỗi → các platform pending đang chờ bị đánh dấu failed', async () => {
    const harness = await setupWorker({
      browserLauncher: async () => {
        throw new Error('Chrome không khởi động được');
      },
      executors: {
        youtube: async () => ({ status: 'published', videoId: 'yt-1' })
      }
    });
    harness.worker.kick();
    await waitFor(() => harness.status('yt') === 'failed');
    const job = mapJob(getJobRow(harness.db, 'job_1')!);
    expect(job.platforms.youtube.error).toContain('Chrome không khởi động được');
  });

  it('browser launcher OK → executor nhận được session của cụm', async () => {
    const harness = await setupWorker({
      browserLauncher: async (_clusterId, _proxyServer, profileDir) => ({
        newPage: async (url?: string) => ({ url, profileDir }),
        close: async () => undefined
      }),
      executors: {
        youtube: async context => {
          if (context.browser === undefined) return { status: 'failed', error: 'no browser' };
          const page = await context.browser.newPage('https://studio.youtube.com') as { url?: string };
          return { status: 'published', videoId: page.url ?? '' };
        }
      }
    });
    harness.worker.kick();
    await waitFor(() => harness.status('yt') === 'published');
    const job = mapJob(getJobRow(harness.db, 'job_1')!);
    expect(job.platforms.youtube.error).toBeNull();
  });

  it('hàng đợi paused → không chạy platform nào', async () => {
    const harness = await setupWorker({
      paused: true,
      executors: { youtube: async () => ({ status: 'published', videoId: 'yt-1' }) }
    });
    harness.worker.kick();
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(harness.status('yt')).toBe('pending');
    harness.worker.kick(); // vẫn pending nhờ paused
    expect(harness.status('yt')).toBe('pending');
  });

  it('job không đến hạn → không chạy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'social-worker-'));
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    cleanup = async () => {
      closeSocialDatabase(db);
      await rm(dir, { recursive: true, force: true });
    };
    createClusterRow(db, {
      id: 'cluster_a', name: 'Cụm A', seriesName: '', proxyServer: '',
      fbMode: 'graph_api', fbPageId: '', fbPageTokenEncrypted: null,
      defaultScheduleTimes: ['19:30'], defaultDescription: '',
      nowISO: '2026-03-15T00:00:00.000Z'
    });
    insertJobRow(db, {
      id: 'job_future', clusterId: 'cluster_a', clusterName: 'Cụm A',
      videoPath: 'D:/v.mp4', thumbnailPath: null, title: 'Tập 5',
      description: '', scheduledAt: '2027-03-15T09:00:00.000Z', // tương lai xa
      nowISO: '2026-03-15T00:00:00.000Z'
    });
    const worker = createSocialWorker({
      tickIntervalMs: 0,
      executors: { youtube: async () => ({ status: 'published', videoId: 'yt-1' }) }
    });
    worker.bind({ db, screenshotDir: join(dir, 's'), profileRoot: join(dir, 'p'), decryptToken: () => '' });
    worker.kick();
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(getJobRow(db, 'job_future')?.yt_status).toBe('pending');
  });
});
