import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocialService } from './social-service.js';
import type { SocialOverview } from './social-service.js';
import SocialWorkspace from '../features/dashboard/SocialWorkspace.js';
import { LanguageProvider } from '../i18n/LanguageProvider.js';
import {
  dayKey,
  eachDay,
  startOfWeek
} from '../features/dashboard/social-calendar.js';
import {
  setPendingSocialHandoffSource,
  peekPendingSocialHandoffSource
} from '../features/dashboard/pending-social-handoff.js';

type Call = { method: string; path: string; body?: unknown };

function fakeClient() {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async get(path: string) {
        calls.push({ method: 'GET', path });
        const base = path.split('?')[0]!;
        return base === '/social/stats' ? stats()
          : base === '/social/comments' ? [{
              id: 1, jobId: 'job_1', clusterId: 'cluster_a', clusterName: 'Cụm A',
              platform: 'facebook', externalVideoId: 'fb-1', externalCommentId: 'cmt-1',
              author: 'Mai', text: 'Tập 17 hay quá!', commentCreatedAt: null,
              createdAt: '2026-10-19T09:00:00.000Z', replyStatus: 'sent',
              replyText: 'Cảm ơn bạn nhiều!', repliedAt: '2026-10-19T09:05:00.000Z', skippedReason: null
            }] as never
            : base.startsWith('/social/downloads') ? { items: [{
                path: 'D:/downloads/tap-5.mp4', title: 'Tập 5', seriesName: 'Long Hổ Riệu',
                downloadedAt: '2026-10-19T07:00:00.000Z', sizeBytes: 120 * 1024 * 1024
              }] }
            : overview();
      },
      async post(path: string, body?: unknown) {
        calls.push({ method: 'POST', path, body });
        return path === '/social/jobs' ? enqueueResult()
          : path === '/social/stats/refresh' ? stats()
            : path === '/social/comments/scan' ? scanResult()
              : overview();
      },
      async patch(path: string, body?: unknown) { calls.push({ method: 'PATCH', path, body }); return overview(); },
      async delete(path: string) { calls.push({ method: 'DELETE', path }); return { clusters: [], jobs: [] } as never; }
    } as never as Parameters<typeof createSocialService>[0]
  };
}

function stats() {
  return {
    channels: [{
      clusterId: 'cluster_a',
      clusterName: 'Cụm A',
      platform: 'facebook',
      metrics: { followers: { value: 12000, capturedAt: '2026-10-19T08:00:00.000Z', previous: 11000 } }
    }],
    videos: [],
    lastRefreshAt: '2026-10-19T08:00:00.000Z',
    refreshError: null
  };
}

function scanResult() {
  return { clustersScanned: 1, videosScanned: 1, newComments: 1, repliesAttempted: 1, repliesSent: 1, errors: [] };
}

function atHour(dayOffset: number, hour: number, minute: number): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function overview(): SocialOverview {
  return {
    queue: 'running',
    counts: { pending: 5, running: 0, published: 0, scheduled: 0, failed: 1, skipped: 0 },
    clusters: [{
      id: 'cluster_a',
      name: 'Cụm A',
      seriesName: 'Long Hổ Riệu',
      proxyServer: 'http://1.2.3.4:8080',
      proxyStatus: 'online',
      proxyDetail: null,
      fbMode: 'graph_api',
      fbPageId: 'page-1',
      fbPageTokenConfigured: true,
      defaultScheduleTimes: ['19:30'],
      defaultDescription: '',
      ytChannelUrl: 'https://www.youtube.com/@kenhphim',
      tkProfileUrl: '',
      autoReplyEnabled: false,
      autoReplyPrompt: '',
      loginStatus: { youtube: 'unknown', tiktok: 'unknown', facebook: 'unknown' },
      browserOpen: false,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z'
    }],
    jobs: [{
      id: 'job_1',
      clusterId: 'cluster_a',
      clusterName: 'Cụm A',
      videoPath: 'D:/v.mp4',
      thumbnailPath: null,
      title: 'Tập 1',
      description: '',
      scheduledAt: atHour(-1, 12, 30),
      platforms: {
        youtube: { status: 'failed', attempts: 1, videoId: null, error: 'x', publishedAt: null },
        tiktok: { status: 'pending', attempts: 0, videoId: null, error: null, publishedAt: null },
        facebook: { status: 'published', attempts: 0, videoId: 'fb-1', error: null, publishedAt: null }
      },
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z'
    }, {
      id: 'job_2',
      clusterId: 'cluster_a',
      clusterName: 'Cụm A',
      videoPath: 'D:/v2.mp4',
      thumbnailPath: null,
      title: 'Tập 2',
      description: '',
      scheduledAt: atHour(0, 19, 30),
      platforms: {
        youtube: { status: 'pending', attempts: 0, videoId: null, error: null, publishedAt: null },
        tiktok: { status: 'pending', attempts: 0, videoId: null, error: null, publishedAt: null },
        facebook: { status: 'pending', attempts: 0, videoId: null, error: null, publishedAt: null }
      },
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z'
    }]
  };
}

