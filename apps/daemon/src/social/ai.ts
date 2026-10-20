/**
 * AI tích hợp sẵn cho module đa kênh: sinh tiêu đề/mô tả/hashtag chuẩn SEO
 * và thử giọng trả lời bình luận — đi qua cấu hình LLM của app
 * (router nội bộ localhost:20128/v1, không cần người dùng nhập key).
 * Không cấu hình / lỗi mạng → fallback tự viết từ dữ liệu có sẵn để UI không chết.
 */
import type { SocialLlmConfig } from './comments.js';

export type SocialAiComposeInput = {
  /** Tên thô của video (tên file hoặc tên bản dịch origen). */
  videoTitle: string;
  /** Ngôn ngữ nội dung (mặc định vietsub). */
  language?: string;
};

export type SocialAiCompose = {
  /** Tiêu đề ≤100 ký tự (giới hạn YouTube). */
  title: string;
  description: string;
  /** Chuỗi "#Tag1 #Tag2 …" */
  hashtags: string;
};

export type SocialAiReplyTestInput = {
  /** Chỉ dẫn tính cách của kênh (auto_reply_prompt). */
  prompt: string;
  /** Nội dung bình luận khán giả cần phản hồi thử. */
  comment: string;
};

async function chat(
  config: SocialLlmConfig | null,
  system: string,
  user: string,
  maxTokens: number
): Promise<string> {
  if (config === null || config.baseUrl.trim() === '' || config.apiKey.trim() === '') return '';
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.7,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    }),
    signal: AbortSignal.timeout(30_000)
  }).catch((): null => null);
  if (response === null || !response.ok) return '';
  const payload = await response.json().catch((): null => null) as {
    choices?: Array<{ message?: { content?: string } }>
  } | null;
  return payload?.choices?.[0]?.message?.content?.trim() ?? '';
}

function baseTitleOf(videoTitle: string): string {
  const raw = videoTitle.trim();
  if (raw === '') return 'Video mới của kênh';
  const noExt = raw.replace(/\.(mp4|mkv|mov|webm)$/i, '');
  return noExt.length > 90 ? noExt.slice(0, 90) : noExt;
}

function guessHashtags(videoTitle: string): string {
  const cleaned = baseTitleOf(videoTitle)
    .replace(/[\\/:*?"<>|_\-\.]+/g, ' ')
    .replace(/\b(tap|phan)\s*(\d+)\b/gi, (_m, word: string, num: string) => `Tap${num} ${word === 'phan' ? 'Phan' : ''}`)
    .replace(/[^A-Za-z0-9À-ỹ\s]/g, ' ');
  const words = cleaned.split(/\s+/).filter(word => word.trim().length > 1).slice(0, 4);
  const tags = [...words.map(word => `#${word.replace(/\s+/g, '')}`), '#Vietsub', '#PhimHay'];
  return Array.from(new Set(tags)).join(' ');
}

/** Sinh tiêu đề + mô tả + hashtag chuẩn SEO cho 1 video sắp đăng đa kênh. */
export async function aiComposeVideoMeta(
  config: SocialLlmConfig | null,
  input: SocialAiComposeInput
): Promise<SocialAiCompose> {
  const rawTitle = baseTitleOf(input.videoTitle);
  const language = (input.language ?? 'vi').trim() === '' ? 'vi' : input.language;
  const system = [
    'Bạn là biên tập viên kênh phim truyện, viết tiêu đề/mô tả/hashtag chuẩn SEO cho bài đăng đa nền tảng.',
    'Trả về đúng 1 JSON object, không thêm chữ nào ngoài JSON:',
    '{"title":"...","description":"...","hashtags":"#Tag1 #Tag2 ..."}',
    'Ràng buộc: title ≤ 100 ký tự, description 1–3 câu tự nhiên có kêu gọi theo dõi, hashtags 5–8 tag.'
  ].join('\n');
  const user = `Ngôn ngữ: ${language}\nTên video gốc: ${rawTitle}`;
  const content = await chat(config, system, user, 400);
  if (content !== '') {
    try {
      const json = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
      const parsed = JSON.parse(json) as { title?: string; description?: string; hashtags?: string };
      return {
        title: (parsed.title ?? '').trim() !== '' ? parsed.title!.trim().slice(0, 100) : rawTitle,
        description: (parsed.description ?? '').trim(),
        hashtags: (parsed.hashtags ?? '').trim() !== '' ? parsed.hashtags!.trim() : guessHashtags(input.videoTitle)
      };
    } catch {
      // JSON hỏng → rơi về fallback bên dưới.
    }
  }
  return {
    title: rawTitle,
    description: `${rawTitle} — Vietsub FULL HD. Theo dõi kênh để xem tập mới mỗi ngày!`,
    hashtags: guessHashtags(input.videoTitle)
  };
}

/** Thử phản hồi AI cho 1 bình luận — chỉ sinh chữ, KHÔNG đăng lên nền tảng. */
export async function aiTestReply(
  config: SocialLlmConfig | null,
  input: SocialAiReplyTestInput
): Promise<{ reply: string; fallbackUsed: boolean }> {
  const system = [
    'Bạn là trợ lý của một kênh phim truyện, viết bình luận trả lời ngắn gọn, thân thiện, tự nhiên như người thật.',
    'Tối đa 200 ký tự, không quá 1 emoji, không kèm liên kết, không lặp nguyên văn tên người dùng.'
  ];
  if (input.prompt.trim() !== '') system.push(`Chỉ dẫn riêng của kênh: ${input.prompt.trim()}`);
  system.push('Nếu nội dung bình luận Spam/quảng cáo/không rõ, trả về đúng ký tự: []');
  const user = `Người dùng bình luận: "${input.comment}"`;
  const content = await chat(config, system.join('\n'), user, 160);
  if (content === '' && (config === null || config.baseUrl.trim() === '' || config.apiKey.trim() === '')) {
    return { reply: fallbackReply(input.comment), fallbackUsed: true };
  }
  if (content === '' || content === '[]') return { reply: fallbackReply(input.comment), fallbackUsed: true };
  return { reply: content.slice(0, 600), fallbackUsed: false };
}

const DEFAULT_REPLIES_TEST: string[] = [
  'Cảm ơn bạn đã ủng hộ kênh bạn nhé! 💛',
  'Bạn muốn xem thêm phim nào, bình luận giúp kênh nhé! 🎬',
  'Chúc bạn xem phim vui vẻ, hẹn gặp lại! 🍿'
];

function fallbackReply(commentText: string): string {
  const t = commentText.toLowerCase();
  if (/(cảm ơn|thank)/.test(t)) return 'Cảm ơn bạn nhiều, đã ủng hộ kênh! 💛';
  if (/(tập|phim|xem tiếp|hóng)/.test(t)) return 'Tập mới sẽ được cập nhật đều mỗi ngày, theo sát kênh nhé! 🎬';
  if (/(link|full)/.test(t)) return 'Bạn theo dõi kênh để xem đầy đủ các tập mới nhất nhé! 🍿';
  return DEFAULT_REPLIES_TEST[Math.floor(Math.random() * DEFAULT_REPLIES_TEST.length)] ?? 'Cảm ơn bạn đã ủng hộ kênh! 💛';
}
