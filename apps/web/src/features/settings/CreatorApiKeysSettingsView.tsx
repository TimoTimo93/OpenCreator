import type { CreatorServicesConfig } from '@opencreator/protocol';
import { KeyRound, LoaderCircle, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocalizedCopy } from '../../i18n/useLocalizedCopy.js';
import type { CreatorServicesSettingsService } from '../../services/creator-services-service.js';
import { IssueList } from '../issues/IssuePresenter.js';
import { usePageIssueState } from '../issues/page-issue-state.js';
import { MultiApiKeyManager } from './MultiApiKeyManager.js';
import './creator-services-settings.css';

const AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const AGNES_MODEL = 'agnes-3.0-pro';
const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
const ELEVENLABS_MODEL = 'eleven_multilingual_v2';
const ELEVENLABS_VOICE = 'f5q6kePPoQAjCPYG6moa';

/**
 * "Cấu hình API": nơi duy nhất quản lý khoá dịch vụ của ứng dụng — danh sách API Key
 * Agnes AI (văn bản/dịch) và danh sách API Key ElevenLabs (lồng tiếng) kèm giao diện
 * thêm/xoá/kiểm tra key. Trang Dịch vụ AI chỉ còn phần "Cấu hình tùy chỉnh" cho
 * Người mẫu, Phiên âm, Tiếng nói, Hình ảnh, Băng hình.
 *
 * Danh sách key được lưu TỰ ĐỘNG ngay khi thay đổi (nộp trễ 700ms) vì người dùng
 * thường thêm key, bấm kiểm tra rồi sang tab khác — nếu phải bấm Lưu thủ công thì
 * key sẽ tưởng như "biến mất" khi quay lại.
 */
