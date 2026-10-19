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
  listStatsHistory,
  type SocialDB,
  type SocialJobRow,
  type SocialClusterRow
} from './db.js';
import type { SocialWorker } from './worker.js';
import {
  type SocialChannelStat,
  type SocialHistoryPoint,
  type SocialMetricHistory,
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
  /**
   * Chạy yt-dlp với args dựng sẵn (profile TikTok, flat-playlist JSON) —
   * dùng runtime yt-dlp đóng gói (không mở trình duyệt). Không có → quét
   * trình duyệt như trước. Inject để test không gọi mạng thật.
   */
  runYtDlpFn?: (args: readonly string[]) => Promise<unknown>;
  /**
   * YouTube Data API v3 key (tùy chọn). Có key → channels.list/videos.list
   * theo batch (rẻ quota) thay vì scrape trình duyệt; rỗng → fallback cũ.
   */
  readYoutubeApiKey?: () => string | undefined | null | Promise<string | undefined | null>;
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

    const clusterRows = listClusterRows(input.db);
    const jobRows = listJobRows(input.db);

    // YouTube Data API (tùy chọn): 1 fetch/batch cho các video+publisher của cả cụm.
    const ytApiKey = input.readYoutubeApiKey === undefined
      ? ''
      : ((await input.readYoutubeApiKey()) ?? '').trim();
    const ytApiHandledJobIds = new Set<string>();
    const ytApiHandledClusters = new Set<string>();
    if (ytApiKey !== '') {
      try {
        const pass = await collectYouTubeViaApi(
          input.db, fetchFn, ytApiKey, clusterRows, jobRows, capturedAt
        );
        channelSnapshots += pass.channelSnapshots;
        videoSnapshots += pass.videoSnapshots;
        for (const jobId of pass.handledJobIds) ytApiHandledJobIds.add(jobId);
        for (const clusterId of pass.handledClusterIds) ytApiHandledClusters.add(clusterId);
      } catch (error) {
        errors.push(`youtube-api: ${message(error)}`);
      }
    }

    for (const clusterRow of clusterRows) {
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
      if (ytChannelUrl.trim() !== '' && !ytApiHandledClusters.has(cluster.id)) {
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

      // TikTok: ưu tiên yt-dlp (không trình duyệt, không captcha); lỗi → fallback.
      const tkProfileUrl = cluster.tk_profile_url ?? '';
      if (tkProfileUrl.trim() !== '') {
        try {
          const metrics = await tikTokMetrics(cluster, tkProfileUrl.trim(), jobRows);
          if (metrics.followers !== null) {
            insertStatsSnapshot(input.db, { clusterId: cluster.id, platform: 'tiktok', metric: 'followers', value: metrics.followers, capturedAt });
            channelSnapshots += 1;
          }
          if (metrics.likes !== null) {
            insertStatsSnapshot(input.db, { clusterId: cluster.id, platform: 'tiktok', metric: 'likes', value: metrics.likes, capturedAt });
            channelSnapshots += 1;
          }
          // Per-video views: khớp entry với job TikTok đã đăng theo tk_video_id.
          for (const match of metrics.perVideo) {
            try {
              insertVideoStat(input.db, {
                jobId: match.jobId, clusterId: cluster.id, platform: 'tiktok',
                externalVideoId: match.externalVideoId, views: match.views,
                likes: null, commentsCount: null, capturedAt
              });
              videoSnapshots += 1;
            } catch (error) {
              errors.push(`tiktok-video/${cluster.name}: ${message(error)}`);
            }
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
        if (job.yt_status === 'published' && (job.yt_video_id ?? '') !== '' && !ytApiHandledJobIds.has(job.id)) {
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

  async function tikTokMetrics(
    cluster: SocialClusterRow,
    profileUrl: string,
    jobRows: SocialJobRow[]
  ): Promise<{ followers: number | null; likes: number | null; perVideo: Array<{ jobId: string; externalVideoId: string; views: number }> }> {
    // Ưu tiên yt-dlp (không trình duyệt, không captcha). yt-dlp chạy được nhưng
    // thiếu số tổng (tùy account — flat-playlist có thể không bóc được
    // followerCount) → bổ sung tổng bằng fallback trình duyệt, giữ per-video.
    if (input.runYtDlpFn !== undefined) {
      try {
        const viaYtDlp = await collectTikTokViaYtDlp(input.runYtDlpFn, cluster, profileUrl, jobRows);
        if (viaYtDlp.followers !== null || viaYtDlp.likes !== null) return viaYtDlp;
        const fallback = await scrapeTikTokProfile(input.worker, cluster.id, profileUrl);
        return { followers: fallback.followers, likes: fallback.likes, perVideo: viaYtDlp.perVideo };
      } catch (error) {
        log(`tiktok/${cluster.name}: yt-dlp lỗi → quét trình duyệt (${message(error)})`);
      }
    }
    return { ...(await scrapeTikTokProfile(input.worker, cluster.id, profileUrl)), perVideo: [] };
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
      history: [...metricHistory('followers'), ...metricHistory('views')],
      lastRefreshAt: kvGet(input.db, 'stats_last_refresh_at') ?? null,
      refreshError: kvGet(input.db, 'stats_last_refresh_error') === '' ? null : (kvGet(input.db, 'stats_last_refresh_error') ?? null)
    };
  }

  /**
   * Lịch sử (sparkline) cho 1 metric chính: gom listStatsHistory theo
   * (cluster, platform) — điểm tăng dần theo thời gian, tối đa 30/chuỗi.
   * Chỉ followers + views (2 metric chính), không gắn cho likes/videos.
   */
  function metricHistory(metric: 'followers' | 'views'): SocialMetricHistory[] {
    const bySeries = new Map<string, SocialMetricHistory>();
    for (const row of listStatsHistory(input.db, { metric })) {
      const key = `${row.cluster_id}\n${row.platform}`;
      let entry = bySeries.get(key);
      if (entry === undefined) {
        entry = {
          clusterId: row.cluster_id,
          platform: row.platform as SocialChannelStat['platform'],
          metric,
          points: []
        };
        bySeries.set(key, entry);
      }
      const point: SocialHistoryPoint = { value: row.value, capturedAt: row.captured_at };
      entry.points.push(point);
    }
    return [...bySeries.values()];
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

// ---------------------------------------------------------------------------
// YouTube Data API v3 (tùy chọn — rẻ quota: 1 fetch cho cả batch 50 mục)
// ---------------------------------------------------------------------------

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

type YouTubeApiPass = {
  channelSnapshots: number;
  videoSnapshots: number;
  handledJobIds: string[];
  handledClusterIds: string[];
};

type YtApiItem = {
  id: string;
  channelId?: string;
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    subscriberCount?: string;
    videoCount?: string;
  };
};

async function youtubeApiGet(
  fetchFn: typeof fetch,
  apiKey: string,
  path: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const url = new URL(`${YT_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('key', apiKey);
  const response = await fetchFn(url.toString(), { method: 'GET' });
  if (!response.ok) {
    throw new Error(`YouTube Data API ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
  }
  return await response.json() as Record<string, unknown>;
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += size) pages.push(items.slice(index, index + size));
  return pages;
}

function apiNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Xếp @handle trong yt_channel_url (dùng channels.list?forHandle, 1 quota). */
export function extractYouTubeHandle(raw: string | null): string | null {
  const match = (raw ?? '').trim().match(/@([\w.-]+)/);
  return match === null ? null : `@${match[1]}`;
}

export function parseChannelIdFromUrl(raw: string | null): string | null {
  const match = (raw ?? '').trim().match(/channel\/(UC[\w-]{10,})/);
  return match === null ? null : match[1]!;
}

function apiItems(payload: Record<string, unknown>): YtApiItem[] {
  return Array.isArray(payload.items) ? payload.items as YtApiItem[] : [];
}

/**
 * Lượt quét YouTube bằng Data API: videos.list (mỗi 50 id = 1 quota cho views
 * từng video) + channels.list (mỗi 50 id = 1 quota cho subscribers/total
 * views/videoCount). Trả cờ job/cluster đã xử lý để vòng quét cũ bỏ qua.
 */
async function collectYouTubeViaApi(
  db: SocialDB,
  fetchFn: typeof fetch,
  apiKey: string,
  clusterRows: SocialClusterRow[],
  jobRows: SocialJobRow[],
  capturedAt: string
): Promise<YouTubeApiPass> {
  let channelSnapshots = 0;
  let videoSnapshots = 0;
  const handledJobIds: string[] = [];
  const handledClusterIds: string[] = [];

  const publishedJobs = jobRows.filter(
    job => job.yt_status === 'published' && (job.yt_video_id ?? '').trim() !== ''
  );

  // 1) videos.list batch → views từng video + channelId (map video về cụm).
  const channelIdByVideo = new Map<string, string>();
  const ids = [...new Set(publishedJobs.map(job => job.yt_video_id!.trim()))];
  for (const page of chunkItems(ids, 50)) {
    const payload = await youtubeApiGet(fetchFn, apiKey, 'videos', {
      part: 'statistics,snippet',
      id: page.join(',')
    });
    const known = new Set(page);
    for (const item of apiItems(payload)) {
      if (!known.has(item.id)) continue;
      if (item.channelId !== undefined) channelIdByVideo.set(item.id, item.channelId);
      const views = apiNumber(item.statistics?.viewCount);
      const job = publishedJobs.find(candidate => candidate.yt_video_id!.trim() === item.id);
      if (job === undefined) continue;
      if (views !== null) {
        insertVideoStat(db, {
          jobId: job.id, clusterId: job.cluster_id, platform: 'youtube',
          externalVideoId: item.id, views, likes: null, commentsCount: null, capturedAt
        });
        videoSnapshots += 1;
        handledJobIds.push(job.id);
      }
    }
  }

  // 2) Map cụm → channelId: qua video đã đăng, hoặc "channel/UC..." trong URL.
  const channelIdByCluster = new Map<string, string>();
  for (const job of publishedJobs) {
    const channelId = channelIdByVideo.get(job.yt_video_id!.trim());
    if (channelId !== undefined && !channelIdByCluster.has(job.cluster_id)) {
      channelIdByCluster.set(job.cluster_id, channelId);
    }
  }
  for (const clusterRow of clusterRows) {
    if (channelIdByCluster.has(clusterRow.id)) continue;
    const direct = parseChannelIdFromUrl(clusterRow.yt_channel_url ?? '');
    if (direct !== null) channelIdByCluster.set(clusterRow.id, direct);
  }

  // 3) channels.list batch theo id; cụm còn lại thử forHandle trên URL @handle.
  const statsByChannel = new Map<string, YtApiItem['statistics'] | undefined>();
  for (const page of chunkItems([...new Set(channelIdByCluster.values())], 50)) {
    const payload = await youtubeApiGet(fetchFn, apiKey, 'channels', {
      part: 'statistics',
      id: page.join(',')
    });
    for (const item of apiItems(payload)) statsByChannel.set(item.id, item.statistics);
  }
  for (const clusterRow of clusterRows) {
    if (channelIdByCluster.has(clusterRow.id)) continue;
    const handle = extractYouTubeHandle(clusterRow.yt_channel_url ?? '');
    if (handle === null) continue;
    try {
      const payload = await youtubeApiGet(fetchFn, apiKey, 'channels', {
        part: 'statistics',
        forHandle: handle
      });
      const item = apiItems(payload)[0];
      if (item !== undefined && item.statistics !== undefined) {
        channelIdByCluster.set(clusterRow.id, item.id);
        statsByChannel.set(item.id, item.statistics);
      }
    } catch {
      // cụm này rơi về quét trình duyệt trong vòng quét chính.
    }
  }

  // 4) Ghi snapshot kênh từ statistics của channelId.
  for (const clusterRow of clusterRows) {
    const channelId = channelIdByCluster.get(clusterRow.id);
    if (channelId === undefined) continue;
    const stats = statsByChannel.get(channelId);
    if (stats === undefined) continue;
    const subscribers = apiNumber(stats.subscriberCount);
    const totalViews = apiNumber(stats.viewCount);
    const videoCount = apiNumber(stats.videoCount);
    let inserted = 0;
    if (subscribers !== null) {
      insertStatsSnapshot(db, { clusterId: clusterRow.id, platform: 'youtube', metric: 'followers', value: subscribers, capturedAt });
      inserted += 1;
    }
    if (totalViews !== null) {
      insertStatsSnapshot(db, { clusterId: clusterRow.id, platform: 'youtube', metric: 'views', value: totalViews, capturedAt });
      inserted += 1;
    }
    if (videoCount !== null) {
      insertStatsSnapshot(db, { clusterId: clusterRow.id, platform: 'youtube', metric: 'videos', value: videoCount, capturedAt });
      inserted += 1;
    }
    if (inserted === 0) continue;
    channelSnapshots += inserted;
    handledClusterIds.push(clusterRow.id);
  }

  return { channelSnapshots, videoSnapshots, handledJobIds, handledClusterIds };
}

// ---------------------------------------------------------------------------
// TikTok qua yt-dlp (flat-playlist — KHÔNG trình duyệt, KHÔNG captcha)
// ---------------------------------------------------------------------------

export type TikTokYtDlpEntry = {
  id: string;
  viewCount: number | null;
};

export type TikTokYtDlpProfile = {
  followers: number | null;
  likes: number | null;
  entries: TikTokYtDlpEntry[];
};

/** Bóc kết quả `--flat-playlist --dump-single-json` của profile TikTok. */
export function parseTikTokYtDlpProfile(payload: unknown): TikTokYtDlpProfile | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const entries = Array.isArray(record.entries) ? record.entries : [];
  return {
    followers: asNumber(record['channel_follower_count']),
    likes: asNumber(record['like_count']),
    entries: entries
      .filter(item => typeof item === 'object' && item !== null)
      .map(item => {
        const entry = item as Record<string, unknown>;
        return {
          id: typeof entry['id'] === 'string' ? entry['id'] : String(entry['id'] ?? ''),
          viewCount: asNumber(entry['view_count'])
        };
      })
      .filter(entry => entry.id !== '')
  };
}

/**
 * yt-dlp cho 1 profile TikTok; trả metrics tổng + per-video khớp job theo
 * `tk_video_id`. Dựng args: proxy là proxy của cụm; runner chịu timeout 60s.
 */
export async function collectTikTokViaYtDlp(
  runYtDlpFn: (args: readonly string[]) => Promise<unknown>,
  cluster: SocialClusterRow,
  profileUrl: string,
  jobRows: SocialJobRow[]
): Promise<{
  followers: number | null;
  likes: number | null;
  perVideo: Array<{ jobId: string; externalVideoId: string; views: number }>;
}> {
  const url = profileUrl.startsWith('http') ? profileUrl : `https://${profileUrl}`;
  const args = ['--flat-playlist', '--dump-single-json', '--encoding', 'utf-8',
    '--skip-download', '--no-warnings', '--socket-timeout', '20', '--playlist-end', '50'];
  if (cluster.proxy_server.trim() !== '') args.push('--proxy', cluster.proxy_server.trim());
  args.push('--', url);
  const profile = parseTikTokYtDlpProfile(await runYtDlpFn(args));
  if (profile === null) throw new Error('yt-dlp TikTok output không đọc được');
  const perVideo: Array<{ jobId: string; externalVideoId: string; views: number }> = [];
  for (const job of jobRows) {
    if (job.cluster_id !== cluster.id || job.tk_status !== 'published') continue;
    const tkVideoId = (job.tk_video_id ?? '').trim();
    if (tkVideoId === '') continue;
    const entry = profile.entries.find(candidate => candidate.id === tkVideoId);
    if (entry === undefined || entry.viewCount === null) continue;
    perVideo.push({ jobId: job.id, externalVideoId: entry.id, views: entry.viewCount });
  }
  return { followers: profile.followers, likes: profile.likes, perVideo };
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
