/**
 * Lưu trữ Social Automation: SQLite riêng `<dataDir>/social.sqlite` (WAL).
 * Không đụng migrations toàn cục — schema tạo ngay khi mở db.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  sanitizePlatformSettings,
  type SocialCluster,
  type SocialFacebookMode,
  type SocialJob,
  type SocialPlatform,
  type SocialPlatformSettings,
  type SocialPlatformState
} from './types.js';
import { normalizeDatabaseTimestamp } from '../storage/database.js';
import { ensurePendingUploadsSchema } from './pending-uploads.js';

export type SocialDB = Database.Database;

const CLUSTER_COLUMNS = [
  'id', 'name', 'series_name', 'proxy_server', 'proxy_status', 'proxy_detail',
  'yt_login', 'tk_login', 'fb_login', 'fb_mode', 'fb_page_id', 'fb_page_token_encrypted',
  'default_schedule_times', 'default_description', 'created_at', 'updated_at',
  'yt_channel_url', 'tk_profile_url', 'auto_reply_enabled', 'auto_reply_prompt',
  'auto_publish_after_translate', 'yt_account_name', 'yt_account_id'
] as const;

const JOB_COLUMNS = [
  'id', 'cluster_id', 'cluster_name', 'video_path', 'thumbnail_path', 'title', 'description',
  'scheduled_at', 'platform_settings',
  'yt_status', 'yt_attempts', 'yt_video_id', 'yt_error', 'yt_screenshot', 'yt_last_attempt_at',
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
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      yt_account_name TEXT NOT NULL DEFAULT '',
      yt_account_id TEXT NOT NULL DEFAULT ''
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
  ensurePendingUploadsSchema(db);
  // GĐ3: bảng thống kê + bình luận (cộng thêm — không đổi bảng cũ).
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cluster_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      metric TEXT NOT NULL,
      value INTEGER NOT NULL,
      captured_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_social_stats_channel
      ON social_stats(cluster_id, platform, metric, captured_at);

    CREATE TABLE IF NOT EXISTS social_video_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      cluster_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      external_video_id TEXT NOT NULL,
      views INTEGER,
      likes INTEGER,
      comments_count INTEGER,
      captured_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_social_video_stats_job
      ON social_video_stats(job_id, platform, captured_at);

    CREATE TABLE IF NOT EXISTS social_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      cluster_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      external_video_id TEXT NOT NULL DEFAULT '',
      external_comment_id TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      comment_created_at TEXT,
      reply_status TEXT NOT NULL DEFAULT 'pending',
      reply_text TEXT,
      replied_at TEXT,
      skipped_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform, external_comment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_social_comments_cluster
      ON social_comments(cluster_id, platform, created_at);
  `);
  migrateColumns(db);
  return db;
}

/**
 * ALTER TABLE cộng thêm cột cho các database đã tồn tại (schema v1 không có).
 * safe-superset: chỉ thêm, không xoá/cột đổi.
 */
