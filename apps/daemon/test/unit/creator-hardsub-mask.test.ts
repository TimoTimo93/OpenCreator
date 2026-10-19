import { describe, expect, it } from 'vitest';
import { buildKrillinStageOptions } from '../../src/creator/krillin/adapter.js';
import {
  DEFAULT_HARDSUB_BAND,
  HARDSUB_BAND_PERCENT_MAX,
  HARDSUB_BAND_PERCENT_MIN,
  analyzeHardsubFrames,
  buildHardsubMaskFilterChain,
  buildHardsubPreprocessArgs,
  clampHardsubBand,
  detectHardsubBand,
  hardsubBandPixels,
  parseHardsubBandPercent,
  parseHardsubHandling
} from '../../src/creator/translation-pipeline/hardsub-mask.js';

const WIDTH = 1920;
const HEIGHT = 1080;

describe('hardsub mask mode parsing', () => {
  it('accepts the four supported modes', () => {
    for (const mode of ['none', 'blur', 'cover', 'crop'] as const) {
      expect(parseHardsubHandling(mode)).toBe(mode);
    }
  });

  it('falls back to none for unknown, missing, or non-string values (backward compatible with old jobs)', () => {
    expect(parseHardsubHandling(undefined)).toBe('none');
    expect(parseHardsubHandling(null)).toBe('none');
    expect(parseHardsubHandling('')).toBe('none');
    expect(parseHardsubHandling('MASK')).toBe('none');
    expect(parseHardsubHandling(3)).toBe('none');
  });

  it('parses the manual band percent and clamps it into the supported range', () => {
    expect(parseHardsubBandPercent(22)).toBe(22);
    expect(parseHardsubBandPercent(22.4)).toBe(22);
    expect(parseHardsubBandPercent(1)).toBe(HARDSUB_BAND_PERCENT_MIN);
    expect(parseHardsubBandPercent(999)).toBe(HARDSUB_BAND_PERCENT_MAX);
  });

  it('returns null (auto detection) for missing or invalid band values', () => {
    expect(parseHardsubBandPercent(undefined)).toBeNull();
    expect(parseHardsubBandPercent(null)).toBeNull();
    expect(parseHardsubBandPercent('30')).toBeNull();
    expect(parseHardsubBandPercent(Number.NaN)).toBeNull();
  });
});

describe('hardsub band geometry', () => {
  it('keeps the default band inside 78%–96% of the frame height measured from the top', () => {
    expect(DEFAULT_HARDSUB_BAND).toEqual({ bottomPercent: 4, topPercent: 22 });
    const band = hardsubBandPixels(DEFAULT_HARDSUB_BAND, HEIGHT);
    expect(band.top).toBe(842);
    expect(band.height).toBe(1036 - 842);
  });

  it('rounds band edges to even pixels for odd-sized frames', () => {
    const band = hardsubBandPixels(DEFAULT_HARDSUB_BAND, 1081);
    expect(band.top % 2).toBe(0);
    expect(band.height % 2).toBe(0);
    expect(band.top).toBe(842);
    expect(band.height).toBe(1036 - 842);
  });

  it('clamps inverted or out-of-range bands so the top edge stays above the bottom edge', () => {
    expect(clampHardsubBand({ bottomPercent: 30, topPercent: 10 })).toEqual({ bottomPercent: 4, topPercent: 10 });
    expect(clampHardsubBand({ bottomPercent: -5, topPercent: 400 })).toEqual({ bottomPercent: 0, topPercent: HARDSUB_BAND_PERCENT_MAX });
  });
});

