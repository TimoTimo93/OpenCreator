import { describe, expect, it, vi } from 'vitest';
import { createLocalTtsSynthesizer } from '../../src/creator/krillin/local-tts.js';

function fakeVieNeu(result?: { audio: Buffer; format: 'mp3' | 'wav' }) {
  const synthesize = vi.fn(async () => result ?? { audio: Buffer.from('vieneu'), format: 'mp3' as const });
  return { synthesize, isAvailable: async () => true, close: async () => {} };
}

function fakeEdge(result = Buffer.from('edge')) {
  const synthesize = vi.fn(async () => result);
  return { synthesize, close: async () => {} };
}

describe('krillin local TTS synthesizer', () => {
  it('prefers VieNeu for Vietnamese text with a preset voice', async () => {
    const vieNeu = fakeVieNeu({ audio: Buffer.from('vieneu-audio'), format: 'mp3' });
    const edge = fakeEdge();
    const local = createLocalTtsSynthesizer({ vieNeu, edge });

    const result = await local.synthesize({ text: 'Xin chào các bạn', voice: 'Hải Đăng' });

    expect(vieNeu.synthesize).toHaveBeenCalledTimes(1);
    expect(edge.synthesize).not.toHaveBeenCalled();
    expect(result.format).toBe('mp3');
    expect(result.audio.toString()).toBe('vieneu-audio');
  });

  it('falls back to the Vietnamese Edge voice when VieNeu fails', async () => {
    const vieNeu = { synthesize: vi.fn(async () => { throw new Error('boom'); }), isAvailable: async () => true, close: async () => {} };
    const edge = fakeEdge(Buffer.from('edge-audio'));
    const local = createLocalTtsSynthesizer({ vieNeu, edge });

    const result = await local.synthesize({ text: 'Xin chào các bạn', voice: 'Hải Đăng' });

    expect(vieNeu.synthesize).toHaveBeenCalledTimes(1);
    expect(edge.synthesize).toHaveBeenCalledWith({
      text: 'Xin chào các bạn',
      voice: 'vi-VN-HoaiMyNeural',
      speed: undefined
    });
    expect(result.audio.toString()).toBe('edge-audio');
  });

  it('skips VieNeu for Chinese-only text and uses a Chinese Edge voice', async () => {
    const vieNeu = fakeVieNeu();
    const edge = fakeEdge();
    const local = createLocalTtsSynthesizer({ vieNeu, edge });

    await local.synthesize({ text: '前面美女走哪条路？', voice: 'Hải Đăng' });

    // VieNeu là TTS tiếng Việt: chữ Hán thuần không dùng được, đi thẳng sang Edge.
    expect(vieNeu.synthesize).not.toHaveBeenCalled();
    expect(edge.synthesize).toHaveBeenCalledWith({
      text: '前面美女走哪条路？',
      voice: 'zh-CN-XiaoxiaoNeural',
      speed: undefined
    });
  });

  it('still tries VieNeu for mixed Vietnamese and Chinese text', async () => {
    const vieNeu = fakeVieNeu();
    const edge = fakeEdge();
    const local = createLocalTtsSynthesizer({ vieNeu, edge });

    await local.synthesize({ text: 'Nhưng ta không chịu chết 今天我教你怎么死。', voice: 'Hải Đăng' });

    expect(vieNeu.synthesize).toHaveBeenCalledTimes(1);
    expect(edge.synthesize).not.toHaveBeenCalled();
  });

  it('honours an explicit Edge voice instead of VieNeu', async () => {
    const vieNeu = fakeVieNeu();
    const edge = fakeEdge();
    const local = createLocalTtsSynthesizer({ vieNeu, edge });

    await local.synthesize({ text: 'Xin chào', voice: 'vi-VN-HoaiMyNeural' });

    expect(vieNeu.synthesize).not.toHaveBeenCalled();
    expect(edge.synthesize).toHaveBeenCalledWith({
      text: 'Xin chào',
      voice: 'vi-VN-HoaiMyNeural',
      speed: undefined
    });
  });
});
