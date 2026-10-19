import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSocialService, SocialError } from '../../src/social/service.js';
import { createSocialWorker } from '../../src/social/worker.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function makeService(options: { paused?: boolean } = {}): Promise<{ service: ReturnType<typeof createSocialService>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'social-service-'));
  const worker = createSocialWorker({ tickIntervalMs: 0 });
  const service = createSocialService({ dataDir: dir, worker, checkProxyFn: async () => ({ status: 'online', detail: '9ms' }) });
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
