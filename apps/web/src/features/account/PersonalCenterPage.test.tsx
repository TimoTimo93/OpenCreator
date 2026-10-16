import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayAccountState } from '@opencreator/protocol';
import { LanguageProvider } from '../../i18n/LanguageProvider.js';
import { createLocalizedCopy } from '../../i18n/localized-copy.js';
import type { GatewayAccountSettingsService } from '../../services/gateway-account-service.js';
import PersonalCenterPage from './PersonalCenterPage.js';

afterEach(() => { cleanup(); sessionStorage.clear(); });
const signedOut: GatewayAccountState = { source: 'manual', authState: 'signed_out', activationState: 'inactive', account: null, bindingVersion: null, models: [], activationError: null };
const signedIn: GatewayAccountState = { ...signedOut, source: 'gateway', authState: 'signed_in', activationState: 'ready', account: { id: 'a', email: 'a@example.test', verified: true } };
function createService(): GatewayAccountSettingsService {
  return {
    getState: vi.fn(async () => signedIn),
    start: vi.fn(),
    cancel: vi.fn(),
    logout: vi.fn(async () => signedOut),
    activate: vi.fn(),
    setSource: vi.fn(),
    selectModel: vi.fn(),
    getBalance: vi.fn(),
    getSummary: vi.fn(),
    getPlans: vi.fn(),
    getOrders: vi.fn(),
    getOrder: vi.fn(),
    getCreditGrants: vi.fn(),
    checkout: vi.fn(),
    portal: vi.fn()
  } as unknown as GatewayAccountSettingsService;
}
function page(
  accountState?: GatewayAccountState,
  onBack = vi.fn(),
  onOpenModelSettings?: () => void
) {
  return <LanguageProvider initialPreference="zh-CN"><PersonalCenterPage service={createService()} accountState={accountState} onBack={onBack} onOpenModelSettings={onOpenModelSettings}/></LanguageProvider>;
}

it('renders the local-first identity and the unlimited local status', () => {
  render(page(signedIn));
  expect(screen.getByRole('main', { name: '个人中心' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '个人中心' })).toBeVisible();
  expect(screen.getByRole('button', { name: '返回' })).toBeEnabled();
  expect(within(screen.getByRole('region', { name: '账户信息' })).getByRole('heading', { name: 'OpenCreator Local' })).toBeVisible();
  expect(screen.getByText('● 本地模式（本地优先）')).toBeVisible();
  const localCenter = screen.getByRole('region', { name: '本地中心' });
  expect(within(localCenter).getByRole('heading', { name: 'AI 系统状态' })).toBeVisible();
  expect(within(localCenter).getByText('无限额度（本地访问）')).toBeVisible();
});

it.each(['vi-VN', 'en-US'] as const)('localizes the local-first page in %s', language => {
  const l = createLocalizedCopy(language);
  render(<LanguageProvider initialPreference={language}><PersonalCenterPage service={createService()} accountState={signedIn} onBack={vi.fn()}/></LanguageProvider>);
  expect(screen.getByRole('main', { name: l('个人中心', 'Account') })).toBeVisible();
  expect(screen.getByRole('button', { name: l('返回', 'Back') })).toBeEnabled();
  expect(screen.getByText(l('● 本地模式（本地优先）', '● Local mode (local-first)'))).toBeVisible();
  expect(screen.getByRole('region', { name: l('本地中心', 'Local center') })).toBeVisible();
  expect(screen.getByText(l('无限额度（本地访问）', 'Unlimited (local access)'))).toBeVisible();
});

it('returns to the previous view', async () => {
  const back = vi.fn();
  render(page(signedIn, back));
  await userEvent.setup().click(screen.getByRole('button', { name: '返回' }));
  expect(back).toHaveBeenCalledOnce();
});

it('shows the model status and opens model settings when activation is not ready', async () => {
  const blocked = { ...signedIn, activationState: 'blocked' as const, activationError: { code: 'services_not_ready', message: 'Unavailable' } };
  const settings = vi.fn();
  render(page(blocked, vi.fn(), settings));
  expect(screen.getByText('模型服务暂不可用')).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: '模型设置' }));
  expect(settings).toHaveBeenCalledOnce();
});

it('shows the connecting status while activation is loading', () => {
  const loading = { ...signedIn, activationState: 'loading' as const };
  render(page(loading));
  expect(screen.getByText('模型服务正在连接')).toBeInTheDocument();
  expect(screen.queryByText('模型服务暂不可用')).not.toBeInTheDocument();
});

it('does not show the model status without a gateway sign-in', () => {
  render(page(signedOut));
  expect(screen.queryByText('模型服务暂不可用')).not.toBeInTheDocument();
  expect(screen.queryByText('模型服务正在连接')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '模型设置' })).not.toBeInTheDocument();
});
