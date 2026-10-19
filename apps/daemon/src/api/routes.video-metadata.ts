import { homedir } from 'node:os';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  VideoMetadataError,
  type VideoMetadataService
} from '../video-metadata/service.js';
import { WorkspaceFileError } from '../workspace-files/errors.js';
import { defaultRevealExecutor, type RevealExecutor } from '../workspace-files/reveal.js';
import { apiError } from './errors.js';

export async function registerVideoMetadataRoutes(
  server: FastifyInstance,
  service: VideoMetadataService,
  options: { revealExecutor?: RevealExecutor } = {}
): Promise<void> {
  const revealExecutor = options.revealExecutor ?? defaultRevealExecutor;
  server.get('/video-metadata', async (request, reply) => {
    const { url } = request.query as { url?: string };
    if (typeof url !== 'string' || url.trim().length === 0) {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'url is required'));
    }

    try {
      return await service.get(url);
    } catch (error) {
      if (error instanceof VideoMetadataError) {
        if (error.code === 'UNSUPPORTED_SOURCE' || error.code === 'INVALID_PART') {
          return reply.code(400).send(apiError('VALIDATION_FAILED', error.message));
        }
        return reply.code(502).send(apiError('VIDEO_METADATA_UNAVAILABLE', error.message));
      }
      throw error;
    }
  });

  // Mở thư mục chứa file video đã tải (path = file đã tải) hoặc thư mục gốc tải
  // về của OpenCreator khi không truyền path. Chỉ mở thư mục, không chọn file.
  server.post<{ Body: unknown }>('/video-downloads/reveal', async (request, reply) => {
    const parsed = parseDownloadRevealBody(request.body);
    if (!parsed.ok) return reply.code(400).send(apiError('VALIDATION_FAILED', parsed.message));

    try {
      return { ok: true, ...(await revealDownloadLocation(parsed.value.path, revealExecutor)) };
    } catch (error) {
      if (error instanceof WorkspaceFileError) {
        return reply.code(error.statusCode).send(apiError(error.code, error.message, error.details));
      }
      throw error;
    }
  });
}

type DownloadRevealInput = { path?: string };

function parseDownloadRevealBody(body: unknown): { ok: true; value: DownloadRevealInput } | { ok: false; message: string } {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'body must be an object' };
  }
  const path = (body as Record<string, unknown>).path;
  if (path !== undefined && typeof path !== 'string') {
    return { ok: false, message: 'path must be a string' };
  }
  return { ok: true, value: path === undefined ? {} : { path } };
}

async function revealDownloadLocation(
  path: string | undefined,
  revealExecutor: RevealExecutor
): Promise<{ directory: string }> {
  const downloadsRoot = await downloadsRootReal();
  if (path === undefined || path.trim() === '') {
    await revealExecutor({ absolutePath: downloadsRoot, mode: 'directory' });
    return { directory: downloadsRoot };
  }
  const trimmed = path.trim();
  if (!isAbsolute(trimmed)) {
    throw new WorkspaceFileError('PATH_INVALID', 'path must be an absolute local path.');
  }
  const absolute = resolve(trimmed);
  const info = await stat(absolute).catch(() => {
    throw new WorkspaceFileError('FILE_NOT_FOUND', 'The downloaded file is no longer on disk.');
  });
  const directory = info.isDirectory() ? absolute : dirname(absolute);
  const directoryReal = await realpath(directory).catch(() => {
    throw new WorkspaceFileError('FILE_NOT_FOUND', 'The download folder is no longer on disk.');
  });
  await revealExecutor({ absolutePath: directoryReal, mode: 'directory' });
  return { directory: directoryReal };
}

async function downloadsRootReal(): Promise<string> {
  // Trùng mặc định của projects/manager.ts: Documents/OpenCreator.
  const root = join(homedir(), 'Documents', 'OpenCreator');
  await mkdir(root, { recursive: true });
  return realpath(root);
}
