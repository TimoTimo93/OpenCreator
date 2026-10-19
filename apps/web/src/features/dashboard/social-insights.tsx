import { useCallback, useEffect, useState } from 'react';
import { BarChart3, LoaderCircle, MessageSquareReply, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import type { Translate } from '../../i18n/LanguageProvider.js';
import type {
  SocialClusterSummary,
  SocialCommentScanResult,
  SocialCommentSummary,
  SocialHistoryPoint,
  SocialStatsOverview
} from '../../services/social-service.js';
import type { SocialService } from '../../services/social-service.js';

/**
 * GĐ3 — Dữ liệu + panel thống kê (view/sub) và bình luận AI tự động của
 * module đa kênh. Workspace mới tách thành 2 tab riêng (Thống kê / Bình luận);
 * cả hai dùng chung một hook dữ liệu nhẹ, refresh cùng nhịp polling overview.
 */

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

function deltaLabel(point: { value: number; previous: number | null } | undefined): string {
  if (point === undefined || point.previous === null) return '';
  const delta = point.value - point.previous;
  if (delta === 0) return '';
  return `${delta > 0 ? '+' : ''}${delta.toLocaleString()}`;
}

function formatScheduleShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return String(error ?? 'unknown error');
}

/**
 * Sparkline SVG thuần (không thư viện chart): polyline theo các điểm đo
 * + chấm tại điểm cuối. Màu xanh khi điểm cuối ≥ điểm đầu, đỏ khi ngược lại.
 * Trả null khi <2 điểm — không đủ dữ liệu để vẽ xu hướng.
 */
