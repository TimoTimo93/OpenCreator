/**
 * Đăng nhập Facebook tự động trong trình duyệt của cụm.
 *
 * Facebook **không** cho đăng ký mới bằng tài khoản Google (Google chặn), nên
 * đăng nhập phải dùng email + mật khẩu của chính tài khoản Facebook:
 * - Có mật khẩu lưu trong cụm → điền email + mật khẩu và bấm "Log in" (tự động).
 * - Chưa có mật khẩu → điền email, để người dùng gõ mật khẩu ngay trong cửa
 *   sổ trình duyệt; daemon theo dõi cookie phiên (c_user/xs) và tự lưu khi
 *   đăng nhập thành công.
 *
 * Mọi bước có checkpoint/2FA/CAPTCHA đều trả `needsManual: true` ⇒ app giữ
 * cửa sổ trình duyệt mở để người dùng tự xử lý.
 */
import type { SignupHandle, SignupPage } from './account-signup.js';

export type FacebookLoginResult = {
  ok: boolean;
  needsManual?: boolean;
  message?: string;
  accountName?: string;
};

/** Cookie phiên đăng nhập Facebook (c_user + xs là cặp chuẩn). */
const FB_SESSION_COOKIES = ['c_user', 'xs'];

function isSessionCookie(name: string, value: string): boolean {
  return FB_SESSION_COOKIES.includes(name) && value.trim() !== '';
}

/** Profile cụm đã có phiên Facebook chưa? */
export async function hasFacebookSession(handle: SignupHandle): Promise<boolean> {
  if (handle.cookies === undefined) return false;
  try {
    const cookies = await handle.cookies(['https://www.facebook.com/', 'https://www.facebook.com']);
    return cookies.some(cookie => isSessionCookie(cookie.name, cookie.value));
  } catch {
    return false;
  }
}

/** Chờ cookie phiên xuất hiện (người dùng đang gõ mật khẩu trong cửa sổ). */
export async function waitForFacebookSession(
  handle: SignupHandle,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasFacebookSession(handle)) return true;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  return false;
}

/** Đọc thông báo lỗi của Facebook (sai mật khẩu, khóa tài khoản…) nếu có. */
async function readFacebookError(page: SignupPage): Promise<string> {
  return page.evaluate(() => {
    const visible = (el: HTMLElement): boolean => el.offsetParent !== null;
    const candidates = Array.from(document.querySelectorAll(
      '[role="alert"], div[id*="error" i], div[class*="error" i], span[aria-live]'
    ));
    for (const el of candidates) {
      if (!visible(el as HTMLElement)) continue;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text !== '' && text.length < 300) return text;
    }
    return '';
  }).catch(() => '');
}

/** Chờ kết quả đăng nhập: có cookie phiên, có lỗi, hay hết giờ. */
async function waitForFacebookOutcome(
  handle: SignupPage & SignupHandle,
  page: SignupPage,
  timeoutMs: number
): Promise<'signed-in' | 'error' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasFacebookSession(handle)) return 'signed-in';
    const error = await readFacebookError(page);
    if (error !== '') return 'error';
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  return 'timeout';
}

