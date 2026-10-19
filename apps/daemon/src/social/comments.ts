/**
 * GĐ3 — Quét bình luận + tự động phản hồi bằng AI.
 *
 * - Facebook: Graph API đọc bình luận video Page và đăng reply (ổn định nhất,
 *   token Page mã hoá sẵn).
 * - YouTube: mở trang watch của video công khai bằng trình duyệt cụm → lấy
 *   bình luận; trả lời bằng nút Reply trên trang (best-effort, khớp comment
 *   theo author + text vì DOM không lộ comment id).
 * - TikTok: quét bình luận qua DOM trang video (id thật `data-comment-id`
 *   nếu có, không thì id tổng hợp ổn định `tt:<videoId>:<hash>`), tự trả lời
 *   bằng nút Reply trên trang (best-effort).
 *
 * Guardrails: bỏ comment/quảng cáo, cap reply/ngày, dedupe theo comment id,
 * reset "pending"→"failed" sẽ không chạy lại vô hạn (chỉ nhắc ở UI).
 */
import { readFile } from 'node:fs/promises';
import {
  countCommentRowsRepliedSince,
  listClusterRows,
  listCommentRows,
  listJobRows,
  upsertCommentRow,
  updateCommentRow,
  type SocialClusterRow,
  type SocialCommentRowLike,
  type SocialDB
} from './db.js';
import type { SocialWorker } from './worker.js';
import { type SocialComment, type SocialCommentScanResult } from './types.js';

const FB_API_VERSION = 'v20.0';
/** Số video/cluster quét bằng trình duyệt mỗi lượt (giới hạn thời gian chạy). */
const MAX_BROWSER_VIDEOS_PER_CLUSTER = 2;
/** Tối đa bài AI tự trả lời mỗi cụm mỗi ngày. */
export const MAX_AUTO_REPLIES_PER_DAY = 25;
/** Từ khoá quảng cáo/spam: bỏ qua, không trả lời. */
const SPAM_KEYWORDS = ['http://', 'https://', 'hotline', 'zalo', 'viber', 'wap', 'kèmبحabe', 'giao dịch', 'sale'];

// ---------------------------------------------------------------------------
// Selector DOM cho quét/reply (config-driven — platform đổi DOM chỉ cần sửa
// selectors.json; đọc lỗi thì rơi về mặc định bên dưới).
// ---------------------------------------------------------------------------

type TikTokCommentSelectors = {
  /** Nút mở khu vực bình luận trên trang video (best-effort, không thấy thì bỏ). */
  comment_open_btn: string;
  comment_item: string;
  comment_text: string;
  /** Tác giả comment trên trang video (Studio không có key riêng). */
  comment_author: string;
  /** Vùng cuộn danh sách bình luận. */
  comment_container: string;
  /** Attribute chứa comment id thật (nền tảng có lộ thì dùng, không thì tổng hợp). */
  comment_id_attr: string;
  reply_trigger_btn: string;
  reply_input: string;
  reply_submit_btn: string;
};

type YouTubeWatchSelectors = {
  comment_thread: string;
  comment_author: string;
  comment_content: string;
  reply_button: string;
  reply_input: string;
  reply_submit_btn: string;
};

export type CommentSelectorConfig = {
  tiktok: TikTokCommentSelectors;
  youtube: YouTubeWatchSelectors;
};

const DEFAULT_COMMENT_SELECTORS: CommentSelectorConfig = {
  tiktok: {
    comment_open_btn: "[data-e2e='comment-icon'], [data-e2e='comment-count'], [data-e2e='comments-link'], button[aria-label*='Bình luận'], button[aria-label*='comment']",
    comment_item: "div[data-e2e='comment-item'], div[class*='CommentItem']",
    comment_text: "span[data-e2e='comment-level-1'], p[data-e2e='comment-text'], div[data-e2e='comment-text'], div[class*='comment-text']",
    comment_author: "a[data-e2e='comment-author'], [data-e2e='comment-author'], a[href*='/@']",
    comment_container: "[data-e2e='comments-list'], div[class*='CommentList'], div[class*='comment-list']",
    comment_id_attr: 'data-comment-id',
    reply_trigger_btn: "span[data-e2e='comment-reply-btn'], button:has-text('Trả lời'), button:has-text('Reply')",
    reply_input: "div[contenteditable='true'], textarea[placeholder*='Trả lời'], textarea[placeholder*='Reply']",
    reply_submit_btn: "button[data-e2e='comment-post'], button:has-text('Đăng'), button:has-text('Send')"
  },
  youtube: {
    comment_thread: 'ytd-comment-thread-renderer',
    comment_author: '#author-text, #author-simple-name',
    comment_content: '#content-text',
    reply_button: "#reply-button, button[aria-label*='Phản hồi'], button[aria-label*='Reply'], ytd-button-renderer#reply-button button",
    reply_input: '#contenteditable-root',
    reply_submit_btn: '#submit-button, ytd-button-renderer#submit-button button'
  }
};

