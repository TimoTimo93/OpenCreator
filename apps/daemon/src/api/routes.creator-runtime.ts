import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { YtDlpUpdateManager } from '../creator/yt-dlp/update-manager.js';
import { YtDlpUpdateError } from '../creator/yt-dlp/update-manager.js';
import type { HongguoComponentManager } from '../creator/hongguo/manager.js';
import { HongguoUpdateError } from '../creator/hongguo/manager.js';
import { apiError } from './errors.js';
import type { CreatorServicesConfig } from '@opencreator/protocol';
import type { createKrillinDependencyLoader } from '../creator/krillin/dependency-loader.js';
import type { RemotionComponentManager } from '../creator/stickman/remotion-component.js';

const componentDownloadSchema = z.object({
  componentId: z.enum(['whisperkit', 'whisper.cpp', 'faster-whisper', 'remotion']).optional()
}).optional();

export async function registerCreatorRuntimeRoutes(
  server: FastifyInstance,
  ytDlp: YtDlpUpdateManager | undefined,
  local?: { loader: ReturnType<typeof createKrillinDependencyLoader>; readConfig(): Promise<CreatorServicesConfig>; remotion?: RemotionComponentManager },
  hongguo?: HongguoComponentManager
): Promise<void> {
  server.addHook('preClose', () => {
    ytDlp?.close();
    hongguo?.close();
    local?.loader.close();
    local?.remotion?.close();
  });

  server.get('/creator/yt-dlp/status', async (_request, reply) => {
    if (ytDlp === undefined) return unavailable(reply);
    return { ytDlp: ytDlp.status() };
  });

  server.post<{ Body: unknown }>('/creator/yt-dlp/check', async (request, reply) => {
    if (ytDlp === undefined) return unavailable(reply);
    try {
      const force = readForce(request.body);
      return { ytDlp: await ytDlp.check({ force }) };
    } catch (error) {
      return sendUpdateError(reply, error);
    }
  });

  server.post('/creator/yt-dlp/update', async (_request, reply) => {
    if (ytDlp === undefined) return unavailable(reply);
    try {
      return { ytDlp: await ytDlp.update() };
    } catch (error) {
      return sendUpdateError(reply, error);
    }
  });

  server.get('/creator/hongguo/status', async (_request, reply) => {
    if (hongguo === undefined) return hongguoUnavailable(reply);
    return { hongguo: hongguo.status() };
  });

  server.post<{ Body: unknown }>('/creator/hongguo/check', async (request, reply) => {
    if (hongguo === undefined) return hongguoUnavailable(reply);
    try {
      const force = readHongguoForce(request.body);
      return { hongguo: await hongguo.check({ force }) };
    } catch (error) {
      return sendHongguoError(reply, error);
    }
  });

  server.post<{ Body: unknown }>('/creator/hongguo/channel', async (request, reply) => {
    if (hongguo === undefined) return hongguoUnavailable(reply);
    const body = request.body as { url?: unknown } | null;
    const url = typeof body?.url === 'string' ? body.url : '';
    try {
      await hongguo.setChannel(url);
      return { hongguo: await hongguo.status() };
    } catch (error) {
      return sendHongguoError(reply, error);
    }
  });

  server.post('/creator/hongguo/update', async (_request, reply) => {
    if (hongguo === undefined) return hongguoUnavailable(reply);
    try {
      return { hongguo: await hongguo.update() };
    } catch (error) {
      return sendHongguoError(reply, error);
    }
  });

  server.get('/creator/components/status', async (_request, reply) => {
    if (local === undefined) return reply.code(503).send(apiError('creator_components_unavailable', 'Local components are unavailable'));
    const status = await local.loader.status(await local.readConfig());
    if (local.remotion) status.components.push(await local.remotion.status());
    return status;
  });
  server.post('/creator/components/download', async (request, reply) => {
    if (local === undefined) return reply.code(503).send(apiError('creator_components_unavailable', 'Local components are unavailable'));
    try {
      const body = componentDownloadSchema.parse(request.body);
      const config = await local.readConfig();
      if (body?.componentId === 'remotion') {
        if (!local.remotion) throw new Error('Remotion components are unavailable');
        await local.remotion.download();
      } else {
        await local.loader.download(config, body?.componentId);
      }
      const status = await local.loader.status(config);
      if (local.remotion) status.components.push(await local.remotion.status());
      return status;
    } catch (error) {
      return reply.code(400).send(apiError('creator_component_download_unavailable', error instanceof Error ? error.message : 'Component download unavailable'));
    }
  });
}

function readForce(value: unknown): boolean {
  if (value === undefined) return true;
  if (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && ('force' in value)
  ) {
    if (typeof value.force === 'boolean') return value.force;
    throw new YtDlpUpdateError(
      'creator_yt_dlp_update_check_failed',
      'force must be a boolean',
      400
    );
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return true;
  }
  throw new YtDlpUpdateError(
    'creator_yt_dlp_update_check_failed',
    'body must be an object',
    400
  );
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send(apiError(
    'creator_yt_dlp_update_unavailable',
    'yt-dlp updates are unavailable for this Runtime'
  ));
}

function sendUpdateError(reply: FastifyReply, error: unknown) {
  if (error instanceof YtDlpUpdateError) {
    return reply.code(error.statusCode).send(apiError(error.code, error.message));
  }
  throw error;
}

function readHongguoForce(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'object' && !Array.isArray(value) && 'force' in value) {
    const force = (value as { force?: unknown }).force;
    if (typeof force === 'boolean') return force;
    throw new HongguoUpdateError('creator_hongguo_check_failed', 'force must be a boolean', 400);
  }
  if (typeof value === 'object' && !Array.isArray(value)) return true;
  throw new HongguoUpdateError('creator_hongguo_check_failed', 'body must be an object', 400);
}

function hongguoUnavailable(reply: FastifyReply) {
  return reply.code(503).send(apiError(
    'creator_hongguo_unavailable',
    'Hongguo component management is unavailable for this Runtime'
  ));
}

function sendHongguoError(reply: FastifyReply, error: unknown) {
  if (error instanceof HongguoUpdateError) {
    return reply.code(error.statusCode).send(apiError(error.code, error.message));
  }
  throw error;
}
