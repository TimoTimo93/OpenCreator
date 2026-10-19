/**
 * GĐ3 — Quét bình luận + tự động phản hồi bằng AI.
 *
 * - Facebook: Graph API đọc bình luận video Page và đăng reply (ổn định nhất,
 *   token Page mã hoá sẵn).
 * - YouTube: mở trang watch của video công khai bằng trình duyệt cụm → lấy
 *   bình luận; trả lời bằng nút Reply trên trang (best-effort).
 * - TikTok: quét đang hạn chế (đọc sẽ thêm sau — đăng reply qua DOM rủi ro
 *   bế tắc), luôn để pending, không tự đăng.
 *
 * Guardrails: bỏ comment/quảng cáo, cap reply/ngày, dedupe theo comment id,
 * reset "pending"→"failed" sẽ không chạy lại vô hạn (chỉ nhắc ở UI).
 */
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
      // TikTok: chưa có đường đọc comment ổn định — bỏ qua một cách tường minh.
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
          const sent = await postReply(fetchFn, clusterRow, comment, text, input.decryptToken);
          if (sent) {
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
              skipped_reason: 'Cần trả lời thủ công / nền tảng chưa hỗ trợ tự động'
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

async function postReply(
  fetchFn: typeof fetch,
  cluster: SocialClusterRow,
  comment: SocialCommentRowLike,
  text: string,
  decryptToken: (token: string | null) => string
): Promise<boolean> {
  if (comment.platform === 'facebook') {
    const token = decryptToken(cluster.fb_page_token_encrypted);
    if (token === '' || comment.external_comment_id.trim() === '') return false;
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
      return response.ok;
    } catch (error) {
      void error;
      return false;
    }
  }
  // YouTube/TikTok: đăng reply qua DOM phức tạp — để "failed" cho chế độ thủ công.
  void text;
  return false;
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
