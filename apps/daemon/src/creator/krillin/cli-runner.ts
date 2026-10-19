import { copyFile, link, mkdir, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type CreatorJson,
  type CreatorServicesConfig,
  resolveEffectiveTranscriptionProvider
} from '@opencreator/protocol';
import type { CreatorExecutorInput } from '../executor.js';
import { CreatorExecutorError } from '../executor.js';
import { sha256CreatorFile } from '../file-hash.js';
import { publicErrorKindForCode, sanitizePublicErrorFacts, type PublicErrorFacts } from '@opencreator/protocol';
import { spawnCreatorProcess } from '../process-tree.js';
import {
  BGM_SEPARATION_MODEL,
  ensureSeparationRuntime,
  extractSourceAudio,
  mixDubVoiceWithBackground,
  replaceDubbedVideoAudio,
  resolveBackgroundMusicSettings,
  resolveSeparationRuntimeRoot,
  separateBackgroundStem
} from '../audio/bgm-separation.js';
import { createKrillinConfigToml } from './config-bridge.js';
import { gatewayCreatorBinding } from '../../gateway/creator-service-source.js';
import { isYouTubeSource } from './execution-plan.js';
import type { KrillinTtsGatewayConfig } from './tts-gateway.js';
import {
  resolveInside,
  type KrillinRuntimeManifest
} from './manifest.js';
import {
  DEFAULT_HARDSUB_BAND,
  buildHardsubPreprocessArgs,
  detectHardsubBand,
  parseHardsubBandPercent,
  parseHardsubHandling,
  type HardsubBand
} from '../translation-pipeline/hardsub-mask.js';
import { probeStreamSpec } from '../translation-pipeline/merge.js';
import type { YtDlpRuntime } from '../yt-dlp/runtime.js';

export type MaterializedKrillinArtifact = {
  id: string;
  kind: string;
  path: string;
};

export type KrillinResultArtifact = {
  id: string;
  kind: string;
  relativePath: string;
  mimeType?: string;
  size?: number;
  sha256?: string;
};

type KrillinCliResponse = {
  ok?: boolean;
  stage?: string;
  task_id?: string;
  outputs?: Record<string, string>;
  warnings?: string[];
  error?: {
    kind?: string;
    code?: string;
    message?: string;
    retryable?: boolean;
  };
};

export type KrillinCliProgressFrame = {
  type: 'progress';
  phase?: string;
  percent: number;
  message?: string;
};

type RunProcess = (input: {
  executable: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
}) => Promise<void>;

export class KrillinCliError extends Error {
  readonly publicFacts: PublicErrorFacts;
  constructor(
    readonly code: string,
    message: string,
    readonly kind?: string,
    readonly retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'KrillinCliError';
    const douyinFailure = /^prepare_(?:media|audio_fallback)_failed$/.test(code) && /\[Douyin(?:\+[^\]]+)?\]/i.test(message);
    const signatureRequired = douyinFailure && /Douyin request signature is required/i.test(message);
    const sessionRequired = douyinFailure && /fresh cookies|Douyin browser identity was rejected/i.test(message);
    const status = sessionRequired || signatureRequired ? /http error\s+(\d{3})\b/i.exec(message) : null;
    this.publicFacts = sanitizePublicErrorFacts({
      kind: signatureRequired ? 'unsupported' : sessionRequired ? 'unauthorized' : /^prepare_(?:media|audio_fallback)_failed$/.test(code)
        && /bilibili risk control (?:rejected the media request|blocked media extraction)/i.test(message)
        ? 'http-rejected' : publicErrorKindForCode(code) ?? 'unknown', provider: 'krillinai',
      upstreamCode: code, upstreamMessage: message,
      ...(status === null ? {} : { httpStatus: Number(status[1]) })
    });
  }
}

type RunKrillinCliInput = {
  resourceRoot: string;
  jobsRoot: string;
  dependencyRoot: string;
  manifest: KrillinRuntimeManifest;
  stage: CreatorExecutorInput;
  config: CreatorServicesConfig;
  artifacts: MaterializedKrillinArtifact[];
  source?: string;
  options: Record<string, unknown>;
  ytDlpRuntime?: YtDlpRuntime;
  llmOverride?: { baseUrl: string; apiKey: string; model: string };
  /** Ghi đè endpoint TTS (cổng Edge TTS cục bộ) cho giai đoạn lồng tiếng. */
  ttsOverride?: KrillinTtsGatewayConfig;
};

