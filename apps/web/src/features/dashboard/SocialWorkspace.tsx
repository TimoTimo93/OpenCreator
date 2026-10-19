import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  BarChart3,
  Calendar,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Facebook,
  FileVideo,
  KeyRound,
  ListVideo,
  LoaderCircle,
  MessageSquareReply,
  MonitorSmartphone,
  Music2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Tv,
  Youtube
} from 'lucide-react';
import { useAppLanguage, type Translate } from '../../i18n/LanguageProvider.js';
import type {
  SocialClusterSummary,
  SocialDownloadItem,
  SocialEnqueueItem,
  SocialJobPlatformSettings,
  SocialJobSummary,
  SocialOverview,
  SocialService,
  SocialTranslatedVideo,
  SocialPlatformName
} from '../../services/social-service.js';
import { listTranslatedVideos } from '../../services/social-service.js';
import type { CreatorWebService } from '../../services/creator-service.js';
import {
  composeEnqueueItems,
  dayKey,
  eachDay,
  formatBytes,
  fromDatetimeLocalValue,
  groupJobsByDay,
  isSameDay,
  jobIsReschedulable,
  monthGridDays,
  nextGoldenSlot,
  shiftJobToDay,
  startOfWeek,
  toDatetimeLocalValue
} from './social-calendar.js';
import { ExcelImportButton, downloadTemplate } from './social-excel.js';
import { SocialCommentsPanel, SocialStatsPanel } from './social-insights.js';
import {
  peekPendingSocialHandoffSource,
  takePendingSocialHandoffSource
} from './pending-social-handoff.js';
import './social-workspace.css';

type PlatformName = 'youtube' | 'tiktok' | 'facebook';

const PLATFORMS: PlatformName[] = ['youtube', 'tiktok', 'facebook'];

type TabId = 'calendar' | 'queue' | 'channels' | 'stats' | 'comments';

const PLATFORM_ICONS: Record<PlatformName, LucideIcon> = {
  youtube: Youtube,
  tiktok: Music2,
  facebook: Facebook
};

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

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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

