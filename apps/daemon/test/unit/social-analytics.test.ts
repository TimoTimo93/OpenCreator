/**
 * Kiểm thử GĐ3 — thống kê đa kênh (analytics) + bình luận/AI auto-reply.
 * Dùng trình duyệt giả và fetch giả; không gọi mạng thật.
 */
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSocialAnalytics,
  extractTikTokNumberField,
  extractYouTubeSubscribers,
  parseCompactNumber,
  type SocialAnalytics
} from '../../src/social/analytics.js';
import type { SocialStatsOverview } from '../../src/social/types.js';
import {
  createSocialComments,
  isSpam,
  MAX_AUTO_REPLIES_PER_DAY,
  type SocialComments
} from '../../src/social/comments.js';
import {
  createClusterRow,
  insertJobRow,
  insertStatsSnapshot,
  listCommentRows,
  listStatsHistory,
  openSocialDatabase,
  updateJobRow,
  type SocialDB
} from '../../src/social/db.js';
import { createSocialWorker, type SocialBrowserLauncher } from '../../src/social/worker.js';

let cleanupDirs: string[] = [];
afterEach(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  cleanupDirs = [];
});

function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix)).then(dir => {
    cleanupDirs.push(dir);
    return dir;
  });
}

/** Trang giả của Patchright: trả nội dung HTML định sẵn. */
type FakePageInput = { html?: string; getText?: (url: string) => string };

function fakeBrowserLauncher(input: FakePageInput = {}): SocialBrowserLauncher {
  return async () => ({
    async newPage(url?: string) {
      const urlText = url ?? '';
      return {
        content: async () => (input.getText !== undefined ? input.getText(urlText) : (input.html ?? '')),
        url: () => urlText,
        waitForTimeout: async () => undefined,
        evaluate: async () => [],
        close: async () => undefined
      };
    },
    async close() { /* profile giữ nguyên */ }
  });
}

