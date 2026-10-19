import { defaultVideoGenerationModels } from './media-generation.js';
import { publicErrorKindForCode, safePublicErrorMessage } from './errors.js';
import type { PublicErrorFacts } from './issues.js';

export type OpenAiCompatibleConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export const creatorTtsProviders = ['openai', 'aliyun', 'edge-tts', 'minimax', 'volcengine', 'elevenlabs', 'vieneu'] as const;
export type CreatorTtsProvider = (typeof creatorTtsProviders)[number];

export function isCreatorTtsProvider(value: unknown): value is CreatorTtsProvider {
  return creatorTtsProviders.some(provider => provider === value);
}

export type CreatorTtsProviderConfig = OpenAiCompatibleConfig & {
  defaultVoiceId: string;
};

export type ElevenLabsProviderConfig = {
  baseUrl: string;
  apiKeys: string[];
  model: string;
  defaultVoiceId: string;
};

export type VieNeuProviderConfig = {
  baseUrl: string;
  model: string;
  defaultVoiceId: string;
};

export type AgnesAiConfig = {
  baseUrl: string;
  apiKeys: string[];
  model: string;
};

/**
 * Doubao Voice / OpenSpeech console credentials.
 * ASR, TTS V1, and TTS V3 share this Access Token; only the wire names differ:
 * ASR and TTS V3 send `X-Api-Access-Key`, while TTS V1 sends
 * `Authorization: Bearer;<token>` and JSON `app.token`.
 */
export type VolcengineSpeechCredentials = {
  appId: string;
  accessToken: string;
};

export type VolcengineTtsConfig = VolcengineSpeechCredentials & {
  baseUrl: string;
  model: string;
  defaultVoiceId: string;
};

export type VolcengineAsrConfig = VolcengineSpeechCredentials & {
  resourceId: string;
  baseUrl: string;
};

export type CreatorTtsVoice = {
  id: string;
  name: string;
  provider: CreatorTtsProvider;
  language?: string;
  gender?: string;
  scenario?: string;
  kind?: 'builtin' | 'custom' | 'designed';
  supportedModels?: string[];
  recommended?: boolean;
};

export type CreatorTtsVoicesResponse = {
  provider: CreatorTtsProvider;
  model: string;
  voices: CreatorTtsVoice[];
};

export type CreatorTtsPreviewRequest = {
  provider: CreatorTtsProvider;
  model?: string;
  voiceId: string;
  text?: string;
};

export type KlingAiConfig = {
  baseUrl: string;
  accessKey: string;
  secretKey: string;
  model: string;
};

export type AliyunOssConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  endpoint: string;
};

export type AliyunSpeechConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  appKey: string;
};

export const creatorTranscriptionProviders = [
  'openai',
  'faster-whisper',
  'whisperkit',
  'whisper.cpp',
  'aliyun',
  'volcengine',
  'funasr'
] as const;
export type CreatorTranscriptionProvider = (typeof creatorTranscriptionProviders)[number];

export function isCreatorTranscriptionProvider(
  value: unknown
): value is CreatorTranscriptionProvider {
  return creatorTranscriptionProviders.some(provider => provider === value);
}

/**
 * Khóa API của gateway cục bộ (9router) chỉ là giá trị mặc định, không phải
 * thông tin đăng nhập thật. Các nhà cung cấp thật phải cấu hình khóa riêng.
 */
const placeholderGatewayApiKeys = new Set(['9router', '9router-local']);

export function hasValidOpenAiApiKey(apiKey: string | undefined): boolean {
  if (typeof apiKey !== 'string') return false;
  const trimmed = apiKey.trim();
  return trimmed.length > 0 && !placeholderGatewayApiKeys.has(trimmed);
}

export function hasValidOpenAiTranscriptionApiKey(apiKey: string | undefined): boolean {
  return hasValidOpenAiApiKey(apiKey);
}

export function resolveEffectiveTranscriptionProvider(
  transcription: CreatorServicesConfig['transcription'],
  officialModel?: string,
  platform: NodeJS.Platform = typeof process !== 'undefined' ? process.platform : 'win32',
  arch: string = typeof process !== 'undefined' ? process.arch : 'x64'
): CreatorTranscriptionProvider {
  if (officialModel) return 'openai';
  if (transcription.provider === 'openai') {
    if (hasValidOpenAiTranscriptionApiKey(transcription.openai.apiKey)) {
      return 'openai';
    }
    if (platform === 'darwin' && arch === 'arm64') return 'whisperkit';
    if (platform === 'win32' && arch === 'x64') return 'whisper.cpp';
    return 'whisper.cpp';
  }
  return transcription.provider;
}

