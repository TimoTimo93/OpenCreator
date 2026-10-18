import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Chênh lệch thời lượng cho phép giữa video ghép với tổng phân đoạn. */
export const MERGE_DURATION_TOLERANCE_RATIO = 0.02;

export type SegmentSpec = {
  path: string;
  episodeIndex: number | null;
  positionHint: number;
};

/**
 * Ghép các phân đoạn dịch xong thành một video dài:
 *
 * 1. ffprobe từng phân đoạn: chuẩn codec video (codec_name, width, height,
 *    pix_fmt, fps) + chuẩn audio;
 * 2. nếu mọi phân đoạn cùng chuẩn → nối bằng concat demuxer `-c copy` (nhanh,
 *    không re-encode); phân đoạn nào lệch chuẩn → chỉ re-encode đúng các phân
 *    đoạn lệch về chuẩn của phân đoạn tham chiếu rồi mới nối copy;
 * 3. kiểm tra thời lượng: video ghép ≈ tổng phân đoạn (±2%) — phát hiện ghép
 *    lệch / lộn xộn trước khi trả kết quả.
 */

export type MergeReport = {
  outputPath: string;
  durationSeconds: number;
  segmentDurations: number[];
  reencodedPositions: number[];
};

export type StreamSpec = {
  durationSeconds: number;
  video: {
    codec: string;
    width: number;
    height: number;
    pixFmt: string;
    frameRate: number;
  } | null;
  audio: {
    codec: string;
    sampleRate: number;
    channels: number;
  } | null;
};

export const REFERENCE_VIDEO_ENCODING = {
  codec: 'libx264',
  pixFmt: 'yuv420p',
  preset: 'veryfast',
  crf: 20
} as const;

export const REFERENCE_AUDIO_ENCODING = {
  codec: 'aac',
  sampleRate: 48_000,
  bitrate: '256k'
} as const;

