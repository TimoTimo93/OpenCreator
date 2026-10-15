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
      <section className="personal-center__identity" aria-label={l('Thông tin tài khoản', 'Account information')}>
        <AccountAvatar email={email} accountId={state?.account?.id} avatarUrl={state?.account?.avatarUrl} loadAvatar={props.service?.getAvatar} large/>
        <div className="personal-center__local-identity" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginLeft: '1rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>OpenCreator Local</h2>
          <span style={{ color: '#10b981', fontWeight: 500, fontSize: '0.9rem' }}>● Chế độ Cục bộ (Local-First)</span>
          <p style={{ color: '#888', fontSize: '0.85rem', margin: 0 }}>
            Vận hành độc lập trên máy tính · Không giới hạn hạn mức · Kết nối trực tiếp 9router & VieNeu-TTS
          </p>
        </div>
      </section>
      {modelUnavailable ? <div className="personal-center__model-status" role="status">
        <span>{state.activationState === 'loading' ? l('Dịch vụ mô hình đang kết nối', 'Connecting to model services') : l('Dịch vụ mô hình chưa sẵn sàng', 'Model services are unavailable')}</span>
        {props.onOpenModelSettings ? <button type="button" onClick={props.onOpenModelSettings}><Settings2 size={15}/>{l('Cài đặt mô hình', 'Model settings')}</button> : null}
      </div> : null}
      <section className="account-credits" aria-label="Trung tâm Cục bộ" style={{ marginTop: '1.5rem', padding: '1.5rem', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '12px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
        <div className="account-credits__balance">
          <div>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, margin: 0 }}>Trạng thái Hệ thống AI</h2>
            <p className="account-credits__value" style={{ color: '#10b981', fontSize: '1.25rem', margin: '0.5rem 0' }}>
              Không giới hạn hạn mức (Unlimited Local Access)
            </p>
            <p style={{ color: '#999', fontSize: '0.875rem', lineHeight: '1.5', margin: 0 }}>
              Toàn bộ các tác vụ sáng tạo, dịch thuật, lồng tiếng video, nhận dạng giọng nói và chỉnh sửa được thực thi trực tiếp qua các dịch vụ AI nội bộ (9router, Agnes AI, ElevenLabs, VieNeu-TTS). Không cần nạp thẻ hay duy trì tài khoản đám mây.
            </p>
          </div>
        </div>
      </section>
    </div>
  </main>;
}
