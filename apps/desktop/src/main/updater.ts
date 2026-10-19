import { app, autoUpdater as nativeAutoUpdater, dialog } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import electronUpdater from 'electron-updater';
import type { DesktopLogger } from './logger.js';
import type { DesktopUpdaterSnapshot, DesktopUpdaterState } from '../shared/types.js';

export type { DesktopUpdaterSnapshot, DesktopUpdaterState };

type UpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade?: boolean;
  channel?: string | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};

export type DesktopUpdateCheckRecord = {
  lastCheckAt?: string;
};

export type DesktopUpdateCheckStore = {
  read(): DesktopUpdateCheckRecord;
  write(record: DesktopUpdateCheckRecord): void;
};

export type DesktopUpdaterController = {
  dispose(): void;
  checkNow(): Promise<void>;
  userInstallNow(): void;
  getState(): DesktopUpdaterState;
  getSnapshot(): DesktopUpdaterSnapshot;
  onStateChange(listener: (snapshot: DesktopUpdaterSnapshot) => void): void;
};

export function startUpdater(input: {
  logger: DesktopLogger;
  isPackaged?: boolean;
  updater?: UpdaterLike;
  nativeUpdater?: Pick<Electron.AutoUpdater, 'on' | 'removeListener'>;
  showMessageBox?: typeof dialog.showMessageBox;
  prepareInstall?(): Promise<void>;
  beforeQuitForInstall?(): void;
  recoverAfterInstallFailure?(): Promise<void>;
  setAllowQuit?(allowed: boolean): void;
  platform?: NodeJS.Platform;
  arch?: string;
  locale?: string;
  isCustomBuild?: boolean;
  resourcesPath?: string;
  checkStore?: DesktopUpdateCheckStore;
  initialCheckDelayMs?: number;
  checkIntervalMs?: number;
}): DesktopUpdaterController {
  const updater = resolveUpdaterWorker(input);
  const nativeUpdater = input.nativeUpdater ?? nativeAutoUpdater;
  const isPackaged = input.isPackaged ?? app.isPackaged;
  const checkStore = input.checkStore
    ?? (isPackaged ? createFileCheckStore(defaultCheckStorePath()) : undefined);
  const initialDelayMs = input.initialCheckDelayMs ?? 60_000;
  const intervalMs = input.checkIntervalMs ?? 24 * 60 * 60 * 1_000;
  let state: DesktopUpdaterState = 'idle';
  let disposed = false;
  let downloadRequested = false;
  let lastCheckAt: string | undefined = checkStore?.read().lastCheckAt;
  let availableVersion: string | undefined;
  let errorMessage: string | undefined;
  let activeOperation: Promise<void> | undefined;
  let scheduledTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingAvailableVersion: string | undefined;
  let stateListener: ((snapshot: DesktopUpdaterSnapshot) => void) | undefined;
  const showMessageBox = input.showMessageBox
    ?? ((options: Electron.MessageBoxOptions) => dialog.showMessageBox(options));
  const locale = input.locale
    ?? (typeof app.getLocale === 'function' ? app.getLocale() : 'en');

  if (!isPackaged) {
    return createInactiveController(state);
  }

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  if (
    (input.platform ?? process.platform) === 'darwin'
    && (input.arch ?? process.arch) === 'x64'
  ) {
    updater.channel = 'latest-x64';
    updater.allowDowngrade = false;
  }

  const fail = async (
    context: string,
    error: unknown,
    recoverRuntime = false
  ) => {
    state = 'error';
    const message = error instanceof Error ? error.message : String(error);
    errorMessage = message;
    touchLastCheck();
    emit();
    input.logger.warn(context, { message });
    input.setAllowQuit?.(false);
    if (recoverRuntime && input.recoverAfterInstallFailure !== undefined) {
      await input.recoverAfterInstallFailure().catch(recoveryError => {
        input.logger.error('Desktop update recovery failed', {
          message: recoveryError instanceof Error
            ? recoveryError.message
            : String(recoveryError)
        });
      });
    }
  };

  const onError = (error: Error) => {
    const needsRecovery = state === 'preparing_install' || state === 'installing';
    if (needsRecovery) {
      void fail('Desktop updater emitted an install error', error, true);
    } else {
      state = 'error';
      errorMessage = error.message;
      touchLastCheck();
      emit();
      input.logger.warn('Desktop update operation failed', {
        message: error.message
      });
    }
  };
  const onNotAvailable = () => {
    if (state === 'checking') {
      state = 'idle';
      touchLastCheck();
      emit();
    }
  };
  const onBeforeQuitForUpdate = () => {
    if (disposed || state !== 'installing') return;
    // On macOS this precedes window closing; before-quit arrives afterwards.
    input.logger.info('Desktop updater is quitting for installation');
    input.beforeQuitForInstall?.();
  };
  const onAvailable = (info: { version: string }) => {
    if (disposed) return;
    if (state === 'checking') {
      // A check is still settling; show the prompt once it completes.
      pendingAvailableVersion = info.version;
      return;
    }
    if (isBusyState(state) || state === 'downloaded') return;
    showAvailablePrompt(info.version);
  };
  const showAvailablePrompt = (version: string) => {
    state = 'available';
    availableVersion = version;
    touchLastCheck();
    emit();
    activeOperation = (async () => {
      try {
        const copy = buildUpdateDialogCopy(locale, version, input.isCustomBuild === true);
        const choice = await showMessageBox({
          type: 'info',
          title: copy.title,
          message: copy.message,
          detail: copy.detail,
          buttons: [copy.updateLabel, copy.laterLabel],
          defaultId: input.isCustomBuild ? 1 : 0,
          cancelId: 1
        });
        if (choice.response !== 0 || disposed || state !== 'available') return;
        downloadRequested = true;
        state = 'downloading';
        emit();
        await updater.downloadUpdate();
      } catch (error) {
        await fail('Desktop update download failed', error);
      }
    })().finally(() => {
      activeOperation = undefined;
    });
  };
  const onDownloaded = (info: { version: string }) => {
    if (disposed || state === 'installing' || state === 'preparing_install') return;
    state = 'downloaded';
    availableVersion = info.version;
    touchLastCheck();
    emit();
    if (downloadRequested) {
      // One-click flow: the user already approved the update, install right
      // away without asking again.
      void beginInstall(info.version);
      return;
    }
    activeOperation = (async () => {
      try {
        const copy = buildReadyDialogCopy(locale, info.version, input.isCustomBuild === true);
        const choice = await showMessageBox({
          type: 'info',
          title: copy.title,
          message: copy.message,
          detail: copy.detail,
          buttons: [copy.updateLabel, copy.laterLabel],
          defaultId: input.isCustomBuild ? 1 : 0,
          cancelId: 1
        });
        if (choice.response !== 0 || disposed) return;
        await beginInstall(info.version);
      } catch (error) {
        await fail('Desktop update install failed', error, true);
      }
    })().finally(() => {
      activeOperation = undefined;
    });
  };

  updater.on('error', onError);
  updater.on('update-not-available', onNotAvailable);
  updater.on('update-available', onAvailable);
  updater.on('update-downloaded', onDownloaded);
  nativeUpdater.on('before-quit-for-update', onBeforeQuitForUpdate);

  const touchLastCheck = () => {
    lastCheckAt = new Date().toISOString();
    if (checkStore !== undefined) {
      try {
        checkStore.write({ lastCheckAt });
      } catch (error) {
        input.logger.warn('Desktop updater failed to persist the check timestamp', {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  const checkNow = async () => {
    if (
      disposed
      || activeOperation !== undefined
      || !['idle', 'error'].includes(state)
    ) {
      return;
    }
    state = 'checking';
    errorMessage = undefined;
    emit();
    try {
      await updater.checkForUpdates();
    } catch (error) {
      await fail('Desktop update request failed', error);
    }
    if (state === 'checking') {
      state = 'idle';
      touchLastCheck();
      emit();
    }
    if (pendingAvailableVersion !== undefined && state === 'idle' && !disposed) {
      const version = pendingAvailableVersion;
      pendingAvailableVersion = undefined;
      showAvailablePrompt(version);
    }
  };

  const beginInstall = async (version: string) => {
    try {
      state = 'preparing_install';
      emit();
      input.logger.info('Desktop update installation preparing', {
        version
      });
      await input.prepareInstall?.();
      input.setAllowQuit?.(true);
      state = 'installing';
      emit();
      updater.quitAndInstall(false, true);
    } catch (error) {
      downloadRequested = false;
      await fail('Desktop update install preparation failed', error, true);
    }
  };

  const getSnapshot = (): DesktopUpdaterSnapshot => ({
    state,
    ...(lastCheckAt === undefined ? {} : { lastCheckAt }),
    ...(availableVersion === undefined ? {} : { availableVersion }),
    ...(state === 'error' && errorMessage !== undefined
      ? { errorMessage }
      : {})
  });

  const emit = () => {
    stateListener?.(getSnapshot());
  };

  // Silent daily schedule: check once per day in the background; only a newly
  // available update produces a visible prompt.
  planNextCheck();

  function planNextCheck(): void {
    if (scheduledTimer !== undefined) clearTimeout(scheduledTimer);
    const elapsed = elapsedSinceLastCheck();
    const delay = lastCheckAt === undefined
      ? initialDelayMs
      : elapsed >= intervalMs
        ? initialDelayMs
        : Math.max(initialDelayMs, intervalMs - elapsed);
    scheduledTimer = setTimeout(() => {
      scheduledTimer = undefined;
      void checkNow().finally(() => {
        if (!disposed) planNextCheck();
      });
    }, delay);
    scheduledTimer.unref?.();
  }

  function elapsedSinceLastCheck(): number {
    if (lastCheckAt === undefined) return Number.POSITIVE_INFINITY;
    const parsed = Date.parse(lastCheckAt);
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : Date.now() - parsed;
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (scheduledTimer !== undefined) clearTimeout(scheduledTimer);
      updater.removeListener('error', onError);
      updater.removeListener('update-not-available', onNotAvailable);
      updater.removeListener('update-available', onAvailable);
      updater.removeListener('update-downloaded', onDownloaded);
      nativeUpdater.removeListener('before-quit-for-update', onBeforeQuitForUpdate);
    },
    checkNow,
    userInstallNow() {
      if (disposed) return;
      if (state === 'downloaded') {
        void beginInstall(availableVersion ?? '');
        return;
      }
      if (state === 'available' && availableVersion !== undefined) {
        if (activeOperation !== undefined) return;
        downloadRequested = true;
        state = 'downloading';
        emit();
        activeOperation = (async () => {
          try {
            await updater.downloadUpdate();
          } catch (error) {
            await fail('Desktop update download failed', error);
          }
        })().finally(() => {
          activeOperation = undefined;
        });
      }
    },
    getState: () => state,
    getSnapshot,
    onStateChange(listener) {
      stateListener = listener;
    }
  };
}

const BUSY_STATES: readonly DesktopUpdaterState[] = [
  'checking',
  'downloading',
  'preparing_install',
  'installing'
];

function defaultCheckStorePath(): string {
  try {
    return join(app.getPath('userData'), 'update-check.json');
  } catch {
    return join(process.cwd(), 'update-check.json');
  }
}

function createFileCheckStore(path: string): DesktopUpdateCheckStore {
  return {
    read(): DesktopUpdateCheckRecord {
      try {
        return JSON.parse(
          readFileSync(path, 'utf8')
        ) as DesktopUpdateCheckRecord;
      } catch {
        return {};
      }
    },
    write(record: DesktopUpdateCheckRecord): void {
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    }
  };
}

function isBusyState(state: DesktopUpdaterState): boolean {
  return BUSY_STATES.includes(state);
}

/**
 * Prefers the packaged feed configuration (app-update.yml, written by the
 * official NSIS installer). Unpacked or locally packaged builds ship without
 * it, so fall back to an explicit GitHub feed so the same update checks keep
 * working there.
 */
function resolveUpdaterWorker(input: {
  updater?: UpdaterLike;
  resourcesPath?: string;
  isPackaged?: boolean;
}): UpdaterLike {
  if (input.updater !== undefined) return input.updater;
  if ((input.isPackaged ?? app.isPackaged) !== true) {
    return electronUpdater.autoUpdater;
  }
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  if (resolveUpdaterFeedMode(resourcesPath) === 'packaged-config') {
    return electronUpdater.autoUpdater;
  }
  const updaterWithFeed = new electronUpdater.NsisUpdater({
    provider: 'github',
    owner: 'krillinai',
    repo: 'OpenCreator'
  });
  // electron-updater keeps reading resources/app-update.yml for the staged
  // download cache directory even when the feed is supplied in code; unpacked
  // builds have no such file, so install an in-memory substitute.
  (updaterWithFeed as unknown as { configOnDisk: unknown }).configOnDisk = {
    value: Promise.resolve({
      channel: 'latest',
      updaterCacheDirName: 'opencreator-updater'
    })
  };
  return updaterWithFeed;
}

export type DesktopUpdaterFeedMode = 'packaged-config' | 'explicit-github';

/**
 * The official NSIS installer writes app-update.yml next to the app; unpacked
 * or locally packaged builds do not, and must use an explicit GitHub feed.
 */
export function resolveUpdaterFeedMode(
  resourcesPath: string | undefined
): DesktopUpdaterFeedMode {
  const hasFeedConfig = typeof resourcesPath === 'string'
    && existsSync(join(resourcesPath, 'app-update.yml'));
  return hasFeedConfig ? 'packaged-config' : 'explicit-github';
}

function createInactiveController(_state: DesktopUpdaterState): DesktopUpdaterController {
  return {
    dispose() {},
    checkNow: async () => undefined,
    userInstallNow() {},
    getState: () => _state,
    getSnapshot: () => ({ state: _state }),
    onStateChange() {}
  };
}

type UpdateDialogCopy = {
  title: string;
  message: string;
  detail: string;
  updateLabel: string;
  laterLabel: string;
};

function buildUpdateDialogCopy(
  locale: string,
  version: string,
  isCustomBuild: boolean
): UpdateDialogCopy {
  const base = locale.startsWith('vi')
    ? {
        title: 'OpenCreator có bản cập nhật',
        message: `OpenCreator ${version} đã được phát hành`,
        detail: 'Cập nhật mới có thể tải về trong nền mà không làm gián đoạn tác vụ đang chạy.',
        updateLabel: 'Cập nhật ngay',
        laterLabel: 'Để sau'
      }
    : locale.startsWith('zh')
      ? {
          title: 'OpenCreator 有可用更新',
          message: `OpenCreator ${version} 已发布`,
          detail: '更新可在后台下载，不会中断正在进行的任务。',
          updateLabel: '立即更新',
          laterLabel: '稍后'
        }
      : {
          title: 'OpenCreator update',
          message: `OpenCreator ${version} is available`,
          detail: 'The update can download in the background without interrupting your current tasks.',
          updateLabel: 'Update now',
          laterLabel: 'Later'
        };
  if (isCustomBuild) {
    base.detail = `${base.detail}\n${buildCustomBuildWarning(locale)}`;
  }
  return base;
}

function buildReadyDialogCopy(
  locale: string,
  version: string,
  isCustomBuild: boolean
): UpdateDialogCopy {
  const base = locale.startsWith('vi')
    ? {
        title: 'OpenCreator bản cập nhật đã tải xong',
        message: `OpenCreator ${version} đã sẵn sàng để cài đặt`,
        detail: 'Việc cài đặt sẽ thoát ứng dụng và dừng Runtime cục bộ. Hãy chắc chắn không còn tác vụ nào cần chạy tiếp.',
        updateLabel: 'Cập nhật ngay',
        laterLabel: 'Để sau'
      }
    : locale.startsWith('zh')
      ? {
          title: 'OpenCreator 更新已下载',
          message: `OpenCreator ${version} 已准备就绪，可以安装`,
          detail: '安装将退出应用并停止本地 Runtime。请确认没有需要继续运行的任务。',
          updateLabel: '立即更新',
          laterLabel: '稍后'
        }
      : {
          title: 'Update downloaded',
          message: `OpenCreator ${version} is ready to install`,
          detail: 'Quitting to install will stop the local Runtime. Make sure no tasks need to keep running.',
          updateLabel: 'Update now',
          laterLabel: 'Later'
        };
  if (isCustomBuild) {
    base.detail = `${base.detail}\n${buildCustomBuildWarning(locale)}`;
  }
  return base;
}

function buildCustomBuildWarning(locale: string): string {
  if (locale.startsWith('vi')) {
    return 'Lưu ý: đang chạy bản build tuỳ biến có tính năng mở rộng (module Đăng đa kênh). Cài bản chính thức sẽ thay bằng bản gốc — các tính năng mở rộng đó sẽ mất. Nếu muốn giữ, hãy chọn "Để sau".';
  }
  if (locale.startsWith('zh')) {
    return '注意：当前运行的是包含扩展功能（多渠道发布模块）的自定义构建。安装官方版会替换为原版，这些扩展功能将丢失。如需保留请选择"稍后"。';
  }
  return 'Note: you are running a custom build with extra features (multi-channel publishing module). Installing the official release replaces them with the stock build and those features will be lost. Choose "Later" to keep them.';
}