export function Sparkline(props: { points: SocialHistoryPoint[]; width: number; height: number }) {
  if (props.points.length < 2) return null;
  const { width, height } = props;
  const pad = 3;
  const values = props.points.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const stepX = (width - pad * 2) / (props.points.length - 1);
  const coords = props.points.map((point, index) => ({
    x: pad + index * stepX,
    y: span === 0 ? height / 2 : pad + (1 - (point.value - min) / span) * (height - pad * 2)
  }));
  const first = coords[0] ?? { x: 0, y: 0 };
  const last = coords[coords.length - 1] ?? first;
  const up = (values[values.length - 1] ?? 0) >= (values[0] ?? 0);
  return (
    <svg
      className={`social-spark ${up ? 'social-spark-up' : 'social-spark-down'}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-hidden="true"
    >
      <polyline
        className="social-spark-line"
        points={coords.map(coord => `${coord.x.toFixed(1)},${coord.y.toFixed(1)}`).join(' ')}
      />
      <circle className="social-spark-dot" cx={last.x.toFixed(1)} cy={last.y.toFixed(1)} r="2.4" />
    </svg>
  );
}

/** Lấy chuỗi điểm đo của một (cụm, nền tảng, metric) từ history của overview. */
function trendPointsFor(
  history: SocialStatsOverview['history'],
  clusterId: string,
  platform: string,
  metric: string
): SocialHistoryPoint[] {
  const match = history?.find(
    entry => entry.clusterId === clusterId && entry.platform === platform && entry.metric === metric
  );
  return match?.points ?? [];
}

type InsightsData = {
  stats: SocialStatsOverview | null;
  comments: SocialCommentSummary[];
  busy: boolean;
  scanning: boolean;
  scanSummary: SocialCommentScanResult | null;
  errorText: string;
  reload(spinner: boolean): Promise<void>;
  scan(): Promise<void>;
  setErrorText(text: string): void;
};

function useSocialInsightsData(service: SocialService, refreshKey: number): InsightsData {
  const [stats, setStats] = useState<SocialStatsOverview | null>(null);
  const [comments, setComments] = useState<SocialCommentSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanSummary, setScanSummary] = useState<SocialCommentScanResult | null>(null);
  const [errorText, setErrorText] = useState('');

  const reload = useCallback(async (spinner: boolean) => {
    if (spinner) setBusy(true);
    try {
      const [statsData, commentsData] = await Promise.all([
        service.getStats(),
        service.listComments(undefined, 60).catch(() => [])
      ]);
      setStats(statsData);
      setComments(commentsData);
      setErrorText('');
    } catch (cause) {
      setErrorText(messageOf(cause));
    } finally {
      if (spinner) setBusy(false);
    }
  }, [service]);

  useEffect(() => {
    void reload(refreshKey !== 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await service.scanComments();
      setScanSummary(result);
      await reload(false);
    } catch (cause) {
      setErrorText(messageOf(cause));
    } finally {
      setScanning(false);
    }
  }, [service, reload]);

  return { stats, comments, busy, scanning, scanSummary, errorText, reload, scan, setErrorText };
}

export function SocialStatsPanel(props: {
  service: SocialService;
  t: Translate;
  refreshKey: number;
}) {
  const { t } = props;
  const data = useSocialInsightsData(props.service, props.refreshKey);
  const stats = data.stats;
  // Xu hướng followers: lấy điểm đo theo (cụm, nền tảng) từ history của daemon.
  const followerTrends = (stats?.channels ?? []).map(channel => ({
    channel,
    points: trendPointsFor(stats?.history, channel.clusterId, channel.platform, 'followers')
  }));
  const hasTrendColumn = followerTrends.some(entry => entry.points.length >= 2);
  // Block tổng quan: tối đa 3 sparkline lớn cho followers — chỉ khi dữ liệu đủ dày (≥3 điểm).
  const trendCards = followerTrends.filter(entry => entry.points.length >= 3).slice(0, 3);
  return (
    <div className="social-insights" aria-label={t('dashboard.social.insightsTitle')}>
      <div className="social-panel-head">
        <h2><BarChart3 size={15} aria-hidden="true" /> {t('dashboard.social.insightsStats')}</h2>
        <div className="social-panel-head-actions">
          <button type="button" className="social-btn social-btn-sm" onClick={() => void data.reload(true)} disabled={data.busy}>
            <RefreshCw size={12} className={data.busy ? 'social-spin' : ''} aria-hidden="true" /> {t('dashboard.drama.refresh')}
          </button>
        </div>
      </div>

      {data.errorText !== '' ? (
        <div className="social-error" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>{data.errorText}</span>
          <button type="button" className="social-btn social-btn-sm" onClick={() => void data.reload(true)}>
            {t('dashboard.drama.retry')}
          </button>
        </div>
      ) : null}

      {data.busy && stats === null ? (
        <p className="social-loading"><LoaderCircle size={16} className="social-spin" /> {t('dashboard.drama.loading')}</p>
      ) : null}

      {stats !== null ? (
        <div className="social-stats">
          {stats.lastRefreshAt !== null ? (
            <p className="social-stats-meta">
              {t('dashboard.social.statsLastRefresh', { time: formatScheduleShort(stats.lastRefreshAt) })}
              {stats.refreshError !== null ? ` · ${t('dashboard.social.statsErrors')}` : ''}
            </p>
          ) : null}
          {stats.channels.length === 0 ? (
            <p className="social-empty">{t('dashboard.social.statsEmpty')}</p>
          ) : (
            <>
              {trendCards.length > 0 ? (
                <div className="social-trend-strip">
                  {trendCards.map(entry => (
                    <div
                      key={`trend-${entry.channel.clusterId}-${entry.channel.platform}`}
                      className="social-trend-card"
                    >
                      <span className="social-trend-card-name">
                        {entry.channel.clusterName} · {entry.channel.platform}
                      </span>
                      <Sparkline points={entry.points} width={160} height={48} />
                    </div>
                  ))}
                </div>
              ) : null}
              <table className="social-table">
                <thead>
                  <tr>
                    <th>{t('dashboard.social.statsColCluster')}</th>
                    <th>{t('dashboard.social.statsColPlatform')}</th>
                    <th>{t('dashboard.social.statsColFollowers')}</th>
                    {hasTrendColumn ? <th>{t('dashboard.social.trendColumn')}</th> : null}
                    <th>{t('dashboard.social.statsColCaptured')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.channels.map((channel, index) => {
                    const points = followerTrends[index]?.points ?? [];
                    return (
                      <tr key={`${channel.clusterId}-${channel.platform}-${index}`}>
                        <td>{channel.clusterName}</td>
                        <td>{channel.platform}</td>
                        <td>
                          {formatCount(channel.metrics.followers?.value)}
                          {deltaLabel(channel.metrics.followers) !== '' ? (
                            <span className={deltaLabel(channel.metrics.followers).startsWith('+') ? 'social-delta-up' : 'social-delta-down'}>
                              {' '}{deltaLabel(channel.metrics.followers)}
                            </span>
                          ) : null}
                        </td>
                        {hasTrendColumn ? (
                          <td>
                            {points.length >= 2 ? (
                              <Sparkline points={points} width={80} height={24} />
                            ) : (
                              <span className="social-trend-empty">—</span>
                            )}
                          </td>
                        ) : null}
                        <td>{channel.metrics.followers !== undefined ? formatScheduleShort(channel.metrics.followers.capturedAt) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
          {stats.videos.length > 0 ? (
            <>
              <h3>{t('dashboard.social.statsVideoTitle')}</h3>
              <table className="social-table">
                <thead>
                  <tr>
                    <th>{t('dashboard.social.statsColVideo')}</th>
                    <th>{t('dashboard.social.statsColPlatform')}</th>
                    <th>{t('dashboard.social.statsColViews')}</th>
                    <th>{t('dashboard.social.statsColCaptured')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.videos.map((video, index) => (
                    <tr key={`${video.jobId}-${video.platform}-${index}`}>
                      <td title={video.title}>{video.title.length > 40 ? `${video.title.slice(0, 40)}…` : video.title}</td>
                      <td>{video.platform}</td>
                      <td>
                        {formatCount(video.views)}
                        {video.previousViews !== null && video.views !== null && video.views !== video.previousViews ? (
                          <span className={video.views > video.previousViews ? 'social-delta-up' : 'social-delta-down'}>
                            {' '}{video.views - video.previousViews > 0 ? '+' : ''}{(video.views - video.previousViews).toLocaleString()}
                          </span>
                        ) : null}
                      </td>
                      <td>{formatScheduleShort(video.capturedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SocialCommentsPanel(props: {
  service: SocialService;
  clusters: SocialClusterSummary[];
  t: Translate;
  refreshKey: number;
}) {
  const { t } = props;
  const data = useSocialInsightsData(props.service, props.refreshKey);
  const comments = data.comments;
  return (
    <div className="social-insights" aria-label={t('dashboard.social.insightsTitle')}>
      <div className="social-panel-head">
        <h2><MessageSquareReply size={15} aria-hidden="true" /> {t('dashboard.social.insightsComments')}</h2>
      </div>

      {data.errorText !== '' ? (
        <div className="social-error" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>{data.errorText}</span>
          <button type="button" className="social-btn social-btn-sm" onClick={() => void data.reload(true)}>
            {t('dashboard.drama.retry')}
          </button>
        </div>
      ) : null}

      <div className="social-comments">
        <div className="social-comments-actions">
          <button
            type="button"
            className="social-btn social-btn-sm social-btn-primary"
            disabled={data.scanning}
            onClick={() => void data.scan()}
          >
            {data.scanning ? <LoaderCircle size={12} className="social-spin" aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}
            {t('dashboard.social.commentsScan')}
          </button>
          <span className="social-comments-hint">{t('dashboard.social.commentsHint')}</span>
        </div>
        {data.scanSummary !== null ? (
          <p className="social-stats-meta">
            {t('dashboard.social.commentsScanSummary', {
              videos: data.scanSummary.videosScanned,
              fresh: data.scanSummary.newComments,
              sent: data.scanSummary.repliesSent,
              attempted: data.scanSummary.repliesAttempted
            })}
            {data.scanSummary.errors.length > 0 ? ` — ${data.scanSummary.errors[0]}` : ''}
          </p>
        ) : null}
        <div className="social-autoreply-clusters">
          {props.clusters.map(cluster => (
            <button
              key={cluster.id}
              type="button"
              className={`social-btn social-btn-sm ${cluster.autoReplyEnabled ? 'social-btn-primary' : ''}`}
              onClick={() => void props.service.updateCluster(cluster.id, { autoReplyEnabled: !cluster.autoReplyEnabled }).then(
                () => { void data.reload(false); },
                cause => { data.setErrorText(messageOf(cause)); }
              )}
            >
              {cluster.autoReplyEnabled ? '✅' : '⏸'} {t('dashboard.social.autoReplyToggle')}: {cluster.seriesName !== '' ? cluster.seriesName : cluster.name}
            </button>
          ))}
        </div>
        {comments.length === 0 ? (
          <p className="social-empty">{t('dashboard.social.commentsEmpty')}</p>
        ) : (
          <ul className="social-comment-list">
            {comments.map(comment => (
              <li key={comment.id} className={`social-comment-row social-comment-${comment.replyStatus}`}>
                <div className="social-comment-main">
                  <p className="social-comment-text" title={comment.text}>“{comment.text.length > 120 ? `${comment.text.slice(0, 120)}…` : comment.text}”</p>
                  <p className="social-comment-meta">
                    {comment.author} · {comment.platform} · {comment.clusterName}
                    {comment.commentCreatedAt !== null ? ` · ${formatScheduleShort(comment.commentCreatedAt)}` : ''}
                  </p>
                  {comment.replyText !== null ? <p className="social-comment-reply">↩ “{comment.replyText.length > 120 ? `${comment.replyText.slice(0, 120)}…` : comment.replyText}”</p> : null}
                  {comment.skippedReason !== null ? <p className="social-comment-skipped">{comment.skippedReason}</p> : null}
                </div>
                <span className="social-chip social-chip-pending">{t(`dashboard.social.reply_${comment.replyStatus}` as never)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
