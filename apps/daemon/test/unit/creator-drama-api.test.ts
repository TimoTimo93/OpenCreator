import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HongguoDramaApiStatus } from '@opencreator/protocol';
import {
  createHongguoComponentManager,
  HongguoUpdateError,
  type HongguoComponentManager,
  type HongguoComponentManagerDeps,
  type HongguoSpawnedProcess
} from '../../src/creator/hongguo/manager.js';
import { registerCreatorDramaRoutes } from '../../src/api/routes.creator-drama.js';
import type { DramaTitleTranslator } from '../../src/creator/drama/title-translator.js';

const CHANNEL_URL = 'https://channel.test/releases/manifest.json';
const ARTIFACT_URL = 'https://channel.test/releases/HongguoDrama-1.74.0-vi.1-win-x64.zip';
const EXE_NAME = '红果短剧.exe';
const ARTIFACT_BYTES = Buffer.from('fake hongguo portable payload');
const ARTIFACT_SHA = createHash('sha256').update(ARTIFACT_BYTES).digest('hex');

let root = '';

afterEach(async () => {
  delete process.env.OPENCREATOR_HONGGUO_UPDATE_MANIFEST_URL;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

type ApiCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

type DramaFixture = {
  manager: HongguoComponentManager;
  spawnCalls: Array<{ exePath: string; env: NodeJS.ProcessEnv }>;
  apiCalls: ApiCall[];
  probeCalls: ApiCall[];
  setApiUp: (value: boolean) => void;
  setApiStatus: (status: number) => void;
  /** Cổng/token đang phục vụ thật (giống tiến trình thành phần đang chạy). */
  serving: () => { port: number; token: string };
  setServing: (value: { port: number; token: string }) => void;
};

async function createDramaFixture(options: { exitFirstSpawn?: boolean } = {}): Promise<DramaFixture> {
  root = await mkdtemp(join(tmpdir(), 'creator-hongguo-drama-'));
  process.env.OPENCREATOR_HONGGUO_UPDATE_MANIFEST_URL = CHANNEL_URL;
  const manifest: Record<string, unknown> = {
    version: '1.74.0',
    viRevision: 1,
    artifact: 'HongguoDrama-1.74.0-vi.1-win-x64.zip',
    sha256: ARTIFACT_SHA,
    bytes: ARTIFACT_BYTES.byteLength,
    upstream: 'jackotom/hongguo-drama',
    launch: { exe: EXE_NAME }
  };
  // Chỉ cổng của tiến trình thành phần đang chạy mới phản hồi; cổng khác coi như
  // không có gì lắng nghe (giống máy thật khi state.json trỏ sai cổng).
  let apiUp = false;
  let apiStatus = 200;
  let serving = { port: 0, token: '' };
  const apiCalls: ApiCall[] = [];
  const probeCalls: ApiCall[] = [];
  const headersOf = (init?: RequestInit): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
    return headers;
  };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === CHANNEL_URL) return jsonResponse(manifest);
    if (url === ARTIFACT_URL) return new Response(ARTIFACT_BYTES, { status: 200 });
    const parsed = new URL(url);
    if (!apiUp || Number(parsed.port) !== serving.port) {
      return new Response('connection refused', { status: 502 });
    }
    if (parsed.pathname === '/healthz') {
      return jsonResponse({ ok: true, name: 'hongguo-drama-api', version: '1.73.0' });
    }
    const headers = headersOf(init);
    const call: ApiCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined
    };
    // Endpoint dò token của daemon: không tính vào danh sách lời gọi nghiệp vụ.
    if (parsed.pathname === '/api/v1/browse-categories') {
      probeCalls.push(call);
      if (headers.authorization !== `Bearer ${serving.token}`) return new Response('unauthorized', { status: 401 });
      return jsonResponse({ categories: [] });
    }
    apiCalls.push(call);
    if (headers.authorization !== `Bearer ${serving.token}`) return new Response('unauthorized', { status: 401 });
    if (apiStatus !== 200) return new Response('upstream boom', { status: apiStatus });
    if (url.includes('/api/v1/browse-list')) {
      return jsonResponse({ success: true, results: [{ series_id: '7686713195246930968', series_title: '总裁' }], total: 1, totalPages: 1 });
    }
    if (url.includes('/api/v1/download-batch')) return jsonResponse({ success: true, count: 2, requested: 2 });
    if (url.includes('/api/v1/media-sources')) {
      return jsonResponse({ success: true, sources: [{ id: 'hongguo', label: 'Hồng Quả' }] });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  const spawnCalls: Array<{ exePath: string; env: NodeJS.ProcessEnv }> = [];
  const exitedPids = new Set<number>();
  const deps: HongguoComponentManagerDeps = {
    fetchImpl,
    extractArchive: async (zipPath, destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, EXE_NAME), 'MZ fake portable');
      await writeFile(join(destination, 'artifact-source.txt'), zipPath);
    },
    spawnProcess: (exePath, env): HongguoSpawnedProcess => {
      spawnCalls.push({ exePath, env });
      if (options.exitFirstSpawn === true && spawnCalls.length === 1) {
        // Giả lập tiến trình thoát ngay (một bản Hồng Quả khác đang giữ khoá
        // single-instance) nên API không bao giờ lắng nghe.
        exitedPids.add(4241);
        return {
          pid: 4241,
          onExit: handler => { queueMicrotask(() => handler(0)); },
          onError: () => undefined
        };
      }
      // Giả lập tiến trình component boot xong là API phản hồi ở đúng cổng/token.
      apiUp = true;
      serving = { port: Number(env.HONGGUO_API_PORT), token: String(env.HONGGUO_API_TOKEN) };
      return { pid: 4242, onExit: () => undefined, onError: () => undefined };
    },
    isProcessAlive: pid => !exitedPids.has(pid)
  };
  const manager = await createHongguoComponentManager({ root }, deps);
  return {
    manager,
    spawnCalls,
    apiCalls,
    probeCalls,
    setApiUp: value => { apiUp = value; },
    setApiStatus: value => { apiStatus = value; },
    serving: () => serving,
    setServing: value => { serving = value; }
  };
}