export function CreatorApiKeysSettingsView(props: {
  connected: boolean;
  service: CreatorServicesSettingsService | null;
}) {
  const l = useLocalizedCopy();
  const [config, setConfig] = useState<CreatorServicesConfig>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  const pageIssues = usePageIssueState('settings-api-keys');
  /** Lưu liên tục: các thay đổi key được ghi xuống ngay (debounce 700ms). */
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const latestDraftRef = useRef<CreatorServicesConfig>();
  useEffect(() => {
    latestDraftRef.current = config;
  }, [config]);
  useEffect(() => () => {
    clearTimeout(saveTimerRef.current);
  }, []);

  useEffect(() => {
    let active = true;
    if (!props.connected || props.service === null) {
      setLoading(false);
      setConfig(undefined);
      pageIssues.clearIssues();
      return () => {
        active = false;
      };
    }
    setLoading(true);
    pageIssues.resolveOperation('settings.api-keys.load');
    void props.service.getConfig().then(response => {
      if (!active) return;
      setConfig(response.config);
      setLoading(false);
    }).catch(cause => {
      if (!active) return;
      setLoading(false);
      pageIssues.captureOperationFailure(
        'settings.api-keys.load',
        cause,
        l('无法加载 API Key 列表。', 'Could not load the API keys.')
      );
    });
    return () => {
      active = false;
    };
  }, [l, pageIssues.captureOperationFailure, pageIssues.clearIssues, pageIssues.resolveOperation, props.connected, props.service, reloadToken]);

  const update = (mutate: (draft: CreatorServicesConfig) => void) => {
    setConfig(current => {
      if (current === undefined) return current;
      const next = structuredClone(current);
      mutate(next);
      scheduleAutoSave(next);
      return next;
    });
    setNotice(undefined);
  };

  function scheduleAutoSave(draft: CreatorServicesConfig) {
    clearTimeout(saveTimerRef.current);
    latestDraftRef.current = draft;
    saveTimerRef.current = setTimeout(() => {
      if (props.service !== null && props.connected) void persist(latestDraftRef.current);
    }, 700);
  }

  async function persist(draft: CreatorServicesConfig | undefined) {
    if (draft === undefined || props.service === null) return;
    setSaving(true);
    setNotice(undefined);
    try {
      const response = await props.service.saveConfig(draft);
      setConfig(current => (current === undefined ? response.config : current));
      setNotice(l('已保存 API Key 列表。', 'API keys saved.'));
    } catch (cause) {
      pageIssues.captureOperationFailure(
        'settings.api-keys.save',
        cause,
        l('无法保存 API Key 列表。', 'Could not save the API keys.')
      );
    } finally {
      setSaving(false);
    }
  }

  const save = async () => {
    clearTimeout(saveTimerRef.current);
    await persist(config);
  };

  const agnesKeys = config?.llm.agnesAi?.apiKeys ?? [];
  const elevenlabsKeys = config?.tts.elevenlabs?.apiKeys ?? [];

  return (
    <section className="settings-section creator-services-settings" id="creator-api-keys-panel" aria-labelledby="creator-api-keys-title">
      <header className="creator-services-header">
        <div>
          <h1 id="creator-api-keys-title">
            <KeyRound size={18} aria-hidden="true" />
            {l('API 配置', 'API configuration')}
          </h1>
          <p>
            {l(
              '统一管理所有功能使用的 API Key：Agnes AI（文本模型与翻译）和 ElevenLabs（高质量配音）。',
              'Manage the API key lists used by every feature: Agnes AI (text model and translation) and ElevenLabs (high quality dubbing).'
            )}
          </p>
        </div>
      </header>

      {loading ? (
        <div className="creator-services-state">
          <LoaderCircle className="creator-services-spinner" size={18} aria-hidden="true" />
          {l('正在读取配置', 'Loading settings')}
        </div>
      ) : !props.connected || props.service === null ? (
        <div className="creator-services-state">
          {l('连接本地 Runtime 后即可管理 API Key。', 'Connect the local Runtime to manage API keys.')}
        </div>
      ) : config === undefined ? (
        <div className="creator-services-state">
          {l('配置暂不可用', 'Settings are unavailable')}
          <button
            className="settings-secondary-button"
            type="button"
            onClick={() => setReloadToken(token => token + 1)}
          >
            {l('重试', 'Try again')}
          </button>
        </div>
      ) : (
        <form
          className="creator-services-form"
          onSubmit={event => {
            event.preventDefault();
            void save();
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <label className="creator-services-field">
              <span>{l('Agnes AI · API Base URL', 'Agnes AI · API Base URL')}</span>
              <input
                type="text"
                value={config.llm.agnesAi?.baseUrl || AGNES_BASE_URL}
                placeholder={AGNES_BASE_URL}
                onChange={event => update(draft => {
                  draft.llm.agnesAi = {
                    baseUrl: event.target.value,
                    apiKeys: draft.llm.agnesAi?.apiKeys ?? [],
                    model: draft.llm.agnesAi?.model || AGNES_MODEL
                  };
                })}
              />
            </label>
            <label className="creator-services-field">
              <span>{l('Agnes AI · 模型', 'Agnes AI · Model')}</span>
              <select
                value={config.llm.agnesAi?.model || AGNES_MODEL}
                onChange={event => update(draft => {
                  draft.llm.agnesAi = {
                    baseUrl: draft.llm.agnesAi?.baseUrl || AGNES_BASE_URL,
                    apiKeys: draft.llm.agnesAi?.apiKeys ?? [],
                    model: event.target.value
                  };
                })}
              >
                <option value="agnes-3.0-pro">Agnes 3.0 Pro (Tối ưu dịch thuật video - Khuyên dùng)</option>
                <option value="agnes-2.5-pro">Agnes 2.5 Pro (Tốc độ cao)</option>
              </select>
            </label>
          </div>

          <MultiApiKeyManager
            title={l('Agnes AI API Key 列表（agnes-ai.com）', 'Agnes AI API key list (agnes-ai.com)')}
            description={l(
              '支持粘贴多个 key（每行一个）。系统自动分行、保存，并在遇到 429/402 错误时轮换故障转移。',
              'Paste many keys (one per line). They are split automatically, stored, and rotated as a failover when a request fails with 429/402.'
            )}
            apiKeys={agnesKeys}
            onChange={keys => update(draft => {
              if (!draft.llm.agnesAi) {
                draft.llm.agnesAi = {
                  baseUrl: AGNES_BASE_URL,
                  apiKeys: [],
                  model: AGNES_MODEL
                };
              }
              draft.llm.agnesAi.apiKeys = keys;
              if (keys[0] !== undefined) draft.llm.apiKey = keys[0];
            })}
            onTestKey={async key => props.service?.testApiKey
              ? props.service.testApiKey({
                  provider: 'agnes-ai',
                  key,
                  baseUrl: config.llm.agnesAi?.baseUrl || AGNES_BASE_URL
                })
              : { valid: true }}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <label className="creator-services-field">
              <span>{l('ElevenLabs · API Base URL', 'ElevenLabs · API Base URL')}</span>
              <input
                type="text"
                value={config.tts.elevenlabs?.baseUrl || ELEVENLABS_BASE_URL}
                placeholder={ELEVENLABS_BASE_URL}
                onChange={event => update(draft => {
                  if (!draft.tts.elevenlabs) {
                    draft.tts.elevenlabs = {
                      baseUrl: ELEVENLABS_BASE_URL,
                      apiKeys: [],
                      model: ELEVENLABS_MODEL,
                      defaultVoiceId: ELEVENLABS_VOICE
                    };
                  }
                  draft.tts.elevenlabs.baseUrl = event.target.value;
                })}
              />
            </label>
            <label className="creator-services-field">
              <span>{l('ElevenLabs · 模型', 'ElevenLabs · Model')}</span>
              <select
                value={config.tts.elevenlabs?.model || ELEVENLABS_MODEL}
                onChange={event => update(draft => {
                  if (!draft.tts.elevenlabs) {
                    draft.tts.elevenlabs = {
                      baseUrl: ELEVENLABS_BASE_URL,
                      apiKeys: [],
                      model: ELEVENLABS_MODEL,
                      defaultVoiceId: ELEVENLABS_VOICE
                    };
                  }
                  draft.tts.elevenlabs.model = event.target.value;
                })}
              >
                <option value="eleven_multilingual_v2">eleven_multilingual_v2 (Đa ngôn ngữ chất lượng cao - Khuyên dùng)</option>
                <option value="eleven_turbo_v2_5">eleven_turbo_v2_5 (Tối ưu tốc độ cao)</option>
                <option value="eleven_v4">eleven_v4 (Cơ bản)</option>
              </select>
            </label>
          </div>

          <MultiApiKeyManager
            title={l('ElevenLabs API Key 列表（自动轮换故障转移）', 'ElevenLabs API key list (automatic failover)')}
            description={l(
              '支持批量粘贴 API Key（每行一个）。当某个 key 额度用尽（429、402、456），系统自动切换到下一个 key，并在 15 分钟后自动恢复。',
              'Paste many keys (one per line). When a key runs out of quota (429, 402, 456), the next key is used automatically and the key recovers after 15 minutes.'
            )}
            apiKeys={elevenlabsKeys}
            onChange={keys => update(draft => {
              if (!draft.tts.elevenlabs) {
                draft.tts.elevenlabs = {
                  baseUrl: ELEVENLABS_BASE_URL,
                  apiKeys: [],
                  model: ELEVENLABS_MODEL,
                  defaultVoiceId: ELEVENLABS_VOICE
                };
              }
              draft.tts.elevenlabs.apiKeys = keys;
            })}
            onTestKey={async key => props.service?.testApiKey
              ? props.service.testApiKey({
                  provider: 'elevenlabs',
                  key,
                  baseUrl: config.tts.elevenlabs?.baseUrl || ELEVENLABS_BASE_URL
                })
              : { valid: true }}
          />

          <footer className="creator-services-actions">
            <div aria-live="polite">
              {notice ? <p className="settings-notice">{notice}</p> : null}
            </div>
            <button className="settings-primary-button" type="submit" disabled={saving}>
              {saving ? (
                <LoaderCircle className="creator-services-spinner" size={15} aria-hidden="true" />
              ) : (
                <Save size={15} aria-hidden="true" />
              )}
              {saving ? l('保存中', 'Saving') : l('保存 API Key 列表', 'Save API keys')}
            </button>
          </footer>
        </form>
      )}
      <IssueList
        issues={pageIssues.issues}
        actions={{ retryOperations: {
          'settings.api-keys.load': () => setReloadToken(token => token + 1),
          'settings.api-keys.save': () => void save()
        } }}
        onDismiss={pageIssues.dismissIssue}
      />
    </section>
  );
}
