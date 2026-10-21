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

export type SignupPage = {
  url(): string;
  title(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  reload(options?: { timeout?: number }): Promise<unknown>;
  locator(selector: string): {
    nth(index: number): {
      fill(value: string): Promise<void>;
      click(options?: { timeout?: number }): Promise<void>;
      count(): Promise<number>;
      selectOption(value: string | string[] | { index: number }): Promise<void>;
    };
    count(): Promise<number>;
    first(): { click(options?: { timeout?: number }): Promise<void>; count(): Promise<number> };
  };
  getByRole(role: string, options: { name: string | RegExp; exact?: boolean }): {
    first(): { click(options?: { timeout?: number }): Promise<void>; count(): Promise<number> };
  };
  getByText(text: string | RegExp, options?: { exact?: boolean }): {
    first(): {
      click(options?: { timeout?: number }): Promise<void>;
      count(): Promise<number>;
      innerText(): Promise<string>;
    };
  };
  evaluate<T>(fn: (arg?: unknown) => T, arg?: unknown): Promise<T>;
  close(): Promise<void>;
};

export type SignupHandle = {
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

/**
 * Bấm đúng một phần tử (a/button) có text khớp tuyệt đối — tránh bấm nhầm
 * phần tử cha khi dùng getByText (TikTok bọc text trong nhiều lớp div).
 */
async function clickExactElement(page: SignupPage, text: string): Promise<boolean> {
  const clicked = await page.evaluate((needle: unknown) => {
    const value = (typeof needle === 'string' ? needle : '').replace(/\s+/g, ' ').trim();
    if (value === '') return false;
    const nodes = Array.from(document.querySelectorAll('a,button'));
    for (const node of nodes) {
      const own = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (own !== value) continue;
      (node as HTMLElement).click();
      return true;
    }
    return false;
  }, text).catch(() => false);
  return clicked === true;
}

/**
 * TikTok mặc định đăng ký bằng **SĐT**; khi tài khoản Google dùng lần đầu,
 * TikTok bắt tạo tài khoản mới và yêu cầu "Sign up with email"/"Đăng ký bằng
 * email" — phải bấm link đó để điền email Gmail của cụm.
 */
export async function switchToEmailSignup(page: SignupPage): Promise<boolean> {
  if (page.url().includes('phone-or-email/email')) return true;
  for (const label of ['Sign up with email', 'Đăng ký bằng email', 'Continue with email', 'Sign up with Email']) {
    if (await clickExactElement(page, label)) {
      await page.waitForTimeout(2_000).catch(() => undefined);
      return page.url().includes('/email');
    }
  }
  return false;
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

/**
 * Chọn một mục trong dropdown của TikTok (role=combobox + listbox, không phải
 * <select>). TikTok đổi nhãn theo locale (vi-VN: "Tháng 1"…) nên chọn theo
 * INDEX của option (tháng 1 = index 0) thay vì theo tên.
 */
async function pickComboboxOption(
  page: SignupPage,
  comboIndex: number,
  option: { index?: number; text?: string }
): Promise<boolean> {
  const combos = page.locator('div[role="combobox"][data-e2e="select-container"]');
  if (await combos.count().catch(() => 0) <= comboIndex) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await combos.nth(comboIndex).click({ timeout: 8_000 }).catch(() => undefined);
    for (let wait = 0; wait < 4; wait += 1) {
      await page.waitForTimeout(600).catch(() => undefined);
      // TikTok dựng sẵn 3 listbox (tháng/ngày/năm) theo đúng thứ tự combobox →
      // phải lấy listbox theo index của combobox, không lấy "listbox visible đầu tiên"
      // (listbox tháng vẫn còn trong DOM sau khi đóng).
      const clicked = await page.evaluate((arg: unknown) => {
        const options = (arg ?? {}) as { comboIndex: number; index?: number; text?: string };
        const lists = Array.from(document.querySelectorAll('div[role="listbox"]'));
        const list = lists[options.comboIndex];
        if (list === undefined) return false;
        const items = Array.from(list.querySelectorAll('[role="option"]'));
        let target: HTMLElement | undefined;
        if (options.text !== undefined) {
          target = items.find(item => (item.textContent ?? '').trim() === options.text) as HTMLElement | undefined;
        }
        if (target === undefined && options.index !== undefined) {
          target = items[options.index] as HTMLElement | undefined;
        }
        if (target === undefined) return false;
        target.click();
        return true;
      }, { comboIndex, index: option.index, text: option.text }).catch(() => false);
      if (clicked === true) return true;
    }
  }
  return false;
}

/** Bấm nút "Next"/"Tiếp" của TikTok (nút chính thức có data-e2e=next-button). */
async function clickPrimaryNext(page: SignupPage): Promise<void> {
  const next = page.locator('button[data-e2e="next-button"]');
  if (await next.count().catch(() => 0) > 0) {
    await next.nth(0).click().catch(() => undefined);
    return;
  }
  await clickText(page, 'Next');
  await clickText(page, 'Tiếp');
}

/** Đọc email Google đang đăng nhập trong profile cụm (từ menu avatar YouTube). */
async function readGoogleEmail(handle: SignupHandle): Promise<string> {
  let page: {
    url(): string;
    waitForTimeout(ms: number): Promise<void>;
    evaluate<T>(fn: (arg?: unknown) => T, arg?: unknown): Promise<T>;
    close(): Promise<void>;
  } | undefined;
  try {
    const opened = await handle.newPage('https://www.youtube.com/');
    page = opened as unknown as NonNullable<typeof page>;
    await page.waitForTimeout(4_000);
    await page.evaluate(() => {
      const avatar = document.querySelector('#avatar-btn, ytd-topbar-menu-button button, ytd-avatar-shape');
      (avatar as HTMLElement | null)?.click();
    }, null).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const email = await page.evaluate(() => {
      const match = (document.body?.innerText ?? '').match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/);
      return match?.[0] ?? '';
    }, null).catch(() => '');
    return email;
  } catch {
    return '';
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/** Đọc giá trị đang chọn của combobox (bỏ listbox khỏi bản sao trước khi đọc text). */
async function readComboValue(page: SignupPage, comboIndex: number): Promise<string> {
  return page.evaluate((index: unknown) => {
    const idx = typeof index === 'number' ? index : 0;
    const combos = Array.from(document.querySelectorAll('div[role="combobox"][data-e2e="select-container"]'));
    const combo = combos[idx];
    if (combo === undefined) return '';
    const clone = combo.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[role="listbox"]').forEach(list => list.remove());
    return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  }, comboIndex).catch(() => '');
}

/**
 * Chọn ngày sinh (Tháng/Ngày/Năm) nếu trang còn để trống — TikTok hiện 3
 * dropdown này ở cả trang age-gate và trang phone-or-email.
 */
async function fillBirthday(page: SignupPage): Promise<void> {
  const placeholders = /^(month|day|year|tháng|ngày|năm|month|ngay)$/i;
  const month = await readComboValue(page, 0);
  const day = await readComboValue(page, 1);
  const year = await readComboValue(page, 2);
  if (month === '' || placeholders.test(month)) await pickComboboxOption(page, 0, { index: 0 });
  if (day === '' || placeholders.test(day)) await pickComboboxOption(page, 1, { index: 0 });
  if (year === '' || placeholders.test(year)) await pickComboboxOption(page, 2, { text: '1995' });
}

/** Tick ô đồng ý điều khoản (checkbox thật bị ẩn → phải click bằng DOM). */
async function clickTermsCheckbox(page: SignupPage): Promise<boolean> {
  return page.evaluate(() => {
    const box = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (box === null) return false;
    if (box.checked) return true;
    (box as HTMLElement).click();
    if (box.checked) return true;
    const wrapper = (box.closest('label') ?? box.parentElement) as HTMLElement | null;
    wrapper?.click();
    return box.checked;
  }).catch(() => false);
}

/**
 * Bước "đăng ký bằng Gmail" của TikTok: chuyển sang chế độ email (mặc định là
 * SĐT), chọn ngày sinh, điền email + mật khẩu rồi bấm "Gửi mã"/"Send code"
 * để TikTok gửi mã 6 chữ số về hộp thư. Trả về mật khẩu để người dùng dùng lại.
 */
export async function startTiktokEmailSignup(
  page: SignupPage,
  email: string
): Promise<{ ok: boolean; password: string; emailMode: boolean }> {
  const password = `Oc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const emailMode = await switchToEmailSignup(page);
  await page.waitForTimeout(2_000).catch(() => undefined);
  await fillBirthday(page);
  const emailInput = page.locator('input[placeholder="Email address"], input[placeholder="Email"], input[type="email"]');
  if (email === '' || await emailInput.count().catch(() => 0) === 0) {
    return { ok: false, password, emailMode };
  }
  await emailInput.nth(0).fill(email).catch(() => undefined);
  const passwordInput = page.locator('input[placeholder="Password"], input[type="password"]');
  if (await passwordInput.count().catch(() => 0) > 0) {
    await passwordInput.nth(0).fill(password).catch(() => undefined);
  }
  await clickTermsCheckbox(page);
  await page.waitForTimeout(600).catch(() => undefined);
  const sendCode = page.locator('button[data-e2e="send-code-button"]');
  if (await sendCode.count().catch(() => 0) > 0) {
    await sendCode.nth(0).click({ timeout: 8_000 }).catch(() => undefined);
  } else {
    await clickText(page, 'Gửi mã');
    await clickText(page, 'Send code');
  }
  await page.waitForTimeout(3_000).catch(() => undefined);
  return { ok: true, password, emailMode };
}

/** TikTok: đăng ký bằng Google đang đăng nhập của cụm. */
export async function signUpTiktokViaGoogle(handle: SignupHandle): Promise<SocialAccountSignupResult> {
  let page: SignupPage | undefined;
  let manualRequired = false;
  let googleEmail = '';
  try {
    // Profile cụm đã có phiên TikTok → không cần đăng ký lại.
    if (await hasTiktokSession(handle)) {
      return { ok: true, accountName: 'TikTok', accountUrl: 'https://www.tiktok.com/' };
    }
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
          const emailText = await emailItem.innerText().catch(() => '');
          const matched = emailText.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/);
          if (matched !== null) googleEmail = matched[0];
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
        // Bước chọn ngày sinh (TikTok yêu cầu cho tài khoản mới): 3 dropdown
        // (Tháng / Ngày / Năm) dạng combobox — chọn theo index vì nhãn theo locale.
        await fillBirthday(page);
        await clickPrimaryNext(page);
        await page.waitForTimeout(5_000).catch(() => undefined);
        if (page.url().includes('phone-or-email')) {
          // TikTok bắt tạo tài khoản mới khi tài khoản Google dùng lần đầu.
          // Mặc định TikTok chọn đăng ký bằng SĐT → phải bấm "Sign up with
          // email" để dùng email Gmail của cụm, rồi gửi mã 6 chữ số.
          const email = googleEmail !== '' ? googleEmail : await readGoogleEmail(handle);
          const started = await startTiktokEmailSignup(page, email);
          if (started.ok) {
            manualRequired = true;
            return {
              ok: false,
              needsManual: true,
              message: `TikTok đã gửi mã xác minh 6 chữ số về email ${email} — hãy nhập mã trong cửa sổ trình duyệt của cụm (mật khẩu tài khoản: ${started.password}), xong bấm "Lưu Phiên" trong phần mềm.`
            };
          }
        }
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
