import type { CreatorRuntimeComponentsResponse, CreatorYtDlpStatus, HongguoComponentStatus } from '@opencreator/protocol';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../runtime/client.js';
import type { RuntimeDependencyService } from '../services/runtime-dependency-service.js';
import { useRuntimeDependencies } from './use-runtime-dependencies.js';

/** Mock đủ bộ method drama discovery + dịch cả bộ cho service test (tất cả optional với UI). */
function dramaMocks() {
  return {
    getDramaStatus: vi.fn(async () => ({
      hongguo: hongguoStatus(),
      drama: { ready: false, port: null, installed: false, running: false, error: null }
    })),
    getDramaMediaSources: vi.fn(async () => ({ success: true, sources: [] })),
    getDramaCategories: vi.fn(async () => ({ categories: [] })),
    browseDrama: vi.fn(async () => ({ success: true, results: [] })),
    searchDrama: vi.fn(async () => ({ success: true, results: [] })),
    getDramaSeries: vi.fn(async () => ({ success: true })),
    getDramaSeriesEpisodes: vi.fn(async () => ({ success: true })),
    downloadDramaBatch: vi.fn(async () => ({ success: true })),
    getDramaDownloadTasks: vi.fn(async () => ({ tasks: [] })),
    translateDramaTitles: vi.fn(async () => ({ translations: {} })),
    getTranslationBatch: vi.fn(async () => ({
      items: [],
      paused: false,
      counts: { queued: 0, running: 0, completed: 0, failed: 0 },
      progress: {
        total: 0, queued: 0, running: 0, completed: 0, failed: 0, canceled: 0, allDone: true, percent: 0
      },
      merge: { status: 'idle', outputPath: null, uploadReady: null, episodeCount: null, error: null },
      uploadFolder: ''
    })),
    enqueueTranslationBatch: vi.fn(async () => ({
      items: [],
      paused: false,
      counts: { queued: 0, running: 0, completed: 0, failed: 0 },
      progress: {
        total: 0, queued: 0, running: 0, completed: 0, failed: 0, canceled: 0, allDone: true, percent: 0
      },
      merge: { status: 'idle', outputPath: null, uploadReady: null, episodeCount: null, error: null },
      uploadFolder: ''
    })),
    mergeTranslationBatch: vi.fn(async () => ({
      status: 'idle', outputPath: null, episodeCount: null, seriesName: null
    })),
    revealTranslationBatch: vi.fn(async () => ({ ok: true })),
    renameProject: vi.fn(async (projectId: string, name: string) => ({ project: { id: projectId, name } }))
  };
}

