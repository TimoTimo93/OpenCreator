import type { CreatorJob, CreatorStageRun } from '@opencreator/protocol';
import { createDefaultCreatorServicesConfig } from '@opencreator/protocol';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDownloadExecutor } from '../../src/creator/download/executor.js';
import type { CreatorExecutorInput } from '../../src/creator/executor.js';
import { classifyDouyinChallenge } from '../../src/creator/download/issue-catalog.js';

let tempDir = '';

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function fakeFailingBinaries(failureStderr: string) {
  tempDir = await mkdtemp(join(tmpdir(), 'creator-douyin-adv-'));
  const ytDlpScriptPath = join(tempDir, 'yt-dlp.mjs');
  const ffmpegScriptPath = join(tempDir, 'ffmpeg.mjs');
  const ffprobeScriptPath = join(tempDir, 'ffprobe.mjs');

  await writeExecutable(
    ytDlpScriptPath,
    `#!/usr/bin/env node
process.stderr.write(${JSON.stringify(failureStderr)} + '\\n');
process.exit(1);
`
  );

  await writeExecutable(ffmpegScriptPath, `#!/usr/bin/env node\nprocess.exit(0);\n`);
  await writeExecutable(ffprobeScriptPath, `#!/usr/bin/env node\nprocess.exit(0);\n`);

  const config = createDefaultCreatorServicesConfig();
  return {
    configStore: { read: async () => config },
    ytDlpPath: process.execPath,
    ytDlpPrefixArgs: [ytDlpScriptPath],
    ffmpegPath: process.execPath,
    ffmpegPrefixArgs: [ffmpegScriptPath],
    ffprobePath: process.execPath,
    ffprobePrefixArgs: [ffprobeScriptPath],
  };
}

function probeStage(sourceUrl: string, workdir: string): CreatorExecutorInput {
  const createdAt = '2026-10-15T00:00:00.000Z';
  const job: CreatorJob = {
    id: 'download_job',
    projectId: 'project_adv',
    templateId: 'video-download',
    templateVersion: 2,
    status: 'running',
    revision: 1,
    presetOrigin: null,
    state: { sourceUrl },
    agentThreadId: null,
    stages: [],
    artifacts: [],
    providerRequests: [],
    activities: [],
    createdAt,
    updatedAt: createdAt,
  };
  const stageRun: CreatorStageRun = {
    id: 'stage_probe',
    jobId: job.id,
    stageId: 'probe',
    executor: 'download',
    status: 'running',
    dispatchStatus: 'claimed',
    claimOwner: 'test',
    claimExpiresAt: null,
    attempt: 1,
    idempotencyKey: null,
    scopeKey: null,
    inputFingerprint: null,
    progress: {},
    errorCode: null,
    errorMessage: null,
    startedAt: createdAt,
    finishedAt: null,
  };
  return {
    stageRun,
    job,
    inputArtifacts: [],
    workdir,
    signal: new AbortController().signal,
    reportProgress: vi.fn(),
  };
}

