import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreatorJob, ProjectResponse } from '@opencreator/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { publishCreatorArtifacts } from '../../src/creator/artifact-publisher.js';

let root = '';

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('creator artifact publisher', () => {
  it('copies completed deliverables by project, job and result version', async () => {
    root = await mkdtemp(join(tmpdir(), 'opencreator-publisher-'));
    const sourceDir = join(root, 'internal');
    await mkdir(sourceDir);
    const source = join(sourceDir, 'video.mp4');
    await writeFile(source, 'video');
    const job = {
      id: 'job/1',
      projectId: 'project_1',
      templateId: 'video-translation',
      artifacts: [{
        id: 'artifact_1',
        jobId: 'job/1',
        kind: 'horizontal_video',
        version: 2,
        status: 'completed',
        path: source,
        scopeKey: null,
        inputFingerprint: null,
        sha256: null,
        sourceArtifactIds: [],
        metadata: { resultVersion: 3, fileName: 'final.mp4' },
        createdAt: new Date().toISOString()
      }]
    } as unknown as CreatorJob;
    const project = { id: 'project_1', name: 'Demo' } as ProjectResponse;

    const published = await publishCreatorArtifacts({
      job,
      project,
      outputRoot: join(root, 'exports')
    });

    expect(published).toHaveLength(1);
    // Video thành phẩm nằm trong thư mục con "video/" theo loại sản phẩm.
    expect(published[0]).toContain(join('Demo-project_1', 'video-translation-job-1', 'V3', 'video'));
    // Không có tên video gốc trong job → giữ cách đặt tên kind-version cũ.
    expect(published[0]).toMatch(/horizontal_video-2\.mp4$/);
    expect(await readFile(published[0]!, 'utf8')).toBe('video');
    expect(await readFile(source, 'utf8')).toBe('video');
  });

  it('names published files after the source episode title when available', async () => {
    root = await mkdtemp(join(tmpdir(), 'opencreator-publisher-'));
    const sourceDir = join(root, 'internal');
    await mkdir(sourceDir);
    const video = join(sourceDir, 'render.mp4');
    await writeFile(video, 'video');
    const job = {
      id: 'job_2',
      projectId: 'project_1',
      templateId: 'video-translation',
      artifacts: [
        {
          id: 'artifact_source',
          kind: 'source_video',
          version: 1,
          status: 'completed',
          path: join(sourceDir, 'Tap 01.mp4'),
          sourceArtifactIds: [],
          metadata: { fileName: 'Tập 01.mp4' }
        },
        {
          id: 'artifact_video',
          kind: 'horizontal_video',
          version: 1,
          status: 'completed',
          path: video,
          sourceArtifactIds: [],
          metadata: { resultVersion: 1 }
        }
      ]
    } as unknown as CreatorJob;

    const published = await publishCreatorArtifacts({
      job,
      project: { id: 'project_1', name: 'Bộ Phim' } as ProjectResponse,
      outputRoot: join(root, 'exports')
    });

    expect(published).toHaveLength(1);
    // Tên file video xuất = tên video gốc / tên tập ("Tập 01.mp4"), giữ unicode.
    expect(published[0]).toMatch(/Tập 01\.mp4$/);
  });

  it('does not publish source or stale artifacts', async () => {
    root = await mkdtemp(join(tmpdir(), 'opencreator-publisher-'));
    const job = {
      id: 'job_1',
      projectId: 'project_1',
      templateId: 'image-generation',
      artifacts: [
        { kind: 'source_video', status: 'completed', path: '/missing/source.mp4' },
        { kind: 'generated_image', status: 'stale', path: '/missing/image.png' }
      ]
    } as unknown as CreatorJob;

    await expect(publishCreatorArtifacts({
      job,
      project: { id: 'project_1', name: 'Demo' } as ProjectResponse,
      outputRoot: join(root, 'exports')
    })).resolves.toEqual([]);
  });

  it('publishes subtitles and dubbing into sub folders and keeps kind naming without a source title', async () => {
    root = await mkdtemp(join(tmpdir(), 'opencreator-publisher-'));
    const sourceDir = join(root, 'internal');
    await mkdir(sourceDir);
    const subtitle = join(sourceDir, 'sub.srt');
    await writeFile(subtitle, 'sub');
    const audio = join(sourceDir, 'audio.wav');
    await writeFile(audio, 'audio');
    const job = {
      id: 'job_1',
      projectId: 'project_1',
      templateId: 'video-translation',
      artifacts: [
        {
          id: 'artifact_sub',
          kind: 'bilingual_subtitle',
          version: 1,
          status: 'completed',
          path: subtitle,
          sourceArtifactIds: [],
          metadata: { resultVersion: 1 }
        },
        {
          id: 'artifact_audio',
          kind: 'dubbed_audio',
          version: 1,
          status: 'completed',
          path: audio,
          sourceArtifactIds: [],
          metadata: { resultVersion: 1 }
        }
      ]
    } as unknown as CreatorJob;

    const published = await publishCreatorArtifacts({
      job,
      project: { id: 'project_1', name: 'Bộ Phim' } as ProjectResponse,
      outputRoot: join(root, 'exports')
    });

    expect(published).toHaveLength(2);
    // Phụ đề vào "sub/", âm thanh vào "audio/".
    expect(published[0]).toContain(join('Bộ Phim-project_1', 'video-translation-job_1', 'V1', 'sub'));
    expect(published[0]).toMatch(/bilingual_subtitle-1\.srt$/);
    expect(published[1]).toContain(join('Bộ Phim-project_1', 'video-translation-job_1', 'V1', 'audio'));
    expect(published[1]).toMatch(/dubbed_audio-1\.wav$/);
  });
});