export async function runKrillinCli(input: RunKrillinCliInput): Promise<KrillinResultArtifact[]> {
  const cli = input.manifest.resources.find(resource => (
    resource.kind === 'executable'
    && /(?:^|\/)krillinai-cli(?:\.exe)?$/i.test(resource.path)
  ));
  if (cli === undefined) throw new CreatorExecutorError('dependency_not_packaged', 'Missing KrillinAI CLI');

  const runtimeBin = resolve(input.resourceRoot, 'bin');
  const launcherRoot = join(input.stage.workdir, '.krillin-cli');
  const configDir = join(launcherRoot, 'config');
  const dependencyBin = join(input.dependencyRoot, 'bin');
  await rm(launcherRoot, { recursive: true, force: true });
  await mkdir(configDir, { recursive: true });
  const officialTranscriptionModel = gatewayCreatorBinding(input.config)?.models.transcription;
  const effectiveTranscriptionProvider = resolveEffectiveTranscriptionProvider(
    input.config.transcription,
    officialTranscriptionModel
  );
  const cliResourceRoot = await prepareCliResourceRoot({
    resourceRoot: input.resourceRoot,
    dependencyRoot: input.dependencyRoot,
    launcherRoot,
    onDemandTranscriptionProvider: isOnDemandTranscriptionProvider(
      effectiveTranscriptionProvider
    ) ? effectiveTranscriptionProvider : undefined,
    onDemandTranscriptionModel: effectiveTranscriptionProvider === 'whisper.cpp'
      ? input.config.transcription.whisperCpp.model
      : undefined,
    ytDlpRuntime: input.ytDlpRuntime
  });
  const cliConfig = stageConfig(
    input.config,
    krillinCliStageId(input.stage.stageRun.stageId),
    input.options,
    input.ttsOverride
  );
  await writeFile(
    join(configDir, 'config.toml'),
    createKrillinConfigToml(cliConfig, input.llmOverride, gatewayCreatorBinding(input.config)?.models.transcription),
    { mode: 0o600 }
  );
  await writeFile(join(dependencyBin, '.yt-dlp-last-check'), new Date().toISOString(), { mode: 0o600 });

  const style = input.options.subtitleStyle;
  const stylePath = style === undefined ? undefined : join(configDir, 'subtitle-style.json');
  if (stylePath !== undefined) {
    await writeFile(stylePath, `${JSON.stringify(style, null, 2)}\n`, { mode: 0o600 });
  }
  if (krillinCliStageId(input.stage.stageRun.stageId) !== 'subtitle') {
    await writeInitialManifest(input.stage, input.options);
  }

  const executable = resolveInside(input.resourceRoot, cli.path);
  const supportsRenderLineMode = cliSupportsRenderLineMode(executable);
  // Xử lý phụ đề in sẵn (hardsub) trước khi burn phụ đề mới: tạo
  // `source_hardsub_processed.mp4` bên cạnh workdir rồi dùng nó làm nguồn burn
  // (không đè file gốc). Chỉ áp dụng cho stage render (nơi burn phụ đề).
  const artifactsForCli = await preprocessHardsubForRenderStage(input);
  const args = buildKrillinCliCommandArguments(
    input.stage,
    artifactsForCli,
    input.options,
    stylePath,
    input.source,
    supportsRenderLineMode
  );
  input.stage.reportProgress({
    krillinMode: 'cli',
    providerStatus: 'running',
    percent: 5
  });
  try {
    let response: KrillinCliResponse;
    try {
      response = await executeCli({
        executable,
        args,
        cwd: launcherRoot,
        runtimeBin,
        resourceRoot: cliResourceRoot,
        dependencyBin,
        ytDlpRuntime: input.ytDlpRuntime,
        reportProgress: progress => input.stage.reportProgress(progress),
        signal: input.stage.signal
      });
    } catch (error) {
      const recovered = await recoverWindowsHorizontalAssRender({
        platform: process.platform,
        resourceRoot: input.resourceRoot,
        manifest: input.manifest,
        stageId: input.stage.stageRun.stageId,
        workdir: input.stage.workdir,
        artifacts: artifactsForCli,
        signal: input.stage.signal,
        error,
        reportProgress: progress => input.stage.reportProgress(progress)
      });
      if (recovered === undefined) throw error;
      response = recovered;
    }
    const artifacts = await collectArtifacts(input, response);
    const restored = await restoreBackgroundMusicForDubbedStage(input, artifacts);
    input.stage.reportProgress({
      krillinMode: 'cli',
      providerStatus: 'succeeded',
      percent: 100,
      completedOutputKinds: restored.map(artifact => artifact.kind)
    });
    return restored;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'KrillinAI CLI failed';
    input.stage.reportProgress({
      krillinMode: 'cli',
      providerStatus: 'failed',
      phase: 'failed',
      krillinEventPayload: {
        phase: 'failed',
        message
      }
    });
    throw error;
  } finally {
    await removeLauncherRootBestEffort(launcherRoot);
  }
}

/** Tên file pre-process hardsub trong workdir stage (không đè file nguồn gốc). */
const HARDSUB_PROCESSED_VIDEO = 'source_hardsub_processed.mp4';

/**
 * Bước pre-process "sub mới đè sub cũ": với stage render (nơi burn phụ đề mới)
 * và `hardsubHandling ≠ none`, chạy ffmpeg xử lý vùng hardsub của video nguồn
 * (blur/cover/crop theo dải % chiều cao tính từ mép đáy) tạo
 * `source_hardsub_processed.mp4`, rồi hoán video đó vào artifacts để CLI burn
 * phụ đề mới đè lên. File nguồn gốc không bị đụng tới.
 *
 * Mọi thất bại không chặn stage: không dò được dải → dùng dải mặc định;
 * không đọc được kích thước video → bỏ qua xử lý và burn như cũ.
 */
async function preprocessHardsubForRenderStage(
  input: RunKrillinCliInput
): Promise<MaterializedKrillinArtifact[]> {
  const stageId = krillinCliStageId(input.stage.stageRun.stageId);
  if (stageId !== 'render-horizontal' && stageId !== 'render-vertical') return input.artifacts;
  const mode = parseHardsubHandling(input.options.hardsubHandling);
  if (mode === 'none') return input.artifacts;
  const ffmpeg = input.manifest.resources.find(resource => (
    resource.kind === 'executable'
    && /(?:^|\/)ffmpeg(?:\.exe)?$/i.test(resource.path)
  ));
  if (ffmpeg === undefined) return input.artifacts;
  // Nguồn burn trùng với lựa chọn của buildKrillinCliCommandArguments:
  // ưu tiên video lồng tiếng khi có, nếu không dùng video nguồn.
  const dubbed = booleanOption(input.options, 'dubbed', false);
  const dubbedVideo = artifactPath(input.artifacts, 'dubbed_video');
  const sourceVideo = artifactPath(input.artifacts, 'source_video');
  const burnSource = dubbed && dubbedVideo !== undefined ? dubbedVideo : sourceVideo;
  if (burnSource === undefined) return input.artifacts;
  const ffmpegPath = resolveInside(input.resourceRoot, ffmpeg.path);
  const reportHardsub = (progress: Record<string, CreatorJson>) => input.stage.reportProgress({
    krillinMode: 'cli',
    providerStatus: 'running',
    phase: 'hardsub_preprocess',
    ...progress
  });

  // Dải hardsub: người dùng chỉnh đỉnh dải (hardsubBandPercent) thì dùng luôn;
  // để trống (null — mặc định) thì tự dò từ khung hình mẫu, lỗi thì dùng mặc định.
  const manualTopPercent = parseHardsubBandPercent(input.options.hardsubBandPercent);
  let band: HardsubBand;
  let detected = false;
  if (manualTopPercent === null) {
    reportHardsub({ percent: 2, hardsubMode: mode, message: 'Đang dò vùng phụ đề in sẵn (hardsub) trong video nguồn' });
    const detection = await detectHardsubBand({
      ffmpegPath,
      videoPath: burnSource,
      signal: input.stage.signal
    });
    band = detection.band;
    detected = detection.detected;
  } else {
    band = { bottomPercent: DEFAULT_HARDSUB_BAND.bottomPercent, topPercent: manualTopPercent };
  }

  // Chuẩn encode lấy từ phân tích kích thước bằng ffprobe (cùng nguồn với các
  // bước ffmpeg khác: binary khai báo trong runtime manifest).
  let width = 0;
  let height = 0;
  try {
    const ffprobe = input.manifest.resources.find(resource => (
      resource.kind === 'executable'
      && /(?:^|\/)ffprobe(?:\.exe)?$/i.test(resource.path)
    ));
    if (ffprobe === undefined) throw new Error('ffprobe không có trong runtime manifest');
    const spec = await probeStreamSpec(resolveInside(input.resourceRoot, ffprobe.path), burnSource);
    if (spec.video === null || spec.video.width < 2 || spec.video.height < 2) {
      throw new Error('Video nguồn không đọc được kích thước khung hình');
    }
    width = spec.video.width;
    height = spec.video.height;
  } catch (error) {
    // Không đọc được kích thước → bỏ qua xử lý hardsub, burn như cũ (không chết stage).
    reportHardsub({
      percent: 2,
      hardsubMode: mode,
      hardsubSkipped: true,
      message: `Bỏ qua xử lý hardsub: ${error instanceof Error ? error.message : String(error)}`
    });
    return input.artifacts;
  }

  const outputPath = join(input.stage.workdir, HARDSUB_PROCESSED_VIDEO);
  const args = buildHardsubPreprocessArgs({
    mode,
    band,
    width,
    height,
    sourcePath: burnSource,
    outputPath
  });
  await rm(outputPath, { force: true });
  await runProcess({
    executable: ffmpegPath,
    args,
    cwd: input.stage.workdir,
    signal: input.stage.signal
  });
  if (!await isNonEmptyFile(outputPath)) {
    throw new KrillinCliError('render_video_failed', 'Hardsub pre-process did not produce a video');
  }
  reportHardsub({
    percent: 4,
    hardsubMode: mode,
    hardsubBand: { ...band },
    hardsubDetected: detected,
    message: `Đã xử lý vùng phụ đề in sẵn (hardsub) ở dải ${band.topPercent}%–${band.bottomPercent}% chiều cao từ mép đáy`
  });
  // Hoán video đã xử lý vào mọi artifact video sẽ được burn/đọc ở bước render
  // (source_video cho burn thường + recovery, dubbed_video khi burn trên bản lồng tiếng).
  return input.artifacts.map(artifact => (
    artifact.kind === 'source_video' || artifact.kind === 'dubbed_video'
      ? { ...artifact, path: outputPath }
      : artifact
  ));
}