/** fetch giả định tuyến theo URL. */
function fakeFetch(routes: Array<{
  test: (url: string, method: string) => boolean;
  reply: (url: string, method: string) => { status?: number; body: unknown | string };
}>): typeof fetch {
  return (async (url: string | URL, request?: RequestInit) => {
    const text = typeof url === 'string' ? url : url.toString();
    const method = (request?.method ?? 'GET').toUpperCase();
    for (const route of routes) {
      if (route.test(text, method)) {
        const reply = route.reply(text, method);
        const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
        return new Response(body, { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

type ClusterSeed = {
  id: string;
  name: string;
  fbPageId?: string;
  fbToken?: string | null;
  ytChannelUrl?: string;
  tkProfileUrl?: string;
  proxyServer?: string;
  autoReplyEnabled?: boolean;
  autoReplyPrompt?: string;
};

function seedCluster(db: SocialDB, seed: ClusterSeed): void {
  createClusterRow(db, {
    id: seed.id,
    name: seed.name,
    seriesName: 'Series',
    proxyServer: seed.proxyServer ?? '',
    fbMode: 'graph_api',
    fbPageId: seed.fbPageId ?? '',
    fbPageTokenEncrypted: seed.fbToken === undefined ? null : (seed.fbToken === null ? null : seed.fbToken),
    defaultScheduleTimes: ['19:30'],
    defaultDescription: '',
    ...(seed.ytChannelUrl !== undefined ? { ytChannelUrl: seed.ytChannelUrl } : {}),
    ...(seed.tkProfileUrl !== undefined ? { tkProfileUrl: seed.tkProfileUrl } : {}),
    ...(seed.autoReplyEnabled !== undefined ? { autoReplyEnabled: seed.autoReplyEnabled } : {}),
    ...(seed.autoReplyPrompt !== undefined ? { autoReplyPrompt: seed.autoReplyPrompt } : {}),
    nowISO: '2026-10-19T00:00:00.000Z'
  });
}

// ---------------------------------------------------------------------------
// Migration + helpers
// ---------------------------------------------------------------------------

describe('social db — migrate cộng thêm (GĐ3)', () => {
  it('', async () => {
    const dir = await tempRoot('social-db-old-');
    const dbPath = join(dir, 'social.sqlite');
    // Mô phỏng database schema v1: chỉ có 3 bảng gốc, không có cột mới/bảng stats.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE social_clusters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        series_name TEXT NOT NULL DEFAULT '',
        proxy_server TEXT NOT NULL DEFAULT '',
        proxy_status TEXT NOT NULL DEFAULT 'unchecked',
        proxy_detail TEXT,
        yt_login TEXT NOT NULL DEFAULT 'unknown',
        tk_login TEXT NOT NULL DEFAULT 'unknown',
        fb_login TEXT NOT NULL DEFAULT 'unknown',
        fb_mode TEXT NOT NULL DEFAULT 'graph_api',
        fb_page_id TEXT NOT NULL DEFAULT '',
        fb_page_token_encrypted TEXT,
        default_schedule_times TEXT NOT NULL DEFAULT '["19:30"]',
        default_description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE social_jobs (
        id TEXT PRIMARY KEY,
        cluster_id TEXT NOT NULL,
        cluster_name TEXT NOT NULL DEFAULT '',
        video_path TEXT NOT NULL,
        thumbnail_path TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        scheduled_at TEXT NOT NULL,
        yt_status TEXT NOT NULL DEFAULT 'pending',
        yt_attempts INTEGER NOT NULL DEFAULT 0,
        yt_video_id TEXT,
        yt_error TEXT,
        yt_screenshot TEXT,
        yt_last_attempt_at TEXT,
        tk_status TEXT NOT NULL DEFAULT 'pending',
        tk_attempts INTEGER NOT NULL DEFAULT 0,
        tk_video_id TEXT,
        tk_error TEXT,
        tk_screenshot TEXT,
        tk_last_attempt_at TEXT,
        fb_status TEXT NOT NULL DEFAULT 'pending',
        fb_attempts INTEGER NOT NULL DEFAULT 0,
        fb_video_id TEXT,
        fb_error TEXT,
        fb_screenshot TEXT,
        fb_last_attempt_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE social_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
      INSERT INTO social_clusters(id, name) VALUES ('c1', 'Cụm cũ');
    `);
    legacy.close();

    const reopened = openSocialDatabase(dbPath);
    const clusterColumnNames = (reopened.pragma('table_info(social_clusters)') as Array<{ name: string }>)
      .map(info => info.name);
    expect(clusterColumnNames).toContain('yt_channel_url');
    expect(clusterColumnNames).toContain('tk_profile_url');
    expect(clusterColumnNames).toContain('auto_reply_enabled');
    expect(clusterColumnNames).toContain('auto_reply_prompt');
    // Dữ liệu cũ vẫn đọc được, cột mới rơi về giá trị mặc định.
    reopened.exec("UPDATE social_clusters SET updated_at = '2026-10-19T00:00:00.000Z' WHERE id = 'c1'");
    reopened.close();
  });

  it('', async () => {
    const dir = await tempRoot('social-stats-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = 'cluster_a';
    seedCluster(db, { id: clusterId, name: 'Cụm A' });
    // Hai lần đo: followers tăng 100 → 150.
    db.prepare("INSERT INTO social_stats(cluster_id, platform, metric, value, captured_at) VALUES (?, 'facebook', 'followers', 100, '2026-10-18T08:00:00.000Z')")
      .run(clusterId);
    db.prepare("INSERT INTO social_stats(cluster_id, platform, metric, value, captured_at) VALUES (?, 'facebook', 'followers', 150, '2026-10-19T08:00:00.000Z')")
      .run(clusterId);
    const stats = db.prepare(`
      SELECT value, previous FROM (
        SELECT id, value, captured_at, LAG(value) OVER (ORDER BY id) AS previous
        FROM social_stats WHERE cluster_id = ? AND platform = 'facebook' AND metric = 'followers'
      ) ORDER BY id DESC LIMIT 1
    `).get(clusterId) as { value: number; previous: number | null };
    expect(stats.value).toBe(150);
    expect(stats.previous).toBe(100);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// listStatsHistory — lịch sử điểm đo cho sparkline (B1: biểu đồ xu hướng)
// ---------------------------------------------------------------------------

function insertHistoryPoint(
  db: SocialDB,
  clusterId: string,
  platform: string,
  metric: string,
  value: number,
  capturedAt: string
): void {
  insertStatsSnapshot(db, { clusterId, platform, metric, value, capturedAt });
}

describe('listStatsHistory — lọc + thứ tự + limit', () => {
  it('lọc theo cụm/nền tảng/metric, trả điểm tăng dần theo captured_at', async () => {
    const dir = await tempRoot('social-history-filter-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    seedCluster(db, { id: 'cluster_a', name: 'Cụm A' });
    seedCluster(db, { id: 'cluster_b', name: 'Cụm B' });
    insertHistoryPoint(db, 'cluster_a', 'facebook', 'followers', 100, '2026-10-16T08:00:00.000Z');
    insertHistoryPoint(db, 'cluster_a', 'facebook', 'followers', 150, '2026-10-17T08:00:00.000Z');
    insertHistoryPoint(db, 'cluster_a', 'facebook', 'followers', 120, '2026-10-18T08:00:00.000Z');
    insertHistoryPoint(db, 'cluster_b', 'facebook', 'followers', 900, '2026-10-18T09:00:00.000Z');
    insertHistoryPoint(db, 'cluster_a', 'youtube', 'followers', 42, '2026-10-18T10:00:00.000Z');
    insertHistoryPoint(db, 'cluster_a', 'facebook', 'views', 7, '2026-10-18T11:00:00.000Z');

    // Lọc cụm + nền tảng + metric: chỉ 3 điểm followers Facebook của cluster_a.
    const history = listStatsHistory(db, {
      clusterId: 'cluster_a', platform: 'facebook', metric: 'followers'
    });
    expect(history.map(row => `${row.value}@${row.captured_at}`)).toEqual([
      '100@2026-10-16T08:00:00.000Z',
      '150@2026-10-17T08:00:00.000Z',
      '120@2026-10-18T08:00:00.000Z'
    ]);

    // Lọc cụm + metric (bỏ nền tảng): cả facebook + youtube của cluster_a,
    // nhóm theo chuỗi, vẫn tăng dần trong từng nhóm.
    const mixed = listStatsHistory(db, { clusterId: 'cluster_a', metric: 'followers' });
    expect(mixed.map(row => row.platform)).toEqual(['facebook', 'facebook', 'facebook', 'youtube']);
    expect(mixed.map(row => row.value)).toEqual([100, 150, 120, 42]);
    db.close();
  });

  it('limit: mặc định 30, chặn trần 120, sàn 1', async () => {
    const dir = await tempRoot('social-history-limit-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    seedCluster(db, { id: 'cluster_a', name: 'Cụm A' });
    for (let index = 0; index < 130; index += 1) {
      insertHistoryPoint(
        db, 'cluster_a', 'facebook', 'followers', index,
        new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString()
      );
    }
    // Mặc định: 30 điểm gần nhất, tăng dần (cũ nhất trước).
    const byDefault = listStatsHistory(db);
    expect(byDefault).toHaveLength(30);
    expect(byDefault[0]?.value).toBe(100);
    expect(byDefault[byDefault.length - 1]?.value).toBe(129);
    // Trần 120: vượt 999 → chỉ lấy 120 điểm gần nhất.
    const clamped = listStatsHistory(db, { limit: 999 });
    expect(clamped).toHaveLength(120);
    expect(clamped[0]?.value).toBe(10);
    expect(clamped[clamped.length - 1]?.value).toBe(129);
    // Sàn 1: limit 0 → 1 điểm mới nhất.
    const floor = listStatsHistory(db, { limit: 0 });
    expect(floor).toHaveLength(1);
    expect(floor[0]?.value).toBe(129);
    db.close();
  });
});

describe('analytics.getStats — gắn history followers/views cho sparkline', () => {
  it('chỉ gắn 2 metric chính của các chuỗi có điểm, bỏ qua likes', async () => {
    const dir = await tempRoot('social-history-overview-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    seedCluster(db, { id: 'cluster_a', name: 'Cụm A' });
    insertHistoryPoint(db, 'cluster_a', 'facebook', 'followers', 100, '2026-10-16T08:00:00.000Z');
    insertHistoryPoint(db, 'cluster_a', 'facebook', 'followers', 150, '2026-10-17T08:00:00.000Z');
    insertHistoryPoint(db, 'cluster_a', 'tiktok', 'views', 5000, '2026-10-17T09:00:00.000Z');
    insertHistoryPoint(db, 'cluster_a', 'tiktok', 'views', 6200, '2026-10-18T09:00:00.000Z');
    insertHistoryPoint(db, 'cluster_a', 'tiktok', 'likes', 77, '2026-10-18T09:00:00.000Z');

    const analytics = createSocialAnalytics({
      db,
      worker: {} as never,
      decryptToken: () => '',
      refreshIntervalMs: 0
    });
    const overview: SocialStatsOverview = analytics.getStats();
    expect(overview.history).toEqual([
      {
        clusterId: 'cluster_a', platform: 'facebook', metric: 'followers',
        points: [
          { value: 100, capturedAt: '2026-10-16T08:00:00.000Z' },
          { value: 150, capturedAt: '2026-10-17T08:00:00.000Z' }
        ]
      },
      {
        clusterId: 'cluster_a', platform: 'tiktok', metric: 'views',
        points: [
          { value: 5000, capturedAt: '2026-10-17T09:00:00.000Z' },
          { value: 6200, capturedAt: '2026-10-18T09:00:00.000Z' }
        ]
      }
    ]);
    analytics.close();
    db.close();
  });
});

describe('social analytics — parser thuần', () => {
  it('', () => {
    expect(parseCompactNumber('1,2 N người đăng ký')).toBe(1200);
    expect(parseCompactNumber('12K subscribers')).toBe(12_000);
    expect(parseCompactNumber('1.2M')).toBe(1_200_000);
    expect(parseCompactNumber('123')).toBe(123);
    expect(parseCompactNumber('')).toBeNull();
    expect(parseCompactNumber(undefined)).toBeNull();
  });

  it('', () => {
    expect(extractYouTubeSubscribers('x"subscriberCountText":{"accessibility":{},"simpleText":"1,2 N người đăng ký"}y')).toBe(1200);
    expect(extractYouTubeSubscribers('no data')).toBeNull();
    expect(extractTikTokNumberField('{"followerCount":12345,"likesCount":998877}', 'followerCount')).toBe(12345);
    expect(extractTikTokNumberField('{"bio":"no numbers"}', 'followerCount')).toBeNull();
  });
});

describe('social analytics — refresh với Graph API giả + trình duyệt giả', () => {
  it('', async () => {
    const dir = await tempRoot('social-analytics-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = 'cluster_fb';
    seedCluster(db, { id: clusterId, name: 'Cụm FB', fbPageId: '111', fbToken: 'page-token' });
    insertJobRow(db, {
      id: 'job1', clusterId, clusterName: 'Cụm FB', videoPath: 'D:/v.mp4', thumbnailPath: null,
      title: 'Tập 1', description: '', scheduledAt: '2026-10-19T08:00:00.000Z', nowISO: '2026-10-19T08:00:00.000Z'
    });
    updateJobRow(db, 'job1', { fb_status: 'published', fb_video_id: 'vid_fb_1', updated_at: '2026-10-19T08:30:00.000Z' });

    const fetchMock = fakeFetch([
      {
        test: url => url.includes('/111?fields=followers_count'),
        reply: () => ({ body: { followers_count: 4567 } })
      },
      {
        test: url => url.includes('/vid_fb_1/video_insights'),
        reply: () => ({ body: { data: [{ name: 'total_video_views', values: [{ value: 8271 }] }] } })
      }
    ]);

    const worker = createSocialWorker({ tickIntervalMs: 0 });
    const analytics: SocialAnalytics = createSocialAnalytics({
      db,
      worker,
      decryptToken: () => 'page-token',
      refreshIntervalMs: 0,
      fetchFn: fetchMock,
      now: () => '2026-10-19T12:00:00.000Z',
      log: () => undefined
    });

    const result = await analytics.refresh();
    expect(result.clustersScanned).toBe(1);
    expect(result.channelSnapshots).toBe(1);

    const overview = analytics.getStats();
    const fbChannel = overview.channels.find(entry => entry.platform === 'facebook');
    expect(fbChannel?.metrics.followers?.value).toBe(4567);
    const fbVideo = overview.videos.find(entry => entry.platform === 'facebook');
    expect(fbVideo?.views).toBe(8271);
    analytics.close();
    db.close();
  });

  it('', async () => {
    const dir = await tempRoot('social-analytics-yt-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = 'cluster_yt';
    seedCluster(db, { id: clusterId, name: 'Cụm YT', ytChannelUrl: 'https://www.youtube.com/@kenhphim' });
    const worker = createSocialWorker({ tickIntervalMs: 0, browserLauncher: fakeBrowserLauncher({
      getText: url => url.includes('youtube.com/@')
        ? 'html "subscriberCountText":{"simpleText":"2,3 N người đăng ký"} html'
        : ''
    }) });
    // withClusterBrowser cần db đã bind vào worker.
    worker.bind({
      db,
      screenshotDir: join(dir, 'screenshots'),
      profileRoot: join(dir, 'profiles'),
      decryptToken: () => ''
    });

    const analytics = createSocialAnalytics({
      db, worker,
      decryptToken: () => '',
      refreshIntervalMs: 0,
      fetchFn: fakeFetch([]),
      now: () => '2026-10-19T12:00:00.000Z',
      log: () => undefined
    });

    await analytics.refresh();
    const yt = analytics.getStats().channels.find(entry => entry.platform === 'youtube');
    expect(yt?.metrics.followers?.value).toBe(2300);
    analytics.close();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// YouTube Data API (tùy chọn) + TikTok yt-dlp
// ---------------------------------------------------------------------------

function metricsFor(analytics: SocialAnalytics, platform: 'youtube' | 'tiktok'): SocialStatsOverview['channels'] {
  return analytics.getStats().channels.filter(entry => entry.platform === platform);
}

function aggregateChannelMetrics(channels: SocialStatsOverview['channels']): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const channel of channels) {
    for (const [name, point] of Object.entries(channel.metrics)) {
      out[name] = point?.value;
    }
  }
  return out;
}


describe('social analytics — YouTube Data API batch + TikTok yt-dlp', () => {
  it('có key → channels.list + videos.list, không mở trình duyệt', async () => {
    const dir = await tempRoot('social-analytics-ytapi-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = 'cluster_yt_api';
    seedCluster(db, { id: clusterId, name: 'Cụm YT API', ytChannelUrl: 'https://www.youtube.com/@kenhapi' });
    insertJobRow(db, {
      id: 'jobyt', clusterId, clusterName: 'Cụm YT API', videoPath: 'D:/v.mp4', thumbnailPath: null,
      title: 'Tập 1', description: '', scheduledAt: '2026-10-19T08:00:00.000Z', nowISO: '2026-10-19T08:00:00.000Z'
    });
    updateJobRow(db, 'jobyt', { yt_status: 'published', yt_video_id: 'vid_yt_1', updated_at: '2026-10-19T08:30:00.000Z' });

    const ytUrls: string[] = [];
    const fetchMock = fakeFetch([
      {
        test: url => url.includes('googleapis.com/youtube/v3/videos'),
        reply: url => {
          ytUrls.push(url);
          return { body: { items: [{ id: 'vid_yt_1', channelId: 'UCabc123', statistics: { viewCount: '3210' } }] } };
        }
      },
      {
        test: url => url.includes('googleapis.com/youtube/v3/channels'),
        reply: url => {
          ytUrls.push(url);
          return { body: { items: [{ id: 'UCabc123', statistics: { subscriberCount: '999', viewCount: '120000', videoCount: '42' } }] } };
        }
      }
    ]);

    // Launcher ném lỗi — với key đúng thì analytics không được chạm trình duyệt.
    const worker = createSocialWorker({
      tickIntervalMs: 0,
      browserLauncher: async () => { throw new Error('browser must not be used when API key is configured'); }
    });
    worker.bind({ db, screenshotDir: join(dir, 'ss'), profileRoot: join(dir, 'pf'), decryptToken: () => '' });

    const analytics = createSocialAnalytics({
      db, worker,
      decryptToken: () => '',
      refreshIntervalMs: 0,
      fetchFn: fetchMock,
      readYoutubeApiKey: () => 'testkey123',
      now: () => '2026-10-19T12:00:00.000Z',
      log: () => undefined
    });
    const result = await analytics.refresh();
    // Không có lỗi quét youtube không trình duyệt.
    expect(result.errors.filter(text => text.includes('youtube'))).toEqual([]);

    const channel = aggregateChannelMetrics(metricsFor(analytics, 'youtube'));
    expect(channel.followers).toBe(999);
    expect(channel.views).toBe(120_000);
    expect(channel.videos).toBe(42);
    const video = analytics.getStats().videos.find(entry => entry.platform === 'youtube');
    expect(video?.views).toBe(3210);
    // Batch: 1 fetch videos + 1 fetch channels (channelId biết qua videos.list).
    expect(ytUrls.filter(url => url.includes('/videos?')).length).toBe(1);
    expect(ytUrls.filter(url => url.includes('/channels?')).length).toBe(1);
    expect(ytUrls.join('|')).toContain('key=testkey123');
    // Không rơi vào forHandle vì videos.list đã cho channelId.
    expect(ytUrls.join('|')).not.toContain('forHandle');
    analytics.close();
    db.close();
  });

  it('không key → fallback quét trình duyệt (giữ nguyên collector cũ)', async () => {
    const dir = await tempRoot('social-analytics-ytnokey-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    seedCluster(db, { id: 'cluster_yt_fb', name: 'Cụm YT fb', ytChannelUrl: 'https://www.youtube.com/@kenh' });
    const worker = createSocialWorker({ tickIntervalMs: 0, browserLauncher: fakeBrowserLauncher({
      getText: url => url.includes('youtube.com/@') ? 'html "subscriberCountText":{"simpleText":"5K subscribers"}' : ''
    }) });
    worker.bind({ db, screenshotDir: join(dir, 'ss'), profileRoot: join(dir, 'pf'), decryptToken: () => '' });
    const analytics = createSocialAnalytics({
      db, worker, decryptToken: () => '', refreshIntervalMs: 0,
      fetchFn: fakeFetch([]), readYoutubeApiKey: () => '', now: () => '2026-10-19T12:00:00.000Z', log: () => undefined
    });
    await analytics.refresh();
    expect(analytics.getStats().channels.find(entry => entry.platform === 'youtube')?.metrics.followers?.value).toBe(5000);
    analytics.close();
    db.close();
  });

  it('TikTok: ưu tiên yt-dlp — args đúng proxy + khớp tk_video_id cho per-video views', async () => {
    const dir = await tempRoot('social-analytics-tkdlp-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = 'cluster_tk';
    seedCluster(db, { id: clusterId, name: 'Cụm TikTok', tkProfileUrl: 'https://www.tiktok.com/@user', proxyServer: 'http://1.2.3.4:8080' });
    insertJobRow(db, {
      id: 'jobtk', clusterId, clusterName: 'Cụm TikTok', videoPath: 'D:/v.mp4', thumbnailPath: null,
      title: 'Tập 1', description: '', scheduledAt: '2026-10-19T08:00:00.000Z', nowISO: '2026-10-19T08:00:00.000Z'
    });
    updateJobRow(db, 'jobtk', { tk_status: 'published', tk_video_id: '7411111111111111111', updated_at: '2026-10-19T08:30:00.000Z' });

    const worker = createSocialWorker({
      tickIntervalMs: 0,
      browserLauncher: async () => { throw new Error('browser must not be used when yt-dlp succeeds'); }
    });
    worker.bind({ db, screenshotDir: join(dir, 'ss'), profileRoot: join(dir, 'pf'), decryptToken: () => '' });

    const seenArgs: string[][] = [];
    const analytics = createSocialAnalytics({
      db, worker, decryptToken: () => '', refreshIntervalMs: 0,
      fetchFn: fakeFetch([]),
      runYtDlpFn: async args => {
        seenArgs.push([...args]);
        return {
          channel_follower_count: 777,
          like_count: 8_888,
          entries: [
            { id: '7411111111111111111', view_count: 1234 },
            { id: '999_111', view_count: 5 }
          ]
        };
      },
      now: () => '2026-10-19T12:00:00.000Z',
      log: () => undefined
    });
    const result = await analytics.refresh();
    expect(result.errors).toEqual([]);

    const args = seenArgs[0]!;
    expect(args).toContain('--flat-playlist');
    expect(args).toContain('--dump-single-json');
    // Proxy của cụm được mang vào; URL dạng https.
    const proxyIndex = args.indexOf('--proxy');
    expect(args[proxyIndex + 1]).toBe('http://1.2.3.4:8080');

    const tk = aggregateChannelMetrics(metricsFor(analytics, 'tiktok'));
    expect(tk.followers).toBe(777);
    expect(tk.likes).toBe(8888);
    // Per-video khớp theo tk_video_id của job đã đăng.
    const tkVideo = analytics.getStats().videos.find(entry => entry.platform === 'tiktok');
    expect(tkVideo?.jobId).toBe('jobtk');
    expect(tkVideo?.externalVideoId).toBe('7411111111111111111');
    expect(tkVideo?.views).toBe(1234);
    analytics.close();
    db.close();
  });

  it('TikTok: yt-dlp lỗi → fallback quét trình duyệt', async () => {
    const dir = await tempRoot('social-analytics-tkfb-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    seedCluster(db, { id: 'cluster_tk2', name: 'Cụm TikTok 2', tkProfileUrl: 'tiktok.com/@user2' });
    const worker = createSocialWorker({ tickIntervalMs: 0, browserLauncher: fakeBrowserLauncher({
      getText: url => url.includes('tiktok.com/@') ? 'html {"followerCount":12345,"likesCount":100} html' : ''
    }) });
    worker.bind({ db, screenshotDir: join(dir, 'ss'), profileRoot: join(dir, 'pf'), decryptToken: () => '' });
    const analytics = createSocialAnalytics({
      db, worker, decryptToken: () => '', refreshIntervalMs: 0,
      fetchFn: fakeFetch([]),
      runYtDlpFn: async () => { throw new Error('yt-dlp crashed'); },
      now: () => '2026-10-19T12:00:00.000Z',
      log: () => undefined
    });
    await analytics.refresh();
    const tk = analytics.getStats().channels.find(entry => entry.platform === 'tiktok');
    expect(tk?.metrics.followers?.value).toBe(12345);
    analytics.close();
    db.close();
  });
});

describe('social comments — quét + AI trả lời (fetch giả)', () => {  it('', async () => {
    const dir = await tempRoot('social-comments-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = 'cluster_c1';
    seedCluster(db, {
      id: clusterId, name: 'Cụm C1', fbPageId: '111', fbToken: 'page-token', autoReplyEnabled: true
    });
    insertJobRow(db, {
      id: 'job1', clusterId, clusterName: 'Cụm C1', videoPath: 'D:/v.mp4', thumbnailPath: null,
      title: 'Tập 1', description: '', scheduledAt: '2026-10-19T08:00:00.000Z', nowISO: '2026-10-19T08:00:00.000Z'
    });
    updateJobRow(db, 'job1', { fb_status: 'published', fb_video_id: 'vid_fb_1', updated_at: '2026-10-19T08:30:00.000Z' });

    const postedReplies: string[] = [];
    const fetchMock = fakeFetch([
      {
        test: url => url.includes('/vid_fb_1/comments') && url.includes('GET') === false,
        reply: () => ({ body: { data: [
          { id: 'cmt_deluxe_1', message: 'Tập 17 hay quá!', created_time: '2026-10-19T05:00:00Z', from: { name: 'Mai' } },
          { id: 'cmt_2', message: 'Theo dõi kenh sale hot xong giảm giá ngay', from: { name: 'Ads' } }
        ] } })
      },
      {
        test: (url, method) => method === 'GET' && url.includes('/vid_fb_1/comments'),
        reply: () => ({ body: { data: [
          { id: 'cmt_deluxe_1', message: 'Tập 17 hay quá!', created_time: '2026-10-19T05:00:00Z', from: { name: 'Mai' } },
          { id: 'cmt_2', message: 'sale hot', from: { name: 'Ads' } }
        ] } })
      },
      {
        test: (url, method) => method === 'POST' && url.includes('/cmt_deluxe_1/comments'),
        reply: (url) => {
          postedReplies.push(url);
          return { body: { id: 'reply_1' } };
        }
      },
      {
        test: (url, method) => method === 'GET' && url.includes('graph.facebook'),
        reply: () => ({ body: { data: [] } })
      }
    ]);

    const worker = createSocialWorker({ tickIntervalMs: 0 });
    const comments: SocialComments = createSocialComments({
      db,
      worker,
      // Token đã "mã hóa" ở seed → decrypt trả lại nguyên bản.
      decryptToken: token => token ?? '',
      readLlmConfig: async () => null, // không LLM → dùng mẫu mặc định
      scanIntervalMs: 0,
      fetchFn: fetchMock,
      now: () => '2026-10-19T12:00:00.000Z',
      log: () => undefined
    });

    const result = await comments.scan(clusterId);
    expect(result.newComments).toBe(2);
    // Comment sạch được trả lời qua Graph; comment spam bị skip.
    expect(result.repliesAttempted).toBeGreaterThanOrEqual(1);
    expect(result.repliesSent).toBeGreaterThanOrEqual(1);
    expect(postedReplies[0]).toContain('/cmt_deluxe_1/comments');
    const rows = listCommentRows(db, { clusterId });
    const replied = rows.find(row => row.external_comment_id === 'cmt_deluxe_1');
    expect(replied?.reply_status).toBe('sent');
    expect(replied?.reply_text?.length).toBeGreaterThan(0);
    const skipped = rows.find(row => row.external_comment_id === 'cmt_2');
    expect(skipped?.reply_status).toBe('skipped');
    comments.close();
    db.close();
  });
});

describe('social comments — guardrails', () => {
  it('', () => {
    expect(isSpam('Liên hệ hotline 09xx để quảng cáo')).toBe(true);
    expect(isSpam('Tập 17 quá hay, cám ơn kênh')).toBe(false);
    expect(isSpam('https://spam.example.com')).toBe(true);
    expect(isSpam('x'.repeat(600))).toBe(true);
  });
  it('cap reply/ngày được xuất hằng số', () => {
    expect(MAX_AUTO_REPLIES_PER_DAY).toBeGreaterThan(0);
  });
});
