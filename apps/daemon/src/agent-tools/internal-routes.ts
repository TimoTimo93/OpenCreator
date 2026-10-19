import type {
  CreateScheduleRequest,
  RunScheduleNowResponse,
  ScheduleDetailResponse,
  ScheduleResponse,
  UpdateScheduleRequest
} from '@opencreator/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ScheduleAgentActor,
  ScheduleCoordinator
} from '../scheduler/coordinator.js';
import { SchedulerError, type SchedulerService } from '../scheduler/service.js';
import { scheduleOperationActors } from '../scheduler/types.js';
import type { RuntimeThread, ThreadManager } from '../threads/types.js';
import { apiError } from '../api/errors.js';
import { SocialError, type SocialService, type SocialClusterPatch } from '../social/service.js';
import { sanitizePlatformSettings, type SocialEnqueueRequest, type SocialPlatformSettings } from '../social/types.js';
import {
  AgentCapabilityTokenError,
  type AgentCapabilityGrant,
  type AgentCapabilityScope,
  type AgentCapabilityTokenStore
} from './capability-token.js';
import type { CreatorToolOperations } from './creator-tools.js';

export const AGENT_TOOL_ROUTE_PREFIX = '/internal/agent-tools';
export const AGENT_SCHEDULE_MCP_ROUTE = `${AGENT_TOOL_ROUTE_PREFIX}/mcp`;

export type AgentScheduleActor = ScheduleAgentActor;

type MaybePromise<T> = T | Promise<T>;

/**
 * Phản chiếu API thành phần Hồng Quả cho các route nội bộ của trợ lý.
 * Trạng thái "chưa cài / đang bận" của manager được đẩy thẳng lên trình trợ lý.
 */
