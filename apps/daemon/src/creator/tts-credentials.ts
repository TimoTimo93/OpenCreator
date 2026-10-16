import type { CreatorServicesConfig } from '@opencreator/protocol';
import { hasValidOpenAiApiKey } from '@opencreator/protocol';

/**
 * Kiểm tra provider TTS (openai/aliyun/minimax/volcengine/edge-tts/elevenlabs/vieneu)
 * đã có đủ thông tin đăng nhập trong cấu hình dịch vụ chưa. Edge TTS và VieNeu chạy
 * cục bộ nên luôn sẵn sàng. Khóa của gateway cục bộ (9router) không được coi là
 * thông tin đăng nhập thật.
 */
export function providerHasTtsCredentials(
  config: CreatorServicesConfig,
  provider: string
): boolean {
  if (provider === 'edge-tts' || provider === 'vieneu') return true;
  if (provider === 'elevenlabs') {
    return (config.tts.elevenlabs?.apiKeys?.some(key => key.trim().length > 0) ?? false);
  }
  if (provider === 'openai') return hasValidOpenAiApiKey(config.tts.openai.apiKey);
  if (provider === 'minimax') return config.tts.minimax.apiKey.trim().length > 0;
  if (provider === 'volcengine') {
    return (
      config.tts.volcengine.appId.trim().length > 0
      && config.tts.volcengine.accessToken.trim().length > 0
    );
  }
  return config.tts.aliyun.apiKey.trim().length > 0;
}
