import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSocialService, SocialError } from '../../src/social/service.js';
import { createSocialWorker } from '../../src/social/worker.js';
import { closeSocialDatabase, openSocialDatabase } from '../../src/social/db.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function makeService(options: {
  paused?: boolean;
  readDownloadsRoot?: () => Promise<string | undefined>;
} = {}): Promise<{ service: ReturnType<typeof createSocialService>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'social-service-'));
  const worker = createSocialWorker({ tickIntervalMs: 0 });
  const service = createSocialService({
    dataDir: dir,
    worker,
    checkProxyFn: async () => ({ status: 'online', detail: '9ms' }),
    ...(options.readDownloadsRoot === undefined ? {} : { readDownloadsRoot: options.readDownloadsRoot })
  });
  cleanup = async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { service, dir };
}

describe('social service â€” cá»¥m kÃªnh', () => {
  it('', async () => {
    const { service } = await makeService();
    const summary = service.createCluster({ name: '  Cá»¥m B  ', fbPageToken: ' tok-xyz ', defaultScheduleTimes: ['08:00', 'zzz'] });
    const created = summary.clusters[0]!;
    expect(created.name).toBe('Cá»¥m B');
    expect('fbPageTokenEncrypted' in created).toBe(false);
    expect(created.fbPageTokenConfigured).toBe(true);
    expect(created.defaultScheduleTimes).toEqual(['08:00']); // lá»c khung há»ng
    expect(created.proxyStatus).toBe('no_proxy');
  });

  it('', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C', fbPageToken: 'tok', proxyServer: 'http://a.b:1' });
    const clusterId = service.getOverview().clusters[0]!.id;
    const summary = service.updateCluster(clusterId, { proxyServer: 'http://c.d:2', fbPageToken: null });
    const updated = summary.clusters[0]!;
    expect(updated.proxyServer).toBe('http://c.d:2');
    expect(updated.proxyStatus).toBe('unchecked');
    expect(updated.fbPageTokenConfigured).toBe(false);
  });

  it('', async () => {
    const { service } = await makeService();
    expect(() => service.updateCluster('nope', { name: 'x' })).toThrow(SocialError);
    expect(() => service.deleteCluster('nope')).toThrow(SocialError);
  });

  it('checkClusterProxy ghi láº¡i status tá»« checkProxyFn', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C', proxyServer: 'http://1.1.1.1:8080' });
    const summary = await service.checkClusterProxy(service.getOverview().clusters[0]!.id);
    expect(summary.clusters[0]!.proxyStatus).toBe('online');
    expect(summary.clusters[0]!.proxyDetail).toContain('9ms');
  });
});

describe('social service â€” enqueue & hÃ ng Ä‘á»£i', () => {
  it('', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C', defaultScheduleTimes: ['09:00'] });
    const clusterId = service.getOverview().clusters[0]!.id;
    const result = service.enqueue([
      { clusterId, path: 'D:/v1.mp4', title: 'Táº­p 1' },
      { clusterId, path: 'D:/v2.mp4', title: 'Táº­p 2' }
    ]);
    expect(result.accepted).toBe(2);
    expect(result.duplicates).toEqual([]);
    const scheduled = result.summary.jobs.map(job => job.scheduledAt).sort();
    expect(new Date(scheduled[1]!).getTime() - new Date(scheduled[0]!).getTime()).toBe(24 * 60 * 60_000);
  });

  it('', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C' });
    const clusterId = service.getOverview().clusters[0]!.id;
    service.enqueue([{ clusterId, path: 'D:/same.mp4' }]);
    const second = service.enqueue([{ clusterId, path: 'D:/same.mp4' }]);
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toEqual(['D:/same.mp4']);
  });

  it('', async () => {
    const { service } = await makeService();
    const result = service.enqueue([{ clusterId: 'none', path: 'D:/v.mp4' }]);
    expect(result.accepted).toBe(0);
    expect(result.duplicates).toEqual(['D:/v.mp4']);
  });

  it('', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C', defaultDescription: 'Mo ta chung' });
    const clusterId = service.getOverview().clusters[0]!.id;
    const result = service.enqueue([{ clusterId, path: 'D:/clip/Tap-3-final.mp4' }]);
    const job = result.summary.jobs[0]!;
    expect(job.title).toBe('Tap-3-final.mp4');
    expect(job.description).toBe('Mo ta chung');
  });

  it('', async () => {
    const { service } = await makeService();
    expect(service.pause().queue).toBe('paused');
    expect(service.resume().queue).toBe('running');
  });

  it('', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C' });
    const clusterId = service.getOverview().clusters[0]!.id;
    const { summary } = service.enqueue([{ clusterId, path: 'D:/v.mp4' }]);
    const jobId = summary.jobs[0]!.id;
    service.removeJob(jobId);
    expect(() => service.removeJob(jobId)).toThrow(SocialError);
  });

  it('', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C' });
    const clusterId = service.getOverview().clusters[0]!.id;
    const result = service.enqueue([
      { clusterId, path: 'D:/due.mp4', scheduledAt: new Date(Date.now() - 60_000).toISOString() },
      { clusterId, path: 'D:/future.mp4', scheduledAt: new Date(Date.now() + 30 * 60_000).toISOString() }
    ]);
    expect(result.summary.counts.pending).toBe(3);
    expect(result.summary.counts.scheduled).toBe(3);
  });
});

