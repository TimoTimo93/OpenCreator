import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CreatorArtifact, CreatorJob, CreatorJson } from '@opencreator/protocol';
import {
  createTranslationPipelineService,
  type TranslationPipelineSummary
} from '../../src/creator/translation-pipeline/pipeline.js';
import type { MediaProbe } from '../../src/creator/validators/media.js';

const cleanupDirs: Array<{ path: string }> = [];

function trackTempDir(path: string): void {
  cleanupDirs.push({ path });
}

const PROBE: MediaProbe = { duration: 10, width: 1920, height: 1080, hasVideo: true, hasAudio: true };

type FakeJobEntry = {
  job: CreatorJob;
  artifacts: CreatorArtifact[];
};

function makeFakeCreator() {
  const jobs = new Map<string, FakeJobEntry>();
  let nextId = 0;
  return {
    jobs,
    creator: {
      createJob(_request: { creationKey?: string }): CreatorJob {
        const id = `job_${nextId += 1}`;
        const job: CreatorJob = {
          id,
          projectId: 'project_1',
          templateId: 'video-translation',
          templateVersion: 2,
          status: 'running',
          revision: 0,
          state: {},
          presetOrigin: null,
          agentThreadId: null,
          stages: [],
          artifacts: [],
          providerRequests: [],
          activities: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as unknown as CreatorJob;
        jobs.set(id, { job, artifacts: job.artifacts });
        return job;
      },
      getJob(jobId: string): CreatorJob | undefined {
        return jobs.get(jobId)?.job;
      },
      registerSourceVideo(jobId: string, request: { path: string; expectedRevision: number }): {
        job: CreatorJob;
        artifact: CreatorArtifact;
        deduplicated: boolean;
      } {
        const entry = jobs.get(jobId);
        if (entry === undefined) throw new Error('missing job');
        const artifact: CreatorArtifact = {
          id: `artifact_${entry.artifacts.length + 1}`,
          jobId,
          jobRevision: request.expectedRevision,
          kind: 'source_video',
          status: 'completed',
          path: request.path,
          metadata: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as unknown as CreatorArtifact;
        entry.artifacts.push(artifact);
        entry.job.revision += 1;
        return { job: entry.job, artifact, deduplicated: false };
      }
    }
  };
}

function makeFakeDispatcher(jobs: Map<string, FakeJobEntry>, stageDelayMs: number) {
  let runId = 0;
  const runStage = (jobId: string, stageId: string): void => {
    const entry = jobs.get(jobId);
    if (entry === undefined) throw new Error('missing job');
    // Stage hoàn thành bất đồng bộ sau stageDelayMs để đi qua vòng poll thật của service.
    setTimeout(() => {
        // Khớp receipt: stageRunId = `${stageId}_run` (mỗi job chạy 1 lần mỗi stage).
        entry.job.stages.push({
          id: `${stageId}_run`,
        jobId,
        stageId,
        executor: 'krillinai',
        status: 'succeeded',
        dispatchStatus: 'done',
        claimOwner: null,
        claimExpiresAt: null,
        attempt: 1,
        idempotencyKey: null,
        scopeKey: null,
        inputFingerprint: null,
        progress: {},
        errorCode: null,
        errorMessage: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      } as CreatorJob['stages'][number]);
      if (stageId === 'render-horizontal') {
        const sourceArtifact = entry.artifacts.find(artifact => artifact.kind === 'source_video');
        const videoPath = sourceArtifact === undefined
          ? join(entry.job.projectId, 'out.mp4')
          : `${String(sourceArtifact.path)}.dub.mp4`;
        entry.artifacts.push({
          id: `artifact_h_${entry.artifacts.length + 1}`,
          jobId,
          jobRevision: entry.job.revision,
          kind: 'horizontal_video',
          status: 'completed',
          path: videoPath,
          metadata: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as unknown as CreatorArtifact);
      }
    }, stageDelayMs);
  };
  return {
    dispatcher: {
      dispatchWorkflow(jobId: string, request: { action: string; input: Record<string, CreatorJson> }) {
        const entry = jobs.get(jobId);
        if (entry === undefined) throw new Error('missing job');
        entry.job.revision += 1;
        if (request.action === 'update-settings') {
          Object.assign(entry.job.state, request.input.patch);
          return {
            job: entry.job,
            receipt: { newRevision: entry.job.revision },
            commandReceipt: { stageRunId: null, status: 'committed' }
          };
        }
        runStage(jobId, String(request.input.stageId));
        return {
          job: entry.job,
          receipt: { newRevision: entry.job.revision },
          commandReceipt: { stageRunId: `${request.input.stageId}_run`, status: 'committed' }
        };
      }
    }
  };
}

async function makeService(options: {
  failProbeIndex?: number;
  stageDelayMs?: number;
} = {}): Promise<{
  service: ReturnType<typeof build>;
  dataDir: string;
  sourcePaths: string[];
  mergeCalls: Array<Array<string>>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'oc-pipeline-test-'));
  trackTempDir(dataDir);
  const { creator, jobs } = makeFakeCreator();
  const { dispatcher } = makeFakeDispatcher(jobs, options.stageDelayMs ?? 20);
  const sourcePaths = await Promise.all([
    join(dataDir, 'tap-01.mp4'),
    join(dataDir, 'tap-02.mp4')
  ].map(async path => {
    await writeFile(path, 'fake-video');
    return path;
  }));
  const mergeCalls: Array<Array<string>> = [];
  const service = createTranslationPipelineService({
    dataDir,
    creator,
    dispatcher,
    projects: { ensureDefaultProject: () => ({ projectId: 'project_1' }) },
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    ensureRuntimeReady: async () => undefined,
    probeSourceMedia: async path => {
      if (options.failProbeIndex !== undefined
        && normalize(path) === normalize(sourcePaths[options.failProbeIndex]!)) {
        throw new Error('Không đọc được file nguồn');
      }
      return PROBE;
    },
    mergeSegments: async request => {
      mergeCalls.push(request.segments.map(segment => segment.path));
      const outputPath = join(dataDir, 'merged-out.mp4');
      await writeFile(outputPath, 'fake-merged');
      return {
        outputPath,
        durationSeconds: 20,
        segmentDurations: request.segments.map(() => 10),
        reencodedSegments: []
      };
    }
  });
  function build() {
    return service;
  }
  return { service: build(), dataDir, sourcePaths, mergeCalls };
}

async function waitForSettle(service: {
  getSummary(): TranslationPipelineSummary;
}): Promise<TranslationPipelineSummary> {
  let summary = service.getSummary();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    summary = service.getSummary();
    if (summary.counts.queued === 0 && summary.counts.running === 0
      && (summary.merge.status === 'completed' || summary.merge.status === 'failed'
        || summary.counts.completed === 0)) {
      return summary;
    }
  }
  return summary;
}

