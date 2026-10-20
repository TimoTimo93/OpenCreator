/**
 * Tạo tài khoản/kênh mạng xã hội cho một cụm khi tài khoản đã đăng nhập Google
 * nhưng chưa có tài khoản ở nền tảng đó.
 *
 * - TikTok: trang `tiktok.com/signup` có nút **"Continue with Google"** (đã kiểm
 *   chứng bằng ảnh chụp) ⇒ dùng đúng phiên Google đang đăng nhập của cụm. Google
 *   mở popup riêng: chọn tài khoản → bấm "Continue" ở bước "Sign in to TikTok".
 * - Facebook: **không** cho tạo tài khoản mới bằng tài khoản Google (Google đã
 *   chặn) ⇒ nếu cụm đã đăng nhập Facebook thì tạo **Page** tại
 *   `facebook.com/pages/create`; nếu chưa đăng nhập thì báo rõ lý do.
 *
 * Mọi bước có CAPTCHA/2FA đều trả `needsManual: true` ⇒ app GIỮ cửa sổ trình duyệt
 * mở để người dùng tự xác minh, không báo sai rằng đã tạo xong.
 */

export type SocialAccountSignupResult = {
  ok: boolean;
  needsManual?: boolean;
  message?: string;
  accountName?: string;
  accountUrl?: string;
};

