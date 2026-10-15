import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { z } from 'zod';
import type { HongguoComponentStatus, RuntimeErrorCode } from '@opencreator/protocol';
import {
  readPrivateJsonFile,
  writePrivateJsonFile
} from '../../config/private-json-file.js';
import { fetchCreatorService } from '../../creator-services/upstream-fetch.js';

/**
 * Hongguo ("Phim ngắn Hồng Quả") third-party component manager.
 *
 * Follows the yt-dlp update-manager pattern (pinned manifest channel -> staged
 * download -> sha256 verify -> atomic swap of versions/<key>/), extended with
 * a GUI launcher that isolates all component data under
 * <OPENCREATOR_HOME>/runtime/hongguo-drama/ through the HONGGUO_USER_DATA_DIR
 * and HONGGUO_DOWNLOAD_DIR environment variables.
 *
 * The update channel ALWAYS points at the fork's release manifest (Vietnamese
 * builds produced by scripts/build-component-zip.cjs) - never at the upstream
 * repository - so an update can never lose the Vietnamese UI or features.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const CHECK_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const USER_AGENT = 'OpenCreator-Hongguo-Component/1';

const manifestSchema = z.object({
  version: z.string().regex(/^\d+(\.\d+){1,3}/, 'version must be numeric'),
  viRevision: z.number().int().positive(),
  artifact: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  bytes: z.number().int().positive().optional(),
  url: z.string().optional(),
  upstream: z.string().optional(),
  launch: z.object({ exe: z.string().min(1) }).optional()
});

type HongguoManifest = z.infer<typeof manifestSchema>;

type InstalledVersion = {
  version: string;
  viRevision: number;
  artifact: string;
  sha256: string;
  /** Executable path relative to versions/<key>/ (may contain CJK characters). */
  exe: string;
  installedAt: string;
};

type ChannelLatest = {
  version: string;
  viRevision: number;
  artifact: string;
  sha256: string;
  bytes: number | null;
  url: string;
  exe: string | null;
  upstream: string | null;
};

type HongguoState = {
  schema: 1;
  active?: InstalledVersion;
  previous?: InstalledVersion;
  latest?: ChannelLatest;
  lastCheckedAt?: string;
  lastCheckAttemptAt?: string;
};

export class HongguoUpdateError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly statusCode: number = 500
  ) {
    super(message);
    this.name = 'HongguoUpdateError';
  }
}

export type HongguoSpawnedProcess = {
  pid: number | undefined;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
};

export type HongguoComponentManagerDeps = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Resolve the proxy configured in Creator services (may be async). */
  proxy?: () => Promise<string | undefined> | string | undefined;
  /** Overridable archive extraction (default: PowerShell Expand-Archive). */
  extractArchive?: (zipPath: string, destination: string) => Promise<void>;
  /** Overridable GUI launcher (default: detached spawn). */
  spawnProcess?: (exePath: string, env: NodeJS.ProcessEnv) => HongguoSpawnedProcess;
  isProcessAlive?: (pid: number) => boolean;
};

export type HongguoComponentManager = {
  status(): HongguoComponentStatus;
  check(input: { force: boolean }): Promise<HongguoComponentStatus>;
  update(): Promise<HongguoComponentStatus>;
  launch(): Promise<HongguoComponentStatus>;
  close(): void;
};