const SELECTORS_PATH = new URL('./platforms/selectors.json', import.meta.url);

async function loadCommentSelectors(): Promise<CommentSelectorConfig> {
  try {
    const raw = JSON.parse(await readFile(SELECTORS_PATH, 'utf8')) as {
      tiktok_studio?: Record<string, unknown>;
      youtube_watch?: Record<string, unknown>;
    };
    const tk = raw.tiktok_studio ?? {};
    const yt = raw.youtube_watch ?? {};
    const pick = (source: Record<string, unknown>, key: string, fallback: string): string => {
      const value = source[key];
      return typeof value === 'string' && value.trim() !== '' ? value : fallback;
    };
    const fallback = DEFAULT_COMMENT_SELECTORS;
    return {
      tiktok: {
        comment_open_btn: pick(tk, 'comment_open_btn', fallback.tiktok.comment_open_btn),
        comment_item: pick(tk, 'comment_item', fallback.tiktok.comment_item),
        comment_text: pick(tk, 'comment_text', fallback.tiktok.comment_text),
        comment_author: pick(tk, 'video_comment_author', fallback.tiktok.comment_author),
        comment_container: pick(tk, 'video_comment_container', fallback.tiktok.comment_container),
        comment_id_attr: pick(tk, 'video_comment_id_attr', fallback.tiktok.comment_id_attr),
        reply_trigger_btn: pick(tk, 'reply_trigger_btn', fallback.tiktok.reply_trigger_btn),
        reply_input: pick(tk, 'reply_input', fallback.tiktok.reply_input),
        reply_submit_btn: pick(tk, 'reply_submit_btn', fallback.tiktok.reply_submit_btn)
      },
      youtube: {
        comment_thread: pick(yt, 'comment_thread', fallback.youtube.comment_thread),
        comment_author: pick(yt, 'comment_author', fallback.youtube.comment_author),
        comment_content: pick(yt, 'comment_content', fallback.youtube.comment_content),
        reply_button: pick(yt, 'reply_button', fallback.youtube.reply_button),
        reply_input: pick(yt, 'reply_input', fallback.youtube.reply_input),
        reply_submit_btn: pick(yt, 'reply_submit_btn', fallback.youtube.reply_submit_btn)
      }
    };
  } catch {
    // selectors.json không đọc được → dùng mặc định, không chết scan.
    return DEFAULT_COMMENT_SELECTORS;
  }
}

// ---------------------------------------------------------------------------
// Trang DOM tối thiểu (Patchright Page nói riêng không được import vào đây —
// dùng structural typing như phần quét YouTube sẵn có).
// ---------------------------------------------------------------------------

type SocialDomLocator = {
  first(): SocialDomLocator;
  nth(index: number): SocialDomLocator;
  /** Locator lồng nhau (row.locator(...)) — giữ phạm vi của locator hiện tại. */
  locator(selector: string): SocialDomLocator;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  type(text: string, options?: { delay?: number }): Promise<void>;
  press(key: string): Promise<void>;
  textContent(): Promise<string | null>;
  getAttribute(name: string): Promise<string | null>;
  scrollIntoViewIfNeeded(): Promise<void>;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
};

type SocialDomPage = {
  url(): string;
  close(): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T, Arg = undefined>(fn: (arg: Arg) => T, arg?: Arg): Promise<T>;
  locator(selector: string): SocialDomLocator;
  keyboard?: {
    type(text: string, options?: { delay?: number }): Promise<void>;
    press(key: string): Promise<void>;
  };
};

export type SocialLlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type SocialCommentsInput = {
  db: SocialDB;
  worker: SocialWorker;
  decryptToken(token: string | null): string;
  /** LLM để soạn câu trả lời (hết cấu hình → dùng mẫu/trả lời mặc định). */
  readLlmConfig: () => Promise<SocialLlmConfig | null>;
  scanIntervalMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => { unref?(): void };
  fetchFn?: typeof fetch;
  now?: () => string;
  log?: (message: string) => void;
};

export type SocialComments = {
  scan(clusterId?: string): Promise<SocialCommentScanResult>;
  list(clusterId?: string, limit?: number): SocialComment[];
  close(): void;
};