function migrateColumns(db: SocialDB): void {
  const missing = (table: string, column: string): boolean => {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    return !columns.some(info => info.name === column);
  };
  const addColumn = (table: string, column: string, ddl: string): void => {
    if (missing(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addColumn('social_clusters', 'yt_channel_url', "yt_channel_url TEXT NOT NULL DEFAULT ''");
  addColumn('social_clusters', 'tk_profile_url', "tk_profile_url TEXT NOT NULL DEFAULT ''");
  // Tài khoản đã liên kết (đọc từ cookie/Studio sau khi đăng nhập tay).
  addColumn('social_clusters', 'yt_account_name', "yt_account_name TEXT NOT NULL DEFAULT ''");
  addColumn('social_clusters', 'yt_account_id', "yt_account_id TEXT NOT NULL DEFAULT ''");
  // Tên tài khoản TikTok/Facebook (để cột hiển thị "● <tên>" như YouTube).
  addColumn('social_clusters', 'tk_account_name', "tk_account_name TEXT NOT NULL DEFAULT ''");
  addColumn('social_clusters', 'fb_account_name', "fb_account_name TEXT NOT NULL DEFAULT ''");
  // Thông tin đăng nhập Facebook (mật khẩu được mã hóa AES-256-GCM).
  addColumn('social_clusters', 'fb_login_email', "fb_login_email TEXT NOT NULL DEFAULT ''");
  addColumn('social_clusters', 'fb_login_password_encrypted', 'fb_login_password_encrypted TEXT');
  addColumn('social_clusters', 'auto_reply_enabled', 'auto_reply_enabled INTEGER NOT NULL DEFAULT 0');
  addColumn('social_clusters', 'auto_reply_prompt', "auto_reply_prompt TEXT NOT NULL DEFAULT ''");
  // GĐ4: công tắc tự nạp đăng sau khi dịch xong (điều khiển từ daemon).
  addColumn('social_clusters', 'auto_publish_after_translate', 'auto_publish_after_translate INTEGER NOT NULL DEFAULT 0');
  addColumn('social_jobs', 'platform_settings', "platform_settings TEXT NOT NULL DEFAULT '{}'");
  void missing;
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
  yt_channel_url: string | null;
  tk_profile_url: string | null;
  yt_account_name: string | null;
  yt_account_id: string | null;
  tk_account_name: string | null;
  fb_account_name: string | null;
  fb_login_email: string | null;
  fb_login_password_encrypted: string | null;
  auto_reply_enabled: number | null;
  auto_reply_prompt: string | null;
  auto_publish_after_translate: number | null;
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
  platform_settings: string | null;
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
    ytChannelUrl: row.yt_channel_url ?? '',
    tkProfileUrl: row.tk_profile_url ?? '',
    ytAccountName: row.yt_account_name ?? '',
    ytAccountId: row.yt_account_id ?? '',
    tkAccountName: row.tk_account_name ?? '',
    fbAccountName: row.fb_account_name ?? '',
    fbLoginEmail: row.fb_login_email ?? '',
    needsChannel: (row.yt_login === 'ok') && (row.yt_account_id ?? '') === '',
    autoReplyEnabled: row.auto_reply_enabled === 1,
    autoReplyPrompt: row.auto_reply_prompt ?? '',
    autoPublishAfterTranslate: row.auto_publish_after_translate === 1,
    createdAt: normalizeDatabaseTimestamp(row.created_at),
    updatedAt: normalizeDatabaseTimestamp(row.updated_at)
  };
}

type SocialClusterLoginValue = SocialCluster['loginStatus']['youtube'];

/** Đọc settings từng nền tảng từ cột JSON; hỏng/rác → {} (không bao giờ ném). */
function parsePlatformSettings(raw: string | null): SocialPlatformSettings {
  if (raw === null || raw.trim() === '') return {};
  try {
    return sanitizePlatformSettings(JSON.parse(raw));
  } catch {
    return {};
  }
}

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
    platformSettings: parsePlatformSettings(row.platform_settings),
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
    ytChannelUrl?: string;
    tkProfileUrl?: string;
    autoReplyEnabled?: boolean;
    autoReplyPrompt?: string;
    autoPublishAfterTranslate?: boolean;
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
    yt_account_name: '',
    yt_account_id: '',
    tk_account_name: '',
    fb_account_name: '',
    fb_login_email: '',
    fb_login_password_encrypted: null,
    fb_mode: data.fbMode,
    fb_page_id: data.fbPageId,
    fb_page_token_encrypted: data.fbPageTokenEncrypted,
    default_schedule_times: JSON.stringify(data.defaultScheduleTimes.length > 0 ? data.defaultScheduleTimes : ['19:30']),
    default_description: data.defaultDescription,
    yt_channel_url: data.ytChannelUrl ?? '',
    tk_profile_url: data.tkProfileUrl ?? '',
    auto_reply_enabled: data.autoReplyEnabled === true ? 1 : 0,
    auto_reply_prompt: data.autoReplyPrompt ?? '',
    auto_publish_after_translate: data.autoPublishAfterTranslate === true ? 1 : 0,
    created_at: data.nowISO,
    updated_at: data.nowISO
  };
  db.prepare(`
    INSERT INTO social_clusters(
      id, name, series_name, proxy_server, proxy_status, proxy_detail,
      yt_login, tk_login, fb_login, fb_mode, fb_page_id, fb_page_token_encrypted,
      default_schedule_times, default_description, created_at, updated_at,
      yt_channel_url, tk_profile_url, auto_reply_enabled, auto_reply_prompt,
      auto_publish_after_translate
    ) VALUES (
      @id, @name, @series_name, @proxy_server, @proxy_status, @proxy_detail,
      @yt_login, @tk_login, @fb_login, @fb_mode, @fb_page_id, @fb_page_token_encrypted,
      @default_schedule_times, @default_description, @created_at, @updated_at,
      @yt_channel_url, @tk_profile_url, @auto_reply_enabled, @auto_reply_prompt,
      @auto_publish_after_translate
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
    yt_channel_url: string;
    tk_profile_url: string;
    yt_account_name: string;
    yt_account_id: string;
    tk_account_name: string;
    fb_account_name: string;
    fb_login_email: string;
    fb_login_password_encrypted: string | null;
    auto_reply_enabled: number;
    auto_reply_prompt: string;
    auto_publish_after_translate: number;
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
  db.prepare('DELETE FROM social_stats WHERE cluster_id = ?').run(id);
  db.prepare('DELETE FROM social_video_stats WHERE cluster_id = ?').run(id);
  db.prepare('DELETE FROM social_comments WHERE cluster_id = ?').run(id);
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
    platformSettings?: SocialPlatformSettings;
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
    platform_settings: JSON.stringify(data.platformSettings ?? {}),
    yt_status: 'pending', yt_attempts: 0, yt_video_id: null, yt_error: null, yt_screenshot: null, yt_last_attempt_at: null,
    tk_status: 'pending', tk_attempts: 0, tk_video_id: null, tk_error: null, tk_screenshot: null, tk_last_attempt_at: null,
    fb_status: 'pending', fb_attempts: 0, fb_video_id: null, fb_error: null, fb_screenshot: null, fb_last_attempt_at: null,
    created_at: data.nowISO,
    updated_at: data.nowISO
  };
  db.prepare(`
    INSERT INTO social_jobs (
      id, cluster_id, cluster_name, video_path, thumbnail_path, title, description, scheduled_at, platform_settings,
      yt_status, yt_attempts, yt_video_id, yt_error, yt_screenshot, yt_last_attempt_at,
      tk_status, tk_attempts, tk_video_id, tk_error, tk_screenshot, tk_last_attempt_at,
      fb_status, fb_attempts, fb_video_id, fb_error, fb_screenshot, fb_last_attempt_at,
      created_at, updated_at
    ) VALUES (
      @id, @cluster_id, @cluster_name, @video_path, @thumbnail_path, @title, @description, @scheduled_at, @platform_settings,
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
  platform_settings: string;
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

// ---------------------------------------------------------------------------
// GĐ3 — Thống kê kênh / video
// ---------------------------------------------------------------------------

export type StatsSnapshotRow = {
  id: number;
  cluster_id: string;
  platform: string;
  metric: string;
  value: number;
  captured_at: string;
};

/** Lưu một điểm đo (Δ: chỉ ghi khi giá trị đổi hoặc lần đo đầu — để giữ history gọn). */
export function insertStatsSnapshot(
  db: SocialDB,
  data: { clusterId: string; platform: string; metric: string; value: number; capturedAt: string }
): void {
  db.prepare(`
    INSERT INTO social_stats(cluster_id, platform, metric, value, captured_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(data.clusterId, data.platform, data.metric, data.value, data.capturedAt);
}

/** chuỗi lịch sử: điểm gần nhất + trước đó của một chỉ số (mỗi cụm/platform/metric). */
export function latestStatsWithPrevious(
  db: SocialDB,
  clusterId?: string
): Array<{ cluster_id: string; platform: string; metric: string; value: number; captured_at: string; previous: number | null }> {
  return db.prepare(`
    SELECT s.cluster_id, s.platform, s.metric, s.value, s.captured_at,
      (SELECT older.value FROM social_stats AS older
        WHERE older.cluster_id = s.cluster_id AND older.platform = s.platform
          AND older.metric = s.metric AND older.id < s.id
        ORDER BY older.id DESC LIMIT 1) AS previous
    FROM (
      SELECT st.*, ROW_NUMBER() OVER (
        PARTITION BY st.cluster_id, st.platform, st.metric ORDER BY st.id DESC) AS rn
      FROM social_stats AS st
      ${clusterId !== undefined ? 'WHERE st.cluster_id = ?' : ''}
    ) AS s
    WHERE s.rn = 1
    ORDER BY s.cluster_id, s.platform, s.metric
  `).all(...(clusterId !== undefined ? [clusterId] : [])) as Array<{
    cluster_id: string; platform: string; metric: string; value: number; captured_at: string; previous: number | null;
  }>;
}

export type StatsHistoryRow = {
  cluster_id: string;
  platform: string;
  metric: string;
  value: number;
  captured_at: string;
};

export type StatsHistoryQuery = {
  clusterId?: string;
  platform?: string;
  metric?: string;
  /** Số điểm mỗi chuỗi đo (mặc định 30, chặn tối đa STATS_HISTORY_MAX_LIMIT). */
  limit?: number;
};

/** Chặn trần cho listStatsHistory — giữ payload overview gọn. */
export const STATS_HISTORY_MAX_LIMIT = 120;

/**
 * Lịch sử N điểm gần nhất theo captured_at của TỪNG chuỗi đo
 * (cluster_id + platform + metric), trả tăng dần theo thời gian để vẽ chart.
 * Dùng idx_social_stats_channel có sẵn; KHÔNG đổi hành vi ghi.
 */
export function listStatsHistory(db: SocialDB, query: StatsHistoryQuery = {}): StatsHistoryRow[] {
  const rawLimit = query.limit ?? 30;
  const limit = Math.min(Math.max(Math.floor(rawLimit), 1), STATS_HISTORY_MAX_LIMIT);
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (query.clusterId !== undefined) {
    conditions.push('st.cluster_id = ?');
    params.push(query.clusterId);
  }
  if (query.platform !== undefined) {
    conditions.push('st.platform = ?');
    params.push(query.platform);
  }
  if (query.metric !== undefined) {
    conditions.push('st.metric = ?');
    params.push(query.metric);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`
    SELECT s.cluster_id, s.platform, s.metric, s.value, s.captured_at
    FROM (
      SELECT st.*, ROW_NUMBER() OVER (
        PARTITION BY st.cluster_id, st.platform, st.metric
        ORDER BY st.captured_at DESC, st.id DESC
      ) AS rn
      FROM social_stats AS st
      ${where}
    ) AS s
    WHERE s.rn <= ?
    ORDER BY s.cluster_id, s.platform, s.metric, s.captured_at, s.id
  `).all(...params, limit) as StatsHistoryRow[];
}

export function deleteStatsBefore(db: SocialDB, beforeISO: string): void {
  db.prepare('DELETE FROM social_stats WHERE captured_at < ?').run(beforeISO);
  db.prepare('DELETE FROM social_video_stats WHERE captured_at < ?').run(beforeISO);
}

export function kvDelete(db: SocialDB, key: string): void {
  db.prepare('DELETE FROM social_kv WHERE key = ?').run(key);
}

// ---------------------------------------------------------------------------
// GĐ3 — Video stats
// ---------------------------------------------------------------------------

export type VideoStatRow = {
  id: number;
  job_id: string;
  cluster_id: string;
  platform: string;
  external_video_id: string;
  views: number | null;
  likes: number | null;
  comments_count: number | null;
  captured_at: string;
};

export function insertVideoStat(
  db: SocialDB,
  data: {
    jobId: string; clusterId: string; platform: string; externalVideoId: string;
    views: number | null; likes: number | null; commentsCount: number | null; capturedAt: string;
  }
): void {
  db.prepare(`
    INSERT INTO social_video_stats(job_id, cluster_id, platform, external_video_id, views, likes, comments_count, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(data.jobId, data.clusterId, data.platform, data.externalVideoId, data.views, data.likes, data.commentsCount, data.capturedAt);
}

/** Metrics gần nhất mỗi (job, platform) + số views của lượt đo trước đó. */
export function latestVideoStats(
  db: SocialDB,
  clusterId?: string
): Array<VideoStatRow & { previousViews: number | null }> {
  return db.prepare(`
    SELECT s.job_id, s.cluster_id, s.platform, s.external_video_id, s.views, s.likes, s.comments_count, s.captured_at,
      (SELECT older.views FROM social_video_stats AS older
        WHERE older.job_id = s.job_id AND older.platform = s.platform
          AND older.id < s.id ORDER BY older.id DESC LIMIT 1) AS previousViews
    FROM (
      SELECT vs.*, ROW_NUMBER() OVER (
        PARTITION BY vs.job_id, vs.platform ORDER BY vs.id DESC) AS rn
      FROM social_video_stats AS vs
      ${clusterId !== undefined ? 'WHERE vs.cluster_id = ?' : ''}
    ) AS s
    WHERE s.rn = 1
    ORDER BY s.captured_at DESC
  `).all(...(clusterId !== undefined ? [clusterId] : [])) as Array<VideoStatRow & { previousViews: number | null }>;
}

/** Simplest: điểm đo trước đó của một cặp job+platform. */
export function previousVideoStatRow(
  db: SocialDB,
  jobId: string,
  platform: string
): VideoStatRow | undefined {
  return db.prepare(`
    SELECT * FROM social_video_stats WHERE job_id = ? AND platform = ?
    ORDER BY id DESC LIMIT 1
  `).get(jobId, platform) as VideoStatRow | undefined;
}

export function latestVideoStatRow(
  db: SocialDB,
  jobId: string,
  platform: string
): VideoStatRow | undefined {
  return previousVideoStatRow(db, jobId, platform);
}

// ---------------------------------------------------------------------------
// GĐ3 — Bình luận (quét + AI trả lời)
// ---------------------------------------------------------------------------

export type SocialCommentRowLike = {
  id: number;
  job_id: string | null;
  cluster_id: string;
  platform: string;
  external_video_id: string;
  external_comment_id: string;
  author: string;
  text: string;
  comment_created_at: string | null;
  reply_status: string;
  reply_text: string | null;
  replied_at: string | null;
  skipped_reason: string | null;
  created_at: string;
};

/** Nhập bình luận mới; trả số bản ghi thật sự được tạo (unique theo platform+comment id). */
export function upsertCommentRow(
  db: SocialDB,
  data: {
    jobId: string | null; clusterId: string; platform: string;
    externalVideoId: string; externalCommentId: string;
    author: string; text: string; commentCreatedAt: string | null; nowISO: string;
  }
): boolean {
  const result = db.prepare(`
    INSERT INTO social_comments(
      job_id, cluster_id, platform, external_video_id, external_comment_id,
      author, text, comment_created_at, reply_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(platform, external_comment_id) DO NOTHING
  `).run(
    data.jobId, data.clusterId, data.platform, data.externalVideoId, data.externalCommentId,
    data.author, data.text, data.commentCreatedAt, data.nowISO
  );
  return result.changes > 0;
}

export function listCommentRows(
  db: SocialDB,
  filters: { clusterId?: string; limit?: number; replyStatus?: string }
): SocialCommentRowLike[] {
  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (filters.clusterId !== undefined) {
    wheres.push('cluster_id = ?');
    params.push(filters.clusterId);
  }
  if (filters.replyStatus !== undefined) {
    wheres.push('reply_status = ?');
    params.push(filters.replyStatus);
  }
  const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
  params.push(filters.limit ?? 100);
  return db.prepare(`
    SELECT * FROM social_comments ${whereSql}
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(...params) as SocialCommentRowLike[];
}

export function getCommentRow(db: SocialDB, id: number): SocialCommentRowLike | undefined {
  return db.prepare('SELECT * FROM social_comments WHERE id = ?').get(id) as SocialCommentRowLike | undefined;
}

export function updateCommentRow(
  db: SocialDB,
  id: number,
  patch: { reply_status: string; reply_text?: string | null; replied_at?: string | null; skipped_reason?: string | null }
): void {
  db.prepare(`
    UPDATE social_comments SET
      reply_status = ?,
      reply_text = COALESCE(?, reply_text),
      replied_at = COALESCE(?, replied_at),
      skipped_reason = COALESCE(?, skipped_reason)
    WHERE id = ?
  `).run(patch.reply_status, patch.reply_text ?? null, patch.replied_at ?? null, patch.skipped_reason ?? null, id);
}

export function countCommentRowsRepliedSince(
  db: SocialDB,
  clusterId: string,
  sinceISO: string
): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM social_comments
    WHERE cluster_id = ? AND reply_status = 'sent' AND replied_at >= ?
  `).get(clusterId, sinceISO) as { n: number };
  return row.n;
}