describe('hongguo drama api (component loopback proxy)', () => {
  it('launches the component with API credentials and proxies browse requests', async () => {
    const fixture = await createDramaFixture();
    await fixture.manager.update();

    const payload = await fixture.manager.apiFetch('/api/v1/browse-list', {
      query: { source: 'hongguo', category: 'real-drama', page: 2 }
    });

    expect(payload).toMatchObject({ success: true });
    expect(fixture.spawnCalls).toHaveLength(1);
    const spawnEnv = fixture.spawnCalls[0]!.env;
    expect(spawnEnv.HONGGUO_USER_DATA_DIR).toBe(join(root, 'user-data'));
    expect(spawnEnv.HONGGUO_DOWNLOAD_DIR).toBe(join(root, 'downloads'));
    expect(spawnEnv.HONGGUO_API_PORT).toMatch(/^\d+$/);
    expect(spawnEnv.HONGGUO_API_TOKEN!.length).toBeGreaterThanOrEqual(8);

    expect(fixture.apiCalls).toHaveLength(1);
    const call = fixture.apiCalls[0]!;
    expect(call.url).toContain('/api/v1/browse-list?');
    expect(call.url).toContain('source=hongguo');
    expect(call.url).toContain('category=real-drama');
    expect(call.url).toContain('page=2');
    expect(call.headers.authorization).toBe(`Bearer ${spawnEnv.HONGGUO_API_TOKEN}`);
    expect(call.headers.accept).toBe('application/json');
  });

  it('persists API credentials so a daemon restart keeps the same port and token', async () => {
    const fixture = await createDramaFixture();
    await fixture.manager.update();
    await fixture.manager.launch();
    const firstEnv = fixture.spawnCalls[0]!.env;
    const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as {
      api?: { port: number; token: string };
    };
    expect(state.api?.port).toBe(Number(firstEnv.HONGGUO_API_PORT));
    expect(state.api?.token).toBe(firstEnv.HONGGUO_API_TOKEN);
  });

  it('adopts the port and token published by a running component when state.json is stale', async () => {
    const fixture = await createDramaFixture();
    await fixture.manager.update();
    // Thành phần đang chạy đã ghi descriptor với cổng khác state.json.
    const descriptor = { port: 49_999, token: 'descriptor-token-123456', pid: 777, version: '1.73.0' };
    fixture.setServing({ port: descriptor.port, token: descriptor.token });
    fixture.setApiUp(true);
    await mkdir(join(root, 'user-data'), { recursive: true });
    await writeFile(join(root, 'user-data', 'drama-api.json'), JSON.stringify(descriptor), 'utf8');

    const payload = await fixture.manager.apiFetch('/api/v1/media-sources');

    expect(payload).toMatchObject({ success: true });
    expect(fixture.spawnCalls).toHaveLength(0);
    const call = fixture.apiCalls[0]!;
    expect(call.url).toContain(':49999/');
    expect(call.headers.authorization).toBe(`Bearer ${descriptor.token}`);
  });

  it('relaunches on a fresh port when the spawned process exits at once (stale single-instance lock)', async () => {
    const fixture = await createDramaFixture({ exitFirstSpawn: true });
    await fixture.manager.update();

    const payload = await fixture.manager.apiFetch('/api/v1/media-sources');

    expect(payload).toMatchObject({ success: true });
    expect(fixture.spawnCalls).toHaveLength(2);
    const firstPort = fixture.spawnCalls[0]!.env.HONGGUO_API_PORT;
    const secondPort = fixture.spawnCalls[1]!.env.HONGGUO_API_PORT;
    expect(secondPort).not.toBe(firstPort);
    expect(secondPort).toBe(String(fixture.serving().port));
  });

  it('rejects with creator_hongguo_unavailable when the component is not installed', async () => {    const fixture = await createDramaFixture();
    const error = await fixture.manager.apiFetch('/api/v1/media-sources').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HongguoUpdateError);
    expect((error as HongguoUpdateError).code).toBe('creator_hongguo_unavailable');
    expect((error as HongguoUpdateError).statusCode).toBe(503);
    expect(fixture.spawnCalls).toHaveLength(0);
    expect(fixture.apiCalls).toHaveLength(0);
  });

  it('probeDramaApi reports readiness without spawning the component', async () => {
    const fixture = await createDramaFixture();
    const fresh = await fixture.manager.probeDramaApi();
    expect(fresh).toMatchObject({ ready: false, port: null, installed: false, running: false });

    await fixture.manager.update();
    const installed = await fixture.manager.probeDramaApi();
    expect(installed).toMatchObject({ ready: false, installed: true, running: false });

    await fixture.manager.launch();
    const running = await fixture.manager.probeDramaApi();
    expect(running.ready).toBe(true);
    expect(running.running).toBe(true);
    expect(running.port).toBeGreaterThan(0);
    expect(running.error).toBeNull();
  });

  it('sends POST bodies as JSON with the bearer token attached', async () => {
    const fixture = await createDramaFixture();
    await fixture.manager.update();
    const payload = await fixture.manager.apiFetch('/api/v1/download-batch', {
      method: 'POST',
      body: { seriesId: '123', seriesTitle: 'Phim A', episodes: [{ vid: 'v1', vid_index: 1 }] }
    });
    expect(payload).toMatchObject({ success: true, count: 2 });
    const call = fixture.apiCalls[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.body ?? '{}')).toMatchObject({ seriesId: '123' });
  });

  it('maps upstream non-2xx responses to creator_hongguo_unavailable', async () => {
    const fixture = await createDramaFixture();
    await fixture.manager.update();
    fixture.setApiStatus(500);
    const error = await fixture.manager.apiFetch('/api/v1/browse-list').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HongguoUpdateError);
    expect((error as HongguoUpdateError).code).toBe('creator_hongguo_unavailable');
    expect((error as HongguoUpdateError).statusCode).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

function fakeManager(overrides: Partial<HongguoComponentManager> = {}): HongguoComponentManager {
  return {
    status: () => ({ installed: true } as never),
    check: vi.fn(),
    update: vi.fn(),
    launch: vi.fn(),
    probeDramaApi: vi.fn(async (): Promise<HongguoDramaApiStatus> => ({
      ready: true, port: 18765, installed: true, running: false, error: null
    })),
    apiFetch: vi.fn(async (pathname: string, options?: Record<string, unknown>) => ({ pathname, options })),
    close: vi.fn(),
    ...overrides
  } as HongguoComponentManager;
}

async function buildApp(manager?: HongguoComponentManager, translator?: DramaTitleTranslator) {
  const app = Fastify();
  await registerCreatorDramaRoutes(app, manager, translator);
  await app.ready();
  return app;
}

describe('creator drama routes', () => {
  it('serves status with component snapshot and api probe', async () => {
    const manager = fakeManager();
    const app = await buildApp(manager);
    const response = await app.inject({ method: 'GET', url: '/creator/drama/status' });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { hongguo: unknown; drama: HongguoDramaApiStatus };
    expect(payload.hongguo).toMatchObject({ installed: true });
    expect(payload.drama).toMatchObject({ ready: true, port: 18765 });
    expect(manager.apiFetch).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards browse and search query strings to the component API', async () => {
    const manager = fakeManager();
    const app = await buildApp(manager);
    const browse = await app.inject({ method: 'GET', url: '/creator/drama/browse?source=hongguo&category=hot-drama&page=3&forceRefresh=true' });
    expect(browse.statusCode).toBe(200);
    expect(manager.apiFetch).toHaveBeenLastCalledWith('/api/v1/browse-list', {
      query: { source: 'hongguo', category: 'hot-drama', page: '3', forceRefresh: 'true' },
      timeoutMs: 150_000
    });

    const search = await app.inject({ method: 'GET', url: `/creator/drama/search?keyword=${encodeURIComponent('总裁')}` });
    expect(search.statusCode).toBe(200);
    expect(manager.apiFetch).toHaveBeenLastCalledWith('/api/v1/search-series', {
      query: { keyword: '总裁' },
      timeoutMs: 150_000
    });
    await app.close();
  });

  it('validates download-batch bodies and proxies valid ones as POST', async () => {
    const manager = fakeManager();
    const app = await buildApp(manager);

    const invalid = await app.inject({ method: 'POST', url: '/creator/drama/download-batch', payload: [1, 2] });
    expect(invalid.statusCode).toBe(400);
    expect(manager.apiFetch).not.toHaveBeenCalled();

    const body = { seriesId: '9', seriesTitle: 'Phim B', episodes: [{ vid: 'v2', vid_index: 2 }] };
    const valid = await app.inject({ method: 'POST', url: '/creator/drama/download-batch', payload: body });
    expect(valid.statusCode).toBe(200);
    expect(manager.apiFetch).toHaveBeenCalledWith('/api/v1/download-batch', { method: 'POST', body });
    await app.close();
  });

  it('maps HongguoUpdateError to api errors and 503 when the manager is absent', async () => {
    const failing = fakeManager({
      apiFetch: vi.fn(async () => {
        throw new HongguoUpdateError('creator_hongguo_unavailable', 'not installed yet', 503);
      })
    });
    const app = await buildApp(failing);
    const failed = await app.inject({ method: 'GET', url: '/creator/drama/categories' });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ error: { code: 'creator_hongguo_unavailable' } });
    await app.close();

    const absent = await buildApp(undefined);
    const response = await absent.inject({ method: 'GET', url: '/creator/drama/status' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'creator_hongguo_unavailable' } });
    await absent.close();
  });

  it('translates drama titles through the injected translator', async () => {
    const translate = vi.fn(async (titles: readonly string[]) => Object.fromEntries(titles.map(title => [title, `vi:${title}`])));
    const app = await buildApp(undefined, { translate } as DramaTitleTranslator);
    const response = await app.inject({
      method: 'POST',
      url: '/creator/drama/translate-titles',
      payload: { titles: ['惊悚', '志怪', 7, null], language: 'vi-VN' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ translations: { 惊悚: 'vi:惊悚', 志怪: 'vi:志怪' } });
    expect(translate).toHaveBeenCalledWith(['惊悚', '志怪'], 'vi');
    await app.close();
  });

  it('rejects malformed title translation bodies', async () => {
    const app = await buildApp(undefined, { translate: vi.fn(async () => ({})) } as DramaTitleTranslator);
    const notAnObject = await app.inject({ method: 'POST', url: '/creator/drama/translate-titles', payload: [1, 2] });
    expect(notAnObject.statusCode).toBe(400);
    const missingTitles = await app.inject({ method: 'POST', url: '/creator/drama/translate-titles', payload: { language: 'vi' } });
    expect(missingTitles.statusCode).toBe(400);
    await app.close();
  });

  it('does not register the translation route without a translator', async () => {
    const app = await buildApp(undefined);
    const response = await app.inject({ method: 'POST', url: '/creator/drama/translate-titles', payload: { titles: ['惊悚'] } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
