import { shouldApplyBootstrapState } from '../shared/bootstrap-state.js';
import type { DesktopBootstrapState as BootstrapState } from '../shared/types.js';

type BootstrapApi = {
  windowChrome?: {
    integratedTitleBar: boolean;
    titleBarHeight?: number;
    trafficLightInset?: number;
  };
  readBootstrapState(): Promise<BootstrapState>;
  subscribeBootstrapState(listener: (state: BootstrapState) => void): () => void;
  retryBootstrap(): Promise<unknown>;
  selectCodexPath(): Promise<unknown>;
  reloadWorkspace(): Promise<unknown>;
  restartRuntime(): Promise<unknown>;
  exportDiagnostics(): Promise<unknown>;
  quit(): Promise<void>;
  controlWindow?(action: 'close' | 'minimize' | 'zoom'): Promise<void>;
};

declare global {
  interface Window {
    opencreatorDesktop?: BootstrapApi;
  }
}

const api = window.opencreatorDesktop;
if (api === undefined) throw new Error('OpenCreator Desktop bridge is unavailable');
if (
  api.windowChrome?.integratedTitleBar === true
  && typeof api.windowChrome.titleBarHeight === 'number'
  && typeof api.windowChrome.trafficLightInset === 'number'
) {
  document.documentElement.dataset.integratedTitleBar = 'true';
  document.documentElement.style.setProperty(
    '--opencreator-titlebar-height',
    `${api.windowChrome.titleBarHeight}px`
  );
  document.documentElement.style.setProperty(
    '--opencreator-traffic-light-inset',
    `${api.windowChrome.trafficLightInset}px`
  );
  if (api.controlWindow !== undefined) {
    const controls = document.querySelector<HTMLElement>('.desktop-window-controls')!;
    controls.hidden = false;
    controls.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
      const action = button?.dataset.action;
      if (action === 'close' || action === 'minimize' || action === 'zoom') {
        void api.controlWindow!(action).catch(error => console.error('Failed to control desktop window', error));
      }
    });
  }
}

const title = element('status-title');
const detail = element('status-detail');
const elapsed = element('elapsed');
const statusMark = element('status-mark');
const progress = element('progress');
const progressFill = element('progress-fill');
const bootSteps = element('boot-steps');
const actions = element('failure-actions');
const workspaceActions = element('workspace-actions');
const technicalDetails = element('technical-details');
const codexPath = element('codex-path');
const codexHome = element('codex-home');
const errorCode = element('error-code');
const errorMessage = element('error-message');
const selectCodex = element('select-codex');
let currentState: BootstrapState | undefined;

const labels: Record<BootstrapState['phase'], [string, string]> = {
  idle: ['Đang chuẩn bị OpenCreator', 'Đang khởi tạo môi trường desktop'],
  resolving_codex: ['Đang định vị Codex', 'Đang đọc môi trường shell và đường dẫn đã lưu'],
  starting_daemon: ['Đang khởi động Runtime cục bộ', 'Đang tạo môi trường OpenCreator Runtime cô lập'],
  probing_codex: ['Đang kiểm tra tính sẵn sàng của Codex', 'Đang kiểm tra tiến trình Codex cục bộ'],
  starting_runtime: ['Đang mở OpenCreator', 'Đang tải dữ liệu cục bộ và tính năng Codex'],
  ready: ['Đang mở OpenCreator', 'Runtime cục bộ đã sẵn sàng'],
  workspace_failed: ['Không thể tải Bảng điều khiển', 'Runtime cục bộ vẫn đang chạy. Hãy tải lại Bảng điều khiển hoặc khởi động lại Runtime.'],
  failed: ['Codex CLI không khả dụng', 'OpenCreator không nhận được phản hồi hợp lệ. Vui lòng kiểm tra chẩn đoán và thử lại.']
};

/** Phản hồi thị giác cho thanh tiến trình (giá trị ước lượng theo pha). */
const PHASE_PERCENT: Record<BootstrapState['phase'], number> = {
  idle: 6,
  resolving_codex: 20,
  starting_daemon: 45,
  probing_codex: 68,
  starting_runtime: 88,
  ready: 100,
  workspace_failed: 100,
  failed: 100
};

