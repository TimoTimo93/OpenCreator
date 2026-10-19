/**
 * Kiểm thử bình luận đa kênh (GĐ3 — A4):
 * - Quét bình luận TikTok qua DOM trang video (id tổng hợp ổn định → dedupe).
 * - Tự trả lời YouTube/TikTok qua DOM (best-effort), Facebook vẫn qua Graph.
 * - Guardrails: cap reply/ngày, bỏ spam.
 * Dùng trình duyệt DOM giả (locator/evaluate/fill canned) — không gọi mạng thật.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSocialComments,
  isSpam,
  MAX_AUTO_REPLIES_PER_DAY,
  stableHash,
  syntheticTikTokCommentId,
  type SocialComments
} from '../../src/social/comments.js';
import {
  createClusterRow,
  insertJobRow,
  listCommentRows,
  openSocialDatabase,
  updateCommentRow,
  updateJobRow,
  upsertCommentRow,
  type SocialDB
} from '../../src/social/db.js';
import { createSocialWorker, type SocialBrowserLauncher } from '../../src/social/worker.js';

let cleanupDirs: string[] = [];
afterEach(async () => {
  for (const dir of cleanupDirs) {
    // Windows khoá sqlite khi test fail giữa chừng (db chưa close) — không để
    // lỗi dọn dẹp che mất lỗi thật của test kế tiếp.
    await rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
  }
  cleanupDirs = [];
});

function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix)).then(dir => {
    cleanupDirs.push(dir);
    return dir;
  });
}

// ---------------------------------------------------------------------------
// Trình duyệt DOM giả: locator/evaluate/keyboard đủ cho luồng reply + quét.
// ---------------------------------------------------------------------------

type FakeCollectEntry = { author: string; text: string; realId: string | null; order: number };

/** Trạng thái một "hàng" comment DOM giả (thread YT hoặc item TikTok). */
type FakeRowSpec = {
  author: string;
  text: string;
  replyBtnVisible?: boolean;
  replyBtnThrows?: boolean;
  inputVisible?: boolean;
  submitThrows?: boolean;
  /** Bấm submit → editor bị xoá (platform chấp nhận reply) hay giữ nguyên. */
  submitClears?: boolean;
  /** Trạng thái runtime do fake ghi lại trong lúc chạy. */
  editorText?: string;
  replyOpened?: boolean;
};

type FakePageSpec = {
  /** Kết quả evaluate thu comment (payload có arg) — cho quét TikTok. */
  collect?: FakeCollectEntry[];
  /** Các hàng comment cho locator flow (reply). */
  rows?: FakeRowSpec[];
};

type LocatorRole = 'thread' | 'item' | 'author' | 'content' | 'reply' | 'input' | 'submit' | 'unknown';

function roleOf(selector: string): LocatorRole {
  if (selector.includes('ytd-comment-thread-renderer')) return 'thread';
  if (selector.includes('comment-item')) return 'item';
  if (selector.includes('author')) return 'author';
  if (selector.includes('content-text') || selector.includes('comment-text') || selector.includes('comment-level')) return 'content';
  if (selector.includes('reply-button') || selector.includes('reply-btn')) return 'reply';
  if (selector.includes('contenteditable') || selector.includes('reply-input')) return 'input';
  if (selector.includes('submit') || selector.includes('comment-post')) return 'submit';
  return 'unknown';
}

class FakeDomPage {
  readonly actions: string[] = [];
  closed = false;
  readonly keyboard = {
    type: async (text: string): Promise<void> => { this.actions.push(`type:${text}`); },
    press: async (key: string): Promise<void> => { this.actions.push(`press:${key}`); }
  };

  constructor(public readonly pageUrl: string, public readonly spec: FakePageSpec) {}

  url(): string { return this.pageUrl; }
  async waitForTimeout(_ms: number): Promise<void> { /* no-op */ }
  async close(): Promise<void> { this.closed = true; }

  /** Evaluate canned: không arg (scroll/thu YT) → []; có arg (payload thu TikTok) → spec.collect. */
  async evaluate<T>(_fn: (arg?: unknown) => T, arg?: unknown): Promise<T> {
    void _fn;
    return (arg === undefined ? [] : (this.spec.collect ?? [])) as T;
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator(this, selector, undefined);
  }
}

class FakeLocator {
  constructor(
    private readonly page: FakeDomPage,
    private readonly selector: string,
    private readonly row: FakeRowSpec | undefined
  ) {}

