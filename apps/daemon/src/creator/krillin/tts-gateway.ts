import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Cổng TTS cục bộ cho KrillinAI CLI.
 *
 * CLI chỉ biết nói chuyện với một endpoint TTS kiểu OpenAI (`POST /audio/speech`).
 * Cổng này giả lập endpoint đó nhưng tổng hợp giọng bằng cục bộ: ưu tiên VieNeu-TTS
 * v3 Turbo (giọng Việt chất lượng cao, chạy CPU), và chỉ rơi về Edge TTS (miễn phí)
 * khi VieNeu không dùng được. Nhờ vậy giai đoạn lồng tiếng của Dịch video vẫn chạy
 * khi mọi provider có khóa đều bị từ chối — mà vẫn giữ được chất lượng giọng đọc.
 *
 * Tuyến nằm dưới tiền tố nội bộ đã miễn xác thực của daemon và tự kiểm tra token riêng.
 */

export const KRILLIN_TTS_ROUTE_PREFIX = '/internal/krillin-tts';

export type KrillinTtsGatewayConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultVoiceId: string;
};

export type KrillinTtsAudio = {
  audio: Buffer;
  format: 'mp3' | 'wav';
};

export function createKrillinTtsGateway(input: {
  synthesize(request: { text: string; voice: string; speed?: number }): Promise<KrillinTtsAudio>;
}) {
  const token = `octts_${randomBytes(32).toString('base64url')}`;

  return {
    config(baseUrl: string, voice: string): KrillinTtsGatewayConfig {
      const resolved = voice.trim() === '' ? 'vi-VN-HoaiMyNeural' : voice.trim();
      return {
        baseUrl: `${baseUrl}${KRILLIN_TTS_ROUTE_PREFIX}/v1`,
        apiKey: token,
        model: resolved,
        defaultVoiceId: resolved
      };
    },
    async register(server: FastifyInstance): Promise<void> {
      server.post(`${KRILLIN_TTS_ROUTE_PREFIX}/v1/audio/speech`, async (request, reply) => {
        if (!authorized(request, token)) {
          return reply.code(401).send({ error: { message: 'Invalid Krillin TTS token', code: 'unauthorized' } });
        }
        const body = record(request.body);
        const text = typeof body?.input === 'string' ? body.input.trim() : '';
        if (text === '') {
          return reply.code(400).send({ error: { message: 'input must be a non-empty string', code: 'invalid_request' } });
        }
        const voice = readVoice(body);
        try {
          const audio = await input.synthesize({ text, voice, speed: readSpeed(body) });
          return reply
            .header('content-type', audio.format === 'wav' ? 'audio/wav' : 'audio/mpeg')
            .header('content-length', String(audio.audio.length))
            .send(audio.audio);
        } catch (error) {
          return reply.code(502).send({
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: 'upstream_error',
              code: 'tts_synthesis_failed'
            }
          });
        }
      });
    }
  };
}

/** Giọng đọc: ưu tiên trường `voice`, rồi tới hậu tố của `model` (`<provider>/<giọng>`). */
function readVoice(body: Record<string, unknown> | undefined): string {
  const direct = typeof body?.voice === 'string' ? body.voice.trim() : '';
  if (direct !== '') return direct;
  const model = typeof body?.model === 'string' ? body.model.trim() : '';
  const slash = model.indexOf('/');
  if (slash >= 0 && slash < model.length - 1) return model.slice(slash + 1);
  return 'vi-VN-HoaiMyNeural';
}

function readSpeed(body: Record<string, unknown> | undefined): number | undefined {
  const value = body?.speed;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function authorized(request: FastifyRequest, token: string): boolean {
  const value = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const left = Buffer.from(value);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
