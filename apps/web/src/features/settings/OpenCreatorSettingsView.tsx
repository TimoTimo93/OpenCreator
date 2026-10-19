import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, CircleCheck, CircleAlert, FolderOpen, KeyRound, Moon, Save, Sun } from 'lucide-react';
import type {
  CodexProfileListResponse,
  CodexStatusResponse,
  OpenCreatorStorageSettings
} from '@opencreator/protocol';
import { useConfirmDialog } from '../../components/dialogs/ConfirmDialogProvider.js';
import type { ColorMode } from '../../styles/color-mode.js';
import { useAppLanguage } from '../../i18n/LanguageProvider.js';
import { useLocalizedCopy } from '../../i18n/useLocalizedCopy.js';
import { appLanguageOptions, type AppLanguagePreference } from '../../i18n/language.js';
import {
  defaultAccentColor,
  defaultCustomAccentColor,
  normalizeHexColor,
  type AccentColor
} from '../../styles/accent-color.js';
import type { ProjectPermission } from '../projects/project-model.js';
import { ProfileSettingsView, type ProfileSettingsService } from './ProfileSettingsView.js';
import { CleanupSettingsView, type CleanupSettingsService } from './CleanupSettingsView.js';
import { DiagnosticsSettingsView } from './DiagnosticsSettingsView.js';
import type { CreatorServicesSection } from './CreatorServicesSettingsView.js';
import type { CreatorServicesSettingsService } from '../../services/creator-services-service.js';
import type { CodexRuntimeSettingsService } from './CodexRuntimeSettingsView.js';
import {
  MemorySettingsView,
  type MemoryScopeOption,
  type MemorySettingsService
} from './MemorySettingsView.js';
import type { RuntimeDependenciesController } from '../../app/use-runtime-dependencies.js';
import { RuntimeComponentsSettingsView } from './RuntimeComponentsSettingsView.js';
import './settings-management.css';
import type { OpenCreatorSettingsService } from '../../services/opencreator-settings-service.js';
import type { AppUpdaterService, AppUpdaterSnapshot } from '../../services/desktop-updater-service.js';
import { IssueList } from '../issues/IssuePresenter.js';
import { usePageIssueState } from '../issues/page-issue-state.js';
import './gateway-account-settings.css';
import type { SettingsRouteTab } from '../../app/routes.js';
import type { GatewayAccountSettingsService } from '../../services/gateway-account-service.js';
import type { GatewayAccountState } from '@opencreator/protocol';
import { OfficialServicesSettingsView } from './OfficialServicesSettingsView.js';
import { NetworkSettings } from './NetworkSettings.js';
import { PlatformConnectionsSettingsView } from './PlatformConnectionsSettingsView.js';
import type { PlatformConnectionsService } from '../../services/platform-connections-service.js';

const CreatorServicesSettingsView = lazy(async () => {
  const module = await import('./CreatorServicesSettingsView.js');
  return { default: module.CreatorServicesSettingsView };
});

const CreatorApiKeysSettingsView = lazy(async () => {
  const module = await import('./CreatorApiKeysSettingsView.js');
  return { default: module.CreatorApiKeysSettingsView };
});

export type RuntimeStatus = {
  connected: boolean;
  appVersion?: string;
  runtimeVersion?: string;
  codexVersion?: string;
  codexPath?: string;
  codexHome?: string;
  lastCheckedAt?: string;
};

export type DefaultPermissionPreference = 'follow-project' | ProjectPermission;

export type OpenCreatorSettingsViewProps = {
  runtimeStatus: RuntimeStatus;
  updaterService?: AppUpdaterService | null;
  defaultPermission?: DefaultPermissionPreference;
  defaultPermissionError?: string;
  onDefaultPermissionChange?(permission: DefaultPermissionPreference): void;
  colorMode?: ColorMode;
  onColorModeChange?(mode: ColorMode): void;
  accentColor?: AccentColor;
  onAccentColorChange?(color: AccentColor): void;
  customAccentColor?: string;
  onCustomAccentColorChange?(color: string): void;
  desktopCloseBehavior?: 'hide' | 'quit';
  onDesktopCloseBehaviorChange?(behavior: 'hide' | 'quit'): void;
  desktopTelemetryEnabled?: boolean;
  onDesktopTelemetryEnabledChange?(enabled: boolean): void;
  profileService?: ProfileSettingsService | null;
  profileData?: CodexProfileListResponse;
  onProfileDataChange?(data: CodexProfileListResponse): void;
  cleanupService?: CleanupSettingsService | null;
  creatorServicesService?: CreatorServicesSettingsService | null;
  platformConnectionsService?: PlatformConnectionsService | null;
  gatewayAccountService?: GatewayAccountSettingsService | null;
  gatewayAccountState?: GatewayAccountState;
  onGatewayStateChange?(state: GatewayAccountState): void;
  openExternal?(url: string): Promise<void> | void;
  codexRuntimeService?: CodexRuntimeSettingsService | null;
  agentSetupNeeded?: boolean;
  onOpenAgentSetup?(): void;
  memoryService?: MemorySettingsService | null;
  memoryProjects?: MemoryScopeOption[];
  memoryThreads?: MemoryScopeOption[];
  runtimeDependencies?: RuntimeDependenciesController;
  storageSettingsService?: Pick<OpenCreatorSettingsService, 'getStorageSettings' | 'updateStorageSettings'> | null;
  onSelectStorageDirectory?(purpose: 'default-project-root' | 'output-root' | 'download-root'): Promise<string | null>;
  codexStatus?: CodexStatusResponse;
  initialTab?: 'general' | SettingsRouteTab;
  initialSection?: CreatorServicesSection;
  componentId?: string;
  returnToTranslation?: boolean;
  onBack(): void;
};

