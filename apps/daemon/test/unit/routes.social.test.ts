import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSocialRoutes } from '../../src/api/routes.social.js';
import { createSocialService } from '../../src/social/service.js';
import { createSocialWorker } from '../../src/social/worker.js';

let server: FastifyInstance | undefined;
let teardown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  await teardown?.();
  teardown = undefined;
});

describe('registerSocialRoutes — service chưa cắm', () => {  it('GET /social/overview → 503 social_unavailable', async () => {
    server = Fastify();
    await registerSocialRoutes(server, undefined);
    const response = await server.inject('/social/overview');
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('social_unavailable');
  });
});

async function setupServer(options: { downloadsRoot?: string; browserLauncher?: NonNullable<Parameters<typeof createSocialWorker>[0]>['browserLauncher'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'social-routes-'));
  const worker = createSocialWorker({
    tickIntervalMs: 0,
    ...(options.browserLauncher === undefined ? {} : { browserLauncher: options.browserLauncher })
  });
  const service = createSocialService({
    dataDir: dir,
    worker,
    checkProxyFn: async proxyServer => ({ status: 'dead', detail: `dead: ${proxyServer}` }),
    ...(options.downloadsRoot === undefined
      ? {}
      : { readDownloadsRoot: async () => options.downloadsRoot })
  });
  server = Fastify();
  await registerSocialRoutes(server, service);
  teardown = async () => {
    await server?.close();
    server = undefined;
    await service.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { service, dir };
}

describe('registerSocialRoutes — đủ service', () => {
  it('tạo cụm thiếu name → 400', async () => {
    await setupServer();
    const response = await server!.inject({ method: 'POST', url: '/social/clusters', payload: { seriesName: 'x' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('CRUD cụm qua REST', async () => {
    await setupServer();
    const created = await server!.inject({
      method: 'POST', url: '/social/clusters',
      payload: { name: 'Cụm REST', fbMode: 'graph_api', fbPageToken: 'secret-token' }
    });
    expect(created.statusCode).toBe(200);
    const cluster = created.json().clusters[0];
    expect(cluster.name).toBe('Cụm REST');
    expect(cluster.fbPageTokenConfigured).toBe(true);
    expect(JSON.stringify(created.json())).not.toContain('secret-token');

    const patched = await server!.inject({
      method: 'PATCH', url: `/social/clusters/${cluster.id}`,
      payload: { name: 'Cụm REST*', defaultScheduleTimes: ['06:30', '20:00'] }
    });
    expect(patched.json().clusters[0]).toMatchObject({ name: 'Cụm REST*', defaultScheduleTimes: ['06:30', '20:00'] });

    const deleted = await server!.inject({ method: 'DELETE', url: `/social/clusters/${cluster.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().clusters).toHaveLength(0);
  });

  it('enqueue 1 item + dạng items[] + dedupe 409', async () => {
    await setupServer();
    const clusterId = (await server!.inject({ method: 'POST', url: '/social/clusters', payload: { name: 'Q' } })).json().clusters[0].id;
    const single = await server!.inject({ method: 'POST', url: '/social/jobs', payload: { clusterId, path: 'D:/a.mp4', title: 'A' } });
    expect(single.statusCode).toBe(200);
    expect(single.json().accepted).toBe(1);

    const batch = await server!.inject({ method: 'POST', url: '/social/jobs', payload: { items: [{ clusterId, path: 'D:/b.mp4' }] } });
    expect(batch.json().accepted).toBe(1);

    const duplicate = await server!.inject({ method: 'POST', url: '/social/jobs', payload: { clusterId, path: 'D:/a.mp4' } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('social_enqueue_duplicate');
    expect(duplicate.json().duplicates).toEqual(['D:/a.mp4']);

    const invalid = await server!.inject({ method: 'POST', url: '/social/jobs', payload: { nope: true } });
    expect(invalid.statusCode).toBe(400);
  });

  it('retry-failed trên job không tồn tại → 404; pause/resume; screenshot 404', async () => {
    await setupServer();
    expect((await server!.inject({ method: 'POST', url: '/social/jobs/job_missing/retry-failed' })).statusCode).toBe(404);
    expect((await server!.inject({ method: 'DELETE', url: '/social/jobs/job_missing' })).statusCode).toBe(404);
    expect((await server!.inject('/social/jobs/job_missing/error-screenshot?platform=youtube')).statusCode).toBe(404);
    expect((await server!.inject({ method: 'POST', url: '/social/queue/pause' })).json().queue).toBe('paused');
    expect((await server!.inject({ method: 'POST', url: '/social/queue/resume' })).json().queue).toBe('running');
  });

  it('platform không hợp lệ trên error-screenshot → 400', async () => {
    await setupServer();
    const clusterId = (await server!.inject({ method: 'POST', url: '/social/clusters', payload: { name: 'S' } })).json().clusters[0].id;
    const jobId = (await server!.inject({ method: 'POST', url: '/social/jobs', payload: { clusterId, path: 'D:/v.mp4' } })).json().summary.jobs[0].id;
    const response = await server!.inject(`/social/jobs/${jobId}/error-screenshot?platform=instagram`);
    expect(response.statusCode).toBe(400);
    const missing = await server!.inject(`/social/jobs/${jobId}/error-screenshot?platform=youtube`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('social_screenshot_missing');
  });
});

describe('registerSocialRoutes — nạp đa kênh 1 lần (1 video × N cụm)', () => {
  it('clusterIds nạp 1 video vào nhiều cụm, summary gộp; settings lưu trong job view', async () => {
    await setupServer();
    await server!.inject({ method: 'POST', url: '/social/clusters', payload: { name: 'A' } });
    await server!.inject({ method: 'POST', url: '/social/clusters', payload: { name: 'B' } });
    const clusters = (await server!.inject('/social/overview')).json().clusters;
    const clusterA = clusters[0].id;
    const clusterB = clusters[1].id;
    const response = await server!.inject({
      method: 'POST',
      url: '/social/jobs',
      payload: {
        clusterIds: [clusterA, clusterB],
        path: 'D:/multi.mp4',
        title: 'Đa kênh',
        platformSettings: {
          youtube: { privacy: 'private', tags: ['kênh'], madeForKids: false },
          tiktok: { privacy: 'friends', allowDuet: false },
          facebook: { postType: 'reel' }
        }
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(2);
    expect(body.summary.jobs).toHaveLength(2);
    for (const job of body.summary.jobs) {
      expect(job.clusterId === clusterA || job.clusterId === clusterB).toBe(true);
      expect(job.title).toBe('Đa kênh');
      expect(job.platformSettings).toEqual({
        youtube: { privacy: 'private', tags: ['kênh'], madeForKids: false },
        tiktok: { privacy: 'friends', allowDuet: false },
        facebook: { postType: 'reel' }
      });
    }
    // Cụm không tồn tại trong danh sách → bị bỏ qua nhưng phần hợp lệ vẫn nạp.
    const mixed = await server!.inject({
      method: 'POST',
      url: '/social/jobs',
      payload: { clusterIds: [clusterA, 'cluster_ghost'], path: 'D:/other.mp4' }
    });
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json().accepted).toBe(1);
    expect(mixed.json().duplicates).toEqual(['D:/other.mp4']);

    const invalid = await server!.inject({
      method: 'POST',
      url: '/social/jobs',
      payload: { clusterIds: [], path: 'D:/x.mp4' }
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('registerSocialRoutes — PATCH /social/jobs/:id (đổi giờ)', () => {
  it('đổi giờ job chưa đăng → 200 + giờ mới; thiếu/threshold sai → 400; job lạ → 404', async () => {
    const { dir } = await setupServer();
    const clusterId = (await server!.inject({ method: 'POST', url: '/social/clusters', payload: { name: 'R' } })).json().clusters[0].id;
    const jobId = (await server!.inject({ method: 'POST', url: '/social/jobs', payload: { clusterId, path: 'D:/v.mp4' } })).json().summary.jobs[0].id;

    const newTime = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    const patched = await server!.inject({
      method: 'PATCH',
      url: `/social/jobs/${jobId}`,
      payload: { scheduledAt: newTime }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().jobs.find((job: { id: string }) => job.id === jobId).scheduledAt).toBe(newTime);

    const missingField = await server!.inject({ method: 'PATCH', url: `/social/jobs/${jobId}`, payload: {} });
    expect(missingField.statusCode).toBe(400);
    const notISO = await server!.inject({ method: 'PATCH', url: `/social/jobs/${jobId}`, payload: { scheduledAt: 'maicao' } });
    expect(notISO.statusCode).toBe(400);
    expect(notISO.json().error.code).toBe('social_job_schedule_invalid');
    const ghost = await server!.inject({ method: 'PATCH', url: '/social/jobs/job_ghost', payload: { scheduledAt: newTime } });
    expect(ghost.statusCode).toBe(404);

    // Job đã đăng trên nền tảng → 409 social_job_not_reschedulable.
    const raw = (await import('../../src/social/db.js')).openSocialDatabase(join(dir, 'social.sqlite'));
    try {
      raw.prepare("UPDATE social_jobs SET yt_status = 'published' WHERE id = ?").run(jobId);
      const conflict = await server!.inject({
        method: 'PATCH',
        url: `/social/jobs/${jobId}`,
        payload: { scheduledAt: new Date(Date.now() + 7 * 60 * 60_000).toISOString() }
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe('social_job_not_reschedulable');
    } finally {
      (await import('../../src/social/db.js')).closeSocialDatabase(raw);
    }
  });
});

describe('registerSocialRoutes — POST /social/clusters/:id/login/:platform (đăng nhập tay)', () => {
  it('nền tảng hợp lệ → { ok: true }; sai nền tảng → 400; cụm lạ → 404', async () => {
    const openedUrls: string[] = [];
    await setupServer({
      browserLauncher: async () => ({
        newPage: async (url?: string) => {
          openedUrls.push(url ?? '');
          return { url };
        },
        close: async () => undefined
      })
    });
    const created = await server!.inject({ method: 'POST', url: '/social/clusters', payload: { name: 'Cụm Đăng Nhập' } });
    const clusterId = created.json().clusters[0].id;
    const ok = await server!.inject({ method: 'POST', url: `/social/clusters/${clusterId}/login/tiktok` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(openedUrls).toEqual(['https://www.tiktok.com/login']);

    const badPlatform = await server!.inject({ method: 'POST', url: `/social/clusters/${clusterId}/login/threads` });
    expect(badPlatform.statusCode).toBe(400);
    expect(badPlatform.json().error.code).toBe('VALIDATION_FAILED');

    const ghost = await server!.inject({ method: 'POST', url: '/social/clusters/cluster_nope/login/youtube' });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error.code).toBe('social_cluster_not_found');
  });
});

describe('registerSocialRoutes — GET /social/downloads (media picker)', () => {
  it('trả video đã tải về: lọc đuôi, mới nhất trước, giới hạn limit', async () => {
    const downloadsRoot = await mkdtemp(join(tmpdir(), 'social-routes-dl-'));
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(downloadsRoot, 'ep-1.mp4'), '1');
      await writeFile(join(downloadsRoot, 'ep-2.mkv'), '2');
      await writeFile(join(downloadsRoot, 'notes.txt'), 'bỏ');
      await writeFile(join(downloadsRoot, 'clip.webm'), '3');
      const { utimes } = await import('node:fs/promises');
      const base = Date.parse('2026-05-10T09:00:00.000Z');
      await utimes(join(downloadsRoot, 'ep-1.mp4'), new Date(base), new Date(base));
      await utimes(join(downloadsRoot, 'ep-2.mkv'), new Date(base + 9_000), new Date(base + 9_000));
      await utimes(join(downloadsRoot, 'clip.webm'), new Date(base + 3_000), new Date(base + 3_000));

      await setupServer({ downloadsRoot });
      const all = await server!.inject('/social/downloads');
      expect(all.statusCode).toBe(200);
      expect(all.json().items.map((item: { title: string }) => item.title)).toEqual(['ep-2', 'clip', 'ep-1']);
      expect(all.json().items[0]).toMatchObject({ seriesName: '', sizeBytes: 1 });

      const limited = await server!.inject('/social/downloads?limit=1');
      expect(limited.json().items).toHaveLength(1);
      expect(limited.json().items[0].title).toBe('ep-2');
    } finally {
      await rm(downloadsRoot, { recursive: true, force: true });
    }
  });

  it('không cấu hình downloadsRoot → danh sách rỗng (không lỗi)', async () => {
    await setupServer();
    const response = await server!.inject('/social/downloads');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });
});

describe('registerSocialRoutes — công tắc autoPublishAfterTranslate qua REST', () => {
  it('PATCH /social/clusters/:id nhận autoPublishAfterTranslate và GET overview trả lại', async () => {
    await setupServer();
    const created = await server!.inject({ method: 'POST', url: '/social/clusters', payload: { name: 'Cụm Tự Nạp' } });
    const clusterId = created.json().clusters[0].id;
    expect(created.json().clusters[0].autoPublishAfterTranslate).toBe(false);

    const patched = await server!.inject({
      method: 'PATCH',
      url: `/social/clusters/${clusterId}`,
      payload: { autoPublishAfterTranslate: true }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().clusters[0].autoPublishAfterTranslate).toBe(true);

    const overview = (await server!.inject('/social/overview')).json();
    expect(overview.clusters[0].autoPublishAfterTranslate).toBe(true);
  });
});
