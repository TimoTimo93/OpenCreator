import {
  isCreatorTtsProvider,
  smartDubbingStyles,
  type CreatorJson,
  type CreatorTtsProvider,
  type SmartDubbingFormat,
  type SmartDubbingStyle
} from '@opencreator/protocol';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  KrillinTtsServiceError,
  type KrillinTtsService
} from '../krillin/tts-service.js';
import { smartDubbingInstructions } from '../../smart-dubbing/styles.js';
import type { CreatorExecutor } from '../executor.js';
import { CreatorExecutorError } from '../executor.js';
import { edgeFallbackVoice } from '../krillin/tts-dubbing-provider.js';

export function createSmartDubbingExecutor(input: {
  ttsService: Pick<KrillinTtsService, 'synthesize'>;
  isOfficial?(): boolean;
  /**
   * Tổng hợp giọng cục bộ (VieNeu-TTS ưu tiên, rơi về Edge TTS). KrillinAI speech
   * utility không hỗ trợ edge-tts nên đường Edge phải đi qua bộ tổng hợp cục bộ.
   */
  synthesizeLocal?: (request: {
    text: string;
    voice: string;
    speed?: number;
  }) => Promise<{ audio: Buffer; format: 'mp3' | 'wav' }>;
}): CreatorExecutor {
  return {
    id: 'smart-dubbing',
    async run(stage) {
      stage.reportProgress({ phase: 'validating', percent: 5 });
      const request = readRequest(stage.job.state);
      const official = input.isOfficial?.() === true;
      if (official && (request.style !== 'natural' || request.speed !== 1)) throw new CreatorExecutorError('unsupported_capability', 'The official speech model supports only natural delivery and default speed');
      if (stage.signal.aborted) {
        throw new CreatorExecutorError('creator_stage_canceled', 'Creator stage was canceled');
      }
      stage.reportProgress({ phase: 'generating_voice', percent: 20 });
      try {
        let synthesis: {
          content: Buffer;
          mime: 'audio/mpeg' | 'audio/wav';
          provider: string;
          model: string;
          voiceId: string;
          format: 'mp3' | 'wav';
        };
        if (request.provider === 'edge-tts' && !official) {
          synthesis = await synthesizeLocalSpeech(input, request);
        } else {
          const provider = request.provider === 'edge-tts' ? undefined : request.provider;
          synthesis = await input.ttsService.synthesize({
            logicalId:stage.stageRun.id,
            text: request.text,
            ...(provider === undefined ? {} : { provider }),
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.voiceCode === undefined ? {} : { voiceId: request.voiceCode }),
            format: request.format,
            speed: request.speed,
            instructions: official ? undefined : smartDubbingInstructions(request.style),
            signal: stage.signal
          });
        }
        if (stage.signal.aborted) {
          throw new CreatorExecutorError('creator_stage_canceled', 'Creator stage was canceled');
        }
        stage.reportProgress({ phase: 'finalizing_output', percent: 90 });
        const fileName = `OpenCreator-dubbing.${synthesis.format}`;
        const path = join(stage.workdir, fileName);
        await writeFile(path, synthesis.content, { mode: 0o600 });
        const characterCount = [...request.text].length;
        return {
          outputs: [{
            kind: 'dubbed_audio',
            status: 'completed',
            path,
            metadata: {
              fileName,
              mime: synthesis.mime,
              bytes: synthesis.content.length,
              sha256: createHash('sha256').update(synthesis.content).digest('hex'),
              provider: synthesis.provider,
              model: synthesis.model,
              voiceCode: synthesis.voiceId,
              voiceName: request.voiceName ?? synthesis.voiceId,
              style: request.style,
              speed: request.speed,
              format: synthesis.format,
              characterCount,
              settingsSnapshot: stage.job.state
            }
          }],
          progress: {
            phase: 'completed',
            percent: 100,
            completed: 1,
            failed: 0,
            total: 1
          }
        };
      } catch (error) {
        if (stage.signal.aborted) {
          throw new CreatorExecutorError('creator_stage_canceled', 'Creator stage was canceled');
        }
        if (error instanceof CreatorExecutorError) throw error;
        if (error instanceof KrillinTtsServiceError) {
          const code = error.code === 'VALIDATION_FAILED'
            ? 'creator_stage_input_missing'
            : error.code;
          throw new CreatorExecutorError(code, error.message);
        }
        throw new CreatorExecutorError(
          'creator_tts_upstream_error',
          error instanceof Error ? error.message : 'Speech synthesis failed'
        );
      }
    }
  };
}

function readRequest(state: Record<string, CreatorJson>): {
  text: string;
  provider?: CreatorTtsProvider;
  model?: string;
  voiceCode?: string;
  voiceName?: string;
  style: SmartDubbingStyle;
  speed: number;
  format: SmartDubbingFormat;
} {
  const text = readString(state.text)?.trim() ?? '';
  if (!text || [...text].length > 5_000) {
    throw new CreatorExecutorError(
      'creator_stage_input_missing',
      'Dubbing text must contain between 1 and 5000 characters'
    );
  }
  const provider = readString(state.ttsProvider);
  if (provider !== undefined && !isCreatorTtsProvider(provider)) {
    throw new CreatorExecutorError(
      'creator_stage_input_missing',
      'The selected TTS provider is invalid'
    );
  }
  const style = readString(state.style) ?? 'natural';
  if (!(smartDubbingStyles as readonly string[]).includes(style)) {
    throw new CreatorExecutorError('creator_stage_input_missing', 'Dubbing style is invalid');
  }
  const speed = typeof state.speed === 'number' ? state.speed : 1;
  if (!Number.isFinite(speed) || speed < 0.75 || speed > 1.25) {
    throw new CreatorExecutorError('creator_stage_input_missing', 'Dubbing speed is invalid');
  }
  const format = state.format === 'wav' ? 'wav' : 'mp3';
  return {
    text,
    ...(provider === undefined
      ? {}
      : { provider: provider as CreatorTtsProvider }),
    ...(readString(state.ttsModel) === undefined ? {} : { model: readString(state.ttsModel) }),
    ...(readString(state.voiceCode) === undefined ? {} : { voiceCode: readString(state.voiceCode) }),
    ...(readString(state.voiceName) === undefined ? {} : { voiceName: readString(state.voiceName) }),
    style: style as SmartDubbingStyle,
    speed,
    format
  };
}

async function synthesizeLocalSpeech(
  input: {
    synthesizeLocal?: (request: {
      text: string;
      voice: string;
      speed?: number;
    }) => Promise<{ audio: Buffer; format: 'mp3' | 'wav' }>;
  },
  request: { text: string; voiceCode?: string; speed: number }
): Promise<{
  content: Buffer;
  mime: 'audio/mpeg' | 'audio/wav';
  provider: string;
  model: string;
  voiceId: string;
  format: 'mp3' | 'wav';
}> {
  if (input.synthesizeLocal === undefined) {
    throw new CreatorExecutorError(
      'creator_tts_config_missing',
      'Local Edge TTS synthesis is unavailable on this Runtime'
    );
  }
  const voice = edgeFallbackVoice(request.text, request.voiceCode ?? '');
  const result = await input.synthesizeLocal({
    text: request.text,
    voice,
    speed: request.speed
  });
  return {
    content: result.audio,
    mime: result.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    provider: 'edge-tts',
    model: '',
    voiceId: voice,
    format: result.format
  };
}

function readString(value: CreatorJson | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