export type CreatorServicesConfig = {
  proxy: string;
  /**
   * Thư mục gốc lưu video sau khi tải về (Trình tải video). Rỗng = dùng mặc định
   * Documents/OpenCreator; giá trị không hợp lệ sẽ bị bỏ kèm cảnh báo log.
   */
  downloadRoot: string;
  llm: OpenAiCompatibleConfig & {
    jsonMode: boolean;
    source: 'codex' | 'custom' | 'agnes';
    agnesAi?: AgnesAiConfig;
    failoverToAgnes?: boolean;
  };
  transcription: {
    provider: CreatorTranscriptionProvider;
    enableGpuAcceleration: boolean;
    openai: OpenAiCompatibleConfig;
    fasterWhisper: { model: 'tiny' | 'medium' | 'large-v2' };
    whisperKit: { model: 'large-v2' };
    whisperCpp: { model: 'tiny' | 'medium' | 'large-v2' | 'large-v3-turbo' };
    aliyun: {
      oss: AliyunOssConfig;
      speech: AliyunSpeechConfig;
    };
    volcengine: VolcengineAsrConfig;
    funasr: OpenAiCompatibleConfig & { timeoutMs: number };
  };
  tts: {
    provider: CreatorTtsProvider;
    openai: CreatorTtsProviderConfig;
    minimax: CreatorTtsProviderConfig;
    aliyun: CreatorTtsProviderConfig;
    volcengine: VolcengineTtsConfig;
    elevenlabs?: ElevenLabsProviderConfig;
    vieneu?: VieNeuProviderConfig;
  };
  image: {
    provider: 'openai' | 'jimeng' | 'kling' | 'gemini' | 'codex-native';
    openai: OpenAiCompatibleConfig;
    jimeng: OpenAiCompatibleConfig;
    kling: KlingAiConfig;
    gemini: OpenAiCompatibleConfig;
    codexNative: Record<never, never>;
  };
  video: {
    provider: 'seedance' | 'kling' | 'veo';
    seedance: OpenAiCompatibleConfig;
    kling: KlingAiConfig;
    veo: OpenAiCompatibleConfig;
  };
};

export type CreatorServicesConfigResponse = {
  config: CreatorServicesConfig;
  configuredCredentials: CreatorServicesCredentialField[];
};

export type CreatorTranscriptionProviderCapability = {
  provider: CreatorTranscriptionProvider;
  kind: 'cloud' | 'local';
  available: boolean;
  models: string[];
  modelDetails?: Record<string, { diskBytes: number }>;
  gpuAcceleration: boolean;
  unavailableReason?: 'unsupported_platform' | 'installer_unavailable';
};

export type CreatorServicesCapabilitiesResponse = {
  platform: string;
  arch: string;
  transcription: {
    providers: CreatorTranscriptionProviderCapability[];
  };
};

export type CodexImageStatus = {
  authentication: 'api_key' | 'chatgpt' | 'none';
  ready: boolean;
  executionMode: 'api' | 'native' | null;
  message: string;
  model?: string;
  version?: string;
};

export type CreatorPreflightExecutionMode = 'local' | 'remote' | 'mixed';

export type CreatorPreflightRepair = {
  label: string;
  deepLink?: string;
  capability?: string;
};

export type CreatorPreflightCheck = {
  id: string;
  title: string;
  message: string;
  executionMode: CreatorPreflightExecutionMode;
  repair?: CreatorPreflightRepair;
};

export type CreatorPreflightResponse = {
  templateId: string;
  templateVersion: number;
  stageId: string;
  executionMode: CreatorPreflightExecutionMode;
  canStart: boolean;
  ready: CreatorPreflightCheck[];
  warning: CreatorPreflightCheck[];
  blocked: Array<CreatorPreflightCheck & { repair: CreatorPreflightRepair }>;
  checkedAt: string;
};

/** Keep client-side and daemon-side preflight failures identical. */
export function creatorPreflightFailure(result: CreatorPreflightResponse): {
  code: string; message: string; publicFacts: PublicErrorFacts;
} {
  const codes: Record<string, string> = {
    'reference-image-required': 'creator_stage_input_missing',
    llm: 'creator_llm_config_missing',
    tts: 'creator_tts_config_missing',
    'image-provider': 'creator_image_config_missing',
    'video-provider': 'VIDEO_GENERATION_CONFIG_REQUIRED',
    'reference-image-capability': 'unsupported_capability',
    'transcription-config': 'creator_transcription_config_missing',
    'input-file': 'creator_stage_input_missing',
    'managed-directory': 'creator_storage_failed'
  };
  const id = Object.keys(codes).find(id => result.blocked.some(item => item.id === id));
  const code = id === undefined ? 'creator_preflight_blocked' : codes[id]!;
  const message = safePublicErrorMessage(result.blocked.map(item => item.message).join('; '))
    ?? 'Preflight checks failed. Review the task configuration.';
  return { code, message, publicFacts: {
    kind: publicErrorKindForCode(code) ?? 'validation', upstreamMessage: message,
    ...(id === 'reference-image-required' ? { upstreamCode: 'IMAGE_REFERENCE_MISSING' } : {})
  } };
}