  first(): FakeLocator { return this.nth(0); }
  nth(index: number): FakeLocator {
    const role = roleOf(this.selector);
    const rows = this.page.spec.rows ?? [];
    const row = role === 'thread' || role === 'item' ? rows[index] : this.row;
    return new FakeLocator(this.page, this.selector, row);
  }

  async count(): Promise<number> {
    const role = roleOf(this.selector);
    if (role === 'thread' || role === 'item') return (this.page.spec.rows ?? []).length;
    return this.row === undefined ? 0 : 1;
  }

  async textContent(): Promise<string | null> {
    const role = roleOf(this.selector);
    const row = this.row;
    if (row === undefined) return null;
    if (role === 'author') return row.author;
    if (role === 'content') return row.text;
    if (role === 'input') return row.editorText ?? '';
    return null;
  }

  async isVisible(): Promise<boolean> {
    const role = roleOf(this.selector);
    const row = this.row;
    if (row === undefined) return false;
    if (role === 'reply') return row.replyBtnVisible === true;
    if (role === 'input') return row.inputVisible === true || row.replyOpened === true;
    if (role === 'submit') return row.replyOpened === true;
    return role !== 'unknown';
  }

  async click(): Promise<void> {
    const role = roleOf(this.selector);
    const row = this.row;
    if (role === 'reply' && row !== undefined) {
      this.page.actions.push('click:reply');
      if (row.replyBtnThrows === true) throw new Error('reply click failed');
      row.replyOpened = true;
      return;
    }
    if (role === 'submit' && row !== undefined) {
      this.page.actions.push('click:submit');
      if (row.submitThrows === true) throw new Error('submit click failed');
      if (row.submitClears === true) row.editorText = '';
      return;
    }
    this.page.actions.push(`click:${this.selector}`);
  }

  async fill(value: string): Promise<void> {
    this.page.actions.push(`fill:${this.selector}`);
    if (this.row !== undefined) this.row.editorText = value;
  }

  async type(value: string): Promise<void> {
    this.page.actions.push(`type:${value}`);
    if (this.row !== undefined) this.row.editorText = `${this.row.editorText ?? ''}${value}`;
  }

  async press(_key: string): Promise<void> { this.page.actions.push('press:locator'); }
  async scrollIntoViewIfNeeded(): Promise<void> { this.page.actions.push('scrollIntoView'); }
  async waitFor(_options?: { state?: string; timeout?: number }): Promise<void> { /* no-op */ }
  async getAttribute(_name: string): Promise<string | null> { return null; }

  /** Locator lồng nhau (row.locator(...)) — giữ phạm vi hàng hiện tại. */
  locator(selector: string): FakeLocator {
    return new FakeLocator(this.page, selector, this.row);
  }
}

/** Launcher giả định tuyến theo URL → spec trang. */
function fakeDomLauncher(
  routes: Array<{ match: (url: string) => boolean; spec: FakePageSpec }>,
  openedUrls: string[] = []
): SocialBrowserLauncher {
  return async () => ({
    async newPage(url?: string) {
      const urlText = url ?? '';
      openedUrls.push(urlText);
      const found = routes.find(route => route.match(urlText));
      return new FakeDomPage(urlText, found?.spec ?? {});
    },
    async close() { /* profile giữ nguyên */ }
  });
}

