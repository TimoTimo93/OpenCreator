import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformConnectionService, type PlatformConnectionOptions } from '../../src/platform-connections/service.js';
import { LoginBrowserCloseError, type BrowserLoginSession } from '../../src/platform-connections/browser-login.js';
import { filterPlatformCookies, hasPlatformSession, serializePlatformCookies, type PlatformCookie } from '../../src/platform-connections/cookies.js';
import type { BrowserProfile } from '../../src/platform-connections/browser.js';
import { registerPlatformConnectionRoutes } from '../../src/api/routes.platform-connections.js';
import { requireAuth } from '../../src/api/auth.js';
import { classifyDouyinChallenge } from '../../src/creator/download/issue-catalog.js';

const cookie: PlatformCookie = {
  name: 's_v_web_id',
  value: 'private-verification-session',
  domain: '.douyin.com',
  path: '/',
  secure: true,
  httpOnly: true,
  expires: 0,
};

const profileA: BrowserProfile = {
  id: 'a'.repeat(24),
  browser: 'chrome',
  label: 'Chrome Profile A',
  directory: '/profiles/a',
  preferred: false,
};

const profileB: BrowserProfile = {
  id: 'b'.repeat(24),
  browser: 'edge',
  label: 'Edge Profile B',
  directory: '/profiles/b',
  preferred: true,
};

const runtime = {
  executable: '/yt-dlp',
  prefixArgs: ['--plugin-dirs', '/plugins'],
  version: 'test',
  env: {},
};

const roots: string[] = [];
const services: PlatformConnectionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupAdversarial(
  platform: 'youtube' | 'douyin' = 'douyin',
  options: Partial<PlatformConnectionOptions> = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'douyin-adv-'));
  roots.push(root);
  const service = new PlatformConnectionService({
    root,
    platform,
    getRuntime: () => runtime,
    osPlatform: options.osPlatform ?? 'win32',
    listProfiles: options.listProfiles ?? (async () => [profileA, profileB]),
    readBrowserCookies: options.readBrowserCookies,
    openLoginBrowser: options.openLoginBrowser,
    ...options,
  });
  services.push(service);
  await service.initialize();
  return { root, service };
}

