import type { CreatorYtDlpStatus, HongguoComponentStatus } from '@opencreator/protocol';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeDependenciesController } from '../../app/use-runtime-dependencies.js';
import { normalizePageIssue } from '../issues/page-issue-state.js';
import { LanguageProvider } from '../../i18n/LanguageProvider.js';
import { RuntimeComponentsSettingsView } from './RuntimeComponentsSettingsView.js';

describe('RuntimeComponentsSettingsView', () => {
  it('shows current, latest, and updated versions, and installs an available update', async () => {
    const updateYtDlp = vi.fn(async () => status({
      source: 'managed',
      currentVersion: '2026.08.31.120000'
    }));
    renderView({
      ytDlpStatus: status({
        latestVersion: '2026.08.31.120000',
        updateAvailable: true,
        lastCheckedAt: '2026-08-31T00:00:00.000Z'
      }),
      updateYtDlp
    });

    expect(screen.getByRole('heading', { name: '第三方组件' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'yt-dlp nightly' })).toBeInTheDocument();
    expect(screen.getAllByText('2026.08.29.232711')).toHaveLength(1);
    expect(screen.getByText('更新时间')).toBeInTheDocument();
    expect(screen.getByText('尚未检查')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', {
      name: '更新到 2026.08.31.120000'
    }));

    expect(screen.getByText('有可用更新')).toHaveAttribute('data-status', 'update');
    expect(screen.getByRole('button', { name: '更新到 2026.08.31.120000' })).toHaveAttribute('data-status', 'update');
    await waitFor(() => expect(updateYtDlp).toHaveBeenCalledOnce());
  });

  it('keeps the current version active when update verification fails', async () => {
    renderView({
      ytDlpStatus: status({
        latestVersion: '2026.08.31.120000',
        updateAvailable: true
      }),
      issues: [normalizePageIssue(
        'settings-runtime-components',
        'runtime.update-yt-dlp',
        new Error('verification failed'),
        'yt-dlp 更新校验失败，当前版本仍可继续使用。'
      )]
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'yt-dlp 更新校验失败，当前版本仍可继续使用。'
    );
    expect(screen.queryByText('更新失败时，OpenCreator 会继续使用当前可用版本。'))
      .not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('有可用更新')).toBeInTheDocument());
  });

  it('checks live before claiming that a cached version is current', async () => {
    let resolveCheck!: (value: CreatorYtDlpStatus) => void;
    const checkYtDlpUpdate = vi.fn(() => new Promise<CreatorYtDlpStatus>(resolve => {
      resolveCheck = resolve;
    }));
    renderView({
      ytDlpStatus: status({
        latestVersion: '2026.08.29.232711',
        lastCheckedAt: '2026-08-31T00:00:00.000Z'
      }),
      checkYtDlpUpdate
    });

    expect(screen.getAllByText('正在检查')).not.toHaveLength(0);
    expect(screen.queryByText('已是最新')).not.toBeInTheDocument();
    expect(screen.getByText('上次检查版本')).toBeInTheDocument();
    expect(checkYtDlpUpdate).toHaveBeenCalledWith(true);

    resolveCheck(status({
      latestVersion: '2026.09.16.232951',
      updateAvailable: true
    }));
    await waitFor(() => expect(screen.queryByText('正在检查')).not.toBeInTheDocument());
  });

  it('marks cached release information as stale when the live check fails', async () => {
    const checkYtDlpUpdate = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    renderView({
      ytDlpStatus: status({ latestVersion: '2026.08.29.232711' }),
      checkYtDlpUpdate
    });

    await waitFor(() => expect(screen.getByText('失败')).toHaveAttribute('data-status', 'failed'));
    expect(screen.getByText('检查失败').closest('.runtime-component-details')).not.toBeNull();
    expect(screen.getByText('上次检查版本')).toBeInTheDocument();
    expect(screen.queryByText('已是最新')).not.toBeInTheDocument();
  });

  it('shows a notice when a manual check finds no update', async () => {
    const checkYtDlpUpdate = vi.fn(async () => status());
    renderView({ checkYtDlpUpdate });

    await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已经是最新版本'));
    expect(checkYtDlpUpdate).toHaveBeenCalledWith(true);
  });

  it('recovers the failed status after a successful manual retry', async () => {
    const checkYtDlpUpdate = vi.fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue(status());
    renderView({ checkYtDlpUpdate });

    await waitFor(() => expect(screen.getByText('失败')).toHaveAttribute('data-status', 'failed'));
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));

    await waitFor(() => expect(screen.getByText('已就绪')).toHaveAttribute('data-status', 'current'));
    expect(screen.queryByText('检查失败')).not.toBeInTheDocument();
    expect(checkYtDlpUpdate).toHaveBeenCalledTimes(2);
  });

  it('shows readiness in the main badge and the latest status next to the version', async () => {
    renderView({ ytDlpStatus: status({ latestVersion: '2026.08.29.232711' }) });

    await waitFor(() => expect(screen.getByText('已就绪')).toHaveAttribute('data-status', 'current'));
    expect(screen.getByText('已是最新').closest('.runtime-component-details')).not.toBeNull();
    expect(screen.getByText('已是最新').closest('.runtime-component-title')).toBeNull();
  });

  it('replaces the blocked Hongguo update check with a single clear notice', () => {
    const checkHongguoUpdate = vi.fn();
    renderView({ hongguoStatus: hongguo({ channelConfigured: false, installed: true }), checkHongguoUpdate });
    const card = screen.getByRole('heading', { name: '红果短剧（第三方组件）' }).closest('article')!;

    expect(within(card).getByText('红果短剧当前有错误，无法检查更新。')).toBeVisible();
    expect(within(card).getByText('无法检查更新')).toHaveAttribute('data-status', 'failed');
    // Không còn nút bị chặn nào để bấm.
    expect(within(card).queryByRole('button', { name: '检查更新' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /更新到|安装/ })).not.toBeInTheDocument();
    expect(checkHongguoUpdate).not.toHaveBeenCalled();
  });

  it('keeps the Hongguo update check usable once a channel exists', async () => {
    const checkHongguoUpdate = vi.fn(async () => hongguo({ channelConfigured: true, installed: true }));
    renderView({
      hongguoStatus: hongguo({ channelConfigured: true, installed: true }),
      checkHongguoUpdate
    });
    const card = screen.getByRole('heading', { name: '红果短剧（第三方组件）' }).closest('article')!;

    expect(within(card).queryByText('红果短剧当前有错误，无法检查更新。')).not.toBeInTheDocument();
    expect(within(card).getByText('已就绪')).toBeVisible();
    fireEvent.click(within(card).getByRole('button', { name: '检查更新' }));
    await waitFor(() => expect(checkHongguoUpdate).toHaveBeenCalledWith(true));
  });
});

function renderView(patch: Partial<RuntimeDependenciesController>) {
  const controller = {
    ytDlpStatus: status(),
    phase: 'idle',
    checkYtDlpUpdate: vi.fn(async () => status()),
    updateYtDlp: vi.fn(async () => status()),
    ...patch
  } as RuntimeDependenciesController;
  return render(
    <LanguageProvider initialPreference="zh-CN">
      <RuntimeComponentsSettingsView connected controller={controller} />
    </LanguageProvider>
  );
}

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

function hongguo(patch: Partial<HongguoComponentStatus> = {}): HongguoComponentStatus {
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
    dataRoot: '/runtime/hongguo-drama/user-data',
    downloadsRoot: '/runtime/hongguo-drama/downloads',
    error: null,
    ...patch
  };
}
