import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Facebook,
  FileVideo,
  KeyRound,
  LoaderCircle,
  Music2,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Youtube
} from 'lucide-react';
import { useAppLanguage, type Translate } from '../../i18n/LanguageProvider.js';
import type {
  SocialClusterSummary,
  SocialClusterInput,
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
import { browserBridge } from '../../host/browser-bridge.js';
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
import { ExcelImportButton } from './social-excel.js';
import { SocialCommentsPanel, SocialStatsPanel } from './social-insights.js';
import {
  takePendingSocialHandoffSource
} from './pending-social-handoff.js';
import './social-workspace.css';

type PlatformName = 'youtube' | 'tiktok' | 'facebook';

const PLATFORMS: PlatformName[] = ['youtube', 'tiktok', 'facebook'];

type TabId = 'channels' | 'calendar' | 'queue' | 'stats' | 'comments';

const PLATFORM_ICONS: Record<PlatformName, LucideIcon> = {
  youtube: Youtube,
  tiktok: Music2,
  facebook: Facebook
};

/** Nhãn tab trùng khớp demo đã chốt. */
const TAB_LABELS: Record<TabId, string> = {
  channels: '1. Nhóm Tài Khoản',
  calendar: '2. Lịch Đăng & Composer Đa Kênh',
  queue: '3. Hàng Đợi & Trình Soi Lỗi',
  stats: '4. Thống Kê Tài Khoản',
  comments: '5. Trung Tâm Bình Luận AI + Playground'
};

type LogLine = { time: string; text: string; level: 'info' | 'error' | 'action' };

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return String(error ?? 'unknown error');
}

