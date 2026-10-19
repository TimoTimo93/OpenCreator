import { describe, expect, it } from 'vitest';
import {
  matchClusterByName,
  parseCsvToRows,
  rowsToSocialItems,
  SOCIAL_EXCEL_TEMPLATE_CSV
} from './social-excel.js';
import type { SocialClusterSummary } from '../../services/social-service.js';

function cluster(name: string, seriesName: string): SocialClusterSummary {
  return {
    id: `cluster_${name}`, name, seriesName,
    proxyServer: '', proxyStatus: 'no_proxy', proxyDetail: null,
    fbMode: 'graph_api', fbPageId: '', fbPageTokenConfigured: false,
    defaultScheduleTimes: ['19:30'], defaultDescription: '',
    ytChannelUrl: '', tkProfileUrl: '', autoReplyEnabled: false, autoReplyPrompt: '',
    autoPublishAfterTranslate: false,
    loginStatus: { youtube: 'unknown', tiktok: 'unknown', facebook: 'unknown' },
    browserOpen: false, createdAt: '', updatedAt: ''
  };
}

describe('social excel — parse CSV khử BOM + ngoặc kép', () => {
  it('', () => {
    const csv = SOCIAL_EXCEL_TEMPLATE_CSV.replace('cluster,path,title,description,hẹn,thumbnail',
      'cluster,path,title,description,hen,thumbnail');
    const table = parseCsvToRows(csv);
    expect(table.length).toBeGreaterThanOrEqual(3);
    const parsed = rowsToSocialItems(table[0]!, table.slice(1));
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.invalid).toBe(0);
    expect(parsed.rows[0]!.path).toBe('D:/videos/tap-1.mp4');
    expect(parsed.rows[0]!.title).toBe('Tập 1');
    expect(parsed.rows[0]!.scheduledAt).toBe('2026-10-20T19:30:00'.replace('2026', String(new Date().getFullYear())));
  });

  it('', () => {
    const parsed = rowsToSocialItems(['cluster', 'path', 'title'], [['Web Phim', 'D:/a.mp4', 'T1'], ['Thiếu path', '', 'T2']]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.invalid).toBe(1);
  });

  it('', () => {
    const clusters = [cluster('Cluster Phim', 'Web Phim Hay')];
    expect(matchClusterByName(clusters, 'web phim hay')?.id).toBe('cluster_Cluster Phim');
    expect(matchClusterByName(clusters, 'Cluster Phim')?.id).toBe('cluster_Cluster Phim');
    expect(matchClusterByName(clusters, 'Không có')).toBeNull();
  });
});
