import type { EdgeTtsEngine } from './edge-tts-engine.js';
import type { KrillinTtsAudio } from './tts-gateway.js';
import {
  edgeFallbackVoice,
  hasVietnameseText,
  isCjkText,
  isEdgeTtsVoice
} from './tts-dubbing-provider.js';
import type { VieNeuEngine } from './vieneu-engine.js';

/**
 * Tổng hợp giọng cho cổng TTS cục bộ của KrillinAI CLI.
 *
 * Ưu tiên VieNeu-TTS v3 Turbo (giọng Việt chất lượng cao, chạy CPU cục bộ). Rơi về
 * Edge TTS (miễn phí) khi:
 *  - người dùng chọn thẳng một giọng Edge,
 *  - văn bản còn chữ Hán mà không có tiếng Việt (VieNeu là TTS tiếng Việt), hoặc
 *  - VieNeu lỗi/không dùng được.
 *
 * Nhờ vậy giai đoạn lồng tiếng luôn tạo được âm thanh thay vì dừng cả video.
 */
export function createLocalTtsSynthesizer(input: {
  vieNeu: VieNeuEngine;
  edge: EdgeTtsEngine;
}): {
  synthesize(request: { text: string; voice: string; speed?: number }): Promise<KrillinTtsAudio>;
} {
  return {
    async synthesize(request) {
      const requested = request.voice.trim();
      const vieNeuCapable = !isEdgeTtsVoice(requested)
        && !(isCjkText(request.text) && !hasVietnameseText(request.text));
      if (vieNeuCapable) {
        try {
          return await input.vieNeu.synthesize(request);
        } catch {
          // VieNeu không dùng được cho đoạn này: rơi về Edge TTS bên dưới.
        }
      }
      const audio = await input.edge.synthesize({
        text: request.text,
        voice: edgeFallbackVoice(request.text, requested),
        speed: request.speed
      });
      return { audio, format: 'mp3' };
    }
  };
}
