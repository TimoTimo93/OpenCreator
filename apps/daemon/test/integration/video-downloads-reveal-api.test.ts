import Fastify, { type FastifyInstance } from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDownloadProbe } from '../../src/creator/download/probe-parser.js';
import { registerVideoMetadataRoutes } from '../../src/api/routes.video-metadata.js';
import type { RevealExecutor } from '../../src/workspace-files/reveal.js';

describe('download probe series metadata', () => {
  it('keeps the series id and name declared by the source', () => {
    const probe = parseDownloadProbe({
      id: 'ep2',
      title: 'Phim A - Tập 02',
      series: 'Phim A',
      playlist_id: 'PL-series-a',
      formats: []
    }, 'https://www.youtube.com/watch?v=ep2');
    expect(probe.seriesId).toBe('PL-series-a');
    expect(probe.seriesName).toBe('Phim A');
  });

  it('falls back to the playlist title and ignores self-named playlists', () => {
    const named = parseDownloadProbe({
      id: 'ep3',
      title: 'Phim B - Tập 03',
      playlist_title: 'Phim B',
      formats: []
    }, 'https://www.youtube.com/watch?v=ep3');
    expect(named.seriesId).toBe('Phim B');
    expect(named.seriesName).toBe('Phim B');

    const selfNamed = parseDownloadProbe({
      id: 'solo',
      title: 'Standalone video',
      playlist_title: 'Standalone video',
      formats: []
    }, 'https://www.youtube.com/watch?v=solo');
    expect(selfNamed.seriesId).toBeNull();
    expect(selfNamed.seriesName).toBeNull();
  });
});

describe('video downloads reveal API', () => {
  let server: FastifyInstance;
  let dataDir: string;
  let revealed: Array<{ absolutePath: string; mode: 'file' | 'directory' }>;
  const revealExecutor: RevealExecutor = async request => {
    revealed.push(request);
  };

  beforeEach(async () => {
    server = Fastify({ logger: false });
    dataDir = await mkdtemp(join(tmpdir(), 'video-download-reveal-'));
    revealed = [];
    // Bẻ homedir sang tmp để nút "mở thư mục gốc" không tạo thư mục thật.
    process.env.USERPROFILE = dataDir;
    process.env.HOME = dataDir;
  });

  afterEach(async () => {
    delete process.env.USERPROFILE;
    delete process.env.HOME;
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('opens the default downloads root when no path is submitted', async () => {
    await registerVideoMetadataRoutes(server, {
      get: async () => ({ platform: 'youtube', title: 'unused' })
    }, { revealExecutor });

    const response = await server.inject({ method: 'POST', url: '/video-downloads/reveal', payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, directory: join(homedir(), 'Documents', 'OpenCreator') });
    expect(revealed).toHaveLength(1);
    expect(revealed[0]!.mode).toBe('directory');
    expect(revealed[0]!.absolutePath).toBe(join(homedir(), 'Documents', 'OpenCreator'));
  });

  it('opens the folder containing a downloaded file', async () => {
    await registerVideoMetadataRoutes(server, {
      get: async () => ({ platform: 'youtube', title: 'unused' })
    }, { revealExecutor });
    const file = join(dataDir, 'project-x', 'episode.mp4');
    await mkdir(join(dataDir, 'project-x'), { recursive: true });
    await writeFile(file, 'video');

    const response = await server.inject({ method: 'POST', url: '/video-downloads/reveal', payload: { path: file } });

    expect(response.statusCode).toBe(200);
    expect(revealed).toHaveLength(1);
    expect(revealed[0]!.mode).toBe('directory');
    expect(revealed[0]!.absolutePath).toBe(join(dataDir, 'project-x'));
  });

  it('rejects relative paths and files that are gone', async () => {
    await registerVideoMetadataRoutes(server, {
      get: async () => ({ platform: 'youtube', title: 'unused' })
    }, { revealExecutor });

    const relative = await server.inject({ method: 'POST', url: '/video-downloads/reveal', payload: { path: 'downloads/video.mp4' } });
    expect(relative.statusCode).toBe(400);

    const missing = await server.inject({ method: 'POST', url: '/video-downloads/reveal', payload: { path: join(dataDir, 'gone.mp4') } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('FILE_NOT_FOUND');
    expect(revealed).toHaveLength(0);
  });
});
