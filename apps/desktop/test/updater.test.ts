import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoUpdater as nativeUpdater } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import electronUpdater from 'electron-updater';
import { startUpdater, resolveUpdaterFeedMode } from '../src/main/updater.js';
import type { DesktopLogger } from '../src/main/logger.js';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: {
      isPackaged: false,
      getVersion: () => '3.2.6',
      getName: () => 'OpenCreator',
      getPath: (kind: string) => join(tmpdir(), 'opencreator-updater-mock-electron', kind)
    },
    dialog: {},
    autoUpdater: new EventEmitter()
  };
});

describe('Desktop updater', () => {
  beforeEach(() => {
    nativeUpdater.removeAllListeners();
  });

  it('uses a separate update channel for Intel macOS releases', () => {
    const updater = new FakeUpdater();
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      initialCheckDelayMs: 0,
      platform: 'darwin',
      arch: 'x64'
    });

    expect(updater.channel).toBe('latest-x64');
    expect(updater.allowDowngrade).toBe(false);
    controller.dispose();
  });

  it('disables silent auto-download and background installation', () => {
    const updater = new FakeUpdater();
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      initialCheckDelayMs: 0,
      platform: 'win32',
      arch: 'x64'
    });

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    controller.dispose();
  });

  it('checks once on boot with an immediate delay when requested', async () => {
    const updater = new FakeUpdater();
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      initialCheckDelayMs: 0
    });
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledOnce());
    controller.dispose();
  });

  it('skips the boot check when the daily interval has not elapsed', async () => {
    const stored = { lastCheckAt: new Date(Date.now() - 60_000).toISOString() };
    const checkStore = {
      read: () => ({ lastCheckAt: stored.lastCheckAt }),
      write: record => {
        stored.lastCheckAt = record.lastCheckAt;
      }
    };
    const updater = new FakeUpdater();
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      checkStore,
      initialCheckDelayMs: 5_000,
      checkIntervalMs: 24 * 60 * 60 * 1_000
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('persists the last check timestamp after a completed check', async () => {
    const records: Array<{ lastCheckAt?: string }> = [];
    const updater = new FakeUpdater();
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      checkStore: {
        read: () => ({}),
        write: record => records.push(record)
      },
      initialCheckDelayMs: 0
    });

    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledOnce());
    updater.emit('update-not-available');
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0].lastCheckAt).toEqual(expect.any(String));
    expect(controller.getSnapshot().lastCheckAt).toEqual(records[0].lastCheckAt);
    controller.dispose();
  });

  it('captures download failures without an unhandled rejection', async () => {
    const updater = new FakeUpdater();
    updater.downloadUpdate = vi.fn(async () => {
      throw new Error('download failed');
    });
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      initialCheckDelayMs: 3_600_000,
      showMessageBox: vi.fn(async () => ({
        response: 0,
        checkboxChecked: false
      }))
    });

    updater.emit('update-available', { version: '1.2.3' });
    await vi.waitFor(() => expect(controller.getState()).toBe('error'));
    controller.dispose();
  });

  it('opens a two-choice prompt when an update is available', async () => {
    const updater = new FakeUpdater();
    const showMessageBox = vi.fn(async () => ({
      response: 1,
      checkboxChecked: false
    }));
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      locale: 'vi-VN',
      initialCheckDelayMs: 3_600_000,
      showMessageBox
    });

    updater.emit('update-available', { version: '3.2.9' });
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce());

    expect(showMessageBox.mock.calls[0][0].buttons).toEqual(['Cập nhật ngay', 'Để sau']);
    await vi.waitFor(() => expect(controller.getSnapshot().state).toBe('available'));
    expect(controller.getSnapshot().availableVersion).toBe('3.2.9');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('downloads automatically without another confirmation once approved', async () => {
    const updater = new FakeUpdater();
    updater.quitAndInstall = vi.fn(() => {
      steps.push('install');
    });
    let resolveDownload: () => void = () => undefined;
    updater.downloadUpdate = vi.fn(
      () => new Promise<void>(resolve => {
        resolveDownload = resolve;
      })
    );
    const steps: string[] = [];
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      initialCheckDelayMs: 3_600_000,
      showMessageBox: vi.fn(async () => ({
        response: 0,
        checkboxChecked: false
      })),
      async prepareInstall() {
        steps.push('prepare');
      },
      setAllowQuit(value) {
        if (value) steps.push('allow-quit');
      }
    });

    updater.emit('update-available', { version: '3.2.9' });
    await vi.waitFor(() => expect(controller.getState()).toBe('downloading'));
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());
    resolveDownload();
    updater.emit('update-downloaded', { version: '3.2.9' });
    await vi.waitFor(() => {
      expect(steps).toEqual(['prepare', 'allow-quit', 'install']);
    });
    expect(controller.getState()).toBe('installing');
    controller.dispose();
  });

  it('stops runtime state before invoking the installer', async () => {
    const steps: string[] = [];
    const updater = new FakeUpdater();
    updater.quitAndInstall = vi.fn(() => {
      steps.push('install');
    });
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      initialCheckDelayMs: 0,
      showMessageBox: vi.fn(async () => ({
        response: 0,
        checkboxChecked: false
      })),
      async prepareInstall() {
        steps.push('prepare');
      },
      setAllowQuit(value) {
        if (value) steps.push('allow-quit');
      }
    });

    updater.emit('update-downloaded', { version: '1.2.3' });
    await vi.waitFor(() => expect(controller.getState()).toBe('installing'));

    expect(steps).toEqual(['prepare', 'allow-quit', 'install']);
    controller.dispose();
  });

  it('recovers the current version when installation preparation fails', async () => {
    const recover = vi.fn(async () => undefined);
    const allowQuit: boolean[] = [];
    const updater = new FakeUpdater();
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      initialCheckDelayMs: 3_600_000,
      showMessageBox: vi.fn(async () => ({
        response: 0,
        checkboxChecked: false
      })),
      async prepareInstall() {
        throw new Error('flush failed');
      },
      recoverAfterInstallFailure: recover,
      setAllowQuit: value => allowQuit.push(value)
    });

    updater.emit('update-downloaded', { version: '1.2.3' });
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));

    expect(controller.getState()).toBe('error');
    expect(allowQuit.at(-1)).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('allows native update window closing before the ordinary quit event', async () => {
    const steps: string[] = [];
    const updater = new FakeUpdater();
    updater.quitAndInstall = vi.fn(() => {
      nativeUpdater.emit('before-quit-for-update');
      steps.push('native-window-close');
    });
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      initialCheckDelayMs: 0,
      showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
      async prepareInstall() {
        steps.push('stop-runtime');
      },
      beforeQuitForInstall() {
        steps.push('allow-window-close');
      }
    });

    updater.emit('update-downloaded', { version: '1.2.3' });
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledOnce());

    expect(steps).toEqual(['stop-runtime', 'allow-window-close', 'native-window-close']);
    controller.dispose();
  });

  it('keeps the window available until the native installer actually quits', async () => {
    const beforeQuitForInstall = vi.fn();
    const updater = new FakeUpdater();
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      initialCheckDelayMs: 0,
      beforeQuitForInstall,
      showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false }))
    });

    nativeUpdater.emit('before-quit-for-update');
    expect(beforeQuitForInstall).not.toHaveBeenCalled();
    updater.emit('update-downloaded', { version: '1.2.3' });
    await vi.waitFor(() => expect(controller.getState()).toBe('installing'));
    expect(beforeQuitForInstall).not.toHaveBeenCalled();

    updater.emit('error', new Error('native download failed'));
    nativeUpdater.emit('before-quit-for-update');
    expect(controller.getState()).toBe('error');
    expect(beforeQuitForInstall).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('keeps the current runtime running when the user postpones installation', async () => {
    const prepareInstall = vi.fn(async () => undefined);
    const recover = vi.fn(async () => undefined);
    const updater = new FakeUpdater();
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      initialCheckDelayMs: 0,
      showMessageBox: vi.fn(async () => ({
        response: 1,
        checkboxChecked: false
      })),
      prepareInstall,
      recoverAfterInstallFailure: recover
    });

    updater.emit('update-downloaded', { version: '1.2.3' });
    await vi.waitFor(() => expect(controller.getState()).toBe('downloaded'));

    expect(prepareInstall).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('does not restart the runtime when checking for updates fails', async () => {
    const recover = vi.fn(async () => undefined);
    const updater = new FakeUpdater();
    updater.checkForUpdates = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      initialCheckDelayMs: 0,
      recoverAfterInstallFailure: recover
    });

    await vi.waitFor(() => expect(controller.getState()).toBe('error'));

    expect(recover).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('falls back to an explicit GitHub feed without app-update.yml', () => {
    const options: unknown[] = [];
    let built: FakeUpdater | undefined;
    const holder = electronUpdater as unknown as { NsisUpdater: unknown };
    const spy = vi
      .spyOn(holder, 'NsisUpdater')
      .mockImplementation(((value: unknown) => {
        options.push(value);
        built = new FakeUpdater();
        return built as unknown as unknown;
      }) as never);
    try {
      expect(resolveUpdaterFeedMode(
        join(tmpdir(), 'opencreator-updater-missing-resources')
      )).toBe('explicit-github');
      startUpdater({
        logger: fakeLogger(),
        isPackaged: true,
        resourcesPath: join(tmpdir(), 'opencreator-updater-missing-resources'),
        initialCheckDelayMs: 3_600_000
      });
      expect(options).toHaveLength(1);
      expect(options[0]).toEqual({
        provider: 'github',
        owner: 'krillinai',
        repo: 'OpenCreator'
      });
      expect(built?.configOnDisk).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('reads the packaged feed configuration when app-update.yml exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencreator-updater-feed-'));
    writeFileSync(join(dir, 'app-update.yml'), 'owner: krillinai\n');
    expect(resolveUpdaterFeedMode(dir)).toBe('packaged-config');
  });

  it('removes updater listeners when disposed', () => {
    const updater = new FakeUpdater();
    const controller = startUpdater({
      logger: fakeLogger(),
      isPackaged: true,
      updater,
      initialCheckDelayMs: 0
    });

    controller.dispose();

    expect(updater.eventNames()).toEqual([]);
    expect(nativeUpdater.eventNames()).toEqual([]);
  });
});

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  channel: string | null = null;
  configOnDisk?: unknown;
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => undefined);
  quitAndInstall = vi.fn();
}

function fakeLogger(): DesktopLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    warnRateLimited: vi.fn(),
    flush: vi.fn(async () => undefined)
  };
}