/** Bấm nút "Log in"/"Đăng nhập" của Facebook (div[role=button], không phải <button>). */
async function clickFacebookLogin(page: SignupPage): Promise<boolean> {
  for (const selector of [
    'div[role="button"][aria-label="Log in"]',
    'div[role="button"][aria-label="Đăng nhập"]',
    'button[name="login"]'
  ]) {
    const button = page.locator(selector);
    if (await button.count().catch(() => 0) > 0) {
      await button.nth(0).click({ timeout: 8_000 }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

/** Gỡ banner cookie nếu Facebook hiện (không chặn việc điền form). */
async function dismissCookieBanner(page: SignupPage): Promise<void> {
  for (const label of ['Allow all cookies', 'Cho phép tất cả cookie', 'Only allow essential cookies', 'Decline optional cookies']) {
    try {
      const clicked = await page.evaluate((needle: unknown) => {
        const value = (typeof needle === 'string' ? needle : '').trim();
        if (value === '') return false;
        for (const node of Array.from(document.querySelectorAll('button, div[role="button"]'))) {
          if ((node.textContent ?? '').replace(/\s+/g, ' ').trim() !== value) continue;
          (node as HTMLElement).click();
          return true;
        }
        return false;
      }, label);
      if (clicked === true) {
        await page.waitForTimeout(1_500).catch(() => undefined);
        return;
      }
    } catch {
      // thử nhãn tiếp theo
    }
  }
}

/**
 * Đăng nhập Facebook cho một cụm.
 * - `email`: email/SDT của tài khoản Facebook (có thể để trống để người dùng tự nhập).
 * - `password`: mật khẩu (có thể để trống ⇒ người dùng tự gõ trong cửa sổ trình duyệt).
 */
export async function loginFacebook(
  handle: SignupHandle,
  options: { email?: string; password?: string; waitMs?: number }
): Promise<FacebookLoginResult> {
  const email = (options.email ?? '').trim();
  const password = options.password ?? '';
  const waitMs = options.waitMs ?? (password !== '' ? 90_000 : 240_000);
  let page: SignupPage | undefined;
  let manualRequired = false;
  try {
    // Đã có phiên → không cần đăng nhập lại.
    if (await hasFacebookSession(handle)) {
      return { ok: true, accountName: 'Facebook' };
    }
    page = await handle.newPage('https://www.facebook.com/login') as SignupPage;
    await page.waitForTimeout(6_000).catch(() => undefined);
    await dismissCookieBanner(page);

    const emailInput = page.locator('input[name="email"], input[autocomplete="username"], input[id="email"]');
    if (await emailInput.count().catch(() => 0) > 0 && email !== '') {
      await emailInput.nth(0).fill(email).catch(() => undefined);
    }
    const passwordInput = page.locator('input[name="pass"], input[type="password"], input[autocomplete="current-password"]');
    const hasPasswordField = await passwordInput.count().catch(() => 0) > 0;

    if (password !== '' && hasPasswordField) {
      await passwordInput.nth(0).fill(password).catch(() => undefined);
      await page.waitForTimeout(600).catch(() => undefined);
      await clickFacebookLogin(page);
      const outcome = await waitForFacebookOutcome(handle as never, page, waitMs);
      if (outcome === 'signed-in') {
        return { ok: true, accountName: 'Facebook' };
      }
      const url = page.url();
      if (url.includes('checkpoint') || url.includes('two_step')) {
        manualRequired = true;
        return {
          ok: false,
          needsManual: true,
          message: 'Facebook yêu cầu xác minh 2 lớp (checkpoint) — hãy hoàn tất trong cửa sổ trình duyệt của cụm, phiên sẽ được lưu tự động.'
        };
      }
      const error = outcome === 'error' ? await readFacebookError(page) : '';
      manualRequired = true;
      return {
        ok: false,
        needsManual: true,
        message: error !== ''
          ? `Facebook không đăng nhập được: ${error}`
          : 'Facebook chưa cấp phiên đăng nhập — kiểm tra lại email/mật khẩu trong cửa sổ trình duyệt của cụm.'
      };
    }

    // Chưa có mật khẩu: chỉ điền email rồi chờ người dùng gõ mật khẩu trong cửa sổ
    // (KHÔNG bấm "Đăng nhập" — Facebook sẽ báo lỗi "email không khớp" khi mật
    // khẩu còn trống).
    manualRequired = true;
    const signedIn = await waitForFacebookSession(handle, waitMs);
    if (signedIn) {
      return {
        ok: true,
        accountName: 'Facebook',
        message: `Đã đăng nhập Facebook${email !== '' ? ` (${email})` : ''} — phiên đã lưu cho cụm.`
      };
    }
    return {
      ok: false,
      needsManual: true,
      message: `Facebook chưa đăng nhập được. Hãy nhập mật khẩu trong cửa sổ trình duyệt của cụm${email !== '' ? ` (email đã điền: ${email})` : ''}, hoặc lưu mật khẩu trong "Sửa cụm" để đăng nhập tự động.`
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    // Cần người dùng thao tác → GIỮ tab mở.
    if (!manualRequired) await page?.close().catch(() => undefined);
  }
}
