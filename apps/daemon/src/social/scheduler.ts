/**
 * Lịch hẹn đăng: tự xếp khung giờ trống (Auto-Slot) và kiểm tra giới hạn
 * nền tảng (Time-Gate). Đây là hàm thuần — không đụng database, dễ kiểm thử.
 */
import type { SocialPlatform } from './types.js';

/** Facebook yêu cầu scheduled_publish_time cách hiện tại ít nhất 10 phút, tối đa 75 ngày. */
export const MIN_SCHEDULE_LEAD_MS = 10 * 60_000;
export const FACEBOOK_MAX_SCHEDULE_MS = 75 * 24 * 60 * 60_000;
/** Bảo vệ: không xếp lịch vượt quá 60 ngày với YT/TikTok. */
export const GENERAL_MAX_SCHEDULE_MS = 60 * 24 * 60 * 60_000;

export type SlotInput = {
  /** ISO UTC "now". */
  nowISO: string;
  /** Khung giờ HH:mm theo giờ máy, gồm phút. */
  scheduleTimes: readonly string[];
  /** Khung hẹn muộn nhất đang giữ trong hàng đợi (ISO UTC) hoặc null. */
  lastScheduledISO?: string | null;
};

function parseLocalTimeHHmm(value: string): { hour: number; minute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute > 59) {
    return undefined;
  }
  return { hour, minute };
}

/**
 * Xác định thời điểm hẹn trống tiếp theo: quét các khung giờ của cụm từ hôm nay
 * trở đi (tối đa 60 ngày); khung nào ở sau `now` (và đang không bị job cũ chiếm
 * sát ngay) thì lấy. Dữ liệu "giờ máy" – dùng Date chỉ để format theo local.
 */
export function nextAvailableSlot(input: SlotInput, formatLocalDT = defaultFormatLocalDT): string {
  const now = new Date(input.nowISO);
  const floor = now.getTime() + MIN_SCHEDULE_LEAD_MS;
  const times = parseLocalTimeList(input.scheduleTimes);

  // Điểm bắt đầu quét: sau job đã hẹn muộn nhất (nếu có) để không trùng slot.
  let minCandidateMs = floor;
  if (input.lastScheduledISO) {
    const last = new Date(input.lastScheduledISO);
    if (!Number.isNaN(last.getTime()) && last.getTime() + 60_000 > minCandidateMs) {
      minCandidateMs = last.getTime() + 60_000;
    }
  }

  const base = new Date(minCandidateMs);
  for (let dayOffset = 0; dayOffset <= 60; dayOffset += 1) {
    const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset);
    for (const time of times) {
      const candidate = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), time.hour, time.minute, 0, 0);
      if (candidate.getTime() >= minCandidateMs) {
        return candidate.toISOString();
      }
    }
  }
  return new Date(minCandidateMs).toISOString();
}

function parseLocalTimeList(values: readonly string[]): Array<{ hour: number; minute: number }> {
  // Rỗng sau lọc → dùng 19:30 mặc định theo đặc tả khung giờ vàng.
  const parsed = values
    .map(parseLocalTimeHHmm)
    .filter((value): value is { hour: number; minute: number } => value !== undefined)
    .sort((left, right) => left.hour * 60 + left.minute - (right.hour * 60 + right.minute));
  if (parsed.length === 0) {
    parsed.push({ hour: 19, minute: 30 });
  }
  return parsed;
}

/** Format "YYYY-MM-DD HH:MM:SS" theo giờ máy cho UI hiển thị/điều khiển. */
export function defaultFormatLocalDT(date: Date): string {
  const pad = (value: number, len = 2): string => String(value).padStart(len, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

export type GateValidation =
  | { ok: true }
  | { ok: false; reason: string };

/** Kiểm tra giới hạn khoảng hẹn của từng nền tảng. */
export function validatePlatformGate(
  platform: SocialPlatform,
  scheduledAtISO: string,
  nowISO: string
): GateValidation {
  const scheduled = new Date(scheduledAtISO).getTime();
  const now = new Date(nowISO).getTime();
  if (Number.isNaN(scheduled)) return { ok: false, reason: 'Thời điểm hẹn không hợp lệ' };
  if (scheduled - now < MIN_SCHEDULE_LEAD_MS) {
    // Quá gần hiện tại → không hẹn giờ, đăng thẳng (caller quyết định).
    return { ok: false, reason: 'SLIGHTLY_PAST' };
  }
  const max = platform === 'facebook' ? FACEBOOK_MAX_SCHEDULE_MS : GENERAL_MAX_SCHEDULE_MS;
  if (scheduled - now > max) {
    return { ok: false, reason: `Thời điểm hẹn vượt giới hạn ${platform === 'facebook' ? '75 ngày' : '60 ngày'} của ${platform}` };
  }
  return { ok: true };
}