export function createSocialComments(input: SocialCommentsInput): SocialComments {
  const log = input.log ?? ((message: string): void => { console.log(`[social-comments] ${message}`); });
  const now = input.now ?? ((): string => new Date().toISOString());
  const fetchFn = input.fetchFn ?? globalThis.fetch.bind(globalThis);
  let closed = false;
  let busy = false;
  let timer: { unref?(): void } | undefined;

  const interval = input.scanIntervalMs ?? 3 * 60 * 60_000;
  if (interval > 0) {
    const setter = input.setIntervalFn ?? ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms) as { unref?(): void };
      t.unref?.();
      return t;
    });
    timer = setter(() => { void runScan().catch(error => log(`scan thất bại: ${message(error)}`)); }, interval);
  }

  return {
    async scan(clusterId?: string): Promise<SocialCommentScanResult> {
      if (closed) throw new Error('Comments service đã đóng');
      if (busy) {
        return { clustersScanned: 0, videosScanned: 0, newComments: 0, repliesAttempted: 0, repliesSent: 0, errors: ['Đang quét, thử lại sau'] };
      }
      busy = true;
      try {
        return await runScan(clusterId);
      } finally {
        busy = false;
      }
    },

    list(clusterId?: string, limit = 80): SocialComment[] {
      const clusters = new Map(listClusterRows(input.db).map(row => [row.id, row] as const));
      return listCommentRows(input.db, { clusterId, limit }).map(row => mapCommentRow(row, clusters.get(row.cluster_id)?.name ?? row.cluster_id));
    },

    close(): void {
      closed = true;
      if (timer !== undefined) {
        clearInterval(timer as NodeJS.Timeout);
        timer = undefined;
      }
    }
  };

  // -------------------------------------------------------------------------

  async function runScan(clusterId?: string): Promise<SocialCommentScanResult> {
    const clusterRows = listClusterRows(input.db)
      .filter(row => clusterId === undefined || row.id === clusterId);
    const errors: string[] = [];
    let clustersScanned = 0;
    let videosScanned = 0;
    let newComments = 0;
    let repliesAttempted = 0;
    let repliesSent = 0;
    // Selector DOM đọc một lần mỗi lượt quét (dùng cho scrape + reply).
    const selectors = await loadCommentSelectors();

    for (const clusterRow of clusterRows) {
      clustersScanned += 1;
      const cluster = clusterRow;
      const jobs = listJobRows(input.db).filter(row => row.cluster_id === cluster.id);

      // --- Facebook (Graph API) ---
      if (cluster.fb_mode === 'graph_api' && cluster.fb_page_id.trim() !== '') {
        const token = input.decryptToken(cluster.fb_page_token_encrypted);
        if (token !== '') {
          const videos = jobs.filter(row => (row.fb_status === 'published' || row.fb_status === 'scheduled')
            && (row.fb_video_id ?? '') !== '');
          for (const video of videos) {
            videosScanned += 1;
            try {
              const fetched = await fetchFacebookComments(fetchFn, video.fb_video_id!, token);
              for (const comment of fetched) {
                if (comment.message === undefined || comment.message.trim() === '') continue;
                const inserted = upsertCommentRow(input.db, {
                  jobId: video.id,
                  clusterId: cluster.id,
                  platform: 'facebook',
                  externalVideoId: video.fb_video_id!,
                  externalCommentId: comment.id,
                  author: comment.from?.name ?? 'Người dùng',
                  text: comment.message.slice(0, 1_000),
                  commentCreatedAt: comment.created_time ?? null,
                  nowISO: now()
                });
                if (inserted) newComments += 1;
              }
            } catch (error) {
              errors.push(`facebook/${cluster.name}: ${message(error)}`);
            }
          }
        }
      }

      // --- YouTube (browser, best-effort) ---
      const ytChannelUrl = cluster.yt_channel_url ?? '';
      if (ytChannelUrl.trim() !== '' || jobs.some(row => (row.yt_video_id ?? '') !== '')) {
        const videos = jobs.filter(row => row.yt_status === 'published' && (row.yt_video_id ?? '') !== '')
          .slice(0, MAX_BROWSER_VIDEOS_PER_CLUSTER);
        for (const video of videos) {
          try {
            const scraped = await scrapeYouTubeComments(input.worker, cluster.id, video.yt_video_id!);
            videosScanned += 1;
            for (const comment of scraped) {
              const inserted = upsertCommentRow(input.db, {
                jobId: video.id,
                clusterId: cluster.id,
                platform: 'youtube',
                externalVideoId: video.yt_video_id!,
                externalCommentId: comment.id,
                author: comment.author,
                text: comment.text.slice(0, 1_000),
                commentCreatedAt: null,
                nowISO: now()
              });
              if (inserted) newComments += 1;
            }
          } catch (error) {
            errors.push(`youtube/${cluster.name}: ${message(error)}`);
          }
        }
      }
      // --- TikTok (browser, best-effort) ---
      const tkHandle = parseTikTokHandle(cluster.tk_profile_url ?? '');
      if (tkHandle !== '') {
        const videos = jobs.filter(row => row.tk_status === 'published' && (row.tk_video_id ?? '').trim() !== '')
          .slice(0, MAX_BROWSER_VIDEOS_PER_CLUSTER);
        for (const video of videos) {
          const videoUrl = buildTikTokVideoUrl(tkHandle, video.tk_video_id!);
          if (videoUrl === null) continue;
          try {
            const scraped = await scrapeTikTokComments(input.worker, cluster.id, video.tk_video_id!, videoUrl, selectors.tiktok);
            videosScanned += 1;
            for (const comment of scraped) {
              const inserted = upsertCommentRow(input.db, {
                jobId: video.id,
                clusterId: cluster.id,
                platform: 'tiktok',
                externalVideoId: video.tk_video_id!,
                externalCommentId: comment.id,
                author: comment.author === '' ? 'Người dùng' : comment.author,
                text: comment.text.slice(0, 1_000),
                commentCreatedAt: null,
                nowISO: now()
              });
              if (inserted) newComments += 1;
            }
          } catch (error) {
            errors.push(`tiktok/${cluster.name}: ${message(error)}`);
          }
        }
      }
    }

    // --- AI auto-reply ---
    const llmConfig = await input.readLlmConfig().catch((): null => null);
    try {
      for (const clusterRow of clusterRows) {
        const cluster = clusterRow;
        if (cluster.auto_reply_enabled !== 1) continue;
        let remaining = MAX_AUTO_REPLIES_PER_DAY - repliedToday(input.db, cluster.id);
        if (remaining <= 0) continue;
        const pending = listCommentRows(input.db, { clusterId: cluster.id, replyStatus: 'pending', limit: 30 });
        for (const comment of pending) {
          if (remaining <= 0) break;
          if (isSpam(comment.text)) {
            updateCommentRow(input.db, comment.id, { reply_status: 'skipped', skipped_reason: 'Bỏ qua quảng cáo/spam' });
            continue;
          }
          repliesAttempted += 1;
          const text = await generateReply(llmConfig, cluster.auto_reply_prompt ?? '', comment);
          const outcome = await postReply(
            fetchFn,
            input.worker,
            clusterRow.id,
            clusterRow,
            comment,
            text,
            input.decryptToken,
            selectors
          );
          if (outcome.ok) {
            repliesSent += 1;
            remaining -= 1;
            updateCommentRow(input.db, comment.id, {
              reply_status: 'sent',
              reply_text: text,
              replied_at: now()
            });
          } else {
            updateCommentRow(input.db, comment.id, {
              reply_status: 'failed',
              reply_text: text,
              skipped_reason: outcome.reason
            });
          }
        }
      }
    } catch (error) {
      errors.push(`ai-reply: ${message(error)}`);
    }

    log(`scan xong: ${videosScanned} video, ${newComments} comment mới, ${repliesSent}/${repliesAttempted} trả lời`);
    return { clustersScanned, videosScanned, newComments, repliesAttempted, repliesSent, errors };
  }
}