export type CreatorServicesCredentialField =
  | 'llm.apiKey'
  | 'transcription.openai.apiKey'
  | 'transcription.aliyun.oss.accessKeyId'
  | 'transcription.aliyun.oss.accessKeySecret'
  | 'transcription.aliyun.speech.accessKeyId'
  | 'transcription.aliyun.speech.accessKeySecret'
  | 'transcription.aliyun.speech.appKey'
  | 'transcription.volcengine.appId'
  | 'transcription.volcengine.accessToken'
  | 'transcription.funasr.apiKey'
  | 'tts.openai.apiKey'
  | 'tts.minimax.apiKey'
  | 'tts.aliyun.apiKey'
  | 'tts.volcengine.appId'
  | 'tts.volcengine.accessToken'
  | 'image.openai.apiKey'
  | 'image.jimeng.apiKey'
  | 'image.kling.accessKey'
  | 'image.kling.secretKey'
  | 'image.gemini.apiKey'
  | 'video.seedance.apiKey'
  | 'video.kling.accessKey'
  | 'video.kling.secretKey'
  | 'video.veo.apiKey';

export const defaultVolcengineSpeechBaseUrl = 'https://openspeech.bytedance.com';
export const defaultVolcengineAsrResourceId = 'volc.seedasr.auc';
export const defaultVolcengineTtsCluster = 'volcano_tts';
export const defaultVolcengineTtsVoiceId = 'BV001_streaming';

export function createDefaultCreatorServicesConfig(): CreatorServicesConfig {
  return {
    proxy: '',
    downloadRoot: '',
    llm: {
      baseUrl: 'http://localhost:20128/v1',
      apiKey: '9router-local',
      model: 'cx/gpt-6-sol',
      jsonMode: false,
      source: 'codex',
      agnesAi: {
        baseUrl: 'https://apihub.agnes-ai.com/v1',
        apiKeys: [],
        model: 'agnes-3.0-pro'
      },
      failoverToAgnes: true
    },
    transcription: {
      provider: 'openai',
      enableGpuAcceleration: false,
      openai: {
        baseUrl: 'http://localhost:20128/v1',
        apiKey: '',
        model: 'whisper-1'
      },
      fasterWhisper: { model: 'medium' },
      whisperKit: { model: 'large-v2' },
      whisperCpp: { model: 'medium' },
      aliyun: {
        oss: { accessKeyId: '', accessKeySecret: '', bucket: '', region: 'cn-shanghai', endpoint: '' },
        speech: { accessKeyId: '', accessKeySecret: '', appKey: '' }
      },
      funasr: { baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '', model: 'sensevoice', timeoutMs: 120000 },
      volcengine: {
        appId: '',
        accessToken: '',
        resourceId: defaultVolcengineAsrResourceId,
        baseUrl: defaultVolcengineSpeechBaseUrl
      }
    },
    tts: {
      provider: 'openai',
      openai: {
        baseUrl: 'http://localhost:20128/v1',
        apiKey: '9router-local',
        model: 'gpt-4o-mini-tts',
        defaultVoiceId: 'marin'
      },
      elevenlabs: {
        baseUrl: 'https://api.elevenlabs.io',
        apiKeys: [],
        model: 'eleven_multilingual_v2',
        defaultVoiceId: 'f5q6kePPoQAjCPYG6moa'
      },
      vieneu: {
        baseUrl: 'http://127.0.0.1:7860',
        model: 'v3turbo',
        defaultVoiceId: 'Mai Anh'
      },
      minimax: {
        baseUrl: 'https://api.minimax.io',
        apiKey: '',
        model: 'speech-2.8-hd',
        defaultVoiceId: 'English_Graceful_Lady'
      },
      aliyun: {
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        apiKey: '',
        model: 'qwen3-tts-flash',
        defaultVoiceId: 'Cherry'
      },
      volcengine: {
        baseUrl: defaultVolcengineSpeechBaseUrl,
        accessToken: '',
        model: defaultVolcengineTtsCluster,
        defaultVoiceId: defaultVolcengineTtsVoiceId,
        appId: ''
      }
    },
    image: {
      provider: 'codex-native',
      openai: {
        baseUrl: '',
        apiKey: '',
        model: 'gpt-image-1'
      },
      jimeng: {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: '',
        model: 'doubao-seedream-4-0-250828'
      },
      kling: {
        baseUrl: 'https://api-beijing.klingai.com',
        accessKey: '',
        secretKey: '',
        model: 'kling-v2-1'
      },
      gemini: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: '',
        model: 'gemini-2.5-flash-image'
      },
      codexNative: {}
    },
    video: {
      provider: 'seedance',
      seedance: {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: '',
        model: defaultVideoGenerationModels.seedance
      },
      kling: {
        baseUrl: 'https://api-beijing.klingai.com',
        accessKey: '',
        secretKey: '',
        model: defaultVideoGenerationModels.kling
      },
      veo: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: '',
        model: defaultVideoGenerationModels.veo
      }
    }
  };
}
