/**
 * Kiểm thử B1 — cột "Xu hướng" (sparkline SVG) trong SocialStatsPanel:
 * ≥2 điểm → vẽ polyline; 0–1 điểm → cột ẩn. Dữ liệu fake, không gọi daemon.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SocialStatsPanel } from './social-insights.js';
import type { SocialService, SocialStatsOverview } from '../../services/social-service.js';
import type { Translate } from '../../i18n/LanguageProvider.js';

/** t giả: trả về chính key (dễ assert). */
const t = ((key: string) => key) as unknown as Translate;

function fakeService(statsData: SocialStatsOverview): SocialService {
  return {
    getStats: async () => statsData,
    refreshStats: async () => statsData,
    listComments: async () => [],
    scanComments: async () => ({
      clustersScanned: 0, videosScanned: 0, newComments: 0, repliesAttempted: 0, repliesSent: 0, errors: []
    })
  } as never as SocialService;
}

function statsWith(history: SocialStatsOverview['history']): SocialStatsOverview {
  return {
    channels: [{
      clusterId: 'cluster_a',
      clusterName: 'Cụm A',
      platform: 'facebook',
      metrics: { followers: { value: 150, capturedAt: '2026-10-18T08:00:00.000Z', previous: 100 } }
    }],
    videos: [],
    history,
    lastRefreshAt: '2026-10-18T08:00:00.000Z',
    refreshError: null
  };
}

describe('SocialStatsPanel — sparkline xu hướng (SVG thuần)', () => {
  it('≥2 điểm → hiện cột Xu hướng + polyline, màu theo chiều tăng/giảm', async () => {
    const service = fakeService(statsWith([
      {
        clusterId: 'cluster_a', platform: 'facebook', metric: 'followers',
        points: [
          { value: 100, capturedAt: '2026-10-16T08:00:00.000Z' },
          { value: 150, capturedAt: '2026-10-17T08:00:00.000Z' }
        ]
      },
      {
        // Chuỗi giảm — không khớp channel trên bảng nhưng vẫn nằm trong history.
        clusterId: 'cluster_b', platform: 'youtube', metric: 'followers',
        points: [
          { value: 900, capturedAt: '2026-10-16T08:00:00.000Z' },
          { value: 800, capturedAt: '2026-10-17T08:00:00.000Z' }
        ]
      }
    ]));
    const { container } = render(<SocialStatsPanel service={service} t={t} refreshKey={0} />);

    await screen.findByText('dashboard.social.trendColumn');
    const sparks = container.querySelectorAll('svg.social-spark polyline');
    expect(sparks.length).toBeGreaterThanOrEqual(1);
    // Đường của Cụm A tăng → class social-spark-up.
    const upSpark = container.querySelector('svg.social-spark-up polyline');
    expect(upSpark).not.toBeNull();
    const spark = container.querySelector('svg.social-spark');
    expect(spark?.getAttribute('width')).toBe('80');
    expect(spark?.getAttribute('height')).toBe('24');
    await waitFor(() => {
      expect(screen.getByText('Cụm A')).toBeInTheDocument();
    });
  });

  it('0–1 điểm → ẩn cột Xu hướng, không vẽ sparkline', async () => {
    const service = fakeService(statsWith([
      {
        clusterId: 'cluster_a', platform: 'facebook', metric: 'followers',
        points: [{ value: 150, capturedAt: '2026-10-17T08:00:00.000Z' }]
      }
    ]));
    const { container } = render(<SocialStatsPanel service={service} t={t} refreshKey={0} />);

    await screen.findByText('Cụm A');
    expect(screen.queryByText('dashboard.social.trendColumn')).toBeNull();
    expect(container.querySelector('svg.social-spark')).toBeNull();
  });

  it('history thiếu (server cũ) → ẩn cột Xu hướng, bảng vẫn hiện bình thường', async () => {
    const service = fakeService(statsWith(undefined));
    const { container } = render(<SocialStatsPanel service={service} t={t} refreshKey={0} />);

    await screen.findByText('Cụm A');
    expect(screen.queryByText('dashboard.social.trendColumn')).toBeNull();
    expect(container.querySelector('svg.social-spark')).toBeNull();
  });

  it('≥3 điểm → block tổng quan có sparkline lớn 160×48 cho followers cụm', async () => {
    const service = fakeService(statsWith([
      {
        clusterId: 'cluster_a', platform: 'facebook', metric: 'followers',
        points: [
          { value: 90, capturedAt: '2026-10-15T08:00:00.000Z' },
          { value: 120, capturedAt: '2026-10-16T08:00:00.000Z' },
          { value: 150, capturedAt: '2026-10-17T08:00:00.000Z' }
        ]
      }
    ]));
    const { container } = render(<SocialStatsPanel service={service} t={t} refreshKey={0} />);

    await screen.findByText('dashboard.social.trendColumn');
    // Cột bảng (80×24) + block tổng quan (160×48) cùng lúc.
    const sizes = [...container.querySelectorAll('svg.social-spark')].map(
      svg => `${svg.getAttribute('width')}x${svg.getAttribute('height')}`
    );
    expect(sizes).toContain('160x48');
    expect(sizes).toContain('80x24');
    // Giảm điểm → điểm cuối < điểm đầu → đỏ (social-spark-down) không xuất hiện.
    expect(container.querySelector('svg.social-spark-down')).toBeNull();
  });
});
