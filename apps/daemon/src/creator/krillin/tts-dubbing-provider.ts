import type { CreatorServicesConfig } from '@opencreator/protocol';
import { providerHasTtsCredentials } from '../tts-credentials.js';

/**
 * Các provider TTS mà KrillinAI CLI (giai đoạn lồng tiếng của Dịch video) thực sự
 * hỗ trợ. Provider khác (ví dụ ElevenLabs, VieNeu) chỉ dùng được cho các tính năng
 * do daemon tự tổng hợp giọng, không đi qua CLI.
 */
export const krillinDubbingTtsProviders = [
  'openai',
  'aliyun',
  'minimax',
  'volcengine',
  'edge-tts'
] as const;

export type KrillinDubbingTtsProvider = (typeof krillinDubbingTtsProviders)[number];

/**
 * Giọng Edge TTS miễn phí đi qua gateway cục bộ (9router) theo ngôn ngữ đích của
 * KrillinAI. Gateway định tuyến TTS bằng tiền tố model `edge-tts/<giọng>` nên
 * giọng đọc phải nằm trong tên model.
 */
const gatewayEdgeTtsVoices: Record<string, string> = {
  vi: 'vi-VN-HoaiMyNeural',
  zh_cn: 'zh-CN-XiaoxiaoNeural',
  zh_tw: 'zh-TW-HsiaoChenNeural',
  en: 'en-US-AriaNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
  th: 'th-TH-PremwadeeNeural',
  id: 'id-ID-GadisNeural',
  ms: 'ms-MY-YasminNeural',
  fil: 'fil-PH-BlessicaNeural',
  hi: 'hi-IN-SwaraNeural',
  es: 'es-ES-ElviraNeural',
  fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-KatjaNeural',
  pt: 'pt-BR-FranciscaNeural',
  it: 'it-IT-ElsaNeural',
  ru: 'ru-RU-SvetlanaNeural',
  ar: 'ar-SA-ZariyahNeural',
  tr: 'tr-TR-EmelNeural',
  nl: 'nl-NL-FennaNeural',
  pl: 'pl-PL-ZofiaNeural'
};

const edgeTtsVoicePattern = /^[a-z]{2,3}-[A-Z]{2}-\w+Neural$/;

export type DubbingTtsCandidate = {
  provider: string;
  model?: string;
  voiceId?: string;
};

export type DubbingTtsProbe = (candidate: DubbingTtsCandidate) => Promise<boolean>;

export type DubbingTtsDecision = {
  ttsProvider: KrillinDubbingTtsProvider;
  ttsModel?: string;
  voiceCode?: string;
  notice?: string;
  /** Khi true, giai đoạn TTS phải dùng cổng TTS cục bộ của daemon (VieNeu ưu tiên). */
  localTts?: boolean;
};

export function isKrillinDubbingTtsProvider(value: string): value is KrillinDubbingTtsProvider {
  return (krillinDubbingTtsProviders as readonly string[]).includes(value);
}

/**
 * Chọn provider TTS thực sự chạy được cho giai đoạn lồng tiếng của Dịch video.
 *
 * Thứ tự thử:
 * 1. Provider đang cấu hình (nếu CLI hỗ trợ và có thông tin đăng nhập) — xác minh
 *    bằng một lần tổng hợp thử rất ngắn.
 * 2. Cổng TTS cục bộ của daemon: VieNeu-TTS v3 Turbo (giọng Việt chất lượng cao,
 *    chạy CPU) khi đích là tiếng Việt; bên trong cổng vẫn rơi về Edge TTS nếu cần.
 * 3. Tuyến Edge TTS miễn phí của gateway cục bộ (9router) khi endpoint TTS
 *    OpenAI-compatible trỏ vào loopback.
 * 4. Cổng Edge TTS cục bộ của daemon (miễn phí, không cần khóa).
 * 5. Edge TTS tích hợp của KrillinAI (miễn phí, không cần khóa).
 *
 * Nhờ vậy video vẫn có lồng tiếng thay vì dừng lại vì một provider "trông như đã
 * cấu hình" nhưng thực tế bị máy chủ từ chối.
 */
