import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RuntimeErrorCode } from '@opencreator/protocol';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { apiError } from './errors.js';
import { SocialError, type SocialClusterPatch, type SocialService } from '../social/service.js';
import type { SocialEnqueueRequest } from '../social/types.js';

/**
 * REST cho Mạng Lưới Đăng Đa Kênh:
 * - GET  /social/overview
 * - POST /social/clusters                       → tạo cụm
 * - PATCH /social/clusters/:id                  → sửa cụm
 * - DELETE /social/clusters/:id                 → xóa cụm
 * - POST /social/clusters/:id/check-proxy       → đo proxy
 * - POST /social/clusters/:id/open-browser      → mở trình duyệt Persistent (đăng nhập tay)
 * - POST /social/clusters/:id/close-browser
 * - POST /social/jobs                           → nạp video (web + trợ lý AI)
 * - DELETE /social/jobs/:id
 * - POST /social/jobs/:id/retry-failed          → chạy lại nền tảng lỗi
 * - POST /social/queue/pause | /social/queue/resume
 * - GET  /social/jobs/:id/error-screenshot?platform=yt|tk|fb → ảnh lỗi
 */
export async function registerSocialRoutes(
  server: FastifyInstance,
  social?: SocialService
): Promise<void> {
  if (social === undefined) {
    server.get('/social/overview', async (_request, reply) =>
      reply.code(503).send(apiError(
        'social_unavailable',
        'Mạng Lưới Đăng Đa Kênh chưa được cắm vào runtime này'
      ))
    );
    return;
  }
  const overview = () => social.getOverview();

  server.get('/social/overview', async () => overview());

  server.post<{ Body: SocialClusterPatch & { name?: string } }>('/social/clusters', async (request, reply) => {
    const body = request.body;
    if (typeof body !== 'object' || body === null || typeof (body as { name?: unknown }).name !== 'string'
      || (body as { name: string }).name.trim() === '') {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'body.name (tên cụm) là bắt buộc'));
    }
    return social.createCluster({
      ...stripClusterPatch(body as SocialClusterPatch),
      name: (body as { name: string }).name
    });
  });

  server.patch<{ Params: { id: string }; Body: SocialClusterPatch }>('/social/clusters/:id', async (request, reply) => {
    const body = request.body;
    if (typeof body !== 'object' || body === null) {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'body must be an object'));
    }
    return social.updateCluster(request.params.id, stripClusterPatch(body));
  });

  server.delete<{ Params: { id: string } }>('/social/clusters/:id', async request =>
    social.deleteCluster(request.params.id));

  server.post<{ Params: { id: string } }>('/social/clusters/:id/check-proxy', async (request, reply) => {
    try {
      return await social.checkClusterProxy(request.params.id);
    } catch (error) {
      return socialFailure(error, reply);
    }
  });

  server.post<{ Params: { id: string } }>('/social/clusters/:id/open-browser', async (request, reply) => {
    try {
      return await social.openClusterBrowser(request.params.id);
    } catch (error) {
      return socialFailure(error, reply);
    }
  });

  server.post<{ Params: { id: string } }>('/social/clusters/:id/close-browser', async (request, reply) => {
    try {
      return await social.closeClusterBrowser(request.params.id);
    } catch (error) {
      return socialFailure(error, reply);
    }
  });

  server.post<{ Body: unknown }>('/social/jobs', async (request, reply) => {
    try {
      const body = request.body;
      const items = parseEnqueueBody(body);
      if (items === undefined) {
        return reply.code(400).send(apiError(
          'VALIDATION_FAILED',
          'body phải là object {clusterId, path, ...} hoặc {items: [...]} không rỗng'
        ));
      }
      const result = social.enqueue(items);
      if (result.accepted === 0) {
        return reply.code(409).send({
          ...apiError('social_enqueue_duplicate', 'Các video này đã có trong hàng đợi (chưa hoàn thành)'),
          summary: result.summary,
          duplicates: result.duplicates
        });
      }
      return result;
    } catch (error) {
      return socialFailure(error, reply);
    }
  });

  server.delete<{ Params: { id: string } }>('/social/jobs/:id', async (request, reply) => {
    try {
      return social.removeJob(request.params.id);
    } catch (error) {
      return socialFailure(error, reply);
    }
  });

  server.post<{ Params: { id: string } }>('/social/jobs/:id/retry-failed', async (request, reply) => {
    try {
      return social.retryFailedPlatforms(request.params.id);
    } catch (error) {
      return socialFailure(error, reply);
    }
  });

  server.post('/social/queue/pause', async () => social.pause());
  server.post('/social/queue/resume', async () => social.resume());

  // ---- GĐ3: thống kê + bình luận -------------------------------------------
  server.get('/social/stats', async () => social.getStats());

  server.post('/social/stats/refresh', async (request, reply) => {
    try {
      return await social.refreshStats();
    } catch (error) {
      return socialFailure(error, reply);
    }
  });

  server.get<{ Querystring: { clusterId?: string; limit?: string } }>('/social/comments', async (request, reply) => {
    const limitRaw = request.query.limit;
    const limit = typeof limitRaw === 'string' && /^\d+$/.test(limitRaw) ? Math.min(Number(limitRaw), 500) : undefined;
    try {
      return social.listComments(request.query.clusterId, limit);
    } catch (error) {
      return socialFailure(error, reply);
    }
  });

  server.post<{ Body: { clusterId?: unknown } }>('/social/comments/scan', async (request, reply) => {
    try {
      const clusterId = typeof (request.body as { clusterId?: unknown } | undefined)?.clusterId === 'string'
        ? (request.body as { clusterId: string }).clusterId
        : undefined;
      return await social.scanComments(clusterId);
    } catch (error) {
      return socialFailure(error, reply);
    }
  });


  server.get<{ Params: { id: string }; Querystring: { platform?: string } }>('/social/jobs/:id/error-screenshot', async (request, reply) => {
    const overviewNow = social.getOverview();
    const job = overviewNow.jobs.find(candidate => candidate.id === request.params.id);
    if (job === undefined) {
      return reply.code(404).send(apiError('social_job_not_found', 'Không tìm thấy job trong hàng đợi'));
    }
    const platform = request.query.platform === 'tiktok' ? 'tiktok'
      : request.query.platform === 'facebook' ? 'facebook'
        : request.query.platform === 'youtube' ? 'youtube' : undefined;
    if (platform === undefined) {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'query.platform phải là youtube|tiktok|facebook'));
    }
    const path = job.platforms[platform]!.screenshotPath;
    if (path === null || path === '') {
      return reply.code(404).send(apiError('social_screenshot_missing', 'Không có ảnh lỗi cho nền tảng này'));
    }
    try {
      const info = await stat(path);
      void info;
    } catch {
      return reply.code(404).send(apiError('social_screenshot_missing', 'File ảnh lỗi không còn trên đĩa'));
    }
    return reply.header('content-type', 'image/png').send(createReadStream(path));
  });
}