function repliedToday(db: SocialDB, clusterId: string): number {
  return countCommentRowsRepliedSince(db, clusterId, new Date(new Date().setHours(0, 0, 0, 0)).toISOString());
}

function repliedAtStartOk(db: SocialDB, clusterId: string): number {
  return repliedToday(db, clusterId);
}

export function isSpam(text: string): boolean {
  const lower = text.toLowerCase();
  return SPAM_KEYWORDS.some(keyword => lower.includes(keyword)) || text.length > 480;
}

// ---------------------------------------------------------------------------
// LLM + templates
// ---------------------------------------------------------------------------

const DEFAULT_REPLIES: string[] = [
  'Cảm ơn bạn đã ủng hộ kênh bạn nhé! 💛',
  'Bạn muốn xem thêm phim nào, bình luận giúp kênh nhé! 🎬',
  'Chúc bạn xem phim vui vẻ, hẹn gặp lại! 🍿'
];

async function generateReply(
  config: SocialLlmConfig | null,
  prompt: string,
  comment: SocialCommentRowLike
): Promise<string> {
  if (config === null || config.baseUrl.trim() === '' || config.apiKey.trim() === '') {
    return defaultReply(comment.text);
  }
  const system = [
    'Bạn là trợ lý của một kênh phim truyện, viết bình luận Facebook ngắn gọn, thân thiện, tự nhiên như người thật.',
    'Câu trả lời tối đa 200 ký tự, không kèm emoji nhiều hơn 1 cái, không dùng liên kết, không lặp lại nguyên văn tên người dùng.',
    prompt.trim() === '' ? '' : `Chỉ dẫn riêng của kênh: ${prompt.trim()}`,
    'Nếu không chắc nội dung comment (spam/không rõ), trả về "[]".'
  ].filter(line => line !== '').join('\n');
  const user = `Người dùng "${comment.author || 'Ẩn danh'}" bình luận: "${comment.text}"`;
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
      max_tokens: 140,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    }),
    signal: AbortSignal.timeout(20_000)
  }).catch((error: unknown): null => { void error; return null; });
  if (response === null || !response.ok) return defaultReply(comment.text);
  const payload = await response.json().catch((): null => null) as {
    choices?: Array<{ message?: { content?: string } }>
  } | null;
  const content = payload?.choices?.[0]?.message?.content?.trim() ?? '';
  if (content === '' || content === '[]') return defaultReply(comment.text);
  return content.slice(0, 600);
}

