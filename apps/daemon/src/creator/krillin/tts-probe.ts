import type { CreatorTtsProvider } from '@opencreator/protocol';
import type { DubbingTtsCandidate } from './tts-dubbing-provider.js';
import type { KrillinTtsService } from './tts-service.js';

const probeText = 'xin chào';
const probeTimeoutMs = 15_000;

/**
 * Tổng hợp thử một đoạn rất ngắn để biết provider TTS thực sự phản hồi. Dùng cho
 * giai đoạn lồng tiếng của Dịch video: một provider "trông như đã cấu hình" vẫn có
 * thể bị máy chủ từ chối (ví dụ gateway cục bộ không có thông tin đăng nhập).
 */
export async function probeDubbingTtsProvider(
  tts: Pick<KrillinTtsService, 'synthesize'>,
  candidate: DubbingTtsCandidate
): Promise<boolean> {
  if (candidate.provider === 'edge-tts') return true;
  try {
    const result = await tts.synthesize({
      text: probeText,
      provider: candidate.provider as CreatorTtsProvider,
      ...(candidate.model === undefined ? {} : { model: candidate.model }),
      ...(candidate.voiceId === undefined ? {} : { voiceId: candidate.voiceId }),
      format: 'mp3',
      speed: 1,
      signal: AbortSignal.timeout(probeTimeoutMs)
    });
    return result.content.length > 0;
  } catch {
    return false;
  }
}