/** Bước đang chạy trong dải 3 bước (0..2). */
const PHASE_STEP: Record<BootstrapState['phase'], number> = {
  idle: 0,
  resolving_codex: 0,
  starting_daemon: 1,
  probing_codex: 1,
  starting_runtime: 2,
  ready: 2,
  workspace_failed: 2,
  failed: 0
};

api.subscribeBootstrapState(render);
void api.readBootstrapState().then(render);

element('retry').addEventListener('click', () => void api.retryBootstrap());
element('select-codex').addEventListener('click', () => void api.selectCodexPath());
element('diagnostics').addEventListener('click', () => void api.exportDiagnostics());
element('quit').addEventListener('click', () => void api.quit());
element('reload-workspace').addEventListener('click', () => void api.reloadWorkspace());
element('restart-runtime').addEventListener('click', () => void api.restartRuntime());
element('workspace-diagnostics').addEventListener('click', () => void api.exportDiagnostics());
element('workspace-quit').addEventListener('click', () => void api.quit());

window.setInterval(() => {
  if (
    currentState === undefined
    || currentState.phase === 'ready'
    || currentState.phase === 'failed'
    || currentState.phase === 'workspace_failed'
  ) {
    elapsed.hidden = true;
    return;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(currentState.startedAt)) / 1000));
  elapsed.hidden = seconds < 3;
  elapsed.textContent = `Đang đợi ${seconds} giây...`;
}, 500);

function render(state: BootstrapState): void {
  if (!shouldApplyBootstrapState(currentState, state)) return;
  currentState = state;
  const [nextTitle, nextDetail] = state.phase === 'failed'
    ? failureLabel(state)
    : labels[state.phase];
  title.textContent = nextTitle;
  detail.textContent = nextDetail;
  const failed = state.phase === 'failed';
  const workspaceFailed = state.phase === 'workspace_failed';
  statusMark.dataset.failed = failed || workspaceFailed ? 'true' : 'false';
  const percent = PHASE_PERCENT[state.phase];
  progress.hidden = failed || workspaceFailed;
  progressFill.style.width = `${percent}%`;
  progress.setAttribute('aria-valuenow', String(percent));
  const activeStep = PHASE_STEP[state.phase];
  for (const [index, step] of Array.from(bootSteps.children).entries()) {
    step.setAttribute(
      'data-state',
      failed ? 'failed' : index < activeStep ? 'done' : index === activeStep ? 'active' : 'pending'
    );
  }
  actions.hidden = !failed;
  selectCodex.hidden = state.error?.code === 'RUNTIME_DATA_IN_USE';
  workspaceActions.hidden = !workspaceFailed;
  technicalDetails.hidden = !failed && !workspaceFailed;
  codexPath.textContent = state.codexBin ?? '-';
  codexHome.textContent = state.codexHome ?? '-';
  errorCode.textContent = state.error?.code ?? '-';
  errorMessage.textContent = state.error?.message ?? '';
}

function failureLabel(state: BootstrapState): [string, string] {
  if (state.error?.code === 'CODEX_NOT_FOUND') {
    return [
      'Không tìm thấy Codex CLI',
      'Đảm bảo codex chạy được trong terminal, hoặc chọn ứng dụng ChatGPT hoặc Codex.'
    ];
  }
  if (state.error?.code === 'CODEX_PATH_INVALID') {
    return ['Đường dẫn Codex đã chọn không khả dụng', state.error.message];
  }
  if (state.error?.code === 'RUNTIME_DATA_IN_USE') {
    return [
      'OpenCreator Runtime đang chạy',
      'Một phiên bản khác đang sử dụng cùng thư mục dữ liệu. Vui lòng đóng cửa sổ khác của phiên bản này và thử lại.'
    ];
  }
  return labels.failed;
}

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing bootstrap element: ${id}`);
  return value;
}

export {};
