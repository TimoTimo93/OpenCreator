import { describe, expect, it } from 'vitest';
import {
  composeEnqueueItems,
  dayKey,
  defaultPlatformSettings,
  eachDay,
  formatBytes,
  fromDatetimeLocalValue,
  groupJobsByDay,
  isSameDay,
  jobIsReschedulable,
  monthGridDays,
  nextGoldenSlot,
  parseHhmm,
  shiftJobToDay,
  startOfWeek,
  toDatetimeLocalValue
} from './social-calendar.js';
import type { SocialJobSummary } from '../../services/social-service.js';

function job(id: string, scheduledAt: string, statuses: Array<'pending' | 'running' | 'published' | 'failed'>): SocialJobSummary {
  return {
    id,
    clusterId: 'c1',
    clusterName: 'Cụm A',
    videoPath: `D:/${id}.mp4`,
    thumbnailPath: null,
    title: id,
    description: '',
    scheduledAt,
    platforms: {
      youtube: { status: statuses[0]!, attempts: 0, videoId: null, error: null, publishedAt: null },
      tiktok: { status: statuses[1]!, attempts: 0, videoId: null, error: null, publishedAt: null },
      facebook: { status: statuses[2]!, attempts: 0, videoId: null, error: null, publishedAt: null }
    },
    createdAt: '',
    updatedAt: ''
  };
}

describe('lưới lịch', () => {
  it('startOfWeek luôn trả về thứ 2', () => {
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(2026, 9, 18 + day); // 18/10/2026 là chủ nhật
      expect(startOfWeek(date).getDay()).toBe(1);
    }
  });

  it('eachDay + dayKey + isSameDay', () => {
    const days = eachDay(new Date(2026, 9, 19), 7);
    expect(days).toHaveLength(7);
    expect(dayKey(days[0]!)).toBe('2026-10-19');
    expect(dayKey(days[6]!)).toBe('2026-10-25');
    expect(isSameDay(days[0]!, new Date(2026, 9, 19, 23, 59))).toBe(true);
    expect(isSameDay(days[0]!, days[1]!)).toBe(false);
  });

  it('monthGridDays trả 42 ô, bắt đầu thứ 2 và phủ trọn tháng', () => {
    const grid = monthGridDays(new Date(2026, 9, 15));
    expect(grid).toHaveLength(42);
    expect(grid[0]!.getDay()).toBe(1);
    expect(grid[0]!.getTime()).toBeLessThanOrEqual(new Date(2026, 9, 1).getTime());
    expect(grid[41]!.getTime()).toBeGreaterThanOrEqual(new Date(2026, 9, 31).getTime());
  });
});

describe('nhóm job theo ngày + kéo-thả', () => {
  it('groupJobsByDay xếp đúng thứ tự giờ trong ngày', () => {
    const map = groupJobsByDay([
      job('b', new Date(2026, 9, 20, 21, 0).toISOString(), ['pending', 'pending', 'pending']),
      job('a', new Date(2026, 9, 20, 8, 0).toISOString(), ['pending', 'pending', 'pending']),
      job('c', new Date(2026, 9, 21, 8, 0).toISOString(), ['pending', 'pending', 'pending'])
    ]);
    expect(map.get('2026-10-20')?.map(entry => entry.id)).toEqual(['a', 'b']);
    expect(map.get('2026-10-21')?.map(entry => entry.id)).toEqual(['c']);
  });

  it('jobIsReschedulable: đã đăng hoặc đang chạy thì chặn', () => {
    expect(jobIsReschedulable(job('a', '', ['published', 'pending', 'pending']))).toBe(false);
    expect(jobIsReschedulable(job('a', '', ['pending', 'running', 'pending']))).toBe(false);
    expect(jobIsReschedulable(job('a', '', ['failed', 'pending', 'pending']))).toBe(true);
  });

  it('shiftJobToDay giữ nguyên giờ:lúc, đổi ngày', () => {
    const source = job('a', new Date(2026, 9, 20, 19, 30).toISOString(), ['pending', 'pending', 'pending']);
    const iso = shiftJobToDay(source, new Date(2026, 9, 24));
    const moved = new Date(iso);
    expect(moved.getDate()).toBe(24);
    expect(moved.getHours()).toBe(19);
    expect(moved.getMinutes()).toBe(30);
  });
});

describe('khung giờ vàng + datetime-local', () => {
  it('parseHhmm khử lệ + nextGoldenSlot hôm nay/hôm mai', () => {
    expect(parseHhmm('19:30')).toBe(19 * 60 + 30);
    expect(parseHhmm('24:00')).toBeNull();
    expect(parseHhmm('abc')).toBeNull();

    const morning = new Date(2026, 9, 19, 10, 0);
    expect(nextGoldenSlot(['19:30'], morning)?.getHours()).toBe(19);

    const evening = new Date(2026, 9, 19, 20, 0);
    const nextDay = nextGoldenSlot(['19:30'], evening)!;
    expect(nextDay.getDate()).toBe(20);
    expect(nextDay.getHours()).toBe(19);

    const sorted = nextGoldenSlot(['19:30', '08:00'], morning)!;
    expect(sorted.getHours()).toBe(19);

    expect(nextGoldenSlot([], morning)).toBeNull();
    expect(nextGoldenSlot(['không hợp lệ'], morning)).toBeNull();
  });

  it('toDatetimeLocalValue/fromDatetimeLocalValue quay vòng tròn theo giờ máy', () => {
    const date = new Date(2026, 0, 5, 7, 8);
    const text = toDatetimeLocalValue(date.toISOString());
    expect(text).toBe('2026-01-05T07:08');
    const iso = fromDatetimeLocalValue(text)!;
    expect(new Date(iso).getHours()).toBe(7);
    expect(fromDatetimeLocalValue('')).toBeUndefined();
    expect(fromDatetimeLocalValue('rác')).toBeUndefined();
  });
});

describe('composer — composeEnqueueItems', () => {
  it('1 video × N cụm → N item, giữ settings + lịch, bỏ trường rỗng', () => {
    const items = composeEnqueueItems({
      clusters: [{ id: 'a' }, { id: 'b' }],
      path: ' D:/video.mp4 ',
      title: '  Tập 1  ',
      description: '   ',
      scheduledAt: '2026-10-20T19:30',
      settings: defaultPlatformSettings()
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      clusterId: 'a',
      path: 'D:/video.mp4',
      title: 'Tập 1',
      platformSettings: {
        youtube: { privacy: 'public' },
        tiktok: { privacy: 'public', allowDuet: true, allowStitch: true, allowComments: true, directPost: false },
        facebook: { postType: 'post' }
      }
    });
    expect(items[0]!.description).toBeUndefined();
    // datetime-local → ISO vẫn đúng giờ máy
    expect(new Date(items[0]!.scheduledAt!).getHours()).toBe(19);
    expect(items[1]!.clusterId).toBe('b');
  });

  it('không có lịch → không gửi scheduledAt (daemon tự xếp khung giờ)', () => {
    const items = composeEnqueueItems({ clusters: [{ id: 'a' }], path: 'D:/v.mp4' });
    expect(items[0]!.scheduledAt).toBeUndefined();
    expect(items[0]!.platformSettings).toBeUndefined();
  });
});

describe('formatBytes', () => {
  it('định dung lượng', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});