describe('Adversarial Challenge: classifyDownloadError via DownloadExecutor', () => {
  it('classifies ArgusSecurityPlugin Validate Error on Douyin probe as platform_session_required', async () => {
    const stderr = 'ERROR: [douyin] HTTP Error 403: Forbidden\nBlocked by ArgusSecurityPlugin Validate Error';
    const binaries = await fakeFailingBinaries(stderr);
    const executor = createDownloadExecutor(binaries);

    await expect(
      executor.run(probeStage('https://www.douyin.com/video/7490000000000000001', tempDir))
    ).rejects.toMatchObject({
      code: 'platform_session_required',
      message: expect.stringContaining('website verification (anti-bot captcha)'),
      publicFacts: {
        kind: 'unauthorized',
        provider: 'yt-dlp',
        httpStatus: 403,
      },
    });
  });

  it('classifies ArgusSecurityPlugin Signature Not Found as platform_request_signature_required', async () => {
    const stderr = 'ERROR: [douyin] Douyin request signature is required (HTTP Error 403; Signature Not Found). Reconnecting cookies alone cannot fix it.';
    const binaries = await fakeFailingBinaries(stderr);
    const executor = createDownloadExecutor(binaries);

    await expect(
      executor.run(probeStage('https://www.douyin.com/video/7490000000000000001', tempDir))
    ).rejects.toMatchObject({
      code: 'platform_request_signature_required',
      message: expect.stringContaining('required browser request signature is not supported'),
      publicFacts: {
        kind: 'unsupported',
        provider: 'yt-dlp',
        httpStatus: 403,
      },
    });
  });

  it('classifies Douyin slider captcha challenge as platform_session_required', async () => {
    const stderr = 'ERROR: [douyin] Slider verification captcha triggered. Please complete captcha.';
    const binaries = await fakeFailingBinaries(stderr);
    const executor = createDownloadExecutor(binaries);

    await expect(
      executor.run(probeStage('https://www.douyin.com/video/7490000000000000001', tempDir))
    ).rejects.toMatchObject({
      code: 'platform_session_required',
      publicFacts: {
        kind: 'unauthorized',
        provider: 'yt-dlp',
        httpStatus: 403,
      },
    });
  });

  it('falls through to network_unavailable when Douyin encounters connection timeout', async () => {
    const stderr = 'ERROR: [douyin] Unable to download webpage: Connection timed out';
    const binaries = await fakeFailingBinaries(stderr);
    const executor = createDownloadExecutor(binaries);

    await expect(
      executor.run(probeStage('https://www.douyin.com/video/7490000000000000001', tempDir))
    ).rejects.toMatchObject({
      code: 'network_unavailable',
      publicFacts: {
        kind: 'timeout',
        provider: 'yt-dlp',
      },
    });
  });

  it('falls through to network_unavailable when Douyin encounters DNS failure', async () => {
    const stderr = 'ERROR: [douyin] Unable to download webpage: Failed to resolve host';
    const binaries = await fakeFailingBinaries(stderr);
    const executor = createDownloadExecutor(binaries);

    await expect(
      executor.run(probeStage('https://www.douyin.com/video/7490000000000000001', tempDir))
    ).rejects.toMatchObject({
      code: 'network_unavailable',
      publicFacts: {
        kind: 'dns',
        provider: 'yt-dlp',
      },
    });
  });

  it('falls through to format_unavailable when Douyin reports no video formats found', async () => {
    const stderr = 'ERROR: [douyin] No video formats found!';
    const binaries = await fakeFailingBinaries(stderr);
    const executor = createDownloadExecutor(binaries);

    await expect(
      executor.run(probeStage('https://www.douyin.com/video/7490000000000000001', tempDir))
    ).rejects.toMatchObject({
      code: 'format_unavailable',
      publicFacts: {
        kind: 'not-found',
        provider: 'yt-dlp',
      },
    });
  });

  it('falls through to download_http_error when Douyin returns HTTP 502 Bad Gateway', async () => {
    const stderr = 'ERROR: [douyin] Unable to download webpage: HTTP Error 502: Bad Gateway';
    const binaries = await fakeFailingBinaries(stderr);
    const executor = createDownloadExecutor(binaries);

    await expect(
      executor.run(probeStage('https://www.douyin.com/video/7490000000000000001', tempDir))
    ).rejects.toMatchObject({
      code: 'download_http_error',
      publicFacts: {
        kind: 'unavailable',
        httpStatus: 502,
        provider: 'yt-dlp',
      },
    });
  });

  it('preserves publicFacts and sanitizes upstreamMessage in CreatorExecutorError', async () => {
    const stderr = 'ERROR: [douyin] website verification required\nSensitive token: xyz123secret';
    const binaries = await fakeFailingBinaries(stderr);
    const executor = createDownloadExecutor(binaries);

    try {
      await executor.run(probeStage('https://www.douyin.com/video/7490000000000000001', tempDir));
      expect.fail('Should have thrown');
    } catch (error: any) {
      expect(error.code).toBe('platform_session_required');
      expect(error.publicFacts).toBeDefined();
      expect(error.publicFacts.kind).toBe('unauthorized');
      expect(error.publicFacts.provider).toBe('yt-dlp');
      expect(error.publicFacts.upstreamMessage).toContain('website verification required');
    }
  });
});
