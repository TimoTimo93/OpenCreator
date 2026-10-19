import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeVideoSegments, probeStreamSpec, type SegmentSpec } from './merge.js';

/**
 * Ghép toàn bộ các tập ĐÃ DỊCH XONG của một lần "dịch cả bộ" thành một file
 * "full movie" duy nhất trong thư mục dự án: `<Tên phim>-full.mp4`.
 *
 * - Tên file được làm sạch theo quy tắc Windows (cấm \ / : * ? " < > |, giữ
 *   nguyên chữ tiếng Việt có dấu);
 * - ≥ 2 phân đoạn → tái dùng `mergeVideoSegments` (concat demuxer -c copy khi
 *   cùng chuẩn; re-encode đúng phân đoạn lệch chuẩn);
 * - đúng 1 phân đoạn → copy sang tên full movie (không cần ffmpeg);
 * - ghi vào file tạm rồi rename để không bao giờ để lại file dở dang.
 */

export type FullMovieMergeReport = {
  outputPath: string;
  durationSeconds: number;
  segmentCount: number;
  reencodedPositions: number[];
};

/** Ký tự cấm trong tên file Windows + ký tự điều khiển. */
/** Tên thiết bị dành riêng của Windows (không được dùng làm tên file). */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeWindowsFileName(value: string, fallback = 'untitled'): string {
  const cleaned = value
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-\s]+/u, '')
    .replace(/[-\s.]+$/u, '')
    .trim();
  const guarded = WINDOWS_RESERVED.test(cleaned) ? `${cleaned}-movie` : cleaned;
  const trimmed = guarded.length > 120 ? guarded.slice(0, 120).trim() : guarded;
  return trimmed.length > 0 ? trimmed : fallback;
}

export function fullMovieFileName(seriesName: string): string {
  return `${sanitizeWindowsFileName(seriesName, 'full-movie')}-full.mp4`;
}

export async function mergeEpisodesToFullMovie(input: {
  ffmpegPath: string;
  ffprobePath: string;
  segments: readonly SegmentSpec[];
  /** Thư mục dự án đặt file kết quả (đã tồn tại hoặc sẽ được tạo). */
  targetDirectory: string;
  /** Tên phim / bộ — dùng đặt tên `<Tên phim>-full.mp4`. */
  seriesName: string;
}): Promise<FullMovieMergeReport> {
  if (input.segments.length === 0) {
    throw new Error('Chưa có tập nào đã dịch xong để ghép full movie');
  }
  await mkdir(input.targetDirectory, { recursive: true });
  const outputPath = join(input.targetDirectory, fullMovieFileName(input.seriesName));
  const temporaryPath = join(
    input.targetDirectory,
    `.${fullMovieFileName(input.seriesName)}.tmp-${process.pid}`
  );
  await rm(temporaryPath, { force: true });
  try {
    if (input.segments.length === 1) {
      // Đúng một tập: không cần ghép — copy sang tên full movie.
      await copyFile(input.segments[0]!.path, temporaryPath);
      const spec = await probeStreamSpec(input.ffprobePath, temporaryPath);
      await rm(outputPath, { force: true });
      await rename(temporaryPath, outputPath);
      return {
        outputPath,
        durationSeconds: spec.durationSeconds,
        segmentCount: 1,
        reencodedPositions: []
      };
    }
    const report = await mergeVideoSegments({
      ffmpegPath: input.ffmpegPath,
      ffprobePath: input.ffprobePath,
      segments: input.segments,
      outputPath: temporaryPath
    });
    await rm(outputPath, { force: true });
    await rename(temporaryPath, outputPath);
    return {
      outputPath,
      durationSeconds: report.durationSeconds,
      segmentCount: input.segments.length,
      reencodedPositions: report.reencodedPositions
    };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export type TranslationBatchProgress = {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  canceled: number;
  /** true khi mọi tập đều đã xong (không còn queued/running). */
  allDone: boolean;
  /** Phần trăm hoàn thành (0–100, làm tròn số nguyên). */
  percent: number;
};

export function batchProgress(items: ReadonlyArray<{ status: string }>): TranslationBatchProgress {
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, canceled: 0 };
  for (const item of items) {
    if (item.status === 'queued') counts.queued += 1;
    else if (item.status === 'running') counts.running += 1;
    else if (item.status === 'completed') counts.completed += 1;
    else if (item.status === 'failed') counts.failed += 1;
    else counts.canceled += 1;
  }
  const total = items.length;
  return {
    ...counts,
    total,
    allDone: total > 0 && counts.queued === 0 && counts.running === 0,
    percent: total === 0 ? 0 : Math.round((counts.completed / total) * 100)
  };
}
