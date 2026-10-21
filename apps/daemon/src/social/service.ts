/**
 * Service Mạng Lưới Đăng Đa Kênh: hợp nhất db + Auto-Slot + kiểm tra proxy +
 * worker upload. API bám kiểu TranslationPipelineService cho routes/tools dùng.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  closeSocialDatabase,
  createClusterRow,
  deleteClusterRow,
  deleteJobRow,
  findActiveDuplicateJob,
  getClusterRow,
  getJobRow,
  insertJobRow,
  kvGet,
  kvSet,
  listClusterRows,
  listJobRows,
  mapCluster,
  mapJob,
  openSocialDatabase,
  recoverRunningJobs,
  updateClusterRow,
  updateJobRow,
  type SocialDB,
  type SocialJobRow
} from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { nextAvailableSlot } from './scheduler.js';
import { checkProxy } from './proxy-check.js';
import { createSocialAnalytics } from './analytics.js';
import { spawnCreatorProcess } from '../creator/process-tree.js';
import type { YtDlpRuntime } from '../creator/yt-dlp/runtime.js';
import { createSocialComments, type SocialLlmConfig } from './comments.js';
import { aiComposeVideoMeta, aiTestReply, type SocialAiCompose, type SocialAiReplyTestInput } from './ai.js';
import { listDownloadedVideos, type SocialDownloadItem } from './downloads.js';
import { createYoutubeChannel } from './platforms/youtube-channel.js';
import { createFacebookPage, signUpTiktokViaGoogle } from './platforms/account-signup.js';
import { createFacebookAccountWithGmail, isFacebookSignedIn } from './platforms/facebook-account.js';
import { readGmailAccountEmail, readGmailConfirmationCode } from './platforms/gmail.js';
import { loginFacebook, waitForFacebookSession } from './platforms/facebook-login.js';
import type { SocialWorker } from './worker.js';
import {
  SOCIAL_PLATFORM_LOGIN_URLS,
  sanitizePlatformSettings,
  type SocialCluster,
  type SocialClusterView,
  type SocialComment,
  type SocialCommentScanResult,
  type SocialEnqueueRequest,
  type SocialJob,
  type SocialOverview,
  type SocialPlatform,
  type SocialPlatformState,
  type SocialQueueState,
  type SocialStatsOverview
} from './types.js';

export type SocialServiceInput = {
  dataDir: string;
  worker: SocialWorker;
  /** Đè khi kiểm thử (mặc định đo proxy thật). */
  checkProxyFn?: typeof checkProxy;
  /** GĐ3: cấu hình LLM để tự trả lời bình luận (không có → mẫu mặc định). */
  readLlmConfig?: () => Promise<SocialLlmConfig | null>;
  /**
   * Nguồn thư mục gốc chứa video đã tải về (media picker): trả về downloadRoot
   * người dùng cấu hình hoặc mặc định. Không cấu hình → danh sách downloads rỗng.
   */
  readDownloadsRoot?: () => Promise<string | undefined>;
  /** GĐ3: khoảng quét thống kê/bình luận; 0/âm → chỉ chạy khi gọi thủ công. */
  analyticsRefreshIntervalMs?: number;
  commentsScanIntervalMs?: number;
  now?: () => string;
  /** YouTube Data API v3 key (tùy chọn) — quét thống kê bằng API thay vì trình duyệt. */
  readYoutubeApiKey?: () => Promise<string | null | undefined>;
  /**
   * Runtime yt-dlp đóng gói: cho TikTok quét thống kê không cần trình duyệt.
   * Không có → TikTok vẫn quét bằng trình duyệt của cụm (fallback).
   */
  getYtDlpRuntime?: () => YtDlpRuntime | undefined;
};

export type SocialClusterPatch = {
  name?: string;
  seriesName?: string;
  proxyServer?: string;
  fbMode?: 'graph_api' | 'browser';
  fbPageId?: string;
  fbPageToken?: string | null;
  defaultScheduleTimes?: string[];
  defaultDescription?: string;
  ytChannelUrl?: string;
  tkProfileUrl?: string;
  autoReplyEnabled?: boolean;
  autoReplyPrompt?: string;
  /** GĐ4: bật tự nạp đăng sau khi pipeline dịch xong (hook của daemon). */
  autoPublishAfterTranslate?: boolean;
};

export type SocialService = {
  getOverview(): SocialOverview;
  createCluster(patch: SocialClusterPatch & { name: string }): SocialOverview;
  updateCluster(clusterId: string, patch: SocialClusterPatch): SocialOverview;
  deleteCluster(clusterId: string): SocialOverview;
  checkClusterProxy(clusterId: string): Promise<SocialOverview>;
  openClusterBrowser(clusterId: string): Promise<SocialOverview>;
  closeClusterBrowser(clusterId: string): Promise<SocialOverview>;
  /** Mở tab trang đăng nhập của nền tảng trong trình duyệt persistent cụm (người dùng tự đăng nhập). */
  openClusterLoginPage(clusterId: string, platform: SocialPlatform): Promise<{ ok: true }>;
  /** Xác minh phiên đăng nhập (đọc cookie profile cụm) + cập nhật loginStatus. */
  verifyClusterLogin(clusterId: string, platform: SocialPlatform): Promise<{ ok: boolean; status: 'ok' | 'unknown' | 'expired'; needsChannel?: boolean; accountName?: string; channelId?: string; channelUrl?: string }>;
  /** Tạo kênh YouTube (Brand Account) khi tài khoản đã đăng nhập nhưng chưa có kênh. */
  createClusterYoutubeChannel(clusterId: string, channelName: string): Promise<{ ok: boolean; channelId?: string; channelName?: string; error?: string }>;
  /** Tạo tài khoản/kênh TikTok (qua Google) hoặc Facebook Page khi cụm chưa có tài khoản. */
  createClusterSocialAccount(clusterId: string, platform: SocialPlatform, options?: { name?: string }): Promise<{ ok: boolean; needsManual?: boolean; message?: string; accountName?: string; accountUrl?: string }>;
  /**
   * Đăng nhập Facebook tự động trong trình duyệt cụm: điền email (+mật khẩu nếu
   * có) và tự lưu phiên khi cookie c_user/xs xuất hiện.
   */
  loginFacebook(clusterId: string, options?: { email?: string; password?: string }): Promise<{ ok: boolean; needsManual?: boolean; message?: string; accountName?: string }>;
  /** Lưu thông tin đăng nhập Facebook cho cụm (mật khẩu mã hóa, không bao giờ trả ra API). */
  saveFacebookCredentials(clusterId: string, credentials: { email: string; password: string }): Promise<{ ok: boolean; email: string }>;
  /** Nạp video vào hàng đợi; trả summary + số nạp + danh sách path bị bỏ qua. */
  enqueue(requests: readonly SocialEnqueueRequest[]): { summary: SocialOverview; accepted: number; duplicates: string[] };
  pause(): SocialOverview;
  resume(): SocialOverview;
  removeJob(jobId: string): SocialOverview;
  /** Đổi giờ công khai của job chưa đăng xong; xong luôn đánh thức worker xếp lại slot. */
  rescheduleJob(jobId: string, scheduledAt: string): SocialOverview;
  /** Video đã tải về trong thư mục gốc downloads (media picker; chỉ đọc). */
  listDownloads(limit?: number): Promise<{ items: SocialDownloadItem[] }>;
  retryFailedPlatforms(jobId: string): SocialOverview;
  /** GĐ3: thống kê view/sub đã lưu + quét ngay khi cần. */
  getStats(): SocialStatsOverview;
  refreshStats(): Promise<SocialStatsOverview>;
  /** GĐ3: bình luận gần đây + quét/AI trả lời theo yêu cầu. */
  listComments(clusterId?: string, limit?: number): SocialComment[];
  scanComments(clusterId?: string): Promise<SocialCommentScanResult>;
  /**
   * GĐ4 — tự nạp đăng sau dịch (hook gọi từ daemon khi pipeline dịch xong 1 tập):
   * tìm mọi cụm đang bật autoPublishAfterTranslate và xếp video vào hàng đợi
   * của từng cụm (không truyền scheduledAt → Auto-Slot khung giờ vàng).
   */
  enqueueAfterTranslate(request: SocialAfterTranslateRequest): {
    accepted: number;
    duplicates: string[];
    /** id các cụm bật tự nạp đã xử lý (nạp mới hoặc trùng — để log/diag). */
    clusters: string[];
  };
  /** AI tích hợp sẵn: sinh tiêu đề + mô tả + hashtag chuẩn SEO cho 1 video. */
  aiComposeVideoMeta(input: { videoTitle: string; language?: string }): Promise<SocialAiCompose>;
  /** AI tích hợp sẵn: thử phản hồi bình luận — chỉ sinh chữ, không đăng thật. */
  aiTestReply(input: SocialAiReplyTestInput): Promise<{ reply: string; fallbackUsed: boolean }>;
  /** Đọc raw selectors.json đang dùng (Trình Soi Lỗi → Sửa Selector Nóng). */
  getSelectors(): Promise<{ selectors: string }>;
  /** Ghi selectors.json mới (tự tạo bản .bak trước) — job đăng sau áp dụng ngay. */
  saveSelectors(selectors: string): Promise<{ selectors: string }>;
  close(): Promise<void>;
};