function socialFailure(error: unknown, reply: FastifyReply): unknown {
  if (error instanceof SocialError) {
    const knownCodes = new Set<RuntimeErrorCode>([
      'social_cluster_not_found',
      'social_job_not_found',
      'social_enqueue_duplicate',
      'social_screenshot_missing'
    ]);
    return reply
      .code(error.code === 'social_cluster_not_found' || error.code === 'social_job_not_found' ? 404 : 400)
      .send(apiError(knownCodes.has(error.code as RuntimeErrorCode) ? error.code as RuntimeErrorCode : 'social_unavailable', error.message));
  }
  throw error;
}

function parseEnqueueBody(body: unknown): SocialEnqueueRequest[] | undefined {
  type EnqueueCandidate = {
    clusterId?: unknown;
    path?: unknown;
    title?: unknown;
    description?: unknown;
    scheduledAt?: unknown;
    thumbnailPath?: unknown;
  };
  const itemsRaw = typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items)
    ? (body as { items: unknown[] }).items
    : Array.isArray(body) ? body
      : typeof body === 'object' && body !== null && typeof (body as { path?: unknown }).path === 'string'
        ? [body]
        : undefined;
  if (itemsRaw === undefined || itemsRaw.length === 0) return undefined;
  const items: SocialEnqueueRequest[] = [];
  for (const raw of itemsRaw) {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const candidate = raw as EnqueueCandidate;
    if (typeof candidate.clusterId !== 'string' || candidate.clusterId.trim() === '') return undefined;
    if (typeof candidate.path !== 'string' || candidate.path.trim() === '') return undefined;
    items.push({
      clusterId: candidate.clusterId,
      path: candidate.path,
      ...(typeof candidate.title === 'string' && candidate.title.trim() !== '' ? { title: candidate.title.trim() } : {}),
      ...(typeof candidate.description === 'string' && candidate.description.trim() !== '' ? { description: candidate.description.trim() } : {}),
      ...(typeof candidate.scheduledAt === 'string' && candidate.scheduledAt.trim() !== '' ? { scheduledAt: candidate.scheduledAt.trim() } : {}),
      ...(candidate.thumbnailPath === null ? { thumbnailPath: null } : {})
    });
  }
  return items;
}

function stripClusterPatch(body: SocialClusterPatch): SocialClusterPatch {
  const patch: SocialClusterPatch = {};
  if (typeof body.name === 'string') patch.name = body.name;
  if (typeof body.seriesName === 'string') patch.seriesName = body.seriesName;
  if (typeof body.proxyServer === 'string') patch.proxyServer = body.proxyServer;
  if (body.fbMode === 'graph_api' || body.fbMode === 'browser') patch.fbMode = body.fbMode;
  if (typeof body.fbPageId === 'string') patch.fbPageId = body.fbPageId;
  if (typeof body.fbPageToken === 'string' || body.fbPageToken === null) patch.fbPageToken = body.fbPageToken;
  if (Array.isArray(body.defaultScheduleTimes)) {
    patch.defaultScheduleTimes = body.defaultScheduleTimes.filter((time): time is string => typeof time === 'string');
  }
  if (typeof body.defaultDescription === 'string') patch.defaultDescription = body.defaultDescription;
  if (typeof body.ytChannelUrl === 'string') patch.ytChannelUrl = body.ytChannelUrl;
  if (typeof body.tkProfileUrl === 'string') patch.tkProfileUrl = body.tkProfileUrl;
  if (typeof body.autoReplyEnabled === 'boolean') patch.autoReplyEnabled = body.autoReplyEnabled;
  if (typeof body.autoReplyPrompt === 'string') patch.autoReplyPrompt = body.autoReplyPrompt;
  return patch;
}

