import type { FastifyInstance, FastifyReply } from 'fastify';
import type { HongguoComponentManager } from '../creator/hongguo/manager.js';
import { HongguoUpdateError } from '../creator/hongguo/manager.js';
import type { DramaTitleTranslator } from '../creator/drama/title-translator.js';
import { apiError } from './errors.js';

/**
 * Drama discovery routes (Khám phá phim / Gợi ý hot).
 *
 * Thin proxies onto the component's token-guarded loopback API. The component
 * is launched lazily on the first data request (single-flight inside the
 * manager) so opening the panes "wakes up" the installed Hongguo build; a
 * missing component surfaces as creator_hongguo_unavailable (503) and the web
 * UI falls back to the install hint in Settings -> Runtime components.
 *
 * Payloads are passed through verbatim - the component already returns the
 * { success, error, results, ... } shapes the web panes consume, with
 * Vietnamese data labels applied at the boundary.
 */
export async function registerCreatorDramaRoutes(
  server: FastifyInstance,
  hongguo?: HongguoComponentManager,
  titleTranslator?: DramaTitleTranslator
): Promise<void> {
  if (titleTranslator !== undefined) {
    server.post<{ Body: unknown }>('/creator/drama/translate-titles', async (request, reply) => {
      const body = request.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return reply.code(400).send(apiError('VALIDATION_FAILED', 'body must be an object'));
      }
      const { titles, language } = body as { titles?: unknown; language?: unknown };
      if (!Array.isArray(titles)) {
        return reply.code(400).send(apiError('VALIDATION_FAILED', 'titles must be an array'));
      }
      const list = titles.filter((title): title is string => typeof title === 'string').slice(0, 200);
      const target = language === 'en-US' || language === 'en' ? 'en' : 'vi';
      return { translations: await titleTranslator.translate(list, target) };
    });
  }

  if (hongguo === undefined) {
    // Older wiring without the component manager: keep routes discoverable so
    // the UI can distinguish "not available" from "not connected".
    server.get('/creator/drama/status', async (_request, reply) => dramaUnavailable(reply));
    return;
  }

  server.get('/creator/drama/status', async (_request, reply) => {
    try {
      return { hongguo: hongguo.status(), drama: await hongguo.probeDramaApi() };
    } catch (error) {
      return sendDramaError(reply, error);
    }
  });

  server.get('/creator/drama/media-sources', async (_request, reply) => proxy(reply, () =>
    hongguo.apiFetch('/api/v1/media-sources', { timeoutMs: DRAMA_UPSTREAM_TIMEOUT_MS })
  ));

  server.get('/creator/drama/categories', async (request, reply) => proxy(reply, () =>
    hongguo.apiFetch('/api/v1/browse-categories', { query: asQuery(request.query), timeoutMs: DRAMA_UPSTREAM_TIMEOUT_MS })
  ));

  server.get('/creator/drama/browse', async (request, reply) => proxy(reply, () =>
    hongguo.apiFetch('/api/v1/browse-list', { query: asQuery(request.query), timeoutMs: DRAMA_UPSTREAM_TIMEOUT_MS })
  ));

  server.get('/creator/drama/search', async (request, reply) => proxy(reply, () =>
    hongguo.apiFetch('/api/v1/search-series', { query: asQuery(request.query), timeoutMs: DRAMA_UPSTREAM_TIMEOUT_MS })
  ));

  server.get('/creator/drama/series', async (request, reply) => proxy(reply, () =>
    hongguo.apiFetch('/api/v1/search-resolve', { query: asQuery(request.query), timeoutMs: DRAMA_UPSTREAM_TIMEOUT_MS })
  ));

  server.get('/creator/drama/series-episodes', async (request, reply) => proxy(reply, () =>
    hongguo.apiFetch('/api/v1/series-episodes', { query: asQuery(request.query), timeoutMs: DRAMA_UPSTREAM_TIMEOUT_MS })
  ));

  server.post<{ Body: unknown }>('/creator/drama/download-batch', async (request, reply) => {
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.code(400).send(apiError('creator_hongguo_unavailable', 'body must be an object'));
    }
    return proxy(reply, () => hongguo.apiFetch('/api/v1/download-batch', { method: 'POST', body }));
  });

  server.get('/creator/drama/download-tasks', async (_request, reply) => proxy(reply, () =>
    hongguo.apiFetch('/api/v1/download-tasks')
  ));
}

/**
 * Nguồn Tây Phạn/Hà Mã phản hồi chậm và thành phần Hồng Quả tự thử lại vài lần,
 * nên hạn chờ proxy phải rộng hơn mặc định 60s để không cắt ngang lượt thử lại.
 */
const DRAMA_UPSTREAM_TIMEOUT_MS = 150_000;

/** Passes the upstream payload through; maps manager errors to API errors. */
async function proxy(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run();
  } catch (error) {
    return sendDramaError(reply, error);
  }
}

function asQuery(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') out[key] = String(raw);
  }
  return out;
}

function dramaUnavailable(reply: FastifyReply) {
  return reply.code(503).send(apiError(
    'creator_hongguo_unavailable',
    'Hongguo component management is unavailable for this Runtime'
  ));
}

function sendDramaError(reply: FastifyReply, error: unknown) {
  if (error instanceof HongguoUpdateError) {
    return reply.code(error.statusCode).send(apiError(error.code, error.message));
  }
  throw error;
}
