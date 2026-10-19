import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectResponse } from '@opencreator/protocol';
import { registerTranslationBatchRoutes } from '../../src/api/routes.translation-batch.js';
import type { TranslationPipelineService } from '../../src/creator/translation-pipeline/pipeline.js';
import { parseEpisodeIndex } from '../../src/creator/translation-pipeline/episode-index.js';
import {
  batchProgress,
  fullMovieFileName,
  mergeEpisodesToFullMovie,
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

type FakePipeline = TranslationPipelineService & {
  enqueued: Array<Array<Record<string, unknown>>>;
};

function fakePipeline(items: Array<Record<string, unknown>> = []): FakePipeline {
  const enqueued: Array<Array<Record<string, unknown>>> = [];
  const summary = () => ({
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
  });
  return {
    enqueued,
    getSummary: summary,
    enqueue: vi.fn((requests: readonly Record<string, unknown>[]) => {
      enqueued.push([...requests]);
      return summary();
    }),
    pause: vi.fn(summary),
    resume: vi.fn(summary),
    remove: vi.fn(summary),
    retry: vi.fn(summary),
    clearFinished: vi.fn(() => ({ summary: summary(), removed: 0 })),
    mergeNow: vi.fn(summary),
    recover: async () => undefined,
    close: async () => undefined
  } as unknown as FakePipeline;
}

function fakeProject(
  overrides: { id: string; name: string; cwd: string }
): ProjectResponse {
  return {
    id: overrides.id,
    name: overrides.name,
    cwd: overrides.cwd,
    canonicalCwd: overrides.cwd,
    directoryState: 'available',
    profile: 'default',
    model: null,
    reasoning: null,
    sandbox: 'follow-global',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null
  };
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

  it('enqueue resolves a project by seriesName and tags every item with its projectId', async () => {
    root = await mkdtemp(join(tmpdir(), 'opencreator-batch-project-'));
    server = Fastify();
    const pipeline = fakePipeline();
    const projects = {
      ensureProjectByName: vi.fn(() => ({
        id: 'project_phim',
        folder: join(root, 'Phim Hay'),
        name: 'Phim Hay'
      })),
      getProject: vi.fn()
    };
    await registerTranslationBatchRoutes(server, { pipeline, projects });

    const response = await server.inject({
      method: 'POST',
      url: '/creator/translation-batch/enqueue',
      payload: {
        seriesName: 'Phim Hay',
        items: [
          { path: join(root, 'Tập 01.mp4') },
          { path: join(root, 'Tập 02.mp4'), episodeIndex: 2 }
        ]
      }
    });
    expect(response.statusCode).toBe(200);
    expect(projects.ensureProjectByName).toHaveBeenCalledWith('Phim Hay');
    // projectId được gắn vào TỪNG item trước khi nạp hàng đợi.
    expect(pipeline.enqueued[0]).toHaveLength(2);
    expect(pipeline.enqueued[0]?.every(item => item.projectId === 'project_phim')).toBe(true);
    expect(response.json()).toMatchObject({
      projectId: 'project_phim',
      folder: join(root, 'Phim Hay'),
      projectName: 'Phim Hay'
    });

    // GET trả lại project đang dùng cho batch.
    const status = await server.inject({ method: 'GET', url: '/creator/translation-batch' });
    expect(status.json()).toMatchObject({
      projectId: 'project_phim',
      folder: join(root, 'Phim Hay'),
      projectName: 'Phim Hay'
    });
  });

  it('enqueue keeps item-level projectId passthrough when seriesName is absent', async () => {
    server = Fastify();
    const pipeline = fakePipeline();
    const projects = {
      ensureProjectByName: vi.fn(),
      getProject: vi.fn()
    };
    await registerTranslationBatchRoutes(server, { pipeline, projects });

    const response = await server.inject({
      method: 'POST',
      url: '/creator/translation-batch/enqueue',
      payload: {
        items: [{ path: join('D:', 'Tập 01.mp4'), projectId: 'project_direct' }]
      }
    });
    expect(response.statusCode).toBe(200);
    expect(projects.ensureProjectByName).not.toHaveBeenCalled();
    expect(pipeline.enqueued[0]).toEqual([
      expect.objectContaining({ projectId: 'project_direct' })
    ]);
    expect(response.json()).toMatchObject({ projectId: null, folder: null });
  });

  it('enqueue refuses a seriesName when the project manager is not wired', async () => {
    server = Fastify();
    const pipeline = fakePipeline();
    await registerTranslationBatchRoutes(server, { pipeline });

    const response = await server.inject({
      method: 'POST',
      url: '/creator/translation-batch/enqueue',
      payload: { seriesName: 'Phim Hay', items: [{ path: 'D:\\Tập 01.mp4' }] }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('creator_pipeline_unavailable');
    expect(pipeline.enqueued).toEqual([]);
  });

  it('merge writes the full movie into the exports folder of the requested project', async () => {
    root = await mkdtemp(join(tmpdir(), 'opencreator-batch-merge-project-'));
    server = Fastify();
    const mergeFullMovie = vi.fn(async (_mergeInput: Parameters<typeof mergeEpisodesToFullMovie>[0]) => ({
      outputPath: join(root, 'Exports', 'Phim Một-project_one', 'Phim Một-full.mp4'),
      durationSeconds: 120,
      segmentCount: 2,
      reencodedPositions: []
    }));
    const pipeline = fakePipeline([
      { id: 'a', status: 'completed', episodeIndex: 1, outputVideoPath: join(root, '1.mp4'), addedAt: '2026-01-01T00:00:00.000Z', title: 'Tập 1' },
      { id: 'b', status: 'completed', episodeIndex: 2, outputVideoPath: join(root, '2.mp4'), addedAt: '2026-01-01T00:01:00.000Z', title: 'Tập 2' }
    ]);
    const projects = {
      ensureProjectByName: vi.fn(),
      getProject: vi.fn(() => fakeProject({
        id: 'project_one',
        name: 'Phim Một',
        cwd: join(root, 'Phim Một')
      }))
    };
    await registerTranslationBatchRoutes(server, {
      pipeline,
      projects,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      // Mô phỏng server.ts sau khi wire: Exports theo project đích.
      resolveProjectFolder: project => ({
        folder: project === undefined
          ? join(root, 'Exports-Default')
          : join(root, 'Exports', `${project.name}-${project.id}`),
        projectName: project?.name ?? 'Default project'
      }),
      mergeFullMovie
    });

    const response = await server.inject({
      method: 'POST',
      url: '/creator/translation-batch/merge',
      payload: { projectId: 'project_one' }
    });
    expect(response.statusCode).toBe(200);
    const expectedFolder = join(root, 'Exports', 'Phim Một-project_one');
    expect(response.json()).toMatchObject({
      seriesName: 'Phim Một',
      projectId: 'project_one',
      folder: expectedFolder
    });
    await vi.waitFor(() => expect(mergeFullMovie).toHaveBeenCalled());
    expect(mergeFullMovie.mock.calls[0]?.[0]).toMatchObject({
      targetDirectory: expectedFolder,
      seriesName: 'Phim Một'
    });

    // GET trả lại project vừa dùng cho merge.
    const status = await server.inject({ method: 'GET', url: '/creator/translation-batch' });
    expect(status.json()).toMatchObject({ projectId: 'project_one', folder: expectedFolder });
  });

  it('merge resolves the project by seriesName when projectId is absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'opencreator-batch-merge-series-'));
    server = Fastify();
    const mergeFullMovie = vi.fn(async (_mergeInput: Parameters<typeof mergeEpisodesToFullMovie>[0]) => ({
      outputPath: join(root, 'Phim Mới', 'Phim Mới-full.mp4'),
      durationSeconds: 60,
      segmentCount: 1,
      reencodedPositions: []
    }));
    const pipeline = fakePipeline([
      { id: 'a', status: 'completed', episodeIndex: 1, outputVideoPath: join(root, '1.mp4'), addedAt: '2026-01-01T00:00:00.000Z', title: 'Tập 1' }
    ]);
    const projects = {
      ensureProjectByName: vi.fn(() => ({
        id: 'project_new',
        folder: join(root, 'Phim Mới'),
        name: 'Phim Mới'
      })),
      getProject: vi.fn()
    };
    await registerTranslationBatchRoutes(server, {
      pipeline,
      projects,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      mergeFullMovie
    });

    const response = await server.inject({
      method: 'POST',
      url: '/creator/translation-batch/merge',
      payload: { seriesName: 'Phim Mới' }
    });
    expect(response.statusCode).toBe(200);
    expect(projects.ensureProjectByName).toHaveBeenCalledWith('Phim Mới');
    expect(response.json()).toMatchObject({
      seriesName: 'Phim Mới',
      projectId: 'project_new',
      folder: join(root, 'Phim Mới')
    });
    await vi.waitFor(() => expect(mergeFullMovie).toHaveBeenCalled());
    expect(mergeFullMovie.mock.calls[0]?.[0]).toMatchObject({
      targetDirectory: join(root, 'Phim Mới')
    });
  });

  it('merge keeps the default exports folder when no project is requested', async () => {
    root = await mkdtemp(join(tmpdir(), 'opencreator-batch-merge-default-'));
    server = Fastify();
    const mergeFullMovie = vi.fn(async (_mergeInput: Parameters<typeof mergeEpisodesToFullMovie>[0]) => ({
      outputPath: join(root, 'project', 'Bộ Phim-full.mp4'),
      durationSeconds: 30,
      segmentCount: 1,
      reencodedPositions: []
    }));
    const projects = {
      ensureProjectByName: vi.fn(),
      getProject: vi.fn()
    };
    const pipeline = fakePipeline([
      { id: 'a', status: 'completed', episodeIndex: 1, outputVideoPath: join(root, '1.mp4'), addedAt: '2026-01-01T00:00:00.000Z', title: 'Tập 1' }
    ]);
    await registerTranslationBatchRoutes(server, {
      pipeline,
      projects,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      resolveProjectFolder: () => ({ folder: join(root, 'project'), projectName: 'Bộ Phim' }),
      mergeFullMovie
    });

    const response = await server.inject({
      method: 'POST',
      url: '/creator/translation-batch/merge',
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    expect(projects.ensureProjectByName).not.toHaveBeenCalled();
    expect(projects.getProject).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({ seriesName: 'Bộ Phim', projectId: null });
    await vi.waitFor(() => expect(mergeFullMovie).toHaveBeenCalled());
    expect(mergeFullMovie.mock.calls[0]?.[0]).toMatchObject({
      targetDirectory: join(root, 'project'),
      seriesName: 'Bộ Phim'
    });
  });

  it('merge rejects projectId without a wired project manager or with an unknown project', async () => {
    server = Fastify();
    const pipeline = fakePipeline();
    await registerTranslationBatchRoutes(server, {
      pipeline,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe'
    });
    const unwired = await server.inject({
      method: 'POST',
      url: '/creator/translation-batch/merge',
      payload: { projectId: 'project_missing' }
    });
    expect(unwired.statusCode).toBe(503);

    root = await mkdtemp(join(tmpdir(), 'opencreator-batch-merge-unknown-'));
    await server.close();
    server = Fastify();
    await registerTranslationBatchRoutes(server, {
      pipeline: fakePipeline(),
      projects: {
        ensureProjectByName: vi.fn(),
        getProject: vi.fn(() => undefined)
      },
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe'
    });
    const unknown = await server.inject({
      method: 'POST',
      url: '/creator/translation-batch/merge',
      payload: { projectId: 'project_unknown' }
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('PROJECT_NOT_FOUND');
  });
});

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
