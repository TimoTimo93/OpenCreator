import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeSocialDatabase,
  createClusterRow,
  deleteClusterRow,
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
  updateJobRow
} from '../../src/social/db.js';
import { emptyPlatforms } from '../../src/social/types.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function openTempDb() {
  const dir = await mkdtemp(join(tmpdir(), 'social-db-'));
  const db = openSocialDatabase(join(dir, 'social.sqlite'));
  cleanup = async () => {
    closeSocialDatabase(db);
    await rm(dir, { recursive: true, force: true });
  };
  return db;
}

function makeCluster(db: ReturnType<typeof openSocialDatabase>, overrides: Record<string, unknown> = {}) {
  const data = {
    id: 'cluster_a',
    name: 'Cụm A',
    seriesName: 'Long Hổ Riệu',
    proxyServer: 'http://user:pass@1.2.3.4:8080',
    fbMode: 'graph_api' as const,
    fbPageId: 'page-123',
    fbPageTokenEncrypted: 'v1:abc',
    defaultScheduleTimes: ['07:00', '19:30'],
    defaultDescription: 'Mô tả mặc định',
    nowISO: '2026-03-15T00:00:00.000Z',
    ...overrides
  };
  createClusterRow(db, data);
  return data;
}

describe('social db — clusters', () => {
  it('round-trip tạo/đọc/đổi/xóa cụm', async () => {
    const db = await openTempDb();
    makeCluster(db);
    const row = getClusterRow(db, 'cluster_a');
    expect(row).toBeDefined();
    const cluster = mapCluster(row!);
    expect(cluster.seriesName).toBe('Long Hổ Riệu'); // trim
    expect(cluster.proxyStatus).toBe('unchecked');
    expect(cluster.loginStatus.youtube).toBe('unknown');
    expect(cluster.defaultScheduleTimes).toEqual(['07:00', '19:30']);

    updateClusterRow(db, 'cluster_a', { proxy_status: 'online', name: 'Cụm A*' });
    expect(mapCluster(getClusterRow(db, 'cluster_a')!).name).toBe('Cụm A*');
    expect(mapCluster(getClusterRow(db, 'cluster_a')!).proxyStatus).toBe('online');

    expect(deleteClusterRow(db, 'cluster_a')).toBe(true);
    expect(listClusterRows(db)).toHaveLength(0);
  });

  it('xóa cụm kéo theo xóa job của cụm', async () => {
    const db = await openTempDb();
    makeCluster(db);
    insertJobRow(db, {
      id: 'job_1', clusterId: 'cluster_a', clusterName: 'Cụm A',
      videoPath: 'D:/v.mp4', thumbnailPath: null, title: 'Tập 1',
      description: '', scheduledAt: '2026-03-15T10:00:00.000Z',
      nowISO: '2026-03-15T00:00:00.000Z'
    });
    deleteClusterRow(db, 'cluster_a');
    expect(listJobRows(db)).toHaveLength(0);
  });
});

describe('social db — jobs', () => {
  it('insert mặc định 3 platform pending và map đúng cấu trúc', async () => {
    const db = await openTempDb();
    makeCluster(db);
    insertJobRow(db, {
      id: 'job_1', clusterId: 'cluster_a', clusterName: 'Cụm A',
      videoPath: 'D:/v.mp4', thumbnailPath: 'D:/t.jpg', title: 'Tập 1',
      description: '', scheduledAt: '2026-03-15T10:00:00.000Z',
      nowISO: '2026-03-15T00:00:00.000Z'
    });
    const job = mapJob(getJobRow(db, 'job_1')!);
    expect(job.platforms).toEqual(emptyPlatforms());
    expect(job.clusterName).toBe('Cụm A');
  });

  it('updateJobRow chỉ đè cột được chỉ định (atomic từng platform)', async () => {
    const db = await openTempDb();
    makeCluster(db);
    insertJobRow(db, {
      id: 'job_1', clusterId: 'cluster_a', clusterName: 'Cụm A',
      videoPath: 'D:/v.mp4', thumbnailPath: null, title: 'Tập 1',
      description: '', scheduledAt: '2026-03-15T10:00:00.000Z',
      nowISO: '2026-03-15T00:00:00.000Z'
    });
    updateJobRow(db, 'job_1', {
      yt_status: 'published', yt_video_id: 'yt-abc', updated_at: '2026-03-15T11:00:00.000Z'
    });
    const job = mapJob(getJobRow(db, 'job_1')!);
    expect(job.platforms.youtube).toMatchObject({ status: 'published', videoId: 'yt-abc', attempts: 0 });
    expect(job.platforms.tiktok.status).toBe('pending');
    expect(job.platforms.facebook.status).toBe('pending');
  });

  it('findActiveDuplicateJob chỉ khớp job chưa hoàn thành', async () => {
    const db = await openTempDb();
    makeCluster(db);
    insertJobRow(db, {
      id: 'job_1', clusterId: 'cluster_a', clusterName: 'Cụm A',
      videoPath: 'D:/v.mp4', thumbnailPath: null, title: 'Tập 1',
      description: '', scheduledAt: '2026-03-15T10:00:00.000Z',
      nowISO: '2026-03-15T00:00:00.000Z'
    });
    expect(findActiveDuplicateJob(db, 'cluster_a', 'D:/v.mp4')).toBeDefined();
    updateJobRow(db, 'job_1', {
      yt_status: 'published', tk_status: 'published', fb_status: 'published'
    });
    expect(findActiveDuplicateJob(db, 'cluster_a', 'D:/v.mp4')).toBeUndefined();
  });

  it('recoverRunningJobs đưa running về pending khi daemon khởi động lại', async () => {
    const db = await openTempDb();
    makeCluster(db);
    insertJobRow(db, {
      id: 'job_1', clusterId: 'cluster_a', clusterName: 'Cụm A',
      videoPath: 'D:/v.mp4', thumbnailPath: null, title: 'Tập 1',
      description: '', scheduledAt: '2026-03-15T10:00:00.000Z',
      nowISO: '2026-03-15T00:00:00.000Z'
    });
    updateJobRow(db, 'job_1', { yt_status: 'running', tk_status: 'running' });
    recoverRunningJobs(db);
    const job = mapJob(getJobRow(db, 'job_1')!);
    expect(job.platforms.youtube.status).toBe('pending');
    expect(job.platforms.tiktok.status).toBe('pending');
    expect(job.platforms.facebook.status).toBe('pending');
  });
});

