import { createDefaultCreatorServicesConfig } from '@opencreator/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  isLoopbackBaseUrl,
  resolveDubbingTtsDecision,
  type DubbingTtsCandidate
} from '../../src/creator/krillin/tts-dubbing-provider.js';
import { probeDubbingTtsProvider } from '../../src/creator/krillin/tts-probe.js';

function gatewayConfig(apiKey = 'sk-local-gateway') {
  const config = createDefaultCreatorServicesConfig();
  config.tts.provider = 'openai';
  config.tts.openai.baseUrl = 'http://localhost:20128/v1';
  config.tts.openai.apiKey = apiKey;
  config.tts.openai.model = 'gpt-4o-mini-tts';
  config.tts.openai.defaultVoiceId = 'marin';
  return config;
}

describe('resolveDubbingTtsDecision', () => {
  it('keeps the configured provider when the probe succeeds', async () => {
    const probe = vi.fn(async () => true);
    const decision = await resolveDubbingTtsDecision({
      config: gatewayConfig(),
      requestedProvider: 'openai',
      requestedModel: 'gpt-4o-mini-tts',
      requestedVoice: 'marin',
      targetLanguage: 'vi',
      probe
    });
    expect(decision).toEqual({ ttsProvider: 'openai' });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4o-mini-tts', voiceId: 'marin' });
  });

  it('routes through the local gateway Edge TTS voice when the configured provider is rejected', async () => {
    const probe = vi.fn(async (candidate: DubbingTtsCandidate) => candidate.model?.startsWith('edge-tts/') === true);
    const decision = await resolveDubbingTtsDecision({
      config: gatewayConfig(),
      requestedProvider: 'openai',
      requestedModel: 'gpt-4o-mini-tts',
      requestedVoice: 'marin',
      targetLanguage: 'vi',
      probe
    });
    expect(decision).toMatchObject({
      ttsProvider: 'openai',
      ttsModel: 'edge-tts/vi-VN-HoaiMyNeural',
      voiceCode: 'vi-VN-HoaiMyNeural'
    });
    expect(decision.notice).toBeTruthy();
    expect(probe).toHaveBeenLastCalledWith({
      provider: 'openai',
      model: 'edge-tts/vi-VN-HoaiMyNeural',
      voiceId: 'vi-VN-HoaiMyNeural'
    });
  });

  it('prefers a requested Edge TTS voice over the language default', async () => {
    const probe = vi.fn(async (candidate: DubbingTtsCandidate) => candidate.model?.startsWith('edge-tts/') === true);
    const decision = await resolveDubbingTtsDecision({
      config: gatewayConfig(),
      requestedProvider: 'openai',
      requestedVoice: 'vi-VN-NamMinhNeural',
      targetLanguage: 'vi',
      probe
    });
    expect(decision).toMatchObject({ ttsModel: 'edge-tts/vi-VN-NamMinhNeural', voiceCode: 'vi-VN-NamMinhNeural' });
  });

  it('falls back to the bundled Edge TTS provider when the gateway route is unavailable', async () => {
    const probe = vi.fn(async () => false);
    const decision = await resolveDubbingTtsDecision({
      config: gatewayConfig(),
      requestedProvider: 'openai',
      requestedVoice: 'marin',
      targetLanguage: 'vi',
      probe
    });
    expect(decision.ttsProvider).toBe('edge-tts');
    expect(decision.ttsModel).toBeUndefined();
  });

  it('does not use the gateway route for a remote TTS endpoint', async () => {
    const config = gatewayConfig();
    config.tts.openai.baseUrl = 'https://api.openai.com/v1';
    const probe = vi.fn(async () => false);
    const decision = await resolveDubbingTtsDecision({
      config,
      requestedProvider: 'openai',
      requestedVoice: 'marin',
      targetLanguage: 'vi',
      probe
    });
    expect(decision.ttsProvider).toBe('edge-tts');
    expect(probe).toHaveBeenCalledOnce();
  });

  it('does not use the gateway route without a language mapping', async () => {
    const probe = vi.fn(async () => false);
    const decision = await resolveDubbingTtsDecision({
      config: gatewayConfig(),
      requestedProvider: 'openai',
      requestedVoice: 'marin',
      targetLanguage: 'auto',
      probe
    });
    expect(decision.ttsProvider).toBe('edge-tts');
    expect(probe).toHaveBeenCalledOnce();
  });

  it('falls back for providers the KrillinAI CLI cannot synthesize', async () => {
    const config = gatewayConfig();
    config.tts.provider = 'elevenlabs';
    config.tts.elevenlabs = {
      baseUrl: 'https://api.elevenlabs.io',
      apiKeys: ['key'],
      model: 'eleven_multilingual_v2',
      defaultVoiceId: 'voice'
    };
    const probe = vi.fn(async () => false);
    const decision = await resolveDubbingTtsDecision({
      config,
      requestedProvider: 'elevenlabs',
      requestedVoice: 'voice',
      targetLanguage: 'vi',
      probe
    });
    expect(decision.ttsProvider).toBe('edge-tts');
  });

  it('keeps the missing-credential fallback when no probe is available', async () => {
    const config = gatewayConfig('');
    const decision = await resolveDubbingTtsDecision({
      config,
      requestedProvider: 'openai',
      targetLanguage: 'vi'
    });
    expect(decision).toMatchObject({ ttsProvider: 'edge-tts' });
    expect(decision.notice).toBeTruthy();
  });

  it('treats the local gateway placeholder key as unconfigured', async () => {
    const probe = vi.fn(async (candidate: DubbingTtsCandidate) => candidate.model?.startsWith('edge-tts/') === true);
    const decision = await resolveDubbingTtsDecision({
      config: gatewayConfig('9router'),
      requestedProvider: 'openai',
      requestedVoice: 'marin',
      targetLanguage: 'vi',
      probe
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({ ttsProvider: 'openai', ttsModel: 'edge-tts/vi-VN-HoaiMyNeural' });
  });

  it('keeps a working configuration when no probe is available', async () => {
    const decision = await resolveDubbingTtsDecision({
      config: gatewayConfig(),
      requestedProvider: 'openai',
      targetLanguage: 'vi'
    });
    expect(decision).toEqual({ ttsProvider: 'openai' });
  });
});

describe('isLoopbackBaseUrl', () => {
  it.each([
    ['http://localhost:20128/v1', true],
    ['http://127.0.0.1:8080/v1', true],
    ['https://api.openai.com/v1', false],
    ['', false],
    ['not a url', false]
  ])('classifies %s', (value, expected) => {
    expect(isLoopbackBaseUrl(value)).toBe(expected);
  });
});

describe('probeDubbingTtsProvider', () => {
  it('treats edge-tts as always usable without a request', async () => {
    const synthesize = vi.fn();
    await expect(probeDubbingTtsProvider({ synthesize }, { provider: 'edge-tts' })).resolves.toBe(true);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('reports failure when synthesis throws', async () => {
    const synthesize = vi.fn(async () => {
      throw new Error('HTTP 400');
    });
    await expect(probeDubbingTtsProvider({ synthesize }, { provider: 'openai', model: 'gpt-4o-mini-tts' }))
      .resolves.toBe(false);
  });

  it('forwards the candidate model and voice to synthesis', async () => {
    const synthesize = vi.fn(async () => ({ content: Buffer.from([1, 2, 3]) }));
    await expect(probeDubbingTtsProvider(
      { synthesize } as never,
      { provider: 'openai', model: 'edge-tts/vi-VN-HoaiMyNeural', voiceId: 'vi-VN-HoaiMyNeural' }
    )).resolves.toBe(true);
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'edge-tts/vi-VN-HoaiMyNeural',
      voiceId: 'vi-VN-HoaiMyNeural',
      format: 'mp3',
      speed: 1
    }));
  });
});
