import {
  normalizeVideoSourceUrl,
  supportedVideoSourcePlatform,
  videoSourceIdentity,
  type CreatorJob
} from '@opencreator/protocol';

export const DOWNLOAD_BATCH_PARENT = 'downloadBatchId';
export const DOWNLOAD_BATCH_HIDDEN = 'downloadBatchHiddenJobIds';

export type DownloadSource = {
  id: string;
  job: CreatorJob;
  url: string;
  title: string;
  thumbnail?: string;
  thumbnailArtifactId?: string;
  /** Nhận dạng bộ phim/series mà link này thuộc về (từ probe của daemon). */
  seriesId?: string;
  /** Tên bộ phim/series hiển thị trên hàng cha khi gộp theo phim. */
  seriesName?: string;
  status: 'waiting' | 'analyzing' | 'ready' | 'downloading' | 'completed' | 'failed' | 'canceled';
  percent?: number;
};

export function downloadSourceIdentity(value: string): string {
  const normalized = normalizeVideoSourceUrl(value);
  return videoSourceIdentity(normalized) ?? normalized;
}

export function parseDownloadLink(value: string): { url: string; error?: never } | { error: 'multiple' | 'invalid'; url?: never } {
  // Check before normalization, which can extract a single URL from share text.
  if ((value.match(/[a-z][a-z\d+.-]*:\/\//gi) ?? []).length > 1) return { error: 'multiple' };
  const url = normalizeVideoSourceUrl(value);
  return supportedVideoSourcePlatform(url) === null ? { error: 'invalid' } : { url };
}

export function downloadSourceForJob(job: CreatorJob): DownloadSource | undefined {
  const url = typeof job.state.sourceUrl === 'string' ? job.state.sourceUrl.trim() : '';
  if (!url) return undefined;
  const probe = [...job.artifacts].reverse().find(artifact => (
    artifact.kind === 'download_probe'
    && artifact.status === 'completed'
    && typeof artifact.metadata.requestedUrl === 'string'
    && downloadSourceIdentity(artifact.metadata.requestedUrl) === downloadSourceIdentity(url)
  ));
  const active = job.stages.filter(stage => stage.status === 'queued' || stage.status === 'running');
  const downloading = active.find(stage => stage.stageId === 'download');
  const latest = job.stages.at(-1);
  const completed = job.artifacts.some(artifact => artifact.status === 'completed'
    && (artifact.kind === 'source_video' || artifact.kind === 'source_audio'));
  const seriesId = metadataText(probe?.metadata.seriesId);
  const seriesName = metadataText(probe?.metadata.seriesName)
    ?? seriesTitleFromName(metadataText(probe?.metadata.title));
  return {
    id: job.id, job, url,
    title: typeof probe?.metadata.title === 'string' ? probe.metadata.title : url,
    ...(seriesId !== undefined ? { seriesId } : {}),
    ...(seriesName !== undefined ? { seriesName } : {}),
    ...(typeof probe?.metadata.thumbnailUrl === 'string' ? { thumbnail: probe.metadata.thumbnailUrl, thumbnailArtifactId: probe.id } : {}),
    status: downloading !== undefined ? 'downloading'
      : active.some(stage => stage.stageId === 'probe') ? 'analyzing'
        : latest?.status === 'failed' ? 'failed'
          : latest?.status === 'canceled' || latest?.status === 'interrupted' ? 'canceled'
            : completed ? 'completed' : probe !== undefined ? 'ready' : 'waiting',
    ...(typeof downloading?.progress.percent === 'number'
      ? { percent: Math.min(100, Math.max(0, downloading.progress.percent)) } : {})
  };
}

export function hiddenDownloadJobIds(job: CreatorJob): string[] {
  const value = job.state[DOWNLOAD_BATCH_HIDDEN];
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

function metadataText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Suy ra tên bộ phim từ tiêu đề từng tập khi nguồn không khai báo series:
 * "Phim A - Tập 002" → "Phim A"; trả về null khi tiêu đề không mang số tập.
 */
export function seriesTitleFromName(title: string | undefined): string | undefined {
  const trimmed = title?.trim() ?? '';
  if (trimmed === '') return undefined;
  for (const pattern of EPISODE_TITLE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match === null) continue;
    const name = match[1]!.replace(/\s*[-–—_.:|~]+\s*$/, '').trim();
    if (name === '' || name === trimmed) return undefined;
    return name;
  }
  return undefined;
}

const EPISODE_TITLE_PATTERNS = [
  /^(.+?)\s*[-–—_.:|~]?\s*第\s*\d+\s*[集期话]\s*$/,
  /^(.+?)\s*[-–—_.:|~]?\s*(?:tập|tap|phần|phan|part|ep|episode|q|s)\s*[.#]?\s*\d{1,4}\s*$/i,
  /^(.+?)\s*[-–—_.:|~]?\s*\(\s*(?:s\d{1,3}\s*)?e(?:p)?\s*\d{1,4}\s*\)\s*$/i,
  /^(.+?)\s*[-–—_.:|~]?\s*\bS\d{1,3}E\d{1,4}\b\s*$/i,
  /^(.+?)\s*[-–—_.:|~]?\s*(?<!\p{L})P\s*\d{1,4}\s*$/u
];

/** Khóa gộp nhóm theo phim: ưu tiên seriesId từ daemon, suy từ tên tập khi thiếu. */
export function downloadSeriesKey(series: { seriesId?: string; seriesName?: string } | undefined): string | undefined {
  const id = series?.seriesId?.trim();
  if (id !== undefined && id !== '') return `id:${id}`;
  const name = series?.seriesName?.trim();
  return name !== undefined && name !== '' ? `name:${name.toLocaleLowerCase()}` : undefined;
}
