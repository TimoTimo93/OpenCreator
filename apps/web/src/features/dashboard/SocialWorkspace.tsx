import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Check,
  ExternalLink,
  Globe,
  LoaderCircle,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Youtube
} from 'lucide-react';
import { useAppLanguage, type Translate } from '../../i18n/LanguageProvider.js';
import type {
  SocialClusterSummary,
  SocialEnqueueItem,
  SocialJobSummary,
  SocialOverview
} from '../../services/social-service.js';
import type { SocialService } from '../../services/social-service.js';
import { ExcelImportButton } from './social-excel.js';
import { SocialInsightsPanel } from './social-insights.js';
import {
  peekPendingSocialHandoffSource,
  takePendingSocialHandoffSource
} from './pending-social-handoff.js';
import './social-workspace.css';

type PlatformName = 'youtube' | 'tiktok' | 'facebook';

const PLATFORMS: PlatformName[] = ['youtube', 'tiktok', 'facebook'];

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return String(error ?? 'unknown error');
}

function formatSchedule(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function platformKind(status: string): string {
  switch (status) {
    case 'published': return 'ok';
    case 'scheduled': return 'scheduled';
    case 'running': return 'running';
    case 'failed': return 'failed';
    case 'pending': return 'pending';
    default: return 'skipped';
  }
}

export default function SocialWorkspace(props: { service: SocialService; onBack(): void }) {
  const { t } = useAppLanguage();
  const service = props.service;
  const [overview, setOverview] = useState<SocialOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [editing, setEditing] = useState<SocialClusterSummary | 'new' | null>(null);
  const [enqueuePath, setEnqueuePath] = useState(() => peekPendingSocialHandoffSource()?.path ?? '');
  const [insightsKey, setInsightsKey] = useState(0);

  const load = useCallback(async (showSpinner: boolean): Promise<void> => {
    if (showSpinner) setLoading(true);
    try {
      const data = await service.getOverview();
      setOverview(data);
      setError('');
      setInsightsKey(key => key + 1);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void load(true);
    const timer = setInterval(() => { void load(false); }, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handoff = takePendingSocialHandoffSource();
    if (handoff !== undefined && handoff.path.trim() !== '') {
      setEnqueuePath(handoff.path);
      setToast(t('dashboard.social.handoffLoaded'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clusters = overview?.clusters ?? [];
  const jobs = useMemo(() => {
    const list = overview?.jobs ?? [];
    return [...list].sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
  }, [overview]);

  async function action(showToast: string, run: () => Promise<unknown>): Promise<void> {
    try {
      const result = await run();
      if (result !== undefined && result !== null && typeof result === 'object' && 'clusters' in result) {
        setOverview(result as SocialOverview);
      } else {
        await load(false);
      }
      if (showToast !== '') setToast(showToast);
    } catch (cause) {
      setError(t('dashboard.social.actionFailed', { message: messageOf(cause) }));
    }
  }

  const queueRunning = overview?.queue !== 'paused';

  return (
    <div className="social-workspace" aria-label={t('dashboard.social.tabTitle')}>
      <header className="social-header">
        <div>
          <div className="social-header-back">
            <button type="button" className="social-btn" onClick={props.onBack}>â† {t('settings.back')}</button>
          </div>
          <h1><MonitorSmartphone size={20} aria-hidden="true" /> {t('dashboard.social.tabTitle')}</h1>
          <p className="social-subtitle">{t('dashboard.social.subtitle')}</p>
        </div>
        <div className="social-header-actions">
          <button type="button" className="social-btn" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw size={14} aria-hidden="true" /> {t('dashboard.drama.refresh')}
          </button>
          <button
            type="button"
            className="social-btn"
            disabled={loading || overview === null}
            onClick={() => void action(
              queueRunning ? t('dashboard.social.paused') : t('dashboard.social.resumed'),
              () => queueRunning ? service.pauseQueue() : service.resumeQueue()
            )}
          >
            {queueRunning ? t('dashboard.social.pauseQueue') : t('dashboard.social.resumeQueue')}
          </button>
          <button type="button" className="social-btn social-btn-primary" onClick={() => setEditing('new')}>
            <Plus size={14} aria-hidden="true" /> {t('dashboard.social.newCluster')}
          </button>
        </div>
      </header>

      {toast !== '' ? <p className="social-toast" role="status">{toast}</p> : null}
      {error !== '' ? (
        <div className="social-error" role="alert">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" className="social-btn social-btn-sm" onClick={() => { setError(''); void load(false); }}>
            {t('dashboard.drama.retry')}
          </button>
        </div>
      ) : null}

      {overview === null && loading ? <p className="social-loading"><LoaderCircle size={16} className="social-spin" /> {t('dashboard.drama.loading')}</p> : null}

      {overview !== null ? (
        <div className="social-grid">
          <section className="social-clusters" aria-label={t('dashboard.social.clustersTitle')}>
            <h2>{t('dashboard.social.clustersTitle', { count: clusters.length })}</h2>
            {clusters.length === 0 ? (
              <p className="social-empty">{t('dashboard.social.noClusters')}</p>
            ) : (
              <ul className="social-cluster-list">
                {clusters.map(cluster => (
                  <ClusterCard
                    key={cluster.id}
                    cluster={cluster}
                    t={t}
                    onCheckProxy={() => void action(t('dashboard.social.checkedProxy'), () => service.checkClusterProxy(cluster.id))}
                    onOpenBrowser={() => void action(t('dashboard.social.browserOpened'), () => service.openClusterBrowser(cluster.id))}
                    onCloseBrowser={() => void action(t('dashboard.social.browserClosed'), () => service.closeClusterBrowser(cluster.id))}
                    onEdit={() => setEditing(cluster)}
                    onDelete={() => { if (window.confirm(t('dashboard.social.confirmDelete', { name: cluster.name }))) void action(t('dashboard.social.deletedCluster'), () => service.deleteCluster(cluster.id)); }}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="social-queue" aria-label={t('dashboard.social.queueTitle')}>
            <div className="social-queue-head">
              <h2>{t('dashboard.social.queueTitle')}</h2>
              <span className={`social-queue-state social-queue-state-${queueRunning ? 'running' : 'paused'}`}>
                {queueRunning ? t('dashboard.social.queueRunning') : t('dashboard.social.queuePaused')}
              </span>
            </div>
            <EnqueueSheet
              clusters={clusters}
              enqueuePath={enqueuePath}
              onPathChange={setEnqueuePath}
              t={t}
              onEnqueue={(item, scheduledAt) => void action(t('dashboard.social.enqueued'), () => service.enqueue([{ ...item, ...(scheduledAt === '' ? {} : { scheduledAt }) }]))}
              onEnqueueMany={(items, summaryMessage) => void action(
                summaryMessage,
                async () => {
                  let last = null;
                  for (let index = 0; index < items.length; index += 60) {
                    const chunk = items.slice(index, index + 60);
                    last = await service.enqueue(chunk);
                  }
                  return last;
                }
              )}
            />
            {jobs.length === 0 ? (
              <p className="social-empty">{t('dashboard.social.noJobs')}</p>
            ) : (
              <ul className="social-job-list">
                {jobs.map(job => (
                  <JobRow
                    key={job.id}
                    job={job}
                    t={t}
                    onRemove={() => void action(t('dashboard.social.jobRemoved'), () => service.removeJob(job.id))}
                    onRetry={() => void action(t('dashboard.social.retried'), () => service.retryFailedPlatforms(job.id))}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      <SocialInsightsPanel service={service} clusters={clusters} t={t} refreshKey={insightsKey} />

      {editing !== null ? (
        <ClusterEditor
          cluster={editing === 'new' ? null : editing}
          t={t}
          onClose={() => setEditing(null)}
          onSave={input => {
            const payload = input;
            if (editing === 'new') {
              void action(t('dashboard.social.createdCluster'), () => service.createCluster(payload));
            } else if (editing !== null) {
              void action(t('dashboard.social.updatedCluster'), () => service.updateCluster(editing.id, payload));
            }
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ClusterCard(props: {
  cluster: SocialClusterSummary;
  t: Translate;
  onCheckProxy(): void;
  onOpenBrowser(): void;
  onCloseBrowser(): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const { cluster, t } = props;
  const proxyLabel: Record<string, string> = {
    online: t('dashboard.social.proxyOnline'),
    dead: t('dashboard.social.proxyDead'),
    unchecked: t('dashboard.social.proxyUnchecked'),
    checking: t('dashboard.social.proxyChecking'),
    no_proxy: t('dashboard.social.proxyNone')
  };
  return (
    <li className="social-cluster-card">
      <div className="social-cluster-head">
        <strong title={cluster.seriesName !== '' ? cluster.seriesName : cluster.name}>
          {cluster.seriesName !== '' ? cluster.seriesName : cluster.name}
        </strong>
        <span className={`social-cluster-proxy social-cluster-proxy-${cluster.proxyStatus}`}>
          <ShieldCheck size={12} aria-hidden="true" /> {proxyLabel[cluster.proxyStatus] ?? cluster.proxyStatus}
        </span>
      </div>
      <div className="social-cluster-logins">
        {PLATFORMS.map(platform => (
          <span key={platform} className={`social-login social-login-${cluster.loginStatus[platform]}`}>
            <Check size={10} aria-hidden="true" /> {platform}
          </span>
        ))}
      </div>
      <p className="social-cluster-meta">
        {t('dashboard.social.scheduleTimes', { times: cluster.defaultScheduleTimes.join(', ') })}
        {' Â· '}
        {t('dashboard.social.fbMode', { mode: cluster.fbMode === 'graph_api' ? 'Graph API' : 'Business Suite' })}
      </p>
      <div className="social-cluster-actions">
        {cluster.browserOpen
          ? <button type="button" className="social-btn social-btn-sm" onClick={props.onCloseBrowser}>{t('dashboard.social.closeBrowser')}</button>
          : <button type="button" className="social-btn social-btn-sm" onClick={props.onOpenBrowser}><ExternalLink size={12} aria-hidden="true" /> {t('dashboard.social.openBrowser')}</button>}
        <button type="button" className="social-btn social-btn-sm" onClick={props.onCheckProxy}>{t('dashboard.social.checkProxy')}</button>
        <button type="button" className="social-btn social-btn-sm" onClick={props.onEdit}>{t('dashboard.social.editCluster')}</button>
        <button type="button" className="social-btn social-btn-sm social-btn-danger" onClick={props.onDelete}><Trash2 size={12} aria-hidden="true" /> {t('dashboard.social.deleteCluster')}</button>
      </div>
    </li>
  );
}

function EnqueueSheet(props: {
  clusters: SocialClusterSummary[];
  enqueuePath: string;
  onPathChange(value: string): void;
  t: Translate;
  onEnqueue(item: SocialEnqueueItem, scheduledAt: string): void;
  onEnqueueMany(items: SocialEnqueueItem[], summaryMessage: string): void;
  onError?(message: string): void;
}) {
  const { t } = props;
  const [clusterId, setClusterId] = useState('');
  const [title, setTitle] = useState('');
  const [scheduleNow, setScheduleNow] = useState('');
  useEffect(() => {
    if (props.clusters.length > 0 && clusterId === '') setClusterId(props.clusters[0]!.id);
  }, [clusterId, props.clusters]);
  const valid = props.enqueuePath.trim() !== '' && clusterId !== '';
  return (
    <div className="social-enqueue">
      <div className="social-enqueue-row">
        <label htmlFor="social-enqueue-cluster">{t('dashboard.social.pickCluster')}</label>
        <select
          id="social-enqueue-cluster"
          value={clusterId}
          onChange={event => setClusterId(event.target.value)}
        >
          {props.clusters.length === 0 ? <option value="">{t('dashboard.social.noClusters')}</option> : null}
          {props.clusters.map(cluster => (
            <option key={cluster.id} value={cluster.id}>{cluster.seriesName !== '' ? cluster.seriesName : cluster.name}</option>
          ))}
        </select>
      </div>
      <div className="social-enqueue-row">
        <label htmlFor="social-enqueue-path">{t('dashboard.social.videoPath')}</label>
        <input
          id="social-enqueue-path"
          type="text"
          placeholder={t('dashboard.social.videoPathPlaceholder')}
          value={props.enqueuePath}
          onChange={event => props.onPathChange(event.target.value)}
        />
      </div>
      <div className="social-enqueue-row social-enqueue-inline">
        <div>
          <label htmlFor="social-enqueue-title">{t('dashboard.social.jobTitle')}</label>
          <input
            id="social-enqueue-title"
            type="text"
            placeholder={t('dashboard.social.jobTitlePlaceholder')}
            value={title}
            onChange={event => setTitle(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="social-enqueue-schedule"><CalendarClock size={12} aria-hidden="true" /> {t('dashboard.social.scheduleAt')}</label>
          <input
            id="social-enqueue-schedule"
            type="datetime-local"
            value={scheduleNow}
            onChange={event => setScheduleNow(event.target.value)}
          />
        </div>
      </div>
      <div className="social-enqueue-actions">
        <button
          type="button"
          className="social-btn social-btn-primary"
          disabled={!valid}
          onClick={() => {
            props.onEnqueue({ clusterId, path: props.enqueuePath.trim(), ...(title.trim() === '' ? {} : { title: title.trim() }) }, scheduleNow);
            setScheduleNow('');
          }}
        >
          <Plus size={14} aria-hidden="true" /> {t('dashboard.social.enqueue')}
        </button>
        <ExcelImportButton
          clusters={props.clusters}
          t={t}
          onEnqueueMany={props.onEnqueueMany}
          onError={message => props.onError?.(message)}
        />
      </div>
      <p className="social-enqueue-hint">{t('dashboard.social.enqueueHint')}</p>
    </div>
  );
}

function JobRow(props: {
  job: SocialJobSummary;
  t: Translate;
  onRemove(): void;
  onRetry(): void;
}) {
  const { job, t } = props;
  const hasFailed = PLATFORMS.some(platform => job.platforms[platform].status === 'failed');
  return (
    <li className="social-job-row">
      <div className="social-job-main">
        <p className="social-job-title" title={job.videoPath}>{job.title}</p>
        <p className="social-job-meta">
          {job.clusterName} Â· <CalendarClock size={11} aria-hidden="true" /> {formatSchedule(job.scheduledAt)}
        </p>
      </div>
      <div className="social-job-platforms">
        {PLATFORMS.map(platform => {
          const state = job.platforms[platform];
          const kind = platformKind(state.status);
          return (
            <span key={platform} className={`social-chip social-chip-${kind}`} title={state.error ?? state.videoId ?? undefined}>
              {platform === 'youtube' ? <Youtube size={11} aria-hidden="true" /> : platform === 'facebook' ? <Globe size={11} aria-hidden="true" /> : null}
              {kind === 'failed' ? t('dashboard.social.status_failed') : t(`dashboard.social.status_${kind}` as never)}
            </span>
          );
        })}
      </div>
      <div className="social-job-actions">
        {hasFailed ? <button type="button" className="social-btn social-btn-sm" onClick={props.onRetry}>{t('dashboard.social.retry')}</button> : null}
        <button type="button" className="social-btn social-btn-sm social-btn-danger" onClick={props.onRemove}>{t('dashboard.social.remove')}</button>
      </div>
    </li>
  );
}

function ClusterEditor(props: {
  cluster: SocialClusterSummary | null;
  t: Translate;
  onClose(): void;
  onSave(input: {
    name?: string;
    seriesName?: string;
    proxyServer?: string;
    fbMode?: 'graph_api' | 'browser';
    fbPageId?: string;
    fbPageToken?: string | null;
    defaultScheduleTimes?: string[];
    defaultDescription?: string;
    ytChannelUrl?: string;
    tkProfileUrl?: string;
    autoReplyEnabled?: boolean;
    autoReplyPrompt?: string;
  }): void;
}) {
  const { t, cluster } = props;
  const [name, setName] = useState(cluster?.name ?? '');
  const [seriesName, setSeriesName] = useState(cluster?.seriesName ?? '');
  const [proxyServer, setProxyServer] = useState(cluster?.proxyServer ?? '');
  const [fbMode, setFbMode] = useState<'graph_api' | 'browser'>(cluster?.fbMode ?? 'graph_api');
  const [fbPageId, setFbPageId] = useState(cluster?.fbPageId ?? '');
  const [fbPageToken, setFbPageToken] = useState('');
  const [times, setTimes] = useState(cluster?.defaultScheduleTimes.join(', ') ?? '19:30');
  const [description, setDescription] = useState(cluster?.defaultDescription ?? '');
  const [ytChannelUrl, setYtChannelUrl] = useState(cluster?.ytChannelUrl ?? '');
  const [tkProfileUrl, setTkProfileUrl] = useState(cluster?.tkProfileUrl ?? '');
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(cluster?.autoReplyEnabled ?? false);
  const [autoReplyPrompt, setAutoReplyPrompt] = useState(cluster?.autoReplyPrompt ?? '');
  const newToken = fbPageToken.trim();
  return (
    <div className="social-modal-mask" role="dialog" aria-modal="true">
      <div className="social-modal">
        <h2>{cluster === null ? t('dashboard.social.newCluster') : t('dashboard.social.editCluster')}</h2>
        <div className="social-enqueue-row">
          <label htmlFor="social-cluster-name">{t('dashboard.social.clusterName')}</label>
          <input id="social-cluster-name" type="text" value={name} onChange={event => setName(event.target.value)} />
        </div>
        <div className="social-enqueue-row">
          <label htmlFor="social-cluster-series">{t('dashboard.social.seriesName')}</label>
          <input id="social-cluster-series" type="text" value={seriesName} onChange={event => setSeriesName(event.target.value)} placeholder=" " />
        </div>
        <div className="social-enqueue-row">
          <label htmlFor="social-cluster-proxy">{t('dashboard.social.proxy')}</label>
          <input
            id="social-cluster-proxy"
            type="text"
            placeholder="http://user:pass@host:port"
            value={proxyServer}
            onChange={event => setProxyServer(event.target.value)}
          />
        </div>
        <div className="social-enqueue-inline">
          <div>
            <label htmlFor="social-cluster-fbmode">{t('dashboard.social.fbModeLabel')}</label>
            <select id="social-cluster-fbmode" value={fbMode} onChange={event => setFbMode(event.target.value === 'browser' ? 'browser' : 'graph_api')}>
              <option value="graph_api">Graph API</option>
              <option value="browser">Business Suite</option>
            </select>
          </div>
          <div>
            <label htmlFor="social-cluster-fbpage">{t('dashboard.social.fbPageId')}</label>
            <input id="social-cluster-fbpage" type="text" value={fbPageId} onChange={event => setFbPageId(event.target.value)} />
          </div>
        </div>
        {fbMode === 'graph_api' ? (
          <div className="social-enqueue-row">
            <label htmlFor="social-cluster-fbtoken">
              {t('dashboard.social.fbPageToken')}{cluster !== null && cluster.fbPageTokenConfigured ? ` Â· ${t('dashboard.social.tokenSaved')}` : ''}
            </label>
            <input
              id="social-cluster-fbtoken"
              type="password"
              placeholder={cluster !== null && cluster.fbPageTokenConfigured ? t('dashboard.social.tokenPlaceholder') : 'EAAGâ€¦'}
              value={fbPageToken}
              onChange={event => setFbPageToken(event.target.value)}
            />
          </div>
        ) : null}
        <div className="social-enqueue-row">
          <label htmlFor="social-cluster-times">{t('dashboard.social.slotTimes')}</label>
          <input id="social-cluster-times" type="text" value={times} onChange={event => setTimes(event.target.value)} />
        </div>
        <div className="social-enqueue-row">
          <label htmlFor="social-cluster-desc">{t('dashboard.social.defaultDescription')}</label>
          <textarea id="social-cluster-desc" rows={3} value={description} onChange={event => setDescription(event.target.value)} />
        </div>
        <div className="social-enqueue-row social-enqueue-inline">
          <div>
            <label htmlFor="social-cluster-yt">{t('dashboard.social.ytChannelUrl')}</label>
            <input
              id="social-cluster-yt"
              type="text"
              placeholder="https://www.youtube.com/@kenhphim"
              value={ytChannelUrl}
              onChange={event => setYtChannelUrl(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="social-cluster-tk">{t('dashboard.social.tkProfileUrl')}</label>
            <input
              id="social-cluster-tk"
              type="text"
              placeholder="https://www.tiktok.com/@kenhphim"
              value={tkProfileUrl}
              onChange={event => setTkProfileUrl(event.target.value)}
            />
          </div>
        </div>
        <div className="social-enqueue-row social-autoreply-editor">
          <label className="social-autoreply-switch">
            <input
              id="social-cluster-autoreply"
              type="checkbox"
              checked={autoReplyEnabled}
              onChange={event => setAutoReplyEnabled(event.target.checked)}
            />
            {' '}{t('dashboard.social.autoReplyToggle')}
          </label>
          <label htmlFor="social-cluster-autoreply-prompt">{t('dashboard.social.autoReplyPrompt')}</label>
          <textarea
            id="social-cluster-autoreply-prompt"
            rows={2}
            placeholder={t('dashboard.social.autoReplyPromptPlaceholder')}
            value={autoReplyPrompt}
            onChange={event => setAutoReplyPrompt(event.target.value)}
          />
        </div>
        <div className="social-modal-actions">
          <button type="button" className="social-btn" onClick={props.onClose}>{t('dashboard.drama.close')}</button>
          <button
            type="button"
            className="social-btn social-btn-primary"
            disabled={name.trim() === ''}
            onClick={() => props.onSave({
              name: name.trim(),
              ...(seriesName.trim() === '' ? {} : { seriesName: seriesName.trim() }),
              ...(proxyServer.trim() === '' ? {} : { proxyServer: proxyServer.trim() }),
              fbMode,
              ...(fbPageId.trim() === '' ? {} : { fbPageId: fbPageId.trim() }),
              ...(fbMode === 'graph_api' && newToken !== '' ? { fbPageToken: newToken } : {}),
              defaultScheduleTimes: times.split(',').map(time => time.trim()).filter(time => /^\d{1,2}:\d{2}$/.test(time)),
              ...(description.trim() === '' ? {} : { defaultDescription: description.trim() }),
              ytChannelUrl: ytChannelUrl.trim(),
              tkProfileUrl: tkProfileUrl.trim(),
              autoReplyEnabled,
              autoReplyPrompt: autoReplyPrompt.trim()
            })}
          >
            <Check size={14} aria-hidden="true" /> {t('dashboard.drama.rangeApply')}
          </button>
        </div>
      </div>
    </div>
  );
}
