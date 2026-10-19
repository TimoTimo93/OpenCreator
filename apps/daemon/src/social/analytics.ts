/**
 * GĐ3 — Thu thập thống kê đa kênh: follower/sub của kênh và lượng view video.
 *
 * Nguồn dữ liệu:
 * - Facebook: Graph API (token Page mã hoá sẵn trong cụm): followers + view video.
 * - YouTube: mở trang kênh bằng trình duyệt của cụm (yt_channel_url) → parse
 *   số người đăng ký; video → fetch trang watch công khai → viewCount JSON.
 * - TikTok: mở profile (tk_profile_url) → parse followerCount/likesCount.
 *
 * Danh sách kết quả được lưu vào `social_stats` / `social_video_stats` với
 * captured_at mới nhất; delta so với lần đo trước hiển thị ở UI.
 */
import {
  insertStatsSnapshot,
  insertVideoStat,
  kvGet,
  kvSet,
  latestStatsWithPrevious,
  latestVideoStats,
  listClusterRows,
  listJobRows,
  type SocialDB,
  type SocialJobRow,
  type SocialClusterRow
} from './db.js';
import type { SocialWorker } from './worker.js';
import {
  type SocialChannelStat,
  type SocialMetricName,
  type SocialStatsOverview,
  type SocialStatsRefreshResult,
  type SocialVideoStat
} from './types.js';

const FB_API_VERSION = 'v20.0';

export type SocialAnalyticsInput = {
  db: SocialDB;
  worker: SocialWorker;
  decryptToken(token: string | null): string;
  /** 0/âm → chỉ chạy khi gọi refresh() thủ công. */
  refreshIntervalMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => { unref?(): void };
  fetchFn?: typeof fetch;
  now?: () => string;
  log?: (message: string) => void;
};

export type SocialAnalytics = {
  refresh(): Promise<SocialStatsRefreshResult>;
  getStats(): SocialStatsOverview;
  close(): void;
};

