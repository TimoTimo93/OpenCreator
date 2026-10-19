import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentCapabilityTokenStore } from '../../src/agent-tools/capability-token.js';
import { registerAgentToolRoutes } from '../../src/agent-tools/internal-routes.js';
import { createSocialToolDefinitions } from '../../src/agent-tools/social-tools.js';
import { registerSocialMcpRoute } from '../../src/agent-tools/mcp-routes.js';
import { createAgentScheduleRunInjector, externalToolScopes } from '../../src/agent-tools/run-injection.js';
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

async function setup(options: { scopes: string[] } = { scopes: ['social:read', 'social:manage'] }) {
  const dir = await mkdtemp(join(tmpdir(), 'social-agent-'));
  const worker = createSocialWorker({ tickIntervalMs: 0 });
  const service = createSocialService({ dataDir: dir, worker, checkProxyFn: async () => ({ status: 'online', detail: '3ms' }) });
  const capabilities = createAgentCapabilityTokenStore();
  server = Fastify();
  await registerAgentToolRoutes(server, {
    capabilities,
    schedules: undefined as never,
    social: service
  });
  const token = capabilities.issue({
    runId: 'run_social_1',
    threadId: 'thread_1',
    createdBy: 'api',
    scopes: options.scopes as never
  }).token;
  teardown = async () => {
    await server?.close();
    server = undefined;
    await service.close();
    await rm(dir, { recursive: true, force: true });
  };
  // Client công cụ chạy nội bộ qua server.inject (không cần cổng thật).
  const injectClient = {
    async request(request: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; body?: Record<string, unknown>; query?: Record<string, string> }) {
      const response = await server!.inject({
        method: request.method,
        url: request.query !== undefined && Object.keys(request.query).length > 0
          ? `${request.path}?${new URLSearchParams(request.query).toString()}`
          : request.path,
        ...(request.body === undefined ? {} : { payload: request.body }),
        headers: { authorization: `Bearer ${token}` }
      });
      if (response.statusCode >= 400) {
        throw new Error(`${response.statusCode}: ${response.body.slice(0, 200)}`);
      }
      return response.json() as unknown;
    }
  };
  return { server, token, service, capabilities, definitions: createSocialToolDefinitions({ request: injectClient.request }) };
}

function request(server: FastifyInstance, token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return server.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: { authorization: `Bearer ${token}` }
  });
}

