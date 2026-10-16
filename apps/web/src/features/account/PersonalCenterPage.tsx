import { useEffect, useState } from 'react';
import { ArrowLeft, Settings2 } from 'lucide-react';
import type { GatewayAccountState } from '@opencreator/protocol';
import type { ExternalNavigation } from '../../host/bridge.js';
import { useLocalizedCopy } from '../../i18n/useLocalizedCopy.js';
import type { GatewayAccountSettingsService } from '../../services/gateway-account-service.js';
import { GatewayAccountSettingsView } from '../settings/GatewayAccountSettingsView.js';
import { GatewaySubscriptionSettingsView } from '../settings/GatewaySubscriptionSettingsView.js';
import { AccountAvatar } from './AccountAvatar.js';
import './personal-center.css';

export default function PersonalCenterPage(props: {
  view?: 'account' | 'subscription';
  service: GatewayAccountSettingsService | null;
  accountState?: GatewayAccountState;
  billingOrderId?: string;
  billingReturnUrl?: string;
  prepareExternalNavigation?(): ExternalNavigation;
  onStateChange?(state: GatewayAccountState): void;
  openExternal?(url: string): Promise<void> | void;
  onBack(): void;
  onOpenModelSettings?(): void;
}) {
  const l = useLocalizedCopy();
  const [state, setState] = useState(props.accountState);
  const [signInRequest, setSignInRequest] = useState(0);
  useEffect(() => { setState(props.accountState); }, [props.accountState]);
  const email = state?.authState === 'signed_in' ? state.account?.email : undefined;
  const title = l('个人中心', 'Account');
  const modelUnavailable = state?.authState === 'signed_in' && state.source === 'gateway' && state.activationState !== 'ready';

  return <main className="opencreator-scroll-page personal-center" aria-label={title}>
    <div className="personal-center__content">
      <header className="personal-center__heading">
        <button type="button" onClick={props.onBack} title={l('返回', 'Back')} aria-label={l('返回', 'Back')}><ArrowLeft size={20}/></button>
        <h1>{title}</h1>
      </header>
      <section className="personal-center__identity" aria-label={l('账户信息', 'Account information')}>
        <AccountAvatar email={email} accountId={state?.account?.id} avatarUrl={state?.account?.avatarUrl} loadAvatar={props.service?.getAvatar} large/>
        <div className="personal-center__local-identity" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginLeft: '1rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>OpenCreator Local</h2>
          <span style={{ color: '#10b981', fontWeight: 500, fontSize: '0.9rem' }}>{l('● 本地模式（本地优先）', '● Local mode (local-first)')}</span>
          <p style={{ color: '#888', fontSize: '0.85rem', margin: 0 }}>
            {l('在本机独立运行 · 无限额度 · 直连 9router 与 VieNeu-TTS', 'Runs independently on this device · No quota limits · Direct connection to 9router and VieNeu-TTS')}
          </p>
        </div>
      </section>
      {modelUnavailable ? <div className="personal-center__model-status" role="status">
        <span>{state.activationState === 'loading' ? l('模型服务正在连接', 'Connecting to model services') : l('模型服务暂不可用', 'Model services are unavailable')}</span>
        {props.onOpenModelSettings ? <button type="button" onClick={props.onOpenModelSettings}><Settings2 size={15}/>{l('模型设置', 'Model settings')}</button> : null}
      </div> : null}
      <section className="account-credits" aria-label={l('本地中心', 'Local center')} style={{ marginTop: '1.5rem', padding: '1.5rem', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '12px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
        <div className="account-credits__balance">
          <div>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, margin: 0 }}>{l('AI 系统状态', 'AI system status')}</h2>
            <p className="account-credits__value" style={{ color: '#10b981', fontSize: '1.25rem', margin: '0.5rem 0' }}>
              {l('无限额度（本地访问）', 'Unlimited (local access)')}
            </p>
            <p style={{ color: '#999', fontSize: '0.875rem', lineHeight: '1.5', margin: 0 }}>
              {l('所有创作、翻译、视频配音、语音识别与编辑任务都通过本地 AI 服务（9router、Agnes AI、ElevenLabs、VieNeu-TTS）直接执行，无需充值或维护云端账户。', 'All creation, translation, video dubbing, speech recognition, and editing tasks run directly through local AI services (9router, Agnes AI, ElevenLabs, VieNeu-TTS). No top-ups or cloud account required.')}
            </p>
          </div>
        </div>
      </section>
    </div>
  </main>;
}