export async function mergeVideoSegments(input: {
  ffmpegPath: string;
  ffprobePath: string;
  segments: readonly SegmentSpec[];
  outputPath: string;
}): Promise<MergeReport> {
  if (input.segments.length < 2) {
    throw new Error('Cần ít nhất 2 phân đoạn để ghép video');
  }
  const workDir = await mkdtemp(join(tmpdir(), 'opencreator-merge-'));
  try {
    const specs: Array<SegmentSpec & { spec: StreamSpec; normalizedPath: string }> = [];
    const reencodedPositions: number[] = [];
    const segmentDurations: number[] = [];
    for (let index = 0; index < input.segments.length; index += 1) {
      const segment = input.segments[index]!;
      const spec = await probeStreamSpec(input.ffprobePath, segment.path);
      segmentDurations.push(spec.durationSeconds);
      const reference = specs[0]?.spec;
      if (reference === undefined || sameSpec(reference, spec)) {
        specs.push({ ...segment, spec, normalizedPath: segment.path });
        continue;
      }
      // Lệch chuẩn: re-encode đúng phân đoạn này về chuẩn tham chiếu.
      const normalizedPath = join(workDir, `segment-${index + 1}.mp4`);
      await reencodeSegment({
        ffmpegPath: input.ffmpegPath,
        sourcePath: segment.path,
        outputPath: normalizedPath,
        reference
      });
      reencodedPositions.push(index + 1);
      specs.push({ ...segment, spec, normalizedPath });
    }
    const listPath = join(workDir, 'concat.txt');
    await writeFile(
      listPath,
      specs
        .map(segment => `file '${escapeForConcat(resolve(segment.normalizedPath))}'`)
        .join('\n'),
      'utf8'
    );
    await runCommand(input.ffmpegPath, [
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      input.outputPath
    ]);
    const outputSpec = await probeStreamSpec(input.ffprobePath, input.outputPath);
    const total = segmentDurations.reduce((sum, value) => sum + value, 0);
    const drift = Math.abs(outputSpec.durationSeconds - total);
    if (drift > Math.max(3, total * MERGE_DURATION_TOLERANCE_RATIO)) {
      throw new Error(
        `Kiểm tra ghép thất bại: tổng phân đoạn ${total.toFixed(1)}s nhưng video ghép ${outputSpec.durationSeconds.toFixed(1)}s (lệch ${drift.toFixed(1)}s)`
      );
    }
    return {
      outputPath: input.outputPath,
      durationSeconds: outputSpec.durationSeconds,
      segmentDurations,
      reencodedPositions
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function probeStreamSpec(ffprobe: string, path: string): Promise<StreamSpec> {
  const payload = JSON.parse(await runCommandText(ffprobe, [
    '-v', 'error',
    '-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels',
    '-of', 'json',
    path
  ])) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      pix_fmt?: string;
      r_frame_rate?: string;
      sample_rate?: string;
      channels?: number;
    }>;
  };
  const duration = Number(payload.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Không đọc được thời lượng của phân đoạn: ${path}`);
  }
  const videoStream = payload.streams?.find(stream =>
    stream.codec_type === 'video' && stream.codec_name !== undefined);
  const audioStream = payload.streams?.find(stream => stream.codec_type === 'audio');
  return {
    durationSeconds: duration,
    video: videoStream === undefined ? null : {
      codec: videoStream.codec_name ?? '',
      width: videoStream.width ?? 0,
      height: videoStream.height ?? 0,
      pixFmt: videoStream.pix_fmt ?? '',
      frameRate: parseFrameRate(videoStream.r_frame_rate ?? '0/1')
    },
    audio: audioStream === undefined ? null : {
      codec: audioStream.codec_name ?? '',
      sampleRate: Number(audioStream.sample_rate ?? 0),
      channels: audioStream.channels ?? 0
    }
  };
}

/** Re-encode đúng phân đoạn lệch chuẩn về chuẩn của phân đoạn tham chiếu. */
async function reencodeSegment(input: {
  ffmpegPath: string;
  sourcePath: string;
  outputPath: string;
  reference: StreamSpec;
}): Promise<void> {
  const video = input.reference.video;
  const args: string[] = ['-y', '-i', input.sourcePath];
  if (video !== null) {
    const width = Math.max(2, Math.floor(video.width / 2) * 2);
    const height = Math.max(2, Math.floor(video.height / 2) * 2);
    args.push(
      '-vf', `scale=${width}:${height}:flags=lanczos,format=${REFERENCE_VIDEO_ENCODING.pixFmt}`,
      '-r', String(video.frameRate),
      '-c:v', REFERENCE_VIDEO_ENCODING.codec,
      '-preset', REFERENCE_VIDEO_ENCODING.preset,
      '-crf', String(REFERENCE_VIDEO_ENCODING.crf)
    );
  } else {
    args.push('-vn');
  }
  args.push(...audioArgs(input.reference), input.outputPath);
  await runCommand(input.ffmpegPath, args);
}

function audioArgs(reference: StreamSpec): string[] {
  if (reference.audio === null) return ['-an'];
  return [
    '-c:a', REFERENCE_AUDIO_ENCODING.codec,
    '-ar', String(reference.audio.sampleRate || REFERENCE_AUDIO_ENCODING.sampleRate),
    '-b:a', REFERENCE_AUDIO_ENCODING.bitrate,
    ...(reference.audio.channels === 1 ? ['-ac', '1'] : ['-ac', '2'])
  ];
}

function parseFrameRate(value: string): number {
  const parts = value.split('/');
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1]);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
    return Math.round((numerator / denominator) * 1000) / 1000;
  }
  return 30;
}

function sameSpec(left: StreamSpec, right: StreamSpec): boolean {
  if (left.video === null || right.video === null) {
    if (left.video !== right.video) return false;
  } else if (
    left.video.codec !== right.video.codec
    || left.video.width !== right.video.width
    || left.video.height !== right.video.height
    || left.video.pixFmt !== right.video.pixFmt
    || Math.abs(left.video.frameRate - right.video.frameRate) > 0.01
  ) {
    return false;
  }
  if (left.audio === null || right.audio === null) {
    if (left.audio !== right.audio) return false;
  } else if (
    left.audio.codec !== right.audio.codec
    || left.audio.sampleRate !== right.audio.sampleRate
    || (left.audio.channels ?? 2) !== (right.audio.channels ?? 2)
  ) {
    return false;
  }
  return true;
}

const escapeForConcat = (value: string): string => value.replace(/'/g, "\\'");

function runCommand(command: string, args: string[]): Promise<string> {
  return runCommandText(command, args);
}

function runCommandText(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30 * 60_000
    }, (error, stdout) => {
      if (error) {
        const stderr = (error as { stderr?: string }).stderr;
        rejectPromise(new Error(stderr?.slice(-400) ?? String(error)));
        return;
      }
      resolvePromise(stdout);
    });
  });
}