export function createSocialAnalytics(input: SocialAnalyticsInput): SocialAnalytics {
  const log = input.log ?? ((message: string): void => { console.log(`[social-stats] ${message}`); });
  const now = input.now ?? ((): string => new Date().toISOString());
  const fetchFn = input.fetchFn ?? globalThis.fetch.bind(globalThis);
  let closed = false;
  let refreshBusy = false;
  let timer: { unref?(): void } | undefined;

  const interval = input.refreshIntervalMs ?? 6 * 60 * 60_000;
  if (interval > 0) {
    const setter = input.setIntervalFn ?? ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms) as { unref?(): void };
      t.unref?.();
      return t;
    });
    timer = setter(() => { void runRefresh().catch(error => log(`refresh thất bại: ${message(error)}`)); }, interval);
  }

  return {
    async refresh(): Promise<SocialStatsRefreshResult> {
      if (closed) throw new Error('Analytics đã đóng');
      if (refreshBusy) {
        return { clustersScanned: 0, channelSnapshots: 0, videoSnapshots: 0, errors: ['Đang quét, thử lại sau'] };
      }
      refreshBusy = true;
      try {
        return await runRefresh();
      } finally {
        refreshBusy = false;
      }
    },

    getStats(): SocialStatsOverview {
      return readStats();
    },

    close(): void {
      closed = true;
      if (timer !== undefined) {
        clearInterval(timer as NodeJS.Timeout);
        timer = undefined;
      }
    }
  };

  // -------------------------------------------------------------------------

  async function runRefresh(): Promise<SocialStatsRefreshResult> {
    const capturedAt = now();
    const errors: string[] = [];
    let clustersScanned = 0;
    let channelSnapshots = 0;
    let videoSnapshots = 0;

    for (const clusterRow of listClusterRows(input.db)) {
      clustersScanned += 1;
      const cluster = clusterRow;

      // --- Channel snapshot ---
      if (cluster.fb_page_id.trim() !== '') {
        const token = input.decryptToken(cluster.fb_page_token_encrypted);
        if (token !== '') {
          try {
            const payload = await graphGet(
              fetchFn,
              `https://graph.facebook.com/${FB_API_VERSION}/${encodeURIComponent(cluster.fb_page_id)}?fields=followers_count`,
              token
            );
            const followers = asNumber((payload as Record<string, unknown>).followers_count);
            if (followers !== null) {
              insertStatsSnapshot(input.db, { clusterId: cluster.id, platform: 'facebook', metric: 'followers', value: followers, capturedAt });
              channelSnapshots += 1;
            }
          } catch (error) {
            errors.push(`facebook/${cluster.name}: ${message(error)}`);
          }
        }
      }

      const ytChannelUrl = cluster.yt_channel_url ?? '';
      if (ytChannelUrl.trim() !== '') {
        try {
          const subs = await scrapeYouTubeChannel(input.worker, cluster.id, ytChannelUrl.trim());
          if (subs !== null) {
            insertStatsSnapshot(input.db, { clusterId: cluster.id, platform: 'youtube', metric: 'followers', value: subs, capturedAt });
            channelSnapshots += 1;
          }
        } catch (error) {
          errors.push(`youtube/${cluster.name}: ${message(error)}`);
        }
      }

      const tkProfileUrl = cluster.tk_profile_url ?? '';
      if (tkProfileUrl.trim() !== '') {
        try {
          const metrics = await scrapeTikTokProfile(input.worker, cluster.id, tkProfileUrl.trim());
          if (metrics.followers !== null) {
            insertStatsSnapshot(input.db, { clusterId: cluster.id, platform: 'tiktok', metric: 'followers', value: metrics.followers, capturedAt });
            channelSnapshots += 1;
          }
          if (metrics.likes !== null) {
            insertStatsSnapshot(input.db, { clusterId: cluster.id, platform: 'tiktok', metric: 'likes', value: metrics.likes, capturedAt });
            channelSnapshots += 1;
          }
        } catch (error) {
          errors.push(`tiktok/${cluster.name}: ${message(error)}`);
        }
      }

      // --- Per-video views ---
      for (const job of listJobRows(input.db).filter(row => row.cluster_id === cluster.id)) {
        if (job.fb_status === 'published' && (job.fb_video_id ?? '') !== '') {
          try {
            const views = await fetchFacebookVideoViews(fetchFn, cluster, job, input.decryptToken);
            if (views !== null) {
              insertVideoStat(input.db, {
                jobId: job.id, clusterId: cluster.id, platform: 'facebook',
                externalVideoId: job.fb_video_id!, views, likes: null, commentsCount: null, capturedAt
              });
              videoSnapshots += 1;
            }
          } catch (error) {
            errors.push(`facebook-video/${cluster.name}/${job.title}: ${message(error)}`);
          }
        }
        if (job.yt_status === 'published' && (job.yt_video_id ?? '') !== '') {
          try {
            const views = await fetchYouTubeVideoViews(fetchFn, job.yt_video_id!);
            if (views !== null) {
              insertVideoStat(input.db, {
                jobId: job.id, clusterId: cluster.id, platform: 'youtube',
                externalVideoId: job.yt_video_id!, views, likes: null, commentsCount: null, capturedAt
              });
              videoSnapshots += 1;
            }
          } catch (error) {
            errors.push(`youtube-video/${cluster.name}/${job.title}: ${message(error)}`);
          }
        }
      }
    }

    kvSet(input.db, 'stats_last_refresh_at', capturedAt);
    if (errors.length > 0) kvSet(input.db, 'stats_last_refresh_error', errors.slice(0, 6).join(' | '));
    else kvSet(input.db, 'stats_last_refresh_error', '');
    log(`refresh xong: ${channelSnapshots} kênh + ${videoSnapshots} video, lỗi ${errors.length}`);
    return { clustersScanned, channelSnapshots, videoSnapshots, errors };
  }

  function readStats(): SocialStatsOverview {
    const clusters = new Map(listClusterRows(input.db).map(row => [row.id, row] as const));
    const channels: SocialChannelStat[] = [];
    for (const row of latestStatsWithPrevious(input.db)) {
      const cluster = clusters.get(row.cluster_id);
      channels.push({
        clusterId: row.cluster_id,
        clusterName: cluster?.name ?? row.cluster_id,
        platform: row.platform as SocialChannelStat['platform'],
        metrics: {
          [row.metric as SocialMetricName]: {
            value: row.value,
            capturedAt: row.captured_at,
            previous: row.previous
          }
        }
      });
    }
    const videos: SocialVideoStat[] = [];
    for (const row of latestVideoStats(input.db)) {
      const cluster = clusters.get(row.cluster_id);
      const job = listJobRows(input.db).find(candidate => candidate.id === row.job_id);
      videos.push({
        jobId: row.job_id,
        clusterId: row.cluster_id,
        clusterName: cluster?.name ?? row.cluster_id,
        title: job?.title ?? row.job_id,
        platform: row.platform as SocialVideoStat['platform'],
        externalVideoId: row.external_video_id,
        views: row.views,
        likes: row.likes,
        commentsCount: row.comments_count,
        capturedAt: row.captured_at,
        previousViews: row.previousViews
      });
    }
    return {
      channels,
      videos,
      lastRefreshAt: kvGet(input.db, 'stats_last_refresh_at') ?? null,
      refreshError: kvGet(input.db, 'stats_last_refresh_error') === '' ? null : (kvGet(input.db, 'stats_last_refresh_error') ?? null)
    };
  }
}