function formatSchedule(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
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

function platformEmoji(platform: PlatformName): string {
  return platform === 'youtube' ? '▶️' : platform === 'tiktok' ? '🎵' : '📘';
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
  const [activeTab, setActiveTab] = useState<TabId>('channels');
  const [editing, setEditing] = useState<SocialClusterSummary | 'new' | null>(null);
  const [handoffPath, setHandoffPath] = useState('');
  const [insightsKey, setInsightsKey] = useState(0);
  const [loginModal, setLoginModal] = useState<{ cluster: SocialClusterSummary; platform: SocialPlatformName } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [creatingChannel, setCreatingChannel] = useState('');
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [selectedJobId, setSelectedJobId] = useState('');
  const overviewRef = useRef<SocialOverview | null>(null);

  const pushLog = useCallback((text: string, level: LogLine['level'] = 'info') => {
    setLogs(current => [
      ...current.slice(-199),
      { time: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }), text, level }
    ]);
  }, []);

  const load = useCallback(async (showSpinner: boolean): Promise<void> => {
    if (showSpinner) setLoading(true);
    try {
      const data = await service.getOverview();
      const previous = overviewRef.current;
      // Nhật ký thực: nền tảng lỗi mới / nền tảng vừa công khai.
      if (previous !== null) {
        for (const job of data.jobs) {
          const before = previous.jobs.find(candidate => candidate.id === job.id);
          if (before === undefined) continue;
          for (const platform of PLATFORMS) {
            const beforeStatus = before.platforms[platform].status;
            const nowStatus = job.platforms[platform].status;
            if (nowStatus === beforeStatus) continue;
            if (nowStatus === 'failed') {
              pushLog(`❌ [${job.clusterName} - ${platform}] ${job.title}: ${job.platforms[platform].error ?? 'lỗi'}`, 'error');
            } else if (nowStatus === 'published') {
              pushLog(`✅ [${job.clusterName} - ${platform}] Đã công khai: ${job.title}`);
            } else if (nowStatus === 'running') {
              pushLog(`🔄 [${job.clusterName} - ${platform}] Đang tải lên: ${job.title}`);
            }
          }
        }
      }
      overviewRef.current = data;
      setOverview(data);
      setError('');
      setInsightsKey(key => key + 1);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [service, pushLog]);

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
      setActiveTab('calendar');
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

  // Chọn job mặc định cho Trình Soi Lỗi: job lỗi đầu tiên, nếu không có thì job đầu tiên.
  useEffect(() => {
    if (jobs.length === 0) {
      if (selectedJobId !== '') setSelectedJobId('');
      return;
    }
    if (jobs.some(job => job.id === selectedJobId)) return;
    const failedJob = jobs.find(job => jobKind(job) === 'failed');
    const fallback = failedJob ?? (jobs.length > 0 ? jobs[0] : undefined);
    if (fallback !== undefined) setSelectedJobId(fallback.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  async function action(showToast: string, run: () => Promise<unknown>): Promise<void> {
    try {
      const result = await run();
      if (result !== undefined && result !== null && typeof result === 'object' && 'clusters' in result) {
        setOverview(result as SocialOverview);
        overviewRef.current = result as SocialOverview;
      } else {
        await load(false);
      }
      if (showToast !== '') setToast(showToast);
    } catch (cause) {
      setError(messageOf(cause));
      pushLog(`⚠️ ${messageOf(cause)}`, 'error');
    }
  }

  async function reschedule(job: SocialJobSummary, scheduledAtISO: string): Promise<void> {
    try {
      await service.rescheduleJob(job.id, scheduledAtISO);
      setToast(t('dashboard.social.rescheduled'));
      pushLog(`📅 Đã hẹn giờ lại job ${shortJobId(job.id)} @ ${formatSchedule(scheduledAtISO)}`, 'action');
      await load(false);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function enqueueFromComposer(items: SocialEnqueueItem[]): Promise<void> {
    try {
      const result = await service.enqueue(items);
      setToast(t('dashboard.social.composerSubmitted', { count: result.accepted }));
      setHandoffPath('');
      pushLog(`📤 Đã nạp ${result.accepted} bài đăng vào hàng đợi (auto-slot khung giờ vàng khi để trống giờ)`, 'action');
      await load(false);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  /** Danh sách nền tảng chưa đăng nhập của cụm (lấy nền tảng ưu tiên). */
  function firstPendingLoginPlatformLocal(cluster: SocialClusterSummary): SocialPlatformName {
    return firstPendingLoginPlatform(cluster);
  }

  const openSocialLogin = useCallback((cluster: SocialClusterSummary, platform: SocialPlatformName): Promise<void> =>
    service.openClusterLogin(cluster.id, platform).then(() => undefined), [service]);

  return (
    <div className={`social-workspace${consoleOpen ? '' : ' social-console-hidden'}`} aria-label={t('dashboard.social.tabTitle')}>
      <header className="social-header">
        <div className="social-header-back">
          <button type="button" className="social-btn" onClick={props.onBack}>
            🏠 Về Trang Chủ
          </button>
        </div>
        <div className="social-header-titles">
          <span aria-hidden="true" style={{ fontSize: 17 }}>🌐</span>
          <h1>{t('dashboard.social.tabTitle')}</h1>
        </div>
        <div className="social-header-actions">
          <button
            type="button"
            className={`social-btn ${queueRunning ? 'social-btn-danger' : 'social-btn-green'}`}
            onClick={() => {
              if (queueRunning) {
                pushLog('⏸️ [System] Đã tạm dừng hàng đợi theo lệnh người dùng.', 'action');
                void action(t('dashboard.social.paused'), () => service.pauseQueue());
              } else {
                pushLog('▶️ [System] Hàng đợi tiếp tục chạy.', 'action');
                void action(t('dashboard.social.resumed'), () => service.resumeQueue());
              }
            }}
          >
            {queueRunning ? '⏸️ Dừng Khẩn Cấp' : '▶️ Tiếp Tục Chạy'}
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
        <TabButton id="channels" label={TAB_LABELS.channels} active={activeTab} onSelect={setActiveTab} />
        <TabButton id="calendar" label={TAB_LABELS.calendar} active={activeTab} onSelect={setActiveTab} />
        <TabButton
          id="queue"
          label={TAB_LABELS.queue}
          active={activeTab}
          onSelect={setActiveTab}
          badge={failedCount > 0 ? `${failedCount} Lỗi` : undefined}
        />
        <TabButton id="stats" label={TAB_LABELS.stats} active={activeTab} onSelect={setActiveTab} />
        <TabButton id="comments" label={TAB_LABELS.comments} active={activeTab} onSelect={setActiveTab} />
      </nav>

      {overview !== null ? (
        <section className="social-panel" role="tabpanel" aria-label={t('dashboard.social.tabTitle')}>
          {activeTab === 'channels' ? (
            <ChannelsPanel
              clusters={clusters}
              t={t}
              loginPendingPlatform={loginModal !== null ? `${loginModal.cluster.id}:${loginModal.platform}` : ''}
              onOpenLogin={(cluster, platform) => setLoginModal({ cluster, platform })}
              onToggleAutoPublish={(cluster, enabled) => void action(
                t('dashboard.social.autoPublishSaved'),
                () => service.updateCluster(cluster.id, { autoPublishAfterTranslate: enabled })
              )}
              onEdit={cluster => setEditing(cluster)}
              onNewCluster={() => setEditing('new')}
              onDeleteCluster={cluster => void action(
                t('dashboard.social.removedCluster'),
                () => service.deleteCluster(cluster.id)
              )}
              onCreateChannel={cluster => {
                const suggested = cluster.seriesName !== '' ? cluster.seriesName : cluster.name;
                const name = window.prompt('Nhập tên kênh YouTube muốn tạo (Brand Account):', suggested);
                if (name === null || name.trim() === '') return;
                setCreatingChannel(cluster.id);
                service.createYoutubeChannel(cluster.id, name.trim())
                  .then(result => {
                    if (result.ok) {
                      pushLog(`✅ [${cluster.name}] Đã tạo kênh YouTube "${result.channelName ?? name}" (${result.channelId ?? ''}) — sẵn sàng đăng video.`, 'action');
                      setToast(`Đã tạo kênh YouTube: ${result.channelName ?? name}`);
                    } else {
                      setToast(result.error ?? 'Không tạo được kênh YouTube');
                    }
                  })
                  .catch(cause => setToast(`Không tạo được kênh YouTube: ${messageOf(cause)}`))
                  .finally(() => {
                    setCreatingChannel('');
                    void load(false);
                  });
              }}
              onCheckAllProxy={() => {
                pushLog('⚡ [Proxy Checker] Đang kiểm tra đồng loạt Proxy của tất cả nhóm...', 'action');
                void action(t('dashboard.social.checkedProxy'), async () => {
                  let last: SocialOverview | null = null;
                  for (const cluster of clusters) {
                    last = await service.checkClusterProxy(cluster.id);
                  }
                  return last;
                });
              }}
            />
          ) : null}
          {activeTab === 'calendar' ? (
            <>
              <CalendarPanel
                jobs={jobs}
                t={t}
                onReschedule={(job, iso) => void reschedule(job, iso)}
                onRemove={job => void action(t('dashboard.social.jobRemoved'), () => service.removeJob(job.id))}
                onRetry={job => void action(t('dashboard.social.retried'), () => service.retryFailedPlatforms(job.id))}
              />
              <ComposerBlock
                clusters={clusters}
                service={service}
                creatorService={props.creatorService}
                projectId={props.projectId}
                initialPath={handoffPath}
                t={t}
                onClose={() => { setHandoffPath(''); }}
                onEnqueue={items => enqueueFromComposer(items)}
              />
            </>
          ) : null}
          {activeTab === 'queue' ? (
            <QueuePanel
              jobs={jobs}
              clusters={clusters}
              service={service}
              t={t}
              selectedJobId={selectedJobId}
              onSelectJob={setSelectedJobId}
              onNewPost={() => setActiveTab('calendar')}
              onToggleQueue={() => {
                if (queueRunning) {
                  pushLog('⏸️ [System] Đã tạm dừng hàng đợi theo lệnh người dùng.', 'action');
                  void action(t('dashboard.social.paused'), () => service.pauseQueue());
                } else {
                  void action(t('dashboard.social.resumed'), () => service.resumeQueue());
                }
              }}
              queueRunning={queueRunning}
              onEnqueue={(item, scheduledAt) => void action(
                t('dashboard.social.enqueued'),
                () => service.enqueue([{ ...item, ...(scheduledAt === '' ? {} : { scheduledAt }) }]).then(result => result.summary)
              )}
              onEnqueueMany={(items, summaryMessage) => void action(
                summaryMessage,
                async () => {
                  let last: SocialOverview | null = null;
                  for (let index = 0; index < items.length; index += 60) {
                    const chunk = items.slice(index, index + 60);
                    last = (await service.enqueue(chunk)).summary;
                  }
                  return last;
                }
              )}
              onError={message => setError(message)}
              onRemove={job => void action(t('dashboard.social.jobRemoved'), () => service.removeJob(job.id))}
              onRetry={job => void action(t('dashboard.social.retried'), () => service.retryFailedPlatforms(job.id))}
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

      <SocialConsole
        open={consoleOpen}
        logs={logs}
        errorBadge={failedCount}
        onToggle={() => setConsoleOpen(open => !open)}
        onClear={() => { setLogs([]); }}
      />

      {loginModal !== null ? (
        <LoginModal
          cluster={loginModal.cluster}
          platform={loginModal.platform}
          t={t}
          onOpen={() => openSocialLogin(loginModal.cluster, loginModal.platform)}
          onDone={() => {
            // Xác minh phiên thật: đọc cookie profile cụm (daemon) rồi cập nhật
            // loginStatus ⇒ cột nền tảng hiện "✔ Đã đăng nhập".
            const target = loginModal;
            const platformName = target.platform === 'youtube' ? 'YouTube' : target.platform === 'tiktok' ? 'TikTok' : 'Facebook';
            setVerifying(true);
            service.verifyClusterLogin(target.cluster.id, target.platform)
              .then(result => {
                if (result.ok) {
                  const who = result.accountName === undefined || result.accountName === '' ? '' : ` — Kênh: ${result.accountName}${result.channelId === undefined ? '' : ` (${result.channelId})`}`;
                  pushLog(`✅ [${target.cluster.name}] Đã xác nhận đăng nhập ${platformName}${who} — phiên đã lưu cho cụm này.`, 'action');
                  setToast(`Đăng nhập ${platformName} thành công${who} — phiên đã lưu cho cụm.`);
                } else if (result.needsChannel === true) {
                  pushLog(`⚠️ [${target.cluster.name}] Đã đăng nhập ${platformName} nhưng tài khoản chưa có kênh — cần tạo kênh.`, 'action');
                  setToast(`Đã đăng nhập ${platformName} nhưng tài khoản chưa có kênh — bấm "➕ Tạo kênh" ở cột ${platformName}.`);
                } else {
                  pushLog(`⚠️ [${target.cluster.name}] Phiên đăng nhập ${platformName} chưa hoàn tất — hãy đăng nhập lại trong cửa sổ trình duyệt của cụm.`, 'action');
                  setToast(`Phiên đăng nhập ${platformName} chưa hoàn tất — hãy đăng nhập lại trong cửa sổ trình duyệt của cụm rồi bấm "Lưu Phiên".`);
                }
              })
              .catch(cause => {
                setToast(`Không kiểm tra được phiên đăng nhập: ${messageOf(cause)}`);
              })
              .finally(() => {
                setVerifying(false);
                setLoginModal(null);
                void load(false);
              });
          }}
          onClose={() => setLoginModal(null)}
          verifying={verifying}
        />
      ) : null}

      {editing !== null ? (
        <ClusterEditor
          cluster={editing === 'new' ? null : editing}
          t={t}
          service={service}
          onMessage={pushLog}
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

function shortJobId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

/** Chip trạng thái nền tảng EN caps như demo (SCHEDULED / PENDING / UPLOADING…). */
function queueChipClass(status: string): string {
  switch (status) {
    case 'published': return 'social-chip-ok';
    case 'scheduled': return 'social-chip-scheduled';
    case 'running': return 'social-chip-running';
    case 'failed': return 'social-chip-failed';
    case 'skipped': return 'social-chip-skipped';
    default: return 'social-chip-pending';
  }
}

function queueChipText(status: { status: string; attempts: number }): string {
  switch (status.status) {
    case 'published': return '✅ PUBLISHED';
    case 'scheduled': return '📅 SCHEDULED';
    case 'running': return '🔄 UPLOADING';
    case 'failed': return `❌ FAILED (${status.attempts}/3)`;
    case 'skipped': return '🚫 SKIPPED';
    default: return '⏳ PENDING';
  }
}

function formatScheduleFull(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => `${n}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Danh sách nền tảng chưa đăng nhập của cụm (lấy nền tảng ưu tiên). */
function firstPendingLoginPlatform(cluster: SocialClusterSummary): SocialPlatformName {
  const entry = PLATFORMS.find(platform => cluster.loginStatus[platform] !== 'ok');
  return (entry ?? 'youtube') as SocialPlatformName;
}

function TabButton(props: {
  id: TabId;
  label: string;
  active: TabId;
  onSelect(id: TabId): void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active === props.id}
      className="social-tab"
      onClick={() => props.onSelect(props.id)}
    >
      {props.label}
      {props.badge !== undefined ? <span className="social-tab-badge">{props.badge}</span> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Console đáy — nhật ký thời gian thực (nút Ẩn/Mở ở giữa như demo)
// ---------------------------------------------------------------------------

function SocialConsole(props: {
  open: boolean;
  logs: LogLine[];
  errorBadge?: number;
  onToggle(): void;
  onClear(): void;
}) {
  return (
    <div className={`social-console${props.open ? '' : ' social-console-collapsed'}`}>
      <div className="social-console-head">
        <span className="social-console-title">
          📋 Nhật Ký Hoạt Động Thời Gian Thực
          {props.errorBadge !== undefined && props.errorBadge > 0
            ? <span className="social-console-badge">{props.errorBadge} Lỗi</span>
            : null}
        </span>
        <button type="button" className="social-console-toggle" onClick={props.onToggle}>
          {props.open ? '⌄ Ẩn Xuống' : '⌃ Mở Lên'}
        </button>
        <button type="button" className="social-console-clear" onClick={props.onClear}>🧹 Xóa Hiển Thị</button>
      </div>
      <div className="social-console-box" role="log">
        {props.logs.map((line, index) => (
          <div key={index} className={line.level === 'error' ? 'social-log-error' : line.level === 'action' ? 'social-log-action' : undefined}>
            [{line.time}] {line.level === 'error' ? '❌' : line.level === 'action' ? '🟢' : '💬'} {line.text}
          </div>
        ))}
        {props.logs.length === 0
          ? <div className="social-log-action">[00:00:00] 🟢 [Worker] Luồng điều phối tự động đã khởi động (SQLite WAL).</div>
          : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 1 — Nhóm Tài Khoản (bảng như demo)
// ---------------------------------------------------------------------------

const LOGIN_STATUS_LABEL: Record<string, string> = {
  ok: '✔ Đã đăng nhập',
  expired: '❌ Đã văng phiên',
  unknown: '⚪ Chưa đăng nhập'
};

function proxyChipClass(proxyStatus: string): string {
  switch (proxyStatus) {
    case 'online': return 'social-chip-ok';
    case 'dead': return 'social-chip-failed';
    case 'checking': return 'social-chip-running';
    default: return 'social-chip-skipped';
  }
}

function proxyChipText(proxyStatus: string, server: string): string {
  const host = server.replace(/^https?:\/\//, '');
  switch (proxyStatus) {
    case 'online': return `🟢 ${host !== '' ? host : 'Đang hoạt động'}`;
    case 'dead': return `🔴 ${host !== '' ? `${host} (Lỗi)` : 'Lỗi kết nối'}`;
    case 'checking': return '⏳ Đang đo...';
    case 'no_proxy': return '— (mạng nhà)';
    default: return '⚪ Chưa kiểm tra';
  }
}

function ChannelsPanel(props: {
  clusters: SocialClusterSummary[];
  t: Translate;
  loginPendingPlatform: string;
  onOpenLogin(cluster: SocialClusterSummary, platform: SocialPlatformName): void;
  onToggleAutoPublish(cluster: SocialClusterSummary, enabled: boolean): void;
  onEdit(cluster: SocialClusterSummary): void;
  onNewCluster(): void;
  onCheckAllProxy(): void;
  onDeleteCluster(cluster: SocialClusterSummary): void;
  onCreateChannel(cluster: SocialClusterSummary): void;
}) {
  const { t } = props;
  return (
    <div className="social-channels">
      <div className="social-channels-toolbar">
        <button type="button" className="social-btn social-btn-primary" onClick={props.onCheckAllProxy}>
          ⚡ Kiểm Tra Proxy Tất Cả Nhóm
        </button>
        <button type="button" className="social-btn social-btn-green" onClick={props.onNewCluster}>
          ➕ {t('dashboard.social.newCluster')}
        </button>
      </div>
      {props.clusters.length === 0 ? (
        <p className="social-empty">{t('dashboard.social.noClusters')}</p>
      ) : (
        <div className="social-tablewrap">
          <table className="social-table">
            <thead>
              <tr>
                <th>{t('dashboard.social.tabChannels')}</th>
                <th>{t('dashboard.social.seriesName')}</th>
                <th>Proxy</th>
                <th>YouTube</th>
                <th>TikTok</th>
                <th>Facebook</th>
                <th>{t('dashboard.social.autoPublishToggle')}</th>
                <th style={{ textAlign: 'center' }}>Thao Tác</th>
              </tr>
            </thead>
            <tbody>
              {props.clusters.map((cluster, index) => {
                const label = cluster.seriesName !== '' ? cluster.seriesName : cluster.name;
                return (
                  <tr key={`${cluster.id}-${index}`}>
                    <td className="social-cell-name">{cluster.name}</td>
                    <td className="social-cell-soft">{cluster.seriesName !== '' ? cluster.seriesName : '—'}</td>
                    <td>
                      <span className={`social-chip ${proxyChipClass(cluster.proxyStatus)}`}>
                        {proxyChipText(cluster.proxyStatus, cluster.proxyServer)}
                      </span>
                    </td>
                    {PLATFORMS.map(platform => {
                      const status = cluster.loginStatus[platform];
                      const key = `${cluster.id}:${platform}`;
                      const accountName = platform === 'youtube' ? cluster.ytAccountName ?? '' : '';
                      const accountId = platform === 'youtube' ? cluster.ytAccountId ?? '' : '';
                      const linked = status === 'ok';
                      return (
                        <td key={platform}>
                          <span className={`social-platform-entry social-login-${platform}`}>
                            {linked ? (
                              <span className={`social-login social-login-${status}`} title={accountId !== '' ? accountId : undefined}>
                                <span className="social-login-dot" aria-hidden="true" />
                                {accountName !== '' ? (
                                  <span className="social-login-account">
                                    {accountName}
                                    {accountId !== '' ? <em> · {accountId}</em> : null}
                                  </span>
                                ) : null}
                              </span>
                            ) : (
                              <span className={`social-login social-login-${status}`}>
                                {LICENSE_MARK[status]} <b>{LOGIN_STATUS_LABEL[status] ?? t('dashboard.social.loginUnknown')}</b>
                              </span>
                            )}
                            {linked ? null : (
                              <button
                                type="button"
                                data-testid={`social-login-${cluster.id}-${platform}`}
                                className={`social-btn social-btn-sm ${status === 'expired' ? 'social-btn-amber' : ''}`}
                                title={`${t('dashboard.social.loginAction')} ${platform}`}
                                onClick={() => props.onOpenLogin(cluster, platform)}
                              >
                                {props.loginPendingPlatform === key
                                  ? <LoaderCircle size={12} className="social-spin" aria-hidden="true" />
                                  : <KeyRound size={12} aria-hidden="true" />}
                                {t('dashboard.social.loginAction')}
                              </button>
                            )}
                            {platform === 'youtube' && cluster.needsChannel === true ? (
                              <button
                                type="button"
                                className="social-btn social-btn-sm social-btn-green"
                                data-testid={`social-create-channel-${cluster.id}`}
                                title="Tạo kênh YouTube cho tài khoản vừa đăng nhập"
                                onClick={() => props.onCreateChannel(cluster)}
                              >
                                ➕ Tạo kênh
                              </button>
                            ) : null}
                          </span>
                        </td>
                      );
                    })}
                    <td>
                      <label className="social-autopublish-toggle" title={t('dashboard.social.autoPublishHint')}>
                        <input
                          type="checkbox"
                          className="accent-green"
                          data-testid={`social-autopublish-${cluster.id}`}
                          checked={cluster.autoPublishAfterTranslate}
                          onChange={event => props.onToggleAutoPublish(cluster, event.target.checked)}
                        />
                        {cluster.autoPublishAfterTranslate ? '✅ Bật' : '⚪ Tắt'}
                      </label>
                    </td>
                    <td>
                      <div className="social-actions-cell">
                        <button
                          type="button"
                          className="social-btn social-btn-sm"
                          onClick={() => props.onOpenLogin(cluster, firstPendingLoginPlatform(cluster))}
                        >
                          🔑 {t('dashboard.social.loginAction')}
                        </button>
                        <button type="button" className="social-btn social-btn-sm" onClick={() => props.onEdit(cluster)}>
                          ⚙️ {t('dashboard.social.editCluster')}
                        </button>
                        <button
                          type="button"
                          className="social-btn social-btn-sm social-btn-danger"
                          title={t('dashboard.social.removeCluster')}
                          onClick={() => {
                            if (window.confirm(`Xóa cụm "${cluster.name}" và toàn bộ job của nó?`)) {
                              props.onDeleteCluster(cluster);
                            }
                          }}
                        >
                          🗑 {t('dashboard.social.remove')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const LICENSE_MARK: Record<string, string> = {
  youtube: '▶️',
  tiktok: '🎵',
  facebook: '📘'
};

// ---------------------------------------------------------------------------
// Tab Lịch đăng — grid tuần/tháng + kéo-thả đổi giờ + danh sách
// ---------------------------------------------------------------------------

const MAX_CHIPS_PER_CELL = 4;

/** Nhãn ngày trong tuần literal theo demo (T2 … CN). */
const WEEKDAY_LABELS = ['CN', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

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
  const [platformFilter, setPlatformFilter] = useState<Record<SocialPlatformName, boolean>>({ youtube: true, tiktok: true, facebook: true });

  const filteredJobs = useMemo(() => props.jobs.filter(job =>
    PLATFORMS.some(platform => job.platforms[platform].status !== 'skipped' && platformFilter[platform])
  ), [props.jobs, platformFilter]);
  const byDay = useMemo(() => groupJobsByDay(filteredJobs), [filteredJobs]);
  const today = new Date();

  const days = view === 'month'
    ? monthGridDays(anchor)
    : eachDay(startOfWeek(anchor), 7);

  function step(direction: number): void {
    setAnchor(current => view === 'month' ? addMonthsSafe(current, direction) : addDaysSafe(current, direction * 7));
  }

  return (
    <div className="social-calendar" aria-label={t('dashboard.social.tabCalendar')}>
      <div className="social-cal-toolbar">
        <div className="social-cal-tools">
          {PLATFORMS.map(platform => {
            const on = platformFilter[platform];
            return (
              <button
                key={platform}
                type="button"
                aria-pressed={on}
                className={`social-cal-pill social-cal-pill-${platform}${on ? '' : ' social-cal-pill-off'}`}
                onClick={() => setPlatformFilter(current => ({ ...current, [platform]: !current[platform] }))}
              >
                {platformEmoji(platform)} {platform === 'youtube' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : 'Facebook'}
              </button>
            );
          })}
          <div className="social-cal-viewswitch" role="group" aria-label={t('dashboard.social.tabCalendar')}>
            <select
              className="social-cal-period"
              value={view}
              onChange={event => setView(event.target.value as typeof view)}
              aria-label={t('dashboard.social.tabCalendar')}
            >
              <option value="week">{t('dashboard.social.calWeek')}</option>
              <option value="month">{t('dashboard.social.calMonth')}</option>
              <option value="list">{t('dashboard.social.calList')}</option>
            </select>
          </div>
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
        </div>
      </div>

      {view !== 'list' ? (
        <>
          <div className="social-cal-weekdays" aria-hidden="true">
            {days.slice(0, 7).map(day => (
              <span key={dayKey(day)}>{WEEKDAY_LABELS[day.getDay()]}</span>
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
                  {view === 'month' ? <span className="social-cal-daynum">{day.getDate()}</span> : null}
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
        </>
      ) : (
        <ul className="social-cal-list">
          {filteredJobs.length === 0 ? <li className="social-empty">{t('dashboard.social.calEmpty')}</li> : null}
          {filteredJobs.map(job => (
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
  const activePlatforms = PLATFORMS.filter(platform => job.platforms[platform].status !== 'skipped');
  const primary = activePlatforms.includes('youtube') ? 'youtube' : activePlatforms.includes('tiktok') ? 'tiktok' : 'facebook';
  const statuses = activePlatforms.map(platform => job.platforms[platform].status);
  const state = statuses.every(status => status === 'published')
    ? 'done'
    : statuses.includes('failed')
      ? 'failed'
      : 'sched';
  return (
    <button
      type="button"
      className={`social-cal-chip social-cal-chip-plat-${primary} social-cal-chip-state-${state}`}
      draggable={draggable}
      title={draggable ? props.t('dashboard.social.calHint') : job.title}
      onClick={props.onClick}
      onDragStart={event => {
        event.dataTransfer.setData('text/plain', job.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
    >
      <span className="social-cal-chip-time">{formatTime(job.scheduledAt)}</span>
      <span className="social-cal-chip-title" title={job.title}>{job.title}</span>
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
        <div className="social-modal-head">
          <h2>{t('dashboard.social.quickEdit')}</h2>
          <button type="button" className="social-modal-close" onClick={props.onClose} aria-label={t('dashboard.drama.close')}>✕</button>
        </div>
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
// Tab Hàng đợi — công cụ nạp nhanh + bảng job + Trình Soi Lỗi
// ---------------------------------------------------------------------------

function QueuePanel(props: {
  jobs: SocialJobSummary[];
  clusters: SocialClusterSummary[];
  service: SocialService;
  queueRunning: boolean;
  selectedJobId: string;
  onSelectJob(id: string): void;
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
  const selectedJob = props.jobs.find(job => job.id === props.selectedJobId) ?? null;
  const failedJobs = props.jobs.filter(job => jobKind(job) === 'failed');
  const [clusterFilter, setClusterFilter] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const visibleJobs = clusterFilter === '' ? props.jobs : props.jobs.filter(job => job.clusterId === clusterFilter);

  function enqueueFiles(files: File[]): void {
    const cluster = clusterFilter === ''
      ? props.clusters[0]
      : props.clusters.find(candidate => candidate.id === clusterFilter);
    if (cluster === undefined) return;
    const paths = files.map(file => {
      const viaBridge = browserBridge.resolveDroppedFilePath?.(file) ?? null;
      const viaProp = typeof (file as unknown as { path?: unknown }).path === 'string' ? (file as unknown as { path: string }).path : '';
      return viaBridge ?? viaProp;
    }).filter(path => path !== '');
    if (paths.length === 0) {
      props.onError('Không lấy được đường dẫn file (host không hỗ trợ). Hãy dán đường dẫn vào Composer tab 2.');
      return;
    }
    for (const path of paths) {
      const items = composeEnqueueItems({
        clusters: [cluster],
        path,
        title: manualTitle,
        settings: {
          youtube: { privacy: 'public' },
          tiktok: { privacy: 'public', allowDuet: true, allowStitch: true, allowComments: true, directPost: false },
          facebook: { postType: 'post' }
        }
      });
      props.onEnqueue(items[0] ?? { clusterId: cluster.id, path }, '');
    }
    setManualTitle('');
  }

  function retryAllFailed(): void {
    for (const job of failedJobs) props.onRetry(job);
  }
  return (
    <div className="social-queue">
      <div className="social-inline-row">
        <span className={`social-queue-state social-queue-state-${props.queueRunning ? 'running' : 'paused'}`}>
          {props.queueRunning ? t('dashboard.social.queueRunning') : t('dashboard.social.queuePaused')}
        </span>
        <span className="social-label" style={{ margin: 0, flexShrink: 0 }}>Nhóm:</span>
        <select
          className="social-queue-cluster"
          value={clusterFilter}
          aria-label="Lọc theo nhóm"
          onChange={event => setClusterFilter(event.target.value)}
        >
          <option value="">Tất cả</option>
          {props.clusters.map(cluster => (
            <option key={cluster.id} value={cluster.id}>
              {cluster.name}{cluster.seriesName !== '' ? ` (${cluster.seriesName})` : ''}
            </option>
          ))}
        </select>
        <input
          type="text"
          className="social-queue-title"
          placeholder="Nhập tiêu đề tập phim (để trống sẽ tự lấy tên file)..."
          value={manualTitle}
          onChange={event => setManualTitle(event.target.value)}
        />
        <button
          type="button"
          className="social-btn social-btn-primary"
          disabled={props.clusters.length === 0}
          onClick={() => fileInputRef.current?.click()}
        >
          ➕ Chọn File & Xếp Lịch Tự Động
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/*"
          multiple
          hidden
          onChange={event => {
            const files = Array.from(event.target.files ?? []);
            enqueueFiles(files);
            event.target.value = '';
          }}
        />
        <ExcelImportButton
          clusters={props.clusters}
          t={t}
          onEnqueueMany={props.onEnqueueMany}
          onError={message => props.onError(message)}
        />
        {failedJobs.length > 0 ? (
          <button type="button" className="social-btn social-btn-amber" onClick={retryAllFailed}>
            🔄 Đặt Lại Job Lỗi (Retry All)
          </button>
        ) : null}
      </div>
      <div className="social-queue-cols">
        <div className="social-queue-table">
          {visibleJobs.length === 0 ? (
            <p className="social-empty">{t('dashboard.social.noJobs')}</p>
          ) : (
            <div className="social-tablewrap">
              <table className="social-table">
                <thead>
                  <tr>
                    <th>Job ID</th>
                    <th>Nhóm</th>
                    <th>Tên File Video</th>
                    <th>Giờ Hẹn Đăng (Auto-Slot)</th>
                    <th>YouTube</th>
                    <th>TikTok</th>
                    <th>Facebook</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleJobs.map(job => {
                    const selected = job.id === props.selectedJobId;
                    const failed = jobKind(job) === 'failed';
                    return (
                      <tr
                        key={job.id}
                        className={`social-queue-selectable${selected ? ' social-queue-selected' : ''}${failed ? ' social-queue-row-failed' : ''}`}
                        onClick={() => props.onSelectJob(job.id)}
                      >
                        <td className="social-cell-mono">#{shortJobId(job.id)}</td>
                        <td className="social-cell-name">{job.clusterName}</td>
                        <td className="social-cell-mono" title={job.videoPath}>
                          {job.title !== '' ? job.title : fileNameOf(job.videoPath)}
                        </td>
                        <td className="social-cell-mono" style={{ color: '#fcd34d' }}>{formatScheduleFull(job.scheduledAt)}</td>
                        {PLATFORMS.map(platform => {
                          const status = job.platforms[platform];
                          return (
                            <td key={platform}>
                              <span className={`social-chip ${queueChipClass(status.status)}`} title={status.error ?? status.videoId ?? undefined}>
                                {queueChipText(status)}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {selectedJob !== null ? (
          <ErrorInspector
            service={props.service}
            job={selectedJob}
            t={t}
            onRetry={() => props.onRetry(selectedJob)}
            onRemove={() => props.onRemove(selectedJob)}
          />
        ) : null}
      </div>
    </div>
  );
}

const SCREENSHOT_PLATFORM_CODES: Record<PlatformName, 'yt' | 'tk' | 'fb'> = { youtube: 'yt', tiktok: 'tk', facebook: 'fb' };

function ErrorInspector(props: {
  service: SocialService;
  job: SocialJobSummary;
  t: Translate;
  onRetry(): void;
  onRemove(): void;
}) {
  const { job, t } = props;
  const failedPlatforms = PLATFORMS.filter(platform => job.platforms[platform].status === 'failed');
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const [shotLoading, setShotLoading] = useState(false);
  const [selectors, setSelectors] = useState<string>('');
  const [selectorsLoaded, setSelectorsLoaded] = useState(false);
  const [selectorsSaving, setSelectorsSaving] = useState(false);
  const [shotResolution, setShotResolution] = useState('');

  useEffect(() => {
    let alive = true;
    setShotUrl(null);
    setShotLoading(true);
    (async () => {
      for (const platform of failedPlatforms) {
        const result = await props.service.getErrorScreenshot(job.id, SCREENSHOT_PLATFORM_CODES[platform]).catch(() => null);
        if (result !== null && result.url !== '' && alive) {
          setShotUrl(result.url);
          break;
        }
      }
      if (alive) setShotLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, failedPlatforms.length]);

  useEffect(() => {
    if (!selectorsLoaded) return;
    props.service.getSelectors()
      .then(result => setSelectors(result.selectors))
      .catch(() => setSelectors(''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectorsLoaded]);

  return (
    <div className="social-err-panel">
      <div className="social-err-head">
        <span className="social-err-title">🔍 Trình Soi Lỗi & Ảnh Chụp (Job #{shortJobId(job.id)})</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {failedPlatforms.length > 0 ? (
            <button type="button" className="social-btn social-btn-danger social-btn-sm" onClick={props.onRetry}>
              {t('dashboard.social.retry')} Riêng {failedPlatforms.map(platform => platform === 'youtube' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : 'Facebook').join(' + ')}
            </button>
          ) : null}
          <button type="button" className="social-btn social-btn-sm" onClick={props.onRemove} title={t('dashboard.social.remove')}>
            🗑
          </button>
        </div>
      </div>
      <div className="social-err-chips">
        {PLATFORMS.map(platform => {
          const status = job.platforms[platform].status;
          const failed = status === 'failed';
          return (
            <span key={platform} className={`social-chip ${failed ? 'social-chip-failed' : status === 'published' || status === 'scheduled' ? 'social-chip-ok' : 'social-chip-pending'}`}>
              {failed ? '❌' : status === 'published' || status === 'scheduled' ? '✔' : '⏳'} {platformEmoji(platform)} {platform === 'youtube' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : 'Facebook'}
            </span>
          );
        })}
      </div>
      <div className="social-err-box">
        {failedPlatforms.length > 0
          ? `${failedPlatforms.map(platform => `${platform}: ${job.platforms[platform].error ?? t('dashboard.social.status_failed')}`).join('\n')}${shotUrl !== null && failedPlatforms[0] !== undefined ? `\nĐã tự động chụp màn hình lưu tại: ./error_screenshots/err_${SCREENSHOT_PLATFORM_CODES[failedPlatforms[0]]}_job${shortJobId(job.id)}.png` : ''}`
          : `✅ Job #${shortJobId(job.id)} hoạt động hoàn toàn bình thường, không có lỗi phát sinh.`}
      </div>
      <span style={{ fontSize: 11, color: '#94a3b8' }}>
        📸 Ảnh chụp màn hình trong trình duyệt của nhóm vào lúc gặp lỗi:
      </span>
      <div className="social-err-shot-frame">
        <div className="social-err-shot-bar">
          <span className="social-err-shot-domain">{firstFailedDomain(failedPlatforms)}</span>
          <span className="social-err-shot-badge">DOM Changed / Popup Blocked</span>
        </div>
        {shotUrl !== null
          ? <img src={shotUrl} alt={`ảnh chụp lỗi job ${shortJobId(job.id)}`} onLoad={event => { const el = event.currentTarget; const w = Math.max(1, Math.round(el.naturalWidth || el.clientWidth)); const h = Math.max(1, Math.round(el.naturalHeight || el.clientHeight)); setShotResolution(`${w}x${h}`); }} />
          : (
            <div className="social-err-shot-placeholder">
              {shotLoading ? <LoaderCircle size={14} className="social-spin" aria-hidden="true" /> : 'Không có ảnh chụp lỗi cho job này.'}
            </div>
          )}
        {shotUrl !== null && shotResolution !== '' ? <div className="social-err-shot-foot">Resolution: {shotResolution} | {job.clusterName}</div> : null}
      </div>
      <details className="social-selectors-details">
        <summary onClick={() => setSelectorsLoaded(true)}>🛠️ Sửa Selector Nóng (khi nền tảng đổi giao diện)</summary>
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            className="social-selectors-textarea"
            spellCheck={false}
            value={selectors}
            onChange={event => setSelectors(event.target.value)}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="social-btn social-btn-green social-btn-sm"
              disabled={selectorsSaving || selectors.trim() === ''}
              onClick={() => {
                setSelectorsSaving(true);
                props.service.saveSelectors(selectors)
                  .then(result => { setSelectors(result.selectors); alert('✅ Đã lưu selectors — job đăng sau áp dụng ngay (đã tạo bản .bak).'); })
                  .catch(cause => alert(`❌ Không lưu được selectors: ${messageOf(cause)}`))
                  .finally(() => setSelectorsSaving(false));
              }}
            >
              ⚡ Lưu & Áp Dụng Ngay
            </button>
            <span className="social-selectors-note">Mỗi lần lưu tự tạo bản backup `.bak` để khôi phục nếu cần.</span>
          </div>
        </div>
      </details>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button type="button" className="social-btn social-btn-danger social-btn-sm" onClick={props.onRemove}>
          <Trash2 size={12} aria-hidden="true" /> {t('dashboard.social.remove')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer đa kênh — trình bày inline trong tab Lịch Đăng như demo
// ---------------------------------------------------------------------------

function ComposerBlock(props: {
  clusters: SocialClusterSummary[];
  service: SocialService;
  creatorService?: CreatorWebService | null;
  projectId?: string;
  initialPath: string;
  t: Translate;
  onClose(): void;
  onEnqueue(items: SocialEnqueueItem[]): Promise<void>;
}) {
  const { t } = props;
  const [path, setPath] = useState(props.initialPath);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [snapshot, setSnapshot] = useState<Set<string>>(new Set());
  const [aiBusy, setAiBusy] = useState(false);
  const [schedule, setSchedule] = useState('');
  const [downloads, setDownloads] = useState<SocialDownloadItem[] | null>(null);
  const [downloadsError, setDownloadsError] = useState('');
  const [translatedVideos, setTranslatedVideos] = useState<SocialTranslatedVideo[] | null>(null);
  const [translatedError, setTranslatedError] = useState('');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [ddOpen, setDdOpen] = useState(false);
  const [ddUp, setDdUp] = useState(false);
  const ddWrapRef = useRef<HTMLDivElement | null>(null);
  const [yt, setYt] = useState({ privacy: 'public', tags: '', madeForKids: false });
  const [tk, setTk] = useState({ privacy: 'public', allowDuet: true, allowStitch: true, allowComments: true, directPost: false });
  const [fb, setFb] = useState({ postType: 'post' });

  useEffect(() => {
    setPath(current => current.trim() === '' ? props.initialPath : current);
    let alive = true;
    props.service.listDownloads(500)
      .then(result => { if (alive) { setDownloads(result.items); setDownloadsError(''); } })
      .catch(cause => { if (alive) setDownloadsError(messageOf(cause)); });
    if (props.creatorService !== undefined && props.creatorService !== null) {
      listTranslatedVideos(props.creatorService, props.projectId)
        .then(result => { if (alive) { setTranslatedVideos(result.items); setTranslatedError(''); } })
        .catch(cause => { if (alive) { setTranslatedVideos([]); setTranslatedError(messageOf(cause)); } });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bấm ra ngoài → đóng dropdown nhóm thông minh.
  useEffect(() => {
    if (!ddOpen) return;
    const handler = (event: MouseEvent): void => {
      if (ddWrapRef.current !== null && !ddWrapRef.current.contains(event.target as Node)) {
        setDdOpen(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [ddOpen]);

  function toggleDropdown(): void {
    setDdOpen(current => {
      if (!current && ddWrapRef.current !== null) {
        // Smart positioning: đủ chỗ trống phía dưới → mở xuống, không thì nhô lên.
        const rect = ddWrapRef.current.getBoundingClientRect();
        setDdUp(window.innerHeight - rect.bottom < 200);
      }
      return !current;
    });
  }

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
  const selectedClusters = props.clusters.filter(cluster => snapshot.has(cluster.id));
  const pathOk = path.trim() !== '';
  const clustersOk = selectedClusters.length > 0;
  const slotTimes = [...new Set(selectedClusters.flatMap(cluster => cluster.defaultScheduleTimes))];
  const titleCounter = title.length;

  function buildSettings(): SocialJobPlatformSettings {
    const hashtagsList = hashtags.split(/\s+/).map(tag => tag.replace(/^#/, '').trim()).filter(tag => tag !== '');
    const ytTags = yt.tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '');
    return {
      youtube: {
        privacy: yt.privacy,
        // Tags để trống → AI tự sinh từ hashtag của composer.
        ...(ytTags.length > 0
          ? { tags: ytTags }
          : hashtagsList.length > 0 ? { tags: hashtagsList } : {}),
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
  }

  function pickDownload(item: SocialDownloadItem): void {
    setPath(item.path);
    if (title.trim() === '') setTitle(item.title !== '' ? item.title : fileNameOf(item.path));
  }

  function pickTranslated(item: SocialTranslatedVideo): void {
    setPath(item.path);
    if (title.trim() === '') setTitle(item.title);
  }

  function aiDoAll(): void {
    const base = title.trim() !== '' ? title : (path.trim() !== '' ? fileNameOf(path) : '');
    if (base === '') return;
    setAiBusy(true);
    props.service.aiCompose(base)
      .then(result => {
        setTitle(result.title);
        setDescription(result.description);
        setHashtags(result.hashtags);
      })
      .catch(cause => alert(`❌ AI soạn nội dung lỗi: ${messageOf(cause)}`))
      .finally(() => setAiBusy(false));
  }

  function submit(): void {
    if (!pathOk || !clustersOk || submitting) return;
    const fullDescription = hashtags.trim() === ''
      ? description
      : [description.trim(), hashtags.trim()].filter(part => part !== '').join('\n\n');
    const items = composeEnqueueItems({
      clusters: selectedClusters,
      path,
      title,
      description: fullDescription,
      scheduledAt: schedule,
      settings: buildSettings()
    });
    setSubmitting(true);
    props.onEnqueue(items)
      .catch(() => undefined)
      .finally(() => setSubmitting(false));
  }

  function ddLabel(): string {
    if (selectedClusters.length === 0) return 'Chưa chọn nhóm nào';
    const first = selectedClusters[0];
    if (first === undefined) return 'Chưa chọn nhóm nào';
    const firstName = first.seriesName !== '' ? first.seriesName : first.name;
    return selectedClusters.length === 1
      ? `✅ ${firstName}`
      : `✅ ${firstName} +${selectedClusters.length - 1} nhóm nữa`;
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

  const mergedMedia: Array<{ key: string } & ({ kind: 'translated'; item: SocialTranslatedVideo } | { kind: 'downloads'; item: SocialDownloadItem })> = [
    ...filteredTranslated.map(item => ({ key: `t:${item.artifactId}`, kind: 'translated' as const, item })),
    ...filteredDownloads.map(item => ({ key: `d:${item.path}`, kind: 'downloads' as const, item }))
  ];

  function mediaTile(entry: (typeof mergedMedia)[number]) {
    const selected = path.trim() !== '' && entry.item.path === path.trim();
    const onPick = () => entry.kind === 'translated'
      ? pickTranslated(entry.item)
      : pickDownload(entry.item);
    return (
      <button
        key={entry.key}
        type="button"
        className={`social-media-card${selected ? ' social-media-card-selected' : ''}`}
        aria-pressed={selected}
        onClick={onPick}
      >
        <span className="social-media-thumb"><FileVideo size={20} aria-hidden="true" /></span>
        <span className="social-media-name">{entry.item.title !== '' ? entry.item.title : fileNameOf(entry.item.path)}</span>
        {entry.kind === 'translated'
          ? <span className="social-media-status ok">✨ Đã dịch — chờ đăng</span>
          : (
            <span className="social-media-status">
              MP4 · {formatBytes(entry.item.sizeBytes)}
            </span>
          )}
      </button>
    );
  }

  return (
    <div className="social-composer-cols">
      <div className="social-composer-col composer-col">
        <div className="social-composer-sec-title">
          <span>🧾 Composer</span>
          <button
            type="button"
            className="social-btn social-btn-primary social-btn-sm"
            title="AI tự làm: tiêu đề · mô tả · hashtag"
            disabled={aiBusy || path.trim() === ''}
            onClick={aiDoAll}
          >
            {aiBusy ? <LoaderCircle size={11} className="social-spin" aria-hidden="true" /> : '✨'} AI Tự Làm
          </button>
        </div>
        {downloadsError !== '' ? <p className="social-warn-text">{downloadsError}</p> : null}
        {translatedError !== '' ? <p className="social-warn-text">{translatedError}</p> : null}
        {!libraryOpen ? (
          <div className="social-media-grid">
            {mergedMedia.slice(0, 2).map(entry => mediaTile(entry))}
            <button
              type="button"
              className="social-media-card social-media-card-search"
              aria-expanded={libraryOpen}
              onClick={() => setLibraryOpen(true)}
            >
              <span>🔍 Tìm trong thư viện</span>
            </button>
          </div>
        ) : (
          <>
            <div className="social-inline-row">
              <label className="social-label" htmlFor="social-composer-path" style={{ margin: 0, flexShrink: 0 }}>
                Vị trí video (MP4)
              </label>
              <input
                id="social-composer-path"
                type="text"
                className="social-input-mono"
                placeholder="D:/downloads/tap-5.mp4"
                value={path}
                onChange={event => setPath(event.target.value)}
              />
            </div>
            <input
              type="search"
              className="social-media-search"
              placeholder={t('dashboard.social.composerSearchVideo')}
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
            <div className="social-media-grid social-media-grid-full">
              {mergedMedia.map(entry => mediaTile(entry))}
              <button
                type="button"
                className="social-media-card social-media-card-search"
                onClick={() => { setLibraryOpen(false); setSearch(''); }}
              >
                <span>✕ Đóng thư viện</span>
              </button>
            </div>
          </>
        )}
        <div>
          <label className="social-label" htmlFor="social-composer-title">Tiêu đề (AI sẽ tự viết chuẩn SEO, ≤100 ký tự):</label>
          <input
            id="social-composer-title"
            type="text"
            placeholder={t('dashboard.social.jobTitlePlaceholder')}
            value={title}
            onChange={event => setTitle(event.target.value)}
          />
          <div className={`social-title-counter${titleCounter > 100 ? ' over' : ''}`}>{titleCounter}/100 ký tự</div>
        </div>
        <div>
          <label className="social-label" htmlFor="social-composer-desc">Mô tả video:</label>
          <textarea
            id="social-composer-desc"
            rows={2}
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </div>
        <div className="social-inline-row">
          <span className="social-label" style={{ margin: 0 }}>Hashtag:</span>
          <input
            type="text"
            className="social-input-mono"
            style={{ flex: 1, minWidth: 0 }}
            placeholder="AI tự tạo bộ hashtag khi bấm ✨ AI Tự Làm"
            value={hashtags}
            onChange={event => setHashtags(event.target.value)}
          />
        </div>
        <div className="social-inline-row">
          <span className="social-label" style={{ margin: 0, flexShrink: 0 }}>{t('dashboard.social.scheduleAt')}:</span>
          <input
            type="datetime-local"
            style={{ width: 168, flexShrink: 0 }}
            value={schedule}
            onChange={event => setSchedule(event.target.value)}
          />
          <span className="social-label" style={{ margin: 0, marginLeft: 4, flexShrink: 0 }}>{t('dashboard.social.composerClusters')}:</span>
          <div className="soc-dd-wrap" ref={ddWrapRef} style={{ flex: 1, minWidth: 180 }}>
            <button type="button" className="soc-dd-btn" onClick={toggleDropdown}>
              <span className={`soc-dd-label${selectedClusters.length === 0 ? ' none' : ''}`}>{ddLabel()}</span>
              <span style={{ color: '#94a3b8' }}>▾</span>
            </button>
            {ddOpen ? (
              <div className={`soc-dd-panel ${ddUp ? 'dd-up' : 'dd-down'}`}>
                {props.clusters.length === 0 ? <span className="soc-dd-item">{t('dashboard.social.noClusters')}</span> : null}
                {props.clusters.map(cluster => {
                  const label = cluster.seriesName !== '' ? cluster.seriesName : cluster.name;
                  const selected = snapshot.has(cluster.id);
                  return (
                    <label key={cluster.id} className="soc-dd-item">
                      <input
                        type="checkbox"
                        checked={selected}
                        className={cluster.loginStatus.youtube === 'ok' ? 'accent-green' : undefined}
                        onChange={() => {
                          setSnapshot(current => {
                            const next = new Set(current);
                            if (next.has(cluster.id)) next.delete(cluster.id);
                            else next.add(cluster.id);
                            return next;
                          });
                        }}
                        aria-label={label}
                      />
                      {label}
                    </label>
                  );
                })}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="social-btn"
            style={{ flexShrink: 0 }}
            disabled={slotTimes.length === 0}
            title={t('dashboard.social.composerUseSlot')}
            onClick={() => {
              const slot = nextGoldenSlot(slotTimes);
              if (slot !== null) setSchedule(toDatetimeLocalValue(slot.toISOString()));
            }}
          >
            Theo khung giờ nhóm
          </button>
          <button
            type="button"
            className="social-btn social-btn-primary"
            style={{ flexShrink: 0 }}
            disabled={!pathOk || !clustersOk || submitting}
            onClick={submit}
          >
            {submitting ? <LoaderCircle size={13} className="social-spin" aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
            📤 Xếp Lịch Đăng
          </button>
        </div>
      </div>

      <div className="social-composer-col composer-col">
        <span className="social-composer-sec-title amber">⚙️ {t('dashboard.social.composerSettings')}</span>
        <details className="social-acc" open>
          <summary className="social-acc-head" style={{ color: '#fca5a5' }}>
            <span className="social-dot social-dot-youtube">{platformIcon('youtube', 11)}</span>
            {t('dashboard.social.youtubeSettings')}
            <span className="social-acc-summary">{ytPrivacyLabels[yt.privacy] ?? yt.privacy}</span>
          </summary>
          <div className="social-acc-body">
            <div className="social-acc-grid">
              <label>
                {t('dashboard.social.ytPrivacy')}
                <select value={yt.privacy} onChange={event => setYt({ ...yt, privacy: event.target.value })}>
                  <option value="public">{t('dashboard.social.ytPrivacyPublic')}</option>
                  <option value="unlisted">{t('dashboard.social.ytPrivacyUnlisted')}</option>
                  <option value="private">{t('dashboard.social.ytPrivacyPrivate')}</option>
                </select>
              </label>
              <label>
                {t('dashboard.social.ytMadeForKids')}
                <select
                  value={yt.madeForKids ? 'kids' : 'not_kids'}
                  onChange={event => setYt({ ...yt, madeForKids: event.target.value === 'kids' })}
                >
                  <option value="not_kids">Không</option>
                  <option value="kids">Có</option>
                </select>
              </label>
              <label className="span-2">
                Tags YouTube (tùy chọn — AI tự sinh từ hashtag nếu để trống)
                <input
                  type="text"
                  className="social-input-mono"
                  value={yt.tags}
                  onChange={event => setYt({ ...yt, tags: event.target.value })}
                  placeholder="phim, review, tap-1"
                />
              </label>
            </div>
          </div>
        </details>
        <details className="social-acc">
          <summary className="social-acc-head" style={{ color: '#cbd5e1' }}>
            <span className="social-dot social-dot-tiktok">{platformIcon('tiktok', 11)}</span>
            {t('dashboard.social.tiktokSettings')}
            <span className="social-acc-summary">{tk.directPost ? t('dashboard.social.tkDirectPostOn') : tkPrivacyLabels[tk.privacy] ?? tk.privacy}</span>
          </summary>
          <div className="social-acc-body">
            <div className="social-acc-grid">
              <label>
                {t('dashboard.social.tkPrivacy')}
                <select value={tk.privacy} onChange={event => setTk({ ...tk, privacy: event.target.value })}>
                  <option value="public">{t('dashboard.social.tkPrivacyPublic')}</option>
                  <option value="friends">{t('dashboard.social.tkPrivacyFriends')}</option>
                  <option value="private">{t('dashboard.social.tkPrivacyPrivate')}</option>
                </select>
              </label>
              <div className="social-switch-row">
                <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                </span>
              </div>
            </div>
          </div>
        </details>
        <details className="social-acc">
          <summary className="social-acc-head" style={{ color: '#93c5fd' }}>
            <span className="social-dot social-dot-facebook">{platformIcon('facebook', 11)}</span>
            {t('dashboard.social.facebookSettings')}
            <span className="social-acc-summary">{fbPostTypeLabels[fb.postType] ?? fb.postType}</span>
          </summary>
          <div className="social-acc-body">
            <label>
              {t('dashboard.social.fbPostType')}
              <select value={fb.postType} onChange={event => setFb({ postType: event.target.value })}>
                <option value="post">{t('dashboard.social.fbPostTypePost')}</option>
                <option value="reel">{t('dashboard.social.fbPostTypeReel')}</option>
                <option value="story">{t('dashboard.social.fbPostTypeStory')}</option>
              </select>
            </label>
          </div>
        </details>
        <div style={{ flex: '1 1 auto', minHeight: 0 }}>
          <span className="social-label">🔍 {t('dashboard.social.composerPreview')}:</span>
          <div className="social-preview-card">
            <span className="social-preview-thumb"><FileVideo size={22} aria-hidden="true" /></span>
            <div className="social-preview-body">
              <p className="social-preview-title" title={title}>{title.trim() !== '' ? title.trim() : (path.trim() !== '' ? fileNameOf(path) : t('dashboard.social.jobTitlePlaceholder'))}</p>
              {hashtags.trim() !== '' ? <p className="social-preview-desc">{hashtags.trim()}</p> : null}
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
          {!pathOk && path.trim() === '' ? (
            <p className="social-enqueue-hint" style={{ marginTop: 6 }}>
              {t('dashboard.social.composerNeedVideo')}
              {selectedClusters.length === 0 ? '' : ''}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Domain thật của nền tảng lỗi (dùn thanh trình duyệt giả trong khung soi lỗi). */
function firstFailedDomain(failedPlatforms: SocialPlatformName[]): string {
  const platform = failedPlatforms[0];
  if (platform === undefined) return '🌐 app.nền-tảng.com/upload';
  if (platform === 'youtube') return '🌐 studio.youtube.com/upload';
  if (platform === 'tiktok') return '🌐 tiktok.com/tiktokstudio/upload';
  return '🌐 facebook.com/web/upload';
}

function fileNameOf(path: string): string {
  const parts = path.trim().split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

// ---------------------------------------------------------------------------
// MODAL ĐĂNG NHẬP — trình bày demo; thật: daemon mở trình duyệt cách ly của cụm
// ---------------------------------------------------------------------------

function LoginModal(props: {
  cluster: SocialClusterSummary;
  platform: SocialPlatformName;
  t: Translate;
  /** Đang xác minh phiên đăng nhập (đọc cookie profile cụm). */
  verifying?: boolean;
  /** Lệnh thật: daemon mở trình duyệt persistent (fingerprint + proxy của cụm) tới trang đăng nhập. */
  onOpen(): Promise<void>;
  onDone(): void;
  onClose(): void;
}) {
  const { cluster, platform, t } = props;
  const name = platform === 'youtube' ? 'YouTube' : platform === 'tiktok' ? 'TikTok' : 'Facebook';
  const url = platform === 'youtube' ? 'accounts.google.com/signin' : platform === 'tiktok' ? 'www.tiktok.com/login' : 'www.facebook.com/login';
  const [step, setStep] = useState(0);
  const [openingError, setOpeningError] = useState('');

  useEffect(() => {
    let alive = true;
    // Gọi daemon thật: mở trang đăng nhập nền tảng trong trình duyệt riêng của cụm.
    props.onOpen()
      .then(() => { if (alive) setOpeningError(''); })
      .catch(cause => { if (alive) setOpeningError(messageOf(cause)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (step > 3 || openingError !== '') return;
    const timer = setInterval(() => setStep(current => {
      if (current > 3 || openingError !== '') return current;
      return current + 1;
    }), 1200);
    return () => clearInterval(timer);
  }, [step, openingError]);

  return (
    <div className="social-modal-mask" role="dialog" aria-modal="true" aria-label={`Đăng nhập ${name}`}>
      <div className="social-modal">
        <div className="social-modal-head">
          <h2>🔑 Đăng Nhập {name} — {cluster.name}</h2>
          <button type="button" className="social-modal-close" onClick={props.onClose} aria-label={t('dashboard.drama.close')}>✕</button>
        </div>
        <p className="social-modal-note">
          Mở trình duyệt <b>riêng biệt</b> (fingerprint + proxy của nhóm) tại trang đăng nhập — bạn tự thao tác, phiên được lưu <b>chỉ cho nhóm này</b>.
        </p>
        {openingError !== '' ? (
          <div className="social-error" role="alert"><TriangleAlert size={14} aria-hidden="true" /> <span>{openingError}</span></div>
        ) : (
          <div className="social-login-frame">
            <div className={`social-login-step${step >= 3 ? ' done' : ''}`}>
              {step === 0 ? '⏳ Đang khởi động trình duyệt cách ly...' : step === 1 ? '🌐 Đang trỏ tới trang đăng nhập...' : step >= 2 ? `✍️ (Trình duyệt nhóm đã mở ${url}) Hãy đăng nhập trong cửa sổ trình duyệt của nhóm...` : ''}
            </div>
            <div className="social-login-bar">
              <div className="social-login-bar-fill" style={{ width: step === 0 ? '0%' : step === 1 ? '40%' : '75%' }} />
            </div>
            <div className="social-login-url">{step >= 1 ? url : ''}</div>
          </div>
        )}
        <div className="social-modal-actions">
          <button type="button" className="social-btn" onClick={props.onClose} disabled={props.verifying === true}>Hủy</button>
          <button type="button" className="social-btn social-btn-green" onClick={props.onDone} disabled={props.verifying === true}>
            {props.verifying === true
              ? <><LoaderCircle size={13} className="social-spin" aria-hidden="true" /> Đang kiểm tra phiên…</>
              : '✅ Tôi đã đăng nhập xong — Lưu Phiên'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor cụm kênh — modal config như demo; chứa nén file nâng cao
// ---------------------------------------------------------------------------

function ClusterEditor(props: {
  cluster: SocialClusterSummary | null;
  service: SocialService;
  t: Translate;
  onMessage(text: string, level?: 'info' | 'error' | 'action'): void;
  onClose(): void;
  onSave(input: SocialClusterInput & { name?: string }): void;
}) {
  const { t, cluster } = props;
  const [name, setName] = useState(cluster?.name ?? '');
  const [seriesName, setSeriesName] = useState(cluster?.seriesName ?? '');
  const [proxyServer, setProxyServer] = useState(cluster?.proxyServer ?? '');
  const [fbMode, setFbMode] = useState<'graph_api' | 'browser'>(cluster?.fbMode ?? 'graph_api');
  const [fbPageId, setFbPageId] = useState(cluster?.fbPageId ?? '');
  const [fbPageToken, setFbPageToken] = useState('');
  const [times, setTimes] = useState(cluster?.defaultScheduleTimes.join(', ') ?? '11:30, 19:30, 21:00');
  const [autoReplyPrompt, setAutoReplyPrompt] = useState(cluster?.autoReplyPrompt ?? '');
  const [autoPublishAfterTranslate, setAutoPublishAfterTranslate] = useState(cluster?.autoPublishAfterTranslate ?? false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(cluster?.autoReplyEnabled ?? false);
  const [ytChannelUrl, setYtChannelUrl] = useState(cluster?.ytChannelUrl ?? '');
  const [tkProfileUrl, setTkProfileUrl] = useState(cluster?.tkProfileUrl ?? '');
  const newToken = fbPageToken.trim();

  return (
    <div className="social-modal-mask" role="dialog" aria-modal="true">
      <div className="social-modal">
        <div className="social-modal-head">
          <h2>{cluster === null ? `➕ ${t('dashboard.social.newCluster')}` : `⚙️ Cấu Hình Chi Tiết: ${cluster.name}`}</h2>
          <button type="button" className="social-modal-close" onClick={props.onClose} aria-label={t('dashboard.drama.close')}>✕</button>
        </div>
        <div className="social-grid-3">
          <label htmlFor="social-cluster-name">Tên Nhóm:</label>
          <input id="social-cluster-name" type="text" className="span-2" value={name} onChange={event => setName(event.target.value)} placeholder="Nhóm_01" />
          <label htmlFor="social-cluster-series">{t('dashboard.social.seriesName')}:</label>
          <input id="social-cluster-series" type="text" className="span-2" value={seriesName} onChange={event => setSeriesName(event.target.value)} placeholder="Phàm Nhân Tu Tiên - Phần 3" />
          <label htmlFor="social-cluster-proxy">Proxy:</label>
          <input
            id="social-cluster-proxy"
            type="text"
            className="span-2 social-input-mono"
            placeholder="Tùy chọn — để trống dùng mạng nhà"
            value={proxyServer}
            onChange={event => setProxyServer(event.target.value)}
          />
          <label htmlFor="social-cluster-times">{t('dashboard.social.slotTimes')}:</label>
          <input
            id="social-cluster-times"
            type="text"
            className="span-2 social-input-mono"
            style={{ color: '#fbbf24' }}
            value={times}
            onChange={event => setTimes(event.target.value)}
            placeholder='"11:30", "19:30", "21:00"'
          />
          <label htmlFor="social-cluster-persona">{t('dashboard.social.autoReplyPrompt')}:</label>
          <input
            id="social-cluster-persona"
            type="text"
            className="span-2"
            value={autoReplyPrompt}
            onChange={event => setAutoReplyPrompt(event.target.value)}
            placeholder="Đạo hữu tu tiên hài hước, xưng tại hạ - đạo hữu"
          />
        </div>
        <div className="social-modal-toggles">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="accent-green"
              checked={autoPublishAfterTranslate}
              onChange={event => setAutoPublishAfterTranslate(event.target.checked)}
            />
            {' '}📥 Tự nạp đăng sau khi dịch xong
          </label>
          <label>
            <input
              type="checkbox"
              checked={autoReplyEnabled}
              onChange={event => setAutoReplyEnabled(event.target.checked)}
            />
            {' '}🤖 AI tự trả lời bình luận
          </label>
        </div>
        <details className="social-selectors-details">
          <summary>⚙️ Nâng cao (trình duyệt nhóm · Facebook Page · đường dẫn kênh)</summary>
          <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="social-enqueue-inline">
              <div>
                <label className="social-label" htmlFor="social-cluster-fbmode">{t('dashboard.social.fbModeLabel')}</label>
                <select id="social-cluster-fbmode" value={fbMode} onChange={event => setFbMode(event.target.value === 'browser' ? 'browser' : 'graph_api')}>
                  <option value="graph_api">Graph API</option>
                  <option value="browser">Business Suite</option>
                </select>
              </div>
              <div>
                <label className="social-label" htmlFor="social-cluster-fbpage">{t('dashboard.social.fbPageId')}</label>
                <input id="social-cluster-fbpage" type="text" value={fbPageId} onChange={event => setFbPageId(event.target.value)} />
              </div>
            </div>
            {fbMode === 'graph_api' ? (
              <div className="social-enqueue-row">
                <label className="social-label" htmlFor="social-cluster-fbtoken">
                  {t('dashboard.social.fbPageToken')}{cluster !== null && cluster.fbPageTokenConfigured ? ` · ${t('dashboard.social.tokenSaved')}` : ''}
                </label>
                <input
                  id="social-cluster-fbtoken"
                  type="password"
                  className="social-input-mono"
                  placeholder={cluster !== null && cluster.fbPageTokenConfigured ? t('dashboard.social.tokenPlaceholder') : 'EAAG…'}
                  value={fbPageToken}
                  onChange={event => setFbPageToken(event.target.value)}
                />
              </div>
            ) : null}
            <div className="social-enqueue-inline">
              <div>
                <label className="social-label" htmlFor="social-cluster-yt">{t('dashboard.social.ytChannelUrl')}</label>
                <input
                  id="social-cluster-yt"
                  type="text"
                  placeholder="https://www.youtube.com/@kenhphim"
                  value={ytChannelUrl}
                  onChange={event => setYtChannelUrl(event.target.value)}
                />
              </div>
              <div>
                <label className="social-label" htmlFor="social-cluster-tk">{t('dashboard.social.tkProfileUrl')}</label>
                <input
                  id="social-cluster-tk"
                  type="text"
                  placeholder="https://www.tiktok.com/@kenhphim"
                  value={tkProfileUrl}
                  onChange={event => setTkProfileUrl(event.target.value)}
                />
              </div>
            </div>
            {cluster !== null ? (
              <div className="social-enqueue-actions">
                {cluster.browserOpen ? (
                  <button
                    type="button"
                    className="social-btn social-btn-sm"
                    onClick={() => props.service.closeClusterBrowser(cluster.id).then(() => props.onMessage(`🌐 [${cluster.name}] Đã đóng trình duyệt nhóm.`, 'action'), () => undefined)}
                  >
                    {t('dashboard.social.closeBrowser')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="social-btn social-btn-sm"
                    onClick={() => props.service.openClusterBrowser(cluster.id).then(() => props.onMessage(`🌐 [${cluster.name}] Đang mở trình duyệt nhóm...`, 'action'), () => undefined)}
                  >
                    <ExternalLink size={12} aria-hidden="true" /> {t('dashboard.social.openBrowser')}
                  </button>
                )}
                <button
                  type="button"
                  className="social-btn social-btn-sm social-btn-danger"
                  onClick={() => {
                    if (window.confirm(t('dashboard.social.confirmDelete', { name: cluster.name }))) {
                      props.service.deleteCluster(cluster.id)
                        .then(() => { props.onMessage(`🗑️ [${cluster.name}] Đã xóa nhóm.`, 'action'); props.onClose(); })
                        .catch(() => undefined);
                    }
                  }}
                >
                  <Trash2 size={12} aria-hidden="true" /> {t('dashboard.social.deleteCluster')}
                </button>
              </div>
            ) : null}
          </div>
        </details>
        <div className="social-modal-actions">
          <button type="button" className="social-btn" onClick={props.onClose}>Hủy</button>
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
              ytChannelUrl: ytChannelUrl.trim(),
              tkProfileUrl: tkProfileUrl.trim(),
              autoReplyEnabled,
              autoReplyPrompt: autoReplyPrompt.trim(),
              autoPublishAfterTranslate
            })}
          >
            💾 {t('dashboard.drama.rangeApply')}
          </button>
        </div>
      </div>
    </div>
  );
}