export function stageConfig(
  source: CreatorServicesConfig,
  stageId: string,
  options: Record<string, unknown>,
  ttsOverride?: KrillinTtsGatewayConfig
): CreatorServicesConfig {
  // `render-horizontal`/`render-vertical` cũng tự sinh giọng khi lồng tiếng, nên phải
  // nhận cùng cổng TTS cục bộ; nếu không chúng sẽ gọi thẳng nhà cung cấp ngoài.
  const speechCapable = stageId === 'tts'
    || stageId === 'render-horizontal'
    || stageId === 'render-vertical';
  if (!speechCapable) return source;
  const config = structuredClone(source);
  if (ttsOverride !== undefined) {
    config.tts.provider = 'openai';
    config.tts.openai.baseUrl = ttsOverride.baseUrl;
    config.tts.openai.apiKey = ttsOverride.apiKey;
    config.tts.openai.model = ttsOverride.model;
    config.tts.openai.defaultVoiceId = ttsOverride.defaultVoiceId;
    return config;
  }
  if (stageId !== 'tts') return source;
  const provider = stringOption(options, 'ttsProvider');
  if (
    provider !== 'openai'
    && provider !== 'aliyun'
    && provider !== 'minimax'
    && provider !== 'edge-tts'
    && provider !== 'volcengine'
  ) return source;
  config.tts.provider = provider;
  if (provider !== 'edge-tts') {
    const model = stringOption(options, 'ttsModel');
    if (model) config.tts[provider].model = model;
  }
  return config;
}

export const cliRenderCapabilitiesCache = new Map<string, boolean>();

export function cliSupportsRenderLineMode(executablePath: string): boolean {
  const cached = cliRenderCapabilitiesCache.get(executablePath);
  if (cached !== undefined) return cached;
  try {
    const result = spawnSync(executablePath, ['render-horizontal', '--help'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    });
    const supported = result.stdout?.includes('--line-mode') === true;
    cliRenderCapabilitiesCache.set(executablePath, supported);
    return supported;
  } catch {
    cliRenderCapabilitiesCache.set(executablePath, false);
    return false;
  }
}

