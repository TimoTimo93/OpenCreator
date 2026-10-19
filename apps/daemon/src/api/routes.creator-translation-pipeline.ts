import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  PipelineEnqueueRequest,
  TranslationPipelineService
} from '../creator/translation-pipeline/pipeline.js';
import { apiError } from './errors.js';

/**
 * REST cho hàng đợi tự động dịch:
 * - GET    /creator/translation-pipeline                      → trạng thái
 * - POST   /creator/translation-pipeline/enqueue              → nạp file (web và trợ lý AI)
 * - POST   /creator/translation-pipeline/pause | resume       → tạm dừng / tiếp tục
 * - POST   /creator/translation-pipeline/merge                → ghép ngay phần đã xong
 * - DELETE /creator/translation-pipeline/items/:id            → hủy / bỏ mục
 * - POST   /creator/translation-pipeline/items/:id/retry      → dịch lại mục lỗi
 * - POST   /creator/translation-pipeline/clear-finished       → dọn các mục xong
 */
export async function registerTranslationPipelineRoutes(
  server: FastifyInstance,
  pipeline?: TranslationPipelineService
): Promise<void> {
  if (pipeline === undefined) {
    server.get('/creator/translation-pipeline', async (_request, reply) =>
      reply.code(503).send(apiError(
        'creator_pipeline_unavailable',
        'Hàng đợi tự động dịch chưa được cắm vào runtime này'
      ))
    );
    return;
  }
  const summary = () => pipeline.getSummary();

  server.get('/creator/translation-pipeline', async () => summary());

  server.post<{ Body: unknown }>('/creator/translation-pipeline/enqueue', async (request, reply) => {
    const body = request.body;
    if (typeof body !== 'object' || body === null) {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'body must be an object'));
    }
    const items = (body as { items?: unknown }).items;
    if (!Array.isArray(items) || items.length === 0) {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'body.items must be a non-empty array'));
    }
    const parsed: PipelineEnqueueRequest[] = [];
    for (const item of items) {
      if (typeof item !== 'object' || item === null) {
        return reply.code(400).send(apiError('VALIDATION_FAILED', 'each item must be an object'));
      }
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.path !== 'string' || candidate.path.trim() === '') {
        return reply.code(400).send(apiError('VALIDATION_FAILED', 'item.path (file path) is required'));
      }
      parsed.push({
        path: candidate.path,
        ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
        ...(typeof candidate.seriesKey === 'string'
          ? { seriesKey: candidate.seriesKey }
          : candidate.seriesKey === null ? { seriesKey: null } : {}),
        ...(typeof candidate.episodeIndex === 'number'
          ? { episodeIndex: candidate.episodeIndex }
          : {}),
        // GĐ4: passthrough project đích (A3 gửi khi nạp cả bộ).
        ...(typeof candidate.projectId === 'string' && candidate.projectId.trim() !== ''
          ? { projectId: candidate.projectId.trim() }
          : {})
      });
    }
    return pipeline.enqueue(parsed);
  });

  server.post('/creator/translation-pipeline/pause', async () => pipeline.pause());
  server.post('/creator/translation-pipeline/resume', async () => pipeline.resume());
  server.post('/creator/translation-pipeline/merge', async () => pipeline.mergeNow());
  server.post('/creator/translation-pipeline/clear-finished', async () => pipeline.clearFinished());

  server.delete<{ Params: { id: string } }>('/creator/translation-pipeline/items/:id', async (request, reply) => {
    const { id } = request.params;
    const before = summary();
    if (before.items.every(item => item.id !== id)) {
      return reply.code(404).send(apiError('creator_pipeline_item_not_found', 'Không tìm thấy mục trong hàng đợi'));
    }
    return pipeline.remove(id);
  });

  server.post<{ Params: { id: string } }>('/creator/translation-pipeline/items/:id/retry', async (request, reply) => {
    const { id } = request.params;
    const summary = pipeline.getSummary();
    if (summary.items.every(item => item.id !== id)) {
      return reply.code(404).send(apiError('creator_pipeline_item_not_found', 'Không tìm thấy mục trong hàng đợi'));
    }
    return pipeline.retry(id);
  });
}