describe('social service — platform settings khi enqueue', () => {
  it('lưu settings hợp lệ và lọc bỏ trường rác (sanitise)', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C' });
    const clusterId = service.getOverview().clusters[0]!.id;
    const result = service.enqueue([{
      clusterId,
      path: 'D:/v.mp4',
      platformSettings: {
        youtube: { privacy: 'unlisted', tags: ['  phim  ', '', 123 as never, 'hay'], madeForKids: true },
        tiktok: { privacy: 'friends', allowComments: true, directPost: 'không hợp lệ' as never },
        facebook: { postType: 'reel' },
        'khonghop le': 'bỏ đi' as never
      } as never
    }]);
    expect(result.accepted).toBe(1);
    const job = result.summary.jobs[0]!;
    expect(job.platformSettings).toEqual({
      youtube: { privacy: 'unlisted', tags: ['phim', 'hay'], madeForKids: true },
      tiktok: { privacy: 'friends', allowComments: true },
      facebook: { postType: 'reel' }
    });
  });

  it('tags YouTube vượt tổng 500 ký tự bị cắt bớt', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C' });
    const clusterId = service.getOverview().clusters[0]!.id;
    const longTags = Array.from({ length: 40 }, (_, index) => `tag${index}-${'a'.repeat(20)}`);
    const result = service.enqueue([{
      clusterId,
      path: 'D:/v.mp4',
      platformSettings: { youtube: { tags: longTags } }
    }]);
    const tags = result.summary.jobs[0]!.platformSettings.youtube!.tags ?? [];
    expect(tags.length).toBeLessThan(longTags.length);
    expect(tags.reduce((total, tag) => total + tag.length, 0)).toBeLessThanOrEqual(500);
  });

  it('settings sai kiểu hoàn toàn → job vẫn nạp được với platformSettings {}', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C' });
    const clusterId = service.getOverview().clusters[0]!.id;
    const result = service.enqueue([{
      clusterId,
      path: 'D:/v.mp4',
      platformSettings: 'không phải object' as never
    }]);
    expect(result.accepted).toBe(1);
    expect(result.summary.jobs[0]!.platformSettings).toEqual({});
  });
});

