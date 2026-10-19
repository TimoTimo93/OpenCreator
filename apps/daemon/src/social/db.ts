/**
 * Lưu trữ Social Automation: SQLite riêng `<dataDir>/social.sqlite` (WAL).
 * Không đụng migrations toàn cục — schema tạo ngay khi mở db.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type SocialCluster, type SocialFacebookMode, type SocialJob, type SocialPlatform, type SocialPlatformState } from './types.js';
import { normalizeDatabaseTimestamp } from '../storage/database.js';

export type SocialDB = Database.Database;

const CLUSTER_COLUMNS = [
  'id', 'name', 'series_name', 'proxy_server', 'proxy_status', 'proxy_detail',
  'yt_login', 'tk_login', 'fb_login', 'fb_mode', 'fb_page_id', 'fb_page_token_encrypted',
  'default_schedule_times', 'default_description', 'created_at', 'updated_at'
] as const;

const JOB_COLUMNS = [
  'id', 'cluster_id', 'cluster_name', 'video_path', 'thumbnail_path', 'title', 'description',
  'scheduled_at', 'yt_status', 'yt_attempts', 'yt_video_id', 'yt_error', 'yt_screenshot', 'yt_last_attempt_at',
  'tk_status', 'tk_attempts', 'tk_video_id', 'tk_error', 'tk_screenshot', 'tk_last_attempt_at',
  'fb_status', 'fb_attempts', 'fb_video_id', 'fb_error', 'fb_screenshot', 'fb_last_attempt_at',
  'created_at', 'updated_at'
] as const;

export function openSocialDatabase(path: string): SocialDB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path) as SocialDB;
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_clusters (
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

    CREATE TABLE IF NOT EXISTS social_jobs (
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

    CREATE INDEX IF NOT EXISTS idx_social_jobs_cluster ON social_jobs(cluster_id, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_social_jobs_scheduled ON social_jobs(scheduled_at, yt_status);

    CREATE TABLE IF NOT EXISTS social_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

export function closeSocialDatabase(db: SocialDB): void {
  const raw = db as unknown as { close(): void };
  raw.close();
}

// ---------------------------------------------------------------------------
// KV (queue state: paused/running...)
// ---------------------------------------------------------------------------

export function kvGet(db: SocialDB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM social_kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(db: SocialDB, key: string, value: string): void {
  db.prepare(`
    INSERT INTO social_kv(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

export type SocialClusterRow = {
  id: string;
  name: string;
  series_name: string;
  proxy_server: string;
  proxy_status: string;
  proxy_detail: string | null;
  yt_login: string;
  tk_login: string;
  fb_login: string;
  fb_mode: string;
  fb_page_id: string;
  fb_page_token_encrypted: string | null;
  default_schedule_times: string;
  default_description: string;
  created_at: string;
  updated_at: string;
};

export type SocialJobRow = {
  id: string;
  cluster_id: string;
  cluster_name: string;
  video_path: string;
  thumbnail_path: string | null;
  title: string;
  description: string;
  scheduled_at: string;
  yt_status: string;
  yt_attempts: number;
  yt_video_id: string | null;
  yt_error: string | null;
  yt_screenshot: string | null;
  yt_last_attempt_at: string | null;
  tk_status: string;
  tk_attempts: number;
  tk_video_id: string | null;
  tk_error: string | null;
  tk_screenshot: string | null;
  tk_last_attempt_at: string | null;
  fb_status: string;
  fb_attempts: number;
  fb_video_id: string | null;
  fb_error: string | null;
  fb_screenshot: string | null;
  fb_last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
};

export function normalizeScheduledTimestamp(value: string): string {
  // scheduled_at lưu dạng ISO trên API; nếu đến từ SQLite chuẩn UTC thì hóa lại chuỗi.
  return normalizeDatabaseTimestamp(value);
}

export function mapCluster(row: SocialClusterRow): SocialCluster {
  let times: string[] = ['19:30'];
  try {
    const parsed: unknown = JSON.parse(row.default_schedule_times);
    if (Array.isArray(parsed)) times = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    // giữ mặc định
  }
  return {
    id: row.id,
    name: row.name,
    seriesName: row.series_name,
    proxyServer: row.proxy_server,
    proxyStatus: (row.proxy_status as SocialCluster['proxyStatus']) ?? 'unchecked',
    proxyDetail: row.proxy_detail,
    loginStatus: {
      youtube: (row.yt_login as SocialClusterLoginValue) ?? 'unknown',
      tiktok: (row.tk_login as SocialClusterLoginValue) ?? 'unknown',
      facebook: (row.fb_login as SocialClusterLoginValue) ?? 'unknown'
    },
    fbMode: (row.fb_mode as SocialFacebookMode) ?? 'graph_api',
    fbPageId: row.fb_page_id,
    fbPageTokenEncrypted: row.fb_page_token_encrypted,
    defaultScheduleTimes: times,
    defaultDescription: row.default_description,
    createdAt: normalizeDatabaseTimestamp(row.created_at),
    updatedAt: normalizeDatabaseTimestamp(row.updated_at)
  };
}

type SocialClusterLoginValue = SocialCluster['loginStatus']['youtube'];

export function mapJob(row: SocialJobRow): SocialJob {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    clusterName: row.cluster_name,
    videoPath: row.video_path,
    thumbnailPath: row.thumbnail_path,
    title: row.title,
    description: row.description,
    scheduledAt: normalizeDatabaseTimestamp(row.scheduled_at),
    platforms: {
      youtube: mapPlatform(row, SocialJobRowHints.youtube),
      tiktok: mapPlatform(row, SocialJobRowHints.tiktok),
      facebook: mapPlatform(row, SocialJobRowHints.facebook)
    },
    createdAt: normalizeDatabaseTimestamp(row.created_at),
    updatedAt: normalizeDatabaseTimestamp(row.updated_at)
  };
}

const SocialJobRowHints = {
  youtube: { prefix: 'yt', status: 'yt_status', attempts: 'yt_attempts', videoId: 'yt_video_id', error: 'yt_error', screenshot: 'yt_screenshot', lastAttemptAt: 'yt_last_attempt_at' },
  tiktok: { prefix: 'tk', status: 'tk_status', attempts: 'tk_attempts', videoId: 'tk_video_id', error: 'tk_error', screenshot: 'tk_screenshot', lastAttemptAt: 'tk_last_attempt_at' },
  facebook: { prefix: 'fb', status: 'fb_status', attempts: 'fb_attempts', videoId: 'fb_video_id', error: 'fb_error', screenshot: 'fb_screenshot', lastAttemptAt: 'fb_last_attempt_at' }
} as const satisfies Record<SocialPlatform, Record<string, string>>;

function mapPlatform(row: SocialJobRow, hints: { status: string; attempts: string; videoId: string; error: string; screenshot: string; lastAttemptAt: string }): SocialPlatformState {
  const record = row as unknown as Record<string, unknown>;
  return {
    status: record[hints.status] as SocialPlatformState['status'],
    attempts: record[hints.attempts] as number,
    videoId: record[hints.videoId] as string | null,
    error: record[hints.error] as string | null,
    screenshotPath: record[hints.screenshot] as string | null,
    lastAttemptAt: record[hints.lastAttemptAt] === null ? null : normalizeDatabaseTimestamp(record[hints.lastAttemptAt] as string)
  };
}

const PLATFORM_HINTS: Record<SocialPlatform, { status: string; attempts: string; videoId: string; error: string; screenshot: string; lastAttemptAt: string }> = {
  youtube: { status: 'yt_status', attempts: 'yt_attempts', videoId: 'yt_video_id', error: 'yt_error', screenshot: 'yt_screenshot', lastAttemptAt: 'yt_last_attempt_at' },
  tiktok: { status: 'tk_status', attempts: 'tk_attempts', videoId: 'tk_video_id', error: 'tk_error', screenshot: 'tk_screenshot', lastAttemptAt: 'tk_last_attempt_at' },
  facebook: { status: 'fb_status', attempts: 'fb_attempts', videoId: 'fb_video_id', error: 'fb_error', screenshot: 'fb_screenshot', lastAttemptAt: 'fb_last_attempt_at' }
};

// ---------------------------------------------------------------------------
// CRUD clusters
// ---------------------------------------------------------------------------

export function createClusterRow(
  db: SocialDB,
  data: {
    id: string;
    name: string;
    seriesName: string;
    proxyServer: string;
    fbMode: SocialFacebookMode;
    fbPageId: string;
    fbPageTokenEncrypted: string | null;
    defaultScheduleTimes: string[];
    defaultDescription: string;
    nowISO: string;
  }
): SocialClusterRow {
  const row: SocialClusterRow = {
    id: data.id,
    name: data.name,
    series_name: data.seriesName,
    proxy_server: data.proxyServer,
    proxy_status: data.proxyServer.trim() === '' ? 'no_proxy' : 'unchecked',
    proxy_detail: null,
    yt_login: 'unknown',
    tk_login: 'unknown',
    fb_login: 'unknown',
    fb_mode: data.fbMode,
    fb_page_id: data.fbPageId,
    fb_page_token_encrypted: data.fbPageTokenEncrypted,
    default_schedule_times: JSON.stringify(data.defaultScheduleTimes.length > 0 ? data.defaultScheduleTimes : ['19:30']),
    default_description: data.defaultDescription,
    created_at: data.nowISO,
    updated_at: data.nowISO
  };
  db.prepare(`
    INSERT INTO social_clusters(
      id, name, series_name, proxy_server, proxy_status, proxy_detail,
      yt_login, tk_login, fb_login, fb_mode, fb_page_id, fb_page_token_encrypted,
      default_schedule_times, default_description, created_at, updated_at
    ) VALUES (
      @id, @name, @series_name, @proxy_server, @proxy_status, @proxy_detail,
      @yt_login, @tk_login, @fb_login, @fb_mode, @fb_page_id, @fb_page_token_encrypted,
      @default_schedule_times, @default_description, @created_at, @updated_at
    )
  `).run(row);
  return row;
}

export function listClusterRows(db: SocialDB): SocialClusterRow[] {
  return db.prepare(`SELECT * FROM social_clusters ORDER BY created_at ASC, id ASC`).all() as SocialClusterRow[];
}

export function getClusterRow(db: SocialDB, id: string): SocialClusterRow | undefined {
  return db.prepare('SELECT * FROM social_clusters WHERE id = ?').get(id) as SocialClusterRow | undefined;
}

export function updateClusterRow(
  db: SocialDB,
  id: string,
  patch: Partial<{
    name: string;
    series_name: string;
    proxy_server: string;
    proxy_status: string;
    proxy_detail: string | null;
    yt_login: string;
    tk_login: string;
    fb_login: string;
    fb_mode: string;
    fb_page_id: string;
    fb_page_token_encrypted: string | null;
    default_schedule_times: string;
    default_description: string;
    updated_at: string;
  }>
): SocialClusterRow | undefined {
  const keys = Object.keys(patch);
  if (keys.length === 0) return getClusterRow(db, id);
  const assignment = keys.map(key => `${key} = @${key}`).join(', ');
  const params: Record<string, unknown> = { ...patch, id };
  const updated = db.prepare(`
    UPDATE social_clusters SET ${assignment} WHERE id = @id
  `).run(params);
  if (updated.changes === 0) return undefined;
  return getClusterRow(db, id);
}

export function deleteClusterRow(db: SocialDB, id: string): boolean {
  const result = db.prepare('DELETE FROM social_clusters WHERE id = ?').run(id);
  db.prepare('DELETE FROM social_jobs WHERE cluster_id = ?').run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// CRUD jobs
// ---------------------------------------------------------------------------

export function insertJobRow(
  db: SocialDB,
  data: {
    id: string;
    clusterId: string;
    clusterName: string;
    videoPath: string;
    thumbnailPath: string | null;
    title: string;
    description: string;
    scheduledAt: string;
    nowISO: string;
  }
): SocialJobRow {
  const row: SocialJobRow = {
    id: data.id,
    cluster_id: data.clusterId,
    cluster_name: data.clusterName,
    video_path: data.videoPath,
    thumbnail_path: data.thumbnailPath,
    title: data.title,
    description: data.description,
    scheduled_at: data.scheduledAt,
    yt_status: 'pending', yt_attempts: 0, yt_video_id: null, yt_error: null, yt_screenshot: null, yt_last_attempt_at: null,
    tk_status: 'pending', tk_attempts: 0, tk_video_id: null, tk_error: null, tk_screenshot: null, tk_last_attempt_at: null,
    fb_status: 'pending', fb_attempts: 0, fb_video_id: null, fb_error: null, fb_screenshot: null, fb_last_attempt_at: null,
    created_at: data.nowISO,
    updated_at: data.nowISO
  };
  db.prepare(`
    INSERT INTO social_jobs (
      id, cluster_id, cluster_name, video_path, thumbnail_path, title, description, scheduled_at,
      yt_status, yt_attempts, yt_video_id, yt_error, yt_screenshot, yt_last_attempt_at,
      tk_status, tk_attempts, tk_video_id, tk_error, tk_screenshot, tk_last_attempt_at,
      fb_status, fb_attempts, fb_video_id, fb_error, fb_screenshot, fb_last_attempt_at,
      created_at, updated_at
    ) VALUES (
      @id, @cluster_id, @cluster_name, @video_path, @thumbnail_path, @title, @description, @scheduled_at,
      @yt_status, @yt_attempts, @yt_video_id, @yt_error, @yt_screenshot, @yt_last_attempt_at,
      @tk_status, @tk_attempts, @tk_video_id, @tk_error, @tk_screenshot, @tk_last_attempt_at,
      @fb_status, @fb_attempts, @fb_video_id, @fb_error, @fb_screenshot, @fb_last_attempt_at,
      @created_at, @updated_at
    )
  `).run(row);
  return row;
}

export function listJobRows(db: SocialDB): SocialJobRow[] {
  return db.prepare('SELECT * FROM social_jobs ORDER BY scheduled_at ASC, created_at ASC').all() as SocialJobRow[];
}

export function getJobRow(db: SocialDB, id: string): SocialJobRow | undefined {
  return db.prepare('SELECT * FROM social_jobs WHERE id = ?').get(id) as SocialJobRow | undefined;
}

/** Tìm job chưa hoàn thành cùng cụm và cùng file video (dedupe enqueue). */
export function findActiveDuplicateJob(db: SocialDB, clusterId: string, videoPath: string): SocialJobRow | undefined {
  return db.prepare(`
    SELECT * FROM social_jobs
    WHERE cluster_id = ? AND video_path = ?
      AND (yt_status IN ('pending', 'running', 'failed', 'scheduled')
        OR tk_status IN ('pending', 'running', 'failed', 'scheduled')
        OR fb_status IN ('pending', 'running', 'failed', 'scheduled'))
    ORDER BY scheduled_at ASC LIMIT 1
  `).get(clusterId, videoPath) as SocialJobRow | undefined;
}