describe('Adversarial Challenge 1: withCookies() Auto-Discovery and Error Handling', () => {
  it('handles missing credentials when listProfiles returns empty array without crashing', async () => {
    const { root, service } = await setupAdversarial('douyin', {
      listProfiles: async () => [],
    });
    let ran = false;
    const result = await service.withCookies(async () => {
      ran = true;
      return 'unauthenticated-success';
    });
    expect(ran).toBe(true);
    expect(result).toBe('unauthenticated-success');
    expect((await service.getState()).status).toBe('disconnected');
    await expect(access(join(root, 'credentials.json'))).rejects.toThrow();
  });

  it('handles missing credentials when listProfiles throws an unexpected error without crashing', async () => {
    const { root, service } = await setupAdversarial('douyin', {
      listProfiles: async () => {
        throw new Error('EACCES: permission denied to inspect browser profiles');
      },
    });
    let ran = false;
    const result = await service.withCookies(async () => {
      ran = true;
      return 'recovered-after-profile-list-failure';
    });
    expect(ran).toBe(true);
    expect(result).toBe('recovered-after-profile-list-failure');
    expect((await service.getState()).status).toBe('disconnected');
    await expect(access(join(root, 'credentials.json'))).rejects.toThrow();
  });

  it('skips failing or timing-out browser profile and successfully discovers next candidate', async () => {
    const read = vi.fn(async ({ profile }: { profile: BrowserProfile }) => {
      if (profile.id === profileA.id) {
        throw new Error('Timeout or SQLite lock on Profile A');
      }
      return [cookie];
    });

    const { root, service } = await setupAdversarial('douyin', {
      readBrowserCookies: read,
    });

    let authenticatedInContext = false;
    await service.withCookies(async () => {
      const activeRuntime = service.authenticatedRuntime(runtime);
      authenticatedInContext = activeRuntime?.prefixArgs.includes('--cookies') ?? false;
    });

    expect(authenticatedInContext).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect((await service.getState()).status).toBe('connected');
    const saved = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8'));
    expect(saved.profileId).toBe(profileB.id);
    expect(saved.cookies).toEqual([cookie]);
  });

  it('prefers portable Chrome over regular profiles when Network/Cookies is present', async () => {
    const { root, service } = await setupAdversarial('douyin', {
      readBrowserCookies: vi.fn(async ({ profile }: { profile: BrowserProfile }) => {
        if (profile.id === 'managed-douyin-chrome') {
          return [{ ...cookie, value: 'portable-chrome-session' }];
        }
        return [{ ...cookie, value: 'regular-profile-session' }];
      }),
    });

    // Create portable Chrome cookies file
    const portableDefault = join(root, 'browser-chrome', 'Default');
    const networkDir = join(portableDefault, 'Network');
    await mkdir(networkDir, { recursive: true });
    await writeFile(join(networkDir, 'Cookies'), 'dummy-sqlite-cookies-file');

    await service.withCookies(async () => {
      const activeRuntime = service.authenticatedRuntime(runtime);
      expect(activeRuntime?.prefixArgs).toContain('--cookies');
    });

    const saved = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8'));
    expect(saved.profileId).toBe('managed-douyin-chrome');
    expect(saved.cookies[0].value).toBe('portable-chrome-session');
    expect(saved.browser).toBe('chrome');
  });

  it('safely skips portable Chrome directory if Cookies file is missing', async () => {
    const { root, service } = await setupAdversarial('douyin', {
      readBrowserCookies: vi.fn(async ({ profile }: { profile: BrowserProfile }) => {
        return [cookie];
      }),
    });

    // Create directory without Cookies file
    const portableDefault = join(root, 'browser-chrome', 'Default');
    await mkdir(portableDefault, { recursive: true });

    await service.withCookies(async () => {
      const activeRuntime = service.authenticatedRuntime(runtime);
      expect(activeRuntime?.prefixArgs).toContain('--cookies');
    });

    const saved = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8'));
    // Fell back to profileA
    expect(saved.profileId).toBe(profileA.id);
  });

  it('handles concurrent withCookies() calls cleanly when credentials.json does not exist initially', async () => {
    const read = vi.fn(async () => [cookie]);
    const { root, service } = await setupAdversarial('douyin', {
      readBrowserCookies: read,
    });

    const results = await Promise.all([
      service.withCookies(async () => 'worker-1'),
      service.withCookies(async () => 'worker-2'),
      service.withCookies(async () => 'worker-3'),
      service.withCookies(async () => 'worker-4'),
      service.withCookies(async () => 'worker-5'),
    ]);

    expect(results).toEqual(['worker-1', 'worker-2', 'worker-3', 'worker-4', 'worker-5']);
    expect((await service.getState()).status).toBe('connected');
    const saved = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8'));
    expect(saved.cookies).toEqual([cookie]);
  });

  it('cleans up task-* directory even when operation throws an exception', async () => {
    const { root, service } = await setupAdversarial('douyin');
    await service.importCookies(serializePlatformCookies([cookie], 'douyin'));

    let taskDir = '';
    await expect(
      service.withCookies(async () => {
        const cookiePath = service.authenticatedRuntime(runtime)!.prefixArgs.at(-1)!;
        taskDir = join(cookiePath, '..');
        expect(await stat(taskDir)).toBeDefined();
        throw new Error('Fatal operation crash inside withCookies');
      })
    ).rejects.toThrow('Fatal operation crash inside withCookies');

    expect(taskDir).not.toBe('');
    await expect(access(taskDir)).rejects.toThrow();
  });

  it('does NOT run Douyin auto-discovery when platform is youtube', async () => {
    const listProfiles = vi.fn(async () => [profileA]);
    const { root, service } = await setupAdversarial('youtube', {
      listProfiles,
    });

    let ran = false;
    await service.withCookies(async () => {
      ran = true;
      expect(service.authenticatedRuntime(runtime)).toBe(runtime);
    });

    expect(ran).toBe(true);
    expect(listProfiles).not.toHaveBeenCalled();
    await expect(access(join(root, 'credentials.json'))).rejects.toThrow();
  });
});

