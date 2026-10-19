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

describe('registerSocialRoutes — service chưa cắm', () => {
  it('GET /social/overview → 503 social_unavailable', async () => {
    server = Fastify();
    await registerSocialRoutes(server, undefined);
    const response = await server.inject('/social/overview');
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('social_unavailable');
  });
});

async function setupServer() {
  const dir = await mkdtemp(join(tmpdir(), 'social-routes-'));
  const worker = createSocialWorker({ tickIntervalMs: 0 });
  const service = createSocialService({ dataDir: dir, worker, checkProxyFn: async proxyServer => ({ status: 'dead', detail: `dead: ${proxyServer}` }) });
  server = Fastify();
  await registerSocialRoutes(server, service);
  teardown = async () => {
    await server?.close();
    server = undefined;
    await service.close();
    await rm(dir, { recursive: true, force: true });
  };
  return service;
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