describe('social agent tools — internal routes', () => {
  it('scope chỉ đọc: GET overview được, POST cụm bị chặn', async () => {
    const fixture = await setup({ scopes: ['social:read'] });
    const ok = await request(fixture.server!, fixture.token, 'GET', '/internal/agent-tools/social/overview');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().queue).toBe('running');
    const blocked = await request(fixture.server!, fixture.token, 'POST', '/internal/agent-tools/social/clusters', { name: 'Cụm' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('CAPABILITY_SCOPE_FORBIDDEN');
  });

  it('đầy đủ quyền: tạo cụm → nắp video → pause/resume → xóa', async () => {
    const fixture = await setup();
    const discover = await request(fixture.server!, fixture.token, 'GET', '/internal/agent-tools/social/overview');
    expect(discover.statusCode).toBe(200);
    const toolCreate = fixture.definitions.social_create_cluster;
    await toolCreate.execute({ name: 'Cụm Agent' });
    const overview = (await request(fixture.server!, fixture.token, 'GET', '/internal/agent-tools/social/overview')).json();
    const clusterId = overview.clusters[0].id;
    const toolEnqueue = fixture.definitions.social_enqueue_videos;
    const enqueued = await toolEnqueue.execute({
      clusterId,
      videos: [{ path: 'D:/agent/tap-1.mp4', title: 'Tập 1' }]
    });
    expect((enqueued as { accepted: number }).accepted).toBe(1);
    expect((enqueued as { duplicates: string[] }).duplicates).toEqual([]);

    const paused = await request(fixture.server!, fixture.token, 'POST', '/internal/agent-tools/social/queue/pause');
    expect(paused.json().queue).toBe('paused');
    await request(fixture.server!, fixture.token, 'POST', '/internal/agent-tools/social/queue/resume');

    const jobId = (await request(fixture.server!, fixture.token, 'GET', '/internal/agent-tools/social/overview')).json().jobs[0].id;
    const removed = await request(fixture.server!, fixture.token, 'DELETE', `/internal/agent-tools/social/jobs/${jobId}`);
    expect(removed.statusCode).toBe(200);
    const deleted = await request(fixture.server!, fixture.token, 'DELETE', `/internal/agent-tools/social/clusters/${clusterId}`);
    expect(deleted.json().clusters).toHaveLength(0);
  });

  it('body bất hợp lệ → 400 VALIDATION_FAILED; cụm không tồn tại → 404', async () => {
    const fixture = await setup();
    const invalid = await request(fixture.server!, fixture.token, 'POST', '/internal/agent-tools/social/jobs', { items: 'x' });
    expect(invalid.statusCode).toBe(400);
    const missing = await request(fixture.server!, fixture.token, 'POST', '/internal/agent-tools/social/clusters/zzz/check-proxy');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('social_cluster_not_found');
  });

  it('social_reschedule_job: đổi giờ qua PATCH nội bộ; scope chỉ đọc bị chặn', async () => {
    const fixture = await setup();
    await fixture.definitions.social_create_cluster.execute({ name: 'Cụm Đổi Giờ' });
    const overview = (await request(fixture.server!, fixture.token, 'GET', '/internal/agent-tools/social/overview')).json();
    const clusterId = overview.clusters[0].id;
    await fixture.definitions.social_enqueue_videos.execute({
      clusterId,
      videos: [{ path: 'D:/agent/tap-9.mp4', title: 'Tập 9', platformSettings: { youtube: { privacy: 'unlisted', tags: ['phim'] } } }]
    });
    const withSettings = (await request(fixture.server!, fixture.token, 'GET', '/internal/agent-tools/social/overview')).json();
    expect(withSettings.jobs[0].platformSettings).toEqual({ youtube: { privacy: 'unlisted', tags: ['phim'] } });

    const newTime = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
    const rescheduled = await fixture.definitions.social_reschedule_job.execute({
      jobId: withSettings.jobs[0].id,
      scheduledAt: newTime
    });
    const job = (rescheduled as { jobs: Array<{ id: string; scheduledAt: string }> }).jobs
      .find(candidate => candidate.id === withSettings.jobs[0].id)!;
    expect(job.scheduledAt).toBe(newTime);

    // Job lạ → 404; thiếu scheduledAt → 400.
    const ghost = await request(fixture.server!, fixture.token, 'PATCH', '/internal/agent-tools/social/jobs/job_ghost', { scheduledAt: newTime });
    expect(ghost.statusCode).toBe(404);
    const badBody = await request(fixture.server!, fixture.token, 'PATCH', `/internal/agent-tools/social/jobs/${withSettings.jobs[0].id}`, {});
    expect(badBody.statusCode).toBe(400);

    // Scope chỉ đọc → PATCH bị chặn 403, GET downloads vẫn đọc được.
    const readOnlyToken = fixture.capabilities.issue({
      runId: 'run_readonly', threadId: 'thread_ro', createdBy: 'api', scopes: ['social:read']
    }).token;
    const blocked = await request(fixture.server!, readOnlyToken, 'PATCH', `/internal/agent-tools/social/jobs/${withSettings.jobs[0].id}`, { scheduledAt: newTime });
    expect(blocked.statusCode).toBe(403);
    const downloads = await request(fixture.server!, readOnlyToken, 'GET', '/internal/agent-tools/social/downloads');
    expect(downloads.statusCode).toBe(200);
    expect(downloads.json()).toEqual({ items: [] });
  });

  it('không có social service (chưa khởi động) → route không đăng ký → 404', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'social-agent-'));
    teardown = async () => { await rm(dir, { recursive: true, force: true }); };
    const capabilities = createAgentCapabilityTokenStore();
    server = Fastify();
    await registerAgentToolRoutes(server, {
      capabilities,
      schedules: undefined as never,
      social: undefined
    });
    const token = capabilities.issue({
      runId: 'run_mapping', threadId: 'thread_2', createdBy: 'api', scopes: ['social:read', 'social:manage']
    }).token;
    const response = await request(server!, token, 'GET', '/internal/agent-tools/social/overview');
    expect(response.statusCode).toBe(404);
  });
});