type SettingsTab =
  | 'general'
  | 'ai-services'
  | 'api-keys'
  | 'platform-connections'
  | 'local-components'
  | 'plugins'
  | 'memory'
  | 'profiles'
  | 'cleanup'
  | 'diagnostics'
  | 'about';

export function OpenCreatorSettingsView(props: OpenCreatorSettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => props.initialTab ?? 'general');
  const [gatewayState, setGatewayState] = useState<GatewayAccountState>();
  // Ghi đè mục đang mở của trang cài đặt dịch vụ AI khi người dùng bấm nút
  // "Cấu hình API" (thay cho lối đăng nhập OpenCreator cũ).
  const [apiSection, setApiSection] = useState<CreatorServicesSection | undefined>(props.initialSection);
  const { t } = useAppLanguage();
  const l = useLocalizedCopy();
  const officialMode = gatewayState !== undefined && (gatewayState.source === 'gateway' || gatewayState.authState !== 'signed_out');
  const officialConnected = gatewayState?.authState === 'signed_in' && gatewayState.source === 'gateway' && gatewayState.activationState === 'ready';
  const officialStatus = gatewayState?.authState === 'expired' ? l('登录已过期', 'Session expired')
    : gatewayState?.authState === 'authorizing' ? l('正在登录', 'Signing in')
    : gatewayState?.authState === 'signing_out' ? l('正在退出登录…', 'Signing out…')
    : gatewayState?.authState !== 'signed_in' ? l('未登录', 'Signed out')
    : gatewayState.activationState === 'loading' ? l('正在连接', 'Connecting')
    : officialConnected ? l('已连接', 'Connected') : l('暂不可用', 'Unavailable');
  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'general', label: t('settings.tab.general') },
    { id: 'ai-services', label: t('settings.tab.aiServices') },
    { id: 'api-keys', label: l('API 配置', 'API configuration') },
    { id: 'platform-connections', label: l('平台连接', 'Platform connections') },
    { id: 'local-components', label: t('settings.tab.runtimeComponents') },
    { id: 'plugins', label: t('settings.tab.plugins') },
    { id: 'memory', label: t('settings.tab.memory') },
    { id: 'profiles', label: t('settings.tab.profiles') },
    { id: 'cleanup', label: t('settings.tab.cleanup') },
    { id: 'diagnostics', label: t('settings.tab.diagnostics') },
    { id: 'about', label: t('settings.tab.about') }
  ];

  useEffect(() => {
    if (props.initialTab !== undefined) setActiveTab(props.initialTab);
  }, [props.initialTab]);

  useEffect(() => {
    if (props.initialSection !== undefined) setApiSection(props.initialSection);
  }, [props.initialSection]);

  useEffect(() => {
    if (props.gatewayAccountState) { setGatewayState(props.gatewayAccountState); return; }
    let canceled = false;
    void props.gatewayAccountService?.getState().then(next => { if (!canceled) setGatewayState(next); }).catch(() => undefined);
    return () => { canceled = true; };
  }, [props.gatewayAccountService, props.gatewayAccountState]);

  /**
   * "Cấu hình API" (thay lối đăng nhập OpenCreator cũ): mở thẳng mục Cấu hình API
   * trong Cài đặt — nơi quản lý danh sách API Key Agnes AI và ElevenLabs. Trang có
   * thể đang ở sẵn mục đó nên phải có phản hồi thấy được — cuộn tới khối khoá rồi
   * nhấp nháy viền.
   */
  const revealApiSection = useCallback(() => {
    const reveal = (attempt = 0) => {
      const panel = document.getElementById('creator-api-keys-panel');
      if (panel === null) {
        if (attempt < 8) window.setTimeout(() => reveal(attempt + 1), 60);
        return;
      }
      if (typeof panel.scrollIntoView === 'function') {
        panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      panel.dataset.highlight = 'true';
      window.setTimeout(() => { delete panel.dataset.highlight; }, 1800);
    };
    window.setTimeout(() => reveal(), 60);
  }, []);

  const openApiConfiguration = useCallback(() => {
    setActiveTab('api-keys');
    revealApiSection();
  }, [revealApiSection]);
  // Nút "Cấu hình API" ở thanh bên có thể bấm khi trang cài đặt đã mở sẵn ở đúng
  // mục: lúc đó route không đổi nên React không render lại, phải tự cuộn/nhấp nháy
  // để người dùng thấy phản hồi.
  useEffect(() => {
    const onRequest = () => openApiConfiguration();
    window.addEventListener('opencreator:open-api-configuration', onRequest);
    return () => window.removeEventListener('opencreator:open-api-configuration', onRequest);
  }, [openApiConfiguration]);

  const modeControls = props.gatewayAccountService && gatewayState ? (
    <div className={`gateway-account ai-services-mode${officialMode ? ' ai-services-mode--official' : ''}`}>
      <span className="ai-services-mode__label">{l('使用模式', 'Usage mode')}</span>
      <strong>{officialMode ? l('官方服务', 'Official service') : l('自定义配置', 'Custom configuration')}</strong>
      {!officialMode ? <button type="button" onClick={openApiConfiguration}><KeyRound size={15} aria-hidden="true"/>{l('配置 API', 'Configure API')}</button> : null}
    </div>
  ) : null;

  return (
    <div className="settings-page">
      <aside className="settings-sidebar" aria-label={t('settings.navigation')}>
        <button className="settings-back" type="button" onClick={props.onBack}>
          {t('settings.back')}
        </button>
        <nav className="settings-nav" aria-label={t('settings.categories')}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              aria-current={activeTab === tab.id ? 'page' : undefined}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="settings-nav-label">
                {tab.label}
                {tab.id === 'ai-services' && !officialMode ? (
                  <small className="settings-nav-required">{t('settings.required')}</small>
                ) : null}
                {tab.id === 'local-components'
                  && props.runtimeDependencies?.ytDlpStatus?.updateAvailable ? (
                    <span
                      className="settings-nav-update-dot"
                      aria-label={t('settings.runtimeComponents.updateAvailable')}
                    />
                  ) : null}
              </span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="opencreator-scroll-page settings-content">
        {activeTab === 'general' ? (
          <GeneralSettings
            creatorServicesService={props.creatorServicesService}
            connected={props.runtimeStatus.connected}
            defaultPermission={props.defaultPermission ?? 'follow-project'}
            defaultPermissionError={props.defaultPermissionError}
            onDefaultPermissionChange={props.onDefaultPermissionChange}
            colorMode={props.colorMode ?? 'dark'}
            onColorModeChange={props.onColorModeChange}
            accentColor={props.accentColor ?? defaultAccentColor}
            onAccentColorChange={props.onAccentColorChange}
            customAccentColor={props.customAccentColor ?? defaultCustomAccentColor}
            onCustomAccentColorChange={props.onCustomAccentColorChange}
            desktopCloseBehavior={props.desktopCloseBehavior}
            onDesktopCloseBehaviorChange={props.onDesktopCloseBehaviorChange}
            desktopTelemetryEnabled={props.desktopTelemetryEnabled}
            onDesktopTelemetryEnabledChange={props.onDesktopTelemetryEnabledChange}
            storageSettingsService={props.storageSettingsService}
            onSelectStorageDirectory={props.onSelectStorageDirectory}
          />
        ) : null}
        {activeTab === 'ai-services' ? (
          <>
            {officialMode && gatewayState ? <section className="settings-section gateway-account official-services-settings" aria-labelledby="official-services-title">
              <header className="official-services-heading">
                <div>
                  <h1 id="official-services-title">{l('AI 服务', 'AI services')}</h1>
                  <p className={`official-services-status${officialConnected ? ' is-ready' : ''}`} role="status">
                    {officialConnected ? <CircleCheck size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
                    {officialStatus}
                  </p>
                </div>
              </header>
              {modeControls}
              {props.gatewayAccountService ? <OfficialServicesSettingsView state={gatewayState} service={props.gatewayAccountService} onChange={next => { setGatewayState(next); props.onGatewayStateChange?.(next); }} /> : null}
            </section> : null}
            <Suspense fallback={
              <p role="status">{l('正在加载 AI 服务设置…', 'Loading AI service settings…')}</p>
            }>
              {props.gatewayAccountService && gatewayState === undefined ? <p role="status">{l('正在检查使用模式…', 'Checking usage mode…')}</p> : !officialMode ? <CreatorServicesSettingsView
                connected={props.runtimeStatus.connected}
                service={props.creatorServicesService ?? null}
                modelService={props.codexRuntimeService ?? null}
                initialSection={apiSection}
                modeControls={<>
                  {modeControls}
                  {props.agentSetupNeeded && props.onOpenAgentSetup !== undefined ? (
                    <div className="settings-inline-warning" role="status">
                      {l('Agent 尚未配置，无法发送任务。', 'Agent is not configured; tasks cannot be sent.')}
                      {' '}
                      <button className="settings-secondary-button" type="button" onClick={props.onOpenAgentSetup}>
                        {l('配置 Agent', 'Set up Agent')}
                      </button>
                    </div>
                  ) : null}
                </>}
              /> : null}
            </Suspense>
          </>
        ) : null}
        {activeTab === 'api-keys' ? (
          <Suspense fallback={
            <p role="status">{l('正在加载 API Key 列表…', 'Loading API keys…')}</p>
          }>
            <CreatorApiKeysSettingsView
              connected={props.runtimeStatus.connected}
              service={props.creatorServicesService ?? null}
            />
          </Suspense>
        ) : null}
        {activeTab === 'local-components' && props.runtimeDependencies !== undefined ? (
          <RuntimeComponentsSettingsView
            componentId={props.componentId}
            onReturn={props.returnToTranslation ? props.onBack : undefined}
            connected={props.runtimeStatus.connected}
            controller={props.runtimeDependencies}
          />
        ) : null}
        {activeTab === 'platform-connections' ? <PlatformConnectionsSettingsView connected={props.runtimeStatus.connected} service={props.platformConnectionsService} /> : null}
        {activeTab === 'plugins' ? <PluginSettings runtimeStatus={props.runtimeStatus} /> : null}
        {activeTab === 'memory' ? (
          <MemorySettingsView
            connected={props.runtimeStatus.connected}
            service={props.memoryService ?? null}
            projects={props.memoryProjects ?? []}
            threads={props.memoryThreads ?? []}
          />
        ) : null}
        {activeTab === 'profiles' ? (
          <ProfileSettingsView
            connected={props.runtimeStatus.connected}
            service={props.profileService ?? null}
            data={props.profileData}
            onDataChange={props.onProfileDataChange}
          />
        ) : null}
        {activeTab === 'cleanup' ? (
          <CleanupSettingsView
            connected={props.runtimeStatus.connected}
            service={props.cleanupService ?? null}
          />
        ) : null}
        {activeTab === 'diagnostics' ? (
          <DiagnosticsSettingsView
            connected={props.runtimeStatus.connected}
            runtimeVersion={props.runtimeStatus.runtimeVersion}
            codexStatus={props.codexStatus}
          />
        ) : null}
        {activeTab === 'about' ? (
          <AboutSettings runtimeStatus={props.runtimeStatus} updaterService={props.updaterService} />
        ) : null}
      </main>
    </div>
  );
}

function GeneralSettings(props: {
  creatorServicesService?: CreatorServicesSettingsService | null;
  connected: boolean;
  defaultPermission: DefaultPermissionPreference;
  defaultPermissionError?: string;
  onDefaultPermissionChange?(permission: DefaultPermissionPreference): void;
  colorMode: ColorMode;
  onColorModeChange?(mode: ColorMode): void;
  accentColor: AccentColor;
  onAccentColorChange?(color: AccentColor): void;
  customAccentColor: string;
  onCustomAccentColorChange?(color: string): void;
  desktopCloseBehavior?: 'hide' | 'quit';
  onDesktopCloseBehaviorChange?(behavior: 'hide' | 'quit'): void;
  desktopTelemetryEnabled?: boolean;
  onDesktopTelemetryEnabledChange?(enabled: boolean): void;
  storageSettingsService?: Pick<OpenCreatorSettingsService, 'getStorageSettings' | 'updateStorageSettings'> | null;
  onSelectStorageDirectory?(purpose: 'default-project-root' | 'output-root' | 'download-root'): Promise<string | null>;
}) {
  const { language, preference, setPreference, t } = useAppLanguage();
  const confirm = useConfirmDialog();
  const l = useLocalizedCopy();
  const [storage, setStorage] = useState<OpenCreatorStorageSettings>();
  const [storageDraft, setStorageDraft] = useState<OpenCreatorStorageSettings>();
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageReloadToken, setStorageReloadToken] = useState(0);
  const [downloadRoot, setDownloadRoot] = useState<string>();
  const [downloadRootDraft, setDownloadRootDraft] = useState<string>();
  const [downloadRootBusy, setDownloadRootBusy] = useState(false);
  const pageIssues = usePageIssueState('settings-general');

  useEffect(() => {
    if (props.defaultPermissionError === undefined) {
      pageIssues.resolveOperation('settings.default-permission.sync');
      return;
    }
    pageIssues.captureOperationFailure(
      'settings.default-permission.sync',
      new Error(props.defaultPermissionError),
      l('默认权限同步失败，重新打开相关会话后会重试。', 'Default permission sync failed. Reopen the affected session to retry.')
    );
  }, [
    l,
    pageIssues.captureOperationFailure,
    pageIssues.resolveOperation,
    props.defaultPermissionError
  ]);

  useEffect(() => {
    let canceled = false;
    void props.storageSettingsService?.getStorageSettings()
      .then(response => {
        if (!canceled) {
          setStorage(response.settings);
          setStorageDraft(response.settings);
          pageIssues.resolveOperation('settings.storage.load');
        }
      })
      .catch(cause => {
        if (!canceled) pageIssues.captureOperationFailure(
          'settings.storage.load',
          cause,
          l('无法读取存储位置，请重试。', 'Unable to load storage locations. Try again.'),
          { retryable: true }
        );
      });
    return () => { canceled = true; };
  }, [
    l,
    pageIssues.captureOperationFailure,
    pageIssues.resolveOperation,
    props.storageSettingsService,
    storageReloadToken
  ]);

  async function saveStorageDirectory(
    key: keyof OpenCreatorStorageSettings,
    selectedValue?: string
  ) {
    if (props.storageSettingsService === null || props.storageSettingsService === undefined) return;
    const value = (selectedValue ?? storageDraft?.[key] ?? '').trim();
    if (value.length === 0 || value === storage?.[key]) return;
    setStorageBusy(true);
    const operationId = `settings.storage.save:${key}`;
    try {
      const response = await props.storageSettingsService.updateStorageSettings({ [key]: value });
      setStorage(response.settings);
      setStorageDraft(response.settings);
      pageIssues.resolveOperation(operationId);
    } catch (cause) {
      pageIssues.captureOperationFailure(
        operationId,
        cause,
        l(
          '无法保存存储位置，请填写可创建且可写的绝对目录后重试。',
          'Unable to save the storage location. Enter a writable absolute path and retry.'
        ),
        { retryable: true }
      );
    } finally {
      setStorageBusy(false);
    }
  }

  async function selectStorageDirectory(key: keyof OpenCreatorStorageSettings) {
    if (
      props.onSelectStorageDirectory === undefined
    ) return;
    const operationId = `settings.storage.select:${key}`;
    try {
      const selected = await props.onSelectStorageDirectory(
        key === 'defaultProjectRoot' ? 'default-project-root' : 'output-root'
      );
      if (selected === null) return;
      pageIssues.resolveOperation(operationId);
      setStorageDraft(current => current === undefined ? current : { ...current, [key]: selected });
      await saveStorageDirectory(key, selected);
    } catch (cause) {
      pageIssues.captureOperationFailure(
        operationId,
        cause,
        l('无法选择存储目录，请重试。', 'Unable to select a storage directory. Try again.')
      );
    }
  }

  useEffect(() => {
    let canceled = false;
    const service = props.creatorServicesService;
    if (service === null || service === undefined) return;
    if (typeof service.getDownloadRoot !== 'function') return;
    void service.getDownloadRoot()
      .then(response => {
        if (canceled) return;
        setDownloadRoot(response.downloadRoot);
        setDownloadRootDraft(response.downloadRoot);
      })
      .catch(() => {
        if (!canceled) {
          setDownloadRoot(undefined);
          setDownloadRootDraft(undefined);
        }
      });
    return () => { canceled = true; };
  }, [props.creatorServicesService]);

  async function saveDownloadRoot(selectedValue?: string) {
    const service = props.creatorServicesService;
    if (service === null || service === undefined) return;
    const value = (selectedValue ?? downloadRootDraft ?? '').trim();
    if (value === (downloadRoot ?? '')) return;
    setDownloadRootBusy(true);
    try {
      const response = await service.saveDownloadRoot(value);
      setDownloadRoot(response.downloadRoot);
      setDownloadRootDraft(response.downloadRoot);
    } catch (cause) {
      pageIssues.captureOperationFailure(
        'settings.download-root.save',
        cause,
        l(
          '无法保存视频保存位置，请填写可创建且可写的绝对目录后重试。',
          'Unable to save the downloaded video location. Enter a writable absolute path and retry.'
        ),
        { retryable: true }
      );
    } finally {
      setDownloadRootBusy(false);
    }
  }

  async function selectDownloadRoot() {
    if (props.onSelectStorageDirectory === undefined) return;
    try {
      const selected = await props.onSelectStorageDirectory('download-root');
      if (selected === null) return;
      setDownloadRootDraft(selected);
      await saveDownloadRoot(selected);
    } catch (cause) {
      pageIssues.captureOperationFailure(
        'settings.download-root.select',
        cause,
        l('无法选择存储目录，请重试。', 'Unable to select a storage directory. Try again.')
      );
    }
  }
  const defaultPermissionOptions: Array<{
    value: DefaultPermissionPreference;
    label: string;
  }> = [
    { value: 'follow-project', label: t('settings.permission.followProject') },
    { value: 'workspace-write', label: t('settings.permission.approval') },
    { value: 'danger-full-access', label: t('settings.permission.fullAccess') }
  ];
  const languageName = appLanguageOptions.find(option => option.value === language)?.label ?? 'English';
  const languageOptions: Array<{ value: AppLanguagePreference; label: string }> = [
    {
      value: 'system',
      label: t('settings.language.system', { language: languageName })
    },
    ...appLanguageOptions
  ];

  return (
    <section className="settings-section" aria-labelledby="settings-general-title">
      <header>
        <h1 id="settings-general-title">{t('settings.tab.general')}</h1>
        <p>{t('settings.general.description')}</p>
      </header>
      <div className="settings-card">
        <NetworkSettings service={props.creatorServicesService} connected={props.connected} />
        {storage === undefined || storageDraft === undefined ? null : (
          <>
            <StorageDirectoryRow
              id="settings-default-project-root"
              label={l('默认项目位置', 'Default project location')}
              value={storageDraft.defaultProjectRoot}
              savedValue={storage.defaultProjectRoot}
              disabled={storageBusy}
              onChange={value => setStorageDraft(current => current === undefined
                ? current
                : { ...current, defaultProjectRoot: value })}
              onSave={() => void saveStorageDirectory('defaultProjectRoot')}
              onSelect={props.onSelectStorageDirectory === undefined
                ? undefined
                : () => void selectStorageDirectory('defaultProjectRoot')}
            />
            <StorageDirectoryRow
              id="settings-output-root"
              label={l('完成产物位置', 'Completed output location')}
              value={storageDraft.outputRoot}
              savedValue={storage.outputRoot}
              disabled={storageBusy}
              onChange={value => setStorageDraft(current => current === undefined
                ? current
                : { ...current, outputRoot: value })}
              onSave={() => void saveStorageDirectory('outputRoot')}
              onSelect={props.onSelectStorageDirectory === undefined
                ? undefined
                : () => void selectStorageDirectory('outputRoot')}
            />
            {downloadRootDraft === undefined ? null : (
              <StorageDirectoryRow
                id="settings-download-root"
                label={l('视频保存位置', 'Downloaded video location')}
                value={downloadRootDraft}
                savedValue={downloadRoot ?? ''}
                allowEmpty
                placeholder={l('默认：Documents/OpenCreator', 'Default: Documents/OpenCreator')}
                disabled={downloadRootBusy}
                onChange={setDownloadRootDraft}
                onSave={() => void saveDownloadRoot()}
                onSelect={props.onSelectStorageDirectory === undefined
                  ? undefined
                  : () => void selectDownloadRoot()}
              />
            )}
          </>
        )}
        <SettingsColorModeRow
          value={props.colorMode}
          onChange={(mode) => props.onColorModeChange?.(mode)}
        />
        <SettingsAccentColorRow
          value={props.accentColor}
          customColor={props.customAccentColor}
          onChange={(color) => props.onAccentColorChange?.(color)}
          onCustomColorChange={(color) => props.onCustomAccentColorChange?.(color)}
        />
        <SettingsSelectRow
          id="settings-default-permission"
          label={t('settings.permission')}
          value={props.defaultPermission}
          options={defaultPermissionOptions}
          onChange={async permission => {
            if (
              permission === 'danger-full-access'
              && props.defaultPermission !== 'danger-full-access'
              && !await confirm({
                title: t('composer.fullAccess.title'),
                description: t('composer.fullAccess.description'),
                confirmLabel: t('composer.fullAccess.confirm')
              })
            ) {
              return;
            }
            props.onDefaultPermissionChange?.(permission);
          }}
        />
        <SettingsRow label={t('settings.defaultFileApp')} value={t('settings.systemDefaultApp')} />
        <SettingsSelectRow
          id="settings-display-language"
          label={t('settings.language')}
          value={preference}
          options={languageOptions}
          onChange={setPreference}
        />
        {props.desktopCloseBehavior === undefined ? (
          <SettingsRow label={t('settings.menuBar')} value={t('settings.browserMode')} />
        ) : (
          <label className="settings-row settings-control-row" htmlFor="settings-desktop-close-behavior">
            <span>{t('settings.closeWindow')}</span>
            <select
              id="settings-desktop-close-behavior"
              className="settings-select"
              value={props.desktopCloseBehavior}
              onChange={event => props.onDesktopCloseBehaviorChange?.(
                event.target.value as 'hide' | 'quit'
              )}
            >
              <option value="hide">{t('settings.hideToMenuBar')}</option>
              <option value="quit">{t('settings.quit')}</option>
            </select>
          </label>
        )}
        {props.desktopTelemetryEnabled === undefined ? null : (
          <label className="settings-row settings-control-row" htmlFor="settings-desktop-telemetry">
            <span>
              {t('settings.telemetry')}
              <small className="settings-row-description">
                {t('settings.telemetryDescription')}
              </small>
            </span>
            <input
              id="settings-desktop-telemetry"
              className="settings-switch"
              type="checkbox"
              role="switch"
              checked={props.desktopTelemetryEnabled}
              onChange={event => props.onDesktopTelemetryEnabledChange?.(event.target.checked)}
            />
          </label>
        )}
      </div>
      <IssueList
        issues={pageIssues.issues}
        actions={{ retryOperations: {
          'settings.storage.load': () => setStorageReloadToken(value => value + 1),
          'settings.storage.save:defaultProjectRoot': () => saveStorageDirectory('defaultProjectRoot'),
          'settings.storage.save:outputRoot': () => saveStorageDirectory('outputRoot')
        } }}
        onDismiss={pageIssues.dismissIssue}
      />
    </section>
  );
}