describe('Adversarial Challenge 2: Windows Managed Login Endpoint /platform-connections/douyin/complete-login', () => {
  it('returns 401 when request is unauthorized', async () => {
    const { service } = await setupAdversarial('douyin');
    const { service: ytService } = await setupAdversarial('youtube');
    const server = Fastify();
    server.addHook('onRequest', requireAuth('secret-token'));
    await registerPlatformConnectionRoutes(server, ytService, service);

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/platform-connections/douyin/complete-login',
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('returns 200 with public state when called with no active login attempt', async () => {
    const { service } = await setupAdversarial('douyin');
    const { service: ytService } = await setupAdversarial('youtube');
    const server = Fastify();
    server.addHook('onRequest', requireAuth('secret-token'));
    await registerPlatformConnectionRoutes(server, ytService, service);

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/platform-connections/douyin/complete-login',
        headers: { authorization: 'Bearer secret-token' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({
        platform: 'douyin',
        status: 'disconnected',
        connectionMethod: 'browser-login',
      });
    } finally {
      await server.close();
    }
  });

  it('completes managed login via POST /platform-connections/douyin/complete-login', async () => {
    let exitWatcher!: () => void;
    const session: BrowserLoginSession = {
      profile: { ...profileA, directory: '/managed/Default' },
      exited: new Promise<void>((resolve) => {
        exitWatcher = resolve;
      }),
      close: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const read = vi.fn(async () => [cookie]);
    const { service } = await setupAdversarial('douyin', {
      readBrowserCookies: read,
      openLoginBrowser: vi.fn(async () => session),
      osPlatform: 'win32',
    });
    const { service: ytService } = await setupAdversarial('youtube');

    const server = Fastify();
    server.addHook('onRequest', requireAuth('secret-token'));
    await registerPlatformConnectionRoutes(server, ytService, service);

    try {
      const headers = { authorization: 'Bearer secret-token' };

      // Initiate connection
      const connectRes = await server.inject({
        method: 'POST',
        url: '/platform-connections/douyin/connect',
        headers,
      });
      expect(connectRes.statusCode).toBe(200);

      await vi.waitFor(async () => {
        const state = await service.getState();
        expect(state.actionRequired).toBe('complete-login');
      });

      // Complete login via API
      const completeRes = await server.inject({
        method: 'POST',
        url: '/platform-connections/douyin/complete-login',
        headers,
      });
      expect(completeRes.statusCode).toBe(200);
      expect(completeRes.headers['cache-control']).toBe('no-store');

      await vi.waitFor(async () => {
        const state = await service.getState();
        expect(state.status).toBe('connected');
      });

      expect(session.close).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(expect.objectContaining({ platform: 'douyin' }));
    } finally {
      await server.close();
    }
  });

  it('handles LoginBrowserCloseError gracefully and allows subsequent completion after browser is closed', async () => {
    let closeAttempts = 0;
    const session: BrowserLoginSession = {
      profile: { ...profileA, directory: '/managed/Default' },
      exited: new Promise<void>(() => {}),
      close: vi.fn(async () => {
        closeAttempts++;
        if (closeAttempts === 1) {
          throw new LoginBrowserCloseError('douyin');
        }
      }),
      dispose: vi.fn(async () => {}),
    };

    const read = vi.fn(async () => [cookie]);
    const { service } = await setupAdversarial('douyin', {
      readBrowserCookies: read,
      openLoginBrowser: vi.fn(async () => session),
      osPlatform: 'win32',
    });
    const { service: ytService } = await setupAdversarial('youtube');

    const server = Fastify();
    server.addHook('onRequest', requireAuth('secret-token'));
    await registerPlatformConnectionRoutes(server, ytService, service);

    try {
      const headers = { authorization: 'Bearer secret-token' };
      await server.inject({ method: 'POST', url: '/platform-connections/douyin/connect', headers });

      await vi.waitFor(async () => {
        expect((await service.getState()).actionRequired).toBe('complete-login');
      });

      // First completeLogin triggers LoginBrowserCloseError
      await server.inject({ method: 'POST', url: '/platform-connections/douyin/complete-login', headers });

      await vi.waitFor(async () => {
        const state = await service.getState();
        expect(state.actionRequired).toBe('close-login-browser');
        expect(state.message).toContain('Close the Douyin verification window');
      });

      // Second completeLogin succeeds
      await server.inject({ method: 'POST', url: '/platform-connections/douyin/complete-login', headers });

      await vi.waitFor(async () => {
        const state = await service.getState();
        expect(state.status).toBe('connected');
      });

      expect(closeAttempts).toBe(2);
    } finally {
      await server.close();
    }
  });
});

describe('Adversarial Challenge 3: classifyDouyinChallenge & classifyDownloadError on Edge Cases', () => {
  it('returns undefined for empty string or non-douyin error strings', () => {
    expect(classifyDouyinChallenge('')).toBeUndefined();
    expect(classifyDouyinChallenge(' ')).toBeUndefined();
    expect(classifyDouyinChallenge('HTTP Error 403: Forbidden on youtube')).toBeUndefined();
    expect(classifyDouyinChallenge('ERROR: Video unavailable on bilibili')).toBeUndefined();
  });

  it('matches Douyin challenges case-insensitively with extractor variants', () => {
    const variants = [
      '[douyin] Blocked by ArgusSecurityPlugin Validate Error',
      '[DouYin] BLOCKED BY ARGUSSECURITYPLUGIN VALIDATE ERROR',
      '[DOUYIN+custom] website verification is required',
      '[douyin+opencreator] slider captcha detected',
      'douyin.com returned: captcha required',
    ];

    for (const msg of variants) {
      const fact = classifyDouyinChallenge(msg);
      expect(fact).toBeDefined();
      expect(fact?.code).toBe('platform_session_required');
      expect(fact?.kind).toBe('unauthorized');
    }
  });

  it('extracts custom HTTP status code when present or defaults to 403', () => {
    const with401 = classifyDouyinChallenge('[douyin] HTTP Error 401: website verification required');
    expect(with401?.httpStatus).toBe(401);

    const with429 = classifyDouyinChallenge('[douyin] HTTP Error 429: captcha challenge');
    expect(with429?.httpStatus).toBe(429);

    const default403 = classifyDouyinChallenge('[douyin] website verification required');
    expect(default403?.httpStatus).toBe(403);
  });

  it('prioritizes unsupported signature requirement over generic session requirement', () => {
    const signatureError = '[douyin] Douyin request signature is required (HTTP Error 403; Signature Not Found)';
    const fact = classifyDouyinChallenge(signatureError);
    expect(fact).toEqual({
      code: 'platform_request_signature_required',
      message: expect.stringContaining('required browser request signature is not supported'),
      kind: 'unsupported',
      httpStatus: 403,
    });
  });

  it('maps rejection guidance and fresh cookies requests to platform_session_required', () => {
    const rejectedFact = classifyDouyinChallenge('[douyin] Douyin browser identity was rejected (HTTP Error 403; Uifid Not Found)');
    expect(rejectedFact).toMatchObject({
      code: 'platform_session_required',
      kind: 'unauthorized',
      httpStatus: 403,
    });

    const freshCookiesFact = classifyDouyinChallenge('[douyin] Fresh cookies are needed');
    expect(freshCookiesFact).toMatchObject({
      code: 'platform_session_required',
      kind: 'unauthorized',
    });
  });

  it('survives very large stderr text buffers with buried douyin challenges without performance breakdown', () => {
    const filler = 'Random debug log output line 12345\n'.repeat(25000); // ~900KB
    const largeStderr = `${filler}[Douyin] Blocked by ArgusSecurityPlugin Validate Error\n${filler}`;
    const start = performance.now();
    const fact = classifyDouyinChallenge(largeStderr);
    const duration = performance.now() - start;

    expect(fact).toBeDefined();
    expect(fact?.code).toBe('platform_session_required');
    expect(duration).toBeLessThan(100); // Must resolve in < 100ms
  });
});

describe('Adversarial Challenge 4: C:\\ Drive Isolation Verification', () => {
  it('ensures all temporary directories and credentials reside strictly under D:\\', async () => {
    const { root, service } = await setupAdversarial('douyin');
    await service.importCookies(serializePlatformCookies([cookie], 'douyin'));

    expect(root.startsWith('D:\\') || !root.startsWith('C:\\')).toBe(true);
    await service.withCookies(async () => {
      const activeRuntime = service.authenticatedRuntime(runtime);
      const cookieFilePath = activeRuntime!.prefixArgs.at(-1)!;
      expect(cookieFilePath.toLowerCase().startsWith('c:\\')).toBe(false);
      expect(cookieFilePath.toLowerCase().startsWith('d:\\')).toBe(true);
    });
  });
});