function defaultReply(commentText: string): string {
  const t = commentText.toLowerCase();
  if (/(cảm ơn|thank|ão)/.test(t)) return 'Cảm ơn bạn nhiều, đã ủng hộ kênh! 💛';
  if (/(tập|phim|xem tiếp|theatre|sập)/.test(t)) return 'Tập mới sẽ được cập nhật đều mỗi ngày, theo sát kênh nhé! 🎬';
  if (/\?|không|ko|nào/.test(t)) return 'Chào bạn! Bạn để lại tên bộ phim mong muốn để kênh cập nhật nhé! 🍿';
  return DEFAULT_REPLIES[Math.floor(Math.random() * DEFAULT_REPLIES.length)] ?? 'Cảm ơn bạn đã ủng hộ kênh! 💛';
}

// ---------------------------------------------------------------------------
// Nền tảng
// ---------------------------------------------------------------------------

type FacebookCommentPayload = {
  id: string;
  message?: string;
  created_time?: string;
  from?: { name?: string };
};

async function fetchFacebookComments(
  fetchFn: typeof fetch,
  videoId: string,
  token: string
): Promise<FacebookCommentPayload[]> {
  const url = `https://graph.facebook.com/${FB_API_VERSION}/${encodeURIComponent(videoId)}`
    + `/comments?fields=id,from,message,created_time&limit=25&order=reverse_chronological&filter=stream`;
  const response = await fetchFn(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`Graph comments ${response.status}: ${(await response.text().catch(() => '')).slice(0, 160)}`);
  }
  const payload = await response.json() as { data?: FacebookCommentPayload[] };
  return Array.isArray(payload.data) ? payload.data : [];
}

/** Kết quả một lần đăng reply tự động. */
type ReplyOutcome = { ok: boolean; reason: string | null };

/** Lý do chung khi nền tảng chưa hỗ trợ/không thể tự đăng. */
const MANUAL_REPLY_REASON = 'Cần trả lời thủ công / nền tảng chưa hỗ trợ tự động';
/** Lý do khi DOM reply đã thử nhưng không xác nhận được thành công. */
const DOM_REPLY_FAIL_REASON = 'Chưa tự đăng được — trả lời tay';

async function postReply(
  fetchFn: typeof fetch,
  worker: SocialWorker,
  clusterId: string,
  cluster: SocialClusterRow,
  comment: SocialCommentRowLike,
  text: string,
  decryptToken: (token: string | null) => string,
  selectors: CommentSelectorConfig
): Promise<ReplyOutcome> {
  if (comment.platform === 'facebook') {
    const token = decryptToken(cluster.fb_page_token_encrypted);
    if (token === '' || comment.external_comment_id.trim() === '') {
      return { ok: false, reason: 'Chưa cấu hình token Page — trả lời tay' };
    }
    try {
      const response = await fetchFn(
        `https://graph.facebook.com/${FB_API_VERSION}/${encodeURIComponent(comment.external_comment_id)}/comments`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'content-type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({ message: text }).toString()
        }
      );
      return response.ok ? { ok: true, reason: null } : { ok: false, reason: MANUAL_REPLY_REASON };
    } catch (error) {
      void error;
      return { ok: false, reason: MANUAL_REPLY_REASON };
    }
  }
  if (comment.platform === 'youtube' && comment.external_video_id.trim() !== '') {
    const sent = await postYouTubeReplyViaDom(worker, clusterId, comment, text, selectors.youtube)
      .catch((): boolean => false);
    return sent ? { ok: true, reason: null } : { ok: false, reason: DOM_REPLY_FAIL_REASON };
  }
  if (comment.platform === 'tiktok') {
    const videoUrl = buildTikTokVideoUrl(parseTikTokHandle(cluster.tk_profile_url ?? ''), comment.external_video_id);
    if (videoUrl !== null) {
      const sent = await postTikTokReplyViaDom(worker, clusterId, videoUrl, comment, text, selectors.tiktok)
        .catch((): boolean => false);
      return sent ? { ok: true, reason: null } : { ok: false, reason: DOM_REPLY_FAIL_REASON };
    }
  }
  return { ok: false, reason: MANUAL_REPLY_REASON };
}

