import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CreatorArtifact, CreatorJob, CreatorJson } from '@opencreator/protocol';
import type { CreatorCommandDispatcher } from '../../src/creator/command-dispatcher.js';
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
      } as unknown as CreatorJob['stages'][number]);
      if (stageId === 'render-horizontal') {
        const sourceArtifact = entry.artifacts.find(artifact => artifact.kind === 'source_video');
        const videoPath = sourceArtifact === undefined
          ? join(entry.job.projectId, 'out.mp4')
          : `${String(sourceArtifact.path)}.dub.mp4`;
        // Giả lập thật: artifact xuất là file có nội dung (merge copy file này).
        void writeFile(videoPath, 'fake-dubbed-video').catch(() => undefined);
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
    // Mock trả receipt tối giản — cast qua unknown để khớp kiểu dispatcher thật.
    dispatcher: {
      dispatchWorkflow(
        jobId: string,
        request: { action: string; input: Record<string, CreatorJson>; expectedRevision?: number; idempotencyKey?: string },
        _identity?: { scopeKey?: string | null; inputFingerprint?: string | null; parentStageRunId?: string | null; resumedFromStageRunId?: string | null }
      ) {
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
    } as unknown as Pick<CreatorCommandDispatcher, 'dispatchWorkflow'>,
    jobs
  };
}

async function makeService(options: {
  failProbeIndex?: number;
  stageDelayMs?: number;
  /** Dùng lại dataDir của instance trước (giả lập restart đọc cùng pipeline.json). */
  dataDir?: string;
  onEpisodeCompleted?: (info: {
    projectId?: string;
    videoPath: string;
    title: string;
    episodeIndex?: number;
  }) => Promise<void>;
  /** v2: hook ghép xong (full movie sẵn sàng upload). */
  onMerged?: (info: {
    seriesKey: string | null;
    projectId: string | null;
    videoPath: string;
    title: string;
    episodeCount: number;
  }) => Promise<void>;
  getProject?: (projectId: string) => { projectId: string } | undefined;
} = {}): Promise<{
  service: ReturnType<typeof build>;
  dataDir: string;
  sourcePaths: string[];
  mergeCalls: Array<Array<string>>;
  createJobRequests: Array<{ projectId: string; creationKey?: string }>;
}> {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'oc-pipeline-test-'));
  trackTempDir(dataDir);
  const { creator, jobs } = makeFakeCreator();
  const { dispatcher } = makeFakeDispatcher(jobs, options.stageDelayMs ?? 20);
  const createJobRequests: Array<{ projectId: string; creationKey?: string }> = [];
  const creatorWithCapture = {
    ...creator,
    createJob: (request: { projectId: string; creationKey?: string }): CreatorJob => {
      createJobRequests.push(request);
      return creator.createJob(request);
    }
  };
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
    creator: creatorWithCapture,
    dispatcher,
    projects: {
      ensureDefaultProject: () => ({ projectId: 'project_1' }),
      ...(options.getProject === undefined ? {} : { getProject: options.getProject })
    },
    ...(options.onEpisodeCompleted === undefined ? {} : { onEpisodeCompleted: options.onEpisodeCompleted }),
    ...(options.onMerged === undefined ? {} : { onMerged: options.onMerged }),
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
  return { service: build(), dataDir, sourcePaths, mergeCalls, createJobRequests };
}