describe('useRuntimeDependencies', () => {
  it('forwards a component download independently of the selected transcription provider', async () => {
    const componentsStatus: CreatorRuntimeComponentsResponse = {
      platform: 'darwin', arch: 'arm64', selectedProvider: 'openai', selectedModel: null, components: []
    };
    const service: RuntimeDependencyService = {
      getComponentsStatus: vi.fn(async () => componentsStatus),
      downloadComponents: vi.fn(async () => componentsStatus),
      getYtDlpStatus: vi.fn(async () => ({ ytDlp: status() })),
      checkYtDlpUpdate: vi.fn(), updateYtDlp: vi.fn(),
      getHongguoStatus: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      checkHongguoUpdate: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      updateHongguo: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      setHongguoChannel: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      ...dramaMocks()
    };
    const { result } = renderHook(() => useRuntimeDependencies({ connected: true, service }));
    await waitFor(() => expect(result.current.componentsStatus).toEqual(componentsStatus));

    await act(async () => { await result.current.downloadComponents?.('whisperkit'); });

    expect(service.downloadComponents).toHaveBeenCalledWith('whisperkit');
    expect(result.current.componentsStatus?.selectedProvider).toBe('openai');
  });

  it('checks yt-dlp once the Runtime connects and the saved interval is due', async () => {
    const getYtDlpStatus = vi.fn(async () => ({
      ytDlp: status({ checkDue: true })
    }));
    const checkYtDlpUpdate = vi.fn(async () => ({
      ytDlp: status({
        checkDue: false,
        latestVersion: '2026.08.31.120000',
        updateAvailable: true,
        lastCheckedAt: '2026-08-31T00:00:00.000Z'
      })
    }));
    const service = {
      getComponentsStatus: vi.fn(), downloadComponents: vi.fn(),
      getYtDlpStatus,
      checkYtDlpUpdate,
      updateYtDlp: vi.fn(),
      getHongguoStatus: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      checkHongguoUpdate: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      updateHongguo: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      setHongguoChannel: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      ...dramaMocks()
    } as RuntimeDependencyService;

    const { result } = renderHook(() => useRuntimeDependencies({
      connected: true,
      service
    }));

    await waitFor(() => expect(result.current.phase).toBe('idle'));
    expect(getYtDlpStatus).toHaveBeenCalledOnce();
    expect(checkYtDlpUpdate).toHaveBeenCalledWith(false);
    expect(result.current.ytDlpStatus?.updateAvailable).toBe(true);
  });

  it('shares the status returned by a manual update', async () => {
    const updateYtDlp = vi.fn(async () => ({
      ytDlp: status({
        source: 'managed',
        currentVersion: '2026.08.31.120000',
        latestVersion: '2026.08.31.120000'
      })
    }));
    const service = {
      getComponentsStatus: vi.fn(), downloadComponents: vi.fn(),
      getYtDlpStatus: vi.fn(async () => ({ ytDlp: status() })),
      checkYtDlpUpdate: vi.fn(),
      updateYtDlp,
      getHongguoStatus: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      checkHongguoUpdate: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      updateHongguo: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      setHongguoChannel: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      ...dramaMocks()
    } as RuntimeDependencyService;
    const { result } = renderHook(() => useRuntimeDependencies({
      connected: true,
      service
    }));
    await waitFor(() => expect(result.current.ytDlpStatus).toBeDefined());

    await act(async () => {
      await result.current.updateYtDlp();
    });

    expect(updateYtDlp).toHaveBeenCalledOnce();
    expect(result.current.ytDlpStatus?.source).toBe('managed');
    expect(result.current.ytDlpStatus?.currentVersion).toBe('2026.08.31.120000');
  });

  it('preserves the Runtime error code used for localized update feedback', async () => {
    const updateYtDlp = vi.fn(async () => {
      throw new ApiClientError({
        status: 502,
        code: 'creator_yt_dlp_update_download_failed',
        message: 'Unable to download the yt-dlp update'
      });
    });
    const service = {
      getComponentsStatus: vi.fn(), downloadComponents: vi.fn(),
      getYtDlpStatus: vi.fn(async () => ({ ytDlp: status() })),
      checkYtDlpUpdate: vi.fn(),
      updateYtDlp,
      getHongguoStatus: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      checkHongguoUpdate: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      updateHongguo: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      setHongguoChannel: vi.fn(async () => ({ hongguo: hongguoStatus() })),
      ...dramaMocks()
    } as RuntimeDependencyService;
    const { result } = renderHook(() => useRuntimeDependencies({
      connected: true,
      service
    }));
    await waitFor(() => expect(result.current.ytDlpStatus).toBeDefined());

    await act(async () => {
      await result.current.updateYtDlp().catch(() => undefined);
    });

    expect(result.current.error).toBeUndefined();
    expect(result.current.issues).toHaveLength(1);
    expect(result.current.issues?.[0]).toMatchObject({
      code: 'creator_yt_dlp_update_download_failed',
      operation: 'runtime.update-yt-dlp',
      fallbackMessage: '运行组件更新失败，请检查网络和磁盘空间后重试。'
    });
    expect(result.current.issues?.[0]?.diagnosticId).toMatch(/^OC-/);
  });
});

function status(patch: Partial<CreatorYtDlpStatus> = {}): CreatorYtDlpStatus {
  return {
    channel: 'nightly',
    source: 'bundled',
    currentVersion: '2026.08.29.232711',
    bundledVersion: '2026.08.29.232711',
    latestVersion: null,
    updateAvailable: false,
    checkDue: false,
    lastCheckedAt: null,
    lastCheckAttemptAt: null,
    installedAt: null,
    ...patch
  };
}

function hongguoStatus(patch: Partial<HongguoComponentStatus> = {}): HongguoComponentStatus {
  return {
    installed: false,
    currentVersion: null,
    currentViRevision: null,
    latestVersion: null,
    latestViRevision: null,
    updateAvailable: false,
    checkDue: false,
    channelConfigured: false,
    channelUrl: null,
    phase: 'idle',
    downloadProgress: null,
    lastCheckedAt: null,
    lastCheckAttemptAt: null,
    installedAt: null,
    running: false,
    runningPid: null,
    dataRoot: 'runtime/hongguo-drama/user-data',
    downloadsRoot: 'runtime/hongguo-drama/downloads',
    error: null,
    ...patch
  };
}
