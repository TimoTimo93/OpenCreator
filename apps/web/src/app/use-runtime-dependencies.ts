import type { CreatorRuntimeComponent, CreatorRuntimeComponentsResponse, CreatorYtDlpStatus, HongguoComponentStatus, OpenCreatorIssue } from '@opencreator/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePageIssueState } from '../features/issues/page-issue-state.js';
import type { RuntimeDependencyService } from '../services/runtime-dependency-service.js';

export type RuntimeDependencyPhase =
  | 'idle'
  | 'loading'
  | 'checking'
  | 'updating';

export type HongguoActionPhase = 'idle' | 'checking' | 'updating' | 'launching';

export type RuntimeDependenciesController = {
  componentsStatus?: CreatorRuntimeComponentsResponse;
  componentError?: string;
  refreshComponents?(): Promise<void>;
  downloadComponents?(componentId?: CreatorRuntimeComponent['id']): Promise<void>;
  ytDlpStatus?: CreatorYtDlpStatus;
  hongguoStatus?: HongguoComponentStatus;
  hongguoPhase?: HongguoActionPhase;
  phase: RuntimeDependencyPhase;
  /** @deprecated Runtime failures are exposed through issues. */
  error?: string;
  issues?: OpenCreatorIssue[];
  dismissIssue?(issueId: string): void;
  checkYtDlpUpdate(force?: boolean): Promise<CreatorYtDlpStatus>;
  updateYtDlp(): Promise<CreatorYtDlpStatus>;
  /** Checks the fork channel; with force it automatically downloads and applies a newer build. */
  checkHongguoUpdate?(force?: boolean): Promise<HongguoComponentStatus>;
  updateHongguo?(): Promise<HongguoComponentStatus>;
  launchHongguo?(): Promise<HongguoComponentStatus>;
  /** Raw runtime dependency service (drama discovery + component ops). */
  service?: RuntimeDependencyService;
};

