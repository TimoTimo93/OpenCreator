import type { CreatorServicesConfig } from '@opencreator/protocol';

/**
 * Kiểm tra provider TTS (openai/aliyun/minimax/volcengine/edge-tts) đã có đủ
 * thông tin đăng nhập trong cấu hình dịch vụ chưa. Edge TTS miễn phí nên luôn
 * sẵn sàng. Bộ điều phối dùng hàm này để tự chuyển sang Edge TTS khi người
 * dùng chưa cấu hình (hoặc cấu hình thiếu) khóa API — video vẫn có lồng tiếng
 * thay vì bị dừng chờ cấu hình.
 */
export function providerHasTtsCredentials(
  config: CreatorServicesConfig,
  provider: string
): boolean {
  if (provider === 'edge-tts') return true;
  if (provider === 'openai') return config.tts.openai.apiKey.trim().length > 0;
  if (provider === 'minimax') return config.tts.minimax.apiKey.trim().length > 0;
  if (provider === 'volcengine') {
    return (
      config.tts.volcengine.appId.trim().length > 0
      && config.tts.volcengine.accessToken.trim().length > 0
    );
  }
  return config.tts.aliyun.apiKey.trim().length > 0;
}