afterAll(async () => {
  // Temp dirs cleaned by OS temp hygiene; keep the hook for future fs.rm usage.
  void cleanupDirs;
});

describe('translation pipeline service', () => {
  it('enqueue khử trùng theo đường dẫn, tự chạy tuần tự và ghép đúng thứ tự số tập', async () => {
    const { service, sourcePaths, mergeCalls } = await makeService();
    const first = service.enqueue([
      { path: sourcePaths[0]!, title: 'Tập 2', seriesKey: 'series-A', episodeIndex: 2 },
      { path: sourcePaths[1]!, title: 'Tập 1', seriesKey: 'series-A', episodeIndex: 1 }
    ]);
    expect(first.items).toHaveLength(2);
    const second = service.enqueue([{ path: sourcePaths[0]!, episodeIndex: 2 }]);
    expect(second.items).toHaveLength(2);

    const summary = await waitForSettle(service);
    expect(summary.counts.completed).toBe(2);
    expect(summary.counts.failed).toBe(0);
    expect(summary.merge.status).toBe('completed');
    expect(summary.merge.episodeCount).toBe(2);
    expect(summary.items.every(item => item.merged && item.mergeRunId === summary.merge.runId)).toBe(true);
    // Ghép: tập 1 (tap-01... .dub.mp4) trước tập 2.
    expect(mergeCalls).toHaveLength(1);
    const expectedFirst = `${sourcePaths[1]!}.dub.mp4`;
    const expectedSecond = `${sourcePaths[0]!}.dub.mp4`;
    expect(mergeCalls[0]![0]).toContain(expectedFirst.split('/').at(-1) ?? expectedFirst);
    expect(mergeCalls[0]![1]).toContain(expectedSecond.split('/').at(-1) ?? expectedSecond);
  });

  it('mục lỗi không chặn mục sau; mục lỗi bị loại khỏi phiên ghép', async () => {
    const { service, sourcePaths, mergeCalls } = await makeService({
      failProbeIndex: 0
    });
    const summary = service.enqueue([
      { path: sourcePaths[0]!, title: 'Tập 1', episodeIndex: 1 },
      { path: sourcePaths[1]!, title: 'Tập 2', episodeIndex: 2 }
    ]);
    expect(summary.counts.queued).toBe(2);

    const after = await waitForSettle(service);
    expect(after.counts.failed).toBe(1);
    expect(after.counts.completed).toBe(1);
    const failedItem = after.items.find(item => item.status === 'failed');
    expect(failedItem?.error).toContain('Không đọc được file nguồn');
    // Merge: chỉ ghép phần đã hoàn thành.
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]).toHaveLength(1);
  });

  it('paused chặn chạy; resume tiếp tục', async () => {
    const { service, sourcePaths } = await makeService();
    service.pause();
    service.enqueue([{ path: sourcePaths[0]!, title: 'Tập 1', episodeIndex: 1 }]);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
    expect(service.getSummary().counts.queued).toBe(1);
    service.resume();
    const after = await waitForSettle(service);
    expect(after.counts.completed).toBe(1);
  });

  it('remove hủy mục running thành canceled và retry về hàng chờ', async () => {
    const { service, sourcePaths } = await makeService({ stageDelayMs: 150 });
    service.pause();
    const summary = service.enqueue([{ path: sourcePaths[0]!, title: 'Tập 1', episodeIndex: 1 }]);
    const itemId = summary.items[0]!.id;
    // Mục queued bị gỡ thẳng khỏi hàng đợi.
    service.remove(itemId);
    expect(service.getSummary().items).toHaveLength(0);
    // Nạp lại và chờ mục vào running rồi hủy.
    const summary2 = service.enqueue([{ path: sourcePaths[0]!, title: 'Tập 1', episodeIndex: 1 }]);
    const itemId2 = summary2.items[0]!.id;
    service.resume();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 220));
    service.pause();
    expect(service.getSummary().items[0]!.status).toBe('running');
    service.remove(itemId2);
    expect(service.getSummary().items[0]!.status).toBe('canceled');
    service.retry(itemId2);
    expect(service.getSummary().items[0]!.status).toBe('queued');
    service.resume();
    await waitForSettle(service);
  });

  it('recover an toàn khi state chưa có mục nào', async () => {
    const { service } = await makeService();
    await service.recover();
    expect(service.getSummary().items).toHaveLength(0);
  });
});