type SignupPage = {
  url(): string;
  title(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  reload(options?: { timeout?: number }): Promise<unknown>;
  locator(selector: string): {
    nth(index: number): {
      fill(value: string): Promise<void>;
      click(): Promise<void>;
      count(): Promise<number>;
      selectOption(value: string | string[] | { index: number }): Promise<void>;
    };
    count(): Promise<number>;
    first(): { click(): Promise<void>; count(): Promise<number> };
  };
  getByRole(role: string, options: { name: string | RegExp; exact?: boolean }): {
    first(): { click(options?: { timeout?: number }): Promise<void>; count(): Promise<number> };
  };
  getByText(text: string | RegExp, options?: { exact?: boolean }): {
    first(): { click(options?: { timeout?: number }): Promise<void>; count(): Promise<number> };
  };
  evaluate<T>(fn: (arg?: unknown) => T, arg?: unknown): Promise<T>;
  close(): Promise<void>;
};

type SignupHandle = {
  newPage(url?: string): Promise<unknown>;
  pages?(): Promise<unknown[]>;
  cookies?(urls: string[]): Promise<Array<{ name: string; value: string; domain: string }>>;
};

const CAPTCHA_MARKERS = ['captcha', 'recaptcha', 'hcaptcha', 'verify you are human', 'unusual traffic'];

async function hasCaptcha(page: SignupPage): Promise<boolean> {
  const html = await page.evaluate(() => document.documentElement?.outerHTML?.slice(0, 120_000) ?? '').catch(() => '');
  const lower = html.toLowerCase();
  return CAPTCHA_MARKERS.some(marker => lower.includes(marker));
}

/** Bấm theo text — TikTok/Google render nút bằng div/span (không phải <button>). */
async function clickText(page: SignupPage, text: string | RegExp): Promise<boolean> {
  try {
    const target = page.getByText(text, { exact: false }).first();
    if (await target.count() > 0) {
      await target.click({ timeout: 10_000 });
      return true;
    }
  } catch {
    // thử cách khác
  }
  try {
    const clicked = await page.evaluate((needle: unknown) => {
      const value = typeof needle === 'string' ? needle : '';
      const nodes = Array.from(document.querySelectorAll('div,span,a,button'));
      for (const node of nodes) {
        if ((node.textContent ?? '').trim() !== value) continue;
        const clickable = node.closest('[role="button"], button, a') ?? node;
        (clickable as HTMLElement).click();
        return true;
      }
      return false;
    }, text);
    return clicked === true;
  } catch {
    return false;
  }
}

/** Tìm tab/popup đang mở tại accounts.google.com (Google hay mở cửa sổ riêng). */
async function findGooglePage(handle: SignupHandle): Promise<SignupPage | undefined> {
  if (handle.pages === undefined) return undefined;
  try {
    const pages = await handle.pages();
    for (const candidate of pages) {
      const page = candidate as SignupPage;
      if (page.url().includes('accounts.google.com')) return page;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Có cookie phiên TikTok (sessionid) trong profile cụm không? */
async function hasTiktokSession(handle: SignupHandle): Promise<boolean> {
  if (handle.cookies === undefined) return false;
  try {
    const cookies = await handle.cookies(['https://www.tiktok.com/']);
    return cookies.some(cookie =>
      (cookie.name === 'sessionid' || cookie.name === 'sessionid_ss') && cookie.value.trim() !== ''
    );
  } catch {
    return false;
  }
}

/** Chọn một mục trong dropdown của TikTok (role=combobox + listbox, không phải <select>). */
async function pickComboboxOption(page: SignupPage, comboIndex: number, label: string): Promise<boolean> {
  const combos = page.locator('div[role="combobox"][data-e2e="select-container"]');
  if (await combos.count().catch(() => 0) <= comboIndex) return false;
  await combos.nth(comboIndex).click().catch(() => undefined);
  await page.waitForTimeout(900).catch(() => undefined);
  try {
    const option = page.getByRole('option', { name: label }).first();
    if (await option.count() > 0) {
      await option.click({ timeout: 8_000 }).catch(() => undefined);
      return true;
    }
  } catch {
    // rơi xuống cách theo text
  }
  return clickText(page, label);
}

/** TikTok: đăng ký bằng Google đang đăng nhập của cụm. */
export async function signUpTiktokViaGoogle(handle: SignupHandle): Promise<SocialAccountSignupResult> {
  let page: SignupPage | undefined;
  let manualRequired = false;
  try {
    page = await handle.newPage('https://www.tiktok.com/signup?lang=en') as SignupPage;
    await page.waitForTimeout(6_000);
    const clicked = await clickText(page, 'Continue with Google');
    if (!clicked) {
      manualRequired = true;
      return {
        ok: false,
        needsManual: true,
        message: 'Không tìm thấy nút "Continue with Google" trên trang đăng ký TikTok — hãy đăng ký tay trong cửa sổ trình duyệt của cụm.'
      };
    }
    // Google điều hướng/popup: lặp tối đa 5 vòng cho tới khi có cookie phiên.
    for (let step = 0; step < 5; step += 1) {
      await page.waitForTimeout(4_000).catch(() => undefined);
      const googlePage = await findGooglePage(handle);
      if (googlePage !== undefined) {
        // Bước 1: chọn tài khoản (Google One Tap render trong shadow DOM).
        const emailItem = googlePage.getByText(/@[\w.\-+]+\.[a-z]{2,}/i).first();
        if (await emailItem.count() > 0) {
          await emailItem.click({ timeout: 10_000 }).catch(() => undefined);
        }
        // Bước 2: "Sign in to TikTok — Google will allow TikTok to access…" → Continue.
        await googlePage.waitForTimeout(5_000).catch(() => undefined);
        await clickText(googlePage, 'Continue');
        await googlePage.waitForTimeout(5_000).catch(() => undefined);
        continue;
      }
      // Không còn popup Google → nạp lại tab TikTok để nhận phiên.
      await page.reload().catch(() => undefined);
      await page.waitForTimeout(5_000).catch(() => undefined);
      const url = page.url();
      if (url.includes('age-gate')) {
        // Bước chọn ngày sinh (TikTok yêu cầu cho tài khoản mới).
        // Bước chọn ngày sinh: 3 dropdown (Tháng / Ngày / Năm) dạng combobox.
        await pickComboboxOption(page, 0, 'January');
        await pickComboboxOption(page, 1, '1');
        await pickComboboxOption(page, 2, '1995');
        await clickText(page, 'Next');
        await page.waitForTimeout(5_000).catch(() => undefined);
        // Bước chọn tên người dùng (nếu TikTok yêu cầu).
        const usernameInput = page.locator('input[data-e2e="user-name-input"], input[placeholder*="username" i], input[placeholder*="nickname" i]');
        if (await usernameInput.count().catch(() => 0) > 0) {
          await usernameInput.nth(0).fill(`opencreator${Date.now().toString().slice(-5)}`).catch(() => undefined);
          await clickText(page, 'Next');
          await page.waitForTimeout(3_000).catch(() => undefined);
          await clickText(page, 'Done');
          await page.waitForTimeout(5_000).catch(() => undefined);
        }
      }
      if (url.includes('tiktok.com') && !url.includes('/login') && !url.includes('/signup')) break;
      if (await hasTiktokSession(handle)) break;
    }
    if (await hasTiktokSession(handle)) {
      const handleName = await handle.cookies?.(['https://www.tiktok.com/'])
        .then(cookies => cookies.find(cookie => cookie.name === 'sessionid' || cookie.name === 'sessionid_ss')?.value ?? '')
        .catch(() => '') ?? '';
      return {
        ok: true,
        accountName: handleName !== '' ? `TikTok @${handleName.slice(0, 8)}` : 'TikTok',
        accountUrl: 'https://www.tiktok.com/'
      };
    }
    manualRequired = true;
    const blocked = await hasCaptcha(page).catch(() => false);
    return {
      ok: false,
      needsManual: true,
      message: blocked
        ? 'TikTok yêu cầu xác minh người dùng (CAPTCHA) — hãy hoàn tất trong cửa sổ trình duyệt của cụm rồi bấm lại.'
        : 'Chưa hoàn tất đăng ký TikTok — hãy bấm "Continue with Google" rồi chọn tài khoản trong cửa sổ trình duyệt của cụm, sau đó bấm lại trong phần mềm.'
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    // Khi cần người dùng xác minh thủ công → GIỮ tab mở để họ xử lý ngay
    // trong cửa sổ trình duyệt của cụm (đóng tab sẽ khiến họ không thấy form).
    if (!manualRequired) await page?.close().catch(() => undefined);
  }
}

/** Facebook: đã đăng nhập FB thì tạo Page (kênh); chưa có tài khoản thì báo rõ. */
export async function createFacebookPage(
  handle: SignupHandle,
  options: { name: string }
): Promise<SocialAccountSignupResult> {
  const name = options.name.trim();
  if (name === '') return { ok: false, message: 'Cần nhập tên Page' };
  let page: SignupPage | undefined;
  let manualRequired = false;
  try {
    page = await handle.newPage('https://www.facebook.com/pages/create/') as SignupPage;
    await page.waitForTimeout(7_000);
    const url = page.url();
    if (url.includes('login') || url.includes('accounts.google.com')) {
      manualRequired = true;
      return {
        ok: false,
        needsManual: true,
        message: 'Facebook không cho tạo tài khoản mới bằng tài khoản Google (Google đã chặn). Hãy tạo tài khoản Facebook bằng email/SĐT khác, đăng nhập trong cửa sổ trình duyệt của cụm, rồi bấm lại để tạo Page.'
      };
    }
    if (await hasCaptcha(page)) {
      manualRequired = true;
      return { ok: false, needsManual: true, message: 'Facebook yêu cầu xác minh — hãy hoàn tất trong cửa sổ trình duyệt của cụm.' };
    }
    const nameInput = page.locator('input[name="page_name"], input[placeholder*="Page name" i], input[aria-label*="page name" i]');
    if (await nameInput.count() === 0) {
      manualRequired = true;
      return { ok: false, needsManual: true, message: 'Không tìm thấy ô tên Page trong Facebook — hãy tạo Page thủ công trong cửa sổ trình duyệt của cụm.' };
    }
    await nameInput.nth(0).fill(name);
    await clickText(page, 'Create Page');
    await page.waitForTimeout(5_000).catch(() => undefined);
    await clickText(page, 'Next');
    await page.waitForTimeout(3_000).catch(() => undefined);
    await clickText(page, 'Next');
    await page.waitForTimeout(3_000).catch(() => undefined);
    await clickText(page, 'Done');
    await page.waitForTimeout(5_000).catch(() => undefined);
    return { ok: true, accountName: name, accountUrl: page.url() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!manualRequired) await page?.close().catch(() => undefined);
  }
}
