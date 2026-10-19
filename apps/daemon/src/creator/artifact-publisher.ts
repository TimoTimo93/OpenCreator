import type { CreatorJob, CreatorJson, ProjectResponse } from '@opencreator/protocol';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const publishableKinds = new Set([
  'source_subtitle',
  'target_subtitle',
  'bilingual_subtitle',
  'dubbed_audio',
  'horizontal_video',
  'vertical_video',
  'auto_clip_video',
  'clean_video',
  'bilingual_video',
  'cover_image',
  'generated_image',
  'generated_video',
  'publish_copy',
  'script_manifest',
  'clip_candidates'
]);

/**
 * Sản phẩm xuất được nhóm vào thư mục con theo loại trong mỗi project:
 * - `video/`: mọi file video thành phẩm (horizontal/vertical/clip...);
 * - `audio/`: file âm thanh lồng tiếng;
 * - `sub/`  : phụ đề (nguyên văn / dịch / song ngữ / dọc).
 * Loại khác (ảnh bìa, văn bản...) vẫn nằm ở gốc thư mục phiên bản.
 */
const outputCategoryByKind: Readonly<Record<string, 'video' | 'audio' | 'sub'>> = {
  horizontal_video: 'video',
  vertical_video: 'video',
  auto_clip_video: 'video',
  clean_video: 'video',
  bilingual_video: 'video',
  generated_video: 'video',
  dubbed_audio: 'audio',
  narration_audio: 'audio',
  source_subtitle: 'sub',
  target_subtitle: 'sub',
  bilingual_subtitle: 'sub',
  vertical_subtitle: 'sub'
};

export function creatorOutputSubdirectory(kind: string): 'video' | 'audio' | 'sub' | null {
  return outputCategoryByKind[kind] ?? null;
}

/** Tên thư mục Exports của project: `<Tên project>-<project id>` (đã sanitize). */
export function creatorProjectFolderName(project: { name: string; id: string }): string {
  return safeSegment(`${project.name}-${project.id}`);
}

export async function publishCreatorArtifacts(input: {
  job: CreatorJob;
  project: ProjectResponse;
  outputRoot: string;
}): Promise<string[]> {
  const published: string[] = [];
  // Tên "đẹp" theo tập (vd "Tập 01.mp4") — rút từ file nguồn người dùng tải lên.
  const titleStem = sourceTitleStem(input.job);
  const usedNames = new Set<string>();
  for (const artifact of input.job.artifacts) {
    if (
      artifact.path === null
      || artifact.status !== 'completed'
      || !publishableKinds.has(artifact.kind)
    ) continue;

    const version = positiveInteger(artifact.metadata?.resultVersion) ?? artifact.version;
    const category = creatorOutputSubdirectory(artifact.kind);
    const directory = resolve(
      input.outputRoot,
      creatorProjectFolderName(input.project),
      safeSegment(`${input.job.templateId}-${input.job.id}`),
      `V${version}`,
      ...(category === null ? [] : [category])
    );
    await mkdir(directory, { recursive: true });
    const sourceName = typeof artifact.metadata?.fileName === 'string'
      ? artifact.metadata.fileName
      : basename(artifact.path);
    const extension = extname(sourceName) || extname(artifact.path);
    // Ưu tiên tên theo tập người dùng đặt ("Tập 01.mp4"); trùng tên trong cùng
    // phiên bản → lùi lại tên loại-an toàn "kind-version.ext" để không ghi đè.
    let publishedName = titleName(artifact.kind, titleStem, extension);
    if (publishedName === null || usedNames.has(publishedName.toLowerCase())) {
      publishedName = `${safeSegment(`${artifact.kind}-${artifact.version}`)}${extension}`;
    }
    usedNames.add(publishedName.toLowerCase());
    const destination = join(directory, publishedName);
    const temporary = `${destination}.tmp-${process.pid}`;
    try {
      await copyFile(artifact.path, temporary);
      await rename(temporary, destination);
      published.push(destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return published;
}

/**
 * Tên file xuất theo loại, rút từ tên video gốc/tên tập ("Tập 01" →
 * "Tập 01.mp4", "Tập 01.source.srt"...). Chỉ áp dụng cho các loại chính của
 * dịch video; loại khác trả null để giữ cách đặt tên cũ.
 */
function titleName(kind: string, stem: string | null, extension: string): string | null {
  if (stem === null) return null;
  switch (kind) {
    case 'horizontal_video':
    case 'bilingual_video':
    case 'dubbed_audio':
    case 'target_subtitle':
    case 'vertical_subtitle':
      return `${stem}${extension}`;
    case 'source_subtitle':
      return `${stem}.source${extension}`;
    case 'bilingual_subtitle':
      return `${stem}.bilingual${extension}`;
    default:
      return null;
  }
}

/** Tên video gốc ("Tập 01.mp4" → "Tập 01") từ artifact nguồn hoặc state job. */
function sourceTitleStem(job: CreatorJob): string | null {
  const source = [...job.artifacts].reverse().find(artifact =>
    artifact.kind === 'source_video' && artifact.status === 'completed');
  const state = job.state as Record<string, CreatorJson> | undefined;
  const rawCandidates = [
    source?.metadata?.fileName,
    state?.sourceFileName
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  for (const candidate of rawCandidates) {
    const stem = candidate.replaceAll('\\', '/').split('/').pop()?.replace(/\.[^.]+$/, '')?.trim();
    if (stem !== undefined && stem !== '') {
      const safe = safeSegment(stem);
      if (safe !== 'untitled') return safe;
    }
  }
  return null;
}

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-');
  return normalized.length > 0 ? normalized.slice(0, 120) : 'untitled';
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}