// ---------------------------------------------------------------------------
// Lấy dữ liệu helpers (exported cho unit test)
// ---------------------------------------------------------------------------

async function graphGet(fetchFn: typeof fetch, url: string, token: string): Promise<unknown> {
  const response = await fetchFn(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`Graph API ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
  }
  return await response.json() as unknown;
}

async function fetchFacebookVideoViews(
  fetchFn: typeof fetch,
  cluster: SocialClusterRow,
  job: SocialJobRow,
  decryptToken: (token: string | null) => string
): Promise<number | null> {
  const token = decryptToken(cluster.fb_page_token_encrypted);
  if (token === '') throw new Error('Chưa cấu hình Page token cho cụm');
  const videoId = encodeURIComponent(job.fb_video_id!);
  try {
    const payload = await graphGet(fetchFn, `https://graph.facebook.com/${FB_API_VERSION}/${videoId}/video_insights?metric=total_video_views`, token);
    const list = (payload as { data?: Array<{ name?: string; values?: Array<{ value?: number }> }> }).data;
    const hits = list?.find(entry => entry.name === 'total_video_views');
    const value = hits?.values?.[0]?.value;
    if (typeof value === 'number') return value;
    return null;
  } catch (error) {
    // Fallback cũ: field "views" trên node video (chỉ đây hỗ trợ trang).
    try {
      const payload = await graphGet(fetchFn, `https://graph.facebook.com/${FB_API_VERSION}/${videoId}?fields=views`, token);
      const views = asNumber((payload as Record<string, unknown>).views);
      if (views !== null) return views;
    } catch {
      void error;
    }
    return null;
  }
}

async function fetchYouTubeVideoViews(fetchFn: typeof fetch, videoId: string): Promise<number | null> {
  const response = await fetchFn(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept-Language': 'vi,en;q=0.9'
    }
  });
  if (!response.ok) throw new Error(`YouTube watch ${response.status}`);
  const html = await response.text();
  // ytInitialPlayerResponse của video công khai chứa viewCount chuỗi số.
  const match = html.match(/"viewCount":"(\d+)"/);
  return match === null ? null : Number(match[1]);
}

