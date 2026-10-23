import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

/**
 * v2.6 — bố cục lưu trữ media yêu cầu của người dùng:
 *
 *   `<nơi cài OpenCreator>\data\download`           — video tải về (mỗi bộ một thư mục theo tên phim)
 *   `<nơi cài OpenCreator>\data\translate`          — video đã dịch (mỗi bộ một thư mục; video lẻ nằm trực tiếp)
 *   `<nơi cài OpenCreator>\data\merging & upload`   — video ghép THÀNH CÔNG (tự nạp hàng chờ upload)
 *
 * "Phần mềm ở đâu thì lưu media ở đấy": `appRoot` là thư mục cài app (chứa
 * OpenCreator.exe) — desktop truyền qua biến môi trường OPENCREATOR_APP_ROOT.
 * Thiếu appRoot (daemon chạy riêng/dev) → fallback dưới dataDir để vẫn hoạt động.
 */
export type MediaStorageRoots = {
  /** Gốc lưu media (thư mục `data` cạnh nơi cài app). */
  root: string;
  /** Chứa video tải về. */
  download: string;
  /** Chứa video đã dịch. */
  translate: string;
  /** Chứa video ghép thành công (full movie) — nguồn tự nạp upload. */
  merging: string;
};

export function resolveMediaStorageRoots(input: {
  appRoot?: string | null;
  dataDir: string;
}): MediaStorageRoots {
  const appRoot = input.appRoot?.trim() ?? '';
  const root = appRoot !== '' && isAbsolute(appRoot)
    ? join(resolve(appRoot), 'data')
    : join(resolve(input.dataDir), 'media');
  return {
    root,
    download: join(root, 'download'),
    translate: join(root, 'translate'),
    // Tên thư mục do người dùng chỉ định nguyên văn (khoảng trắng + dấu &).
    merging: join(root, 'merging & upload')
  };
}

/** Dọn tên thành tên thư mục an toàn cho Windows (cấm `<>:"/\|?*`, kết thúc không phải dấu chấm). */
export function sanitizeFolderName(raw: string): string | null {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim();
  if (cleaned === '') return null;
  return cleaned.length > 100 ? cleaned.slice(0, 100).trim() : cleaned;
}

/**
 * Tên thư mục của một bộ phim suy từ seriesKey:
 * - `title:<tên>` → `<tên>`
 * - `folder:<tên>-<hash>` → `<tên>` (bỏ hậu tố hash Hồng Quá)
 * - key khác không đọc được tên → thử thẻ `《tên phim》` trong tiêu đề → nếu vẫn
 *   không có thì trả null (video nằm trực tiếp trong thư mục cha).
 */
export function seriesFolderName(seriesKey: string | null | undefined, title?: string): string | null {
  const key = seriesKey?.trim() ?? '';
  if (key === '') return null;
  let name: string | null = null;
  if (key.startsWith('title:')) {
    name = key.slice('title:'.length).trim() || null;
  } else if (key.startsWith('folder:')) {
    name = key.slice('folder:'.length).replace(/-[0-9a-f]{6,}$/i, '').trim() || null;
  } else if (!key.includes(':')) {
    name = key;
  }
  if (name === null || name === '') {
    const tagged = title?.match(/《([^》]+)》/)?.[1]?.trim() ?? '';
    if (tagged !== '') name = tagged;
  }
  if (name === null || name === '') return null;
  return sanitizeFolderName(name);
}

/** `path` nằm trong thư mục `root` (hoặc chính là root)? So khớp lexical tuyệt đối. */
export function isPathInside(path: string, root: string): boolean {
  const child = resolve(path);
  const parent = resolve(root);
  return child === parent || child.startsWith(parent + sep);
}

/** Tên file đích: ưu tiên `preferred` (dọn dẹp) hỏi mượn phần mở rộng của file gốc. */
export function targetFileName(sourcePath: string, preferred?: string | null): string {
  const extension = parse(sourcePath).ext || '.mp4';
  const cleaned = preferred === undefined || preferred === null ? '' : sanitizeFolderName(preferred);
  return cleaned === null || cleaned === ''
    ? basename(sourcePath)
    : `${cleaned}${extension}`;
}

/**
 * Di chuyển file video vào thư mục đích (không ghi đè file có sẵn). Cùng ổ →
 * rename; khác ổ → copy rồi xoá gốc (EXDEV). Trả về đường dẫn mới; trả `null`
 * khi `targetDir` là null (không sắp xếp).
 */
export async function moveVideoIntoFile(input: {
  sourcePath: string;
  targetDir: string | null;
  preferredName?: string | null;
}): Promise<string | null> {
  if (input.targetDir === null || input.targetDir === undefined) return null;
  const sourcePath = resolve(input.sourcePath);
  const targetName = targetFileName(sourcePath, input.preferredName);
  let destination = join(input.targetDir, targetName);
  if (dirname(sourcePath) === resolve(input.targetDir) && basename(sourcePath) === targetName) {
    return sourcePath; // đã đúng chỗ, đúng tên
  }
  await mkdir(input.targetDir, { recursive: true });
  // Tránh ghi đè: đuôi ` (2)`, ` (3)`… nếu tên đã chiếm.
  for (let attempt = 2; attempt < 1_000; attempt += 1) {
    if (await pathMissing(destination)) break;
    const parsed = parse(targetName);
    destination = join(input.targetDir, `${parsed.name} (${attempt})${parsed.ext}`);
  }
  try {
    await rename(sourcePath, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EXDEV') throw error;
    await copyFile(sourcePath, destination);
    await rm(sourcePath, { force: true });
  }
  return destination;
}

async function pathMissing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch {
    return true;
  }
}

/** File nào đó có tồn tại (kể cả thư mục)? */
export async function fileExists(path: string): Promise<boolean> {
  return !(await pathMissing(path));
}