export function useRuntimeDependencies(input: {
  connected: boolean;
  service: RuntimeDependencyService | null;
}): RuntimeDependenciesController {
  const [ytDlpStatus, setYtDlpStatus] = useState<CreatorYtDlpStatus>();
  const [hongguoStatus, setHongguoStatus] = useState<HongguoComponentStatus>();
  const [hongguoPhase, setHongguoPhase] = useState<HongguoActionPhase>('idle');
  const [componentsStatus, setComponentsStatus] = useState<CreatorRuntimeComponentsResponse>();
  const [componentError, setComponentError] = useState<string>();
  const componentsRef = useRef<CreatorRuntimeComponentsResponse>();
  const componentDownloadActive = componentsStatus?.components.some(component => ['downloading', 'verifying', 'extracting'].includes(component.state)) ?? false;
  const [phase, setPhase] = useState<RuntimeDependencyPhase>('idle');
  const pageIssues = usePageIssueState('runtime');
  const refreshComponents = useCallback(async () => {
    if (!input.connected || !input.service?.getComponentsStatus) return;
    try {
      const status = await input.service.getComponentsStatus();
      componentsRef.current = status;
      setComponentsStatus(status);
      setComponentError(undefined);
    } catch (error) {
      setComponentError(error instanceof Error ? error.message : 'Unable to read local components');
    }
  }, [input.connected, input.service]);

  useEffect(() => {
    if (!input.connected) { setComponentsStatus(undefined); return; }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refreshComponents();
      const busy = componentsRef.current?.components.some(component => ['downloading', 'verifying', 'extracting'].includes(component.state));
      if (!stopped) timer = setTimeout(() => { void poll(); }, busy ? 1000 : 15_000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [input.connected, refreshComponents, componentDownloadActive]);

  const downloadComponents = useCallback(async (componentId?: CreatorRuntimeComponent['id']) => {
    if (!input.connected || !input.service?.downloadComponents) return;
    try {
      const status = await input.service.downloadComponents(componentId);
      componentsRef.current = status;
      setComponentsStatus(status);
      setComponentError(undefined);
    } catch (error) {
      setComponentError(error instanceof Error ? error.message : 'Unable to download local components');
    }
  }, [input.connected, input.service]);

  useEffect(() => {
    let active = true;
    let operationId = 'runtime.load-yt-dlp';
    if (!input.connected || input.service === null) {
      setYtDlpStatus(undefined);
      setPhase('idle');
      pageIssues.clearIssues();
      return () => {
        active = false;
      };
    }

    setPhase('loading');
    void input.service.getYtDlpStatus()
      .then(async response => {
        if (!active) return;
        setYtDlpStatus(response.ytDlp);
        pageIssues.resolveOperation('runtime.load-yt-dlp');
        if (!response.ytDlp.checkDue) return;
        operationId = 'runtime.auto-check-yt-dlp';
        setPhase('checking');
        const checked = await input.service?.checkYtDlpUpdate(false);
        if (active && checked !== undefined) {
          setYtDlpStatus(checked.ytDlp);
          pageIssues.resolveOperation('runtime.auto-check-yt-dlp');
        }
      })
      .catch(caught => {
        if (active) {
          pageIssues.captureOperationFailure(
            operationId,
            caught,
            '无法读取或检查运行组件，请确认本地 Runtime 已连接后重试。',
            { retryable: true }
          );
        }
      })
      .finally(() => {
        if (active) setPhase('idle');
      });

    return () => {
      active = false;
    };
  }, [
    input.connected,
    input.service,
    pageIssues.captureOperationFailure,
    pageIssues.clearIssues,
    pageIssues.resolveOperation
  ]);

  const checkYtDlpUpdate = useCallback(async (force = true) => {
    if (!input.connected || input.service === null) {
      throw new Error('runtime_dependency_unavailable');
    }
    setPhase('checking');
    try {
      const response = await input.service.checkYtDlpUpdate(force);
      setYtDlpStatus(response.ytDlp);
      pageIssues.resolveOperation('runtime.check-yt-dlp');
      pageIssues.resolveOperation('runtime.auto-check-yt-dlp');
      pageIssues.resolveOperation('runtime.load-yt-dlp');
      return response.ytDlp;
    } catch (caught) {
      pageIssues.captureOperationFailure(
        'runtime.check-yt-dlp',
        caught,
        '检查运行组件更新失败，请稍后重试。',
        { retryable: true }
      );
      throw caught;
    } finally {
      setPhase('idle');
    }
  }, [input.connected, input.service, pageIssues.captureOperationFailure, pageIssues.resolveOperation]);

  const updateYtDlp = useCallback(async () => {
    if (!input.connected || input.service === null) {
      throw new Error('runtime_dependency_unavailable');
    }
    setPhase('updating');
    try {
      const response = await input.service.updateYtDlp();
      setYtDlpStatus(response.ytDlp);
      pageIssues.resolveOperation('runtime.update-yt-dlp');
      return response.ytDlp;
    } catch (caught) {
      pageIssues.captureOperationFailure(
        'runtime.update-yt-dlp',
        caught,
        '运行组件更新失败，请检查网络和磁盘空间后重试。',
        { retryable: true }
      );
      throw caught;
    } finally {
      setPhase('idle');
    }
  }, [input.connected, input.service, pageIssues.captureOperationFailure, pageIssues.resolveOperation]);

  // ---------------------------------------------------------------------------
  // Hongguo ("Phim ngắn Hồng Quả") third-party component
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let active = true;
    if (!input.connected || input.service === null) {
      setHongguoStatus(undefined);
      return () => { active = false; };
    }
    void input.service.getHongguoStatus()
      .then(async response => {
        if (!active) return;
        setHongguoStatus(response.hongguo);
        // Background freshness check (the manager caches it for 6 hours);
        // it only refreshes the manifest - downloading waits for the user's
        // explicit "Kiểm tra cập nhật" click.
        if (!response.hongguo.checkDue) return;
        const checked = await input.service?.checkHongguoUpdate(false);
        if (active && checked !== undefined) setHongguoStatus(checked.hongguo);
      })
      .catch(() => {
        // Older runtimes without hongguo routes simply render the card as unavailable.
        if (active) setHongguoStatus(undefined);
      });
    return () => { active = false; };
  }, [input.connected, input.service]);

  const updateHongguo = useCallback(async (): Promise<HongguoComponentStatus> => {
    if (!input.connected || input.service === null) {
      throw new Error('runtime_dependency_unavailable');
    }
    setHongguoPhase('updating');
    const token = { stopped: false };
    const pollTimer = setInterval(() => {
      if (token.stopped || input.service === null) return;
      void input.service.getHongguoStatus()
        .then(response => { if (!token.stopped) setHongguoStatus(response.hongguo); })
        .catch(() => undefined);
    }, 1500);
    try {
      const response = await input.service.updateHongguo();
      setHongguoStatus(response.hongguo);
      pageIssues.resolveOperation('runtime.update-hongguo');
      pageIssues.resolveOperation('runtime.check-hongguo');
      return response.hongguo;
    } catch (caught) {
      pageIssues.captureOperationFailure(
        'runtime.update-hongguo',
        caught,
        'Cập nhật thành phần Hồng Quả thất bại. Vui lòng kiểm tra mạng và dung lượng đĩa rồi thử lại.',
        { retryable: true }
      );
      try {
        const failed = await input.service.getHongguoStatus();
        setHongguoStatus(failed.hongguo);
      } catch {
        // keep the previous snapshot
      }
      throw caught;
    } finally {
      token.stopped = true;
      clearInterval(pollTimer);
      setHongguoPhase('idle');
    }
  }, [input.connected, input.service, pageIssues.captureOperationFailure, pageIssues.resolveOperation]);

  const checkHongguoUpdate = useCallback(async (force = true): Promise<HongguoComponentStatus> => {
    if (!input.connected || input.service === null) {
      throw new Error('runtime_dependency_unavailable');
    }
    setHongguoPhase('checking');
    try {
      const response = await input.service.checkHongguoUpdate(force);
      setHongguoStatus(response.hongguo);
      pageIssues.resolveOperation('runtime.check-hongguo');
      pageIssues.resolveOperation('runtime.auto-check-hongguo');
      // Product requirement: when the user presses "check for updates", a newer
      // build is downloaded and applied automatically - the artifact itself is
      // the Vietnamese fork build, so nothing can be lost during the update.
      if (force && response.hongguo.channelConfigured && response.hongguo.updateAvailable) {
        return await updateHongguo();
      }
      return response.hongguo;
    } catch (caught) {
      pageIssues.captureOperationFailure(
        'runtime.check-hongguo',
        caught,
        'Kiểm tra cập nhật thành phần Hồng Quả thất bại. Vui lòng thử lại.',
        { retryable: true }
      );
      try {
        const failed = await input.service.getHongguoStatus();
        setHongguoStatus(failed.hongguo);
      } catch {
        // keep the previous snapshot
      }
      throw caught;
    } finally {
      setHongguoPhase('idle');
    }
  }, [input.connected, input.service, pageIssues.captureOperationFailure, pageIssues.resolveOperation, updateHongguo]);

  const launchHongguo = useCallback(async (): Promise<HongguoComponentStatus> => {
    if (!input.connected || input.service === null) {
      throw new Error('runtime_dependency_unavailable');
    }
    setHongguoPhase('launching');
    try {
      const response = await input.service.launchHongguo();
      setHongguoStatus(response.hongguo);
      pageIssues.resolveOperation('runtime.launch-hongguo');
      return response.hongguo;
    } catch (caught) {
      pageIssues.captureOperationFailure(
        'runtime.launch-hongguo',
        caught,
        'Không mở được ứng dụng Hồng Quả. Vui lòng thử lại.',
        { retryable: true }
      );
      throw caught;
    } finally {
      setHongguoPhase('idle');
    }
  }, [input.connected, input.service, pageIssues.captureOperationFailure, pageIssues.resolveOperation]);

  return {
    componentsStatus, componentError, refreshComponents, downloadComponents,
    ytDlpStatus,
    hongguoStatus,
    hongguoPhase,
    phase,
    issues: pageIssues.issues,
    dismissIssue: pageIssues.dismissIssue,
    checkYtDlpUpdate,
    updateYtDlp,
    checkHongguoUpdate,
    updateHongguo,
    launchHongguo,
    service: input.service ?? undefined
  };
}