export function buildKrillinCliCommandArguments(
  stage: CreatorExecutorInput,
  artifacts: MaterializedKrillinArtifact[],
  options: Record<string, unknown>,
  stylePath: string | undefined,
  sourceOverride?: string,
  supportsRenderLineMode: boolean = true
): string[] {
  const command = krillinCliStageId(stage.stageRun.stageId);
  const common = ['--workdir', stage.workdir, '--task-id', stage.stageRun.id];
  const sourceUrl = stringOption(options, 'sourceUrl');
  const mediaCache = sourceUrl ? ['--media-workdir', join(dirname(stage.workdir), 'source-media', createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16))] : [];
  if (command === 'subtitle') {
    const source = sourceOverride ?? resolveKrillinCliSource(artifacts, options);
    if (!source) throw new CreatorExecutorError('creator_stage_input_missing', 'Subtitle input video or URL is required');
    const sourceOnly = booleanOption(options, 'sourceOnly', false);
    const importedTarget = artifactPath(artifacts, 'target_subtitle');
    const importedSource = artifactPath(artifacts, 'source_subtitle');
    const imported = importedTarget ?? importedSource;
    return [
      'subtitle',
      source,
      ...(!sourceOnly && booleanOption(options, 'prepareVideo', true) ? ['--prepare-video'] : []),
      '--origin-lang', requiredOption(options, 'originLanguage'),
      '--target-lang', requiredOption(options, 'targetLanguage'),
      '--caption-source', stringOption(options, 'captionSource') ?? 'any',
      ...(sourceOnly ? ['--source-only'] : []),
      ...(imported ? ['--input-srt', imported, `--srt-translated=${importedTarget !== undefined}`] : []),
      `--bilingual-top=${booleanOption(options, 'bilingualTop', true)}`,
      ...common,
      ...styleArgument(stylePath)
    ];
  }
  if (command === 'tts') {
    const target = artifactPath(artifacts, 'target_subtitle');
    const bilingual = artifactPath(artifacts, 'bilingual_subtitle');
    const subtitle = target ?? bilingual;
    if (!subtitle) throw new CreatorExecutorError('creator_stage_input_missing', 'TTS subtitle input is required');
    const lineMode = target
      ? 'target-only'
      : booleanOption(options, 'bilingualTop', true)
        ? 'bilingual-target-top'
        : 'bilingual-target-bottom';
    const video = artifactPath(artifacts, 'source_video');
    const voice = stringOption(options, 'voiceCode');
    return [
      'tts',
      ...common,
      '--input-srt', subtitle,
      '--line-mode', lineMode,
      ...mediaCache,
      ...(booleanOption(options, 'audioOnly', false) ? ['--audio-only'] : []),
      ...(!video && !booleanOption(options, 'audioOnly', false) ? optionalArgument('--source-url', stringOption(options, 'sourceUrl')) : []),
      ...(video ? ['--video', video] : []),
      ...(voice ? ['--voice', voice] : [])
    ];
  }
  if (command === 'render-horizontal' || command === 'render-vertical') {
    const sourceVideo = artifactPath(artifacts, 'source_video');
    const dubbedVideo = artifactPath(artifacts, 'dubbed_video');
    const dubbedAudio = artifactPath(artifacts, 'dubbed_audio');
    const dubbed = booleanOption(options, 'dubbed', false);
    if (dubbed && !dubbedVideo && !dubbedAudio) {
      throw new CreatorExecutorError(
        'krillin_dubbed_video_missing',
        'Generate the dubbed video before rendering a dubbed output'
      );
    }
    const video = dubbed ? dubbedVideo ?? sourceVideo : sourceVideo;
    const vertical = artifactPath(artifacts, 'vertical_subtitle');
    const target = artifactPath(artifacts, 'target_subtitle');
    const bilingual = artifactPath(artifacts, 'bilingual_subtitle');
    const subtitle = command === 'render-vertical'
      ? vertical ?? (booleanOption(options, 'bilingual', false) ? bilingual ?? target : target ?? bilingual)
      : booleanOption(options, 'bilingual', false) && bilingual
        ? bilingual
        : target ?? bilingual;
    if ((!video && !sourceUrl) || !subtitle) {
      throw new CreatorExecutorError('creator_stage_input_missing', 'Render video and subtitle inputs are required');
    }
    const lineModeArgs = supportsRenderLineMode
      ? [
          '--line-mode', subtitle === bilingual || subtitle === vertical
            ? booleanOption(options, 'bilingualTop', true) ? 'bilingual-target-top' : 'bilingual-target-bottom'
            : 'target-only',
          ...(subtitle === vertical && target ? ['--mixed-target-subtitle', target] : []),
          ...(!booleanOption(options, 'bilingual', false) && subtitle !== target ? ['--target-only'] : [])
        ]
      : [];
    return [
      command,
      ...common,
      ...mediaCache,
      ...(video ? ['--video', video] : ['--source-url', sourceUrl!]),
      '--subtitle', subtitle,
      ...lineModeArgs,
      ...(dubbed && !dubbedVideo && dubbedAudio ? ['--audio', dubbedAudio] : []),
      ...(dubbed ? ['--dubbed'] : []),
      ...(command === 'render-vertical'
        ? [
            ...optionalArgument('--major-title', stringOption(options, 'verticalTitle')),
            ...optionalArgument('--minor-title', stringOption(options, 'verticalSubtitle'))
          ]
        : []),
      ...styleArgument(stylePath)
    ];
  }
  throw new CreatorExecutorError('creator_stage_not_supported', `Unsupported KrillinAI stage ${command}`);
}

async function writeInitialManifest(
  stage: CreatorExecutorInput,
  options: Record<string, unknown>
): Promise<void> {
  await writeFile(join(stage.workdir, 'krillinai_manifest.json'), `${JSON.stringify({
    task_id: stage.stageRun.id,
    workdir: stage.workdir,
    origin_language: stringOption(options, 'originLanguage') ?? '',
    target_language: stringOption(options, 'targetLanguage') ?? '',
    provider: {},
    outputs: {},
    stages: {}
  }, null, 2)}\n`, { mode: 0o600 });
}

function executeCli(input: {
  executable: string;
  args: string[];
  cwd: string;
  runtimeBin: string;
  resourceRoot: string;
  dependencyBin: string;
  ytDlpRuntime?: YtDlpRuntime;
  reportProgress(progress: Record<string, CreatorJson>): void;
  signal: AbortSignal;
}): Promise<KrillinCliResponse> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnCreatorProcess(input.executable, input.args, {
      cwd: input.cwd,
      env: createKrillinCliEnvironment(
        process.env,
        input.runtimeBin,
        input.resourceRoot,
        input.dependencyBin,
        input.ytDlpRuntime
      ),
      stdio: ['ignore', 'pipe', 'pipe']
    }, input.signal);
    let stdout = '';
    let stderr = '';
    let pendingStdoutLine = '';
    child.stdout?.on('data', chunk => {
      const value = String(chunk);
      stdout = boundedAppend(stdout, value);
      pendingStdoutLine = consumeProgressLines(
        pendingStdoutLine + value,
        input.reportProgress
      );
    });
    child.stderr?.on('data', chunk => { stderr = boundedAppend(stderr, String(chunk)); });
    child.once('error', reject);
    child.once('exit', code => {
      if (input.signal.aborted) {
        reject(new CreatorExecutorError('creator_stage_canceled', 'Creator stage was canceled'));
        return;
      }
      reportProgressLine(pendingStdoutLine, input.reportProgress);
      const response = parseResponse(stdout);
      if (response === undefined) {
        reject(new KrillinCliError(
          'krillin_cli_failed',
          redact(stderr || `KrillinAI CLI exited with code ${code ?? 'unknown'}`)
        ));
        return;
      }
      if (response.ok !== true || code !== 0) {
        const errorMsg = response.error?.message ?? stderr;
        if (
          typeof errorMsg === 'string'
          && (
            errorMsg.includes('flag provided but not defined: -line-mode')
            || errorMsg.includes('flag provided but not defined: -preview-width')
            || errorMsg.includes('flag provided but not defined: -preview-height')
            || errorMsg.includes('flag provided but not defined: -mixed-target-subtitle')
            || errorMsg.includes('flag provided but not defined: -target-only')
          )
        ) {
          const filteredArgs: string[] = [];
          for (let i = 0; i < input.args.length; i++) {
            const arg = input.args[i];
            if (arg === undefined) continue;
            if (arg === '--line-mode' || arg === '--preview-width' || arg === '--preview-height' || arg === '--mixed-target-subtitle') {
              i++;
            } else if (arg === '--target-only') {
              // skip flag without value
            } else {
              filteredArgs.push(arg);
            }
          }
          if (filteredArgs.length < input.args.length) {
            void executeCli({
              ...input,
              args: filteredArgs
            }).then(resolvePromise, reject);
            return;
          }
        }
        reject(new KrillinCliError(
          response.error?.code ?? 'krillin_cli_failed',
          redact(response.error?.message ?? (stderr || 'KrillinAI CLI failed')),
          response.error?.kind,
          response.error?.retryable === true
        ));
        return;
      }
      resolvePromise(response);
    });
  });
}

