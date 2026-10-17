import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join, relative } from 'node:path';
import { z } from 'zod';
import type { HongguoComponentStatus, HongguoDramaApiStatus, RuntimeErrorCode } from '@opencreator/protocol';
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
/** Số lần thử khởi động lại tiến trình thành phần khi API chưa phản hồi. */
const API_LAUNCH_ATTEMPTS = 3;

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
  /** Stable loopback API credentials handed to the component on launch. */
  api?: { port: number; token: string };
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

export type HongguoDramaFetchOptions = {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  /** Total budget covering API readiness plus the upstream request. */
  timeoutMs?: number;
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
  /** Starts the component GUI/API; `credential` reuses a port+token already chosen. */
  launch(credential?: { port: number; token: string }): Promise<HongguoComponentStatus>;
  /** Health-checks the component's loopback API without spawning anything. */
  probeDramaApi(): Promise<HongguoDramaApiStatus>;
  /**
   * Calls the component's loopback drama API, launching the component first
   * when needed (single-flight) and attaching the persisted bearer token.
   */
  apiFetch(pathname: string, options?: HongguoDramaFetchOptions): Promise<unknown>;
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
  // Thành phần ghi cổng/token đang phục vụ thật vào file này (xem drama-api.js),
  // để daemon dò lại được khi state.json lệch với tiến trình đang chạy.
  const apiDescriptorPath = join(dataRoot, 'drama-api.json');

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
  let apiReady = false;
  let apiLastError: string | null = null;
  let ensureInFlight: Promise<{ port: number; token: string }> | null = null;

  const implFetch = (): typeof fetch => deps.fetchImpl ?? fetch;

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

  const launch = async (credential?: { port: number; token: string }): Promise<HongguoComponentStatus> => {
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
      // Cổng + token loopback: mọi tiến trình do OpenCreator mở đều phục vụ
      // drama API để màn hình Khám phá phim/Gợi ý hot đọc dữ liệu.
      const api = credential ?? await resolveApiPortAndToken();
      const proc = spawnProcess(exePath, {
        ...process.env,
        HONGGUO_USER_DATA_DIR: dataRoot,
        HONGGUO_DOWNLOAD_DIR: downloadsRoot,
        HONGGUO_API_PORT: String(api.port),
        HONGGUO_API_TOKEN: api.token
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
      fatalError = null;
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

  /**
   * Cổng + token được lưu trong state.json để daemon khởi động lại vẫn nói
   * chuyện được với tiến trình Hồng Quả đang chạy (token/ cổng không đổi).
   *
   * Thứ tự chọn: state.json đang phản hồi -> descriptor do thành phần ghi ra
   * (tiến trình đang chạy có thể dùng cổng khác) -> cấp cổng loopback mới.
   * `force` dùng khi cần chắc chắn một cổng mới (lần khởi động trước thoát ngay).
   */
  const resolveApiPortAndToken = async (
    options: { force?: boolean } = {}
  ): Promise<{ port: number; token: string }> => {
    const existing = state.api;
    if (
      options.force !== true
      && existing !== undefined
      && isApiCredential(existing)
      && (apiReady || await probeApi(existing.port, existing.token, 800))
    ) {
      return existing;
    }
    if (options.force !== true) {
      const discovered = await readApiDescriptor();
      if (discovered !== null) {
        state.api = discovered;
        await persist().catch(() => undefined);
        return discovered;
      }
    }
    const api = { port: await findFreePort(), token: randomUUID() };
    state.api = api;
    await persist().catch(() => undefined);
    return api;
  };

  /**
   * Đọc descriptor của thành phần; chỉ nhận khi cổng đó thật sự phục vụ API
   * loopback với đúng token (tiến trình cũ còn sót lại sẽ bị bỏ qua).
   */
  const readApiDescriptor = async (): Promise<{ port: number; token: string } | null> => {
    let payload: unknown;
    try {
      payload = await readPrivateJsonFile(apiDescriptorPath);
    } catch {
      return null;
    }
    if (typeof payload !== 'object' || payload === null) return null;
    const descriptor = payload as { port?: unknown; token?: unknown };
    if (!isApiCredential(descriptor)) return null;
    const candidate = { port: descriptor.port as number, token: descriptor.token as string };
    return (await probeApi(candidate.port, candidate.token, 800)) ? candidate : null;
  };

  /** Dò cổng API không cần token (healthcheck công khai của thành phần). */
  const probeHealth = async (port: number, timeoutMs: number): Promise<boolean> => {
    try {
      const response = await implFetch()(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return false;
      const payload = (await response.json()) as { ok?: unknown; name?: unknown };
      return payload?.ok === true && payload?.name === 'hongguo-drama-api';
    } catch {
      return false;
    }
  };

  /**
   * Dò API kèm token: một tiến trình cũ còn sót có thể chiếm cổng nhưng trả 401
   * với token hiện tại, khi đó phải coi như chưa sẵn sàng và cấp cổng mới.
   */
  const probeApi = async (port: number, token: string, timeoutMs: number): Promise<boolean> => {
    try {
      const response = await implFetch()(`http://127.0.0.1:${port}/api/v1/browse-categories`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs)
      });
      return response.ok;
    } catch {
      return false;
    }
  };

  const buildDramaStatus = (ready: boolean): HongguoDramaApiStatus => {
    refreshRunning();
    return {
      ready,
      port: state.api?.port ?? null,
      installed: state.active !== undefined,
      running: runningPid !== null,
      error: apiLastError
    };
  };

  const probeDramaApi = async (): Promise<HongguoDramaApiStatus> => {
    const api = state.api;
    if (api === undefined) return buildDramaStatus(false);
    apiReady = await probeHealth(api.port, 600);
    return buildDramaStatus(apiReady);
  };

  /** Đảm bảo API đang phản hồi; tự khởi động component nếu chưa chạy. */
  const ensureApi = async (timeoutMs: number): Promise<{ port: number; token: string }> => {
    if (ensureInFlight !== null) return ensureInFlight;
    const run = (async (): Promise<{ port: number; token: string }> => {
      let api = await resolveApiPortAndToken();
      if (await probeApi(api.port, api.token, 800)) {
        apiReady = true;
        apiLastError = null;
        return api;
      }
      refreshRunning();
      if (state.active === undefined) {
        apiLastError = 'Hongguo chưa được cài đặt';
        throw new HongguoUpdateError('creator_hongguo_unavailable', 'Hongguo is not installed yet', 503);
      }
      if (phase !== 'idle') {
        throw new HongguoUpdateError('creator_hongguo_unavailable', 'Another Hongguo component operation is already running', 503);
      }
      const deadline = Date.now() + timeoutMs;
      // Tối đa vài lượt: tiến trình có thể thoát ngay sau khi spawn (khoá
      // single-instance của một bản Hồng Quả khác), khi đó cấp cổng mới rồi thử lại.
      for (let attempt = 0; attempt < API_LAUNCH_ATTEMPTS; attempt += 1) {
        if (runningPid === null) await launch(api);
        while (Date.now() < deadline) {
          if (await probeApi(api.port, api.token, 800)) {
            apiReady = true;
            apiLastError = null;
            return api;
          }
          refreshRunning();
          if (runningPid === null) break;
          if (fatalError !== null) {
            apiLastError = fatalError;
            throw new HongguoUpdateError('creator_hongguo_launch_failed', fatalError, 502);
          }
          await delay(400);
        }
        if (Date.now() >= deadline) break;
        api = await resolveApiPortAndToken({ force: true });
      }
      apiReady = false;
      apiLastError = 'Ứng dụng Hồng Quả không phản hồi API. Nếu ứng dụng đang mở từ ngoài OpenCreator, hãy đóng nó và mở lại từ OpenCreator.';
      throw new HongguoUpdateError('creator_hongguo_unavailable', apiLastError, 503);
    })();
    ensureInFlight = run.finally(() => {
      ensureInFlight = null;
    });
    return ensureInFlight;
  };

  const apiFetch = async (pathname: string, options: HongguoDramaFetchOptions = {}): Promise<unknown> => {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Ngân sách khởi động component không vượt quá tổng ngân sách yêu cầu.
      const { port, token } = await ensureApi(Math.min(timeoutMs, 30_000));
      const url = new URL(`http://127.0.0.1:${port}${pathname}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
      const response = await implFetch()(url, {
        method: options.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new HongguoUpdateError(
          'creator_hongguo_unavailable',
          `Hongguo drama API responded with status ${response.status}`,
          502
        );
      }
      const text = await response.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new HongguoUpdateError(
          'creator_hongguo_unavailable',
          'Hongguo drama API returned a non-JSON response',
          502
        );
      }
    } catch (error) {
      // Lần gọi sau dò lại cổng/token: tiến trình thành phần có thể vừa thoát.
      apiReady = false;
      if (error instanceof HongguoUpdateError) throw error;
      const message = error instanceof Error && error.name === 'AbortError'
        ? `Hongguo drama API request timed out after ${timeoutMs}ms`
        : messageOf(error);
      apiLastError = message;
      throw new HongguoUpdateError('creator_hongguo_unavailable', message, 504);
    } finally {
      clearTimeout(timer);
    }
  };

  return { status, check, update, launch, probeDramaApi, apiFetch, close };
}

type HongguoComponentDownloadProgressState = HongguoComponentStatus['downloadProgress'];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function versionKey(version: string, viRevision: number): string {
  return `${version}-vi.${viRevision}`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Cổng/token hợp lệ để nói chuyện với drama API của thành phần. */
function isApiCredential(value: unknown): value is { port: number; token: string } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { port?: unknown; token?: unknown };
  return (
    Number.isInteger(candidate.port)
    && (candidate.port as number) > 0
    && (candidate.port as number) < 65_536
    && typeof candidate.token === 'string'
    && candidate.token.length >= 8
  );
}

/** Cổng loopback trống do OS cấp (dùng cho drama API của component). */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('could not allocate a loopback port'));
      });
    });
  });
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
