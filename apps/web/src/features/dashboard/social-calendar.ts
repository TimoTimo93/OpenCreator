import type {
  SocialClusterSummary,
  SocialEnqueueItem,
  SocialJobSummary,
  SocialJobPlatformSettings
} from '../../services/social-service.js';

/**
 * Logic thuần cho tab "Lịch đăng" và composer đa kênh (tư duy Postiz):
 * - lưới tuần/tháng, nhóm job theo ngày, kéo-thả đổi giờ;
 * - khung giờ vàng của cụm, dựng items cho POST /social/jobs.
 * Không JSX, không gọi mạng — toàn bộ hàm thuần để test trực tiếp.
 */

// ---------------------------------------------------------------------------
// Lịch — ngày & lưới
// ---------------------------------------------------------------------------

/** Đầu tuần (thứ 2) của ngày đang xét. */
export function startOfWeek(date: Date, weekStartsOn = 1): Date {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (day.getDay() - weekStartsOn + 7) % 7;
  day.setDate(day.getDate() - offset);
  return day;
}

export function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

export function addMonths(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + amount);
  return next;
}

export function isSameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/** Khóa ngày theo múi giờ máy: YYYY-MM-DD. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function eachDay(windowStart: Date, count: number): Date[] {
  return Array.from({ length: count }, (_, index) => addDays(windowStart, index));
}

/** Lưới tháng Postiz-style: 6 tuần × 7 ngày, bắt đầu thứ 2, chứa cả tháng. */
export function monthGridDays(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  return eachDay(startOfWeek(first), 42);
}

// ---------------------------------------------------------------------------
// Lịch — job
// ---------------------------------------------------------------------------

/** Nhóm job theo ngày (khóa dayKey), mỗi ngày xếp theo giờ đăng. */
export function groupJobsByDay(jobs: SocialJobSummary[]): Map<string, SocialJobSummary[]> {
  const map = new Map<string, SocialJobSummary[]>();
  for (const job of jobs) {
    const date = new Date(job.scheduledAt);
    if (Number.isNaN(date.getTime())) continue;
    const key = dayKey(date);
    const list = map.get(key);
    if (list === undefined) map.set(key, [job]);
    else list.push(job);
  }
  for (const list of map.values()) {
    list.sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
  }
  return map;
}

/** Chỉ job chưa đăng công khai trên nền tảng nào mới được kéo đổi giờ. */
export function jobIsReschedulable(job: SocialJobSummary): boolean {
  const statuses = Object.values(job.platforms).map(state => state.status);
  return !statuses.some(status => status === 'published' || status === 'running');
}

/** Giữ nguyên giờ:lúc của job, chuyển sang ngày khác (kết quả ISO UTC). */
export function shiftJobToDay(job: SocialJobSummary, targetDay: Date): string {
  const current = new Date(job.scheduledAt);
  const next = new Date(targetDay);
  next.setHours(current.getHours(), current.getMinutes(), 0, 0);
  return next.toISOString();
}

// ---------------------------------------------------------------------------
// Khung giờ vàng + datetime-local
// ---------------------------------------------------------------------------

/** '19:30' → phút trong ngày; trả về null nếu sai định dạng. */
export function parseHhmm(time: string): number | null {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Khung giờ trống tiếp theo theo danh sách khung giờ vàng (HH:mm) của cụm:
 * hôm nay còn slot chưa quá → lấy slot đó, hết → ngày mai slot sớm nhất.
 */
export function nextGoldenSlot(times: string[], from: Date = new Date()): Date | null {
  const slots = [...new Set(times)]
    .map(parseHhmm)
    .filter((minutes): minutes is number => minutes !== null)
    .sort((left, right) => left - right);
  if (slots.length === 0) return null;
  const nowMinutes = from.getHours() * 60 + from.getMinutes();
  for (const slot of slots) {
    if (slot > nowMinutes) {
      const next = new Date(from);
      next.setHours(Math.floor(slot / 60), slot % 60, 0, 0);
      return next;
    }
  }
  const next = new Date(from);
  next.setDate(next.getDate() + 1);
  next.setHours(Math.floor(slots[0]! / 60), slots[0]! % 60, 0, 0);
  return next;
}

/** ISO → giá trị cho <input type="datetime-local"> (giờ máy). */
export function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Giá trị datetime-local → ISO UTC (rỗng → undefined). */
export function fromDatetimeLocalValue(value: string): string | undefined {
  if (value.trim() === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/** Định dung lượng file cho media picker. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Composer — dựng items cho POST /social/jobs
// ---------------------------------------------------------------------------

export function defaultPlatformSettings(): SocialJobPlatformSettings {
  return {
    youtube: { privacy: 'public' },
    tiktok: { privacy: 'public', allowDuet: true, allowStitch: true, allowComments: true, directPost: false },
    facebook: { postType: 'post' }
  };
}

export type ComposeInput = {
  clusters: Array<Pick<SocialClusterSummary, 'id'>>;
  path: string;
  title?: string;
  description?: string;
  /** ISO hoặc datetime-local; rỗng → daemon tự xếp khung giờ vàng. */
  scheduledAt?: string;
  settings?: SocialJobPlatformSettings;
};

/** 1 video × N cụm → N item (giữ đúng contract POST /social/jobs). */
export function composeEnqueueItems(input: ComposeInput): SocialEnqueueItem[] {
  const path = input.path.trim();
  const title = input.title?.trim() ?? '';
  const description = input.description?.trim() ?? '';
  const scheduledAt = input.scheduledAt?.trim() ?? '';
  return input.clusters.map(cluster => ({
    clusterId: cluster.id,
    path,
    ...(title !== '' ? { title } : {}),
    ...(description !== '' ? { description } : {}),
    ...(scheduledAt !== '' ? { scheduledAt: fromDatetimeLocalValue(scheduledAt) ?? scheduledAt } : {}),
    ...(input.settings !== undefined ? { platformSettings: input.settings } : {})
  }));
}
