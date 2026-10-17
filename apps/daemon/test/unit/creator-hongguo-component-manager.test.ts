import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareVersions,
  createHongguoComponentManager,
  HongguoUpdateError,
  type HongguoComponentManager,
  type HongguoComponentManagerDeps,
  type HongguoSpawnedProcess
} from '../../src/creator/hongguo/manager.js';

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

type Fixture = {
  manager: HongguoComponentManager;
  manifestFetches: () => number;
  spawnCalls: Array<{ exePath: string; env: NodeJS.ProcessEnv }>;
  killedPids: number[];
  setAlive: (value: boolean) => void;
  manifest: Record<string, unknown>;
};

async function createFixture(options: { configureChannel?: boolean; sha?: string } = {}): Promise<Fixture> {
  root = await mkdtemp(join(tmpdir(), 'creator-hongguo-'));
  if (options.configureChannel !== false) {
    process.env.OPENCREATOR_HONGGUO_UPDATE_MANIFEST_URL = CHANNEL_URL;
  }
  const manifest: Record<string, unknown> = {
    version: '1.74.0',
    viRevision: 1,
    artifact: 'HongguoDrama-1.74.0-vi.1-win-x64.zip',
    sha256: options.sha ?? ARTIFACT_SHA,
    bytes: ARTIFACT_BYTES.byteLength,
    upstream: 'jackotom/hongguo-drama',
    launch: { exe: EXE_NAME }
  };
  let manifestFetches = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === CHANNEL_URL) {
      manifestFetches += 1;
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url === ARTIFACT_URL) {
      return new Response(ARTIFACT_BYTES, { status: 200 });
    }
    // Cổng loopback: thành phần Hồng Quả đang chạy (nếu có) trả lời như thật.
    if (url.startsWith('http://127.0.0.1:')) {
      return new Response(JSON.stringify({ ok: true, name: 'hongguo-drama-api' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  const spawnCalls: Array<{ exePath: string; env: NodeJS.ProcessEnv }> = [];
  const killedPids: number[] = [];
  let alive = true;
  const deps: HongguoComponentManagerDeps = {
    fetchImpl,
    extractArchive: async (zipPath, destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, EXE_NAME), 'MZ fake portable');
      await writeFile(join(destination, 'artifact-source.txt'), zipPath);
    },
    spawnProcess: (exePath, env): HongguoSpawnedProcess => {
      spawnCalls.push({ exePath, env });
      return {
        pid: 4242,
        onExit: () => undefined,
        onError: () => undefined
      };
    },
    isProcessAlive: () => alive,
    killProcessTree: pid => { killedPids.push(pid); }
  };
  const manager = await createHongguoComponentManager({ root }, deps);
  return {
    manager,
    manifestFetches: () => manifestFetches,
    spawnCalls,
    killedPids,
    setAlive: value => { alive = value; },
    manifest
  };
}

describe('hongguo component manager', () => {
  it('reports an unconfigured channel without touching the network', async () => {
    const fixture = await createFixture({ configureChannel: false });
    const initial = fixture.manager.status();
    expect(initial.channelConfigured).toBe(false);
    expect(initial.installed).toBe(false);
    expect(initial.updateAvailable).toBe(false);
    expect(initial.checkDue).toBe(false);
    const checked = await fixture.manager.check({ force: true });
    expect(checked.channelConfigured).toBe(false);
    expect(fixture.manifestFetches()).toBe(0);
  });

  it('checks the channel, detects a newer build, and caches the check', async () => {
    const fixture = await createFixture();
    const checked = await fixture.manager.check({ force: true });
    expect(checked.channelConfigured).toBe(true);
    expect(checked.latestVersion).toBe('1.74.0');
    expect(checked.latestViRevision).toBe(1);
    expect(checked.updateAvailable).toBe(true);
    expect(checked.installed).toBe(false);
    expect(checked.lastCheckedAt).not.toBeNull();
    expect(fixture.manifestFetches()).toBe(1);

    const cached = await fixture.manager.check({ force: false });
    expect(cached.latestVersion).toBe('1.74.0');
    expect(fixture.manifestFetches()).toBe(1);
  });

  it('downloads, verifies, installs, and cleans up staging', async () => {
    const fixture = await createFixture();
    const installed = await fixture.manager.update();
    expect(installed.installed).toBe(true);
    expect(installed.currentVersion).toBe('1.74.0');
    expect(installed.currentViRevision).toBe(1);
    expect(installed.updateAvailable).toBe(false);
    expect(installed.phase).toBe('idle');
    expect(installed.downloadProgress).toBeNull();
    expect(installed.error).toBeNull();

    const versionDir = join(root, 'versions', '1.74.0-vi.1');
    const entries = await readdir(versionDir);
    expect(entries).toContain(EXE_NAME);

    const stagingEntries = await readdir(join(root, 'staging'));
    expect(stagingEntries).toHaveLength(0);

    const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as {
      schema: number;
      active?: { version: string; exe: string };
    };
    expect(state.schema).toBe(1);
    expect(state.active?.version).toBe('1.74.0');
    expect(state.active?.exe).toBe(EXE_NAME);
  });

  it('rejects a corrupted artifact and keeps the component uninstalled', async () => {
    const fixture = await createFixture({
      sha: createHash('sha256').update('something else').digest('hex')
    });
    await expect(fixture.manager.update()).rejects.toThrow(HongguoUpdateError);
    const status = fixture.manager.status();
    expect(status.installed).toBe(false);
    expect(status.phase).toBe('idle');
    expect(status.error).toContain('sha256');
  });

  it('launches the GUI with host-isolated data directories', async () => {
    const fixture = await createFixture();
    await fixture.manager.update();
    const launched = await fixture.manager.launch();
    expect(launched.running).toBe(true);
    expect(launched.runningPid).toBe(4242);
    expect(fixture.spawnCalls).toHaveLength(1);
    const call = fixture.spawnCalls[0]!;
    expect(call.exePath.replaceAll('\\', '/')).toContain('versions/1.74.0-vi.1/');
    expect(call.env.HONGGUO_USER_DATA_DIR).toBe(join(root, 'user-data'));
    expect(call.env.HONGGUO_DOWNLOAD_DIR).toBe(join(root, 'downloads'));

    fixture.setAlive(false);
    expect(fixture.manager.status().running).toBe(false);
  });

  it('adopts the component left by a previous run and stops its tree on close', async () => {
    const fixture = await createFixture();
    await fixture.manager.update();
    await mkdir(join(root, 'user-data'), { recursive: true });
    await writeFile(
      join(root, 'user-data', 'drama-api.json'),
      JSON.stringify({ port: 61234, token: 'adopted-token-1234', pid: 9090, version: '1.74.0' })
    );

    const payload = await fixture.manager.apiFetch('/api/v1/browse-categories');
    expect(payload).toMatchObject({ ok: true });
    // Đã dùng lại tiến trình cũ: không spawn thêm bản Hồng Quả thứ hai.
    expect(fixture.spawnCalls).toHaveLength(0);

    fixture.manager.close();
    expect(fixture.killedPids).toEqual([9090]);
    await vi.waitFor(async () => {
      await expect(readFile(join(root, 'user-data', 'drama-api.json'), 'utf8')).rejects.toThrow();
    });
  });

  it('stops the launched component tree when the host closes', async () => {
    const fixture = await createFixture();
    await fixture.manager.update();
    await fixture.manager.launch();
    fixture.manager.close();
    expect(fixture.killedPids).toEqual([4242]);
  });

  it('keeps the previous version when a newer vi revision arrives', async () => {
    const fixture = await createFixture();
    await fixture.manager.update();
    fixture.manifest.viRevision = 2;
    const updated = await fixture.manager.update();
    expect(updated.currentViRevision).toBe(2);
    expect(updated.installed).toBe(true);

    const versionDirs = await readdir(join(root, 'versions'));
    expect(versionDirs).toContain('1.74.0-vi.1');
    expect(versionDirs).toContain('1.74.0-vi.2');
    expect(versionDirs).toHaveLength(2);
  });

  it('refuses to launch before installation', async () => {
    const fixture = await createFixture();
    await expect(fixture.manager.launch()).rejects.toThrow(HongguoUpdateError);
  });
});

describe('compareVersions', () => {
  it('orders numeric releases and treats missing segments as zero', () => {
    expect(compareVersions('1.74.0', '1.73.0')).toBeGreaterThan(0);
    expect(compareVersions('1.73.0', '1.74.0')).toBeLessThan(0);
    expect(compareVersions('1.74', '1.74.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });
});