export type JobPatch = Partial<{
  scheduled_at: string;
  cluster_name: string;
  yt_status: string; yt_attempts: number; yt_video_id: string | null; yt_error: string | null; yt_screenshot: string | null; yt_last_attempt_at: string | null;
  tk_status: string; tk_attempts: number; tk_video_id: string | null; tk_error: string | null; tk_screenshot: string | null; tk_last_attempt_at: string | null;
  fb_status: string; fb_attempts: number; fb_video_id: string | null; fb_error: string | null; fb_screenshot: string | null; fb_last_attempt_at: string | null;
  updated_at: string;
}>;

export function updateJobRow(db: SocialDB, id: string, patch: JobPatch): SocialJobRow | undefined {
  const keys = Object.keys(patch);
  if (keys.length === 0) return getJobRow(db, id);
  const assignment = keys.map(key => `${key} = @${key}`).join(', ');
  const params: Record<string, unknown> = { ...patch, id };
  const updated = db.prepare(`UPDATE social_jobs SET ${assignment} WHERE id = @id`).run(params);
  if (updated.changes === 0) return undefined;
  return getJobRow(db, id);
}

export function deleteJobRow(db: SocialDB, id: string): boolean {
  const result = db.prepare('DELETE FROM social_jobs WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Đưa các platform `running` về `pending` sau khi daemon khởi động lại. */
export function recoverRunningJobs(db: SocialDB): void {
  db.exec(`
    UPDATE social_jobs SET yt_status = 'pending', updated_at = updated_at WHERE yt_status = 'running';
    UPDATE social_jobs SET tk_status = 'pending', updated_at = updated_at WHERE tk_status = 'running';
    UPDATE social_jobs SET fb_status = 'pending', updated_at = updated_at WHERE fb_status = 'running';
  `);
}