export type SocialAfterTranslateRequest = {
  /** File video đã dịch xong (đường dẫn tuyệt đối trên đĩa). */
  path: string;
  title: string;
  /** null/undefined → không ghép đuôi " — Tập n". */
  episodeIndex?: number | null;
  /** Passthrough từ pipeline enqueue (A3) — chỉ mang theo, social không dùng. */
  projectId?: string | null;
};

export class SocialError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SocialError';
  }
}

/** Nền tảng hợp lệ (youtube | tiktok | facebook). */
function isSocialPlatform(value: string): value is SocialPlatform {
  return value === 'youtube' || value === 'tiktok' || value === 'facebook';
}

/**
 * Cookie đặc trưng của phiên đăng nhập từng nền tảng:
 * - YouTube/Google: SID / SSID / APISID / __Secure-3PSID
 * - TikTok: sessionid / sessionid_ss
 * - Facebook: c_user / xs / datr
 */
const LOGIN_COOKIE_NAMES: Record<SocialPlatform, string[]> = {
  youtube: ['SID', 'SSID', 'APISID', '__Secure-3PSID', '__Secure-1PSID'],
  tiktok: ['sessionid', 'sessionid_ss', 'sid_tt'],
  facebook: ['c_user', 'xs', 'datr', 'sb']
};

/** Có cookie đăng nhập hợp lệ của nền tảng trong profile cụm không? */
export function hasLoginCookie(
  platform: SocialPlatform,
  cookies: ReadonlyArray<{ name: string; value: string; domain: string }>
): boolean {
  const names = LOGIN_COOKIE_NAMES[platform];
  return cookies.some(cookie =>
    names.includes(cookie.name) && cookie.value.trim() !== ''
  );
}

/**
 * Đọc thông tin kênh đã liên kết từ YouTube.
 * Cách ổn định: mở `youtube.com/@me` — khi đã đăng nhập, YouTube chuyển hướng
 * tới trang kênh của bạn (URL chứa `@handle` hoặc `/channel/UC…`) và tiêu đề
 * trang = "<Tên kênh> - YouTube". Khi CHƯA đăng nhập ⇒ bị chuyển về
 * accounts.google.com hoặc trả 404 ⇒ coi như chưa đăng nhập (không báo
 * "✔ Đã đăng nhập" giả).
 */