async function collectArtifacts(
  input: RunKrillinCliInput,
  response: KrillinCliResponse
): Promise<KrillinResultArtifact[]> {
  const mappings = outputMappings(input.stage.stageRun.stageId);
  const result: KrillinResultArtifact[] = [];
  const jobRoot = await realpath(resolve(input.jobsRoot, input.stage.job.id));
  for (const [field, kind] of mappings) {
    if (kind === 'source_video' && input.stage.stageRun.stageId !== 'subtitle' && input.artifacts.some(artifact => artifact.kind === 'source_video')) continue;
    const reported = response.outputs?.[field];
    if (!reported) continue;
    const candidate = isAbsolute(reported) ? reported : resolve(input.stage.workdir, reported);
    let path;
    try {
      path = await realpath(candidate);
    } catch {
      continue;
    }
    if (!isInside(jobRoot, path)) {
      throw new CreatorExecutorError('krillin_output_escape', `KrillinAI output escapes the current Job root: ${field}`);
    }
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) continue;
    result.push({
      id: `${input.stage.stageRun.id}:${kind}`,
      kind,
      relativePath: relative(input.jobsRoot, path).replaceAll('\\', '/'),
      mimeType: mimeType(path),
      size: info.size,
      sha256: await sha256CreatorFile(path, input.stage.signal)
    });
  }
  return result;
}

export function outputMappings(stageId: string): Array<[string, string]> {  if (stageId === 'source-transcript') return [['origin_srt', 'source_subtitle']];
  if (stageId === 'narration') return [['tts_audio', 'narration_audio']];
  if (stageId === 'subtitles') return [['bilingual_srt', 'bilingual_subtitle']];
  if (stageId === 'bilingual-render') return [['horizontal_video', 'bilingual_video']];
  if (stageId === 'subtitle') {
    return [
      ['origin_video', 'source_video'],
      ['origin_srt', 'source_subtitle'],
      ['target_srt', 'target_subtitle'],
      ['bilingual_srt', 'bilingual_subtitle'],
      ['short_origin_mixed_srt', 'vertical_subtitle']
    ];
  }
  if (stageId === 'tts') return [['origin_video', 'source_video'], ['tts_audio', 'dubbed_audio'], ['video_with_tts', 'dubbed_video']];
  if (stageId === 'render-horizontal') return [['origin_video', 'source_video'], ['horizontal_video', 'horizontal_video']];
  if (stageId === 'render-vertical') return [['origin_video', 'source_video'], ['vertical_video', 'vertical_video']];
  return [];
}

/**
 * Khôi phục nhạc nền sau giai đoạn lồng tiếng (tts): tách giọng/video gốc bằng
 * model MDX-Net, ghép stem nhạc nền (âm lượng theo cấu hình `bgmRetention`,
 * mặc định 80%) với audio lồng tiếng, rồi ghi đè lại artifact dubbed_video /
 * dubbed_audio. Pipeline không bao giờ bị chặn nếu phần tách giọng lỗi.
 */