describe('run injection — social MCP', () => {
  it('thread api hội thoại: phát action mcp social với scope manage', async () => {
    const capabilities = createAgentCapabilityTokenStore();
    const injector = createAgentScheduleRunInjector({
      capabilities,
      getBaseUrl: () => 'http://127.0.0.1:43123'
    });
    const prepared = injector.prepare({
      runId: 'run_social_2',
      thread: { id: 'thread_3', purpose: 'chat', cwd: 'D:/w', status: 'active' } as never,
      createdBy: 'api'
    })!;
    const social = prepared.mcpServers.find(entry => entry.name === 'opencreator_social');
    expect(social).toBeDefined();
    expect(social!.url).toBe('http://127.0.0.1:43123/internal/agent-tools/mcp/social');
    const grant = capabilities.inspect(prepared.env.OPENCREATOR_AGENT_CAPABILITY_TOKEN);
    expect(grant.scopes).toContain('social:manage');
    expect(grant.scopes).toContain('social:read');
  });

  it('thread schedule task: KHÔNG gắn social (mutation scope bị cấm cho lịch chạy tự động)', () => {
    const external = externalToolScopes('api', { id: 'thread_4', purpose: 'schedule_task' } as never);
    expect(external.social).toEqual([]);
    const externalChat = externalToolScopes('schedule', { id: 'thread_5', purpose: 'chat' } as never);
    expect(externalChat.social).toEqual([]);
  });

  it('includeSocial: false → không phát mcp social', () => {
    const capabilities = createAgentCapabilityTokenStore();
    const injector = createAgentScheduleRunInjector({
      capabilities,
      getBaseUrl: () => 'http://127.0.0.1:43123',
      includeSocial: false
    });
    const prepared = injector.prepare({
      runId: 'run_social_6',
      thread: { id: 'thread_6', purpose: 'chat' } as never,
      createdBy: 'api'
    })!;
    expect(prepared.mcpServers.some(entry => entry.name === 'opencreator_social')).toBe(false);
  });
});

describe('social MCP route', () => {
  it('scope thiếu → 403; scope đủ → đăng ký tool manage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'social-mcp-'));
    const worker = createSocialWorker({ tickIntervalMs: 0 });
    const service = createSocialService({ dataDir: dir, worker });
    const capabilities = createAgentCapabilityTokenStore();
    server = Fastify();
    await registerSocialMcpRoute(server!, {
      capabilities,
      getBaseUrl: () => 'http://127.0.0.1:43123'
    });
    const readOnly = capabilities.issue({
      runId: 'run_mc', threadId: 'thread_mc', createdBy: 'api', scopes: ['drama:read']
    }).token;
    const denied = await server!.inject({
      method: 'POST',
      url: '/internal/agent-tools/mcp/social',
      headers: { authorization: `Bearer ${readOnly}`, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    });
    expect(denied.statusCode).toBe(403);
    const full = capabilities.issue({
      runId: 'run_mc2', threadId: 'thread_mc2', createdBy: 'api', scopes: ['social:read', 'social:manage']
    }).token;
    void service;
    const listed = await server!.inject({
      method: 'POST',
      url: '/internal/agent-tools/mcp/social',
      headers: {
        authorization: `Bearer ${full}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    });
    expect(listed.statusCode).toBe(200);
    // Transport MCP có thể trả JSON hoặc stream SSE — so chuỗi thô là đủ.
    const names = listed.body;
    expect(names).toContain('social_overview');
    expect(names).toContain('social_enqueue_videos');
    expect(names).toContain('social_reschedule_job');
  });
});
