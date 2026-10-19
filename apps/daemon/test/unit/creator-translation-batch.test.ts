import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTranslationBatchRoutes } from '../../src/api/routes.translation-batch.js';
import type { TranslationPipelineService } from '../../src/creator/translation-pipeline/pipeline.js';
import { parseEpisodeIndex } from '../../src/creator/translation-pipeline/episode-index.js';
import {
  batchProgress,
  fullMovieFileName,
  sanitizeWindowsFileName
} from '../../src/creator/translation-pipeline/batch-merge.js';

let server: FastifyInstance | undefined;
let root = '';

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

function fakePipeline(items: Array<Record<string, unknown>> = []): TranslationPipelineService {
  return {
    getSummary: () => ({
      items: items as never,
      paused: false,
      merge: {
        status: 'idle', runId: null, outputPath: null, uploadReady: null,
        episodeCount: null, skipped: [], error: null
      },
      uploadFolder: join(root, 'upload-pending'),
      counts: {
        queued: items.filter(item => item.status === 'queued').length,
        running: items.filter(item => item.status === 'running').length,
        completed: items.filter(item => item.status === 'completed').length,
        failed: items.filter(item => item.status === 'failed').length
      }
    }),
    enqueue: vi.fn(() => { throw new Error('not used in route test'); }),
    pause: vi.fn(),
    resume: vi.fn(),
    remove: vi.fn(),
    retry: vi.fn(),
    clearFinished: vi.fn(),
    mergeNow: vi.fn(),
    recover: async () => undefined,
    close: async () => undefined
  } as unknown as TranslationPipelineService;
}

describe('translation batch routes', () => {
  it('returns 503 when the pipeline is not wired', async () => {
    server = Fastify();
    await registerTranslationBatchRoutes(server, {});
    const response = await server.inject({ method: 'GET', url: '/creator/translation-batch' });
    expect(response.statusCode).toBe(503);
  });

  it('exposes progress and validates enqueue payloads', async () => {
    server = Fastify();
    await registerTranslationBatchRoutes(server, {
      pipeline: fakePipeline([
        { id: 'a', status: 'completed', episodeIndex: 1, outputVideoPath: join(root, '1.mp4'), addedAt: '2026-01-01T00:00:00.000Z', title: 'Tập 1' },
        { id: 'b', status: 'queued', episodeIndex: 2, outputVideoPath: null, addedAt: '2026-01-01T00:01:00.000Z', title: 'Tập 2' }
      ])
    });
    const status = await server.inject({ method: 'GET', url: '/creator/translation-batch' });
    expect(status.statusCode).toBe(200);
    expect(status.json().progress).toMatchObject({ total: 2, completed: 1, allDone: false, percent: 50 });
    const invalid = await server.inject({ method: 'POST', url: '/creator/translation-batch/enqueue', payload: { items: [] } });
    expect(invalid.statusCode).toBe(400);
  });

  it('refuses a merge when nothing is completed and reveals legacy export paths', async () => {
    root = await mkdtemp(join(tmpdir(), 'opencreator-batch-routes-'));
    server = Fastify();
    const reveal = vi.fn(async () => undefined);
    await registerTranslationBatchRoutes(server, {
      pipeline: fakePipeline(),
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      resolveProjectFolder: () => ({ folder: join(root, 'project'), projectName: 'Bộ Phim' }),
      reveal
    });
    const empty = await server.inject({ method: 'POST', url: '/creator/translation-batch/merge', payload: {} });
    expect(empty.statusCode).toBe(409);

    // Bản cũ: file nằm ở gốc V1 (không có thư mục con video/).
    const legacyFile = join(root, 'project', 'job-1', 'V1', 'Tập 01.mp4');
    await mkdir(join(root, 'project', 'job-1', 'V1'), { recursive: true });
    await writeFile(legacyFile, 'video');
    const revealed = await server.inject({
      method: 'POST',
      url: '/creator/translation-batch/reveal',
      payload: { path: join(root, 'project', 'job-1', 'V1', 'video', 'Tập 01.mp4'), mode: 'file' }
    });
    expect(revealed.statusCode).toBe(200);
    expect(reveal).toHaveBeenCalledWith({ absolutePath: legacyFile, mode: 'file' });
  });
});

import {
  batchProgress,
  fullMovieFileName,
  sanitizeWindowsFileName
} from '../../src/creator/translation-pipeline/batch-merge.js';

describe('translation batch helpers', () => {
  it('extracts the episode index from common file/title patterns', () => {
    expect(parseEpisodeIndex('Tập 01.mp4')).toBe(1);
    expect(parseEpisodeIndex('tap 3 - phim hay.mp4')).toBe(3);
    expect(parseEpisodeIndex('EP12 final.mp4')).toBe(12);
    expect(parseEpisodeIndex('E07.mp4')).toBe(7);
    expect(parseEpisodeIndex('Phim.Com.S01E02.1080p.mp4')).toBe(2);
    expect(parseEpisodeIndex('第03集')).toBe(3);
    expect(parseEpisodeIndex('KieuThiNhiemMieng.mp4', 'video 05')).toBe(5);
    expect(parseEpisodeIndex('phimbo-tap-07.mp4')).toBe(7);
  });

  it('returns null when no episode pattern matches', () => {
    expect(parseEpisodeIndex('movie.mp4')).toBeNull();
    expect(parseEpisodeIndex(undefined, '')).toBeNull();
    expect(parseEpisodeIndex('4k resolution showcase.mp4')).toBeNull();
    expect(parseEpisodeIndex('Tập 0.mp4')).toBeNull();
  });

  it('sanitizes Windows-forbidden characters but keeps Vietnamese unicode', () => {
    expect(sanitizeWindowsFileName('Phim<Tập:1>?')).toBe('Phim-Tập-1');
    expect(sanitizeWindowsFileName('  tên phim  ')).toBe('tên phim');
    expect(sanitizeWindowsFileName('CON')).toBe('CON-movie');
    expect(sanitizeWindowsFileName('***')).toBe('untitled');
    expect(sanitizeWindowsFileName('', 'fallback')).toBe('fallback');
  });

  it('builds the full-movie file name', () => {
    expect(fullMovieFileName('MộcQuanHoa')).toBe('MộcQuanHoa-full.mp4');
    expect(fullMovieFileName('a/b:c')).toBe('a-b-c-full.mp4');
  });

  it('summarizes batch progress', () => {
    const progress = batchProgress([
      { status: 'completed' },
      { status: 'completed' },
      { status: 'running' },
      { status: 'queued' },
      { status: 'failed' }
    ]);
    expect(progress).toMatchObject({
      total: 5,
      completed: 2,
      running: 1,
      queued: 1,
      failed: 1,
      allDone: false,
      percent: 40
    });
    expect(batchProgress([{ status: 'completed' }]).allDone).toBe(true);
    expect(batchProgress([]).allDone).toBe(false);
  });
});