export async function createHongguoComponentManager(
  input: { root: string },
  deps: HongguoComponentManagerDeps = {}
): Promise<HongguoComponentManager> {
  const rootDir = input.root;
  const statePath = join(rootDir, 'state.json');
  const versionsDir = join(rootDir, 'versions');
  const stagingDir = join(rootDir, 'staging');
  const channelFilePath = join(rootDir, 'channel.json');
  const dataRoot = join(rootDir, 'user-data');
  const downloadsRoot = join(rootDir, 'downloads');

  const now = deps.now ?? (() => new Date());
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const extractArchive = deps.extractArchive ?? defaultExtractArchive;
  const spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;

  await mkdir(versionsDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });

  let state = await loadState(statePath);
  let cachedChannel = await resolveChannel(channelFilePath);
  let phase: HongguoComponentStatus['phase'] = 'idle';
  let downloadProgress: HongguoComponentDownloadProgressState = null;
  let runningPid: number | null = null;
  let abortController: AbortController | null = null;
  let fatalError: string | null = null;

  const persist = () => writePrivateJsonFile(statePath, state);

  const refreshRunning = () => {
    if (runningPid !== null && !isProcessAlive(runningPid)) runningPid = null;
  };

  const status = (): HongguoComponentStatus => {
    refreshRunning();
    const active = state.active;
    const latest = state.latest;
    const checkedAt = state.lastCheckedAt === undefined ? null : Date.parse(state.lastCheckedAt);
    const current = now().getTime();
    return {
      installed: active !== undefined,
      currentVersion: active?.version ?? null,
      currentViRevision: active?.viRevision ?? null,
      latestVersion: latest?.version ?? null,
      latestViRevision: latest?.viRevision ?? null,
      updateAvailable: latest !== undefined
        ? active === undefined || isNewer(latest, active)
        : false,
      checkDue: cachedChannel !== null
        && (checkedAt === null || Number.isNaN(checkedAt) || current - checkedAt >= CHECK_INTERVAL_MS),
      channelConfigured: cachedChannel !== null,
      channelUrl: cachedChannel,
      phase,
      downloadProgress,
      lastCheckedAt: state.lastCheckedAt ?? null,
      lastCheckAttemptAt: state.lastCheckAttemptAt ?? null,
      installedAt: active?.installedAt ?? null,
      running: runningPid !== null,
      runningPid,
      dataRoot,
      downloadsRoot,
      error: fatalError
    };
  };

  const ensureIdle = () => {
    if (phase !== 'idle') {
      throw new HongguoUpdateError(
        'creator_hongguo_update_failed',
        'Another Hongguo component operation is already running',
        409
      );
    }
  };

  const fetchManifest = async (channelUrl: string): Promise<HongguoManifest> => {
    const endpoint = parseChannelUrl(channelUrl);
    const proxy = await deps.proxy?.();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const response = await fetchCreatorService({
        endpoint,
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        ...(proxy === undefined || proxy === '' ? {} : { proxy }),
        signal: controller.signal,
        maxResponseBytes: MAX_MANIFEST_BYTES,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl })
      });
      if (!response.ok) {
        throw new Error(`manifest request failed with status ${response.status}`);
      }
      const payload: unknown = JSON.parse(await response.text());
      const parsed = manifestSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`manifest is invalid: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  };

  const toChannelLatest = (manifest: HongguoManifest, channelUrl: string): ChannelLatest => {
    const url = manifest.url !== undefined && manifest.url !== ''
      ? parseChannelUrl(manifest.url).toString()
      : new URL(manifest.artifact, parseChannelUrl(channelUrl)).toString();
    return {
      version: manifest.version,
      viRevision: manifest.viRevision,
      artifact: manifest.artifact,
      sha256: manifest.sha256,
      bytes: manifest.bytes ?? null,
      url,
      exe: manifest.launch?.exe ?? null,
      upstream: manifest.upstream ?? null
    };
  };

  const check = async (input: { force: boolean }): Promise<HongguoComponentStatus> => {
    ensureIdle();
    cachedChannel = await resolveChannel(channelFilePath);
    if (cachedChannel === null) return status();
    const checkedAt = state.lastCheckedAt === undefined ? 0 : Date.parse(state.lastCheckedAt);
    if (
      !input.force
      && state.latest !== undefined
      && !Number.isNaN(checkedAt)
      && now().getTime() - checkedAt < CHECK_INTERVAL_MS
    ) {
      return status();
    }
    phase = 'checking';
    state.lastCheckAttemptAt = now().toISOString();
    try {
      const manifest = await fetchManifest(cachedChannel);
      state.latest = toChannelLatest(manifest, cachedChannel);
      state.lastCheckedAt = now().toISOString();
      fatalError = null;
      await persist();
      return status();
    } catch (error) {
      fatalError = messageOf(error);
      await persist().catch(() => undefined);
      throw new HongguoUpdateError('creator_hongguo_check_failed', fatalError, 502);
    } finally {
      phase = 'idle';
    }
  };

  const update = async (): Promise<HongguoComponentStatus> => {
    ensureIdle();
    cachedChannel = await resolveChannel(channelFilePath);
    if (cachedChannel === null) {
      throw new HongguoUpdateError(
        'creator_hongguo_update_failed',
        'The Hongguo update channel is not configured',
        400
      );
    }
    phase = 'checking';
    state.lastCheckAttemptAt = now().toISOString();
    let latest: ChannelLatest;
    try {
      const manifest = await fetchManifest(cachedChannel);
      latest = toChannelLatest(manifest, cachedChannel);
      state.latest = latest;
      state.lastCheckedAt = now().toISOString();
      await persist();
    } catch (error) {
      phase = 'idle';
      fatalError = messageOf(error);
      await persist().catch(() => undefined);
      throw new HongguoUpdateError('creator_hongguo_check_failed', fatalError, 502);
    }

    if (state.active !== undefined && !isNewer(latest, state.active)) {
      phase = 'idle';
      fatalError = null;
      return status();
    }

    const stagingRoot = join(stagingDir, randomUUID());
    try {
      await downloadArtifact(latest, stagingRoot);
      await verifyArtifact(latest, join(stagingRoot, 'artifact.zip'));
      const extractDir = join(stagingRoot, 'extract');
      const exePath = await extractArtifact(latest, extractDir, join(stagingRoot, 'artifact.zip'));
      await applyArtifact(latest, extractDir, exePath);
      fatalError = null;
      await persist();
      await pruneVersions();
      phase = 'idle';
      downloadProgress = null;
      return status();
    } catch (error) {
      fatalError = messageOf(error);
      await persist().catch(() => undefined);
      throw new HongguoUpdateError('creator_hongguo_update_failed', fatalError, 502);
    } finally {
      phase = 'idle';
      downloadProgress = null;
      abortController = null;
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const downloadArtifact = async (latest: ChannelLatest, stagingRoot: string): Promise<void> => {
    phase = 'downloading';
    downloadProgress = {
      downloadedBytes: 0,
      totalBytes: latest.bytes,
      percent: latest.bytes === null ? null : 0
    };
    const controller = new AbortController();
    abortController = controller;
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const proxy = await deps.proxy?.();
    try {
      const endpoint = parseChannelUrl(latest.url);
      const response = await fetchCreatorService({
        endpoint,
        method: 'GET',
        headers: { accept: 'application/zip, application/octet-stream', 'user-agent': USER_AGENT },
        ...(proxy === undefined || proxy === '' ? {} : { proxy }),
        signal: controller.signal,
        maxResponseBytes: MAX_ARTIFACT_BYTES,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl })
      });
      if (!response.ok) {
        throw new Error(`artifact download failed with status ${response.status}`);
      }
      const body = response.body;
      if (body === null) throw new Error('artifact response has no body');
      await mkdir(stagingRoot, { recursive: true });
      const target = join(stagingRoot, 'artifact.zip');
      const handle = await open(target, 'w');
      try {
        let received = 0;
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
          received += chunk.byteLength;
          if (received > MAX_ARTIFACT_BYTES) {
            throw new Error('artifact exceeds the maximum allowed size');
          }
          await handle.write(chunk);
          downloadProgress = {
            downloadedBytes: received,
            totalBytes: latest.bytes,
            percent: latest.bytes === null
              ? null
              : Math.min(100, Math.floor((received / latest.bytes) * 100))
          };
        }
        if (received === 0) throw new Error('artifact download is empty');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('artifact download timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      abortController = null;
    }
  };

  const verifyArtifact = async (latest: ChannelLatest, artifactPath: string): Promise<void> => {
    phase = 'verifying';
    const digest = await sha256File(artifactPath);
    if (digest !== latest.sha256.toLowerCase()) {
      throw new Error(`artifact sha256 verification failed (expected ${latest.sha256}, got ${digest})`);
    }
  };

  const extractArtifact = async (
    latest: ChannelLatest,
    extractDir: string,
    artifactPath: string
  ): Promise<string> => {
    phase = 'extracting';
    if (latest.exe === null) {
      throw new Error('manifest does not declare launch.exe');
    }
    await mkdir(extractDir, { recursive: true });
    await extractArchive(artifactPath, extractDir);
    const resolved = await locateExecutable(extractDir, latest.exe);
    if (resolved === null) {
      throw new Error(`executable ${latest.exe} was not found inside the artifact`);
    }
    return resolved;
  };

  const applyArtifact = async (latest: ChannelLatest, extractDir: string, exePath: string): Promise<void> => {
    phase = 'applying';
    const key = versionKey(latest.version, latest.viRevision);
    const targetDir = join(versionsDir, key);
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
    for (const entry of await readdir(extractDir)) {
      await rename(join(extractDir, entry), join(targetDir, entry));
    }
    const installed: InstalledVersion = {
      version: latest.version,
      viRevision: latest.viRevision,
      artifact: latest.artifact,
      sha256: latest.sha256,
      exe: relative(extractDir, exePath).replaceAll('\\', '/'),
      installedAt: now().toISOString()
    };
    state.previous = state.active;
    state.active = installed;
    fatalError = null;
  };

  const pruneVersions = async () => {
    const keep = new Set<string>();
    if (state.active !== undefined) keep.add(versionKey(state.active.version, state.active.viRevision));
    if (state.previous !== undefined) keep.add(versionKey(state.previous.version, state.previous.viRevision));
    let entries: string[];
    try {
      entries = await readdir(versionsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (keep.has(entry)) continue;
      await rm(join(versionsDir, entry), { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const launch = async (): Promise<HongguoComponentStatus> => {
    ensureIdle();
    const active = state.active;
    if (active === undefined) {
      throw new HongguoUpdateError('creator_hongguo_launch_failed', 'Hongguo is not installed yet', 400);
    }
    refreshRunning();
    if (runningPid !== null) return status();
    const exePath = join(versionsDir, versionKey(active.version, active.viRevision), active.exe);
    phase = 'launching';
    try {
      await mkdir(dataRoot, { recursive: true });
      await mkdir(downloadsRoot, { recursive: true });
      const proc = spawnProcess(exePath, {
        ...process.env,
        HONGGUO_USER_DATA_DIR: dataRoot,
        HONGGUO_DOWNLOAD_DIR: downloadsRoot
      });
      proc.onExit(code => {
        runningPid = null;
        phase = 'idle';
        // Exit code 0 right after spawn means the single-instance lock handed
        // focus to an already running window; only surface real failures.
        if (code !== null && code !== 0) {
          fatalError = `Hongguo exited with code ${code}`;
        }
      });
      proc.onError(error => {
        runningPid = null;
        phase = 'idle';
        fatalError = messageOf(error);
      });
      runningPid = proc.pid ?? null;
      return status();
    } catch (error) {
      fatalError = messageOf(error);
      throw new HongguoUpdateError('creator_hongguo_launch_failed', fatalError, 500);
    } finally {
      if (phase === 'launching') phase = 'idle';
    }
  };

  const close = () => {
    // Abort in-flight downloads. The launched GUI is deliberately left running:
    // it is a user-facing application, not a daemon-owned background task.
    abortController?.abort();
    abortController = null;
  };

  return { status, check, update, launch, close };
}

type HongguoComponentDownloadProgressState = HongguoComponentStatus['downloadProgress'];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function versionKey(version: string, viRevision: number): string {
  return `${version}-vi.${viRevision}`;
}

function isNewer(candidate: ChannelLatest | InstalledVersion, against: ChannelLatest | InstalledVersion): boolean {
  const order = compareVersions(candidate.version, against.version);
  if (order !== 0) return order > 0;
  return candidate.viRevision > against.viRevision;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(segment => Number.parseInt(segment, 10));
  const b = right.split('.').map(segment => Number.parseInt(segment, 10));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const leftPart = Number.isFinite(a[index]) ? (a[index] ?? 0) : 0;
    const rightPart = Number.isFinite(b[index]) ? (b[index] ?? 0) : 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

async function loadState(statePath: string): Promise<HongguoState> {
  try {
    const raw = await readPrivateJsonFile(statePath);
    if (
      typeof raw === 'object'
      && raw !== null
      && 'schema' in raw
      && (raw as { schema?: unknown }).schema === 1
    ) {
      return raw as HongguoState;
    }
  } catch {
    // Corrupted state falls back to a fresh install view.
  }
  return { schema: 1 };
}

async function resolveChannel(channelFilePath: string): Promise<string | null> {
  const fromEnv = process.env.OPENCREATOR_HONGGUO_UPDATE_MANIFEST_URL?.trim();
  let raw = fromEnv === undefined || fromEnv === '' ? undefined : fromEnv;
  if (raw === undefined) {
    try {
      const { readFile } = await import('node:fs/promises');
      const text = await readFile(channelFilePath, 'utf8');
      const payload: unknown = JSON.parse(text);
      if (typeof payload === 'string') raw = payload.trim();
      else if (typeof payload === 'object' && payload !== null && 'url' in payload) {
        const url = (payload as { url?: unknown }).url;
        if (typeof url === 'string') raw = url.trim();
      }
    } catch {
      return null;
    }
  }
  if (raw === undefined || raw === '') return null;
  return isValidChannelUrl(raw) ? raw : null;
}

function parseChannelUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid update channel URL: ${value}`);
  }
  if (!isValidChannelUrl(value)) {
    throw new Error(`update channel URL must use https (or local http): ${value}`);
  }
  return url;
}

function isValidChannelUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  }
  return false;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function locateExecutable(extractDir: string, exeRelative: string): Promise<string | null> {
  const direct = join(extractDir, exeRelative);
  if (await fileExists(direct)) return direct;
  const target = basename(exeRelative);
  const { stat } = await import('node:fs/promises');
  const entries = await readdir(extractDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name === target && entry.parentPath !== undefined) {
      const candidate = join(entry.parentPath, entry.name);
      try {
        await stat(candidate);
        return candidate;
      } catch {
        // keep searching
      }
    }
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultExtractArchive(zipPath: string, destination: string): Promise<void> {
  const command = `Expand-Archive -LiteralPath '${powershellEscape(zipPath)}' -DestinationPath '${powershellEscape(destination)}' -Force`;
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      error => error === null ? resolve() : reject(error)
    );
  });
}

function powershellEscape(value: string): string {
  return value.replaceAll("'", "''");
}

function defaultSpawnProcess(exePath: string, env: NodeJS.ProcessEnv): HongguoSpawnedProcess {
  const child = spawn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    env,
    windowsHide: false
  });
  child.unref();
  return {
    pid: child.pid,
    onExit(listener) {
      child.once('exit', code => listener(code));
    },
    onError(listener) {
      child.once('error', error => listener(error instanceof Error ? error : new Error(String(error))));
    }
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