/** fetch giả định tuyến theo URL + method. */
function fakeFetch(routes: Array<{
  test: (url: string, method: string) => boolean;
  reply: (url: string, method: string) => { status?: number; body: unknown | string };
}>): typeof fetch {
  return (async (url: string | URL, request?: RequestInit) => {
    const text = typeof url === 'string' ? url : url.toString();
    const method = (request?.method ?? 'GET').toUpperCase();
    for (const route of routes) {
      if (route.test(text, method)) {
        const reply = route.reply(text, method);
        const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
        return new Response(body, { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

type ClusterSeed = {
  id: string;
  name: string;
  fbPageId?: string;
  fbToken?: string | null;
  ytChannelUrl?: string;
  tkProfileUrl?: string;
  autoReplyEnabled?: boolean;
};

function seedCluster(db: SocialDB, seed: ClusterSeed): string {
  createClusterRow(db, {
    id: seed.id,
    name: seed.name,
    seriesName: 'Series',
    proxyServer: '',
    fbMode: 'graph_api',
    fbPageId: seed.fbPageId ?? '',
    fbPageTokenEncrypted: seed.fbToken === undefined ? null : seed.fbToken,
    defaultScheduleTimes: ['19:30'],
    defaultDescription: '',
    ...(seed.ytChannelUrl !== undefined ? { ytChannelUrl: seed.ytChannelUrl } : {}),
    ...(seed.tkProfileUrl !== undefined ? { tkProfileUrl: seed.tkProfileUrl } : {}),
    ...(seed.autoReplyEnabled !== undefined ? { autoReplyEnabled: seed.autoReplyEnabled } : {}),
    nowISO: '2026-10-19T00:00:00.000Z'
  });
  return seed.id;
}

function seedJob(db: SocialDB, clusterId: string, clusterName: string, id: string): string {
  insertJobRow(db, {
    id, clusterId, clusterName, videoPath: 'D:/v.mp4', thumbnailPath: null,
    title: 'Tập 1', description: '', scheduledAt: '2026-10-19T08:00:00.000Z', nowISO: '2026-10-19T08:00:00.000Z'
  });
  return id;
}

function createComments(
  db: SocialDB,
  launcher: SocialBrowserLauncher,
  fetchFn: typeof fetch
): SocialComments {
  const worker = createWorker(launcher, db);
  return createSocialComments({
    db,
    worker,
    decryptToken: token => token ?? '',
    readLlmConfig: async () => null,
    scanIntervalMs: 0,
    fetchFn,
    now: () => '2026-10-19T12:00:00.000Z',
    log: () => undefined
  });
}

function createWorker(launcher: SocialBrowserLauncher, db: SocialDB) {
  const worker = createSocialWorker({ tickIntervalMs: 0, browserLauncher: launcher });
  worker.bind({ db, screenshotDir: join('.', 'shots'), profileRoot: join('.', 'profiles'), decryptToken: () => '' });
  return worker;
}

// ---------------------------------------------------------------------------
// Id tổng hợp TikTok
// ---------------------------------------------------------------------------

describe('social comments — id tổng hợp TikTok', () => {
  it('stableHash deterministic + synthetic id ổn định theo (author|text|order)', () => {
    expect(stableHash('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(stableHash('abc')).toBe(stableHash('abc'));
    const id1 = syntheticTikTokCommentId('tkvid_1', '@mai', 'Tập này hay quá!', 0);
    expect(id1).toBe(syntheticTikTokCommentId('tkvid_1', '@mai', 'Tập này hay quá!', 0));
    expect(id1).toBe(`tt:tkvid_1:${stableHash('@mai|Tập này hay quá!|0')}`);
    expect(id1).not.toBe(syntheticTikTokCommentId('tkvid_1', '@mai', 'Tập này hay quá!', 1));
    expect(id1).not.toBe(syntheticTikTokCommentId('tkvid_2', '@mai', 'Tập này hay quá!', 0));
  });
});

// ---------------------------------------------------------------------------
// Quét TikTok qua DOM
// ---------------------------------------------------------------------------

describe('social comments — quét TikTok qua DOM trang video', () => {
  it('parse N comment, id tổng hợp ổn định → quét lần 2 dedupe', async () => {
    const dir = await tempRoot('social-comments-tk-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = seedCluster(db, { id: 'cluster_tk', name: 'Cụm TK', tkProfileUrl: 'tiktok.com/@kenhphim' });
    seedJob(db, clusterId, 'Cụm TK', 'jobtk1');
    updateJobRow(db, 'jobtk1', { tk_status: 'published', tk_video_id: 'tkvid_1', updated_at: '2026-10-19T08:30:00.000Z' });

    const collect: FakeCollectEntry[] = [
      { author: '@mai', text: 'Tập này hay quá!', realId: null, order: 0 },
      { author: '@binh', text: 'Xem tiếp được không ạ?', realId: null, order: 1 }
    ];
    const openedUrls: string[] = [];
    const launcher = fakeDomLauncher([
      { match: url => url.includes('tiktok.com/@kenhphim/video/tkvid_1'), spec: { collect } }
    ], openedUrls);

    const comments = createComments(db, launcher, fakeFetch([]));
    const result = await comments.scan(clusterId);

    expect(result.videosScanned).toBe(1);
    expect(result.newComments).toBe(2);
    expect(result.errors).toEqual([]);
    expect(openedUrls.some(url => url === 'https://www.tiktok.com/@kenhphim/video/tkvid_1')).toBe(true);

    const rows = listCommentRows(db, { clusterId });
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.platform === 'tiktok')).toBe(true);
    expect(rows.every(row => row.external_video_id === 'tkvid_1')).toBe(true);
    const rowMai = rows.find(row => row.author === '@mai');
    expect(rowMai?.external_comment_id).toBe(syntheticTikTokCommentId('tkvid_1', '@mai', 'Tập này hay quá!', 0));
    expect(rowMai?.comment_created_at).toBeNull();

    // Quét lại cùng dữ liệu → id tổng hợp trùng → không comment mới.
    const second = await comments.scan(clusterId);
    expect(second.newComments).toBe(0);

    comments.close();
    db.close();
  });

  it('comment có id thật (data-comment-id) → dùng id thật thay vì tổng hợp', async () => {
    const dir = await tempRoot('social-comments-tkid-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = seedCluster(db, { id: 'cluster_tk', name: 'Cụm TK', tkProfileUrl: 'tiktok.com/@kenhphim' });
    seedJob(db, clusterId, 'Cụm TK', 'jobtk1');
    updateJobRow(db, 'jobtk1', { tk_status: 'published', tk_video_id: 'tkvid_9', updated_at: '2026-10-19T08:30:00.000Z' });

    const launcher = fakeDomLauncher([
      {
        match: url => url.includes('tiktok.com/@kenhphim/video/tkvid_9'),
        spec: { collect: [{ author: '@real', text: 'Bình luận có id', realId: 'cmt_real_9', order: 0 }] }
      }
    ]);
    const comments = createComments(db, launcher, fakeFetch([]));
    await comments.scan();

    const rows = listCommentRows(db, { clusterId });
    expect(rows.map(row => row.external_comment_id)).toContain('cmt_real_9');
    comments.close();
    db.close();
  });

  it('newPage lỗi → errors có dòng tiktok, scan không chết', async () => {
    const dir = await tempRoot('social-comments-tkerr-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = seedCluster(db, { id: 'cluster_tk', name: 'Cụm TK', tkProfileUrl: 'tiktok.com/@kenhphim' });
    seedJob(db, clusterId, 'Cụm TK', 'jobtk1');
    updateJobRow(db, 'jobtk1', { tk_status: 'published', tk_video_id: 'tkvid_1', updated_at: '2026-10-19T08:30:00.000Z' });

    const launcher: SocialBrowserLauncher = async () => ({
      async newPage() { throw new Error('browser crashed'); },
      async close() { /* no-op */ }
    });
    const comments = createComments(db, launcher, fakeFetch([]));
    const result = await comments.scan(clusterId);

    expect(result.errors.some(error => error.includes('tiktok') && error.includes('browser crashed'))).toBe(true);
    expect(listCommentRows(db, { clusterId })).toHaveLength(0);
    comments.close();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Tự trả lời qua DOM
// ---------------------------------------------------------------------------

describe('social comments — tự trả lời YouTube qua DOM', () => {
  it('khớp author+text → bấm reply → điền → submit → status sent', async () => {
    const dir = await tempRoot('social-comments-ytreply-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = seedCluster(db, { id: 'cluster_yt', name: 'Cụm YT', ytChannelUrl: 'https://www.youtube.com/@kenhphim', autoReplyEnabled: true });
    seedJob(db, clusterId, 'Cụm YT', 'jobyt1');
    updateJobRow(db, 'jobyt1', { yt_status: 'published', yt_video_id: 'ytvid1', updated_at: '2026-10-19T08:30:00.000Z' });

    upsertCommentRow(db, {
      jobId: 'jobyt1', clusterId, platform: 'youtube', externalVideoId: 'ytvid1',
      externalCommentId: 'Ugx_match_1', author: 'Mai', text: 'Tập 1 hay quá!',
      commentCreatedAt: null, nowISO: '2026-10-19T09:00:00.000Z'
    });

    const rowState: FakeRowSpec = { author: 'Mai', text: 'Tập 1 hay quá!', replyBtnVisible: true, submitClears: true };
    const launcher = fakeDomLauncher([
      { match: url => url.includes('youtube.com/watch?v=ytvid1'), spec: { rows: [rowState] } }
    ]);
    const comments = createComments(db, launcher, fakeFetch([]));
    const result = await comments.scan(clusterId);

    expect(result.repliesAttempted).toBeGreaterThanOrEqual(1);
    expect(result.repliesSent).toBe(1);
    const rows = listCommentRows(db, { clusterId, replyStatus: 'sent' });
    const replied = rows.find(row => row.external_comment_id === 'Ugx_match_1');
    expect(replied?.reply_status).toBe('sent');
    expect(replied?.reply_text).toBeTruthy();
    expect(replied?.replied_at).toBeTruthy();
    comments.close();
    db.close();
  });

  it('không tìm thấy comment khớp trong DOM → failed + reason rõ', async () => {
    const dir = await tempRoot('social-comments-ytmiss-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = seedCluster(db, { id: 'cluster_yt', name: 'Cụm YT', ytChannelUrl: 'https://www.youtube.com/@kenhphim', autoReplyEnabled: true });
    seedJob(db, clusterId, 'Cụm YT', 'jobyt1');
    updateJobRow(db, 'jobyt1', { yt_status: 'published', yt_video_id: 'ytvid2', updated_at: '2026-10-19T08:30:00.000Z' });

    upsertCommentRow(db, {
      jobId: 'jobyt1', clusterId, platform: 'youtube', externalVideoId: 'ytvid2',
      externalCommentId: 'Ugx_miss', author: 'Mai', text: 'Tập 2 hay quá',
      commentCreatedAt: null, nowISO: '2026-10-19T09:00:00.000Z'
    });

    const launcher = fakeDomLauncher([
      {
        match: url => url.includes('youtube.com/watch?v=ytvid2'),
        spec: { rows: [{ author: 'Bình', text: 'Comment khác hẳn', replyBtnVisible: true, submitClears: true }] }
      }
    ]);
    const comments = createComments(db, launcher, fakeFetch([]));
    const result = await comments.scan(clusterId);

    expect(result.repliesSent).toBe(0);
    const rows = listCommentRows(db, { clusterId, replyStatus: 'failed' });
    const failed = rows.find(row => row.external_comment_id === 'Ugx_miss');
    expect(failed?.reply_status).toBe('failed');
    expect(failed?.skipped_reason).toContain('Chưa tự đăng được');
    comments.close();
    db.close();
  });

  it('submit xong editor vẫn chứa chữ → coi như thất bại → failed', async () => {
    const dir = await tempRoot('social-comments-ytstuck-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = seedCluster(db, { id: 'cluster_yt', name: 'Cụm YT', ytChannelUrl: 'https://www.youtube.com/@kenhphim', autoReplyEnabled: true });
    seedJob(db, clusterId, 'Cụm YT', 'jobyt1');
    updateJobRow(db, 'jobyt1', { yt_status: 'published', yt_video_id: 'ytvid3', updated_at: '2026-10-19T08:30:00.000Z' });

    upsertCommentRow(db, {
      jobId: 'jobyt1', clusterId, platform: 'youtube', externalVideoId: 'ytvid3',
      externalCommentId: 'Ugx_stuck', author: 'Mai', text: 'Tập 3 hay quá',
      commentCreatedAt: null, nowISO: '2026-10-19T09:00:00.000Z'
    });

    const launcher = fakeDomLauncher([
      {
        match: url => url.includes('youtube.com/watch?v=ytvid3'),
        spec: { rows: [{ author: 'Mai', text: 'Tập 3 hay quá', replyBtnVisible: true, submitClears: false }] }
      }
    ]);
    const comments = createComments(db, launcher, fakeFetch([]));
    await comments.scan(clusterId);

    const failed = listCommentRows(db, { clusterId, replyStatus: 'failed' })
      .find(row => row.external_comment_id === 'Ugx_stuck');
    expect(failed?.skipped_reason).toContain('Chưa tự đăng được');
    comments.close();
    db.close();
  });
});

describe('social comments — tự trả lời TikTok qua DOM', () => {
  it('scroll tới comment khớp → trigger → input → submit → sent', async () => {
    const dir = await tempRoot('social-comments-tkreply-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = seedCluster(db, { id: 'cluster_tkr', name: 'Cụm TKR', tkProfileUrl: 'tiktok.com/@kenhphim', autoReplyEnabled: true });
    seedJob(db, clusterId, 'Cụm TKR', 'jobtkr');
    updateJobRow(db, 'jobtkr', { tk_status: 'published', tk_video_id: 'tkvid_1', updated_at: '2026-10-19T08:30:00.000Z' });

    upsertCommentRow(db, {
      jobId: 'jobtkr', clusterId, platform: 'tiktok', externalVideoId: 'tkvid_1',
      externalCommentId: 'tt:tkvid_1:abc', author: '@mai', text: 'Tập này hay quá!',
      commentCreatedAt: null, nowISO: '2026-10-19T09:00:00.000Z'
    });

    const launcher = fakeDomLauncher([
      {
        match: url => url.includes('tiktok.com/@kenhphim/video/tkvid_1'),
        spec: {
          collect: [],
          rows: [{ author: '@mai', text: 'Tập này hay quá!', replyBtnVisible: true, submitClears: true }]
        }
      }
    ]);
    const comments = createComments(db, launcher, fakeFetch([]));
    const result = await comments.scan(clusterId);

    expect(result.repliesSent).toBe(1);
    const sent = listCommentRows(db, { clusterId, replyStatus: 'sent' })
      .find(row => row.external_comment_id === 'tt:tkvid_1:abc');
    expect(sent?.reply_status).toBe('sent');
    expect(sent?.reply_text).toBeTruthy();
    comments.close();
    db.close();
  });

  it('reply trigger không hiện → failed + reason rõ', async () => {
    const dir = await tempRoot('social-comments-tkmiss-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = seedCluster(db, { id: 'cluster_tkr', name: 'Cụm TKR', tkProfileUrl: 'tiktok.com/@kenhphim', autoReplyEnabled: true });
    seedJob(db, clusterId, 'Cụm TKR', 'jobtkr');
    updateJobRow(db, 'jobtkr', { tk_status: 'published', tk_video_id: 'tkvid_1', updated_at: '2026-10-19T08:30:00.000Z' });

    upsertCommentRow(db, {
      jobId: 'jobtkr', clusterId, platform: 'tiktok', externalVideoId: 'tkvid_1',
      externalCommentId: 'tt:tkvid_1:xyz', author: '@mai', text: 'Tập này hay quá!',
      commentCreatedAt: null, nowISO: '2026-10-19T09:00:00.000Z'
    });

    const launcher = fakeDomLauncher([
      {
        match: url => url.includes('tiktok.com/@kenhphim/video/tkvid_1'),
        spec: { rows: [{ author: '@mai', text: 'Tập này hay quá!' }] }
      }
    ]);
    const comments = createComments(db, launcher, fakeFetch([]));
    await comments.scan(clusterId);

    const failed = listCommentRows(db, { clusterId, replyStatus: 'failed' })
      .find(row => row.external_comment_id === 'tt:tkvid_1:xyz');
    expect(failed?.reply_status).toBe('failed');
    expect(failed?.skipped_reason).toContain('Chưa tự đăng được');
    comments.close();
    db.close();
  });
});

describe('social comments — Facebook (regression Graph)', () => {
  it('đọc comment + đăng reply qua Graph như cũ', async () => {
    const dir = await tempRoot('social-comments-fb-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = seedCluster(db, { id: 'cluster_fb', name: 'Cụm FB', fbPageId: '111', fbToken: 'page-token', autoReplyEnabled: true });
    seedJob(db, clusterId, 'Cụm FB', 'jobfb1');
    updateJobRow(db, 'jobfb1', { fb_status: 'published', fb_video_id: 'vid_fb_1', updated_at: '2026-10-19T08:30:00.000Z' });

    const postedReplies: string[] = [];
    const fetchMock = fakeFetch([
      {
        test: (url, method) => method === 'GET' && url.includes('/vid_fb_1/comments'),
        reply: () => ({ body: { data: [
          { id: 'cmt_fb_1', message: 'Tập 17 hay quá!', created_time: '2026-10-19T05:00:00Z', from: { name: 'Mai' } }
        ] } })
      },
      {
        test: (url, method) => method === 'POST' && url.includes('/cmt_fb_1/comments'),
        reply: url => {
          postedReplies.push(url);
          return { body: { id: 'reply_1' } };
        }
      }
    ]);

    const comments = createComments(db, async () => ({
      async newPage() { throw new Error('không được mở browser'); },
      async close() { /* không mở được thì không cần đóng */ }
    }), fetchMock);
    const result = await comments.scan(clusterId);

    expect(result.newComments).toBe(1);
    expect(result.repliesSent).toBe(1);
    expect(postedReplies[0]).toContain('/cmt_fb_1/comments');
    const replied = listCommentRows(db, { clusterId, replyStatus: 'sent' })
      .find(row => row.external_comment_id === 'cmt_fb_1');
    expect(replied?.reply_status).toBe('sent');
    comments.close();
    db.close();
  });
});

describe('social comments — guardrails', () => {
  it('cap 25 reply/ngày/cụm — đã đủ hạn mức thì không thử thêm', async () => {
    const dir = await tempRoot('social-comments-cap-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = seedCluster(db, { id: 'cluster_cap', name: 'Cụm Cap', ytChannelUrl: 'https://www.youtube.com/@kenhphim', autoReplyEnabled: true });
    seedJob(db, clusterId, 'Cụm Cap', 'jobcap');
    updateJobRow(db, 'jobcap', { yt_status: 'published', yt_video_id: 'ytvid1', updated_at: '2026-10-19T08:30:00.000Z' });

    // Điền đúng hạn mức hôm nay (clock thật vì repliedToday dùng Date thật).
    const repliedAt = new Date().toISOString();
    for (let index = 0; index < MAX_AUTO_REPLIES_PER_DAY; index += 1) {
      upsertCommentRow(db, {
        jobId: 'jobcap', clusterId, platform: 'youtube', externalVideoId: 'ytvid1',
        externalCommentId: `cap_cmt_${index}`, author: 'U', text: `cmt ${index}`,
        commentCreatedAt: null, nowISO: repliedAt
      });
      updateCommentRow(db, index + 1, { reply_status: 'sent', replied_at: repliedAt });
    }
    upsertCommentRow(db, {
      jobId: 'jobcap', clusterId, platform: 'youtube', externalVideoId: 'ytvid1',
      externalCommentId: 'cap_pending', author: 'Mai', text: 'Tập 1 hay quá',
      commentCreatedAt: null, nowISO: repliedAt
    });

    const launcher = fakeDomLauncher([
      {
        match: url => url.includes('youtube.com/watch?v=ytvid1'),
        spec: { rows: [{ author: 'Mai', text: 'Tập 1 hay quá', replyBtnVisible: true, submitClears: true }] }
      }
    ]);
    const comments = createComments(db, launcher, fakeFetch([]));
    const result = await comments.scan(clusterId);

    expect(result.repliesAttempted).toBe(0);
    expect(result.repliesSent).toBe(0);
    const pending = listCommentRows(db, { clusterId, replyStatus: 'pending' });
    expect(pending.some(row => row.external_comment_id === 'cap_pending')).toBe(true);
    comments.close();
    db.close();
  });

  it('comment spam → skipped, không tốn hạn mức', async () => {
    const dir = await tempRoot('social-comments-spam-');
    const db = openSocialDatabase(join(dir, 'social.sqlite'));
    const clusterId = seedCluster(db, { id: 'cluster_spam', name: 'Cụm Spam', ytChannelUrl: 'https://www.youtube.com/@kenhphim', autoReplyEnabled: true });
    seedJob(db, clusterId, 'Cụm Spam', 'jobspam');
    updateJobRow(db, 'jobspam', { yt_status: 'published', yt_video_id: 'ytvid1', updated_at: '2026-10-19T08:30:00.000Z' });

    upsertCommentRow(db, {
      jobId: 'jobspam', clusterId, platform: 'youtube', externalVideoId: 'ytvid1',
      externalCommentId: 'spam_1', author: 'Ads', text: 'Muafollow giá rẻ hotline 09xx',
      commentCreatedAt: null, nowISO: '2026-10-19T09:00:00.000Z'
    });

    const launcher = fakeDomLauncher([
      { match: url => url.includes('youtube.com/watch'), spec: { rows: [] } }
    ]);
    const comments = createComments(db, launcher, fakeFetch([]));
    const result = await comments.scan(clusterId);

    expect(result.repliesAttempted).toBe(0);
    const skipped = listCommentRows(db, { clusterId, replyStatus: 'skipped' })
      .find(row => row.external_comment_id === 'spam_1');
    expect(skipped?.reply_status).toBe('skipped');
    expect(skipped?.skipped_reason).toContain('spam');
    comments.close();
    db.close();
  });

  it('isSpam vẫn hoạt động như cũ', () => {
    expect(isSpam('Liên hệ hotline 09xx để quảng cáo')).toBe(true);
    expect(isSpam('Tập 17 quá hay, cám ơn kênh')).toBe(false);
  });
});