// ---------------------------------------------------------------------------
// DOM helpers chung (mẫu best-effort theo platforms/tiktok.ts uploadFlow)
// ---------------------------------------------------------------------------

/** Bấm vào element nếu thấy — không thấy/DOM đổi thì bỏ qua, không chặn luồng. */
async function clickIfVisible(page: SocialDomPage, selector: string): Promise<void> {
  try {
    const target = page.locator(selector).first();
    if (await target.isVisible().catch(() => false)) {
      await target.click();
      await page.waitForTimeout(600);
    }
  } catch {
    // Không chặn luồng.
  }
}

/** Cuộn khu vực bình luận một nhịp (chạy trong page — hàm tự đủ, không tham chiếu ngoài). */
function scrollCommentsDom(payload: { containerSel: string }): undefined {
  const container = payload.containerSel !== '' ? document.querySelector(payload.containerSel) : null;
  if (container !== null && typeof container.scrollBy === 'function') {
    container.scrollBy(0, 1_200);
  } else {
    window.scrollTo(0, document.body.scrollHeight);
  }
  return undefined;
}

/**
 * Thu bình luận TikTok trong page — hàm tự đủ (Playwright serialize từng dòng,
 * không được tham chiếu biến ngoài). Trả nguyên liệu: id thật (nếu có) + thứ tự.
 */
function collectTikTokCommentsDom(payload: {
  itemSel: string;
  textSel: string;
  authorSel: string;
  idAttr: string;
  max: number;
}): Array<{ author: string; text: string; realId: string | null; order: number }> {
  const out: Array<{ author: string; text: string; realId: string | null; order: number }> = [];
  const nodes = Array.from(document.querySelectorAll(payload.itemSel)) as Element[];
  nodes.slice(0, payload.max).forEach((node, index) => {
    const textNode = payload.textSel !== '' ? node.querySelector(payload.textSel) : null;
    const text = (textNode?.textContent ?? '').trim();
    if (text === '') return;
    let author = '';
    if (payload.authorSel !== '') {
      const authorNode = node.querySelector(payload.authorSel);
      author = (authorNode?.textContent ?? '').trim();
    }
    if (author === '') {
      // Fallback: link @handle trong item.
      const link = node.querySelector("a[href*='@']");
      const handle = /\/@([\w.-]+)/.exec(link?.getAttribute('href') ?? '')?.[1];
      if (handle !== undefined) author = `@${handle}`;
    }
    let realId: string | null = null;
    if (payload.idAttr !== '') {
      realId = node.getAttribute(payload.idAttr)
        ?? node.querySelector(`[${payload.idAttr}]`)?.getAttribute(payload.idAttr)
        ?? null;
    }
    out.push({ author, text: text.slice(0, 1_000), realId: realId === '' ? null : realId, order: index });
  });
  return out;
}

/** FNV-1a 32-bit — hash chuỗi ổn định giữa các lần chạy/khởi động lại. */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Id tổng hợp TikTok khi DOM không lộ comment id: PHẢI ỔN ĐỊNH giữa các lần
 * quét (unique(platform, external_comment_id) phụ thuộc nó) — dùng
 * `tt:<videoId>:<hash(author|text|order)>`.
 */
export function syntheticTikTokCommentId(videoId: string, author: string, text: string, order: number): string {
  return `tt:${videoId}:${stableHash(`${author}|${text}|${order}`)}`;
}

function normalizeDomText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Khớp comment đã lưu với dòng DOM (YT/TikTok không lộ id) theo author + text. */
function commentMatchesDom(domAuthor: string, domText: string, comment: SocialCommentRowLike): boolean {
  const storedText = normalizeDomText(comment.text);
  const domNormalized = normalizeDomText(domText);
  if (storedText === '' || domNormalized === '') return false;
  if (domNormalized !== storedText && !domNormalized.includes(storedText.slice(0, 120))) return false;
  const storedAuthor = normalizeDomText(comment.author).replace(/^@/, '');
  if (storedAuthor === '') return true;
  return normalizeDomText(domAuthor).replace(/^@/, '').includes(storedAuthor);
}

/** `tiktok.com/@user` / `https://www.tiktok.com/@user` → `user`. */
export function parseTikTokHandle(profileUrl: string): string {
  const match = /@([\w.-]+)/.exec(profileUrl.trim());
  return match?.[1] ?? '';
}

function buildTikTokVideoUrl(handle: string, videoId: string): string | null {
  if (handle === '' || videoId.trim() === '') return null;
  return `https://www.tiktok.com/@${handle}/video/${encodeURIComponent(videoId)}`;
}