async function waitForSettle(service: {
  getSummary(): TranslationPipelineSummary;
}): Promise<TranslationPipelineSummary> {
  let summary = service.getSummary();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    summary = service.getSummary();
    const mergeStatus = summary.merges[0]?.status ?? 'idle';
    if (summary.counts.queued === 0 && summary.counts.running === 0
      && (mergeStatus === 'completed' || mergeStatus === 'failed'
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
    const groupMerge = summary.merges.find(entry => entry.seriesKey === 'series-A');
    expect(groupMerge?.status).toBe('completed');
    expect(groupMerge?.episodeCount).toBe(2);
    expect(summary.items.every(item => item.merged && item.mergeRunId === groupMerge?.runId)).toBe(true);
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
    // Merge: v2.5 — nhóm lẻ (seriesKey null) KHÔNG tự ghép nữa; giữ idle.
    expect(mergeCalls).toHaveLength(0);
    const groupMerge = after.merges.find(entry => entry.seriesKey === null);
    expect(groupMerge?.status ?? 'idle').toBe('idle');
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

// ---------------------------------------------------------------------------
// v2 "dịch cả bộ" — thứ tự dịch theo số tập, ghép theo bộ, tự nạp full movie
// ---------------------------------------------------------------------------

describe('translation pipeline v2 — dịch cả bộ', () => {
  async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitFor timeout');
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
  }

  it('nạp tập 100 trước rồi cả bộ 1..N → STILL dịch theo thứ tự số tập tăng dần', async () => {
    const hookCalls: Array<{ episodeIndex?: number }> = [];
    const { service, dataDir, sourcePaths } = await makeService({
      onEpisodeCompleted: async info => {
        hookCalls.push({ episodeIndex: info.episodeIndex });
      }
    });
    // Thêm các file nguồn riêng (khử trùng xử lý theo đường dẫn — cần file distinct).
    const extraPaths = await Promise.all(['tap-100.mp4', 'tap-01x.mp4', 'tap-02x.mp4', 'tap-03x.mp4']
      .map(async name => {
        const path = join(dataDir, name);
        await writeFile(path, 'fake-video');
        return path;
      }));
    // Nạp lộn xộn: ep 100 trước, rồi 3, rồi 1..2. (Test này kiểm THỨ TỰ DỊCH —
    // v2.5 mọi mục bộ không gọi hook từng tập ⇒ bỏ seriesKey để hook phản ánh
    // thứ tự hoàn thành.)
    service.enqueue([{ path: extraPaths[0]!, title: 'Tập 100', episodeIndex: 100 }]);
    await waitFor(() => service.getSummary().counts.running === 1);
    service.enqueue([
      { path: extraPaths[1]!, title: 'Tập 3', episodeIndex: 3 },
      { path: extraPaths[2]!, title: 'Tập 1', episodeIndex: 1 },
      { path: extraPaths[3]!, title: 'Tập 2', episodeIndex: 2 }
    ]);
    void sourcePaths;
    await waitForSettle(service);
    // ep100 đang running xong trước (đã chiếm slot), sau đó đúng 1 → 2 → 3.
    expect(hookCalls.map(call => call.episodeIndex)).toEqual([100, 1, 2, 3]);
  });

  it('batch items bỏ qua nạp đăng tung tập; onMerged gọi đúng 1 lần với FULL MOVIE', async () => {
    const hookCalls: Array<{ title: string }> = [];
    const mergedCalls: Array<{ seriesKey: string | null; projectId: string | null; videoPath: string; title: string; episodeCount: number }> = [];
    const { service, sourcePaths } = await makeService({
      onEpisodeCompleted: async info => {
        hookCalls.push({ title: info.title });
      },
      onMerged: async info => {
        mergedCalls.push(info);
      },
      getProject: projectId => ({ projectId, name: 'Mối Tình Đầu' })
    });
    service.enqueue([
      { path: sourcePaths[0]!, title: 'Tập 1', seriesKey: 'series-A', episodeIndex: 1, projectId: 'project_9', batchMode: true },
      { path: sourcePaths[1]!, title: 'Tập 2', seriesKey: 'series-A', episodeIndex: 2, projectId: 'project_9', batchMode: true }
    ]);
    await waitForSettle(service);
    // KHÔNG nạp đăng từng tập — chờ ghép xong cả bộ.
    expect(hookCalls).toHaveLength(0);
    const groupMerge = service.getSummary().merges.find(entry => entry.seriesKey === 'series-A');
    expect(groupMerge?.status).toBe('completed');
    expect(groupMerge?.episodeCount).toBe(2);
    expect(groupMerge?.uploadReady).toContain('upload-pending');
    await waitFor(() => mergedCalls.length === 1);
    expect(mergedCalls[0]!.title).toBe('Mối Tình Đầu');
    expect(mergedCalls[0]!.projectId).toBe('project_9');
    expect(mergedCalls[0]!.seriesKey).toBe('series-A');
    expect(mergedCalls[0]!.videoPath).toContain('upload-pending');
    expect(mergedCalls[0]!.episodeCount).toBe(2);
    // Mục batch không đánh dấu socialEnqueuedAt (không nạp tung tập) nhưng merged ✓.
    expect(service.getSummary().items.every(item => item.merged && item.socialEnqueuedAt == null)).toBe(true);
  });

  it('2 series ghép 2 phiên riêng — không trộn 2 bộ', async () => {
    const mergedKeys: Array<string | null> = [];
    const { service, sourcePaths } = await makeService({
      onMerged: async info => {
        mergedKeys.push(info.seriesKey);
      }
    });
    service.enqueue([
      { path: sourcePaths[0]!, title: 'S1-Tập 1', seriesKey: 'series-1', episodeIndex: 1, batchMode: true },
      { path: sourcePaths[1]!, title: 'S2-Tập 1', seriesKey: 'series-2', episodeIndex: 1, batchMode: true }
    ]);
    await waitForSettle(service);
    const merges = service.getSummary().merges;
    expect(merges).toHaveLength(2);
    const s1 = merges.find(entry => entry.seriesKey === 'series-1');
    const s2 = merges.find(entry => entry.seriesKey === 'series-2');
    expect(s1?.status).toBe('completed');
    expect(s2?.status).toBe('completed');
    expect(mergedKeys).toEqual(expect.arrayContaining(['series-1', 'series-2']));
  });

  it('mkdir upload-pending ngay khi pipeline khởi động', async () => {
    const { dataDir } = await makeService();
    expect(existsSync(join(dataDir, 'upload-pending'))).toBe(true);
  });

  it('migrate state cũ: `merge` đơn → merges[0] với seriesKey null', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oc-pipeline-legacy-'));
    trackTempDir(dataDir);
    const pipelineDir = join(dataDir, 'translation-pipeline');
    await mkdir(pipelineDir, { recursive: true });
    await writeFile(join(pipelineDir, 'pipeline.json'), JSON.stringify({
      items: [],
      paused: false,
      merge: {
        status: 'completed',
        runId: 'legacy-run',
        outputPath: 'D:/old/merged.mp4',
        uploadReady: 'D:/old/upload-ready.mp4',
        episodeCount: 5,
        skipped: [],
        error: null
      }
    }), 'utf8');
    const { service } = await makeService({ dataDir });
    const summary = service.getSummary();
    expect(summary.merges).toHaveLength(1);
    expect(summary.merges[0]!.seriesKey).toBeNull();
    expect(summary.merges[0]!.status).toBe('completed');
    expect(summary.merges[0]!.episodeCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// GĐ4 — Hook tự nạp đăng sau dịch (điều khiển từ daemon)
// ---------------------------------------------------------------------------

describe('translation pipeline — hook onEpisodeCompleted', () => {
  async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitFor timeout');
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
  }

  it('dịch xong 1 tập → hook nhận đúng videoPath/title/episode và state ghi socialEnqueuedAt', async () => {
    const hookCalls: Array<{ projectId?: string; videoPath: string; title: string; episodeIndex?: number }> = [];
    const { service, sourcePaths } = await makeService({
      onEpisodeCompleted: async info => {
        hookCalls.push(info);
      },
      getProject: projectId => ({ projectId })
    });
    service.enqueue([{ path: sourcePaths[0]!, title: 'Tập 3', episodeIndex: 3, projectId: 'project_9' }]);
    await waitForSettle(service);
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.title).toBe('Tập 3');
    expect(hookCalls[0]!.episodeIndex).toBe(3);
    expect(hookCalls[0]!.projectId).toBe('project_9');
    expect(hookCalls[0]!.videoPath).toContain('tap-01.mp4.dub.mp4');
    await waitFor(() => service.getSummary().items[0]!.socialEnqueuedAt != null);
    expect(service.getSummary().items[0]!.socialEnqueuedAt).toBeTruthy();
  });

  it('hook ném lỗi → mục vẫn completed, không đánh socialEnqueuedAt (lần sau thử lại)', async () => {
    const { service, sourcePaths } = await makeService({
      onEpisodeCompleted: async () => {
        throw new Error('social db khóa');
      }
    });
    service.enqueue([{ path: sourcePaths[0]!, title: 'Tập 1', episodeIndex: 1 }]);
    const after = await waitForSettle(service);
    expect(after.counts.completed).toBe(1);
    expect(after.counts.failed).toBe(0);
    expect(after.items[0]!.socialEnqueuedAt ?? null).toBeNull();
  });

  it('restart (service mới cùng dataDir): recover KHÔNG gọi lại hook khi socialEnqueuedAt đã ghi', async () => {
    const hookCalls: Array<{ videoPath: string }> = [];
    const first = await makeService({
      onEpisodeCompleted: async info => {
        hookCalls.push(info);
      }
    });
    first.service.enqueue([{ path: first.sourcePaths[0]!, title: 'Tập 1', episodeIndex: 1 }]);
    await waitForSettle(first.service);
    expect(hookCalls).toHaveLength(1);
    await waitFor(() => first.service.getSummary().items[0]!.socialEnqueuedAt != null);
    // Giả lập restart: instance mới đọc lại state đĩa + recover().
    const second = await makeService({
      dataDir: first.dataDir,
      onEpisodeCompleted: async info => {
        hookCalls.push(info);
      }
    });
    await second.service.recover();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
    expect(hookCalls).toHaveLength(1); // không nạp lặp
  });

  it('restart với mục completed CHƯA đánh dấu (rớt giữa hook) → recover gọi hook đúng 1 lần rồi tự ghi', async () => {
    const first = await makeService(); // không cắm hook → dịch xong, không đánh dấu
    first.service.enqueue([{ path: first.sourcePaths[0]!, title: 'Tập 2', episodeIndex: 2 }]);
    await waitForSettle(first.service);
    expect(first.service.getSummary().items[0]!.socialEnqueuedAt ?? null).toBeNull();

    const hookCalls: Array<{ videoPath: string; title: string }> = [];
    const second = await makeService({
      dataDir: first.dataDir,
      onEpisodeCompleted: async info => {
        hookCalls.push(info);
      }
    });
    await second.service.recover();
    await waitFor(() => hookCalls.length === 1);
    await waitFor(() => second.service.getSummary().items[0]!.socialEnqueuedAt != null);
    // recover lần nữa vẫn không gọi lại (đã đánh dấu).
    await second.service.recover();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 120));
    expect(hookCalls).toHaveLength(1);
  });

  it('item.projectId tồn tại → createJob dùng project đó; project biến mất → fallback mặc định', async () => {
    const { service, sourcePaths, createJobRequests } = await makeService({
      getProject: projectId => projectId === 'project_9' ? { projectId: 'project_9' } : undefined
    });
    service.enqueue([
      { path: sourcePaths[0]!, title: 'Tập 1', episodeIndex: 1, projectId: 'project_9' },
      { path: sourcePaths[1]!, title: 'Tập 2', episodeIndex: 2, projectId: 'project_lost' }
    ]);
    await waitForSettle(service);
    const usedIds = createJobRequests.map(request => request.projectId);
    expect(usedIds).toContain('project_9');
    expect(usedIds).toContain('project_1'); // fallback mặc định
    expect(service.getSummary().counts.completed).toBe(2);
  });

  it('không cắm hook → pipeline vẫn chạy bình thường (mặc định cũ)', async () => {
    const { service, sourcePaths } = await makeService();
    service.enqueue([{ path: sourcePaths[0]!, title: 'Tập 1', episodeIndex: 1 }]);
    const after = await waitForSettle(service);
    expect(after.counts.completed).toBe(1);
    expect(after.items[0]!.socialEnqueuedAt ?? null).toBeNull();
  });

  // -------------------------------------------------------------------------
  // v2.4 — tự suy seriesKey từ thẻ 《tên phim》 khi luồng nạp không truyền key:
  // mọi mục thuộc một bộ ĐỢI GHÉP xong mới tự nạp đăng (không còn đăng tung tập).
  // -------------------------------------------------------------------------

  it('nạp không truyền key nhưng tiêu đề có thẻ 《》 → tự suy seriesKey, KHÔNG gọi hook tung tập', async () => {
    const hookCalls: Array<{ title: string }> = [];
    const mergeCalls: Array<{ title: string; episodeCount: number }> = [];
    const { service, sourcePaths } = await makeService({
      onEpisodeCompleted: async info => { hookCalls.push({ title: info.title }); },
      onMerged: async info => { mergeCalls.push({ title: info.title, episodeCount: info.episodeCount }); }
    });
    service.enqueue([
      { path: sourcePaths[0]!, title: '《天赋万古无双，只手横推三千帝》 Tập 1', episodeIndex: 1 },
      { path: sourcePaths[1]!, title: '《天赋万古无双，只手横推三千帝》 Tập 2', episodeIndex: 2 }
    ]);
    const after = await waitForSettle(service);
    expect(after.items[0]!.seriesKey).toBe('title:天赋万古无双，只手横推三千帝');
    expect(after.items[1]!.seriesKey).toBe('title:天赋万古无双，只手横推三千帝');
    expect(after.items[0]!.socialEnqueuedAt ?? null).toBeNull();
    expect(hookCalls).toHaveLength(0);
    // Ghép cả bộ xong → hook full movie đã tới.
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]!.episodeCount).toBe(2);
  });

  it('tiêu đề không có thẻ 《》 → mục lẻ giữ nguyên: hook tung tập chạy, không ghép', async () => {
    const hookCalls: Array<{ title: string }> = [];
    const { service, sourcePaths, mergeCalls: mergeSegments } = await makeService({
      onEpisodeCompleted: async info => { hookCalls.push({ title: info.title }); }
    });
    service.enqueue([{ path: sourcePaths[0]!, title: 'OpenCreator kiem tra dich video', episodeIndex: 1 }]);
    const after = await waitForSettle(service);
    expect(after.items[0]!.seriesKey ?? null).toBeNull();
    expect(hookCalls).toHaveLength(1);
    expect(mergeSegments).toHaveLength(0);
  });

  it('nhóm lẻ (seriesKey null) KHÔNG được tự ghép — không trộn video không liên quan', async () => {
    const { service, sourcePaths, mergeCalls } = await makeService();
    service.enqueue([
      { path: sourcePaths[0]!, title: 'video lẻ Một', episodeIndex: 1 },
      { path: sourcePaths[1]!, title: 'video lẻ Hai', episodeIndex: 2 }
    ]);
    const after = await waitForSettle(service);
    const solo = after.merges.find(entry => entry.seriesKey === null);
    expect(solo === undefined || solo.status === 'idle').toBe(true);
    expect(mergeCalls).toHaveLength(0);
  });

  it('bù seriesKey khi đọc state cũ: mục chưa nạp đăng được bù theo thẻ 《》, mục đã nạp giữ nguyên', async () => {
    const first = await makeService();
    // Viết state giả trực tiếp: 1 mục chưa nạp (thẻ 《》) + 1 mục đã nạp đăng.
    const statePath = join(first.dataDir, 'translation-pipeline', 'pipeline.json');
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify({
      paused: false,
      items: [
        {
          id: 'item-new', sourcePath: join(first.dataDir, 'a.mp4'), title: '《Bộ phim A》 Tập 5',
          seriesKey: null, episodeIndex: 5, addedAt: '2026-01-01T00:00:00.000Z',
          status: 'completed', jobId: null, error: null, outputVideoPath: null,
          durationSeconds: null, merged: false, mergeRunId: null, projectId: null, socialEnqueuedAt: null
        },
        {
          id: 'item-old', sourcePath: join(first.dataDir, 'b.mp4'), title: '《Bộ phim A》 Tập 6',
          seriesKey: null, episodeIndex: 6, addedAt: '2026-01-01T00:00:00.000Z',
          status: 'completed', jobId: null, error: null, outputVideoPath: null,
          durationSeconds: null, merged: false, mergeRunId: null, projectId: null,
          socialEnqueuedAt: '2026-01-02T00:00:00.000Z'
        }
      ],
      merges: []
    }, null, 2)}\n`);
    const second = await makeService({ dataDir: first.dataDir });
    const summary = second.service.getSummary();
    expect(summary.items[0]!.seriesKey).toBe('title:Bộ phim A');
    expect(summary.items[1]!.seriesKey ?? null).toBeNull(); // đã nạp đăng → giữ nguyên
  });
});
