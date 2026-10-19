import { useCallback, useEffect, useState } from 'react';
import { BarChart3, LoaderCircle, MessageSquareReply, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import type { Translate } from '../../i18n/LanguageProvider.js';
import type {
  SocialClusterSummary,
  SocialCommentScanResult,
  SocialCommentSummary,
  SocialStatsOverview
} from '../../services/social-service.js';
import type { SocialService } from '../../services/social-service.js';

/**
 * GĐ3 — Panel thống kê (view/sub) + bình luận AI tự động của module đa kênh.
 * Lấy dữ liệu polling nhẹ cùng chu kỳ overview của SocialWorkspace.
 */

type PanelTab = 'stats' | 'comments';

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

export function SocialInsightsPanel(props: {
  service: SocialService;
  clusters: SocialClusterSummary[];
  t: Translate;
  refreshKey: number;
}) {
  const { t } = props;
  const service = props.service;
  const [tab, setTab] = useState<PanelTab>('stats');
  const [stats, setStats] = useState<SocialStatsOverview | null>(null);
  const [comments, setComments] = useState<SocialCommentSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanSummary, setScanSummary] = useState<SocialCommentScanResult | null>(null);
  const [errorText, setErrorText] = useState('');

  const loadStats = useCallback(async (spinner: boolean) => {
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
      setErrorText(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (spinner) setBusy(false);
    }
  }, [service]);

  useEffect(() => {
    void loadStats(props.refreshKey !== 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshKey]);

  return (
    <section className="social-insights" aria-label={t('dashboard.social.insightsTitle')}>
      <div className="social-queue-head">
        <h2>{t('dashboard.social.insightsTitle')}</h2>
        <div className="social-insights-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'stats'}
            className={`social-btn social-btn-sm ${tab === 'stats' ? 'social-btn-primary' : ''}`}
            onClick={() => setTab('stats')}
          >
            <BarChart3 size={12} aria-hidden="true" /> {t('dashboard.social.insightsStats')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'comments'}
            className={`social-btn social-btn-sm ${tab === 'comments' ? 'social-btn-primary' : ''}`}
            onClick={() => setTab('comments')}
          >
            <MessageSquareReply size={12} aria-hidden="true" /> {t('dashboard.social.insightsComments')}
          </button>
        </div>
      </div>

      {errorText !== '' ? (
        <div className="social-error" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>{errorText}</span>
          <button type="button" className="social-btn social-btn-sm" onClick={() => void loadStats(true)}>
            {t('dashboard.drama.retry')}
          </button>
        </div>
      ) : null}

      {busy && stats === null ? (
        <p className="social-loading"><LoaderCircle size={16} className="social-spin" /> {t('dashboard.drama.loading')}</p>
      ) : null}

      {tab === 'stats' && stats !== null ? (
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
            <table className="social-table">
              <thead>
                <tr>
                  <th>{t('dashboard.social.statsColCluster')}</th>
                  <th>{t('dashboard.social.statsColPlatform')}</th>
                  <th>{t('dashboard.social.statsColFollowers')}</th>
                  <th>{t('dashboard.social.statsColCaptured')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.channels.map((channel, index) => (
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
                    <td>{channel.metrics.followers !== undefined ? formatScheduleShort(channel.metrics.followers.capturedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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

      {tab === 'comments' ? (
        <div className="social-comments">
          <div className="social-comments-actions">
            <button
              type="button"
              className="social-btn social-btn-sm social-btn-primary"
              disabled={scanning}
              onClick={async () => {
                setScanning(true);
                try {
                  const result = await service.scanComments();
                  setScanSummary(result);
                  await loadStats(false);
                } catch (cause) {
                  setErrorText(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setScanning(false);
                }
              }}
            >
              {scanning ? <LoaderCircle size={12} className="social-spin" aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}
              {t('dashboard.social.commentsScan')}
            </button>
            <span className="social-comments-hint">{t('dashboard.social.commentsHint')}</span>
          </div>
          {scanSummary !== null ? (
            <p className="social-stats-meta">
              {t('dashboard.social.commentsScanSummary', {
                videos: scanSummary.videosScanned,
                fresh: scanSummary.newComments,
                sent: scanSummary.repliesSent,
                attempted: scanSummary.repliesAttempted
              })}
              {scanSummary.errors.length > 0 ? ` — ${scanSummary.errors[0]}` : ''}
            </p>
          ) : null}
          <div className="social-autoreply-clusters">
            {props.clusters.map(cluster => (
              <button
                key={cluster.id}
                type="button"
                className={`social-btn social-btn-sm ${cluster.autoReplyEnabled ? 'social-btn-primary' : ''}`}
                onClick={() => void props.service.updateCluster(cluster.id, { autoReplyEnabled: !cluster.autoReplyEnabled }).then(
                  () => { void loadStats(false); },
                  cause => { setErrorText(cause instanceof Error ? cause.message : String(cause)); }
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
      ) : null}
    </section>
  );
}

function formatScheduleShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function InsightsRefreshTrigger(props: { onRefresh(): void }) {
  return (
    <button type="button" className="social-btn social-btn-sm" onClick={props.onRefresh}>
      <RefreshCw size={12} aria-hidden="true" />
    </button>
  );
}