/** Điền text + bấm gửi reply (ưu tiên input trong comment, fallback mức trang). */
async function fillAndSubmitReply(
  page: SocialDomPage,
  scope: SocialDomLocator | undefined,
  selectors: { reply_input: string; reply_submit_btn: string },
  text: string
): Promise<boolean | null> {
  const scopes: Array<SocialDomLocator | undefined> = scope !== undefined ? [scope, undefined] : [undefined];
  for (const current of scopes) {
    try {
      const input = current === undefined
        ? page.locator(selectors.reply_input).first()
        : current.locator(selectors.reply_input).first();
      if (!(await input.isVisible().catch(() => false))) continue;
      await input.click().catch(() => undefined);
      await input.fill(text).catch(async () => {
        // contenteditable đôi khi từ chối fill — gõ tay qua keyboard.
        if (page.keyboard !== undefined) {
          await page.keyboard.type(text, { delay: 30 }).catch(() => undefined);
        }
      });
      const submit = current === undefined
        ? page.locator(selectors.reply_submit_btn).first()
        : current.locator(selectors.reply_submit_btn).first();
      if (!(await submit.isVisible().catch(() => false))) continue;
      await submit.click();
      await page.waitForTimeout(3_000);
      // Xác nhận: editor bị xoá/biến mất → nền tảng đã nhận; vẫn còn chữ → thất bại.
      const stillVisible = await input.isVisible().catch(() => false);
      const leftover = (await input.textContent().catch(() => 'unverified')) ?? '';
      return !stillVisible || leftover.trim() === '';
    } catch {
      continue; // Bước DOM lỗi → thử phạm vi khác, không chết luồng.
    }
  }
  return null;
}

