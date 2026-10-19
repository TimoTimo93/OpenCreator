import { describe, expect, it } from 'vitest';
import {
  resolveBackgroundMusicSettings,
  buildMixFilterGraph,
  buildReplaceDubbedAudioArgs,
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

  it('sinh filter graph FFmpeg giữ mức nhạc nền, không chia giảm âm lượng (normalize=0)', () => {
    const graph = buildMixFilterGraph(0.8);
    // Nhạc nền giữ mức bù retention trên luồng [0:a]…
    expect(graph).toContain('[0:a]volume=0.800[bgm]');
    // …giọng lồng được ép stereo trước khi trộn (TTS mono không làm mono cả bản dub)…
    expect(graph).toContain('[1:a]aformat=channel_layouts=stereo[voice]');
    // …amix không được chia đôi âm lượng hai luồng (normalize=0)…
    expect(graph).toContain('[voice][bgm]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mix]');
    // …và bản mix được chuẩn hoá loudness về -16 LUFS.
    expect(graph).toContain('[mix]loudnorm=I=-16:TP=-1.5:LRA=11[aout]');
    expect(buildMixFilterGraph(1)).toContain('volume=1.000');
    expect(buildMixFilterGraph(0)).toContain('volume=0.000');
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

describe('Creator BGM remux (ghi đè audio video dub)', () => {
  it('đệm im audio (apad) và cắt đúng thời lượng video đích (-t), không dùng -shortest', () => {
    const args = buildReplaceDubbedAudioArgs(112.298);
    expect(args).toContain('-map');
    expect(args).toContain('-c:v');
    expect(args).toContain('copy');
    // Audio luôn được đệm im để không hụt tiếng ở cuối…
    const apadIndex = args.indexOf('-af');
    expect(apadIndex).toBeGreaterThanOrEqual(0);
    expect(args[apadIndex + 1]).toBe('apad');
    // …bản xuất bị chặn đúng bằng thời lượng video đo được…
    const durationIndex = args.indexOf('-t');
    expect(durationIndex).toBeGreaterThanOrEqual(0);
    expect(args[durationIndex + 1]).toBe('112.298');
    // …và không còn -shortest cắt đuôi video khi audio dub ngắn hơn.
    expect(args).not.toContain('-shortest');
  });

  it('hạ về apad + -shortest khi không đo được thời lượng video', () => {
    const args = buildReplaceDubbedAudioArgs(undefined);
    const apadIndex = args.indexOf('-af');
    expect(args[apadIndex + 1]).toBe('apad');
    // apad đệm audio vô hạn nên -shortest luôn dừng ở cuối video, không cắt đuôi.
    expect(args).toContain('-shortest');
    expect(args).not.toContain('-t');
  });
});