async function restoreBackgroundMusicForDubbedStage(
  input: RunKrillinCliInput,
  artifacts: KrillinResultArtifact[]
): Promise<KrillinResultArtifact[]> {
  if (input.stage.stageRun.stageId !== 'tts') return artifacts;
  const settings = resolveBackgroundMusicSettings(input.options);
  if (!settings.enabled) return artifacts;
  const dubbedAudio = artifacts.find(entry => entry.kind === 'dubbed_audio');
  const dubbedVideo = artifacts.find(entry => entry.kind === 'dubbed_video');
  if (dubbedAudio === undefined) return artifacts;
  const sourceVideoPath = input.artifacts.find(entry => entry.kind === 'source_video')?.path
    ?? (dubbedVideo === undefined ? undefined : resolve(input.jobsRoot, dubbedVideo.relativePath));
  if (sourceVideoPath === undefined) return artifacts;
  const ffmpeg = input.manifest.resources.find(resource => (
    resource.kind === 'executable'
    && /(?:^|\/)ffmpeg(?:\.exe)?$/i.test(resource.path)
  ));
  if (ffmpeg === undefined) return artifacts;
  const ffmpegPath = resolveInside(input.resourceRoot, ffmpeg.path);
  const ffprobe = input.manifest.resources.find(resource => (
    resource.kind === 'executable'
    && /(?:^|\/)ffprobe(?:\.exe)?$/i.test(resource.path)
  ));
  const ffprobePath = ffprobe === undefined ? undefined : resolveInside(input.resourceRoot, ffprobe.path);

  const reportLocal = (progress: Record<string, unknown>) => input.stage.reportProgress({
    krillinMode: 'local-audio',
    providerStatus: 'running',
    ...progress
  });
  reportLocal({
    phase: 'bgm_restore',
    percent: 8,
    message: 'Đang khôi phục nhạc nền (tách giọng bằng model MDX-Net)'
  });

  const tmpDir = join(input.stage.workdir, `.bgm-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  try {
    await ensureSeparationRuntime({
      root: resolveSeparationRuntimeRoot(),
      reportProgress: reportLocal,
      signal: input.stage.signal
    });
    const separationLayout = {
      separatorExe: join(resolveSeparationRuntimeRoot(), 'python', 'Scripts', 'audio-separator.exe'),
      modelsDir: join(resolveSeparationRuntimeRoot(), 'models')
    };
    const audioPath = await extractSourceAudio({
      ffmpegPath,
      videoPath: sourceVideoPath,
      outputPath: join(tmpDir, 'source-audio.wav'),
      signal: input.stage.signal
    });
    const stems = await separateBackgroundStem({
      separatorExe: separationLayout.separatorExe,
      modelsDir: separationLayout.modelsDir,
      audioPath,
      outputDir: join(tmpDir, 'stems'),
      reportProgress: reportLocal,
      signal: input.stage.signal
    });
    const mixedPath = join(tmpDir, 'dubbed-with-bgm.wav');
    const dubAudioPath = resolve(input.jobsRoot, dubbedAudio.relativePath);
    await mixDubVoiceWithBackground({
      ffmpegPath,
      backgroundPath: stems.instrumentalPath,
      dubAudioPath,
      outputPath: mixedPath,
      retention: settings.retention,
      signal: input.stage.signal
    });
    const updated = [...artifacts];
    if (dubbedVideo !== undefined) {
      const dubbedVideoPath = resolve(input.jobsRoot, dubbedVideo.relativePath);
      await replaceDubbedVideoAudio({
        ffmpegPath,
        ffprobePath,
        dubbedVideoPath,
        mixedAudioPath: mixedPath,
        reportProgress: reportLocal,
        signal: input.stage.signal
      });
      const videoIndex = updated.findIndex(entry => entry.kind === 'dubbed_video');
      const videoArtifact = updated[videoIndex];
      if (videoArtifact !== undefined) {
        const info = await stat(dubbedVideoPath);
        updated[videoIndex] = {
          ...videoArtifact,
          size: info.size,
          sha256: await sha256CreatorFile(dubbedVideoPath, input.stage.signal)
        };
      }
    }
    await copyFile(mixedPath, dubAudioPath);
    const audioIndex = updated.findIndex(entry => entry.kind === 'dubbed_audio');
    const audioArtifact = updated[audioIndex];
    if (audioArtifact !== undefined) {
      const info = await stat(dubAudioPath);
      updated[audioIndex] = {
        ...audioArtifact,
        size: info.size,
        sha256: await sha256CreatorFile(dubAudioPath, input.stage.signal)
      };
    }
    return updated;
  } catch (error) {
    reportLocal({
      phase: 'bgm_restore_skipped',
      percent: 100,
      bgmRestoreWarning: error instanceof Error ? error.message : String(error)
    });
    return artifacts;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function krillinCliStageId(stageId: string): string {  if (stageId === 'source-transcript' || stageId === 'subtitles') return 'subtitle';
  if (stageId === 'narration') return 'tts';
  if (stageId === 'bilingual-render') return 'render-horizontal';
  return stageId;
}

export function createKrillinCliEnvironment(
  env: NodeJS.ProcessEnv,
  runtimeBin: string,
  resourceRoot: string,
  dependencyBin: string,
  ytDlpRuntime?: YtDlpRuntime
): NodeJS.ProcessEnv {
  const names = process.platform === 'win32'
    ? ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']
    : ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  const runtimePaths = ytDlpRuntime === undefined
    ? []
    : [dirname(ytDlpRuntime.executable)];
  const executablePath = process.platform === 'win32'
    ? [dependencyBin, ...runtimePaths, runtimeBin].join(delimiter)
    : [dependencyBin, ...runtimePaths, runtimeBin, '/usr/bin', '/bin'].join(delimiter);
  return {
    ...Object.fromEntries(names.flatMap(name => env[name] === undefined ? [] : [[name, env[name]]])),
    ...ytDlpRuntime?.env,
    ...(process.platform === 'win32' && ytDlpRuntime !== undefined && ytDlpRuntime.prefixArgs.length > 0
      ? { OPENCREATOR_YT_DLP_COMMAND: JSON.stringify([ytDlpRuntime.executable, ...ytDlpRuntime.prefixArgs]) }
      : {}),
    PATH: executablePath,
    Path: executablePath,
    KRILLINAI_RESOURCE_ROOT: resourceRoot,
    KRILLINAI_OFFLINE_DEPENDENCIES: '1',
    OPENCREATOR_KRILLINAI_CLI: '1',
    ...(ytDlpRuntime === undefined
      ? {}
      : {
          KRILLINAI_YT_DLP_EXECUTABLE: ytDlpRuntime.executable,
          KRILLINAI_YT_DLP_PREFIX_ARGS: JSON.stringify(ytDlpRuntime.prefixArgs)
        })
  };
}

function consumeProgressLines(
  value: string,
  reportProgress: (progress: Record<string, CreatorJson>) => void
): string {
  const lines = value.split(/\r?\n/);
  const pending = lines.pop() ?? '';
  for (const line of lines) reportProgressLine(line, reportProgress);
  return pending.length <= 1024 * 1024 ? pending : pending.slice(-1024 * 1024);
}

function reportProgressLine(
  line: string,
  reportProgress: (progress: Record<string, CreatorJson>) => void
): void {
  const frame = parseKrillinCliProgressFrame(line);
  if (frame === undefined) return;
  const payload: Record<string, CreatorJson> = { percent: frame.percent };
  if (frame.phase !== undefined) payload.phase = frame.phase;
  if (frame.message !== undefined) payload.message = frame.message;
  reportProgress({
    krillinMode: 'cli',
    providerStatus: 'running',
    percent: frame.percent,
    ...(frame.phase === undefined ? {} : { phase: frame.phase }),
    ...(frame.message === undefined ? {} : { message: frame.message }),
    krillinEventPayload: payload
  });
}

export function parseKrillinCliProgressFrame(line: string): KrillinCliProgressFrame | undefined {
  const value = line.trim();
  if (!value.startsWith('{') || !value.endsWith('}')) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.type !== 'progress' || typeof parsed.percent !== 'number' || !Number.isFinite(parsed.percent)) {
      return undefined;
    }
    const phase = typeof parsed.phase === 'string' && parsed.phase.trim()
      ? parsed.phase.trim()
      : undefined;
    const message = typeof parsed.message === 'string' && parsed.message.trim()
      ? parsed.message.trim()
      : undefined;
    return {
      type: 'progress',
      percent: Math.max(0, Math.min(99, Math.round(parsed.percent))),
      ...(phase === undefined ? {} : { phase }),
      ...(message === undefined ? {} : { message })
    };
  } catch {
    return undefined;
  }
}

export async function prepareCliResourceRoot(input: {
  resourceRoot: string;
  dependencyRoot: string;
  launcherRoot: string;
  onDemandTranscriptionProvider?: 'whisperkit' | 'whisper.cpp';
  onDemandTranscriptionModel?: 'tiny' | 'medium' | 'large-v2' | 'large-v3-turbo';
  useOnDemandTranscription?: boolean;
  useWhisperCpp?: boolean;
  ytDlpRuntime?: YtDlpRuntime;
}): Promise<string> {
  const dependencyBin = join(input.dependencyRoot, 'bin');
  const dependencyModels = join(input.dependencyRoot, 'models');
  await mkdir(dependencyBin, { recursive: true });
  await mkdir(dependencyModels, { recursive: true });
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  if (input.onDemandTranscriptionProvider === 'whisper.cpp') {
    const model = input.onDemandTranscriptionModel;
    if (model === undefined) {
      throw new CreatorExecutorError(
        'creator_transcription_config_missing',
        'Whisper.cpp model selection is required'
      );
    }
    const sourceModels = join(dependencyModels, 'whispercpp');
    const mountedModels = join(input.launcherRoot, 'models', 'whispercpp');
    await mkdir(mountedModels, { recursive: true });
    if (!await isDirectory(sourceModels)) {
      throw new CreatorExecutorError(
        'dependency_not_packaged',
        'Whisper.cpp model directory is missing. Install a transcription model in Settings and retry.'
      );
    }
    await linkDirectoryEntries(sourceModels, mountedModels);
    // KrillinAI 2.1 still loads the legacy `ggml-large-v2.bin` name unless
    // large-v3-turbo is selected. Source that name from whatever model file is
    // actually installed so a configured model that failed to download (for
    // example while offline) does not abort the stage with ENOENT.
    if (model !== 'large-v3-turbo') {
      const sourceModel = await resolveWhisperCppModelFile(sourceModels, model);
      if (sourceModel === undefined) {
        throw new CreatorExecutorError(
          'dependency_not_packaged',
          `Whisper.cpp ${model} model is not installed. Install a transcription model in Settings and retry.`
        );
      }
      await linkFile(sourceModel, join(mountedModels, 'ggml-large-v2.bin'), true);
    }
  } else {
    await symlink(dependencyModels, join(input.launcherRoot, 'models'), type);
  }
  const overlayBin = join(input.launcherRoot, 'bin');
  await mkdir(overlayBin, { recursive: true });
  await linkDirectoryEntries(join(input.resourceRoot, 'bin'), overlayBin);
  const sourceFonts = join(input.resourceRoot, 'fonts');
  try {
    if ((await stat(sourceFonts)).isDirectory()) {
      const overlayFonts = join(input.launcherRoot, 'fonts');
      await mkdir(overlayFonts, { recursive: true });
      await linkDirectoryEntries(sourceFonts, overlayFonts);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (input.useWhisperCpp === true && input.onDemandTranscriptionProvider === undefined) {
    await linkDirectoryEntries(join(dependencyBin, 'whispercpp'), overlayBin);
  }
  if (input.ytDlpRuntime !== undefined) {
    const ytDlpName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    await installYtDlpCommand(
      input.ytDlpRuntime,
      join(overlayBin, ytDlpName)
    );
  }
  if (
    input.onDemandTranscriptionProvider === 'whisperkit'
    || input.useOnDemandTranscription === true
  ) {
    const whisperKitName = process.platform === 'win32' ? 'whisperkit-cli.exe' : 'whisperkit-cli';
    await linkFile(
      join(dependencyBin, whisperKitName),
      join(overlayBin, whisperKitName)
    );
  } else if (input.onDemandTranscriptionProvider === 'whisper.cpp') {
    await linkDirectory(
      join(dependencyBin, 'whispercpp'),
      join(overlayBin, 'whispercpp')
    );
    await linkDirectoryEntries(join(dependencyBin, 'whispercpp'), overlayBin);
  }
  return input.launcherRoot;
}

export async function recoverWindowsHorizontalAssRender(input: {
  platform: NodeJS.Platform;
  resourceRoot: string;
  manifest: KrillinRuntimeManifest;
  stageId: string;
  workdir: string;
  artifacts: MaterializedKrillinArtifact[];
  signal: AbortSignal;
  error: unknown;
  reportProgress(progress: Record<string, CreatorJson>): void;
  runProcess?: RunProcess;
}): Promise<KrillinCliResponse | undefined> {
  if (!isWindowsHorizontalAssPathFailure(input)) return undefined;
  const sourceVideo = artifactPath(input.artifacts, 'source_video');
  const assName = 'formatted_horizontal_bilingual.ass';
  const assPath = join(input.workdir, assName);
  if (!sourceVideo || !await isNonEmptyFile(sourceVideo) || !await isNonEmptyFile(assPath)) {
    return undefined;
  }
  const ffmpeg = input.manifest.resources.find(resource => (
    resource.kind === 'executable'
    && /(?:^|\/)ffmpeg(?:\.exe)?$/i.test(resource.path)
  ));
  if (ffmpeg === undefined) return undefined;

  const outputPath = join(input.workdir, 'horizontal_bilingual.mp4');
  const temporaryPath = join(input.workdir, '.horizontal_bilingual.opencreator-recovery.mp4');
  const args = [
    '-y',
    '-i', sourceVideo,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', `ass=${assName}`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    temporaryPath
  ];
  await rm(outputPath, { force: true });
  await rm(temporaryPath, { force: true });
  input.reportProgress({
    krillinMode: 'cli',
    providerStatus: 'running',
    phase: 'rendering_subtitles',
    percent: 95,
    message: 'Rendering bilingual subtitles'
  });
  try {
    await (input.runProcess ?? runProcess)({
      executable: resolveInside(input.resourceRoot, ffmpeg.path),
      args,
      cwd: input.workdir,
      signal: input.signal
    });
    if (!await isNonEmptyFile(temporaryPath)) {
      throw new KrillinCliError(
        'render_video_failed',
        'Windows ASS compatibility render did not produce a video'
      );
    }
    await rename(temporaryPath, outputPath);
    await writeFile(join(input.workdir, 'opencreator-windows-ass-recovery.json'), `${JSON.stringify({
      schemaVersion: 1,
      reason: 'krillinai-2.1.0-windows-absolute-ass-path',
      cwd: input.workdir,
      inputVideo: sourceVideo,
      assFile: assName,
      outputVideo: outputPath,
      ffmpegArgs: args
    }, null, 2)}\n`);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (error instanceof CreatorExecutorError || error instanceof KrillinCliError) throw error;
    throw new KrillinCliError(
      'render_video_failed',
      `Windows ASS compatibility render failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    ok: true,
    stage: 'render-horizontal',
    outputs: { horizontal_video: outputPath },
    warnings: ['Recovered KrillinAI 2.1.0 Windows ASS path handling with a relative ASS filter path']
  };
}