export async function resolveDubbingTtsDecision(input: {
  config: CreatorServicesConfig;
  requestedProvider?: string;
  requestedModel?: string;
  requestedVoice?: string;
  targetLanguage?: string;
  probe?: DubbingTtsProbe;
  /** Cổng TTS cục bộ của daemon (VieNeu ưu tiên, Edge TTS là phương án cuối). */
  localTts?: {
    probe?(): Promise<boolean>;
  };
}): Promise<DubbingTtsDecision> {
  const requested = input.requestedProvider?.trim() || input.config.tts.provider;

  if (
    isKrillinDubbingTtsProvider(requested)
    && providerHasTtsCredentials(input.config, requested)
    && await candidateIsUsable(
      { provider: requested, model: input.requestedModel, voiceId: input.requestedVoice },
      input.probe
    )
  ) {
    return { ttsProvider: requested };
  }

  // Ưu tiên VieNeu-TTS v3 Turbo cho giọng Việt: chất lượng cao, chạy hoàn toàn cục bộ.
  if (
    prefersVieNeu(input.config, input.targetLanguage)
    && input.localTts !== undefined
    && await localTtsUsable(input.localTts)
  ) {
    return {
      ttsProvider: 'openai',
      localTts: true,
      notice: 'Provider TTS đã cấu hình không phản hồi — đã chuyển sang VieNeu-TTS v3 Turbo cục bộ để video vẫn có lồng tiếng chất lượng cao.'
    };
  }

  const gateway = gatewayEdgeTtsRoute(
    input.config,
    input.requestedVoice,
    input.targetLanguage
  );
  if (
    gateway !== undefined
    && input.probe !== undefined
    && await candidateIsUsable(
      { provider: 'openai', model: gateway.model, voiceId: gateway.voice },
      input.probe
    )
  ) {
    return {
      ttsProvider: 'openai',
      ttsModel: gateway.model,
      voiceCode: gateway.voice,
      notice: 'Provider TTS đã cấu hình không phản hồi — đã chuyển sang giọng Edge TTS miễn phí qua gateway cục bộ để video vẫn có lồng tiếng.'
    };
  }

  const voice = edgeTtsVoice(input.requestedVoice, input.targetLanguage);
  if (
    input.localTts !== undefined
    && voice !== undefined
    && await localTtsUsable(input.localTts)
  ) {
    return {
      ttsProvider: 'openai',
      ttsModel: `edge-tts/${voice}`,
      voiceCode: voice,
      localTts: true,
      notice: 'Provider TTS đã cấu hình không phản hồi — đã chuyển sang giọng Edge TTS miễn phí của OpenCreator để video vẫn có lồng tiếng.'
    };
  }

  if (requested === 'edge-tts') return { ttsProvider: 'edge-tts' };
  return {
    ttsProvider: 'edge-tts',
    notice: 'Provider TTS thiếu khóa API — đã tự chuyển sang Edge TTS (miễn phí) để vẫn có lồng tiếng.'
  };
}

/**
 * VieNeu-TTS v3 Turbo là TTS tiếng Việt: chỉ ưu tiên khi đích là tiếng Việt hoặc
 * khi người dùng chọn thẳng provider `vieneu` trong Cài đặt dịch vụ AI.
 */
function prefersVieNeu(config: CreatorServicesConfig, targetLanguage: string | undefined): boolean {
  if (config.tts.provider === 'vieneu') return true;
  const language = targetLanguage?.trim().toLowerCase().replaceAll('-', '_');
  return language === 'vi' || language === 'vi_vn';
}

async function localTtsUsable(local: { probe?(): Promise<boolean> }): Promise<boolean> {
  if (local.probe === undefined) return true;
  try {
    return await local.probe();
  } catch {
    return false;
  }
}


async function candidateIsUsable(
  candidate: DubbingTtsCandidate,
  probe: DubbingTtsProbe | undefined
): Promise<boolean> {
  if (candidate.provider === 'edge-tts') return true;
  if (probe === undefined) return true;
  try {
    return await probe(candidate);
  } catch {
    return false;
  }
}

function gatewayEdgeTtsRoute(
  config: CreatorServicesConfig,
  requestedVoice: string | undefined,
  targetLanguage: string | undefined
): { model: string; voice: string } | undefined {
  if (!isLoopbackBaseUrl(config.tts.openai.baseUrl)) return undefined;
  const voice = edgeTtsVoice(requestedVoice, targetLanguage);
  if (voice === undefined) return undefined;
  return { model: `edge-tts/${voice}`, voice };
}

function edgeTtsVoice(
  requestedVoice: string | undefined,
  targetLanguage: string | undefined
): string | undefined {
  const requested = requestedVoice?.trim();
  if (requested && edgeTtsVoicePattern.test(requested)) return requested;
  const language = targetLanguage?.trim().toLowerCase().replaceAll('-', '_');
  if (!language || language === 'auto') return undefined;
  return gatewayEdgeTtsVoices[language];
}

/** Có phải tên giọng Edge TTS (`vi-VN-HoaiMyNeural`) không. */
export function isEdgeTtsVoice(voice: string): boolean {
  return edgeTtsVoicePattern.test(voice.trim());
}

/** Văn bản có chứa chữ Hán không. */
export function isCjkText(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

/** Văn bản có dấu hiệu là tiếng Việt (có dấu hoặc ký tự đặc trưng) không. */
export function hasVietnameseText(text: string): boolean {
  return /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i.test(text);
}

/**
 * Giọng Edge dự phòng phù hợp với nội dung: giữ giọng người dùng đã chọn nếu là
 * giọng Edge hợp lệ; nếu không, dùng giọng Trung cho văn bản còn chữ Hán (giọng
 * Việt của Edge trả về rỗng với chữ Hán) và giọng Việt cho phần còn lại.
 */
export function edgeFallbackVoice(text: string, requested: string): string {
  const trimmed = requested.trim();
  if (isEdgeTtsVoice(trimmed)) return trimmed;
  return isCjkText(text) ? 'zh-CN-XiaoxiaoNeural' : 'vi-VN-HoaiMyNeural';
}

/** Giọng Edge TTS mặc định theo ngôn ngữ đích (nếu có trong bảng). */
export function edgeTtsVoiceForLanguage(language: string | undefined): string | undefined {
  const key = language?.trim().toLowerCase().replaceAll('-', '_');
  if (!key || key === 'auto') return undefined;
  return gatewayEdgeTtsVoices[key];
}

export function isLoopbackBaseUrl(baseUrl: string): boolean {
  const value = baseUrl.trim();
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host === '[::1]'
      || host.endsWith('.localhost');
  } catch {
    return /^localhost(:\d+)?(\/|$)/i.test(value)
      || /^127\.0\.0\.1(:\d+)?(\/|$)/.test(value);
  }
}
