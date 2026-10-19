import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocialService } from './social-service.js';
import SocialWorkspace from '../features/dashboard/SocialWorkspace.js';
import { LanguageProvider } from '../i18n/LanguageProvider.js';
import {
  peekPendingSocialHandoffSource,
  setPendingSocialHandoffSource
} from '../features/dashboard/pending-social-handoff.js';

type Call = { method: string; path: string; body?: unknown };

function fakeClient() {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async get(path: string) {
        calls.push({ method: 'GET', path });
        return path === '/social/stats' ? stats()
          : path === '/social/comments' ? [{
              id: 1, jobId: 'job_1', clusterId: 'cluster_a', clusterName: 'Cụm A',
              platform: 'facebook', externalVideoId: 'fb-1', externalCommentId: 'cmt-1',
              author: 'Mai', text: 'Tập 17 hay quá!', commentCreatedAt: null,
              createdAt: '2026-10-19T09:00:00.000Z', replyStatus: 'sent',
              replyText: 'Cảm ơn bạn nhiều!', repliedAt: '2026-10-19T09:05:00.000Z', skippedReason: null
            }] as never
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

function overview() {
  return {
    queue: 'running',
    counts: { pending: 3, running: 0, published: 0, scheduled: 0, failed: 1, skipped: 0 },
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
      scheduledAt: '2026-10-20T12:30:00.000+07:00',
      platforms: {
        youtube: { status: 'failed', attempts: 1, videoId: null, error: 'x', publishedAt: null },
        tiktok: { status: 'pending', attempts: 0, videoId: null, error: null, publishedAt: null },
        facebook: { status: 'published', attempts: 0, videoId: 'fb-1', error: null, publishedAt: null }
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
  it('đường dẫn REST đúng từng động tác', async () => {
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
    await service.removeJob('j1');
    await service.retryFailedPlatforms('j1');
    await service.pauseQueue();
    await service.resumeQueue();
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
      'DELETE /social/jobs/j1',
      'POST /social/jobs/j1/retry-failed',
      'POST /social/queue/pause',
      'POST /social/queue/resume',
      'GET /social/stats',
      'POST /social/stats/refresh',
      'GET /social/comments?clusterId=cluster_a&limit=50',
      'POST /social/comments/scan'
    ]);
  });
});

describe('SocialWorkspace', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('hiển thị cụm + job và xếp thêm video vào cụm', async () => {
    const { calls, client } = fakeClient();
    render(
      <LanguageProvider initialPreference="vi-VN">
        <SocialWorkspace service={createSocialService(client)} onBack={vi.fn()} />
      </LanguageProvider>
    );
    await waitFor(() => expect(screen.getAllByText(/Long Hổ Riệu/).length).toBeGreaterThan(0));
    // Job row: hiển thị chip nền tảng trạng thái
    expect(screen.getByText('Thất bại')).toBeInTheDocument();
    expect(screen.getByText('Đã đăng')).toBeInTheDocument();

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

  it('tiêu thụ hand-off từ hàng đợi tải phim', async () => {
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
    // hand-off bị tiêu thụ (one-shot): lần sau peek không còn giá trị
    expect(peekPendingSocialHandoffSource()).toBeUndefined();
  });
});