export async function readYoutubeAccount(
  handle: { newPage(url?: string): Promise<unknown> }
): Promise<{ signedIn: boolean; needsChannel?: boolean; name?: string; channelId?: string; channelUrl?: string }> {
  type Page = {
    url(): string;
    title(): Promise<string>;
    waitForTimeout(ms: number): Promise<void>;
    evaluate<T>(fn: (arg?: unknown) => T, arg?: unknown): Promise<T>;
    goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
    click(selector: string, options?: { timeout?: number }): Promise<void>;
    close(): Promise<void>;
  };
  let page: Page | undefined;
  try {
    // Bước 1: web đã cấp phiên chưa?
    // (không dùng #email vì chỉ hiện sau khi mở menu avatar — dùng sự hiện diện
    //  của nút avatar/menu tài khoản ở thanh trên cùng hoặc mục "You" trong sidebar)
    page = await handle.newPage('https://www.youtube.com/') as Page;
    await page.waitForTimeout(4_000);
    const signedInWeb = await page
      .evaluate(() => {
        const selectors = [
          'ytd-topbar-menu-button',
          '#avatar',
          'yt-avatar-shape',
          'ytd-masthead #avatar',
          'a[href*="/feed/history"]',
          'ytd-guide-renderer a[title*="You"]',
          'ytd-mini-guide-renderer a[title*="You"]'
        ];
        for (const selector of selectors) {
          if (document.querySelector(selector) !== null) return true;
        }
        return false;
      })
      .catch(() => false);
    if (!signedInWeb) return { signedIn: false };

    // Bước 2: đã đăng nhập — tìm kênh của chính mình.
    // (Personal Channel không dùng /@me → luôn đọc link kênh trong menu avatar)
    await page
      .click('ytd-topbar-menu-button #avatar-btn, #avatar-btn, ytd-topbar-menu-button', { timeout: 5_000 })
      .catch(() => undefined);
    await page.waitForTimeout(2_500);
    const ownHandle = await page
      .evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href^="/@"]'));
        for (const link of links) {
          const href = link.getAttribute('href') ?? '';
          if (href.length > 2) return href;
        }
        return '';
      })
      .catch(() => '');
    if (ownHandle === '') {
      // Không thấy kênh nào ⇒ tài khoản chưa có kênh (cần tạo).
      return { signedIn: true, needsChannel: true };
    }
    await page.goto(`https://www.youtube.com${ownHandle}`).catch(() => undefined);
    await page.waitForTimeout(3_500);
    const url = page.url();
    const rawTitle = await page.title().catch(() => '');
    const channelMatch = /\/channel\/(UC[\w-]+)/.exec(url);
    const handleMatch = /youtube\.com\/@([\w.\-]+)/.exec(url);
    const name = rawTitle.replace(/\s*[-–—]\s*YouTube\s*$/i, '').trim();
    const channelUrl = channelMatch?.[1] !== undefined
      ? `https://www.youtube.com/channel/${channelMatch[1]}`
      : handleMatch?.[1] !== undefined
        ? `https://www.youtube.com/@${handleMatch[1]}`
        : `https://www.youtube.com${ownHandle}`;
    return {
      signedIn: true,
      ...(name !== '' && name !== 'YouTube' ? { name } : {}),
      ...(channelMatch?.[1] === undefined ? {} : { channelId: channelMatch[1] }),
      channelUrl
    };
  } catch {
    return { signedIn: false };
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/**
 * Tên tài khoản đã liên kết (nếu lấy được):
 * - Google/YouTube: cookie LOGIN_INFO (base64) chứa email + tên hiển thị.
 */
export function readAccountName(
  platform: SocialPlatform,
  cookies: ReadonlyArray<{ name: string; value: string; domain: string }>
): string | undefined {
  if (platform !== 'youtube') return undefined;
  const loginInfo = cookies.find(cookie => cookie.name === 'LOGIN_INFO');
  if (loginInfo === undefined || loginInfo.value.trim() === '') return undefined;
  try {
    const decoded = Buffer.from(loginInfo.value, 'base64').toString('utf8');
    const parts = decoded.split('\n').map(part => part.replace(/^\u0001/, '').trim()).filter(part => part !== '');
    // Dạng: ["1", "<email>", "1", "<displayName>"] → lấy displayName.
    const name = parts[3];
    return name !== undefined && name !== '' ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Mật khẩu Facebook sinh tự động (đủ mạnh, gửi lại cho người dùng trong thông báo). */
function generateFacebookPassword(): string {
  return `Fb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Đọc tên/URL tài khoản TikTok|Facebook sau khi đăng nhập (mở trang cá nhân
 * để đọc tên hiển thị trong DOM). Không đọc được thì trả rỗng, không báo sai.
 */
async function readSocialProfileName(
  handle: { newPage(url?: string): Promise<unknown> },
  platform: SocialPlatform
): Promise<{ name?: string; url?: string }> {
  const home = platform === 'tiktok' ? 'https://www.tiktok.com/' : 'https://www.facebook.com/';
  let page: {
    url(): string;
    title(): Promise<string>;
    waitForTimeout(ms: number): Promise<void>;
    goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
    evaluate<T>(fn: (arg?: unknown) => T, arg?: unknown): Promise<T>;
    close(): Promise<void>;
  } | undefined;
  try {
    const opened = await handle.newPage(home);
    page = opened as unknown as NonNullable<typeof page>;
    await page.waitForTimeout(5_000);
    // Link trang cá nhân cho biết username (TikTok) / user id (Facebook).
    // Link có thể render muộn ⇒ thử lại vài lần trước khi bỏ cuộc.
    let profileLink = '';
    let profileLinkText = '';
    for (let attempt = 0; attempt < 4 && profileLink === ''; attempt += 1) {
      const found = await page.evaluate((arg: unknown) => {
        const target = (arg ?? {}) as { platform: string };
        const selectors = target.platform === 'tiktok'
          ? ['a[data-e2e="profile-icon"]', 'a[href^="/@"]']
          : ['a[href*="profile.php?id="]', 'a[href*="/profile/"]'];
        for (const selector of selectors) {
          for (const el of Array.from(document.querySelectorAll(selector))) {
            const href = (el.getAttribute('href') ?? '').trim();
            if (href === '') continue;
            if (target.platform === 'tiktok' && href.replace('/@', '').trim() === '') continue;
            return {
              href,
              text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
            };
          }
        }
        return { href: '', text: '' };
      }, { platform }).catch(() => ({ href: '', text: '' }));
      profileLink = found.href;
      profileLinkText = found.text;
      if (profileLink === '') await page.waitForTimeout(2_500).catch(() => undefined);
    }
    if (profileLink !== '') {
      const target = profileLink.startsWith('http')
        ? profileLink
        : new URL(profileLink, home).toString();
      await page.goto(target, { timeout: 30_000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForTimeout(4_000).catch(() => undefined);
    }
    const url = page.url();
    const title = await page.title().catch(() => '');
    const name = await page.evaluate((unused: unknown) => {
      const candidates = [
        '[data-e2e="user-title"]',
        'strong[data-e2e="user-title"]',
        '[data-e2e="unique-username"]',
        'h1'
      ];
      for (const selector of candidates) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim() ?? '';
        if (text !== '' && text.length < 80) return text;
      }
      return '';
    }, null).catch(() => '');
    // Username trong URL trang cá nhân (TikTok: /@ten, Facebook: /profile.php?id=…).
    const urlUser = /\/@([A-Za-z0-9._-]+)/.exec(url)?.[1] ?? '';
    // Title chung của trang chủ KHÔNG phải tên tài khoản.
    const genericTitle = /^(tiktok\s*[-–—]\s*make your day|facebook|log in to facebook|facebook – đăng nhập|meta)$/i;
    const cleanedTitle = genericTitle.test(title.trim()) ? '' : title.replace(/\s*[-–—]\s*(TikTok|Facebook)\s*$/i, '').trim();
    // Tên của các nút/nhãn điều hướng KHÔNG phải tên tài khoản.
    const navWords = /^(trang chủ|thông báo|tin nhắn|home|notifications|messages|settings|cài đặt|tìm bạn bè|trang cá nhân của bạn|bảng tin|menu|watch|reels|shop|groups|marketplace|chơi game)$/i;
    const linkName = profileLinkText !== '' && !navWords.test(profileLinkText) ? profileLinkText : '';
    const pageName = name !== '' && !navWords.test(name) ? name : '';
    // TikTok hiển thị theo @username (đúng như demo), Facebook theo tên hiển thị.
    const label = platform === 'tiktok' && urlUser !== ''
      ? `@${urlUser}`
      : linkName !== '' ? linkName : pageName !== '' ? pageName : urlUser !== '' ? urlUser : cleanedTitle;
    return {
      ...(label !== '' && label.length < 80 ? { name: label } : {}),
      ...(url.includes(platform === 'tiktok' ? 'tiktok.com' : 'facebook.com') ? { url } : {})
    };
  } catch {
    return {};
  } finally {
    await page?.close().catch(() => undefined);
  }
}

export function createSocialService(input: SocialServiceInput): SocialService {
  const now = input.now ?? ((): string => new Date().toISOString());
  const db: SocialDB = openSocialDatabase(join(input.dataDir, 'social.sqlite'));
  const screenshotDir = join(input.dataDir, 'social', 'screenshots');
  const selectorsPath = new URL('./platforms/selectors.json', import.meta.url);
  const profileRoot = join(input.dataDir, 'social', 'profiles');
  const secretKeyPath = join(input.dataDir, 'social', 'secret.key');
  mkdirSync(screenshotDir, { recursive: true });
  const worker = input.worker;

  // Daemon vừa khởi động lại: platform "running" → "pending".
  recoverRunningJobs(db);
  const decryptToken = (token: string | null): string => decryptSecret(token, secretKeyPath);
  worker.bind({ db, screenshotDir, profileRoot, decryptToken });

  // GĐ3: quét thống kê + bình luận định kỳ.
  // yt-dlp runner: spawn runtime đóng gói, timeout 60s, decode UTF-8 (không
  // mở trình duyệt). errors → analytics tự fallback quét trình duyệt cũ.
  const runYtDlpFn = input.getYtDlpRuntime === undefined ? undefined : (args: readonly string[]) => {
    const runtime = input.getYtDlpRuntime!();
    if (runtime === undefined) throw new Error('yt-dlp runtime không khả dụng');
    return spawnYtDlpJson(runtime, args);
  };
  const analytics = createSocialAnalytics({
    db,
    worker,
    decryptToken,
    refreshIntervalMs: input.analyticsRefreshIntervalMs ?? 6 * 60 * 60_000,
    readYoutubeApiKey: async () => {
      const raw = input.readYoutubeApiKey === undefined ? undefined : await input.readYoutubeApiKey();
      return (raw ?? '').trim();
    },
    ...(runYtDlpFn === undefined ? {} : { runYtDlpFn }),
    log: message => { console.log(`[social] ${message}`); }
  });
  /**
   * Theo dõi nền phiên Facebook: người dùng đăng nhập trong cửa sổ trình duyệt
   * của cụm → daemon tự ghi fb_login='ok' + tên tài khoản (UI polling 4s).
   */
  async function watchFacebookSession(
    clusterId: string,
    handle: { cookies?(urls: string[]): Promise<Array<{ name: string; value: string; domain: string }>> },
    email: string
  ): Promise<void> {
    try {
      const signedIn = await waitForFacebookSession(handle as never, 10 * 60_000);
      if (!signedIn) return;
      const patch: Parameters<typeof updateClusterRow>[2] = {
        fb_login: 'ok',
        updated_at: new Date().toISOString()
      };
      if (email !== '') patch.fb_login_email = email;
      const profile = await worker.withClusterBrowser(clusterId, async browserHandle =>
        readSocialProfileName(browserHandle, 'facebook'));
      if (profile.name !== undefined) patch.fb_account_name = profile.name;
      updateClusterRow(db, clusterId, patch);
      console.log(`[social] Facebook đã đăng nhập cho cụm ${clusterId}${profile.name === undefined ? '' : ` (${profile.name})`}`);
    } catch {
      // Bỏ qua: người dùng có thể đóng trình duyệt trước khi đăng nhập xong.
    }
  }

  const readLlmConfig = input.readLlmConfig ?? (async (): Promise<SocialLlmConfig | null> => null);  const comments = createSocialComments({
    db,
    worker,
    decryptToken,
    readLlmConfig,
    scanIntervalMs: input.commentsScanIntervalMs ?? 3 * 60 * 60_000,
    log: message => { console.log(`[social] ${message}`); }
  });

  function snapshotQueueState(): SocialQueueState {
    return kvGet(db, 'queue_state') === 'paused' ? 'paused' : 'running';
  }

  function clusterView(cluster: SocialCluster): SocialClusterView {
    const fbPageTokenEncrypted = cluster.fbPageTokenEncrypted;
    return {
      id: cluster.id,
      name: cluster.name,
      seriesName: cluster.seriesName,
      proxyServer: cluster.proxyServer,
      proxyStatus: cluster.proxyStatus,
      proxyDetail: cluster.proxyDetail,
      loginStatus: cluster.loginStatus,
      fbMode: cluster.fbMode,
      fbPageId: cluster.fbPageId,
      defaultScheduleTimes: cluster.defaultScheduleTimes,
      defaultDescription: cluster.defaultDescription,
      ytChannelUrl: cluster.ytChannelUrl,
      tkProfileUrl: cluster.tkProfileUrl,
      ytAccountName: cluster.ytAccountName,
      ytAccountId: cluster.ytAccountId,
      tkAccountName: cluster.tkAccountName,
      fbAccountName: cluster.fbAccountName,
      fbLoginEmail: cluster.fbLoginEmail,
      needsChannel: cluster.needsChannel,
      autoReplyEnabled: cluster.autoReplyEnabled,
      autoReplyPrompt: cluster.autoReplyPrompt,
      autoPublishAfterTranslate: cluster.autoPublishAfterTranslate,
      fbPageTokenConfigured: fbPageTokenEncrypted !== null && fbPageTokenEncrypted !== '',
      createdAt: cluster.createdAt,
      updatedAt: cluster.updatedAt
    };
  }

  function overview(): SocialOverview {
    const jobs = listJobRows(db).map(row => mapJob(row));
    return {
      queue: snapshotQueueState(),
      counts: summarizeCounts(jobs, now()),
      clusters: listClusterRows(db).map(row => clusterView(mapCluster(row))),
      jobs,
      screenshotDir,
      browserOpenClusters: worker.openClusterIds()
    };
  }

  function enqueueVideos(requests: readonly SocialEnqueueRequest[]): { summary: SocialOverview; accepted: number; duplicates: string[] } {
    const duplicates: string[] = [];
    let accepted = 0;
    // Bản đồ "muộn nhất đang hẹn" theo cụm — để Auto-Slot không xếp trùng.
    const lastScheduledByCluster = new Map<string, string | null>();
    for (const row of listJobRows(db)) {
      const current = lastScheduledByCluster.get(row.cluster_id) ?? null;
      const time = new Date(row.scheduled_at).getTime();
      if (!Number.isNaN(time) && (current === null || time > new Date(current).getTime())) {
        lastScheduledByCluster.set(row.cluster_id, row.scheduled_at);
      }
    }
    for (const request of requests) {
      const cluster = getClusterRow(db, request.clusterId);
      if (cluster === undefined) {
        duplicates.push(request.path.trim());
        continue;
      }
      const videoPath = request.path.trim();
      if (videoPath === '') continue;
      if (findActiveDuplicateJob(db, request.clusterId, videoPath) !== undefined) {
        duplicates.push(videoPath);
        continue;
      }
      const clusterModel = mapCluster(cluster);
      let scheduledAt: string;
      const requested = request.scheduledAt?.trim() ?? '';
      if (requested !== '' && normalizeISO(requested) !== null) {
        scheduledAt = requested;
        // Job hẹn quá khứ/ís ít hơn 10 phút → coi như đăng ngay tại thời điểm đã chỉ.
      } else {
        const lastScheduled = lastScheduledByCluster.get(request.clusterId) ?? null;
        scheduledAt = nextAvailableSlot({
          nowISO: now(),
          scheduleTimes: clusterModel.defaultScheduleTimes,
          lastScheduledISO: lastScheduled
        });
        // Tận dụng Auto-Slot: cập nhật bản đồ để mục sau không đội đầu.
        lastScheduledByCluster.set(request.clusterId, scheduledAt);
      }
      insertJobRow(db, {
        id: `socialjob_${randomUUID().slice(0, 12)}`,
        clusterId: request.clusterId,
        clusterName: clusterModel.name,
        videoPath,
        thumbnailPath: request.thumbnailPath ?? null,
        title: request.title !== undefined && request.title.trim() !== '' ? request.title.trim() : fileName(videoPath),
        description: request.description !== undefined && request.description.trim() !== ''
          ? request.description.trim()
          : clusterModel.defaultDescription,
        scheduledAt,
        platformSettings: sanitizePlatformSettings(request.platformSettings ?? {}),
        nowISO: now()
      });
      accepted += 1;
    }
    if (accepted > 0) worker.kick();
    return { summary: overview(), accepted, duplicates };
  }

  return {
    getOverview(): SocialOverview {
      return overview();
    },

    createCluster(patch: SocialClusterPatch & { name: string }): SocialOverview {
      createClusterRow(db, {
        id: `cluster_${randomUUID().slice(0, 8)}`,
        name: patch.name.trim() || 'Cụm kênh mới',
        seriesName: patch.seriesName?.trim() ?? '',
        proxyServer: patch.proxyServer?.trim() ?? '',
        fbMode: patch.fbMode ?? 'graph_api',
        fbPageId: patch.fbPageId?.trim() ?? '',
        fbPageTokenEncrypted: patch.fbPageToken !== undefined && patch.fbPageToken !== null && patch.fbPageToken.trim() !== ''
          ? encryptSecret(patch.fbPageToken.trim(), secretKeyPath)
          : null,
        defaultScheduleTimes: patch.defaultScheduleTimes !== undefined
          ? patch.defaultScheduleTimes.filter(time => /^\d{1,2}:\d{2}$/.test(time))
          : ['19:30'],
        defaultDescription: patch.defaultDescription ?? '',
        ytChannelUrl: patch.ytChannelUrl?.trim() ?? '',
        tkProfileUrl: patch.tkProfileUrl?.trim() ?? '',
        autoReplyEnabled: patch.autoReplyEnabled ?? false,
        autoReplyPrompt: patch.autoReplyPrompt ?? '',
        autoPublishAfterTranslate: patch.autoPublishAfterTranslate ?? false,
        nowISO: now()
      });
      return overview();
    },

    updateCluster(clusterId: string, patch: SocialClusterPatch): SocialOverview {
      const update: Record<string, unknown> = { updated_at: now() };
      if (patch.name !== undefined) update.name = patch.name.trim();
      if (patch.seriesName !== undefined) update.series_name = patch.seriesName.trim();
      if (patch.proxyServer !== undefined) {
        update.proxy_server = patch.proxyServer.trim();
        // Đổi proxy → cần kiểm tra lại trạng thái.
        update.proxy_status = patch.proxyServer.trim() === '' ? 'no_proxy' : 'unchecked';
        update.proxy_detail = null;
      }
      if (patch.fbMode !== undefined) update.fb_mode = patch.fbMode;
      if (patch.fbPageId !== undefined) update.fb_page_id = patch.fbPageId.trim();
      if (patch.fbPageToken !== undefined) {
        update.fb_page_token_encrypted = patch.fbPageToken === null || patch.fbPageToken.trim() === ''
          ? null
          : encryptSecret(patch.fbPageToken.trim(), secretKeyPath);
      }
      if (patch.defaultScheduleTimes !== undefined) {
        update.default_schedule_times = JSON.stringify(
          patch.defaultScheduleTimes.filter(time => /^\d{1,2}:\d{2}$/.test(time))
        );
      }
      if (patch.defaultDescription !== undefined) update.default_description = patch.defaultDescription;
      if (patch.ytChannelUrl !== undefined) update.yt_channel_url = patch.ytChannelUrl.trim();
      if (patch.tkProfileUrl !== undefined) update.tk_profile_url = patch.tkProfileUrl.trim();
      if (patch.autoReplyEnabled !== undefined) update.auto_reply_enabled = patch.autoReplyEnabled ? 1 : 0;
      if (patch.autoReplyPrompt !== undefined) update.auto_reply_prompt = patch.autoReplyPrompt;
      if (patch.autoPublishAfterTranslate !== undefined) {
        update.auto_publish_after_translate = patch.autoPublishAfterTranslate ? 1 : 0;
      }
      const updated = updateClusterRow(db, clusterId, update);
      if (updated === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      return overview();
    },

    deleteCluster(clusterId: string): SocialOverview {
      if (getClusterRow(db, clusterId) === undefined) {
        throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      }
      deleteClusterRow(db, clusterId);
      void worker.closeClusterBrowser(clusterId);
      return overview();
    },

    async checkClusterProxy(clusterId: string): Promise<SocialOverview> {
      const row = getClusterRow(db, clusterId);
      if (row === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      const result = await (input.checkProxyFn ?? checkProxy)(row.proxy_server);
      updateClusterRow(db, clusterId, {
        proxy_status: result.status,
        proxy_detail: result.detail,
        updated_at: now()
      });
      return overview();
    },

    async openClusterBrowser(clusterId: string): Promise<SocialOverview> {
      const row = getClusterRow(db, clusterId);
      if (row === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      await worker.openClusterBrowser(clusterId, row.proxy_server);
      return overview();
    },

    async closeClusterBrowser(clusterId: string): Promise<SocialOverview> {
      const row = getClusterRow(db, clusterId);
      if (row === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      await worker.closeClusterBrowser(clusterId);
      return overview();
    },

    async openClusterLoginPage(clusterId: string, platform: SocialPlatform): Promise<{ ok: true }> {
      const row = getClusterRow(db, clusterId);
      if (row === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      const loginUrl = SOCIAL_PLATFORM_LOGIN_URLS[platform];
      if (typeof loginUrl !== 'string') {
        throw new SocialError('social_platform_invalid', `Nền tảng không hỗ trợ đăng nhập: ${platform}`);
      }
      // withClusterBrowser tự mở trình duyệt persistent của cụm nếu chưa mở —
      // chỉ điều hướng tới trang đăng nhập, người dùng tự thao tác (không tự điền).
      await worker.withClusterBrowser(clusterId, async handle => {
        await handle.newPage(loginUrl);
      });
      return { ok: true };
    },

    /**
     * Xác minh phiên đăng nhập của cụm: đọc cookie thật trong profile persistent
     * (Google SID/SSID, TikTok sessionid, Facebook c_user/xs). Có cookie → ghi
     * loginStatus='ok' vào DB ⇒ UI hiện "✔ Đã đăng nhập" + tên kênh nếu có.
     */
    async verifyClusterLogin(clusterId: string, platform: SocialPlatform): Promise<{ ok: boolean; status: 'ok' | 'unknown' | 'expired'; needsChannel?: boolean; accountName?: string; channelId?: string; channelUrl?: string }> {
      const row = getClusterRow(db, clusterId);
      if (row === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      if (!isSocialPlatform(platform)) {
        throw new SocialError('social_platform_invalid', `Nền tảng không hỗ trợ đăng nhập: ${platform}`);
      }
      const probeUrls = SOCIAL_PLATFORM_LOGIN_URLS[platform] === undefined
        ? []
        : [SOCIAL_PLATFORM_LOGIN_URLS[platform]];
      let cookies: Array<{ name: string; value: string; domain: string }> = [];
      try {
        cookies = await worker.withClusterBrowser(clusterId, async handle => {
          if (handle.cookies === undefined) return [];
          return handle.cookies(probeUrls);
        });
      } catch (error) {
        throw new SocialError(
          'social_browser_unavailable',
          `Không mở được trình duyệt của cụm để kiểm tra phiên đăng nhập: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const signedIn = hasLoginCookie(platform, cookies);
      const column = platform === 'youtube' ? 'yt_login' : platform === 'tiktok' ? 'tk_login' : 'fb_login';
      const patch: Parameters<typeof updateClusterRow>[2] = { [column]: signedIn ? 'ok' : 'unknown', updated_at: new Date().toISOString() };
      let accountName: string | undefined;
      let channelId: string | undefined;
      let channelUrl: string | undefined;
      let needsChannel = false;
      let webSignedIn = signedIn;
      if (signedIn && platform === 'youtube') {        // Đọc thông tin kênh thật: đã đăng nhập + có kênh ⇒ lấy tên/ID;
        // đã đăng nhập nhưng chưa có kênh ⇒ cần tạo kênh (needs_channel);
        // web chưa cấp phiên (cookie có nhưng chưa hoàn tất) ⇒ coi như chưa đăng nhập.
        const account = await worker.withClusterBrowser(clusterId, async browserHandle => readYoutubeAccount(browserHandle));
        webSignedIn = account.signedIn;
        if (account.signedIn) {
          if (account.needsChannel === true) {
            // Đã đăng nhập nhưng chưa có kênh → cần tạo kênh (Brand Account).
            needsChannel = true;
          }
          if (account.name !== undefined) {
            accountName = account.name;
            patch.yt_account_name = account.name;
          }
          if (account.channelId !== undefined) {
            channelId = account.channelId;
            patch.yt_account_id = account.channelId;
          }
          if (account.channelUrl !== undefined) {
            channelUrl = account.channelUrl;
            if (row.yt_channel_url === null || row.yt_channel_url === undefined || row.yt_channel_url === '') {
              patch.yt_channel_url = account.channelUrl;
            }
          }
        } else {
          // Cookie phiên có nhưng web chưa cấp phiên ⇒ chưa đăng nhập hoàn chỉnh.
          patch.yt_login = 'unknown';
          patch.yt_account_name = '';
          patch.yt_account_id = '';
        }
      } else if (signedIn && (platform === 'tiktok' || platform === 'facebook')) {
        // TikTok/Facebook: cookie phiên (sessionid / c_user) là đủ ⇒ đã đăng nhập.
        // Tên tài khoản lấy từ trang profile sau khi đăng nhập (nếu đọc được).
        const account = await worker.withClusterBrowser(clusterId, async browserHandle =>
          readSocialProfileName(browserHandle, platform));
        if (account.name !== undefined) {
          accountName = account.name;
          if (platform === 'tiktok') {
            patch.tk_account_name = account.name;
            patch.tk_profile_url = account.url ?? '';
          } else {
            patch.fb_account_name = account.name;
          }
        }
      }
      updateClusterRow(db, clusterId, patch);
      return {
        ok: webSignedIn && !needsChannel,
        status: webSignedIn ? 'ok' : 'unknown',
        needsChannel,
        ...(accountName === undefined ? {} : { accountName }),
        ...(channelId === undefined ? {} : { channelId }),
        ...(channelUrl === undefined ? {} : { channelUrl })
      };
    },

    /**
     * Tạo tài khoản/kênh cho nền tảng khi cụm đã đăng nhập Google nhưng chưa có
     * tài khoản ở nền tảng đó: TikTok đăng ký bằng Google, Facebook tạo Page.
     */    async createClusterSocialAccount(
      clusterId: string,
      platform: SocialPlatform,
      options: { name?: string } = {}
    ): Promise<{ ok: boolean; needsManual?: boolean; message?: string; accountName?: string; accountUrl?: string }> {
      const row = getClusterRow(db, clusterId);
      if (row === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      if (platform !== 'tiktok' && platform !== 'facebook') {
        throw new SocialError('social_platform_invalid', `Nền tảng không hỗ trợ tạo tài khoản tự động: ${platform}`);
      }
      const requestedName = (options.name ?? '').trim();
      const name = requestedName !== ''
        ? requestedName
        : row.series_name !== '' ? row.series_name : row.name;
      // Facebook: chưa có tài khoản ⇒ đăng ký bằng Gmail của cụm (cùng phiên
      // Google đã đăng nhập) rồi mới tạo Page.
      if (platform === 'facebook') {
        const hasAccount = await worker.withClusterBrowser(clusterId, async browserHandle =>
          isFacebookSignedIn(browserHandle));
        if (!hasAccount) {
          // Đăng ký bằng GMAIL THẬT của cụm (phiên Google đang đăng nhập) — không
          // dùng email nhập tay vì mã xác nhận sẽ gửi về hộp thư đó.
          const profileEmail = await worker.withClusterBrowser(clusterId, async browserHandle =>
            readGmailAccountEmail(browserHandle));
          const email = profileEmail !== '' ? profileEmail : (row.fb_login_email ?? '').trim();
          console.log(`[social] Facebook signup: profileEmail="${profileEmail}" rowEmail="${row.fb_login_email ?? ''}" → dùng "${email}"`);
          const storedPassword = decryptToken(row.fb_login_password_encrypted ?? null);
          const password = storedPassword.trim() !== '' ? storedPassword : generateFacebookPassword();
          const created = await worker.withClusterBrowser(clusterId, async browserHandle =>
            createFacebookAccountWithGmail(
              browserHandle,
              { name, email, password },
              { readConfirmationCode: () => readGmailConfirmationCode(browserHandle, 'Facebook') }
            ));
          if (!created.ok) {
            if (created.needsManual === true) {
              return {
                ok: false,
                needsManual: true,
                message: created.message ?? 'Cần bạn hoàn tất đăng ký Facebook trong cửa sổ trình duyệt của cụm.'
              };
            }
            throw new SocialError('social_account_create_failed', created.message ?? 'Không tạo được tài khoản Facebook');
          }
          // Lưu mật khẩu (mã hóa) để các lần đăng nhập sau tự động.
          updateClusterRow(db, clusterId, {
            fb_login: 'ok',
            fb_login_email: email,
            fb_login_password_encrypted: encryptSecret(password, secretKeyPath),
            updated_at: new Date().toISOString()
          });
        }
      }
      const result = await worker.withClusterBrowser(clusterId, async browserHandle =>
        platform === 'tiktok'
          ? signUpTiktokViaGoogle(browserHandle)
          : createFacebookPage(browserHandle, { name }));
      if (!result.ok) {
        // Cần người dùng xác minh thủ công (mã 6 số, CAPTCHA…) → trả về để UI
        // hiện hướng dẫn, không coi là lỗi hệ thống.
        if (result.needsManual === true) {
          return { ok: false, needsManual: true, message: result.message ?? 'Cần bạn hoàn tất thủ công trong cửa sổ trình duyệt của cụm.' };
        }
        throw new SocialError('social_account_create_failed', result.message ?? 'Không tạo được tài khoản');
      }
      const column = platform === 'tiktok' ? 'tk_login' : 'fb_login';
      const patch: Parameters<typeof updateClusterRow>[2] = {
        [column]: 'ok',
        updated_at: new Date().toISOString()
      };
      // Đọc tên tài khoản thật từ trang profile (để cột hiển thị "● <tên>").
      const profile = await worker.withClusterBrowser(clusterId, async browserHandle =>
        readSocialProfileName(browserHandle, platform));
      const accountName = profile.name ?? result.accountName;
      if (platform === 'tiktok') {
        patch.tk_profile_url = profile.url ?? result.accountUrl ?? '';
        if (accountName !== undefined) patch.tk_account_name = accountName;
      } else if (accountName !== undefined) {
        patch.fb_account_name = accountName;
      }
      if (platform === 'facebook' && result.pageId !== undefined) patch.fb_page_id = result.pageId;
      updateClusterRow(db, clusterId, patch);
      return {
        ok: true,
        ...(accountName === undefined ? {} : { accountName }),
        ...(result.accountUrl === undefined ? {} : { accountUrl: result.accountUrl })
      };
    },

    /**
     * Đăng nhập Facebook tự động trong trình duyệt của cụm: điền email (+mật
     * khẩu đã lưu nếu có) rồi bấm "Log in"; daemon theo dõi cookie c_user/xs và
     * tự ghi trạng thái + tên tài khoản khi đăng nhập thành công.
     */
    async loginFacebook(
      clusterId: string,
      options: { email?: string; password?: string } = {}
    ): Promise<{ ok: boolean; needsManual?: boolean; message?: string; accountName?: string }> {
      const row = getClusterRow(db, clusterId);
      if (row === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      const email = (options.email ?? '').trim() !== '' ? (options.email ?? '').trim() : (row.fb_login_email ?? '');
      const stored = decryptToken(row.fb_login_password_encrypted ?? null);
      const password = (options.password ?? '').trim() !== '' ? (options.password ?? '').trim() : stored;
      const result = await worker.withClusterBrowser(clusterId, async browserHandle => {
        const res = await loginFacebook(browserHandle, {
          email,
          password,
          // Có mật khẩu → chờ tới khi cookie phiên xuất hiện; chưa có mật khẩu
          // → trả về nhanh để người dùng tự gõ trong cửa sổ trình duyệt.
          waitMs: password !== '' ? 90_000 : 12_000
        });
        if (!res.ok && res.needsManual === true) {
          // Theo dõi nền: người dùng đăng nhập xong trong cửa sổ → daemon tự lưu
          // phiên + tên tài khoản (UI tự cập nhật nhờ polling mỗi 4s).
          void watchFacebookSession(clusterId, browserHandle, email);
        }
        return res;
      });
      if (!result.ok) {
        if (result.needsManual === true) {
          return {
            ok: false,
            needsManual: true,
            message: result.message ?? 'Cần bạn đăng nhập Facebook trong cửa sổ trình duyệt của cụm.'
          };
        }
        throw new SocialError('social_account_login_failed', result.message ?? 'Không đăng nhập được Facebook');
      }
      const patch: Parameters<typeof updateClusterRow>[2] = {
        fb_login: 'ok',
        updated_at: new Date().toISOString()
      };
      if (email !== '') patch.fb_login_email = email;
      const profile = await worker.withClusterBrowser(clusterId, async browserHandle =>
        readSocialProfileName(browserHandle, 'facebook'));
      const accountName = profile.name ?? result.accountName;
      if (accountName !== undefined) patch.fb_account_name = accountName;
      updateClusterRow(db, clusterId, patch);
      return {
        ok: true,
        ...(accountName === undefined ? {} : { accountName }),
        ...(result.message === undefined ? {} : { message: result.message })
      };
    },

    /** Lưu email + mật khẩu Facebook của cụm (mật khẩu mã hóa AES-256-GCM). */
    async saveFacebookCredentials(
      clusterId: string,
      credentials: { email: string; password: string }
    ): Promise<{ ok: boolean; email: string }> {
      const row = getClusterRow(db, clusterId);
      if (row === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      const email = credentials.email.trim();
      const password = credentials.password.trim();
      if (email === '' && password === '') {
        throw new SocialError('social_credentials_empty', 'Cần nhập email hoặc mật khẩu Facebook');
      }
      const patch: Parameters<typeof updateClusterRow>[2] = {
        updated_at: new Date().toISOString()
      };
      if (email !== '') patch.fb_login_email = email;
      // Mật khẩu trống ⇒ xóa mật khẩu đã lưu (đăng nhập thủ công trong cửa sổ).
      patch.fb_login_password_encrypted = password === ''
        ? null
        : encryptSecret(password, secretKeyPath);
      updateClusterRow(db, clusterId, patch);
      return { ok: true, email };
    },

    /**
     * Tạo kênh YouTube cho tài khoản đã đăng nhập nhưng chưa có kênh/Studio.
     * Dùng web UI Studio (Brand Account) rồi lưu tên + channel id vào cụm.
     */
    async createClusterYoutubeChannel(clusterId: string, channelName: string): Promise<{ ok: boolean; channelId?: string; channelName?: string; error?: string }> {
      const row = getClusterRow(db, clusterId);
      if (row === undefined) throw new SocialError('social_cluster_not_found', 'Không tìm thấy cụm kênh');
      const name = channelName.trim();
      if (name === '') throw new SocialError('social_channel_name_required', 'Cần nhập tên kênh');
      const result = await worker.withClusterBrowser(clusterId, async browserHandle =>
        createYoutubeChannel(browserHandle, { name }));
      if (!result.ok) {
        throw new SocialError('social_channel_create_failed', result.error ?? 'Không tạo được kênh YouTube');
      }
      const patch: Parameters<typeof updateClusterRow>[2] = {
        yt_login: 'ok',
        updated_at: new Date().toISOString()
      };
      if (result.channelName !== undefined) patch.yt_account_name = result.channelName;
      if (result.channelId !== undefined) patch.yt_account_id = result.channelId;
      if (result.channelId !== undefined) patch.yt_channel_url = `https://www.youtube.com/channel/${result.channelId}`;
      updateClusterRow(db, clusterId, patch);
      return {
        ok: true,
        ...(result.channelId === undefined ? {} : { channelId: result.channelId }),
        ...(result.channelName === undefined ? {} : { channelName: result.channelName })
      };
    },

    enqueue(requests: readonly SocialEnqueueRequest[]): { summary: SocialOverview; accepted: number; duplicates: string[] } {
      return enqueueVideos(requests);
    },

    pause(): SocialOverview {
      kvSet(db, 'queue_state', 'paused');
      return overview();
    },

    resume(): SocialOverview {
      kvSet(db, 'queue_state', 'running');
      worker.kick();
      return overview();
    },

    removeJob(jobId: string): SocialOverview {
      const row = getJobRow(db, jobId);
      if (row === undefined) throw new SocialError('social_job_not_found', 'Không tìm thấy job trong hàng đợi');
      if (row.yt_status !== 'running' && row.tk_status !== 'running' && row.fb_status !== 'running') {
        deleteJobRow(db, jobId);
      }
      return overview();
    },

    rescheduleJob(jobId: string, scheduledAt: string): SocialOverview {
      const row = getJobRow(db, jobId);
      if (row === undefined) throw new SocialError('social_job_not_found', 'Không tìm thấy job trong hàng đợi');
      const normalized = normalizeISO(scheduledAt.trim());
      if (normalized === null) {
        throw new SocialError('social_job_schedule_invalid', 'Giờ hẹn phải là chuỗi ISO hợp lệ (UTC)');
      }
      // Job đã đăng/xuất bản (bất kỳ nền tảng nào) thì không được đổi lịch nữa —
      // tránh lệch trạng thái giữa hàng đợi và nền tảng đã nhận video.
      for (const prefix of ['yt', 'tk', 'fb'] as const) {
        const status = row[`${prefix}_status`];
        if (status === 'published' || status === 'scheduled') {
          throw new SocialError(
            'social_job_not_reschedulable',
            'Job đã được đăng hoặc đã hẹn giờ trên nền tảng — không thể đổi lịch'
          );
        }
      }
      updateJobRow(db, jobId, { scheduled_at: normalized, updated_at: now() });
      // Scheduler đọc lại scheduled_at mỗi lượt pump — kick để job dời lên sớm chạy ngay.
      worker.kick();
      return overview();
    },

    async listDownloads(limit?: number): Promise<{ items: SocialDownloadItem[] }> {
      const readRoot = input.readDownloadsRoot;
      if (readRoot === undefined) return { items: [] };
      const root = await readRoot();
      if (root === undefined || root.trim() === '') return { items: [] };
      return { items: await listDownloadedVideos({ root, limit }) };
    },

    retryFailedPlatforms(jobId: string): SocialOverview {
      const row = getJobRow(db, jobId);
      if (row === undefined) throw new SocialError('social_job_not_found', 'Không tìm thấy job trong hàng đợi');
      const patch: Record<string, unknown> = { updated_at: now() };
      const prefixByPlatform: Record<SocialPlatform, string> = { youtube: 'yt', tiktok: 'tk', facebook: 'fb' };
      for (const [platform, prefix] of Object.entries(prefixByPlatform) as Array<[SocialPlatform, string]>) {
        const statusKey = `${prefix}_status`;
        const attemptsKey = `${prefix}_attempts`;
        const errorKey = `${prefix}_error`;
        const attempts = row[attemptsKey as keyof SocialJobRow] as number;
        if (row[statusKey as keyof SocialJobRow] === 'failed' && attempts < 3) {
          patch[statusKey] = 'pending';
          patch[errorKey] = null;
        }
      }
      updateJobRow(db, jobId, patch);
      worker.kick();
      return overview();
    },

    getStats(): SocialStatsOverview {
      return analytics.getStats();
    },

    async refreshStats(): Promise<SocialStatsOverview> {
      await analytics.refresh();
      return analytics.getStats();
    },

    listComments(clusterId?: string, limit?: number): SocialComment[] {
      return comments.list(clusterId, limit);
    },

    async scanComments(clusterId?: string): Promise<SocialCommentScanResult> {
      return comments.scan(clusterId);
    },

    enqueueAfterTranslate(request: SocialAfterTranslateRequest) {
      const path = request.path.trim();
      if (path === '') return { accepted: 0, duplicates: [], clusters: [] };
      // Chỉ cụm đang bật công tắc mới nhận video tự nạp; cụm tắt → không nạp gì
      // (nút thủ công trên web vẫn là đường đăng bình thường).
      const clusters = listClusterRows(db)
        .filter(row => row.auto_publish_after_translate === 1)
        .map(row => mapCluster(row).id);
      if (clusters.length === 0) return { accepted: 0, duplicates: [], clusters: [] };
      const episodeSuffix = typeof request.episodeIndex === 'number' && Number.isFinite(request.episodeIndex)
        ? ` — Tập ${Math.trunc(request.episodeIndex)}`
        : '';
      const title = `${request.title.trim()}${episodeSuffix}`;
      const result = enqueueVideos(clusters.map(clusterId => ({
        clusterId,
        path,
        title,
        // scheduledAt bỏ trống → Auto-Slot xếp khung giờ trống tiếp theo.
        // platformSettings không truyền → mặc định từng nền tảng.
      })));
      return { accepted: result.accepted, duplicates: result.duplicates, clusters };
    },

    async aiComposeVideoMeta(input: { videoTitle: string; language?: string }): Promise<SocialAiCompose> {
      const config = await readLlmConfig();
      return aiComposeVideoMeta(config, { videoTitle: input.videoTitle, language: input.language });
    },

    async aiTestReply(input: { prompt: string; comment: string }) {
      const config = await readLlmConfig();
      return aiTestReply(config, { prompt: input.prompt, comment: input.comment });
    },

    async getSelectors(): Promise<{ selectors: string }> {
      return { selectors: await readFile(selectorsPath, 'utf8') };
    },

    async saveSelectors(selectors: string): Promise<{ selectors: string }> {
      const parsed = JSON.parse(selectors) as unknown;
      if (parsed === null || typeof parsed !== 'object') {
        throw new SocialError('social_selectors_invalid', 'Nội dung selector phải là JSON object');
      }
      const normalized = `${JSON.stringify(parsed, undefined, 2)}\n`;
      try {
        await copyFile(selectorsPath, `${selectorsPath}.bak`);
      } catch {
        // Chưa có file cũ (lần đầu) — bỏ qua backup.
      }
      await writeFile(selectorsPath, normalized, 'utf8');
      return { selectors: normalized };
    },

    async close(): Promise<void> {
      analytics.close();
      comments.close();
      await worker.close();
      closeSocialDatabase(db);
    }
  };
}

/**
 * Spawn yt-dlp của runtime đóng gói (không mở trình duyệt): timeout 60s,
 * giới hạn stdout 8MB, decode UTF-8 và parse JSON. Lỗi → caller fallback.
 */
async function spawnYtDlpJson(
  runtime: YtDlpRuntime,
  args: readonly string[]
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  timeout.unref();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const child = spawnCreatorProcess(runtime.executable, [
        ...runtime.prefixArgs, ...args
      ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...runtime.env } }, controller.signal);
      const chunks: Buffer[] = [];
      let size = 0;
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          controller.abort();
          reject(new Error('yt-dlp output quá lớn'));
          return;
        }
        chunks.push(chunk);
      });
      // Drain diagnostics — không trả extractor output trong lỗi.
      child.stderr?.on('data', () => undefined);
      child.once('error', reject);
      child.once('close', code => {
        if (code !== 0 || controller.signal.aborted) {
          reject(new Error('yt-dlp không chạy được (timeout/lỗi)'));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('yt-dlp output không đúng JSON')); }
      });
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeISO(value: string): string | null {  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function fileName(path: string): string {
  const slash = path.replace(/\\/g, '/').lastIndexOf('/');
  return path.replace(/\\/g, '/').slice(slash + 1);
}

/** Đếm theo trạng thái từng nền tảng: số nền tảng trong từng trạng thái. */
function summarizeCounts(jobs: SocialJob[], nowISO: string): SocialOverview['counts'] {
  const nowTime = new Date(nowISO).getTime();
  const counts = { pending: 0, running: 0, scheduled: 0, published: 0, failed: 0 };
  for (const job of jobs) {
    for (const platform of Object.keys(job.platforms) as SocialPlatform[]) {
      const state: SocialPlatformState = job.platforms[platform]!;
      switch (state.status) {
        case 'running': counts.running += 1; break;
        case 'published': counts.published += 1; break;
        case 'scheduled': counts.published += 1; break;
        case 'failed': counts.failed += 1; break;
        case 'skipped': break;
        case 'pending': {
          const due = new Date(job.scheduledAt).getTime() <= nowTime;
          counts[due ? 'pending' : 'scheduled'] += 1;
          break;
        }
      }
    }
  }
  return counts;
}