function isWindowsHorizontalAssPathFailure(input: {
  platform: NodeJS.Platform;
  stageId: string;
  error: unknown;
}): boolean {
  if (
    input.platform !== 'win32'
    || input.stageId !== 'bilingual-render'
    || !(input.error instanceof KrillinCliError)
    || input.error.code !== 'render_video_failed'
  ) return false;
  return /Unable to parse option value[\s\S]*formatted_horizontal_bilingual\.ass[\s\S]*as image size/i
    .test(input.error.message)
    && /Error applying option ['"]?original_size['"]? to filter ['"]?ass['"]?/i
      .test(input.error.message);
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function runProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnCreatorProcess(input.executable, input.args, {
      cwd: input.cwd,
      stdio: ['ignore', 'ignore', 'pipe']
    }, input.signal);
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = boundedAppend(stderr, String(chunk)); });
    child.once('error', reject);
    child.once('exit', code => {
      if (input.signal.aborted) {
        reject(new CreatorExecutorError('creator_stage_canceled', 'Creator stage was canceled'));
        return;
      }
      if (code === 0) resolvePromise();
      else reject(new Error(redact(stderr || `FFmpeg exited with code ${code ?? 'unknown'}`)));
    });
  });
}

async function linkDirectoryEntries(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    await linkFile(join(source, entry.name), join(destination, entry.name));
  }
}