function StorageDirectoryRow(props: {
  id: string;
  label: string;
  value: string;
  savedValue: string;
  disabled: boolean;
  /** Cho phép lưu giá trị rỗng (quay về vị trí mặc định). */
  allowEmpty?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onSelect?: () => void;
}) {
  const trimmed = props.value.trim();
  const dirty = trimmed !== props.savedValue
    && (props.allowEmpty === true || trimmed.length > 0);
  return (
    <div className="settings-row settings-control-row settings-directory-row">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        className="settings-directory-input"
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={event => props.onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && dirty) props.onSave();
        }}
      />
      <span className="settings-directory-actions">
        <button
          type="button"
          className="icon-button"
          aria-label={`Save ${props.label}`}
          title={`Save ${props.label}`}
          disabled={props.disabled || !dirty}
          onClick={props.onSave}
        >
          <Save size={17} aria-hidden="true" />
        </button>
        {props.onSelect === undefined ? null : <button
          type="button"
          className="icon-button"
          aria-label={`Select ${props.label}`}
          title={`Select ${props.label}`}
          disabled={props.disabled}
          onClick={props.onSelect}
        >
          <FolderOpen size={17} aria-hidden="true" />
        </button>}
      </span>
    </div>
  );
}

function SettingsColorModeRow(props: { value: ColorMode; onChange(mode: ColorMode): void }) {
  const labelId = 'settings-color-mode-label';
  const { t } = useAppLanguage();

  return (
    <div className="settings-row settings-control-row">
      <span id={labelId}>{t('settings.colorMode')}</span>
      <div className="settings-color-mode" role="group" aria-labelledby={labelId}>
        <button
          type="button"
          aria-pressed={props.value === 'light'}
          onClick={() => props.onChange('light')}
        >
          <Sun size={14} aria-hidden="true" />
          {t('settings.light')}
        </button>
        <button
          type="button"
          aria-pressed={props.value === 'dark'}
          onClick={() => props.onChange('dark')}
        >
          <Moon size={14} aria-hidden="true" />
          {t('settings.dark')}
        </button>
      </div>
    </div>
  );
}

