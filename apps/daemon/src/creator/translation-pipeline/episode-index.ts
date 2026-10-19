/**
 * Trích số thứ tự tập từ tên file / tiêu đề video.
 *
 * Hỗ trợ các kiểu người dùng Việt Nam và quốc tế hay gặp:
 * - "Tập 01", "tap 1", "TẬP 003" (bỏ dấu để khớp, "tap-07", "tap_07");
 * - "EP01", "E01", "ep 12", "S01E02" (số sau E là số tập);
 * - "第03集", "03集" (tiếng Trung);
 * - đuôi số cuối cùng của tên file: "PhongThanh-07.mp4", "01.mp4".
 *
 * Ưu tiên mẫu tường minh (S01E02 → số sau E, "tập 05" → 5) rồi mới tới số cuối.
 * Số 0 hoặc âm bị bỏ qua; không khớp gì trả về null (xếp theo thứ tự nạp).
 */

const RESOLUTION_PATTERN = /\b\d{3,4}p\b/i;

/** Bỏ dấu tiếng Việt ("Tập" → "Tap") để một mẫu khớp cả có dấu lẫn không dấu. */
function deaccent(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function parseFromText(raw: string): number | null {
  const text = deaccent(raw).trim();
  if (text === '') return null;

  // S01E02 / s01 e02 — số sau "E" là số tập.
  const seasonEpisode = /(?:^|[^\da-z])s(\d{1,2})\s*e\s*(\d{1,4})(?![a-z0-9])/i.exec(text);
  if (seasonEpisode !== null) return toIndex(seasonEpisode[2]);

  // 第03集 / 03集 / 第 12 集 — mẫu tiếng Trung.
  const chinese = /第\s*(\d{1,4})\s*集|(?<![0-9])(\d{1,4})\s*集/.exec(text);
  if (chinese !== null) return toIndex(chinese[1] ?? chinese[2]);

  // Tap 01 / EP12 / E07 (cho phép "tap-07", "ep 12", "e_07").
  const explicit = /(?:^|[^\da-z])(?:tap|ep?)\s*[-_\s]*(\d{1,4})(?![a-z0-9])/i.exec(text);
  if (explicit !== null) return toIndex(explicit[1]);

  // Số cuối tên file (đã bỏ đuôi mở rộng): "...-07", "... 7", "..._7".
  const withoutExtension = text.replace(/\.[a-z0-9]+$/i, '');
  if (!RESOLUTION_PATTERN.test(withoutExtension)) {
    const trailing = /(\d{1,4})\s*$/.exec(withoutExtension);
    if (trailing !== null) return toIndex(trailing[1]);
  }
  return null;
}

function toIndex(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function parseEpisodeIndex(...sources: Array<string | undefined | null>): number | null {
  for (const source of sources) {
    if (source === undefined || source === null) continue;
    const parsed = parseFromText(String(source));
    if (parsed !== null) return parsed;
  }
  return null;
}
