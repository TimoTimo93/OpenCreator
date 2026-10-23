/**
 * v2.6 — HÀNG CHỜ UPLOAD 2 TẦNG (yêu cầu người dùng):
 *
 *   video ghép xong (thư mục `merging & upload`) → tự vào DANH SÁCH CHỜ UPLOAD
 *   nhưng CHƯA gán nhóm đăng; đến lúc gán mới xếp vào cụm + slot giờ vàng:
 *   - THỦ CÔNG: người dùng tự chọn cụm cho từng video (web).
 *   - TỰ ĐỘNG: phần mềm bốc lần lượt các cụm theo thứ tự danh sách 1 → N rồi
 *     quay vòng về 1 (mỗi video mới một cụm kế tiếp).
 *
 * Danh sách nằm trong bảng `social_pending_uploads` (SQLite social); cờ bật/tắt
 * cơ chế tự động và bộ đếm xoay vòng nằm trong `social_kv`.
 */
import { randomUUID } from 'node:crypto';
import type { SocialDB } from './db.js';

export type SocialPendingUploadRow = {
  id: string;
  videoPath: string;
  title: string;
  createdAt: string;
};

const KV_AUTO_ASSIGN = 'upload_auto_assign';
const KV_ROUND_ROBIN = 'upload_round_robin_index';

/** Cờ chế độ TỰ ĐỘNG gán nhóm (mặc định BẬT — 1 cụm cũng tự chọn nhóm 1). */
export function readAutoAssignEnabled(db: SocialDB): boolean {
  const row = db.prepare('SELECT value FROM social_kv WHERE key = ?').get(KV_AUTO_ASSIGN) as
    | { value: string }
    | undefined;
  // Không có cờ → mặc định bật (hành vi mới mặc định автомат hoá).
  return row === undefined || row.value !== '0';
}

export function writeAutoAssignEnabled(db: SocialDB, enabled: boolean): void {
  db.prepare(
    `INSERT INTO social_kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(KV_AUTO_ASSIGN, enabled ? '1' : '0');
}

/** Bộ đếm xoay vòng (bước gán kế tiếp bắt đầu từ đây theo mod số cụm). */
export function readRoundRobinIndex(db: SocialDB): number {
  const row = db.prepare('SELECT value FROM social_kv WHERE key = ?').get(KV_ROUND_ROBIN) as
    | { value: string }
    | undefined;
  const parsed = Number.parseInt(row?.value ?? '0', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function writeRoundRobinIndex(db: SocialDB, index: number): void {
  db.prepare(
    `INSERT INTO social_kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(KV_ROUND_ROBIN, String(Math.max(0, Math.trunc(index))));
}

/** Thêm 1 video vào danh sách chờ — mỗi path chỉ 1 lần (trùng → bỏ qua). */
export function insertPendingUpload(db: SocialDB, input: {
  path: string;
  title: string;
  now: () => string;
}): { created: boolean; row: SocialPendingUploadRow } {
  const existing = db
    .prepare('SELECT id FROM social_pending_uploads WHERE video_path = ?')
    .get(input.path.trim());
  if (existing !== undefined) {
    return { created: false, row: readPendingUpload(db, (existing as { id: string }).id)! };
  }
  const row: SocialPendingUploadRow = {
    id: randomUUID(),
    videoPath: input.path.trim(),
    title: input.title.trim(),
    createdAt: input.now()
  };
  db.prepare(
    'INSERT INTO social_pending_uploads (id, video_path, title, created_at) VALUES (?, ?, ?, ?)'
  ).run(row.id, row.videoPath, row.title, row.createdAt);
  return { created: true, row };
}

export function readPendingUpload(db: SocialDB, id: string): SocialPendingUploadRow | undefined {
  const row = db
    .prepare('SELECT id, video_path, title, created_at FROM social_pending_uploads WHERE id = ?')
    .get(id) as { id: string; video_path: string; title: string; created_at: string } | undefined;
  if (row === undefined) return undefined;
  return {
    id: row.id,
    videoPath: row.video_path,
    title: row.title,
    createdAt: row.created_at
  };
}

/** Danh sách chờ theo thời gian vào (cũ trước — xếp lịch ổn định). */
export function listPendingUploads(db: SocialDB): SocialPendingUploadRow[] {
  const rows = db
    .prepare('SELECT id, video_path, title, created_at FROM social_pending_uploads ORDER BY created_at ASC, id ASC')
    .all() as Array<{ id: string; video_path: string; title: string; created_at: string }>;
  return rows.map(row => ({
    id: row.id,
    videoPath: row.video_path,
    title: row.title,
    createdAt: row.created_at
  }));
}

export function deletePendingUpload(db: SocialDB, id: string): boolean {
  const result = db.prepare('DELETE FROM social_pending_uploads WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Bảng + index schema (thêm trong openSocialDatabase — dùng chung db). */
export function ensurePendingUploadsSchema(db: SocialDB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_pending_uploads (
      id TEXT PRIMARY KEY,
      video_path TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_social_pending_uploads_path
      ON social_pending_uploads(video_path);
  `);
}