async function linkFile(
  source: string,
  target: string,
  preferWindowsHardlink = false
): Promise<void> {
  await rm(target, { force: true });
  if (process.platform !== 'win32') {
    await symlink(source, target);
    return;
  }
  if (!preferWindowsHardlink) {
    await copyFile(source, target);
    return;
  }
  try {
    await link(source, target);
  } catch (error) {
    if (!isWindowsLinkFallbackError(error)) throw error;
    await copyFile(source, target);
  }
}

async function resolveWhisperCppModelFile(
  sourceModels: string,
  model: 'tiny' | 'medium' | 'large-v2' | 'large-v3-turbo'
): Promise<string | undefined> {
  const preferred = join(sourceModels, `ggml-${model}.bin`);
  if (await isFile(preferred)) return preferred;
  // Fall back to any installed model, preferring larger (higher quality) files.
  for (const candidate of ['large-v3-turbo', 'large-v2', 'medium', 'tiny'] as const) {
    const path = join(sourceModels, `ggml-${candidate}.bin`);
    if (await isFile(path)) return path;
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function installYtDlpCommand(
  runtime: YtDlpRuntime,
  target: string
): Promise<void> {
  if (runtime.prefixArgs.length === 0) {
    await linkFile(runtime.executable, target);
    return;
  }
  if (process.platform === 'win32') {
    // Krillin executes the structured Python command supplied in its environment.
    await rm(target, { force: true });
    return;
  }

  await rm(target, { force: true });
  const command = [runtime.executable, ...runtime.prefixArgs]
    .map(quoteShellArgument)
    .join(' ');
  await writeFile(target, `#!/bin/sh\nexec ${command} "$@"\n`, {
    mode: 0o700
  });
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function removeLauncherRootBestEffort(launcherRoot: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(launcherRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isBusyCleanupError(error) || attempt === 7) return;
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

function isBusyCleanupError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false;
  return ['EBUSY', 'EPERM', 'EACCES'].includes(String(error.code));
}

function isWindowsLinkFallbackError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false;
  return ['EPERM', 'EACCES', 'EXDEV', 'ENOTSUP'].includes(String(error.code));
}

async function linkDirectory(source: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

function isOnDemandTranscriptionProvider(
  provider: CreatorServicesConfig['transcription']['provider']
): provider is 'whisperkit' | 'whisper.cpp' {
  return provider === 'whisperkit' || provider === 'whisper.cpp';
}

function parseResponse(stdout: string): KrillinCliResponse | undefined {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    const value = line.trim();
    if (!value.startsWith('{') || !value.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(value) as KrillinCliResponse;
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
}

function artifactPath(artifacts: MaterializedKrillinArtifact[], kind: string): string | undefined {
  return artifacts.find(artifact => artifact.kind === kind)?.path;
}

export function resolveKrillinCliSource(
  artifacts: MaterializedKrillinArtifact[],
  options: Record<string, unknown>
): string | undefined {
  const sourceUrl = stringOption(options, 'sourceUrl');
  const captionSource = stringOption(options, 'captionSource') ?? 'any';
  const hasImportedSubtitle = artifacts.some(artifact => artifact.kind === 'source_subtitle' || artifact.kind === 'target_subtitle');
  if (!hasImportedSubtitle && isYouTubeSource(sourceUrl) && captionSource !== 'whisper') {
    return sourceUrl;
  }
  const localSource = artifactPath(artifacts, 'source_video');
  return localSource === undefined ? sourceUrl : `local:${localSource}`;
}

function requiredOption(options: Record<string, unknown>, name: string): string {
  const value = stringOption(options, name);
  if (!value) throw new CreatorExecutorError('creator_stage_config_missing', `KrillinAI option ${name} is required`);
  return value;
}

function stringOption(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanOption(options: Record<string, unknown>, name: string, fallback: boolean): boolean {
  return typeof options[name] === 'boolean' ? options[name] as boolean : fallback;
}

function optionalArgument(flag: string, value: string | undefined): string[] {
  return value ? [flag, value] : [];
}

function styleArgument(path: string | undefined): string[] {
  return path ? ['--subtitle-style-file', path] : [];
}

function mimeType(path: string): string | undefined {
  const extension = basename(path).split('.').at(-1)?.toLowerCase();
  if (extension === 'srt') return 'application/x-subrip';
  if (extension === 'wav') return 'audio/wav';
  if (extension === 'mp3') return 'audio/mpeg';
  if (extension === 'mp4') return 'video/mp4';
  return undefined;
}

function isInside(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function boundedAppend(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= 4 * 1024 * 1024 ? combined : combined.slice(-4 * 1024 * 1024);
}

function redact(value: string): string {
  return value
    .replace(/(?:api[_-]?key|token|secret)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .trim()
    .slice(-4_000);
}