describe('hardsub ffmpeg filter chain builder', () => {
  it('builds a solid semi-transparent cover band for the cover mode', () => {
    const chain = buildHardsubMaskFilterChain({
      mode: 'cover',
      band: DEFAULT_HARDSUB_BAND,
      width: WIDTH,
      height: HEIGHT
    });
    const band = hardsubBandPixels(DEFAULT_HARDSUB_BAND, HEIGHT);
    expect(chain).toBe(
      `drawbox=x=0:y=${band.top}:w=iw:h=${band.height}:color=black@0.85:t=fill,format=yuv420p`
    );
  });

  it('builds a crop + blur + darken overlay chain limited to the hardsub band for the blur mode', () => {
    const chain = buildHardsubMaskFilterChain({
      mode: 'blur',
      band: DEFAULT_HARDSUB_BAND,
      width: WIDTH,
      height: HEIGHT
    });
    const band = hardsubBandPixels(DEFAULT_HARDSUB_BAND, HEIGHT);
    // Bán kính boxblur bị giới hạn theo cạnh ngắn của dải (194/8 = 24).
    expect(chain).toBe(
      'split[hsbase][hsband];'
      + `[hsband]crop=iw:${band.height}:0:${band.top},`
      + 'boxblur=luma_radius=24:luma_power=2:chroma_radius=24:chroma_power=2:alpha_radius=24:alpha_power=2[hsbandblurred];'
      + `[hsbase][hsbandblurred]overlay=0:${band.top},`
      + `drawbox=x=0:y=${band.top}:w=iw:h=${band.height}:color=black@0.25:t=fill,format=yuv420p`
    );
  });

  it('keeps the boxblur radius valid for small bands and small videos', () => {
    const chain = buildHardsubMaskFilterChain({
      mode: 'blur',
      band: DEFAULT_HARDSUB_BAND,
      width: 640,
      height: 360
    });
    // min(640, 64) / 8 = 8
    expect(chain).toContain('boxblur=luma_radius=8:');
  });

  it('crops off the bottom band and scales back to the full frame for the crop mode', () => {
    const chain = buildHardsubMaskFilterChain({
      mode: 'crop',
      band: DEFAULT_HARDSUB_BAND,
      width: WIDTH,
      height: HEIGHT
    });
    const keepHeight = hardsubBandPixels(DEFAULT_HARDSUB_BAND, HEIGHT).top;
    expect(chain).toBe(`crop=iw:${keepHeight}:0:0,scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`);
  });

  it('uses the manual band percent for the filter chain', () => {
    const band = { bottomPercent: DEFAULT_HARDSUB_BAND.bottomPercent, topPercent: 40 };
    const chain = buildHardsubMaskFilterChain({ mode: 'cover', band, width: WIDTH, height: HEIGHT });
    const pixels = hardsubBandPixels(band, HEIGHT);
    expect(chain).toContain(`y=${pixels.top}`);
    expect(pixels.top).toBe(Math.round(HEIGHT * 0.6));
  });
});