describe('social service — rescheduleJob (đổi giờ đăng)', () => {
  it('đổi giờ job chưa đăng → scheduler thấy job đến hạn ngay', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C' });
    const clusterId = service.getOverview().clusters[0]!.id;
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const { summary } = service.enqueue([{ clusterId, path: 'D:/v.mp4', scheduledAt: future }]);
    const jobId = summary.jobs[0]!.id;
    expect(summary.counts.scheduled).toBe(3);

    const past = new Date(Date.now() - 60_000).toISOString();
    const rescheduled = service.rescheduleJob(jobId, past);
    const job = rescheduled.jobs.find(candidate => candidate.id === jobId)!;
    expect(job.scheduledAt).toBe(past);
    // Scheduler xếp lại: platform pending tới hạn → chuyển sang "pending" thay vì "scheduled".
    expect(rescheduled.counts.pending).toBe(3);
    expect(rescheduled.counts.scheduled).toBe(0);
  });

  it('chuẩn hóa ISO có múi giờ về UTC', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C' });
    const clusterId = service.getOverview().clusters[0]!.id;
    const { summary } = service.enqueue([{ clusterId, path: 'D:/v.mp4', scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }]);
    const jobId = summary.jobs[0]!.id;
    const rescheduled = service.rescheduleJob(jobId, '2026-06-01T12:00:00+07:00');
    expect(rescheduled.jobs[0]!.scheduledAt).toBe('2026-06-01T05:00:00.000Z');
  });

  it('job đã published/scheduled trên nền tảng → từ chối (social_job_not_reschedulable)', async () => {
    const { service, dir } = await makeService();
    service.createCluster({ name: 'C' });
    const clusterId = service.getOverview().clusters[0]!.id;
    const { summary } = service.enqueue([{ clusterId, path: 'D:/v.mp4', scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }]);
    const jobId = summary.jobs[0]!.id;
    // Đánh dấu YouTube đã đăng bằng kết nối thứ hai (WAL) như một phiên đăng thật.
    const raw = openSocialDatabase(join(dir, 'social.sqlite'));
    try {
      raw.prepare("UPDATE social_jobs SET yt_status = 'published' WHERE id = ?").run(jobId);
      expect(() => service.rescheduleJob(jobId, new Date(Date.now() + 7_200_000).toISOString()))
        .toThrow(SocialError);
      try {
        service.rescheduleJob(jobId, new Date(Date.now() + 7_200_000).toISOString());
      } catch (error) {
        expect((error as SocialError).code).toBe('social_job_not_reschedulable');
      }
    } finally {
      closeSocialDatabase(raw);
    }
  });

  it('ISO không hợp lệ → social_job_schedule_invalid; job không tồn tại → social_job_not_found', async () => {
    const { service } = await makeService();
    service.createCluster({ name: 'C' });
    const clusterId = service.getOverview().clusters[0]!.id;
    const { summary } = service.enqueue([{ clusterId, path: 'D:/v.mp4', scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }]);
    const jobId = summary.jobs[0]!.id;
    try {
      service.rescheduleJob(jobId, 'không-phải-ngày');
      expect.unreachable();
    } catch (error) {
      expect((error as SocialError).code).toBe('social_job_schedule_invalid');
    }
    try {
      service.rescheduleJob('job_missing', new Date(Date.now() + 3_600_000).toISOString());
      expect.unreachable();
    } catch (error) {
      expect((error as SocialError).code).toBe('social_job_not_found');
    }
  });
});

describe('social service — listDownloads (media picker)', () => {
  it('liệt kê mp4/mkv/webm của thư mục downloads, mới nhất trước, bỏ file khác', async () => {
    const downloadsRoot = await mkdtemp(join(tmpdir(), 'social-downloads-'));
    try {
      await writeFile(join(downloadsRoot, 'a.mp4'), 'a');
      await writeFile(join(downloadsRoot, 'readme.txt'), 'không lấy');
      await writeFile(join(downloadsRoot, 'c.webm'), 'c');
      const seriesDir = join(downloadsRoot, 'Trường Phù');
      await mkdir(seriesDir, { recursive: true });
      await writeFile(join(seriesDir, 'b.mkv'), 'b');
      // Gán mtime tường minh để không phụ thuộc thứ tự ghi đĩa.
      const base = Date.parse('2026-05-01T08:00:00.000Z');
      await utimes(join(downloadsRoot, 'a.mp4'), new Date(base), new Date(base));
      await utimes(join(seriesDir, 'b.mkv'), new Date(base + 5_000), new Date(base + 5_000));
      await utimes(join(downloadsRoot, 'c.webm'), new Date(base + 2_000), new Date(base + 2_000));

      const { service } = await makeService({ readDownloadsRoot: async () => downloadsRoot });
      const { items } = await service.listDownloads();
      expect(items.map(item => item.path)).toEqual([
        join(seriesDir, 'b.mkv'),
        join(downloadsRoot, 'c.webm'),
        join(downloadsRoot, 'a.mp4')
      ]);
      expect(items[0]!).toMatchObject({ title: 'b', seriesName: 'Trường Phù', sizeBytes: 1 });
      expect(items[1]!).toMatchObject({ title: 'c', seriesName: '' });
      expect(items[2]!).toMatchObject({ title: 'a', seriesName: '' });
    } finally {
      await rm(downloadsRoot, { recursive: true, force: true });
    }
  });

  it('giới hạn số lượng theo limit; không cấu hình downloadsRoot → rỗng', async () => {
    const downloadsRoot = await mkdtemp(join(tmpdir(), 'social-downloads-'));
    try {
      for (const name of ['1.mp4', '2.mp4', '3.mp4']) {
        await writeFile(join(downloadsRoot, name), name);
      }
      const { service } = await makeService({ readDownloadsRoot: async () => downloadsRoot });
      const limited = await service.listDownloads(2);
      expect(limited.items).toHaveLength(2);
      const none = await makeService();
      expect(await none.service.listDownloads()).toEqual({ items: [] });
    } finally {
      await rm(downloadsRoot, { recursive: true, force: true });
    }
  });
});
