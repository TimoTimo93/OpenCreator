import { describe, expect, it } from 'vitest';
import {
  resolveBackgroundMusicSettings,
  buildMixFilterGraph,
  resolveSeparationRuntimeRoot,
  BGM_SEPARATION_MODEL
} from '../../src/creator/audio/bgm-separation.js';

describe('Creator BGM (giữ nhạc nền khi lồng tiếng) settings', () => {
  it('mặc định bật với mức giữ 80%', () => {
    expect(resolveBackgroundMusicSettings(undefined)).toEqual({ enabled: true, retention: 0.8 });
    expect(resolveBackgroundMusicSettings({})).toEqual({ enabled: true, retention: 0.8 });
  });

  it('nhận tùy chọn bật/tắt và mức giữ từ trạng thái job', () => {
    expect(resolveBackgroundMusicSettings({ keepBackgroundAudio: false, bgmRetention: 0.9 }))
      .toEqual({ enabled: false, retention: 0 });
    expect(resolveBackgroundMusicSettings({ keepBackgroundAudio: true, bgmRetention: 0.5 }))
      .toEqual({ enabled: true, retention: 0.5 });
    expect(resolveBackgroundMusicSettings({ keepBackgroundAudio: 'false', bgmRetention: 1 }))
      .toEqual({ enabled: false, retention: 0 });
  });

  it('chặn giá trị mức giữ ngoài khoảng 0..1 và coi mức 0 là tắt', () => {
    expect(resolveBackgroundMusicSettings({ bgmRetention: 2 }))
      .toEqual({ enabled: true, retention: 1 });
    expect(resolveBackgroundMusicSettings({ bgmRetention: -5 }))
      .toEqual({ enabled: false, retention: 0 });
    expect(resolveBackgroundMusicSettings({ bgmRetention: Number.NaN }))
      .toEqual({ enabled: true, retention: 0.8 });
    expect(resolveBackgroundMusicSettings({ keepBackgroundAudio: true, bgmRetention: 0.0005 }))
      .toEqual({ enabled: false, retention: 0 });
  });

  it('sinh filter graph FFmpeg với mức giữ đúng', () => {
    expect(buildMixFilterGraph(0.8)).toBe(
      '[0:a]volume=0.800[bgm];[1:a][bgm]amix=inputs=2:duration=longest:dropout_transition=0[aout]'
    );
    expect(buildMixFilterGraph(1)).toContain('volume=1.000');
  });

  it('chọn thư mục runtime tách giọng theo biến môi trường', () => {
    const previous = process.env.OPENCREATOR_RUNTIME_DIR;
    try {
      process.env.OPENCREATOR_RUNTIME_DIR = 'D:/tmp/opencreator-runtime';
      expect(resolveSeparationRuntimeRoot()).toBe('D:\\tmp\\opencreator-runtime\\audio-separation');
      process.env.OPENCREATOR_RUNTIME_DIR = '';
      process.env.OPENCREATOR_DATA_DIR = 'D:/tmp/opencreator-data';
      expect(resolveSeparationRuntimeRoot()).toBe('D:\\tmp\\runtime\\audio-separation');
    } finally {
      if (previous === undefined) delete process.env.OPENCREATOR_RUNTIME_DIR;
      else process.env.OPENCREATOR_RUNTIME_DIR = previous;
      delete process.env.OPENCREATOR_DATA_DIR;
    }
  });

  it('model tách giọng được pin đúng thông số nguồn tải về', () => {
    expect(BGM_SEPARATION_MODEL.fileName).toBe('UVR-MDX-NET-Inst_HQ_3.onnx');
    expect(BGM_SEPARATION_MODEL.sha256)
      .toBe('317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc');
    expect(BGM_SEPARATION_MODEL.url).toContain('/notabilia/uvr5-models/resolve/main/');
    expect(BGM_SEPARATION_MODEL.bytes).toBeGreaterThan(60_000_000);
  });
});
