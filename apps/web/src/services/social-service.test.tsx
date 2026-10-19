import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocialService } from './social-service.js';
import type { SocialOverview } from './social-service.js';
import { listTranslatedVideos, translatedVideosFromCreatorJobs } from './social-service.js';
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
      autoPublishAfterTranslate: false,
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

describe('createSocialService — openClusterLogin (đăng nhập tay)', () => {
  it('POST đúng route login từng nền tảng và từ chối nền tảng lạ', async () => {
    const { calls, client } = fakeClient();
    const service = createSocialService(client);
    await service.openClusterLogin('a1', 'youtube');
    await service.openClusterLogin('a1', 'facebook');
    expect(calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual([
      '/social/clusters/a1/login/youtube',
      '/social/clusters/a1/login/facebook'
    ]);
    await expect(service.openClusterLogin('a1', 'threads' as never)).rejects.toThrow(/không hỗ trợ/);
    expect(calls.filter(call => call.method === 'POST' && call.path.includes('/login/'))).toHaveLength(2);
  });
});

describe('video đã dịch xong — lọc creator jobs', () => {
  const creatorJob = (overrides: Partial<Parameters<typeof translatedVideosFromCreatorJobs>[0][number]> = {}) => ({
    id: 'job_trans_1',
    projectId: 'proj_1',
    templateId: 'video-translation',
    status: 'completed',
    artifacts: [{
      id: 'art_h',
      kind: 'horizontal_video',
      version: 1,
      status: 'completed',
      path: 'D:/projects/dich/tap-1.mp4',
      createdAt: '2026-10-19T08:00:00.000Z'
    }],
    ...overrides
  }) as Parameters<typeof translatedVideosFromCreatorJobs>[0][number];

  it('chỉ lấy job video-translation đã completed với artifact video hoàn chỉnh, mới nhất trước', () => {
    const items = translatedVideosFromCreatorJobs([
      creatorJob(),
      // Template khác → bỏ
      creatorJob({ id: 'job_cover', templateId: 'cover' }),
      // Chưa hoàn tất → bỏ
      creatorJob({ id: 'job_running', status: 'running' }),
      // Artifact chưa hoàn tất / không path → bỏ
      creatorJob({
        id: 'job_draft',
        artifacts: [{ id: 'art_draft', kind: 'horizontal_video', version: 1, status: 'draft', path: null, createdAt: '2026-10-19T07:00:00.000Z' }]
      }),
      // Bản dập hoàn tất mới hơn (vertical V2) → đứng đầu
      creatorJob({
        id: 'job_trans_3',
        artifacts: [{
          id: 'art_new', kind: 'vertical_video', version: 2, status: 'completed',
          path: 'D:/projects/dich/v2.mp4', createdAt: '2026-10-19T09:00:00.000Z'
        }]
      })
    ]);
    expect(items.map(item => item.path)).toEqual([
      'D:/projects/dich/v2.mp4',
      'D:/projects/dich/tap-1.mp4'
    ]);
    expect(items[0]).toMatchObject({ title: 'v2.mp4', kind: 'vertical_video', version: 2 });
  });

  it('bỏ trùng đường dẫn (bản sao cũ hơn bị loại)', () => {
    const items = translatedVideosFromCreatorJobs([
      creatorJob({
        artifacts: [{ id: 'art_a', kind: 'horizontal_video', version: 1, status: 'completed', path: 'D:/x/tap-1.mp4', createdAt: '2026-10-19T08:00:00.000Z' }]
      }),
      creatorJob({
        id: 'job_trans_2',
        artifacts: [{ id: 'art_b', kind: 'horizontal_video', version: 2, status: 'stale', path: 'D:/x/tap-1.mp4', createdAt: '2026-10-19T10:00:00.000Z' }]
      })
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ artifactId: 'art_b', version: 2 });
  });

  it('listTranslatedVideos truyền projectId và trả về { items }', async () => {
    const calls: Array<string | undefined> = [];
    const provider = {
      listJobs: async (projectId?: string) => {
        calls.push(projectId);
        return { jobs: [creatorJob()] };
      }
    };
    const result = await listTranslatedVideos(provider, 'proj_1');
    expect(calls).toEqual(['proj_1']);
    expect(result.items).toHaveLength(1);
    expect((await listTranslatedVideos(provider, '  ')).items).toHaveLength(1);
    expect(calls[1]).toBeUndefined();
  });
});

describe('SocialWorkspace — đăng nhập tài khoản trong tab Kênh', () => {
  afterEach(() => {
    localStorage.clear();
    window.location.hash = '';
  });

  it('hiển thị trạng thái đăng nhập 3 nền tảng; nút Đăng nhập gọi POST login/platform', async () => {
    const { calls, client } = fakeClient();
    render(
      <LanguageProvider initialPreference="vi-VN">
        <SocialWorkspace service={createSocialService(client)} onBack={vi.fn()} />
      </LanguageProvider>
    );
    await waitFor(() => expect(screen.getByText('Tập 2')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Kênh' }));
    // Trạng thái: unknown → 'Chưa rõ' (youtube/tiktok/facebook đều unknown trong fixture)
    await waitFor(() => expect(screen.getAllByText(/Chưa rõ/)).toHaveLength(3));
    fireEvent.click(screen.getByTestId('social-login-status-cluster_a-youtube').closest('.social-login-entry')!.querySelector('button')!);
    await waitFor(() => {
      const login = calls.find(call => call.method === 'POST' && call.path === '/social/clusters/cluster_a/login/youtube');
      expect(login).toBeDefined();
    });
    expect(await screen.findByText(/Đã mở trang đăng nhập/)).toBeInTheDocument();
  });
});

describe('SocialWorkspace — công tắc tự nạp đăng sau dịch (tab Kênh)', () => {
  afterEach(() => {
    localStorage.clear();
    window.location.hash = '';
  });

  it('toggle hiện trạng thái cụm; bật → PATCH updateCluster với autoPublishAfterTranslate', async () => {
    const { calls, client } = fakeClient();
    render(
      <LanguageProvider initialPreference="vi-VN">
        <SocialWorkspace service={createSocialService(client)} onBack={vi.fn()} />
      </LanguageProvider>
    );
    await waitFor(() => expect(screen.getByText('Tập 2')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Kênh' }));
    const toggle = await screen.findByTestId('social-autopublish-cluster_a') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => {
      const patch = calls.find(call => call.method === 'PATCH' && call.path === '/social/clusters/cluster_a');
      expect(patch).toBeDefined();
      expect((patch!.body as { autoPublishAfterTranslate?: boolean }).autoPublishAfterTranslate).toBe(true);
    });
    expect(await screen.findByText('Đã lưu trạng thái tự nạp đăng')).toBeInTheDocument();
  });
});

describe('SocialWorkspace — composer nguồn "Video đã dịch"', () => {
  afterEach(() => {
    localStorage.clear();
  });

  function fakeCreatorService(jobs: unknown[], calls: Array<string | undefined> = []) {
    return {
      listJobsCalls: calls,
      listJobs: async (projectId?: string) => {
        calls.push(projectId);
        return { jobs };
      }
    } as never;
  }

  it('tab "Video đã dịch" là mặc định, chọn video điền path; fallback không creatorService chỉ còn tải về', async () => {
    const { client } = fakeClient();
    render(
      <LanguageProvider initialPreference="vi-VN">
        <SocialWorkspace
          service={createSocialService(client)}
          creatorService={fakeCreatorService([
            {
              id: 'job_trans_1', templateId: 'video-translation', status: 'completed',
              artifacts: [{ id: 'art_1', kind: 'horizontal_video', version: 1, status: 'completed', path: 'D:/dich/tap-1.mp4', createdAt: '2026-10-19T08:00:00.000Z' }]
            }
          ])}
          projectId="proj_1"
          onBack={vi.fn()}
        />
      </LanguageProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tạo bài đăng' }));
    const dialog = await screen.findByRole('dialog', { name: 'Soạn bài đăng đa kênh' });
    // Tab mặc định là "Video đã dịch"
    const translatedTab = within(dialog).getByRole('tab', { name: 'Video đã dịch' });
    expect(translatedTab).toHaveAttribute('aria-selected', 'true');
    // Job dịch hoàn tất xuất hiện trong picker (từ creatorService.listJobs)
    fireEvent.click(within(dialog).getByRole('button', { name: /tap-1\.mp4/ }));
    const pathInput = within(dialog).getByLabelText('Vị trí video (MP4)') as HTMLInputElement;
    expect(pathInput.value).toBe('D:/dich/tap-1.mp4');
    expect(await screen.findByText('Soạn bài đăng đa kênh')).toBeInTheDocument();
  });

  it('composer khi không có creatorService chỉ còn nút "Video tải về" (không crash)', async () => {
    const { client } = fakeClient();
    render(
      <LanguageProvider initialPreference="vi-VN">
        <SocialWorkspace service={createSocialService(client)} onBack={vi.fn()} />
      </LanguageProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tạo bài đăng' }));
    const dialog = await screen.findByRole('dialog', { name: 'Soạn bài đăng đa kênh' });
    expect(within(dialog).queryByRole('tab', { name: 'Video đã dịch' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Tập 5')).toBeInTheDocument();
  });
});