/** Mở trang kênh bằng trình duyệt của cụm và parse số người đăng ký. */
async function scrapeYouTubeChannel(worker: SocialWorker, clusterId: string, channelUrl: string): Promise<number | null> {
  return worker.withClusterBrowser(clusterId, async handle => {
    const page = await handle.newPage(normalizeChannelUrl(channelUrl)) as {
      content(): Promise<string>;
      url(): string;
      close(): Promise<void>;
    };
    try {
      await sleepUntilContent(page, 15_000, html => html.includes('subscriberCountText'));
      return extractYouTubeSubscribers(await page.content());
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

/** TikTok profile: followerCount + likesCount (JSON gần như luôn inline trong HTML). */
async function scrapeTikTokProfile(
  worker: SocialWorker,
  clusterId: string,
  profileUrl: string
): Promise<{ followers: number | null; likes: number | null }> {
  return worker.withClusterBrowser(clusterId, async handle => {
    const page = await handle.newPage(profileUrl.startsWith('http') ? profileUrl : `https://${profileUrl}`) as {
      content(): Promise<string>;
      url(): string;
      close(): Promise<void>;
    };
    try {
      await sleepUntilContent(page, 15_000, html => html.includes('followerCount') || html.includes('likesCount'));
      const html = await page.content();
      return {
        followers: extractTikTokNumberField(html, 'followerCount'),
        likes: extractTikTokNumberField(html, 'likesCount')
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

export function normalizeChannelUrl(url: string): string {
  if (url.startsWith('http')) return url;
  return `https://${url}`;
}

/** Đợi trang nạp xong: kiểm tra predicate liên tục trong maxWaitMs. */
async function sleepUntilContent(
  page: { url(): string; content(): Promise<string> },
  maxWaitMs: number,
  predicate: (html: string) => boolean
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const html = await page.content().catch(() => '');
    if (predicate(html)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

export function extractYouTubeSubscribers(html: string): number | null {
  // Cửa sổ nhỏ quanh subscriberCountText tránh } lồng của accessibility.
  const anchor = html.indexOf('"subscriberCountText"');
  if (anchor < 0) return null;
  const segment = html.slice(anchor, anchor + 240);
  const simple = segment.match(/"simpleText":"([^"]+)"/);
  if (simple !== null) return parseCompactNumber(simple[1] ?? undefined);
  const label = segment.match(/"label":"([^"]+)"/);
  if (label !== null) return parseCompactNumber(label[1] ?? undefined);
  return null;
}

export function extractTikTokNumberField(html: string, field: string): number | null {
  const direct = html.match(new RegExp(`"${field}":("((?:\\\\.|[^"\\\\])*)"|(\\d+))`));
  if (direct === null) return null;
  if (direct[3] !== undefined) return Number(direct[3]);
  const quoted = direct[2];
  return quoted === undefined ? null : parseCompactNumber(quoted);
}

/** "1.234" / "1,23 N người đăng ký" / "12.56 lượt xem" / "1.2M subscribers". */
export function parseCompactNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const text = raw
    .replace(/người đăng ký|người theo dõi|lượt xem|subscribers|followers|likes/gi, '')
    .trim();
  const match = text.match(/([\d.,，]+)\s*([a-zA-ZÀ-ỹĐđ]*)/);
  if (match === null) return null;
  const digits = (match[1] ?? '').replace(/,|，/g, '.').replace(/\s/g, '').replace(/\.(?=.*\.)/g, '');
  const numeric = Number(digits.replace(/\.+/g, '.'));
  if (Number.isNaN(numeric)) return null;
  const suffix = (match[2] ?? '').toLowerCase();
  let multiplier = 1;
  if (suffix.includes('ngh') || suffix === 'n' || suffix === 'k') multiplier = 1_000;
  else if (suffix.startsWith('tr') || suffix === 'm' || suffix === 'trr') multiplier = 1_000_000;
  else if (suffix === 't') multiplier = 1_000_000_000;
  return Math.round(numeric * multiplier);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