describe('social db — platform settings từng job', () => {
  it('insert kèm platformSettings → mapJob trả lại đúng object', async () => {
    const db = await openTempDb();
    makeCluster(db);
    insertJobRow(db, {
      id: 'job_settings', clusterId: 'cluster_a', clusterName: 'Cụm A',
      videoPath: 'D:/v.mp4', thumbnailPath: null, title: 'Tập 1',
      description: '', scheduledAt: '2026-03-15T10:00:00.000Z',
      platformSettings: {
        youtube: { privacy: 'unlisted', tags: ['phim', 'hay'], madeForKids: false },
        tiktok: { privacy: 'friends', allowComments: true },
        facebook: { postType: 'reel' }
      },
      nowISO: '2026-03-15T00:00:00.000Z'
    });
    const job = mapJob(getJobRow(db, 'job_settings')!);
    expect(job.platformSettings).toEqual({
      youtube: { privacy: 'unlisted', tags: ['phim', 'hay'], madeForKids: false },
      tiktok: { privacy: 'friends', allowComments: true },
      facebook: { postType: 'reel' }
    });
    // Job khác không set settings → mặc định {}.
    insertJobRow(db, {
      id: 'job_plain', clusterId: 'cluster_a', clusterName: 'Cụm A',
      videoPath: 'D:/v2.mp4', thumbnailPath: null, title: 'Tập 2',
      description: '', scheduledAt: '2026-03-16T10:00:00.000Z',
      nowISO: '2026-03-15T00:00:00.000Z'
    });
    expect(mapJob(getJobRow(db, 'job_plain')!).platformSettings).toEqual({});
  });

  it('platform_settings trong DB hỏng/khô JSON → mapJob về {} (không ném)', async () => {
    const db = await openTempDb();
    makeCluster(db);
    insertJobRow(db, {
      id: 'job_bad', clusterId: 'cluster_a', clusterName: 'Cụm A',
      videoPath: 'D:/v.mp4', thumbnailPath: null, title: 'Tập 1',
      description: '', scheduledAt: '2026-03-15T10:00:00.000Z',
      nowISO: '2026-03-15T00:00:00.000Z'
    });
    db.exec("UPDATE social_jobs SET platform_settings = '{không phải json' WHERE id = 'job_bad'");
    expect(mapJob(getJobRow(db, 'job_bad')!).platformSettings).toEqual({});
    db.exec("UPDATE social_jobs SET platform_settings = '{\"youtube\":{\"privacy\":\"RÁC\"},\"khac\":1}' WHERE id = 'job_bad'");
    expect(mapJob(getJobRow(db, 'job_bad')!).platformSettings).toEqual({});
  });

  it('migration cộng thêm cột trên DB cũ (thiếu platform_settings) khi mở lại', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'social-db-mig-'));
    const path = join(dir, 'social.sqlite');
    // Lần mở 1: tạo schema đủ rồi GIẢ LẬP DB cũ bằng cách drop cột mới.
    const first = openSocialDatabase(path);
    try {
      insertJobRow(first, {
        id: 'job_old', clusterId: '', clusterName: '',
        videoPath: 'D:/old.mp4', thumbnailPath: null, title: 'Cũ',
        description: '', scheduledAt: '2026-03-15T10:00:00.000Z',
        nowISO: '2026-03-15T00:00:00.000Z'
      });
      first.exec('ALTER TABLE social_jobs DROP COLUMN platform_settings');
    } finally {
      closeSocialDatabase(first);
    }
    // Lần mở 2: migrateColumns phải cộng lại cột, giữ nguyên dữ liệu cũ.
    const reopened = openSocialDatabase(path);
    try {
      const columns = reopened.pragma('table_info(social_jobs)') as Array<{ name: string }>;
      expect(columns.some(info => info.name === 'platform_settings')).toBe(true);
      const job = mapJob(getJobRow(reopened, 'job_old')!);
      expect(job.title).toBe('Cũ');
      expect(job.platformSettings).toEqual({});
    } finally {
      closeSocialDatabase(reopened);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('social db — kv', () => {
  it('lưu/đọc/không có key', async () => {
    const db = await openTempDb();
    expect(kvGet(db, 'queue_state')).toBeUndefined();
    kvSet(db, 'queue_state', 'paused');
    expect(kvGet(db, 'queue_state')).toBe('paused');
    kvSet(db, 'queue_state', 'running');
    expect(kvGet(db, 'queue_state')).toBe('running');
  });
});
