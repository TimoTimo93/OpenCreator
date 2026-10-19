import { describe, expect, it } from 'vitest';
import {
  FACEBOOK_MAX_SCHEDULE_MS,
  MIN_SCHEDULE_LEAD_MS,
  nextAvailableSlot,
  validatePlatformGate
} from '../../src/social/scheduler.js';

describe('social scheduler — nextAvailableSlot', () => {
  it('trả về khung giờ hôm nay nếu còn xa hiện tại', () => {
    // Giờ máy 08:00, khung 19:30 → slot hôm nay 19:30.
    const now = new Date();
    now.setHours(8, 0, 0, 0);
    const slot = new Date(nextAvailableSlot({ nowISO: now.toISOString(), scheduleTimes: ['19:30'] }));
    expect(slot.getHours()).toBe(19);
    expect(slot.getMinutes()).toBe(30);
    expect(slot.getDate()).toBe(now.getDate());
  });

  it('chuyển sang ngày mai khi khung hôm nay đã quá gần hiện tại (<10 phút lead)', () => {
    const now = new Date();
    now.setHours(19, 25, 0, 0); // 19:25 → 19:30 chỉ còn 5 phút < lead 10 phút
    const slot = new Date(nextAvailableSlot({ nowISO: now.toISOString(), scheduleTimes: ['19:30'] }));
    expect(slot.getDate()).toBe(now.getDate() + 1);
    expect(slot.getHours()).toBe(19);
  });

  it('không xếp trùng slot: slot sau luôn sau job đã hẹn muộn nhất', () => {
    const now = new Date();
    now.setHours(8, 0, 0, 0);
    // Job đã chiếm slot 19:30 hôm nay.
    const taken = new Date(now);
    taken.setHours(19, 30, 0, 0);
    const slot = new Date(nextAvailableSlot({
      nowISO: now.toISOString(),
      scheduleTimes: ['19:30'],
      lastScheduledISO: taken.toISOString()
    }));
    expect(slot.getTime()).toBeGreaterThan(taken.getTime());
  });

  it('chọn khung sớm nhất còn trống trong ngày khi có nhiều khung giờ', () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const slot = new Date(nextAvailableSlot({ nowISO: now.toISOString(), scheduleTimes: ['19:30', '08:00', '12:30'] }));
    expect(slot.getHours()).toBe(12);
    expect(slot.getMinutes()).toBe(30);
  });

  it('khung giờ không hợp lệ bị bỏ qua; rỗng → dùng 19:30 mặc định', () => {
    const now = new Date();
    now.setHours(8, 0, 0, 0);
    const slot = new Date(nextAvailableSlot({ nowISO: now.toISOString(), scheduleTimes: ['25:00', 'abc', ''] }));
    expect(slot.getHours()).toBe(19);
  });
});

describe('social scheduler — validatePlatformGate', () => {
  const base = new Date('2026-03-15T00:00:00.000Z');

  it('chấp nhận hẹn ≥ 10 phút và trong giới hạn', () => {
    const ok = new Date(base.getTime() + MIN_SCHEDULE_LEAD_MS + 60_000).toISOString();
    expect(validatePlatformGate('facebook', ok, base.toISOString())).toEqual({ ok: true });
  });

  it('từ chối hẹn quá gần (<10 phút) bằng mã SLIGHTLY_PAST', () => {
    const soon = new Date(base.getTime() + 60_000).toISOString();
    const result = validatePlatformGate('youtube', soon, base.toISOString());
    expect(result).toEqual({ ok: false, reason: 'SLIGHTLY_PAST' });
  });

  it('Facebook cận trên 75 ngày, YouTube/TikTok 60 ngày', () => {
    const at75 = new Date(base.getTime() + FACEBOOK_MAX_SCHEDULE_MS).toISOString();
    expect(validatePlatformGate('facebook', at75, base.toISOString()).ok).toBe(true);
    expect(validatePlatformGate('youtube', at75, base.toISOString()).ok).toBe(false);
  });

  it('ISO hỏng → từ chối', () => {
    expect(validatePlatformGate('tiktok', 'not-a-date', base.toISOString()).ok).toBe(false);
  });
});
