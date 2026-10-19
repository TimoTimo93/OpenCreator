import {
  readOpenCreatorConfig,
  resolveStorageSettings,
  resolveUiSettings,
  updateOpenCreatorStorageSettings,
  updateOpenCreatorUiSettings,
  type OpenCreatorConfigSnapshot
} from '@opencreator/config';
import type {
  OpenCreatorStorageSettings,
  OpenCreatorStorageSettingsResponse,
  OpenCreatorUiSettingsResponse,
  UpdateOpenCreatorStorageSettingsRequest,
  UpdateOpenCreatorUiSettingsRequest
} from '@opencreator/protocol';
import { isAbsolute, join } from 'node:path';

export type OpenCreatorSettingsStore = ReturnType<typeof createOpenCreatorSettingsStore>;

export function createOpenCreatorSettingsStore(
  configFile: string,
  storageDefaults: OpenCreatorStorageSettings
) {
  return {
    readUi(): OpenCreatorUiSettingsResponse {
      const snapshot = readOpenCreatorConfig(configFile);
      return {
        settings: resolveUiSettings(snapshot),
        configured: snapshot.configured.ui
      };
    },
    updateUi(update: UpdateOpenCreatorUiSettingsRequest): OpenCreatorUiSettingsResponse {
      const snapshot = updateOpenCreatorUiSettings(configFile, update);
      return {
        settings: resolveUiSettings(snapshot),
        configured: true
      };
    },
    readStorage(): OpenCreatorStorageSettingsResponse {
      const snapshot = readOpenCreatorConfig(configFile);
      return {
        settings: resolveStorageSettingsWithDownloadRoot(snapshot, storageDefaults),
        configured: snapshot.configured.storage
      };
    },
    updateStorage(
      update: UpdateOpenCreatorStorageSettingsRequest
    ): OpenCreatorStorageSettingsResponse {
      const current = resolveStorageSettingsWithDownloadRoot(
        readOpenCreatorConfig(configFile),
        storageDefaults
      );
      const snapshot = updateOpenCreatorStorageSettings(configFile, { ...current, ...update });
      return {
        settings: resolveStorageSettingsWithDownloadRoot(snapshot, storageDefaults),
        configured: true
      };
    }
  };

  /**
   * Vị trí đầu ra mặc định đi theo "downloadRoot" (vị trí lưu video đã tải về)
   * khi người dùng chưa từng ghi đè outputRoot: exports ghi vào
   * <downloadRoot>/Exports. outputRoot đã tùy chỉnh được giữ nguyên.
   */
  function resolveStorageSettingsWithDownloadRoot(
    snapshot: OpenCreatorConfigSnapshot,
    defaults: OpenCreatorStorageSettings
  ): OpenCreatorStorageSettings {
    const settings = resolveStorageSettings(snapshot, defaults);
    const downloadRoot = readConfiguredDownloadRoot(snapshot);
    if (
      downloadRoot === undefined
      || settings.outputRoot !== defaults.outputRoot
    ) return settings;
    return { ...settings, outputRoot: join(downloadRoot, 'Exports') };
  }
}

function readConfiguredDownloadRoot(snapshot: OpenCreatorConfigSnapshot): string | undefined {
  const creatorServices = snapshot.document.creatorServices ?? {};
  const raw = creatorServices['downloadRoot'] ?? creatorServices['download_root'];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0) return undefined;
  if (!isAbsolute(value) && !value.startsWith('~')) return undefined;
  return value;
}