export type AgentDramaOperations = {
  apiFetch(path: string, options?: {
    method?: 'GET' | 'POST';
    query?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<unknown>;
  translateTitles(titles: readonly string[], language: 'vi' | 'en'): Promise<Record<string, string>>;
};

export type AgentScheduleOperations = {
  getActorThread(actor: AgentScheduleActor): MaybePromise<RuntimeThread | undefined>;
  listSchedules(actor: AgentScheduleActor): MaybePromise<ScheduleResponse[]>;
  getSchedule(
    id: string,
    actor: AgentScheduleActor
  ): MaybePromise<ScheduleDetailResponse | undefined>;
  createSchedule(
    input: CreateScheduleRequest | Record<string, unknown>,
    actor: AgentScheduleActor
  ): MaybePromise<ScheduleResponse>;
  updateSchedule(
    id: string,
    input: UpdateScheduleRequest | Record<string, unknown>,
    actor: AgentScheduleActor
  ): MaybePromise<ScheduleResponse>;
  pauseSchedule(id: string, actor: AgentScheduleActor): MaybePromise<ScheduleResponse>;
  resumeSchedule(id: string, actor: AgentScheduleActor): MaybePromise<ScheduleResponse>;
  runScheduleNow(
    id: string,
    actor: AgentScheduleActor
  ): MaybePromise<RunScheduleNowResponse>;
};

export function isAgentToolInternalRequest(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return path === AGENT_TOOL_ROUTE_PREFIX
    || path.startsWith(`${AGENT_TOOL_ROUTE_PREFIX}/`);
}

export function createDefaultAgentScheduleOperations(input: {
  coordinator: ScheduleCoordinator;
  scheduler: SchedulerService;
  threadManager: Pick<ThreadManager, 'getThread'>;
}): AgentScheduleOperations {
  return {
    getActorThread(actor) {
      return input.threadManager.getThread(actor.threadId);
    },
    listSchedules() {
      return input.scheduler.listSchedules().schedules;
    },
    getSchedule(id) {
      return input.scheduler.getSchedule(id);
    },
    createSchedule(create, actor) {
      return input.coordinator.createFromAgent(create, actor);
    },
    updateSchedule(id, update, actor) {
      return input.coordinator.updateFromAgent(
        id,
        update as UpdateScheduleRequest,
        actor
      );
    },
    pauseSchedule(id, actor) {
      return input.coordinator.updateFromAgent(id, { enabled: false }, actor);
    },
    resumeSchedule(id, actor) {
      return input.coordinator.updateFromAgent(id, { enabled: true }, actor);
    },
    runScheduleNow(id, actor) {
      return input.scheduler.runNow(
        id,
        scheduleOperationActors.agent(actor.runId)
      );
    }
  };
}

export async function registerAgentToolRoutes(
  server: FastifyInstance,
  input: {
    capabilities: AgentCapabilityTokenStore;
    schedules: AgentScheduleOperations;
    creator?: CreatorToolOperations;
    drama?: AgentDramaOperations;
    social?: SocialService;
  }
): Promise<void> {
  if (input.creator !== undefined) {
    server.get(`${AGENT_TOOL_ROUTE_PREFIX}/creator/context`, async (request, reply) => {
      const grant = authorizeRequest(request, reply, input.capabilities, 'creator:context');
      if (grant === undefined) return;
      if (grant.jobId === undefined) {
        return reply.code(403).send(internalApiError('CAPABILITY_RUN_FORBIDDEN', 'Capability is not bound to a creator job'));
      }
      return input.creator!.getContext(grant.jobId);
    });
    server.get<{ Params: { id: string }; Querystring: { start?: string; end?: string } }>(
      `${AGENT_TOOL_ROUTE_PREFIX}/creator/artifacts/:id`,
      async (request, reply) => {
        const grant = authorizeRequest(request, reply, input.capabilities, 'creator:artifact:read');
        if (grant === undefined) return;
        if (grant.jobId === undefined) {
          return reply.code(403).send(internalApiError('CAPABILITY_RUN_FORBIDDEN', 'Capability is not bound to a creator job'));
        }
        try {
          const start = parseOptionalNonNegativeInteger(request.query.start, 'start');
          const end = parseOptionalNonNegativeInteger(request.query.end, 'end');
          return await input.creator!.readArtifact(
            grant.jobId,
            request.params.id,
            start === undefined && end === undefined ? undefined : {
              start: start ?? 0,
              end: end ?? Number.MAX_SAFE_INTEGER
            }
          );
        } catch (error) {
          return reply.code(400).send(apiError('VALIDATION_FAILED', error instanceof Error ? error.message : 'Creator artifact read failed'));
        }
      }
    );
    server.post<{ Body: unknown }>(
      `${AGENT_TOOL_ROUTE_PREFIX}/creator/stages/wait`,
      async (request, reply) => {
        const grant = authorizeRequest(request, reply, input.capabilities, 'creator:context');
        if (grant === undefined) return;
        if (grant.jobId === undefined) {
          return reply.code(403).send(internalApiError('CAPABILITY_RUN_FORBIDDEN', 'Capability is not bound to a creator job'));
        }
        const body = parseBody(request.body, reply);
        if (body === undefined) return;
        try {
          const timeoutSeconds = body.timeoutSeconds === undefined
            ? undefined
            : readRequiredInteger(body.timeoutSeconds, 'timeoutSeconds');
          if (timeoutSeconds !== undefined && (timeoutSeconds < 1 || timeoutSeconds > 120)) {
            return reply.code(400).send(
              apiError('VALIDATION_FAILED', 'timeoutSeconds must be between 1 and 120')
            );
          }
          return await input.creator!.waitForStage(
            grant.jobId,
            readRequiredString(body.stageRunId, 'stageRunId'),
            timeoutSeconds === undefined ? undefined : timeoutSeconds * 1_000
          );
        } catch (error) {
          const candidate = error as { code?: string; message?: string };
          return reply.code(400).send(
            apiError(
              'VALIDATION_FAILED',
              candidate.message ?? 'Creator stage wait failed'
            )
          );
        }
      }
    );
    server.post<{ Body: unknown }>(
      `${AGENT_TOOL_ROUTE_PREFIX}/creator/actions`,
      async (request, reply) => {
        const grant = authorizeRequest(request, reply, input.capabilities, 'creator:action');
        if (grant === undefined) return;
        if (grant.jobId === undefined) {
          return reply.code(403).send(internalApiError('CAPABILITY_RUN_FORBIDDEN', 'Capability is not bound to a creator job'));
        }
        const body = parseBody(request.body, reply);
        if (body === undefined) return;
        if ('actor' in body || 'jobId' in body || 'projectId' in body) {
          return reply.code(400).send(apiError('VALIDATION_FAILED', 'actor, jobId and projectId are bound by the capability token'));
        }
        try {
          return await input.creator!.applyAction(grant.jobId, {
            action: readRequiredString(body.action, 'action'),
            expectedRevision: readRequiredInteger(body.expectedRevision, 'expectedRevision'),
            idempotencyKey: readRequiredString(body.idempotencyKey, 'idempotencyKey'),
            input: (isPlainObject(body.input) ? body.input : {}) as never
          });
        } catch (error) {
          const candidate = error as { code?: string; latestRevision?: number; message?: string };
          const status = candidate.code === 'creator_revision_conflict' ? 409 : 400;
          return reply.code(status).send({
            ...internalApiError(candidate.code ?? 'VALIDATION_FAILED', candidate.message ?? 'Creator action failed'),
            ...(candidate.latestRevision === undefined ? {} : { latestRevision: candidate.latestRevision })
          });
        }
      }
    );
  }
  if (input.drama !== undefined) {
    const drama = input.drama;

    /** Chấp quyền + bọc lỗi thành phần; run() trả payload hoặc reply đã gửi. */
    async function flexDrama(
      request: FastifyRequest,
      reply: FastifyReply,
      scope: AgentCapabilityScope,
      run: () => Promise<unknown>
    ): Promise<unknown> {
      const grant = authorizeRequest(request, reply, input.capabilities, scope);
      if (grant === undefined) return reply;
      try {
        return await run();
      } catch (error) {
        const candidate = error as { code?: string; statusCode?: number; message?: string };
        const statusCode = candidate.statusCode ?? 502;
        if (statusCode >= 500) {
          console.warn(`Drama agent tool failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return reply.code(statusCode).send(
          internalApiError(candidate.code ?? 'creator_hongguo_unavailable', candidate.message ?? 'Hongguo component request failed')
        );
      }
    }

    server.get(`${AGENT_TOOL_ROUTE_PREFIX}/drama/search`, async (request, reply) => {
      return flexDrama(request, reply, 'drama:read', async () => {
        const query = request.query as Record<string, string | undefined>;
        const keyword = query.keyword ?? '';
        if (keyword === '') {
          return reply.code(400).send(apiError('VALIDATION_FAILED', 'query.keyword must not be empty'));
        }
        const payload = await drama.apiFetch('/api/v1/search-series', {
          query: asStringRecord({ keyword, page: query.page ?? '1' }),
          timeoutMs: 150_000
        }) as { success?: boolean; error?: string; results?: Array<{ series_title?: string }> } | undefined;
        if (payload?.success !== true) return payload;
        const titles = (payload.results ?? [])
          .map(item => item.series_title)
          .filter((title): title is string => typeof title === 'string');
        const translations = await translateSafely(drama, titles);
        return { ...payload, ...(Object.keys(translations).length === 0 ? {} : { translatedTitles: translations }) };
      });
    });
    server.get(`${AGENT_TOOL_ROUTE_PREFIX}/drama/browse`, async (request, reply) => {
      return flexDrama(request, reply, 'drama:read', () => drama.apiFetch('/api/v1/browse-list', {
        query: asStringRecord(request.query),
        timeoutMs: 150_000
      }));
    });
    server.get(`${AGENT_TOOL_ROUTE_PREFIX}/drama/series`, async (request, reply) => {
      return flexDrama(request, reply, 'drama:read', async () => {
        const query = request.query as Record<string, string | undefined>;
        const seriesId = query.seriesId ?? '';
        if (seriesId === '') {
          return reply.code(400).send(apiError('VALIDATION_FAILED', 'query.seriesId must not be empty'));
        }
        return await drama.apiFetch('/api/v1/search-resolve', {
          query: { seriesId },
          timeoutMs: 150_000
        });
      });
    });
    server.get(`${AGENT_TOOL_ROUTE_PREFIX}/drama/series-episodes`, async (request, reply) => {
      return flexDrama(request, reply, 'drama:read', async () => {
        const query = request.query as Record<string, string | undefined>;
        const seriesId = query.seriesId ?? '';
        if (seriesId === '') {
          return reply.code(400).send(apiError('VALIDATION_FAILED', 'query.seriesId must not be empty'));
        }
        return await drama.apiFetch('/api/v1/series-episodes', {
          query: { seriesId },
          timeoutMs: 150_000
        });
      });
    });
    server.get(`${AGENT_TOOL_ROUTE_PREFIX}/drama/tasks`, async (request, reply) => {
      return flexDrama(request, reply, 'drama:read', () => drama.apiFetch('/api/v1/download-tasks'));
    });
    server.post(`${AGENT_TOOL_ROUTE_PREFIX}/drama/download-batch`, async (request, reply) => {
      const grant = authorizeRequest(request, reply, input.capabilities, 'drama:download');
      if (grant === undefined) return;
      const body = (typeof request.body === 'object' && request.body !== null
        ? request.body
        : {}) as Record<string, unknown>;
      const seriesId = typeof body.seriesId === 'string' && body.seriesId !== '' ? body.seriesId : undefined;
      const episodes = Array.isArray(body.episodes) ? body.episodes : undefined;
      if (seriesId === undefined || episodes === undefined || episodes.length === 0) {
        return reply.code(400).send(apiError('VALIDATION_FAILED', 'body.seriesId and body.episodes (non-empty) are required'));
      }
      const validEpisodes = episodes.filter(episode =>
        typeof episode === 'object' && episode !== null
        && typeof (episode as { vid?: unknown }).vid === 'string'
        && typeof (episode as { vid_index?: unknown }).vid_index === 'number'
      );
      if (validEpisodes.length !== episodes.length) {
        return reply.code(400).send(apiError('VALIDATION_FAILED', 'each episode needs a vid string and a vid_index number'));
      }
      return flexDrama(request, reply, 'drama:download', () => drama.apiFetch('/api/v1/download-batch', {
        method: 'POST',
        body: {
          seriesId,
          ...(typeof body.seriesTitle === 'string' && body.seriesTitle !== ''
            ? { seriesTitle: body.seriesTitle }
            : {}),
          episodes: validEpisodes,
          ...(typeof body.quality === 'string' && body.quality !== '' ? { quality: body.quality } : {})
        }
      }));
    });
  }
  if (input.social !== undefined) {
    const social = input.social;

    async function flexSocial(
      request: FastifyRequest,
      reply: FastifyReply,
      scope: AgentCapabilityScope,
      run: () => unknown | Promise<unknown>
    ): Promise<unknown> {
      const grant = authorizeRequest(request, reply, input.capabilities, scope);
      if (grant === undefined) return reply;
      try {
        return await run();
      } catch (error) {
        if (error instanceof SocialError) {
          const notFound = error.code === 'social_cluster_not_found' || error.code === 'social_job_not_found';
          return reply.code(notFound ? 404 : 400).send(internalApiError(error.code, error.message));
        }
        console.warn(`Social agent tool failed: ${error instanceof Error ? error.message : String(error)}`);
        return reply.code(500).send(internalApiError('INTERNAL_ERROR', 'Social operation failed'));
      }
    }

    server.get(`${AGENT_TOOL_ROUTE_PREFIX}/social/overview`, async (request, reply) =>
      flexSocial(request, reply, 'social:read', () => social.getOverview()));
    server.post<{ Body: unknown }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/clusters`, async (request, reply) => {
      const body = parseBody(request.body, reply);
      if (body === undefined) return;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') {
        return reply.code(400).send(apiError('VALIDATION_FAILED', 'body.name must be a non-empty string'));
      }
      return flexSocial(request, reply, 'social:manage', () =>
        social.createCluster({ name, ...clusterPatchFromBody(body) }));
    });
    server.patch<{ Params: { id: string }; Body: unknown }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/clusters/:id`, async (request, reply) => {
      const body = parseBody(request.body, reply);
      if (body === undefined) return;
      return flexSocial(request, reply, 'social:manage', () =>
        social.updateCluster(request.params.id, clusterPatchFromBody(body)));
    });
    server.delete<{ Params: { id: string } }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/clusters/:id`, async (request, reply) =>
      flexSocial(request, reply, 'social:manage', () => social.deleteCluster(request.params.id)));
    server.post<{ Params: { id: string } }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/clusters/:id/check-proxy`, async (request, reply) =>
      flexSocial(request, reply, 'social:manage', () => social.checkClusterProxy(request.params.id)));
    server.post<{ Params: { id: string } }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/clusters/:id/open-browser`, async (request, reply) =>
      flexSocial(request, reply, 'social:manage', () => social.openClusterBrowser(request.params.id)));
    server.post<{ Params: { id: string } }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/clusters/:id/close-browser`, async (request, reply) =>
      flexSocial(request, reply, 'social:manage', () => social.closeClusterBrowser(request.params.id)));
    server.post<{ Body: unknown }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/jobs`, async (request, reply) => {
      const body = parseBody(request.body, reply);
      if (body === undefined) return;
      const items = parseAgentEnqueueBody(body);
      if (items === undefined) {
        return reply.code(400).send(apiError(
          'VALIDATION_FAILED',
          'body.items phải là danh sách { clusterId, path, title?, description?, scheduledAt?, platformSettings? } không rỗng'
        ));
      }
      return flexSocial(request, reply, 'social:manage', () => social.enqueue(items));
    });
    server.delete<{ Params: { id: string } }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/jobs/:id`, async (request, reply) =>
      flexSocial(request, reply, 'social:manage', () => social.removeJob(request.params.id)));
    server.patch<{ Params: { id: string }; Body: unknown }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/jobs/:id`, async (request, reply) => {
      const body = parseBody(request.body, reply);
      if (body === undefined) return;
      const scheduledAt = typeof body['scheduledAt'] === 'string' ? body['scheduledAt'] : '';
      if (scheduledAt.trim() === '') {
        return reply.code(400).send(apiError('VALIDATION_FAILED', 'body.scheduledAt (ISO) is required'));
      }
      return flexSocial(request, reply, 'social:manage', () => social.rescheduleJob(request.params.id, scheduledAt));
    });
    server.get<{ Querystring: unknown }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/downloads`, async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const limit = typeof query.limit === 'string' && /^\d+$/.test(query.limit) ? Number(query.limit) : undefined;
      return flexSocial(request, reply, 'social:read', () => social.listDownloads(limit));
    });
    server.post<{ Params: { id: string } }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/jobs/:id/retry-failed`, async (request, reply) =>
      flexSocial(request, reply, 'social:manage', () => social.retryFailedPlatforms(request.params.id)));
    server.post(`${AGENT_TOOL_ROUTE_PREFIX}/social/queue/pause`, async (request, reply) =>
      flexSocial(request, reply, 'social:manage', () => social.pause()));
    server.post(`${AGENT_TOOL_ROUTE_PREFIX}/social/queue/resume`, async (request, reply) =>
      flexSocial(request, reply, 'social:manage', () => social.resume()));
    // GĐ3: thống kê + bình luận.
    server.get(`${AGENT_TOOL_ROUTE_PREFIX}/social/stats`, async (request, reply) =>
      flexSocial(request, reply, 'social:read', () => social.getStats()));
    server.get<{ Querystring: unknown }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/comments`, async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const clusterId = typeof query.clusterId === 'string' && query.clusterId !== '' ? query.clusterId : undefined;
      const limit = typeof query.limit === 'string' && /^\d+$/.test(query.limit)
        ? Math.min(Number(query.limit), 200)
        : undefined;
      return flexSocial(request, reply, 'social:read', () => social.listComments(clusterId, limit));
    });
    server.post<{ Body: unknown }>(`${AGENT_TOOL_ROUTE_PREFIX}/social/comments/scan`, async (request, reply) => {
      const body = typeof request.body === 'object' && request.body !== null ? request.body as Record<string, unknown> : {};
      const clusterId = typeof body.clusterId === 'string' && body.clusterId !== '' ? body.clusterId : undefined;
      return flexSocial(request, reply, 'social:manage', () => social.scanComments(clusterId));
    });
  }
  server.get<{ Params: { id: string } }>(
    `${AGENT_TOOL_ROUTE_PREFIX}/schedules/:id`,
    async (request, reply) => {
      const grant = authorizeRequest(request, reply, input.capabilities, 'schedule:get');
      if (grant === undefined) return;
      const actor = toActor(grant);
      try {
        const schedule = await resolveAccessibleSchedule(
          request.params.id,
          actor,
          input.schedules,
          reply
        );
        if (schedule === undefined) return;
        return schedule;
      } catch (error) {
        return sendAgentScheduleError(error, reply);
      }
    }
  );

  server.post<{ Body: unknown }>(
    `${AGENT_TOOL_ROUTE_PREFIX}/schedules`,
    async (request, reply) => {
      const grant = authorizeRequest(request, reply, input.capabilities, 'schedule:create');
      if (grant === undefined) return;
      const body = parseBody(request.body, reply);
      if (body === undefined) return;
      try {
        const schedule = await input.schedules.createSchedule(body, toActor(grant));
        return reply.code(201).send(schedule);
      } catch (error) {
        return sendAgentScheduleError(error, reply);
      }
    }
  );

  server.patch<{ Params: { id: string }; Body: unknown }>(
    `${AGENT_TOOL_ROUTE_PREFIX}/schedules/:id`,
    async (request, reply) => {
      const grant = authorizeRequest(request, reply, input.capabilities, 'schedule:update');
      if (grant === undefined) return;
      const body = parseBody(request.body, reply);
      if (body === undefined) return;
      const actor = toActor(grant);
      try {
        const existing = await resolveAccessibleSchedule(
          request.params.id,
          actor,
          input.schedules,
          reply
        );
        if (existing === undefined) return;
        return await input.schedules.updateSchedule(existing.id, body, actor);
      } catch (error) {
        return sendAgentScheduleError(error, reply);
      }
    }
  );

  await registerBoundActionRoute(
    server,
    input,
    'pause',
    'schedule:pause',
    async (id, actor) => input.schedules.pauseSchedule(id, actor)
  );
  await registerBoundActionRoute(
    server,
    input,
    'resume',
    'schedule:resume',
    async (id, actor) => input.schedules.resumeSchedule(id, actor)
  );
  await registerBoundActionRoute(
    server,
    input,
    'run-now',
    'schedule:run_now',
    async (id, actor) => input.schedules.runScheduleNow(id, actor),
    202
  );
}

function parseOptionalNonNegativeInteger(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return parsed;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function readRequiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value as number;
}

/** Giữ lại các cặp key=value chuỗi của query; phần còn lại không tương hợp bị bỏ qua. */
function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' && raw !== '') out[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = String(raw);
  }
  return out;
}

/** Dịch tên phim cho trình trợ lý; lỗi dịch không cản trở kết quả tìm kiếm. */
async function translateSafely(
  drama: AgentDramaOperations,
  titles: readonly string[]
): Promise<Record<string, string>> {
  if (titles.length === 0) return {};
  return await drama.translateTitles(titles, 'vi').catch(() => ({}));
}

async function registerBoundActionRoute(
  server: FastifyInstance,
  input: {
    capabilities: AgentCapabilityTokenStore;
    schedules: AgentScheduleOperations;
  },
  action: string,
  scope: AgentCapabilityScope,
  operation: (
    id: string,
    actor: AgentScheduleActor
  ) => Promise<ScheduleResponse | RunScheduleNowResponse>,
  successStatus = 200
): Promise<void> {
  server.post<{ Params: { id: string }; Body: unknown }>(
    `${AGENT_TOOL_ROUTE_PREFIX}/schedules/:id/${action}`,
    async (request, reply) => {
      const grant = authorizeRequest(request, reply, input.capabilities, scope);
      if (grant === undefined) return;
      if (hasActorOverride(request.body)) {
        return reply.code(400).send(
          apiError('VALIDATION_FAILED', 'runId and threadId are not accepted')
        );
      }
      const actor = toActor(grant);
      try {
        const existing = await resolveAccessibleSchedule(
          request.params.id,
          actor,
          input.schedules,
          reply
        );
        if (existing === undefined) return;
        return reply.code(successStatus).send(await operation(existing.id, actor));
      } catch (error) {
        return sendAgentScheduleError(error, reply);
      }
    }
  );
}

function authorizeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  capabilities: AgentCapabilityTokenStore,
  scope: AgentCapabilityScope
): AgentCapabilityGrant | undefined {
  try {
    const grant = capabilities.authorize(
      readBearerToken(request.headers.authorization),
      { scope }
    );
    if (grant.createdBy === 'schedule' && scope !== 'schedule:get') {
      reply.code(403).send(internalApiError(
        'CAPABILITY_SCOPE_FORBIDDEN',
        'Automatic schedule runs cannot mutate schedules'
      ));
      return undefined;
    }
    return grant;
  } catch (error) {
    if (!(error instanceof AgentCapabilityTokenError)) throw error;
    reply.code(error.statusCode).send(
      internalApiError(error.code, capabilityErrorMessage(error.code))
    );
    return undefined;
  }
}

async function resolveAccessibleSchedule(
  id: string,
  actor: AgentScheduleActor,
  schedules: AgentScheduleOperations,
  reply: FastifyReply
): Promise<ScheduleDetailResponse | undefined> {
  const actorThread = await schedules.getActorThread(actor);
  if (actorThread === undefined || actorThread.status !== 'active') {
    reply.code(403).send(internalApiError(
      'CAPABILITY_THREAD_FORBIDDEN',
      'Capability thread is unavailable'
    ));
    return undefined;
  }

  let resolvedId = id;
  if (id === 'current') {
    if (actorThread.purpose === 'schedule_task') {
      if (actorThread.scheduleId === undefined) {
        reply.code(409).send(apiError(
          'SCHEDULE_THREAD_MISSING',
          'Current task thread is not bound to a schedule'
        ));
        return undefined;
      }
      resolvedId = actorThread.scheduleId;
    } else {
      const candidates = (await schedules.listSchedules(actor))
        .filter(schedule => schedule.canonicalCwd === actorThread.canonicalCwd);
      if (candidates.length === 0) {
        reply.code(404).send(apiError('SCHEDULE_NOT_FOUND', 'Schedule not found'));
        return undefined;
      }
      if (candidates.length > 1) {
        reply.code(409).send({
          ...internalApiError(
            'SCHEDULE_SELECTION_REQUIRED',
            'Multiple schedules are available'
          ),
          candidates: candidates.map(toScheduleCandidate)
        });
        return undefined;
      }
      resolvedId = candidates[0]!.id;
    }
  }

  const schedule = await schedules.getSchedule(resolvedId, actor);
  if (schedule === undefined) {
    reply.code(404).send(apiError('SCHEDULE_NOT_FOUND', 'Schedule not found'));
    return undefined;
  }
  const allowed = actorThread.purpose === 'schedule_task'
    ? schedule.threadId === actorThread.id
    : schedule.canonicalCwd === actorThread.canonicalCwd;
  if (!allowed) {
    reply.code(403).send(internalApiError(
      'CAPABILITY_THREAD_FORBIDDEN',
      'Capability does not allow access to this schedule'
    ));
    return undefined;
  }
  return schedule;
}

function toScheduleCandidate(schedule: ScheduleResponse) {
  return {
    scheduleId: schedule.id,
    threadId: schedule.threadId,
    name: schedule.name,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt ?? null
  };
}

function parseBody(
  body: unknown,
  reply: FastifyReply
): Record<string, unknown> | undefined {
  if (!isPlainObject(body)) {
    reply.code(400).send(apiError('VALIDATION_FAILED', 'body must be an object'));
    return undefined;
  }
  if (hasActorOverride(body)) {
    reply.code(400).send(
      apiError('VALIDATION_FAILED', 'runId and threadId are not accepted')
    );
    return undefined;
  }
  return body;
}

function hasActorOverride(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasActorOverride);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, entry]) => {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (
      normalized === 'runid'
      || normalized === 'threadid'
      || normalized === 'actorrunid'
      || normalized === 'actorthreadid'
    ) {
      return true;
    }
    return hasActorOverride(entry);
  });
}

export function readBearerToken(value: string | undefined): string | undefined {
  if (value === undefined || !value.startsWith('Bearer ')) return undefined;
  const token = value.slice('Bearer '.length);
  return token.length === 0 || /\s/.test(token) ? undefined : token;
}

function toActor(grant: AgentCapabilityGrant): AgentScheduleActor {
  return {
    runId: grant.runId,
    threadId: grant.threadId,
    createdBy: grant.createdBy
  };
}

function capabilityErrorMessage(code: AgentCapabilityTokenError['code']): string {
  if (code === 'CAPABILITY_TOKEN_MISSING') return 'Capability token required';
  if (code === 'CAPABILITY_CONTEXT_INACTIVE') {
    return 'Capability context is inactive';
  }
  if (code === 'CAPABILITY_CONTEXT_ACTIVE') {
    return 'Capability context is already active';
  }
  if (
    code === 'CAPABILITY_TOKEN_INVALID'
    || code === 'CAPABILITY_TOKEN_EXPIRED'
    || code === 'CAPABILITY_TOKEN_REVOKED'
  ) {
    return 'Capability token is invalid';
  }
  return 'Capability does not allow this operation';
}

function sendAgentScheduleError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof SchedulerError)) {
    return reply.code(500).send(apiError('INTERNAL_ERROR', 'Internal error'));
  }
  if (error.code === 'VALIDATION_FAILED') {
    return reply.code(400).send(apiError(error.code, error.message));
  }
  if (error.code === 'SCHEDULE_INVALID') {
    return reply.code(422).send(apiError(error.code, error.message));
  }
  if (error.code === 'SCHEDULE_NOT_FOUND' || error.code === 'CODEX_PROFILE_NOT_FOUND') {
    return reply.code(404).send(apiError(error.code, error.message));
  }
  if (
    error.code === 'SCHEDULE_HAS_ACTIVE_RUN'
    || error.code === 'SCHEDULE_THREAD_MISSING'
    || error.code === 'SCHEDULE_THREAD_ARCHIVED'
  ) {
    return reply.code(409).send(apiError(error.code, error.message));
  }
  if (error.code === 'CODEX_PROFILE_INVALID' || error.code === 'CODEX_CONFIG_INVALID') {
    return reply.code(422).send(apiError(error.code, error.message));
  }
  return reply.code(500).send(apiError('INTERNAL_ERROR', 'Internal error'));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function internalApiError(code: string, message: string) {
  return { error: { code, message } };
}

/** Chỉ giữ các patch hợp lệ cho cụm — phần còn lại bị bỏ qua. */
function clusterPatchFromBody(body: Record<string, unknown>): SocialClusterPatch {
  const patch: SocialClusterPatch = {};
  if (typeof body.name === 'string' && body.name.trim() !== '') patch.name = body.name;
  if (typeof body.seriesName === 'string') patch.seriesName = body.seriesName;
  if (typeof body.proxyServer === 'string') patch.proxyServer = body.proxyServer;
  if (body.fbMode === 'graph_api' || body.fbMode === 'browser') patch.fbMode = body.fbMode;
  if (typeof body.fbPageId === 'string') patch.fbPageId = body.fbPageId;
  if (typeof body.fbPageToken === 'string' && body.fbPageToken.trim() !== '' || body.fbPageToken === null) {
    patch.fbPageToken = body.fbPageToken as string | null;
  }
  if (Array.isArray(body.defaultScheduleTimes)) {
    const times = (body.defaultScheduleTimes as unknown[])
      .filter((time): time is string => typeof time === 'string' && /^\d{1,2}:\d{2}$/.test(time));
    if (times.length > 0) patch.defaultScheduleTimes = times;
  }
  if (typeof body.defaultDescription === 'string') patch.defaultDescription = body.defaultDescription;
  if (typeof body.ytChannelUrl === 'string') patch.ytChannelUrl = body.ytChannelUrl;
  if (typeof body.tkProfileUrl === 'string') patch.tkProfileUrl = body.tkProfileUrl;
  if (typeof body.autoReplyEnabled === 'boolean') patch.autoReplyEnabled = body.autoReplyEnabled;
  if (typeof body.autoReplyPrompt === 'string') patch.autoReplyPrompt = body.autoReplyPrompt;
  return patch;
}

type AgentEnqueueItem = {
  clusterId: string;
  path: string;
  title?: string;
  description?: string;
  thumbnailPath?: string | null;
  scheduledAt?: string | null;
  platformSettings?: SocialPlatformSettings;
};

/** Dựng danh sách SocialEnqueueRequest từ body của công cụ trợ lý; bất hợp lệ → undefined. */
function parseAgentEnqueueBody(body: Record<string, unknown>): SocialEnqueueRequest[] | undefined {
  if (!Array.isArray(body.items) || body.items.length === 0) return undefined;
  const items: SocialEnqueueRequest[] = [];
  for (const raw of body.items) {
    if (!isPlainObject(raw)) return undefined;
    if (typeof raw.clusterId !== 'string' || raw.clusterId.trim() === '') return undefined;
    if (typeof raw.path !== 'string' || raw.path.trim() === '') return undefined;
    if (raw.platformSettings !== undefined && !isPlainObject(raw.platformSettings)) return undefined;
    items.push({
      clusterId: raw.clusterId,
      path: raw.path,
      ...(typeof raw.title === 'string' && raw.title.trim() !== '' ? { title: raw.title.trim() } : {}),
      ...(typeof raw.description === 'string' && raw.description.trim() !== '' ? { description: raw.description.trim() } : {}),
      ...(typeof raw.scheduledAt === 'string' && raw.scheduledAt.trim() !== '' ? { scheduledAt: raw.scheduledAt.trim() } : {}),
      ...(raw.thumbnailPath === null ? { thumbnailPath: null } : {}),
      ...(raw.platformSettings !== undefined ? { platformSettings: sanitizePlatformSettings(raw.platformSettings) } : {})
    });
  }
  return items;
}
