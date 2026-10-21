/**
 * Đọc hộp thư Gmail của cụm (phiên Google đã đăng nhập sẵn trong profile).
 *
 * Dùng để:
 * - Lấy đúng địa chỉ Gmail của cụm (phục vụ đăng ký Meta/Facebook).
 * - Đọc mã xác nhận 6 chữ số Meta gửi về sau khi bấm "Submit" form đăng ký ⇒
 *   tài khoản Facebook được tạo hoàn toàn tự động.
 */
import type { SignupHandle, SignupPage } from './account-signup.js';

const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox';

type MailPage = SignupPage & {
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
};

/** Mở hộp thư và chờ danh sách mail hiển thị. */
async function openGmail(page: MailPage): Promise<void> {
  await page.goto(GMAIL_URL, { timeout: 60_000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForTimeout(9_000).catch(() => undefined);
}

/** Email của tài khoản Gmail đang đăng nhập (đọc từ tiêu đề trang). */
export async function readGmailAccountEmail(handle: SignupHandle): Promise<string> {
  let page: MailPage | undefined;
  try {
    const opened = await handle.newPage(GMAIL_URL);
    page = opened as MailPage;
    await page.waitForTimeout(8_000).catch(() => undefined);
    const title = await page.title().catch(() => '');
    const fromTitle = title.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? '';
    console.log(`[social] Gmail: title="${title}" → email="${fromTitle}"`);
    if (fromTitle !== '') return fromTitle;
    const fromBody = await page.evaluate(() => {
      const text = (document.querySelector('div[role="main"]')?.textContent ?? document.body?.textContent ?? '');
      return text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? '';
    }).catch(() => '');
    console.log(`[social] Gmail: đọc từ body → email="${fromBody}"`);
    return fromBody;
  } catch {
    return '';
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/**
 * Tìm mail mới nhất chứa từ khoá (mặc định "Facebook") và rút mã xác nhận.
 * Trả về '' nếu chưa có mail hoặc không tìm thấy mã.
 *
 * Meta gửi mã xác nhận **5 chữ số** (đăng ký) — nên rút 5 số trước, rồi mới
 * tới 6 số (mã đăng nhập) để tránh bắt nhầm số khác trong mail.
 */
export async function readGmailConfirmationCode(
  handle: SignupHandle,
  keyword = 'Facebook'
): Promise<string> {
  let page: MailPage | undefined;
  try {
    const opened = await handle.newPage(GMAIL_URL);
    page = opened as MailPage;
    await page.waitForTimeout(9_000).catch(() => undefined);

    // 1) Tìm kiếm theo từ khoá (Gmail tìm cả trong Spam/Thùng rác).
    const search = page.locator('input[name="q"][aria-label="Search mail"]');
    if (await search.count().catch(() => 0) > 0) {
      await search.nth(0).fill(keyword).catch(() => undefined);
      await search.nth(0).press('Enter').catch(() => undefined);
      await page.waitForTimeout(5_500).catch(() => undefined);
    }
    const body = await openFirstConversation(page, keyword);
    const code = extractConfirmationCode(body);
    if (code !== '') return code;

    // 2) Thư mục Spam — kiểm tra riêng để chắc chắn không bỏ sót.
    await page.goto('https://mail.google.com/mail/u/0/#spam', { timeout: 60_000, waitUntil: 'domcontentloaded' })
      .catch(() => undefined);
    await page.waitForTimeout(8_000).catch(() => undefined);
    const spamSearch = page.locator('input[name="q"][aria-label="Search mail"]');
    if (await spamSearch.count().catch(() => 0) > 0) {
      await spamSearch.nth(0).fill(keyword).catch(() => undefined);
      await spamSearch.nth(0).press('Enter').catch(() => undefined);
      await page.waitForTimeout(5_000).catch(() => undefined);
    }
    const spamBody = await openFirstConversation(page, keyword);
    return extractConfirmationCode(spamBody);
  } catch {
    return '';
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/** Mở cuộc trò chuyện đầu tiên trong danh sách và trả về nội dung mail. */
async function openFirstConversation(page: MailPage, keyword: string): Promise<string> {
  const opened = await page.evaluate((arg: unknown) => {
    const needle = (typeof arg === 'string' ? arg : '').trim();
    const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
    const legacy = Array.from(document.querySelectorAll('[data-legacy-thread-id]')).filter(el => visible(el));
    if (legacy.length > 0) {
      (legacy[0] as HTMLElement).click();
      return true;
    }
    const subjects = Array.from(document.querySelectorAll('span, div')).filter(el =>
      visible(el) && el.children.length === 0 && (el.textContent ?? '').includes(needle));
    if (subjects.length > 0) {
      (subjects[0] as HTMLElement).click();
      return true;
    }
    return false;
  }, keyword).catch(() => false);
  if (opened !== true) {
    // Không mở được ⇒ lấy luôn text đang hiển thị (Gmail render preview).
    return page.evaluate(() => {
      const main = document.querySelector('div[role="main"]');
      return ((main?.textContent ?? '') || '').replace(/\s+/g, ' ').slice(0, 6_000);
    }).catch(() => '');
  }
  await page.waitForTimeout(6_000).catch(() => undefined);
  return page.evaluate(() => {
    const main = document.querySelector('div[role="main"]');
    return ((main?.textContent ?? '') || '').replace(/\s+/g, ' ').slice(0, 6_000);
  }).catch(() => '');
}

/** Rút mã xác nhận (5-6 chữ số) từ nội dung mail. */
export function extractConfirmationCode(body: string): string {
  // Ưu tiên số nằm cạnh từ "code"/"mã" (tiếng Anh hoặc tiếng Việt).
  const nearCode = body.match(/(?:code|mã|ma|xác nhận|verification)[^0-9]{0,40}(\d{5,6})/i)?.[1];
  if (nearCode !== undefined) return nearCode;
  // Meta dùng mã 5 số cho đăng ký, 6 số cho đăng nhập.
  const five = body.match(/\b(\d{5})\b/)?.[1];
  if (five !== undefined) return five;
  const six = body.match(/\b(\d{6})\b/)?.[1];
  if (six !== undefined) return six;
  return body.match(/\b(\d{4,8})\b/)?.[1] ?? '';
}