function enqueueResult() {
  return { accepted: 1, duplicates: [], summary: overview() };
}

describe('createSocialService', () => {
  it('đường dẫn REST đúng từng động tác (gồm reschedule + downloads)', async () => {
    const { calls, client } = fakeClient();
    const service = createSocialService(client);
    await service.getOverview();
    await service.createCluster({ name: 'C' });
    await service.updateCluster('a1', { name: 'C2' });
    await service.deleteCluster('a1');
    await service.checkClusterProxy('a1');
    await service.openClusterBrowser('a1');
    await service.closeClusterBrowser('a1');
    await service.enqueue([]);
    await service.rescheduleJob('j1', '2026-10-21T12:30:00.000Z');
    await service.removeJob('j1');
    await service.retryFailedPlatforms('j1');
    await service.pauseQueue();
    await service.resumeQueue();
    await service.listDownloads();
    await service.listDownloads(50);
    await service.getStats();
    await service.refreshStats();
    await service.listComments('cluster_a', 50);
    await service.scanComments('cluster_a');
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /social/overview',
      'POST /social/clusters',
      'PATCH /social/clusters/a1',
      'DELETE /social/clusters/a1',
      'POST /social/clusters/a1/check-proxy',
      'POST /social/clusters/a1/open-browser',
      'POST /social/clusters/a1/close-browser',
      'POST /social/jobs',
      'PATCH /social/jobs/j1',
      'DELETE /social/jobs/j1',
      'POST /social/jobs/j1/retry-failed',
      'POST /social/queue/pause',
      'POST /social/queue/resume',
      'GET /social/downloads?limit=500',
      'GET /social/downloads?limit=50',
      'GET /social/stats',
      'POST /social/stats/refresh',
      'GET /social/comments?clusterId=cluster_a&limit=50',
      'POST /social/comments/scan'
    ]);
    const patch = calls.find(call => call.method === 'PATCH' && call.path === '/social/jobs/j1');
    expect(patch?.body).toEqual({ scheduledAt: '2026-10-21T12:30:00.000Z' });
  });
});

describe('SocialWorkspace — tab Lịch đăng', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('hiển thị chip lịch theo ngày và mở sửa nhanh', async () => {
    const { calls, client } = fakeClient();
    render(
      <LanguageProvider initialPreference="vi-VN">
        <SocialWorkspace service={createSocialService(client)} onBack={vi.fn()} />
      </LanguageProvider>
    );
    await waitFor(() => expect(screen.getByText('Tập 2')).toBeInTheDocument());
    // Tab mặc định là Lịch đăng
    expect(screen.getByRole('tab', { name: 'Lịch đăng' })).toHaveAttribute('aria-selected', 'true');

    // Bấm chip → modal sửa nhanh với giờ đăng
    fireEvent.click(screen.getByText('Tập 2'));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Sửa nhanh bài đăng' })).toBeInTheDocument());
    const timeInput = screen.getByLabelText('Giờ đăng') as HTMLInputElement;
    expect(timeInput.value).toContain('T19:30');
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Sửa nhanh bài đăng' })).getByRole('button', { name: 'Áp dụng' }));
    await waitFor(() => {
      const patch = calls.find(call => call.method === 'PATCH' && call.path === '/social/jobs/job_2');
      expect(patch).toBeDefined();
      expect(Object.keys((patch!.body as Record<string, unknown>))).toEqual(['scheduledAt']);
    });
  });

  it('kéo-thả chip sang ô ngày khác gọi PATCH /social/jobs/:id; job đã đăng bị chặn', async () => {
    const { calls, client } = fakeClient();
    render(
      <LanguageProvider initialPreference="vi-VN">
        <SocialWorkspace service={createSocialService(client)} onBack={vi.fn()} />
      </LanguageProvider>
    );
    await waitFor(() => expect(screen.getByText('Tập 2')).toBeInTheDocument());
    const sourceKey = dayKey(new Date(overview().jobs[1]!.scheduledAt));
    const weekDays = eachDay(startOfWeek(new Date()), 7);
    const target = weekDays.find(day => dayKey(day) !== sourceKey)!;
    const cell = screen.getByTestId(`social-cal-cell-${dayKey(target)}`);

    // Job đã đăng (Tập 1, facebook published) → drop không tạo PATCH
    fireEvent.drop(cell, { dataTransfer: { getData: () => 'job_1' } });
    expect(calls.some(call => call.method === 'PATCH' && call.path === '/social/jobs/job_1')).toBe(false);

    // Job chưa đăng (Tập 2) → reschedule, giữ nguyên giờ trong ngày
    fireEvent.drop(cell, { dataTransfer: { getData: () => 'job_2' } });
    await waitFor(() => {
      const patch = calls.find(call => call.method === 'PATCH' && call.path === '/social/jobs/job_2');
      expect(patch).toBeDefined();
      const iso = (patch!.body as { scheduledAt: string }).scheduledAt;
      expect(new Date(iso).getHours()).toBe(19);
      expect(new Date(iso).getDate()).toBe(target.getDate());
    });
  });
});

