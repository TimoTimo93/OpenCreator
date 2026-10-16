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
 * 2. Tuyến Edge TTS miễn phí của gateway cục bộ (9router) khi endpoint TTS
 *    OpenAI-compatible trỏ vào loopback.
 * 3. Edge TTS tích hợp của KrillinAI (miễn phí, không cần khóa).
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

  if (requested === 'edge-tts') return { ttsProvider: 'edge-tts' };
  return {
    ttsProvider: 'edge-tts',
    notice: 'Provider TTS thiếu khóa API — đã tự chuyển sang Edge TTS (miễn phí) để vẫn có lồng tiếng.'
  };
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
