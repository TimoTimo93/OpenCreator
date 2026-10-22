/**
 * Dò phiên đăng nhập trong profile trình duyệt của cụm mà KHÔNG cần mở
 * trình duyệt: tên cookie nằm trong bảng Cookies của Chrome (giá trị được mã
 * hoá nhưng tên thì plaintext) ⇒ đọc trực tiếp bằng SQLite read-only.
 *
 * Dùng để sửa trạng thái cột nền tảng khi phiên đã đăng nhập từ trước
 * (tránh hiện "Chưa đăng nhập" + nút "Đăng nhập"/"Tạo tài khoản" khi đã có).
 */
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export type SocialSessionFlags = {
  youtube: boolean;
  tiktok: boolean;
  facebook: boolean;
};

const COOKIE_FILES = [
  join('Default', 'Network', 'Cookies'),
  join('Default', 'Cookies')
];

const PLATFORM_COOKIES: Record<'youtube' | 'tiktok' | 'facebook', string[]> = {
  youtube: ['SID', 'SSID', 'APISID', '__Secure-3PSID', '__Secure-1PSID'],
  tiktok: ['sessionid', 'sessionid_ss', 'sid_tt'],
  facebook: ['c_user', 'xs']
};

/**
 * Đọc tên cookie của profile cụm. Trả về null nếu không đọc được (profile
 * đang bị Chrome khoá, hoặc không tồn tại) — khi đó caller giữ nguyên trạng thái.
 */
function readCookieNames(file: string): Array<{ name: string }> | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as new (path: string, options: { readonly: boolean }) => {
      prepare: (sql: string) => { all: () => Array<{ name: string }> };
      close: () => void;
    };
    const db = new Database(file, { readonly: true });
    const rows = db.prepare('SELECT name FROM cookies').all() as Array<{ name: string }>;
    db.close();
    return rows;
  } catch {
    return null;
  }
}

export function readProfileSessionFlags(profileDir: string): SocialSessionFlags | null {
  for (const relative of COOKIE_FILES) {
    const file = join(profileDir, relative);
    if (!existsSync(file)) continue;
    // Lấy danh sách tên cookie: mở thẳng file readonly; Chrome đang chạy có thể
    // khoá file → fall back copy ra thư mục temp rồi đọc bản copy.
    let rows: Array<{ name: string }> | null = readCookieNames(file);
    if (rows === null) {
      const copyPath = join(tmpdir(), `oc-cookies-${randomUUID()}.sqlite`);
      try {
        copyFileSync(file, copyPath);
        rows = readCookieNames(copyPath);
      } catch {
        rows = null;
      } finally {
        try { unlinkSync(copyPath); } catch { /* bỏ qua */ }
      }
    }
    if (rows === null) continue;
    const names = new Set(rows.map(row => row.name));
    const flags: SocialSessionFlags = {
      youtube: PLATFORM_COOKIES.youtube.some(name => names.has(name)),
      tiktok: PLATFORM_COOKIES.tiktok.some(name => names.has(name)),
      facebook: PLATFORM_COOKIES.facebook.some(name => names.has(name))
    };
    return flags;
  }
  return null;
}