describe('hardsub pre-process ffmpeg args', () => {
  it('re-encodes the processed video once with the shared reference encoding and copies audio', () => {
    const args = buildHardsubPreprocessArgs({
      mode: 'cover',
      band: DEFAULT_HARDSUB_BAND,
      width: WIDTH,
      height: HEIGHT,
      sourcePath: 'source.mp4',
      outputPath: 'source_hardsub_processed.mp4'
    });
    expect(args[0]).toBe('-y');
    expect(args).toEqual([
      '-y',
      '-i', 'source.mp4',
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', buildHardsubMaskFilterChain({
        mode: 'cover',
        band: DEFAULT_HARDSUB_BAND,
        width: WIDTH,
        height: HEIGHT
      }),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      'source_hardsub_processed.mp4'
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dò dải hardsub từ khung mẫu
// ---------------------------------------------------------------------------

const ANALYSIS_WIDTH = 320;
const ANALYSIS_HEIGHT = 180;

/** Vẽ khung mẫu: nền xám phẳng + "chữ" sáng viền đen trong dải [fromRow, toRow]. */
function frameWithTextBand(rows: Array<[number, number]>, frameCount = 6): Buffer {
  const pixels = Buffer.alloc(ANALYSIS_WIDTH * ANALYSIS_HEIGHT * frameCount, 120);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * ANALYSIS_WIDTH * ANALYSIS_HEIGHT;
    for (const [fromRow, toRow] of rows) {
      for (let y = fromRow; y <= toRow; y += 1) {
        for (let x = 0; x < ANALYSIS_WIDTH; x += 1) {
          pixels[offset + y * ANALYSIS_WIDTH + x] = x % 2 === 0 ? 230 : 20;
        }
      }
    }
  }
  return pixels;
}

describe('analyzeHardsubFrames', () => {
  it('detects a burned-in subtitle band near the bottom and returns percentages from the bottom edge', () => {
    // Hardsub giả ở hàng 142–172 (~96%–78% chiều cao tính từ mép trên).
    const band = analyzeHardsubFrames(
      frameWithTextBand([[142, 172]]),
      ANALYSIS_WIDTH,
      ANALYSIS_HEIGHT,
      6
    );
    expect(band).toBeDefined();
    expect(band!.topPercent).toBeGreaterThan(18);
    expect(band!.topPercent).toBeLessThan(28);
    expect(band!.bottomPercent).toBeLessThan(8);
    expect(band!.bottomPercent).toBeLessThan(band!.topPercent);
  });

  it('returns undefined for a flat background without any text band (falls back to the default band)', () => {
    const band = analyzeHardsubFrames(
      frameWithTextBand([]),
      ANALYSIS_WIDTH,
      ANALYSIS_HEIGHT,
      6
    );
    expect(band).toBeUndefined();
  });

  it('ignores text appearing in too few frames (noise vote must not win)', () => {
    const pixels = frameWithTextBand([[142, 172]]);
    // Xóa chữ ở 4/6 khung → chỉ 2 khung còn chữ, thiếu phiếu đa số (3).
    const frameSize = ANALYSIS_WIDTH * ANALYSIS_HEIGHT;
    for (let frame = 2; frame < 6; frame += 1) {
      pixels.fill(120, frame * frameSize, (frame + 1) * frameSize);
    }
    const band = analyzeHardsubFrames(pixels, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, 6);
    expect(band).toBeUndefined();
  });

  it('returns undefined when the buffer does not contain a full frame', () => {
    expect(analyzeHardsubFrames(Buffer.alloc(10), ANALYSIS_WIDTH, ANALYSIS_HEIGHT, 6)).toBeUndefined();
  });
});

describe('detectHardsubBand', () => {
  it('analyzes the raw gray frames produced by ffmpeg and reports a detection', async () => {
    let capturedArgs: string[] | undefined;
    const result = await detectHardsubBand({
      ffmpegPath: 'ffmpeg',
      videoPath: 'source.mp4',
      runFfmpeg: async args => {
        capturedArgs = args;
        return frameWithTextBand([[142, 172]]);
      }
    });
    expect(result.detected).toBe(true);
    expect(result.band.topPercent).toBeGreaterThan(18);
    expect(result.band.topPercent).toBeLessThan(28);
    // Phân tích 5 phút đầu, 1 khung/10s, tối đa 6 khung grayscale.
    expect(capturedArgs).toContain('-t');
    expect(capturedArgs?.join(' ')).toContain('-f rawvideo');
  });

  it('never fails the stage: ffmpeg errors fall back to the default band', async () => {
    const result = await detectHardsubBand({
      ffmpegPath: 'ffmpeg',
      videoPath: 'source.mp4',
      runFfmpeg: async () => {
        throw new Error('ffmpeg crashed');
      }
    });
    expect(result.detected).toBe(false);
    expect(result.band).toEqual(DEFAULT_HARDSUB_BAND);
  });
});

describe('hardsub options pass through the krillin stage options', () => {
  it('forwards validated hardsub fields from the job state', () => {
    const options = buildKrillinStageOptions({
      job: { templateId: 'video-translation', state: { hardsubHandling: 'cover', hardsubBandPercent: 30 } },
      stageRun: { stageId: 'render-horizontal' }
    } as never);
    expect(options.hardsubHandling).toBe('cover');
    expect(options.hardsubBandPercent).toBe(30);
  });

  it('defaults old jobs without the fields to none + auto detection', () => {
    const options = buildKrillinStageOptions({
      job: { templateId: 'video-translation', state: { hardsubHandling: 'weird', hardsubBandPercent: 'x' } },
      stageRun: { stageId: 'render-horizontal' }
    } as never);
    expect(options.hardsubHandling).toBe('none');
    expect(options.hardsubBandPercent).toBeNull();
  });
});