/** Tự trả lời YouTube qua DOM trang watch (best-effort, khớp author + text). */
async function postYouTubeReplyViaDom(
  worker: SocialWorker,
  clusterId: string,
  comment: SocialCommentRowLike,
  text: string,
  selectors: YouTubeWatchSelectors
): Promise<boolean> {
  return worker.withClusterBrowser(clusterId, async handle => {
    const page = (await handle
      .newPage(`https://www.youtube.com/watch?v=${encodeURIComponent(comment.external_video_id)}`)) as unknown as SocialDomPage;
    try {
      await page.waitForTimeout(6_000);
      // Cuộn xuống để phần bình luận được lười nạp.
      await page.evaluate(() => { window.scrollTo(0, 1_400); }).catch(() => undefined);
      await page.waitForTimeout(3_000);
      const threads = page.locator(selectors.comment_thread);
      const count = await threads.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const row = threads.nth(index);
        const author = (await row.locator(selectors.comment_author).first().textContent().catch((): string | null => '')) ?? '';
        const body = (await row.locator(selectors.comment_content).first().textContent().catch((): string | null => '')) ?? '';
        if (!commentMatchesDom(author, body, comment)) continue;
        const replyButton = row.locator(selectors.reply_button).first();
        if (!(await replyButton.isVisible().catch(() => false))) continue;
        await replyButton.click();
        await page.waitForTimeout(1_500);
        const outcome = await fillAndSubmitReply(page, row, selectors, text);
        if (outcome !== null) return outcome;
      }
      return false;
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

/** Tự trả lời TikTok qua DOM trang video (best-effort, khớp author + text). */
async function postTikTokReplyViaDom(
  worker: SocialWorker,
  clusterId: string,
  videoUrl: string,
  comment: SocialCommentRowLike,
  text: string,
  selectors: TikTokCommentSelectors
): Promise<boolean> {
  return worker.withClusterBrowser(clusterId, async handle => {
    const page = (await handle.newPage(videoUrl)) as unknown as SocialDomPage;
    try {
      await page.waitForTimeout(6_000);
      await clickIfVisible(page, selectors.comment_open_btn);
      // Cuộn vài lần để danh sách bình luận nạp đủ (TikTok lười nạp).
      for (let round = 0; round < 3; round += 1) {
        await page
          .evaluate(scrollCommentsDom, { containerSel: selectors.comment_container })
          .catch(() => undefined);
        await page.waitForTimeout(2_500);
      }
      const items = page.locator(selectors.comment_item);
      const count = await items.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const item = items.nth(index);
        const author = (await item.locator(selectors.comment_author).first().textContent().catch((): string | null => '')) ?? '';
        const body = (await item.locator(selectors.comment_text).first().textContent().catch((): string | null => '')) ?? '';
        if (!commentMatchesDom(author, body, comment)) continue;
        await item.scrollIntoViewIfNeeded().catch(() => undefined);
        const trigger = item.locator(selectors.reply_trigger_btn).first();
        if (!(await trigger.isVisible().catch(() => false))) continue;
        await trigger.click();
        await page.waitForTimeout(1_200);
        const outcome = await fillAndSubmitReply(page, item, selectors, text);
        if (outcome !== null) return outcome;
      }
      return false;
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

/** Quét bình luận TikTok bằng trình duyệt của cụm (trang video công khai). */
async function scrapeTikTokComments(
  worker: SocialWorker,
  clusterId: string,
  videoId: string,
  videoUrl: string,
  selectors: TikTokCommentSelectors
): Promise<Array<{ id: string; author: string; text: string }>> {
  return worker.withClusterBrowser(clusterId, async handle => {
    const page = (await handle.newPage(videoUrl)) as unknown as SocialDomPage;
    try {
      await page.waitForTimeout(6_000);
      // Mở khu vực bình luận nếu trang ẩn sẵn (best-effort).
      await clickIfVisible(page, selectors.comment_open_btn);
      // Cuộn vài lần để danh sách bình luận lười nạp.
      for (let round = 0; round < 3; round += 1) {
        await page
          .evaluate(scrollCommentsDom, { containerSel: selectors.comment_container })
          .catch(() => undefined);
        await page.waitForTimeout(2_500);
      }
      type TikTokCommentDom = { author: string; text: string; realId: string | null; order: number };
      const extracted = await page.evaluate<TikTokCommentDom[], {
        itemSel: string;
        textSel: string;
        authorSel: string;
        idAttr: string;
        max: number;
      }>(collectTikTokCommentsDom, {
        itemSel: selectors.comment_item,
        textSel: selectors.comment_text,
        authorSel: selectors.comment_author,
        idAttr: selectors.comment_id_attr,
        max: 25
      }).catch((): TikTokCommentDom[] => []);
      // Id thật ưu tiên; không có → id tổng hợp ổn định (dedupe giữa các lượt quét).
      return extracted.map(entry => {
        const realId = typeof entry.realId === 'string' ? entry.realId : null;
        return {
          id: realId !== null && realId.trim() !== ''
            ? realId.trim()
            : syntheticTikTokCommentId(videoId, entry.author, entry.text, entry.order),
          author: entry.author,
          text: entry.text
        };
      });
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

export function mapCommentRow(
  row: SocialCommentRowLike,
  clusterName: string
): SocialComment {
  return {
    id: row.id,
    jobId: row.job_id,
    clusterId: row.cluster_id,
    clusterName,
    platform: row.platform as SocialComment['platform'],
    externalVideoId: row.external_video_id,
    externalCommentId: row.external_comment_id,
    author: row.author,
    text: row.text,
    commentCreatedAt: row.comment_created_at,
    createdAt: row.created_at,
    replyStatus: row.reply_status as SocialComment['replyStatus'],
    replyText: row.reply_text,
    repliedAt: row.replied_at,
    skippedReason: row.skipped_reason
  };
}

/** Quét bình luận YouTube bằng trình duyệt của cụm (public watch page). */
async function scrapeYouTubeComments(
  worker: SocialWorker,
  clusterId: string,
  videoId: string
): Promise<Array<{ id: string; author: string; text: string }>> {
  return worker.withClusterBrowser(clusterId, async handle => {
    const page = await handle.newPage(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`) as {
      waitForTimeout(ms: number): Promise<void>;
      evaluate<T>(fn: () => T): Promise<T>;
      close(): Promise<void>;
      url(): string;
    };
    try {
      await page.waitForTimeout(6_000);
      // Cuộn xuống để phần bình luận được lười nạp.
      await page.evaluate(() => { window.scrollTo(0, 1_400); }).catch(() => undefined);
      await page.waitForTimeout(4_000);
      type CommentDom = { id: string; author: string; text: string };
      const extracted = await page.evaluate<CommentDom[]>(() => {
        const out: CommentDom[] = [];
        const nodes = Array.from(document.querySelectorAll('ytd-comment-thread-renderer')) as HTMLElement[];
        nodes.slice(0, 25).forEach(node => {
          const author = node.querySelector('#author-text')?.textContent?.trim() ?? '';
          const text = node.querySelector('#content-text')?.textContent?.trim() ?? '';
          const link = node.querySelector('a#expander')?.getAttribute('href')
            ?? node.querySelector('a')?.getAttribute('href') ?? '';
          const id = /comment_id=([\w-]+)/.exec(link)?.[1] ?? `${author}|${text}`.slice(0, 120);
          if (text !== '') out.push({ id, author, text: text.slice(0, 1_000) });
        });
        return out;
      }).catch((): Array<{ id: string; author: string; text: string }> => []);
      return extracted.map(entry => ({
        id: entry.id.startsWith('Ugx') || entry.id.length >= 8 ? entry.id : `${videoId}:${entry.id}`,
        author: entry.author,
        text: entry.text
      }));
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
