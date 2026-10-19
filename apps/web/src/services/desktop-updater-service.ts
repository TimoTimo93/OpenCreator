import type {
  HostBridge,
  HostUpdaterSnapshot,
  HostUpdaterState
} from '../host/bridge.js';

export type AppUpdaterSnapshot = {
  state: HostUpdaterState;
  lastCheckAt?: string;
  availableVersion?: string;
  errorMessage?: string;
};

export type AppUpdaterService = {
  read(): Promise<AppUpdaterSnapshot>;
  checkNow(): Promise<AppUpdaterSnapshot>;
  installNow(): Promise<void>;
  subscribe(listener: (snapshot: AppUpdaterSnapshot) => void): () => void;
};

export function createAppUpdaterService(hostBridge: HostBridge): AppUpdaterService | undefined {
  if (hostBridge.kind !== 'desktop' || hostBridge.readUpdaterState === undefined) {
    return undefined;
  }
  const read = hostBridge.readUpdaterState;
  const check = hostBridge.requestUpdaterCheck;
  const install = hostBridge.requestUpdaterInstall;
  const subscribe = hostBridge.subscribeUpdaterState;
  return {
    read: () => read(),
    checkNow: () => (check !== undefined ? check() : read()),
    installNow: () => install?.() ?? Promise.resolve(),
    subscribe: listener => subscribe?.(listener) ?? (() => undefined)
  };
}