/** Trạng thái tổng hợp của job để tô màu chip lịch. */
function jobKind(job: SocialJobSummary): string {
  const statuses = PLATFORMS.map(platform => job.platforms[platform].status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'running';
  if (statuses.every(status => status === 'published' || status === 'skipped')) return 'ok';
  if (statuses.includes('scheduled')) return 'scheduled';
  return 'pending';
}

function platformIcon(platform: PlatformName, size = 11) {
  const Icon = PLATFORM_ICONS[platform];
  return <Icon size={size} aria-hidden="true" />;
}

export default function SocialWorkspace(props: {
  service: SocialService;
  /** Dịch vụ creator phía web — cho phép chọn "Video đã dịch" trong composer. */
  creatorService?: CreatorWebService | null;
  projectId?: string;
  onBack(): void;
}) {
  const { t } = useAppLanguage();
  const service = props.service;
  const [overview, setOverview] = useState<SocialOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [activeTab, setActiveTab] = useState<TabId>('calendar');
  const [editing, setEditing] = useState<SocialClusterSummary | 'new' | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [handoffPath, setHandoffPath] = useState('');
  const [insightsKey, setInsightsKey] = useState(0);
  const [loginPending, setLoginPending] = useState<string | null>(null);

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
      setHandoffPath(handoff.path);
      setComposerOpen(true);
      setToast(t('dashboard.social.handoffLoaded'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clusters = overview?.clusters ?? [];
  const jobs = useMemo(() => {
    const list = overview?.jobs ?? [];
    return [...list].sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
  }, [overview]);
  const failedCount = overview?.counts.failed ?? 0;
  const queueRunning = overview?.queue !== 'paused';

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

  async function reschedule(job: SocialJobSummary, scheduledAtISO: string): Promise<void> {
    try {
      await service.rescheduleJob(job.id, scheduledAtISO);
      setToast(t('dashboard.social.rescheduled'));
      await load(false);
    } catch (cause) {
      setError(t('dashboard.social.calDropFailed', { message: messageOf(cause) }));
    }
  }

  async function enqueueFromComposer(items: SocialEnqueueItem[]): Promise<void> {
    try {
      const result = await service.enqueue(items);
      setToast(t('dashboard.social.composerSubmitted', { count: result.accepted }));
      setComposerOpen(false);
      setHandoffPath('');
      await load(false);
    } catch (cause) {
      setError(t('dashboard.social.actionFailed', { message: messageOf(cause) }));
    }
  }

  const openClusterLogin = useCallback(async (cluster: SocialClusterSummary, platform: SocialPlatformName): Promise<void> => {
    const key = `${cluster.id}:${platform}`;
    setLoginPending(key);
    try {
      await service.openClusterLogin(cluster.id, platform);
      setToast(t('dashboard.social.loginOpened'));
    } catch (cause) {
      setError(t('dashboard.social.actionFailed', { message: messageOf(cause) }));
    } finally {
      setLoginPending(null);
    }
  }, [service, t]);

  return (
    <div className="social-workspace" aria-label={t('dashboard.social.tabTitle')}>
      <header className="social-header">
        <div className="social-header-titles">
          <div className="social-header-back">
            <button type="button" className="social-btn social-btn-ghost" onClick={props.onBack}>
              <ArrowLeft size={14} aria-hidden="true" /> {t('settings.back')}
            </button>
          </div>
          <h1><MonitorSmartphone size={20} aria-hidden="true" /> {t('dashboard.social.tabTitle')}</h1>
          <p className="social-subtitle">{t('dashboard.social.subtitle')}</p>
        </div>
        <div className="social-header-actions">
          <button type="button" className="social-btn" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw size={14} aria-hidden="true" /> {t('dashboard.drama.refresh')}
          </button>
          <button type="button" className="social-btn social-btn-primary" onClick={() => setComposerOpen(true)}>
            <Plus size={14} aria-hidden="true" /> {t('dashboard.social.newPost')}
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

      {overview === null && loading ? (
        <p className="social-loading"><LoaderCircle size={16} className="social-spin" /> {t('dashboard.drama.loading')}</p>
      ) : null}

      <nav className="social-tabs" role="tablist" aria-label={t('dashboard.social.tabTitle')}>
        <TabButton id="calendar" icon={Calendar} label={t('dashboard.social.tabCalendar')} active={activeTab} onSelect={setActiveTab} />
        <TabButton id="queue" icon={ListVideo} label={t('dashboard.social.tabQueue')} active={activeTab} onSelect={setActiveTab} badge={failedCount > 0 ? failedCount : undefined} />
        <TabButton id="channels" icon={Tv} label={t('dashboard.social.tabChannels')} active={activeTab} onSelect={setActiveTab} />
        <TabButton id="stats" icon={BarChart3} label={t('dashboard.social.tabStats')} active={activeTab} onSelect={setActiveTab} />
        <TabButton id="comments" icon={MessageSquareReply} label={t('dashboard.social.tabComments')} active={activeTab} onSelect={setActiveTab} />
      </nav>

      {overview !== null ? (
        <section className="social-panel" role="tabpanel" aria-label={t('dashboard.social.tabTitle')}>
          {activeTab === 'calendar' ? (
            <CalendarPanel
              jobs={jobs}
              t={t}
              onReschedule={(job, iso) => void reschedule(job, iso)}
              onRemove={job => void action(t('dashboard.social.jobRemoved'), () => service.removeJob(job.id))}
              onRetry={job => void action(t('dashboard.social.retried'), () => service.retryFailedPlatforms(job.id))}
            />
          ) : null}
          {activeTab === 'queue' ? (
            <QueuePanel
              jobs={jobs}
              clusters={clusters}
              queueRunning={queueRunning}
              t={t}
              onToggleQueue={() => void action(
                queueRunning ? t('dashboard.social.paused') : t('dashboard.social.resumed'),
                () => queueRunning ? service.pauseQueue() : service.resumeQueue()
              )}
              onNewPost={() => setComposerOpen(true)}
              onEnqueue={(item, scheduledAt) => void action(
                t('dashboard.social.enqueued'),
                () => service.enqueue([{ ...item, ...(scheduledAt === '' ? {} : { scheduledAt }) }])
              )}
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
              onError={message => setError(message)}
              onRemove={job => void action(t('dashboard.social.jobRemoved'), () => service.removeJob(job.id))}
              onRetry={job => void action(t('dashboard.social.retried'), () => service.retryFailedPlatforms(job.id))}
            />
          ) : null}
          {activeTab === 'channels' ? (
            <ChannelsPanel
              clusters={clusters}
              t={t}
              onNewCluster={() => setEditing('new')}
              onCheckProxy={cluster => void action(t('dashboard.social.checkedProxy'), () => service.checkClusterProxy(cluster.id))}
              onOpenBrowser={cluster => void action(t('dashboard.social.browserOpened'), () => service.openClusterBrowser(cluster.id))}
              onCloseBrowser={cluster => void action(t('dashboard.social.browserClosed'), () => service.closeClusterBrowser(cluster.id))}
              onOpenLogin={openClusterLogin}
              onLoginPending={loginPending}
              onToggleAutoPublish={(cluster, enabled) => void action(
                t('dashboard.social.autoPublishSaved'),
                () => service.updateCluster(cluster.id, { autoPublishAfterTranslate: enabled })
              )}
              onEdit={cluster => setEditing(cluster)}
              onDelete={cluster => {
                if (window.confirm(t('dashboard.social.confirmDelete', { name: cluster.name }))) {
                  void action(t('dashboard.social.deletedCluster'), () => service.deleteCluster(cluster.id));
                }
              }}
            />
          ) : null}
          {activeTab === 'stats' ? (
            <SocialStatsPanel service={service} t={t} refreshKey={insightsKey} />
          ) : null}
          {activeTab === 'comments' ? (
            <SocialCommentsPanel service={service} clusters={clusters} t={t} refreshKey={insightsKey} />
          ) : null}
        </section>
      ) : null}

      <ComposerModal
        open={composerOpen}
        service={service}
        clusters={clusters}
        creatorService={props.creatorService}
        projectId={props.projectId}
        initialPath={handoffPath}
        t={t}
        onClose={() => { setComposerOpen(false); setHandoffPath(''); }}
        onEnqueue={items => enqueueFromComposer(items)}
      />

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

function TabButton(props: {
  id: TabId;
  icon: LucideIcon;
  label: string;
  active: TabId;
  onSelect(id: TabId): void;
  badge?: number;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active === props.id}
      className="social-tab"
      onClick={() => props.onSelect(props.id)}
    >
      <Icon size={15} aria-hidden="true" />
      {props.label}
      {props.badge !== undefined ? <span className="social-tab-badge">{props.badge}</span> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tab Lịch đăng — grid tuần/tháng + kéo-thả đổi giờ + danh sách
// ---------------------------------------------------------------------------

const MAX_CHIPS_PER_CELL = 4;

function CalendarPanel(props: {
  jobs: SocialJobSummary[];
  t: Translate;
  onReschedule(job: SocialJobSummary, scheduledAtISO: string): void;
  onRemove(job: SocialJobSummary): void;
  onRetry(job: SocialJobSummary): void;
}) {
  const { t } = props;
  const [view, setView] = useState<'week' | 'month' | 'list'>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<SocialJobSummary | null>(null);

  const byDay = useMemo(() => groupJobsByDay(props.jobs), [props.jobs]);
  const today = new Date();

  const days = view === 'month'
    ? monthGridDays(anchor)
    : eachDay(startOfWeek(anchor), 7);

  const rangeLabel = view === 'month'
    ? anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : view === 'week'
      ? `${days[0]!.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })} – ${days[days.length - 1]!.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })}`
      : t('dashboard.social.calListTitle', { count: props.jobs.length });

  function step(direction: number): void {
    setAnchor(current => view === 'month' ? addMonthsSafe(current, direction) : addDaysSafe(current, direction * 7));
  }

  return (
    <div className="social-calendar" aria-label={t('dashboard.social.tabCalendar')}>
      <div className="social-cal-toolbar">
        <div className="social-cal-nav">
          <button type="button" className="social-btn social-btn-icon" aria-label={t('dashboard.social.calPrev')} onClick={() => step(-1)}>
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <button type="button" className="social-btn social-btn-sm" onClick={() => setAnchor(new Date())}>
            {t('dashboard.social.calToday')}
          </button>
          <button type="button" className="social-btn social-btn-icon" aria-label={t('dashboard.social.calNext')} onClick={() => step(1)}>
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
        <p className="social-cal-title">{rangeLabel}</p>
        <div className="social-cal-viewswitch" role="group" aria-label={t('dashboard.social.tabCalendar')}>
          {(['week', 'month', 'list'] as const).map(id => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              className={`social-btn social-btn-sm ${view === id ? 'social-btn-primary' : ''}`}
              onClick={() => setView(id)}
            >
              {id === 'week' ? t('dashboard.social.calWeek') : id === 'month' ? t('dashboard.social.calMonth') : t('dashboard.social.calList')}
            </button>
          ))}
        </div>
      </div>

      {view !== 'list' ? (
        <>
          <div className="social-cal-weekdays" aria-hidden="true">
            {days.slice(0, 7).map(day => (
              <span key={dayKey(day)}>{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
            ))}
          </div>
          <div className={`social-cal-grid ${view === 'month' ? 'social-cal-grid-month' : ''}`}>
            {days.map(day => {
              const key = dayKey(day);
              const dayJobs = byDay.get(key) ?? [];
              const isOpen = expanded[key] === true;
              const visible = isOpen ? dayJobs : dayJobs.slice(0, MAX_CHIPS_PER_CELL);
              const hidden = dayJobs.length - visible.length;
              return (
                <div
                  key={key}
                  className={`social-cal-cell${isSameDay(day, today) ? ' social-cal-cell-today' : ''}${view === 'month' && day.getMonth() !== anchor.getMonth() ? ' social-cal-cell-other' : ''}`}
                  data-testid={`social-cal-cell-${key}`}
                  onDragOver={event => event.preventDefault()}
                  onDrop={event => {
                    event.preventDefault();
                    const id = event.dataTransfer.getData('text/plain');
                    const job = props.jobs.find(candidate => candidate.id === id);
                    if (job !== undefined && jobIsReschedulable(job)) {
                      props.onReschedule(job, shiftJobToDay(job, day));
                    }
                  }}
                >
                  <span className="social-cal-daynum">{day.getDate()}</span>
                  <div className="social-cal-chips">
                    {visible.map(job => (
                      <JobChip key={job.id} job={job} t={t} onClick={() => setEditing(job)} />
                    ))}
                    {hidden > 0 ? (
                      <button type="button" className="social-cal-more" onClick={() => setExpanded(current => ({ ...current, [key]: true }))}>
                        {t('dashboard.social.calMore', { count: hidden })}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          {props.jobs.length === 0 ? <p className="social-empty">{t('dashboard.social.calEmpty')}</p> : null}
          <p className="social-cal-hint">{t('dashboard.social.calHint')}</p>
        </>
      ) : (
        <ul className="social-cal-list">
          {props.jobs.length === 0 ? <li className="social-empty">{t('dashboard.social.calEmpty')}</li> : null}
          {props.jobs.map(job => (
            <li key={job.id}>
              <button type="button" className="social-cal-list-row" onClick={() => setEditing(job)}>
                <span className="social-cal-list-when">{formatSchedule(job.scheduledAt)}</span>
                <span className="social-cal-list-title" title={job.videoPath}>{job.title}</span>
                <span className="social-cal-list-cluster">{job.clusterName}</span>
                <span className="social-cal-list-dots">
                  {PLATFORMS.map(platform => (
                    <span key={platform} className={`social-dot social-dot-${platform} social-dot-${job.platforms[platform].status}`}>
                      {platformIcon(platform, 10)}
                    </span>
                  ))}
                </span>
                <span className={`social-chip social-chip-${jobKind(job)}`}>
                  {t(`dashboard.social.status_${jobKind(job)}` as never)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing !== null ? (
        <JobQuickEditModal
          job={editing}
          t={t}
          onClose={() => setEditing(null)}
          onSave={iso => { props.onReschedule(editing, iso); setEditing(null); }}
          onRemove={() => { props.onRemove(editing); setEditing(null); }}
          onRetry={() => { props.onRetry(editing); setEditing(null); }}
        />
      ) : null}
    </div>
  );
}

function addDaysSafe(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function addMonthsSafe(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + amount);
  return next;
}

function JobChip(props: { job: SocialJobSummary; t: Translate; onClick(): void }) {
  const { job } = props;
  const draggable = jobIsReschedulable(job);
  return (
    <button
      type="button"
      className={`social-cal-chip social-cal-chip-${jobKind(job)}`}
      draggable={draggable}
      title={draggable ? props.t('dashboard.social.calHint') : job.title}
      onClick={props.onClick}
      onDragStart={event => {
        event.dataTransfer.setData('text/plain', job.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <span className="social-cal-chip-top">
        <span className="social-cal-chip-time">{formatTime(job.scheduledAt)}</span>
        <span className="social-cal-chip-title" title={job.title}>{job.title}</span>
      </span>
      <span className="social-cal-chip-dots">
        {PLATFORMS.map(platform => (
          <span key={platform} className={`social-dot social-dot-${platform} social-dot-${job.platforms[platform].status}`}>
            {platformIcon(platform, 9)}
          </span>
        ))}
      </span>
    </button>
  );
}

function JobQuickEditModal(props: {
  job: SocialJobSummary;
  t: Translate;
  onClose(): void;
  onSave(scheduledAtISO: string): void;
  onRemove(): void;
  onRetry(): void;
}) {
  const { job, t } = props;
  const [time, setTime] = useState(() => toDatetimeLocalValue(job.scheduledAt));
  const hasFailed = PLATFORMS.some(platform => job.platforms[platform].status === 'failed');
  const reschedulable = jobIsReschedulable(job);
  return (
    <div className="social-modal-mask" role="dialog" aria-modal="true" aria-label={t('dashboard.social.quickEdit')}>
      <div className="social-modal">
        <h2>{t('dashboard.social.quickEdit')}</h2>
        <p className="social-quickedit-meta" title={job.videoPath}>
          {job.title} · {job.clusterName} · <CalendarClock size={11} aria-hidden="true" /> {formatSchedule(job.scheduledAt)}
        </p>
        <div className="social-job-platforms">
          {PLATFORMS.map(platform => {
            const kind = platformKind(job.platforms[platform].status);
            return (
              <span key={platform} className={`social-chip social-chip-${kind}`} title={job.platforms[platform].error ?? job.platforms[platform].videoId ?? undefined}>
                {platformIcon(platform)} {t(`dashboard.social.status_${kind}` as never)}
              </span>
            );
          })}
        </div>
        <div className="social-enqueue-row">
          <label htmlFor="social-quickedit-time">{t('dashboard.social.jobTime')}</label>
          <input
            id="social-quickedit-time"
            type="datetime-local"
            value={time}
            disabled={!reschedulable}
            onChange={event => setTime(event.target.value)}
          />
        </div>
        {!reschedulable ? <p className="social-enqueue-hint">{t('dashboard.social.calLocked')}</p> : null}
        <div className="social-modal-actions">
          <button type="button" className="social-btn" onClick={props.onClose}>{t('dashboard.drama.close')}</button>
          {hasFailed ? (
            <button type="button" className="social-btn" onClick={props.onRetry}>
              <RefreshCw size={13} aria-hidden="true" /> {t('dashboard.social.retry')}
            </button>
          ) : null}
          <button type="button" className="social-btn social-btn-danger" onClick={props.onRemove}>
            <Trash2 size={13} aria-hidden="true" /> {t('dashboard.social.remove')}
          </button>
          <button
            type="button"
            className="social-btn social-btn-primary"
            disabled={!reschedulable || time.trim() === ''}
            onClick={() => {
              const iso = fromDatetimeLocalValue(time);
              if (iso !== undefined) props.onSave(iso);
            }}
          >
            <Check size={13} aria-hidden="true" /> {t('dashboard.drama.rangeApply')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab Hàng đợi — form nạp nhanh + Excel + bảng job
// ---------------------------------------------------------------------------

function QueuePanel(props: {
  jobs: SocialJobSummary[];
  clusters: SocialClusterSummary[];
  queueRunning: boolean;
  t: Translate;
  onToggleQueue(): void;
  onNewPost(): void;
  onEnqueue(item: SocialEnqueueItem, scheduledAt: string): void;
  onEnqueueMany(items: SocialEnqueueItem[], summaryMessage: string): void;
  onError(message: string): void;
  onRemove(job: SocialJobSummary): void;
  onRetry(job: SocialJobSummary): void;
}) {
  const { t } = props;
  return (
    <div className="social-queue">
      <div className="social-panel-head">
        <h2>{t('dashboard.social.queueTitle')}</h2>
        <span className={`social-queue-state social-queue-state-${props.queueRunning ? 'running' : 'paused'}`}>
          {props.queueRunning ? t('dashboard.social.queueRunning') : t('dashboard.social.queuePaused')}
        </span>
        <div className="social-panel-head-actions">
          <button type="button" className="social-btn social-btn-sm" onClick={props.onNewPost}>
            <Plus size={13} aria-hidden="true" /> {t('dashboard.social.newPost')}
          </button>
          <button type="button" className="social-btn social-btn-sm" onClick={props.onToggleQueue}>
            {props.queueRunning ? t('dashboard.social.pauseQueue') : t('dashboard.social.resumeQueue')}
          </button>
        </div>
      </div>
      <p className="social-enqueue-hint">{t('dashboard.social.queueTranslatedHint')}</p>
      <EnqueueSheet
        clusters={props.clusters}
        t={t}
        onEnqueue={props.onEnqueue}
        onEnqueueMany={props.onEnqueueMany}
        onError={props.onError}
      />
      {props.jobs.length === 0 ? (
        <p className="social-empty">{t('dashboard.social.noJobs')}</p>
      ) : (
        <ul className="social-job-list">
          {props.jobs.map(job => (
            <JobRow
              key={job.id}
              job={job}
              t={t}
              onRemove={() => props.onRemove(job)}
              onRetry={() => props.onRetry(job)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ClusterCard(props: {
  cluster: SocialClusterSummary;
  t: Translate;
  loginPendingKey: string;
  onCheckProxy(): void;
  onOpenBrowser(): void;
  onCloseBrowser(): void;
  onOpenLogin(platform: SocialPlatformName): void;
  onToggleAutoPublish(enabled: boolean): void;
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
  const loginLabel: Record<string, string> = {
    ok: t('dashboard.social.loginOk'),
    expired: t('dashboard.social.loginExpired'),
    unknown: t('dashboard.social.loginUnknown')
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
        {PLATFORMS.map(platform => {
          const status = cluster.loginStatus[platform];
          const key = `${cluster.id}:${platform}`;
          return (
            <span key={platform} className="social-login-entry">
              <span
                className={`social-login social-login-${status}`}
                title={loginLabel[status] ?? status}
                data-testid={`social-login-status-${cluster.id}-${platform}`}
              >
                {platformIcon(platform, 10)} {platform} · {loginLabel[status] ?? t('dashboard.social.loginUnknown')}
              </span>
              <button
                type="button"
                className="social-btn social-btn-sm"
                disabled={props.loginPendingKey === key}
                onClick={() => props.onOpenLogin(platform)}
              >
                {props.loginPendingKey === key ? <LoaderCircle size={12} className="social-spin" /> : <KeyRound size={12} aria-hidden="true" />}
                {t('dashboard.social.loginAction')}
              </button>
            </span>
          );
        })}
      </div>
      <p className="social-cluster-meta">
        {t('dashboard.social.scheduleTimes', { times: cluster.defaultScheduleTimes.join(', ') })}
        {' · '}
        {t('dashboard.social.fbMode', { mode: cluster.fbMode === 'graph_api' ? 'Graph API' : 'Business Suite' })}
      </p>
      <label
        className="social-cluster-autopublish"
        title={t('dashboard.social.autoPublishHint')}
      >
        <input
          type="checkbox"
          data-testid={`social-autopublish-${cluster.id}`}
          checked={cluster.autoPublishAfterTranslate}
          onChange={event => props.onToggleAutoPublish(event.target.checked)}
        />
        {' '}{t('dashboard.social.autoPublishToggle')}
      </label>
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

function ChannelsPanel(props: {
  clusters: SocialClusterSummary[];
  t: Translate;
  onNewCluster(): void;
  onCheckProxy(cluster: SocialClusterSummary): void;
  onOpenBrowser(cluster: SocialClusterSummary): void;
  onCloseBrowser(cluster: SocialClusterSummary): void;
  onOpenLogin(cluster: SocialClusterSummary, platform: SocialPlatformName): Promise<void>;
  onLoginPending: string | null;
  onToggleAutoPublish(cluster: SocialClusterSummary, enabled: boolean): void;
  onEdit(cluster: SocialClusterSummary): void;
  onDelete(cluster: SocialClusterSummary): void;
}) {
  const { t } = props;
  return (
    <div className="social-channels">
      <div className="social-panel-head">
        <h2>{t('dashboard.social.clustersTitle', { count: props.clusters.length })}</h2>
        <div className="social-panel-head-actions">
          <button type="button" className="social-btn social-btn-primary" onClick={props.onNewCluster}>
            <Plus size={14} aria-hidden="true" /> {t('dashboard.social.newCluster')}
          </button>
        </div>
      </div>
      <p className="social-enqueue-hint">{t('dashboard.social.loginHint')}</p>
      {props.clusters.length === 0 ? (
        <p className="social-empty">{t('dashboard.social.noClusters')}</p>
      ) : (
        <ul className="social-cluster-grid">
          {props.clusters.map(cluster => (
            <ClusterCard
              key={cluster.id}
              cluster={cluster}
              t={props.t}
              loginPendingKey={props.onLoginPending ?? ''}
              onCheckProxy={() => props.onCheckProxy(cluster)}
              onOpenBrowser={() => props.onOpenBrowser(cluster)}
              onCloseBrowser={() => props.onCloseBrowser(cluster)}
              onOpenLogin={platform => void props.onOpenLogin(cluster, platform)}
              onToggleAutoPublish={enabled => props.onToggleAutoPublish(cluster, enabled)}
              onEdit={() => props.onEdit(cluster)}
              onDelete={() => props.onDelete(cluster)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function EnqueueSheet(props: {
  clusters: SocialClusterSummary[];
  t: Translate;
  onEnqueue(item: SocialEnqueueItem, scheduledAt: string): void;
  onEnqueueMany(items: SocialEnqueueItem[], summaryMessage: string): void;
  onError(message: string): void;
}) {
  const { t } = props;
  const [clusterId, setClusterId] = useState('');
  const [enqueuePath, setEnqueuePath] = useState('');
  const [title, setTitle] = useState('');
  const [scheduleNow, setScheduleNow] = useState('');
  useEffect(() => {
    if (props.clusters.length > 0 && clusterId === '') setClusterId(props.clusters[0]!.id);
  }, [clusterId, props.clusters]);
  const valid = enqueuePath.trim() !== '' && clusterId !== '';
  return (
    <div className="social-enqueue">
      <div className="social-enqueue-inline">
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
          <label htmlFor="social-enqueue-title">{t('dashboard.social.jobTitle')}</label>
          <input
            id="social-enqueue-title"
            type="text"
            placeholder={t('dashboard.social.jobTitlePlaceholder')}
            value={title}
            onChange={event => setTitle(event.target.value)}
          />
        </div>
      </div>
      <div className="social-enqueue-row">
        <label htmlFor="social-enqueue-path">{t('dashboard.social.videoPath')}</label>
        <input
          id="social-enqueue-path"
          type="text"
          placeholder={t('dashboard.social.videoPathPlaceholder')}
          value={enqueuePath}
          onChange={event => setEnqueuePath(event.target.value)}
        />
      </div>
      <div className="social-enqueue-row">
        <label htmlFor="social-enqueue-schedule"><CalendarClock size={12} aria-hidden="true" /> {t('dashboard.social.scheduleAt')}</label>
        <input
          id="social-enqueue-schedule"
          type="datetime-local"
          value={scheduleNow}
          onChange={event => setScheduleNow(event.target.value)}
        />
      </div>
      <div className="social-enqueue-actions">
        <button
          type="button"
          className="social-btn social-btn-primary"
          disabled={!valid}
          onClick={() => {
            props.onEnqueue({ clusterId, path: enqueuePath.trim(), ...(title.trim() === '' ? {} : { title: title.trim() }) }, scheduleNow);
            setEnqueuePath('');
            setScheduleNow('');
          }}
        >
          <Plus size={14} aria-hidden="true" /> {t('dashboard.social.enqueue')}
        </button>
        <ExcelImportButton
          clusters={props.clusters}
          t={t}
          onEnqueueMany={props.onEnqueueMany}
          onError={message => props.onError(message)}
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
  const failedPlatforms = PLATFORMS.filter(platform => job.platforms[platform].status === 'failed');
  const hasFailed = failedPlatforms.length > 0;
  return (
    <li className={`social-job-row${hasFailed ? ' social-job-row-failed' : ''}`}>
      <div className="social-job-main">
        <p className="social-job-title" title={job.videoPath}>{job.title}</p>
        <p className="social-job-meta">
          {job.clusterName} · <CalendarClock size={11} aria-hidden="true" /> {formatSchedule(job.scheduledAt)}
        </p>
        {hasFailed ? (
          <p className="social-job-error">
            {failedPlatforms.map(platform => `${platform}: ${job.platforms[platform].error ?? t('dashboard.social.status_failed')}`).join(' · ')}
          </p>
        ) : null}
      </div>
      <div className="social-job-platforms">
        {PLATFORMS.map(platform => {
          const state = job.platforms[platform];
          const kind = platformKind(state.status);
          return (
            <span key={platform} className={`social-chip social-chip-${kind}`} title={state.error ?? state.videoId ?? undefined}>
              {platformIcon(platform)} {t(`dashboard.social.status_${kind}` as never)}
            </span>
          );
        })}
      </div>
      <div className="social-job-actions">
        {hasFailed ? <button type="button" className="social-btn social-btn-sm social-btn-retry" onClick={props.onRetry}><RefreshCw size={12} aria-hidden="true" /> {t('dashboard.social.retry')}</button> : null}
        <button type="button" className="social-btn social-btn-sm social-btn-danger" onClick={props.onRemove}>{t('dashboard.social.remove')}</button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Composer đa kênh — media picker + cụm + cài đặt từng nền tảng + preview
// ---------------------------------------------------------------------------

type MediaSourceTab = 'translated' | 'downloads';

function ComposerModal(props: {
  open: boolean;
  service: SocialService;
  clusters: SocialClusterSummary[];
  /** Dịch vụ creator phía web — có thể undefined (chỉ còn nguồn "Video tải về"). */
  creatorService?: CreatorWebService | null;
  projectId?: string;
  initialPath: string;
  t: Translate;
  onClose(): void;
  onEnqueue(items: SocialEnqueueItem[]): Promise<void>;
}) {
  const { t } = props;
  const [path, setPath] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [schedule, setSchedule] = useState('');
  const [downloads, setDownloads] = useState<SocialDownloadItem[] | null>(null);
  const [downloadsError, setDownloadsError] = useState('');
  const [translatedVideos, setTranslatedVideos] = useState<SocialTranslatedVideo[] | null>(null);
  const [translatedError, setTranslatedError] = useState('');
  // 2 nguồn chọn media: "Video đã dịch" (luồng dịch → đăng) là mặc định khi
  // có creator service; không có creator service → chỉ còn nguồn tải về.
  const [sourceTab, setSourceTab] = useState<MediaSourceTab>(
    () => props.creatorService == null ? 'downloads' : 'translated'
  );
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [yt, setYt] = useState({ privacy: 'public', tags: '', madeForKids: false });
  const [tk, setTk] = useState({ privacy: 'public', allowDuet: true, allowStitch: true, allowComments: true, directPost: false });
  const [fb, setFb] = useState({ postType: 'post' });
  const [openSections, setOpenSections] = useState<Record<'youtube' | 'tiktok' | 'facebook', boolean>>({
    youtube: false, tiktok: false, facebook: false
  });

  useEffect(() => {
    if (!props.open) return;
    setPath(props.initialPath);
    let alive = true;
    props.service.listDownloads(500)
      .then(result => { if (alive) { setDownloads(result.items); setDownloadsError(''); } })
      .catch(cause => { if (alive) setDownloadsError(messageOf(cause)); });
    // Nguồn "Video đã dịch": creator service có thể không tồn tại (chỉ còn tải về).
    if (props.creatorService !== undefined && props.creatorService !== null) {
      listTranslatedVideos(props.creatorService, props.projectId)
        .then(result => { if (alive) { setTranslatedVideos(result.items); setTranslatedError(''); } })
        .catch(cause => { if (alive) { setTranslatedVideos([]); setTranslatedError(messageOf(cause)); } });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.initialPath]);

  if (!props.open) return null;

  const hasTranslatedSource = props.creatorService != null;
  const needle = search.trim().toLowerCase();
  const translateFilter = (titleText: string, subtitle: string, pathText: string): boolean => {
    if (needle === '') return true;
    return titleText.toLowerCase().includes(needle)
      || subtitle.toLowerCase().includes(needle)
      || pathText.toLowerCase().includes(needle);
  };
  const filteredDownloads = (downloads ?? []).filter(item =>
    translateFilter(item.title, item.seriesName, item.path)
  );
  const filteredTranslated = (translatedVideos ?? []).filter(item => translateFilter(item.title, item.jobId, item.path));
  const selectedClusters = props.clusters.filter(cluster => selectedIds.has(cluster.id));
  const pathOk = path.trim() !== '';
  const clustersOk = selectedClusters.length > 0;
  const slotTimes = [...new Set(selectedClusters.flatMap(cluster => cluster.defaultScheduleTimes))];

  const settings: SocialJobPlatformSettings = {
    youtube: {
      privacy: yt.privacy,
      ...(yt.tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '').length > 0
        ? { tags: yt.tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '') }
        : {}),
      ...(yt.madeForKids ? { madeForKids: true } : {})
    },
    tiktok: {
      privacy: tk.privacy,
      allowDuet: tk.allowDuet,
      allowStitch: tk.allowStitch,
      allowComments: tk.allowComments,
      directPost: tk.directPost
    },
    facebook: { postType: fb.postType }
  };

  function pickDownload(item: SocialDownloadItem): void {
    setPath(item.path);
    if (title.trim() === '') setTitle(item.title !== '' ? item.title : fileNameOf(item.path));
  }

  function pickTranslated(item: SocialTranslatedVideo): void {
    setPath(item.path);
    if (title.trim() === '') setTitle(item.title);
  }

  function submit(): void {
    if (!pathOk || !clustersOk || submitting) return;
    const items = composeEnqueueItems({
      clusters: selectedClusters,
      path,
      title,
      description,
      scheduledAt: schedule,
      settings
    });
    setSubmitting(true);
    props.onEnqueue(items)
      .catch(() => undefined)
      .finally(() => setSubmitting(false));
  }

  const ytPrivacyLabels: Record<string, string> = {
    public: t('dashboard.social.ytPrivacyPublic'),
    unlisted: t('dashboard.social.ytPrivacyUnlisted'),
    private: t('dashboard.social.ytPrivacyPrivate')
  };
  const tkPrivacyLabels: Record<string, string> = {
    public: t('dashboard.social.tkPrivacyPublic'),
    friends: t('dashboard.social.tkPrivacyFriends'),
    private: t('dashboard.social.tkPrivacyPrivate')
  };
  const fbPostTypeLabels: Record<string, string> = {
    post: t('dashboard.social.fbPostTypePost'),
    reel: t('dashboard.social.fbPostTypeReel'),
    story: t('dashboard.social.fbPostTypeStory')
  };

  return (
    <div className="social-modal-mask" role="dialog" aria-modal="true" aria-label={t('dashboard.social.composerTitle')}>
      <div className="social-composer">
        <header className="social-composer-head">
          <h2>{t('dashboard.social.composerTitle')}</h2>
          <button type="button" className="social-btn social-btn-ghost" onClick={props.onClose} aria-label={t('dashboard.drama.close')}>✕</button>
        </header>

        <div className="social-composer-cols">
          <div className="social-composer-col">
            <section className="social-composer-section" aria-label={t('dashboard.social.composerPickVideo')}>
              <h3><FileVideo size={14} aria-hidden="true" /> {t('dashboard.social.composerPickVideo')}</h3>
              {hasTranslatedSource ? (
                <div
                  className="social-media-sources"
                  role="tablist"
                  aria-label={t('dashboard.social.composerPickVideo')}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={sourceTab === 'translated'}
                    className={`social-btn social-btn-sm${sourceTab === 'translated' ? ' social-btn-primary' : ''}`}
                    onClick={() => setSourceTab('translated')}
                  >
                    {t('dashboard.social.composerSourceTranslated')}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={sourceTab === 'downloads'}
                    className={`social-btn social-btn-sm${sourceTab === 'downloads' ? ' social-btn-primary' : ''}`}
                    onClick={() => setSourceTab('downloads')}
                  >
                    {t('dashboard.social.composerSourceDownloads')}
                  </button>
                </div>
              ) : null}
              <input
                type="search"
                className="social-media-search"
                placeholder={t('dashboard.social.composerSearchVideo')}
                value={search}
                onChange={event => setSearch(event.target.value)}
              />
              {sourceTab === 'downloads' && downloadsError !== '' ? <p className="social-warn-text">{downloadsError}</p> : null}
              {sourceTab === 'translated' && translatedError !== '' ? <p className="social-warn-text">{translatedError}</p> : null}
              {sourceTab === 'translated' && filteredTranslated.length === 0 ? (
                <p className="social-empty">{t('dashboard.social.composerNoTranslated')}</p>
              ) : null}
              {sourceTab === 'downloads' && downloads !== null && filteredDownloads.length === 0 ? (
                <p className="social-empty">{t('dashboard.social.composerNoVideos')}</p>
              ) : null}
              <div className="social-media-grid">
                {sourceTab === 'translated' ? filteredTranslated.map(item => {
                  const selected = path.trim() !== '' && item.path === path.trim();
                  return (
                    <button
                      key={item.artifactId}
                      type="button"
                      className={`social-media-card${selected ? ' social-media-card-selected' : ''}`}
                      aria-pressed={selected}
                      onClick={() => pickTranslated(item)}
                    >
                      <span className="social-media-thumb"><FileVideo size={20} aria-hidden="true" /></span>
                      <span className="social-media-name" title={item.title}>{item.title}</span>
                      <span className="social-media-series">{t('dashboard.social.composerSourceTranslated')} · V{item.version}</span>
                      <span className="social-media-meta">{t('dashboard.social.translatedMeta', { time: formatSchedule(item.completedAt) })}</span>
                    </button>
                  );
                }) : filteredDownloads.map(item => {
                  const selected = path.trim() !== '' && item.path === path.trim();
                  return (
                    <button
                      key={item.path}
                      type="button"
                      className={`social-media-card${selected ? ' social-media-card-selected' : ''}`}
                      aria-pressed={selected}
                      onClick={() => pickDownload(item)}
                    >
                      <span className="social-media-thumb"><FileVideo size={20} aria-hidden="true" /></span>
                      <span className="social-media-name" title={item.title}>{item.title !== '' ? item.title : fileNameOf(item.path)}</span>
                      {item.seriesName !== '' ? <span className="social-media-series">{item.seriesName}</span> : null}
                      <span className="social-media-meta">{formatBytes(item.sizeBytes)} · {t('dashboard.social.composerDownloaded', { time: formatSchedule(item.downloadedAt) })}</span>
                    </button>
                  );
                })}
              </div>
              <div className="social-enqueue-row">
                <label htmlFor="social-composer-path">{t('dashboard.social.videoPath')}</label>
                <input
                  id="social-composer-path"
                  type="text"
                  placeholder={t('dashboard.social.videoPathPlaceholder')}
                  value={path}
                  onChange={event => setPath(event.target.value)}
                />
              </div>
              <div className="social-enqueue-row">
                <label htmlFor="social-composer-title">{t('dashboard.social.jobTitle')}</label>
                <input
                  id="social-composer-title"
                  type="text"
                  placeholder={t('dashboard.social.jobTitlePlaceholder')}
                  value={title}
                  onChange={event => setTitle(event.target.value)}
                />
              </div>
              <div className="social-enqueue-row">
                <label htmlFor="social-composer-desc">{t('dashboard.social.defaultDescription')}</label>
                <textarea
                  id="social-composer-desc"
                  rows={3}
                  value={description}
                  onChange={event => setDescription(event.target.value)}
                />
              </div>
            </section>

            <section className="social-composer-section" aria-label={t('dashboard.social.composerClusters')}>
              <h3><Tv size={14} aria-hidden="true" /> {t('dashboard.social.composerClusters')}</h3>
              <div className="social-cluster-picker">
                {props.clusters.map(cluster => {
                  const label = cluster.seriesName !== '' ? cluster.seriesName : cluster.name;
                  const selected = selectedIds.has(cluster.id);
                  return (
                    <label key={cluster.id} className={`social-cluster-option${selected ? ' social-cluster-option-selected' : ''}`}>
                      <input
                        type="checkbox"
                        checked={selected}
                        aria-label={label}
                        onChange={() => {
                          setSelectedIds(current => {
                            const next = new Set(current);
                            if (next.has(cluster.id)) next.delete(cluster.id);
                            else next.add(cluster.id);
                            return next;
                          });
                        }}
                      />
                      <span className="social-cluster-option-name">{label}</span>
                      <span className="social-cluster-option-badges">
                        {PLATFORMS.map(platform => (
                          <span key={platform} className={`social-dot social-dot-${platform} social-dot-${cluster.loginStatus[platform] === 'ok' ? 'published' : 'pending'}`}>
                            {platformIcon(platform, 10)}
                          </span>
                        ))}
                      </span>
                    </label>
                  );
                })}
                {props.clusters.length === 0 ? <p className="social-empty">{t('dashboard.social.noClusters')}</p> : null}
              </div>
            </section>

            <section className="social-composer-section" aria-label={t('dashboard.social.composerSchedule')}>
              <h3><CalendarClock size={14} aria-hidden="true" /> {t('dashboard.social.composerSchedule')}</h3>
              <div className="social-enqueue-inline">
                <div className="social-enqueue-row">
                  <label htmlFor="social-composer-schedule">{t('dashboard.social.scheduleAt')}</label>
                  <input
                    id="social-composer-schedule"
                    type="datetime-local"
                    value={schedule}
                    onChange={event => setSchedule(event.target.value)}
                  />
                </div>
                <div className="social-enqueue-row">
                  <label htmlFor="social-composer-slot">{t('dashboard.social.composerUseSlot')}</label>
                  <button
                    id="social-composer-slot"
                    type="button"
                    className="social-btn"
                    disabled={slotTimes.length === 0}
                    onClick={() => {
                      const slot = nextGoldenSlot(slotTimes);
                      if (slot !== null) setSchedule(toDatetimeLocalValue(slot.toISOString()));
                    }}
                  >
                    <CalendarClock size={13} aria-hidden="true" /> {t('dashboard.social.composerUseSlot')}
                  </button>
                </div>
              </div>
              <p className="social-enqueue-hint">{t('dashboard.social.enqueueHint')}</p>
              <p className="social-enqueue-hint">{t('dashboard.social.queueTranslatedHint')}</p>
              <div className="social-enqueue-actions">
                <button type="button" className="social-btn social-btn-sm" onClick={() => downloadTemplate()}>
                  {t('dashboard.social.excelTemplate')}
                </button>
              </div>
            </section>
          </div>

          <div className="social-composer-col">
            <section className="social-composer-section" aria-label={t('dashboard.social.composerSettings')}>
              <h3>{t('dashboard.social.composerSettings')}</h3>
              <div className="social-acc">
                <button type="button" className="social-acc-head" aria-expanded={openSections.youtube} onClick={() => setOpenSections(current => ({ ...current, youtube: !current.youtube }))}>
                  <span className="social-dot social-dot-youtube">{platformIcon('youtube', 11)}</span>
                  {t('dashboard.social.youtubeSettings')}
                  <span className="social-acc-summary">{ytPrivacyLabels[yt.privacy] ?? yt.privacy}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                {openSections.youtube ? (
                  <div className="social-acc-body">
                    <div className="social-enqueue-row">
                      <label htmlFor="social-yt-privacy">{t('dashboard.social.ytPrivacy')}</label>
                      <select id="social-yt-privacy" value={yt.privacy} onChange={event => setYt({ ...yt, privacy: event.target.value })}>
                        <option value="public">{t('dashboard.social.ytPrivacyPublic')}</option>
                        <option value="unlisted">{t('dashboard.social.ytPrivacyUnlisted')}</option>
                        <option value="private">{t('dashboard.social.ytPrivacyPrivate')}</option>
                      </select>
                    </div>
                    <div className="social-enqueue-row">
                      <label htmlFor="social-yt-tags">{t('dashboard.social.ytTags')}</label>
                      <input id="social-yt-tags" type="text" value={yt.tags} onChange={event => setYt({ ...yt, tags: event.target.value })} placeholder="phim, review, tap-1" />
                    </div>
                    <label className="social-switch">
                      <input type="checkbox" checked={yt.madeForKids} onChange={event => setYt({ ...yt, madeForKids: event.target.checked })} />
                      {t('dashboard.social.ytMadeForKids')}
                    </label>
                  </div>
                ) : null}
              </div>
              <div className="social-acc">
                <button type="button" className="social-acc-head" aria-expanded={openSections.tiktok} onClick={() => setOpenSections(current => ({ ...current, tiktok: !current.tiktok }))}>
                  <span className="social-dot social-dot-tiktok">{platformIcon('tiktok', 11)}</span>
                  {t('dashboard.social.tiktokSettings')}
                  <span className="social-acc-summary">{tk.directPost ? t('dashboard.social.tkDirectPostOn') : tkPrivacyLabels[tk.privacy] ?? tk.privacy}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                {openSections.tiktok ? (
                  <div className="social-acc-body">
                    <div className="social-enqueue-row">
                      <label htmlFor="social-tk-privacy">{t('dashboard.social.tkPrivacy')}</label>
                      <select id="social-tk-privacy" value={tk.privacy} onChange={event => setTk({ ...tk, privacy: event.target.value })}>
                        <option value="public">{t('dashboard.social.tkPrivacyPublic')}</option>
                        <option value="friends">{t('dashboard.social.tkPrivacyFriends')}</option>
                        <option value="private">{t('dashboard.social.tkPrivacyPrivate')}</option>
                      </select>
                    </div>
                    <label className="social-switch">
                      <input type="checkbox" checked={tk.allowDuet} onChange={event => setTk({ ...tk, allowDuet: event.target.checked })} />
                      {t('dashboard.social.tkAllowDuet')}
                    </label>
                    <label className="social-switch">
                      <input type="checkbox" checked={tk.allowStitch} onChange={event => setTk({ ...tk, allowStitch: event.target.checked })} />
                      {t('dashboard.social.tkAllowStitch')}
                    </label>
                    <label className="social-switch">
                      <input type="checkbox" checked={tk.allowComments} onChange={event => setTk({ ...tk, allowComments: event.target.checked })} />
                      {t('dashboard.social.tkAllowComments')}
                    </label>
                    <label className="social-switch">
                      <input type="checkbox" checked={tk.directPost} onChange={event => setTk({ ...tk, directPost: event.target.checked })} />
                      {t('dashboard.social.tkDirectPost')}
                    </label>
                  </div>
                ) : null}
              </div>
              <div className="social-acc">
                <button type="button" className="social-acc-head" aria-expanded={openSections.facebook} onClick={() => setOpenSections(current => ({ ...current, facebook: !current.facebook }))}>
                  <span className="social-dot social-dot-facebook">{platformIcon('facebook', 11)}</span>
                  {t('dashboard.social.facebookSettings')}
                  <span className="social-acc-summary">{fbPostTypeLabels[fb.postType] ?? fb.postType}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                {openSections.facebook ? (
                  <div className="social-acc-body">
                    <div className="social-enqueue-row">
                      <label htmlFor="social-fb-posttype">{t('dashboard.social.fbPostType')}</label>
                      <select id="social-fb-posttype" value={fb.postType} onChange={event => setFb({ postType: event.target.value })}>
                        <option value="post">{t('dashboard.social.fbPostTypePost')}</option>
                        <option value="reel">{t('dashboard.social.fbPostTypeReel')}</option>
                        <option value="story">{t('dashboard.social.fbPostTypeStory')}</option>
                      </select>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="social-composer-section" aria-label={t('dashboard.social.composerPreview')}>
              <h3>{t('dashboard.social.composerPreview')}</h3>
              <div className="social-preview-card">
                <span className="social-preview-thumb"><FileVideo size={22} aria-hidden="true" /></span>
                <div className="social-preview-body">
                  <p className="social-preview-title" title={title}>{title.trim() !== '' ? title.trim() : (path.trim() !== '' ? fileNameOf(path) : t('dashboard.social.jobTitlePlaceholder'))}</p>
                  {description.trim() !== '' ? <p className="social-preview-desc">{description.trim().length > 90 ? `${description.trim().slice(0, 90)}…` : description.trim()}</p> : null}
                  <div className="social-preview-chips">
                    {selectedClusters.slice(0, 3).map(cluster => (
                      <span key={cluster.id} className="social-chip social-chip-pending">{cluster.seriesName !== '' ? cluster.seriesName : cluster.name}</span>
                    ))}
                    {selectedClusters.length > 3 ? <span className="social-chip social-chip-pending">{t('dashboard.social.calMore', { count: selectedClusters.length - 3 })}</span> : null}
                    {PLATFORMS.map(platform => (
                      <span key={platform} className={`social-dot social-dot-${platform} social-dot-published`}>{platformIcon(platform, 10)}</span>
                    ))}
                  </div>
                  <p className="social-preview-when">
                    {schedule.trim() !== ''
                      ? formatSchedule(fromDatetimeLocalValue(schedule) ?? schedule)
                      : t('dashboard.social.composerAutoSlot')}
                  </p>
                </div>
              </div>
            </section>
          </div>
        </div>

        <footer className="social-composer-foot">
          <p className="social-composer-hint">
            {!pathOk ? t('dashboard.social.composerNeedVideo') : !clustersOk ? t('dashboard.social.composerNeedCluster') : ''}
          </p>
          <button
            type="button"
            className="social-btn social-btn-primary"
            disabled={!pathOk || !clustersOk || submitting}
            onClick={submit}
          >
            {submitting ? <LoaderCircle size={14} className="social-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
            {t('dashboard.social.composerSubmit', { count: selectedClusters.length })}
          </button>
        </footer>
      </div>
    </div>
  );
}

function fileNameOf(path: string): string {
  const parts = path.trim().split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

// ---------------------------------------------------------------------------
// Editor cụm kênh (giữ nguyên logic, trình bày mới)
// ---------------------------------------------------------------------------

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
              {t('dashboard.social.fbPageToken')}{cluster !== null && cluster.fbPageTokenConfigured ? ` · ${t('dashboard.social.tokenSaved')}` : ''}
            </label>
            <input
              id="social-cluster-fbtoken"
              type="password"
              placeholder={cluster !== null && cluster.fbPageTokenConfigured ? t('dashboard.social.tokenPlaceholder') : 'EAAG…'}
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