function SettingsAccentColorRow(props: {
  value: AccentColor;
  customColor: string;
  onChange(color: AccentColor): void;
  onCustomColorChange(color: string): void;
}) {
  const { t } = useAppLanguage();
  const labelId = 'settings-accent-color-label';
  const inputId = 'settings-custom-accent-color';
  const normalizedCustomColor = normalizeHexColor(props.customColor) ?? defaultCustomAccentColor;
  const [draft, setDraft] = useState(normalizedCustomColor);
  const [error, setError] = useState<string>();
  const inputFocusedRef = useRef(false);
  const accentColorOptions: Array<{
    value: AccentColor;
    label: string;
    swatch: string;
  }> = [
    { value: 'neutral', label: t('settings.accent.neutral'), swatch: '#85858b' },
    { value: 'blue', label: t('settings.accent.blue'), swatch: '#3b82f6' },
    { value: 'cyan', label: t('settings.accent.cyan'), swatch: '#06b6d4' },
    { value: 'purple', label: t('settings.accent.purple'), swatch: '#8b5cf6' },
    { value: 'orange', label: t('settings.accent.orange'), swatch: '#f97316' },
    { value: 'red', label: t('settings.accent.red'), swatch: '#ef4444' }
  ];

  useEffect(() => {
    if (!inputFocusedRef.current) setDraft(normalizedCustomColor);
  }, [normalizedCustomColor]);

  function commitDraft() {
    const normalized = normalizeHexColor(draft);
    if (normalized === undefined) {
      setError(t('settings.accent.invalid'));
      return;
    }
    setDraft(normalized);
    setError(undefined);
    props.onCustomColorChange(normalized);
  }

  return (
    <div className="settings-row settings-control-row settings-accent-row">
      <span id={labelId}>{t('settings.accent')}</span>
      <div className="settings-accent-controls">
        <div className="settings-accent-color">
          <div className="settings-accent-options" role="radiogroup" aria-labelledby={labelId}>
            {accentColorOptions.map(option => {
              const selected = props.value === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={option.label}
                  title={option.label}
                  style={{ '--settings-accent-swatch': option.swatch } as CSSProperties}
                  onClick={() => props.onChange(option.value)}
                >
                  <span className="settings-accent-swatch" aria-hidden="true">
                    {selected ? <Check size={11} strokeWidth={2.5} /> : null}
                  </span>
                </button>
              );
            })}
            <div className="settings-custom-accent-option">
              <span className="settings-accent-separator" aria-hidden="true">｜</span>
              <button
                className="settings-custom-accent-choice"
                type="button"
                role="radio"
                aria-checked={props.value === 'custom'}
                aria-label={t('settings.accent.custom')}
                title={t('settings.accent.custom')}
                style={{ '--settings-accent-swatch': normalizedCustomColor } as CSSProperties}
                onClick={() => props.onChange('custom')}
              >
                <span className="settings-accent-swatch" aria-hidden="true">
                  {props.value === 'custom' ? <Check size={11} strokeWidth={2.5} /> : null}
                </span>
                <span className="settings-custom-accent-text">{t('settings.accent.custom')}</span>
              </button>
            </div>
          </div>
          <div className="settings-custom-accent">
            <label className="settings-custom-accent-input-label" htmlFor={inputId}>
              {t('settings.accent.customValue')}
            </label>
            <input
              id={inputId}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              aria-invalid={error === undefined ? undefined : 'true'}
              aria-describedby={error === undefined ? undefined : `${inputId}-error`}
              onFocus={() => {
                inputFocusedRef.current = true;
              }}
              onChange={event => {
                const nextDraft = event.target.value;
                setDraft(nextDraft);
                const normalized = normalizeHexColor(nextDraft);
                if (normalized === undefined) return;
                setError(undefined);
                props.onCustomColorChange(normalized);
              }}
              onBlur={() => {
                inputFocusedRef.current = false;
                commitDraft();
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitDraft();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraft(normalizedCustomColor);
                  setError(undefined);
                }
              }}
            />
            {error === undefined ? null : (
              <p id={`${inputId}-error`} className="settings-custom-accent-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PluginSettings(props: { runtimeStatus: RuntimeStatus }) {
  const { t } = useAppLanguage();
  const checkedAt = props.runtimeStatus.lastCheckedAt ?? t('settings.notChecked');
  const status = props.runtimeStatus.connected
    ? t('settings.plugins.ready')
    : t('settings.plugins.waiting');

  return (
    <section className="settings-section" aria-labelledby="settings-plugins-title">
      <header>
        <h1 id="settings-plugins-title">{t('settings.tab.plugins')}</h1>
        <p>{t('settings.plugins.description')}</p>
      </header>
      <div className="settings-card">
        <SettingsRow label={t('settings.plugins.skillsStatus')} value={status} />
        <SettingsRow
          label={t('settings.plugins.mcpStatus')}
          value={props.runtimeStatus.connected
            ? t('settings.plugins.available')
            : t('settings.plugins.unavailable')}
        />
        <SettingsRow label={t('settings.lastChecked')} value={checkedAt} />
      </div>
    </section>
  );
}

function AboutSettings(props: {
  runtimeStatus: RuntimeStatus;
  updaterService?: AppUpdaterService | null;
}) {
  const { t } = useAppLanguage();
  const runtimeStatusText = props.runtimeStatus.connected
    ? t('settings.status.normal')
    : t('settings.status.disconnected');

  return (
    <section className="settings-section" aria-labelledby="settings-about-title">
      <header>
        <h1 id="settings-about-title">{t('settings.tab.about')}</h1>
        <p>{t('settings.about.description')}</p>
      </header>
      <div className="settings-card">
        <SettingsRow
          label={t('settings.about.version')}
          value={props.runtimeStatus.appVersion ?? t('settings.unknown')}
        />
        <SettingsRow
          label={t('settings.about.runtimeVersion')}
          value={props.runtimeStatus.runtimeVersion ?? t('settings.unknown')}
        />
        <SettingsRow
          label={t('settings.about.dataDirectory')}
          value={props.runtimeStatus.codexHome ?? t('settings.notSet')}
        />
        <AboutUpdaterStatus service={props.updaterService ?? undefined} />
      </div>
      <section className="settings-card settings-advanced" aria-label={t('settings.about.advanced')}>
        <h2>{t('settings.about.advanced')}</h2>
        <SettingsRow
          label={t('settings.about.codexVersion')}
          value={props.runtimeStatus.codexVersion ?? t('settings.unknown')}
        />
        <SettingsRow
          label={t('settings.about.codexPath')}
          value={props.runtimeStatus.codexPath ?? t('settings.notSet')}
        />
        <SettingsRow label="CODEX_HOME" value={props.runtimeStatus.codexHome ?? t('settings.notSet')} />
        <SettingsRow label={t('settings.about.runtimeStatus')} value={runtimeStatusText} />
        <SettingsRow
          label={t('settings.lastCheckDetail')}
          value={props.runtimeStatus.lastCheckedAt ?? t('settings.notChecked')}
        />
      </section>
    </section>
  );
}

function SettingsRow(props: { label: string; value: string }) {
  return (
    <div className="settings-row">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

const UPDATER_STATE_KEYS: Record<string, string> = {
  unavailable: 'settings.about.updateLater',
  idle: 'settings.about.updater.stateCurrent',
  checking: 'settings.about.updater.stateChecking',
  available: 'settings.about.updater.stateAvailable',
  downloading: 'settings.about.updater.stateDownloading',
  downloaded: 'settings.about.updater.stateDownloaded',
  preparing_install: 'settings.about.updater.stateInstalling',
  installing: 'settings.about.updater.stateInstalling',
  error: 'settings.about.updater.stateError'
};

function AboutUpdaterStatus(props: { service?: AppUpdaterService }) {
  const { t } = useAppLanguage();
  const service = props.service;
  const [snapshot, setSnapshot] = useState<AppUpdaterSnapshot>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (service === undefined) return undefined;
    let alive = true;
    const apply = (next: AppUpdaterSnapshot) => {
      if (alive) setSnapshot(next);
    };
    service.read().then(apply).catch(() => undefined);
    const unsubscribe = service.subscribe(apply);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [service]);

  if (service === undefined) {
    return (
      <SettingsRow label={t('settings.about.checkUpdates')} value={t('settings.about.updateLater')} />
    );
  }

  const state = snapshot?.state ?? 'idle';
  const stateKey = UPDATER_STATE_KEYS[state] ?? 'settings.unknown';  const lastCheck = snapshot?.lastCheckAt === undefined
    ? '—'
    : formatUpdaterTimestamp(snapshot.lastCheckAt);
  const canInstall = state === 'available' || state === 'downloaded';

  const requestCheck = () => {
    if (busy) return;
    setBusy(true);
    service.checkNow()
      .then(next => setSnapshot(next))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const requestInstall = () => {
    if (busy || !canInstall) return;
    setBusy(true);
    service.installNow()
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="settings-row">
        <span>{t('settings.about.updater.state')}</span>
        <strong>{t(stateKey as Parameters<typeof t>[0])}</strong>
      </div>
      <div className="settings-row">
        <span>{t('settings.about.updater.latestVersion')}</span>
        <strong>{snapshot?.availableVersion ?? '—'}</strong>
      </div>
      <div className="settings-row">
        <span>{t('settings.about.updater.lastCheck')}</span>
        <strong>{lastCheck}</strong>
      </div>
      {state === 'error' && snapshot?.errorMessage !== undefined ? (
        <div className="settings-row">
          <span>{t('settings.about.updater.errorDetail')}</span>
          <strong>{snapshot.errorMessage}</strong>
        </div>
      ) : null}
      <div className="settings-updater-actions">
        <button
          type="button"
          className="settings-secondary-button"
          disabled={busy || state === 'checking'}
          onClick={requestCheck}
        >
          {t('settings.about.checkUpdates')}
        </button>
        {canInstall ? (
          <button
            type="button"
            className="settings-primary-button"
            disabled={busy}
            onClick={requestInstall}
          >
            {t('settings.about.updater.installNow')}
          </button>
        ) : null}
      </div>
    </>
  );
}

function formatUpdaterTimestamp(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

function SettingsSelectRow<Value extends string>(props: {
  id: string;
  label: string;
  value: Value;
  options: Array<{ value: Value; label: string }>;
  onChange(value: Value): void;
}) {
  return (
    <label className="settings-row settings-control-row" htmlFor={props.id}>
      <span>{props.label}</span>
      <select
        id={props.id}
        className="settings-select"
        value={props.value}
        onChange={event => props.onChange(event.target.value as Value)}
      >
        {props.options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}
