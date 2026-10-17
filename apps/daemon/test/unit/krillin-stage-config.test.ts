import { createDefaultCreatorServicesConfig } from '@opencreator/protocol';
import { describe, expect, it } from 'vitest';
import { stageConfig } from '../../src/creator/krillin/cli-runner.js';

function baseConfig() {
  const config = createDefaultCreatorServicesConfig();
  config.tts.provider = 'openai';
  config.tts.openai.baseUrl = 'http://localhost:20128/v1';
  config.tts.openai.apiKey = '9router';
  config.tts.openai.model = 'gpt-4o-mini-tts';
  config.tts.aliyun.apiKey = 'dashscope-key';
  return config;
}

describe('krillin stage config', () => {
  it('leaves non-TTS stages untouched', () => {
    const config = baseConfig();
    expect(stageConfig(config, 'subtitle', { ttsProvider: 'aliyun' })).toBe(config);
  });

  it('ignores providers the CLI cannot use', () => {
    const config = baseConfig();
    expect(stageConfig(config, 'tts', { ttsProvider: 'elevenlabs' })).toBe(config);
  });

  it('overrides the provider and model from the job snapshot', () => {
    const config = baseConfig();
    const result = stageConfig(config, 'tts', {
      ttsProvider: 'aliyun',
      ttsModel: 'qwen3-tts-instruct-flash'
    });
    expect(result.tts.provider).toBe('aliyun');
    expect(result.tts.aliyun.model).toBe('qwen3-tts-instruct-flash');
    // Không sửa cấu hình gốc.
    expect(config.tts.provider).toBe('openai');
  });

  it('routes the OpenAI-compatible TTS endpoint to the local Edge TTS gateway', () => {
    const config = baseConfig();
    const result = stageConfig(
      config,
      'tts',
      { ttsProvider: 'openai', ttsModel: 'edge-tts/vi-VN-HoaiMyNeural' },
      {
        baseUrl: 'http://127.0.0.1:4321/internal/krillin-tts/v1',
        apiKey: 'octts_local',
        model: 'edge-tts/vi-VN-HoaiMyNeural',
        defaultVoiceId: 'vi-VN-HoaiMyNeural'
      }
    );
    expect(result.tts).toMatchObject({
      provider: 'openai',
      openai: {
        baseUrl: 'http://127.0.0.1:4321/internal/krillin-tts/v1',
        apiKey: 'octts_local',
        model: 'edge-tts/vi-VN-HoaiMyNeural',
        defaultVoiceId: 'vi-VN-HoaiMyNeural'
      }
    });
    expect(config.tts.openai.baseUrl).toBe('http://localhost:20128/v1');
  });

  it('routes render stages to the local TTS gateway too', () => {
    // render-horizontal/render-vertical cũng tự sinh giọng khi lồng tiếng; nếu không
    // nhận cổng cục bộ chúng sẽ gọi thẳng nhà cung cấp ngoài và lỗi.
    const config = baseConfig();
    for (const stageId of ['render-horizontal', 'render-vertical']) {
      const result = stageConfig(config, stageId, {}, {
        baseUrl: 'http://127.0.0.1:4321/internal/krillin-tts/v1',
        apiKey: 'octts_local',
        model: 'Hải Đăng',
        defaultVoiceId: 'Hải Đăng'
      });
      expect(result.tts).toMatchObject({
        provider: 'openai',
        openai: {
          baseUrl: 'http://127.0.0.1:4321/internal/krillin-tts/v1',
          apiKey: 'octts_local',
          model: 'Hải Đăng',
          defaultVoiceId: 'Hải Đăng'
        }
      });
    }
    expect(config.tts.openai.baseUrl).toBe('http://localhost:20128/v1');
  });

  it('leaves render stages untouched without a local gateway', () => {
    const config = baseConfig();
    expect(stageConfig(config, 'render-horizontal', { ttsProvider: 'aliyun' })).toBe(config);
  });
});