describe('SocialWorkspace — tab Hàng đợi', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('hiển thị chip trạng thái và xếp video vào hàng đợi', async () => {
    const { calls, client } = fakeClient();
    render(
      <LanguageProvider initialPreference="vi-VN">
        <SocialWorkspace service={createSocialService(client)} onBack={vi.fn()} />
      </LanguageProvider>
    );
    fireEvent.click(screen.getByRole('tab', { name: /Hàng đợi/ }));
    await waitFor(() => expect(screen.getByLabelText('Vị trí video (MP4)')).toBeInTheDocument());
    // Chip trạng thái từng nền tảng (job_1: youtube failed)
    expect(screen.getByText('Thất bại')).toBeInTheDocument();
    expect(screen.getByText('Đã đăng')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Chạy lại lỗi/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Vị trí video (MP4)'), { target: { value: 'D:/new.mp4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Xếp vào hàng đợi' }));
    await waitFor(() => {
      const enqueue = calls.find(call => call.method === 'POST' && call.path === '/social/jobs');
      expect(enqueue).toBeDefined();
      expect((enqueue!.body as { items: Array<{ path: string; clusterId: string }> }).items[0]).toMatchObject({
        clusterId: 'cluster_a',
        path: 'D:/new.mp4'
      });
    });
  });
});

describe('SocialWorkspace — composer đa kênh', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('tiêu thụ hand-off từ hàng đợi tải phim: mở sẵn composer với video đã chọn', async () => {
    const { client } = fakeClient();
    setPendingSocialHandoffSource({ path: 'D:/downloads/tap-5.mp4', title: 'Tập 5' });
    render(
      <LanguageProvider initialPreference="vi-VN">
        <SocialWorkspace service={createSocialService(client)} onBack={vi.fn()} />
      </LanguageProvider>
    );
    await waitFor(() => {
      const input = screen.getByLabelText('Vị trí video (MP4)') as HTMLInputElement;
      expect(input.value).toBe('D:/downloads/tap-5.mp4');
    });
    // media picker đã nạp danh sách video đã tải
    expect(screen.getByText('Tập 5')).toBeInTheDocument();
    // hand-off bị tiêu thụ (one-shot): lần sau peek không còn giá trị
    expect(peekPendingSocialHandoffSource()).toBeUndefined();
  });

  it('gửi items đúng contract: 1 cụm → 1 item kèm platformSettings', async () => {
    const { calls, client } = fakeClient();
    render(
      <LanguageProvider initialPreference="vi-VN">
        <SocialWorkspace service={createSocialService(client)} onBack={vi.fn()} />
      </LanguageProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tạo bài đăng' }));
    const dialog = await screen.findByRole('dialog', { name: 'Soạn bài đăng đa kênh' });

    fireEvent.change(within(dialog).getByLabelText('Vị trí video (MP4)'), { target: { value: 'D:/downloads/tap-5.mp4' } });
    const checkbox = await waitFor(() => within(dialog).getByRole('checkbox', { name: 'Long Hổ Riệu' }));
    fireEvent.click(checkbox);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tạo 1 bài đăng' }));

    await waitFor(() => {
      const enqueue = calls.find(call => call.method === 'POST' && call.path === '/social/jobs');
      expect(enqueue).toBeDefined();
      const body = enqueue!.body as { items: Array<Record<string, unknown>> };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        clusterId: 'cluster_a',
        path: 'D:/downloads/tap-5.mp4',
        platformSettings: {
          youtube: { privacy: 'public' },
          tiktok: { privacy: 'public', allowDuet: true, allowStitch: true, allowComments: true, directPost: false },
          facebook: { postType: 'post' }
        }
      });
    });
    expect(screen.queryByRole('dialog', { name: 'Soạn bài đăng đa kênh' })).not.toBeInTheDocument();
  });
});

describe('SocialWorkspace — tab Thống kê + Bình luận', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('thống kê hiện bảng follower, bình luận hiện luồng AI trả lời', async () => {
    const { client } = fakeClient();
    render(
      <LanguageProvider initialPreference="vi-VN">
        <SocialWorkspace service={createSocialService(client)} onBack={vi.fn()} />
      </LanguageProvider>
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Thống kê' }));
    await waitFor(() => expect(screen.getByText('Cụm A')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Bình luận' }));
    await waitFor(() => expect(screen.getByText(/Tập 17 hay quá!/)).toBeInTheDocument());
    expect(screen.getByText('AI đã trả')).toBeInTheDocument();
  });
});
