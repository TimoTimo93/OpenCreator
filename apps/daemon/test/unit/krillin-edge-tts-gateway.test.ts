import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createKrillinTtsGateway } from '../../src/creator/krillin/tts-gateway.js';
import {
  createEdgeTtsProbe,
  prosodyOptions,
  rateOption,
  type EdgeTtsEngine
} from '../../src/creator/krillin/edge-tts-engine.js';

describe('Krillin local TTS gateway', () => {
  it('serves OpenAI-compatible speech through the local synthesizer', async () => {
    const synthesize = vi.fn(async () => ({ audio: Buffer.from('mp3-bytes'), format: 'mp3' as const }));
    const gateway = createKrillinTtsGateway({ synthesize });
    const server = Fastify();
    await gateway.register(server);
    const config = gateway.config('http://127.0.0.1:1234', 'vi-VN-HoaiMyNeural');

    const response = await server.inject({
      method: 'POST',
      url: '/internal/krillin-tts/v1/audio/speech',
      headers: { authorization: `Bearer ${config.apiKey}` },
      payload: { model: 'edge-tts/vi-VN-HoaiMyNeural', voice: 'vi-VN-HoaiMyNeural', input: 'Xin chào', speed: 1.1 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('audio/mpeg');
    expect(response.rawPayload.toString()).toBe('mp3-bytes');
    expect(synthesize).toHaveBeenCalledWith({ text: 'Xin chào', voice: 'vi-VN-HoaiMyNeural', speed: 1.1 });
    expect(config).toMatchObject({
      baseUrl: 'http://127.0.0.1:1234/internal/krillin-tts/v1',
      model: 'vi-VN-HoaiMyNeural',
      defaultVoiceId: 'vi-VN-HoaiMyNeural'
    });
    await server.close();
  });

  it('reports WAV audio with the matching content type', async () => {
    const synthesize = vi.fn(async () => ({ audio: Buffer.from('wav-bytes'), format: 'wav' as const }));
    const gateway = createKrillinTtsGateway({ synthesize });
    const server = Fastify();
    await gateway.register(server);
    const config = gateway.config('http://127.0.0.1:1234', 'Hải Đăng');

    const response = await server.inject({
      method: 'POST',
      url: '/internal/krillin-tts/v1/audio/speech',
      headers: { authorization: `Bearer ${config.apiKey}` },
      payload: { input: 'Xin chào', voice: 'Hải Đăng' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('audio/wav');
    expect(synthesize).toHaveBeenCalledWith({ text: 'Xin chào', voice: 'Hải Đăng', speed: undefined });
    await server.close();
  });

  it('rejects unauthorized callers and empty input', async () => {
    const synthesize = vi.fn(async () => ({ audio: Buffer.from('mp3-bytes'), format: 'mp3' as const }));
    const gateway = createKrillinTtsGateway({ synthesize });
    const server = Fastify();
    await gateway.register(server);

    const unauthorized = await server.inject({
      method: 'POST',
      url: '/internal/krillin-tts/v1/audio/speech',
      payload: { input: 'Xin chào' }
    });
    expect(unauthorized.statusCode).toBe(401);

    const config = gateway.config('http://127.0.0.1:1234', 'vi-VN-HoaiMyNeural');
    const empty = await server.inject({
      method: 'POST',
      url: '/internal/krillin-tts/v1/audio/speech',
      headers: { authorization: `Bearer ${config.apiKey}` },
      payload: { input: '   ' }
    });
    expect(empty.statusCode).toBe(400);
    expect(synthesize).not.toHaveBeenCalled();
    await server.close();
  });

  it('falls back to the model suffix for the voice and reports synthesis failures', async () => {
    const synthesize = vi.fn(async () => {
      throw new Error('VieNeu sidecar lỗi');
    });
    const gateway = createKrillinTtsGateway({ synthesize });
    const server = Fastify();
    await gateway.register(server);
    const config = gateway.config('http://127.0.0.1:1234', 'vi-VN-HoaiMyNeural');

    const response = await server.inject({
      method: 'POST',
      url: '/internal/krillin-tts/v1/audio/speech',
      headers: { authorization: `Bearer ${config.apiKey}` },
      payload: { model: 'vieneu/Trúc Ly', input: 'Xin chào' }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'tts_synthesis_failed' } });
    expect(synthesize).toHaveBeenCalledWith({ text: 'Xin chào', voice: 'Trúc Ly', speed: undefined });
    await server.close();
  });
});

describe('Edge TTS engine helpers', () => {
  it('maps OpenAI speed factors to SSML prosody rates', () => {
    expect(rateOption(undefined)).toBeUndefined();
    expect(rateOption(1)).toBeUndefined();
    expect(rateOption(1.1)).toBe('+10%');
    expect(rateOption(0.8)).toBe('-20%');
    expect(rateOption(5)).toBe('+100%');
    expect(rateOption(0.01)).toBe('-50%');
    expect(rateOption(Number.NaN)).toBeUndefined();
  });

  it('omits prosody keys entirely so SSML never contains undefined', () => {
    expect(prosodyOptions(undefined)).toBeUndefined();
    expect(prosodyOptions(1)).toBeUndefined();
    expect(prosodyOptions(1.1)).toEqual({ rate: '+10%' });
  });

  it('probes the engine and reports unreachable services as unusable', async () => {
    const ok: EdgeTtsEngine = {
      synthesize: vi.fn(async () => Buffer.from('audio')),
      close: vi.fn(async () => undefined)
    };
    await expect(createEdgeTtsProbe(ok)()).resolves.toBe(true);

    const failing: EdgeTtsEngine = {
      synthesize: vi.fn(async () => {
        throw new Error('edge down');
      }),
      close: vi.fn(async () => undefined)
    };
    await expect(createEdgeTtsProbe(failing)()).resolves.toBe(false);

    const silent: EdgeTtsEngine = {
      synthesize: vi.fn(async () => Buffer.alloc(0)),
      close: vi.fn(async () => undefined)
    };
    await expect(createEdgeTtsProbe(silent)()).resolves.toBe(false);
  });
});
