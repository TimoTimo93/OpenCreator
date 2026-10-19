/**
 * Backend media picker cho Mạng Lưới Đăng Đa Kênh: liệt kê video ĐÃ TẢI VỀ
 * trên đĩa để người dùng chọn nạp vào hàng đợi. CHỈ ĐỌC — không đụng db/hàng
 * đợi của downloader (nguồn sự thật là thư mục tải về: downloadRoot người dùng
 * cấu hình, mặc định Documents/OpenCreator).
 */
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export type SocialDownloadItem = {
  /** Đường dẫn tuyệt đối tới file video. */
  path: string;
  /** Tên file bỏ phần mở rộng. */
  title: string;
  /** Tên thư mục cha (nhóm "sê-ri") nếu file nằm trong thư mục con của gốc tải về. */
  seriesName: string;
  /** Thời điểm file được ghi (mtime, ISO). */
  downloadedAt: string;
  sizeBytes: number;
};

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm']);
/** Giới hạn số mục trả về (mới nhất trước). */
export const MAX_DOWNLOAD_ITEMS = 500;
/** Quét sâu tối đa 1 cấp thư mục con (nhóm theo sê-ri/tên bộ). */
const MAX_SCAN_DEPTH = 2;

/**
 * Liệt kê video trong thư mục gốc tải về: lọc .mp4/.mkv/.webm, sắp mới nhất
 * trước, giới hạn `limit` (mặc định/tối đa MAX_DOWNLOAD_ITEMS). Lỗi đọc một
 * mục (file bị khóa, quyền...) bị bỏ qua — quét read-only hoàn toàn.
 */
export async function listDownloadedVideos(input: {
  root: string;
  limit?: number;
}): Promise<SocialDownloadItem[]> {
  const root = input.root.trim();
  if (root === '') return [];
  const limit = Math.max(1, Math.min(input.limit ?? MAX_DOWNLOAD_ITEMS, MAX_DOWNLOAD_ITEMS));
  const items: SocialDownloadItem[] = [];
  await scanDirectory(root, root, 1, items);
  items.sort((left, right) => {
    const delta = new Date(right.downloadedAt).getTime() - new Date(left.downloadedAt).getTime();
    return delta !== 0 ? delta : left.path.localeCompare(right.path);
  });
  return items.slice(0, limit);
}

async function scanDirectory(
  root: string,
  directory: string,
  depth: number,
  items: SocialDownloadItem[]
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return; // Thư mục biến mất/không đọc được → bỏ qua, không bao giờ ném ra ngoài.
  }
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || depth >= MAX_SCAN_DEPTH) continue;
      await scanDirectory(root, fullPath, depth + 1, items);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    let info: { mtimeMs: number; size: number } | undefined;
    try {
      const fileStat = await stat(fullPath);
      info = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
    } catch {
      continue; // File vừa bị xóa/đang khóa → bỏ qua.
    }
    const seriesName = directory === root ? '' : basename(directory);
    items.push({
      path: fullPath,
      title: basename(entry.name, extname(entry.name)),
      seriesName,
      downloadedAt: new Date(info.mtimeMs).toISOString(),
      sizeBytes: info.size
    });
  }
}
