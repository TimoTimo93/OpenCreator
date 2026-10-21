/**
 * Tạo tài khoản Facebook (Meta account) tự động cho một cụm.
 *
 * Meta **không còn** nút "Continue with Google" trong form đăng ký ⇒ không thể
 * đăng ký bằng Google trực tiếp. Thay vào đó:
 *   1. Điền form đăng ký Meta bằng **Gmail đang đăng nhập** của cụm (cùng phiên
 *      Google đã dùng cho YouTube/TikTok) + mật khẩu do app sinh ra.
 *   2. Meta gửi mã xác nhận 6 chữ số về Gmail ⇒ daemon đọc mã đó ngay trong
 *      hộp thư (phiên Gmail đã đăng nhập sẵn trong profile cụm) và điền vào
 *      form xác nhận ⇒ tài khoản được tạo hoàn toàn tự động.
 *
 * Nếu bước nào cần người dùng (checkpoint/2FA/CAPTCHA) ⇒ `needsManual: true`,
 * app giữ cửa sổ trình duyệt mở để xử lý tiếp.
 */
import type { SignupHandle, SignupPage } from './account-signup.js';

export type FacebookAccountResult = {
  ok: boolean;
  needsManual?: boolean;
  message?: string;
  accountName?: string;
  accountUrl?: string;
  /** ID Page vừa tạo (nếu lấy được từ URL). */
  pageId?: string;
  email?: string;
  password?: string;
};

export type FacebookAccountOptions = {
  /** Tên hiển thị (dùng làm First/Surname). */
  name: string;
  /** Gmail của cụm để đăng ký. */
  email: string;
  /** Mật khẩu tài khoản Facebook. */
  password: string;
  day?: number;
  month?: number;
  year?: number;
  gender?: 'Female' | 'Male' | 'Custom';
};

/** Handle cần thêm khả năng xóa cookie (dọn phiên đăng ký dở). */
type SignupHandleWithCookies = SignupHandle & {
  clearCookies?: (domainPattern: RegExp) => Promise<void>;
};

/** Điền ô và ĐỌC LẠI để chắc chắn giá trị đúng (Chrome có thể autofill ghi đè). */
async function fillAndVerify(
  page: SignupPage,
  selector: string,
  index: number,
  value: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const input = page.locator(selector);
    if (await input.count().catch(() => 0) <= index) return false;
    await input.nth(index).fill(value).catch(() => undefined);
    await page.waitForTimeout(600).catch(() => undefined);
    const actual = await page.evaluate((arg: unknown) => {
      const spec = (arg ?? {}) as { selector: string; index: number };
      const nodes = Array.from(document.querySelectorAll(spec.selector));
      const el = nodes[spec.index];
      return (el && 'value' in el) ? String((el as HTMLInputElement).value ?? '') : '';
    }, { selector, index }).catch(() => '');
    if (actual.trim() === value.trim()) return true;
  }
  return false;
}

/** Điền ô email (placeholder có chứa "email"/"mail", nếu không thì ô text thứ 3). */
async function fillEmailField(page: SignupPage, email: string): Promise<boolean> {
  const byPlaceholder = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('input[type="text"]'));
    for (let i = 0; i < nodes.length; i += 1) {
      const el = nodes[i] as HTMLInputElement;
      const hint = `${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
      if (hint.includes('email') || hint.includes('mail')) return i;
    }
    return -1;
  }).catch(() => -1);
  if (typeof byPlaceholder === 'number' && byPlaceholder >= 0) {
    return fillAndVerify(page, 'input[type="text"]', byPlaceholder, email);
  }
  return fillAndVerify(page, 'input[type="text"]', 2, email);
}

/** Cookie phiên Facebook. */
const FB_SESSION_COOKIES = ['c_user', 'xs'];

export async function hasFacebookSessionCookies(handle: SignupHandle): Promise<boolean> {
  if (handle.cookies === undefined) return false;
  try {
    const cookies = await handle.cookies(['https://www.facebook.com/']);
    return cookies.some(cookie => FB_SESSION_COOKIES.includes(cookie.name) && cookie.value.trim() !== '');
  } catch {
    return false;
  }
}

/**
 * Chọn một mục trong dropdown của Meta (role=combobox → listbox → option).
 *
 * Meta dựng SẴN cả 4 listbox trong DOM (ngày/tháng/năm/giới tính) nên phải
 * định danh listbox đang mở theo `aria-label` (hoặc số option) — nếu lấy "listbox
 * visible đầu tiên" sẽ bấm nhầm listbox của dropdown khác.
 *
 * `text` khớp chính xác nếu có; nếu không thì dùng `index` (option thứ N).
 */
async function pickMetaOption(
  page: SignupPage,
  combos: { nth(index: number): { click(options?: { timeout?: number }): Promise<void> } },
  index: number,
  option: { text?: string; index?: number; ariaLabel?: string; optionCount?: number }
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await combos.nth(index).click({ timeout: 8_000 }).catch(() => undefined);
    for (let wait = 0; wait < 4; wait += 1) {
      await page.waitForTimeout(500).catch(() => undefined);
      const clicked = await page.evaluate((arg: unknown) => {
        const spec = (arg ?? {}) as { text?: string; index?: number; ariaLabel?: string; optionCount?: number };
        const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
        const lists = Array.from(document.querySelectorAll('[role="listbox"]')).filter(list => visible(list));
        if (lists.length === 0) return false;
        const countOf = (list: Element): number => list.querySelectorAll('[role="option"], [role="radio"]').length;
        let list: Element | undefined;
        if (spec.ariaLabel !== undefined) {
          list = lists.find(item => (item.getAttribute('aria-label') ?? '') === spec.ariaLabel);
        }
        if (list === undefined && spec.optionCount !== undefined) {
          list = lists.find(item => countOf(item) === spec.optionCount);
        }
        if (list === undefined) list = lists[0];
        if (list === undefined) return false;
        const items = Array.from(list.querySelectorAll('[role="option"], [role="radio"]'));
        let target: HTMLElement | undefined;
        if (spec.text !== undefined) {
          target = items.find(item => (item.textContent ?? '').trim() === spec.text) as HTMLElement | undefined;
        }
        if (target === undefined && spec.index !== undefined) {
          target = items[spec.index] as HTMLElement | undefined;
        }
        if (target === undefined) return false;
        target.click();
        return true;
      }, option).catch(() => false);
      if (clicked === true) return true;
    }
  }
  return false;
}

/**
 * Bấm nút theo nhãn (Meta render bằng div[role=button]); regex để không phụ
 * thuộc locale (Submit / Gửi / Đăng ký / Tạo Trang…).
 *
 * Dùng CLICK THẬT của Playwright (theo aria-label rồi tới text) vì React không
 * nhận DOM `.click()` — nếu không sẽ bấm mà trang không phản ứng.
 */
async function clickMetaButton(
  page: SignupPage,
  pattern: RegExp,
  options: { allowFallback?: boolean } = {}
): Promise<boolean> {
  const labels = await page.evaluate((arg: unknown) => {
    const spec = (arg ?? {}) as { source: string };
    if (spec.source === '') return [] as Array<{ kind: string; value: string }>;
    let regex: RegExp;
    try {
      regex = new RegExp(spec.source, 'i');
    } catch {
      return [] as Array<{ kind: string; value: string }>;
    }
    const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
    const out: Array<{ kind: string; value: string }> = [];
    for (const el of Array.from(document.querySelectorAll('[role="button"], button'))) {
      if (!visible(el)) continue;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      const aria = (el.getAttribute('aria-label') ?? '').trim();
      if (aria !== '' && regex.test(aria)) out.push({ kind: 'aria', value: aria });
      else if (text !== '' && regex.test(text)) out.push({ kind: 'text', value: text });
    }
    return out;
  }, { source: pattern.source }).catch(() => []);
  for (const label of labels) {
    if (label.kind === 'aria') {
      const locator = page.locator(`[role="button"][aria-label="${label.value}"]`);
      if (await locator.count().catch(() => 0) > 0) {
        await locator.nth(0).click({ timeout: 8_000 }).catch(() => undefined);
        await page.waitForTimeout(1_200).catch(() => undefined);
        return true;
      }
    } else {
      const locator = page.getByText(label.value, { exact: true });
      if (await locator.count().catch(() => 0) > 0) {
        await locator.first().click({ timeout: 8_000 }).catch(() => undefined);
        await page.waitForTimeout(1_200).catch(() => undefined);
        return true;
      }
    }
  }
  if (options.allowFallback !== true) return false;
  return false;
}

/** Chia tên hiển thị thành First name / Surname (lọc ký tự Meta không chấp nhận). */
function splitName(name: string): { first: string; last: string } {
  const cleaned = name
    .replace(/[0-9]+/g, ' ')
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return { first: 'Open', last: 'Creator' };
  const parts = cleaned.split(' ');
  if (parts.length === 1) return { first: parts[0] ?? 'Open', last: 'Creator' };
  return { first: parts[0] ?? 'Open', last: parts.slice(1).join(' ') };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Điền form đăng ký Meta và bấm Submit.
 * Trả về true nếu đã bấm Submit (form đã gửi đi).
 */
async function fillMetaSignupForm(
  page: SignupPage,
  options: FacebookAccountOptions
): Promise<{ submitted: boolean; message?: string }> {
  const { first, last } = splitName(options.name);
  const textInputs = page.locator('input[type="text"]');
  const count = await textInputs.count().catch(() => 0);
  if (count < 3) {
    return { submitted: false, message: `Form đăng ký Meta không đúng cấu trúc (tìm thấy ${count} ô nhập) — hãy đăng ký tay trong cửa sổ trình duyệt của cụm.` };
  }
  // Thứ tự: First name, Surname, Mobile/email, (password là input[type=password]).
  await fillAndVerify(page, 'input[type="text"]', 0, first);
  await fillAndVerify(page, 'input[type="text"]', 1, last);
  // Ô email — điền + đọc lại (chống autofill ghi đè).
  await fillEmailField(page, options.email);
  const passwordInput = page.locator('input[type="password"]');
  if (await passwordInput.count().catch(() => 0) > 0) {
    await passwordInput.nth(0).fill(options.password).catch(() => undefined);
  }
  // Ngày sinh: 3 combobox (day / month / year) — chọn theo INDEX vì nhãn/option
  // đổi theo locale (January/Tháng Một).
  const combos = page.locator('[role="combobox"]');
  const comboCount = await combos.count().catch(() => 0);
  if (comboCount >= 3) {
    await pickMetaOption(page, combos, 0, { text: String(options.day ?? 1), index: (options.day ?? 1) - 1, ariaLabel: 'Select day', optionCount: 31 });
    await pickMetaOption(page, combos, 1, { text: MONTHS[(options.month ?? 1) - 1] ?? 'January', index: (options.month ?? 1) - 1, ariaLabel: 'Select month', optionCount: 12 });
    await pickMetaOption(page, combos, 2, { text: String(options.year ?? 1995), ariaLabel: 'Select year', optionCount: 151 });
  }
  // Giới tính: combobox thứ 4 ("Select your gender") — Female/Male/Custom.
  if (comboCount >= 4) {
    await pickMetaOption(page, combos, 3, { text: options.gender ?? 'Female', index: 0, optionCount: 3 });
  }
  const submitted = await clickMetaButton(page, /^(submit|gửi|đăng ký|tạo tài khoản|create account|hoàn tất|tiếp tục|continue|sign up)$/i);
  if (!submitted) {
    const buttons = await page.evaluate(() => {
      const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
      return JSON.stringify(Array.from(document.querySelectorAll('[role="button"], button'))
        .filter(el => visible(el))
        .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30)));
    }).catch(() => '[]');
    console.log(`[social] Meta signup: không tìm thấy nút Submit — các nút đang có: ${buttons}`);
    return { submitted: false, message: 'Không tìm thấy nút "Submit" của form đăng ký Meta — hãy đăng ký tay trong cửa sổ trình duyệt của cụm.' };
  }
  return { submitted: true };
}

/**
 * Tìm ô nhập mã xác nhận của Meta.
 * Ô này KHÔNG có name/placeholder/aria (chỉ `maxlength=5|6`) ⇒ nhận diện theo
 * maxlength, theo inputmode, theo chữ "code"/"mã", hoặc fallback: trang
 * confirmemail.php chỉ có đúng 1 ô text ⇒ lấy ô text đầu tiên.
 */
async function findCodeInputSelector(page: SignupPage): Promise<string> {
  const candidates = [
    'input[maxlength="5"]',
    'input[maxlength="6"]',
    'input[inputmode="numeric"]',
    'input[name*="code" i]',
    'input[placeholder*="code" i]',
    'input[aria-label*="code" i]',
    'input[placeholder*="mã" i]',
    'input[aria-label*="mã" i]'
  ];
  for (const selector of candidates) {
    const input = page.locator(selector);
    if (await input.count().catch(() => 0) > 0) return selector;
  }
  if (page.url().includes('confirmemail.php')) return 'input[type="text"]';
  return '';
}

/** Trang sau Submit có ô nhập mã xác nhận không? */
async function findConfirmationInput(page: SignupPage): Promise<boolean> {
  const found = await page.evaluate(() => {
    const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
    const selectors = [
      'input[inputmode="numeric"]',
      'input[name*="code" i]',
      'input[placeholder*="code" i]',
      'input[aria-label*="code" i]',
      'input[type="tel"]'
    ];
    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (visible(el)) return true;
      }
    }
    return false;
  }).catch(() => false);
  return found === true;
}

/**
 * Tài khoản Facebook đã đăng nhập THẬT chưa? (cookie có thể tồn tại tạm khi
 * tài khoản mới tạo mà chưa xác nhận mã) ⇒ kiểm tra trang chủ FB có nút
 * "Đăng nhập" không + có link trang cá nhân không.
 */
export async function isFacebookSignedIn(handle: SignupHandle): Promise<boolean> {
  let page: SignupPage | undefined;
  try {
    page = await handle.newPage('https://www.facebook.com/') as SignupPage;
    await page.waitForTimeout(7_000).catch(() => undefined);
    const state = await page.evaluate(() => {
      const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
      const buttons = Array.from(document.querySelectorAll('[role="button"], button'))
        .filter(el => visible(el))
        .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
      const hasLoginButton = buttons.some(text =>
        /^(đăng nhập|log in|đăng nhập với facebook|log in with facebook)$/i.test(text));
      const hasProfileLink = document.querySelector(
        'a[href*="profile.php"], a[data-e2e="profile-icon"], a[href^="/profile"]') !== null;
      return { hasLoginButton, hasProfileLink, url: location.href };
    }).catch(() => ({ hasLoginButton: true, hasProfileLink: false, url: '' }));
    if (state.url.includes('confirmemail.php')) return false;
    return state.hasProfileLink && !state.hasLoginButton;
  } catch {
    return false;
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/**
 * Chọn hạng mục cho Page: ô "Hạng mục (Bắt buộc)" là ô search có
 * aria-label theo locale ⇒ gõ từ khoá rồi bấm gợi ý đầu tiên
 * (`li[role="option"]`). Phải dùng click THẬT (React không nhận DOM click).
 */
async function pickPageCategory(page: SignupPage): Promise<boolean> {
  const categoryInput = page.locator('input[aria-label*="ạng mục" i], input[aria-label*="hang muc" i], input[aria-label*="category" i]');
  if (await categoryInput.count().catch(() => 0) === 0) return false;
  const keywords = ['Phim', 'Video', 'Nội dung', 'Âm nhạc', 'Nghệ thuật', 'Doanh nghiệp', 'Công nghệ'];
  for (const keyword of keywords) {
    await categoryInput.nth(0).fill(keyword).catch(() => undefined);
    await page.waitForTimeout(2_500).catch(() => undefined);
    const options = page.locator('li[role="option"]');
    const count = await options.count().catch(() => 0);
    if (count === 0) continue;
    await options.nth(0).click({ timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500).catch(() => undefined);
    const stillOpen = await page.evaluate(() => {
      const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
      return Array.from(document.querySelectorAll('ul[role="listbox"]')).some(el => visible(el));
    }).catch(() => false);
    if (stillOpen !== true) return true;
  }
  return false;
}

/**
 * Tạo Facebook Page (kênh) cho tài khoản đã đăng nhập.
 * Trang `facebook.com/pages/create` dùng nhãn theo locale (VI: "Tên Trang
 * (bắt buộc)", "Hạng mục (Bắt buộc)", nút "Tạo Trang") ⇒ tìm ô theo
 * placeholder/aria-label đa ngôn ngữ + fallback theo thứ tự ô nhập.
 */
export async function createFacebookPage(
  handle: SignupHandle,
  options: { name: string; description?: string }
): Promise<FacebookAccountResult> {
  const name = options.name.trim();
  if (name === '') return { ok: false, message: 'Cần nhập tên Page' };
  let page: SignupPage | undefined;
  let manualRequired = false;
  try {
    page = await handle.newPage('https://www.facebook.com/pages/create/') as SignupPage;
    await page.waitForTimeout(9_000).catch(() => undefined);
    const url = page.url();
    if (url.includes('/login') || url.includes('accounts.google.com')) {
      manualRequired = true;
      return {
        ok: false,
        needsManual: true,
        message: 'Facebook yêu cầu đăng nhập — hãy bấm "🔑 Đăng nhập" ở cột Facebook trước, rồi bấm lại "Tạo tài khoản".'
      };
    }
    if (await hasCaptchaText(page)) {
      manualRequired = true;
      return { ok: false, needsManual: true, message: 'Facebook yêu cầu xác minh — hãy hoàn tất trong cửa sổ trình duyệt của cụm.' };
    }
    // Ô tên trang: input[type=text] (ô search của FB là type=search).
    const nameIndex = await page.evaluate(() => {
      const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
      const inputs = Array.from(document.querySelectorAll('input[type="text"]')).filter(el => visible(el));
      return inputs.length > 0 ? 0 : -1;
    }).catch(() => -1);
    if (nameIndex === null || nameIndex < 0) {
      manualRequired = true;
      return { ok: false, needsManual: true, message: 'Không tìm thấy ô tên Page trong Facebook — hãy tạo Page thủ công trong cửa sổ trình duyệt của cụm.' };
    }
    const filled = await fillAndVerify(page, 'input[type="text"]', nameIndex, name);
    if (!filled) {
      manualRequired = true;
      return { ok: false, needsManual: true, message: 'Không điền được tên Page — hãy tạo Page thủ công trong cửa sổ trình duyệt của cụm.' };
    }
    // Hạng mục (bắt buộc): gõ từ khoá + bấm gợi ý.
    const categoryOk = await pickPageCategory(page);
    if (!categoryOk) {
      manualRequired = true;
      return { ok: false, needsManual: true, message: 'Không chọn được hạng mục cho Page — hãy chọn hạng mục rồi bấm "Tạo Trang" trong cửa sổ trình duyệt của cụm.' };
    }
    // Mô tả (không bắt buộc).
    const description = (options.description ?? '').trim();
    if (description !== '') {
      const area = page.locator('textarea');
      if (await area.count().catch(() => 0) > 0) {
        await area.nth(0).fill(description).catch(() => undefined);
      }
    }
    // Nút "Tạo Trang" / "Create Page" (chỉ nút đúng nhãn, không bấm nhầm nav bar).
    const created = await clickMetaButton(page, /^(tạo trang|tao trang|create page)$/i);
    if (!created) {
      const buttons = await page.evaluate(() => {
        const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
        return JSON.stringify(Array.from(document.querySelectorAll('[role="button"], button'))
          .filter(el => visible(el))
          .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)));
      }).catch(() => '[]');
      console.log(`[social] Facebook Page: không tìm thấy nút "Tạo Trang" — các nút đang có: ${buttons}`);
      manualRequired = true;
      return { ok: false, needsManual: true, message: 'Không tìm thấy nút "Tạo Trang" — hãy tạo Page thủ công trong cửa sổ trình duyệt của cụm.' };
    }
    await page.waitForTimeout(7_000).catch(() => undefined);
    // Facebook có thể hỏi xác nhận thêm 1 bước.
    await clickMetaButton(page, /^(tạo trang|tao trang|create|ok|đồng ý|xác nhận|confirm)$/i);
    await page.waitForTimeout(5_000).catch(() => undefined);
    // Tên Page đã tồn tại ⇒ coi như đã có Page (không phải lỗi).
    const existsNotice = await page.evaluate(() => {
      const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
      for (const el of Array.from(document.querySelectorAll('div, span, label'))) {
        if (!visible(el)) continue;
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text.length > 200) continue;
        if (/đã quản lý Trang còn tên là|already managing a page named|đã tồn tại|already exists/i.test(text)) {
          return text.slice(0, 160);
        }
      }
      return '';
    }).catch(() => '');
    if (existsNotice !== '') {
      return { ok: true, accountName: name, accountUrl: page.url(), message: `Page "${name}" đã tồn tại trong tài khoản Facebook (${existsNotice})` };
    }
    // Lấy Page ID từ URL sau khi tạo (facebook.com/<pageName> hoặc /pages/id/...).
    const finalUrl = page.url();
    const pageId = /\/pages\/(?:id\/)?(\d+)/.exec(finalUrl)?.[1] ?? /page_id=(\d+)/.exec(finalUrl)?.[1] ?? '';
    return { ok: true, accountName: name, accountUrl: finalUrl, ...(pageId !== '' ? { pageId } : {}) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!manualRequired) await page?.close().catch(() => undefined);
  }
}

/** Trang có CAPTCHA không? */
async function hasCaptchaText(page: SignupPage): Promise<boolean> {
  const html = await page.evaluate(() => document.documentElement?.outerHTML?.slice(0, 120_000) ?? '').catch(() => '');
  const lower = html.toLowerCase();
  return ['captcha', 'recaptcha', 'hcaptcha', 'verify you are human'].some(marker => lower.includes(marker));
}

/**
 * Tạo tài khoản Facebook bằng Gmail của cụm.
 * `readConfirmationCode` được truyền vào để lấy mã 6 số từ hộp thư Gmail.
 */
export async function createFacebookAccountWithGmail(
  handle: SignupHandle,
  options: FacebookAccountOptions,
  deps: {
    /** Đọc mã xác nhận 6 số từ Gmail (trả về '' nếu chưa có mail). */
    readConfirmationCode: () => Promise<string>;
    /** Gọi sau mỗi mốc (form-filled / submitted / code-read) — dùng để chụp ảnh kiểm chứng. */
    onStage?: (stage: string) => Promise<void>;
  }
): Promise<FacebookAccountResult> {
  const email = options.email.trim();
  if (email === '') {
    return { ok: false, needsManual: true, message: 'Cần email (Gmail) của cụm để đăng ký Facebook.' };
  }
  const stage = async (name: string): Promise<void> => {
    if (deps.onStage === undefined) return;
    await deps.onStage(name).catch(() => undefined);
  };
  let page: SignupPage | undefined;
  let manualRequired = false;
  try {
    if (await hasFacebookSessionCookies(handle) && await isFacebookSignedIn(handle)) {
      return { ok: true, accountName: options.name, accountUrl: 'https://www.facebook.com/' };
    }
    // Phiên đăng ký dở từ lần trước (đã nhận mã nhưng chưa xác nhận) khiến
    // /reg chuyển thẳng sang trang nhập mã ⇒ xóa cookie Facebook cho sạch.
    await (handle as SignupHandleWithCookies).clearCookies?.(/(^|\.)facebook\.com$/).catch(() => undefined);
    page = await handle.newPage('https://www.facebook.com/reg') as SignupPage;
    await page.waitForTimeout(8_000).catch(() => undefined);
    if (page.url().includes('confirmemail.php')) {
      // Vẫn còn phiên treo → xóa thêm lần nữa rồi tải lại form.
      await (handle as SignupHandleWithCookies).clearCookies?.(/(^|\.)facebook\.com$/).catch(() => undefined);
      await page.goto('https://www.facebook.com/reg', { timeout: 60_000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForTimeout(7_000).catch(() => undefined);
    }
    const form = await fillMetaSignupForm(page, options);
    await stage('form-filled');
    if (!form.submitted) {
      manualRequired = true;
      return { ok: false, needsManual: true, message: form.message ?? 'Không điền được form đăng ký Meta.' };
    }
    await stage('submitted');
    await page.waitForTimeout(6_000).catch(() => undefined);

    // Meta gửi mã xác nhận 6 số về Gmail → đọc mail và điền mã.
    let code = '';
    for (let attempt = 0; attempt < 12 && code === ''; attempt += 1) {
      code = (await deps.readConfirmationCode().catch(() => '')).trim();
      if (code === '') await page.waitForTimeout(5_000).catch(() => undefined);
    }
    await stage(code === '' ? 'code-missing' : `code-${code}`);
    if (code === '') {
      manualRequired = true;
      return {
        ok: false,
        needsManual: true,
        message: `Facebook đã gửi mã xác nhận về ${email} nhưng chưa đọc được mã trong hộp thư — hãy nhập mã trong cửa sổ trình duyệt của cụm (mật khẩu tài khoản: ${options.password}).`,
        email,
        password: options.password
      };
    }
    const codeSelector = await findCodeInputSelector(page);
    if (codeSelector !== '') {
      const codeInput = page.locator(codeSelector);
      // Ô Meta giới hạn đúng số ký tự (maxlength=5) ⇒ cắt mã cho vừa.
      const maxLength = await page.evaluate((arg: unknown) => {
        const selector = (typeof arg === 'string' ? arg : '');
        const el = document.querySelector(selector);
        const raw = el?.getAttribute('maxlength') ?? '';
        const value = Number(raw);
        return Number.isFinite(value) && value > 0 ? value : 0;
      }, codeSelector).catch(() => 0);
      const typed = maxLength > 0 ? code.slice(0, maxLength) : code;
      await codeInput.nth(0).fill(typed).catch(() => undefined);
      await page.waitForTimeout(1_000).catch(() => undefined);
      await clickMetaButton(page, /^(confirm|xác nhận|tiếp tục|continue|submit|đăng ký|gửi|hoàn tất|verify)$/i);
      await page.waitForTimeout(7_000).catch(() => undefined);
    } else if (await findConfirmationInput(page)) {
      manualRequired = true;
      return {
        ok: false,
        needsManual: true,
        message: `Facebook đã gửi mã xác nhận (${code}) về ${email} — hãy nhập mã trong cửa sổ trình duyệt của cụm.`,
        email,
        password: options.password
      };
    }
    const signedIn = await isFacebookSignedIn(handle);
    if (signedIn) {
      return {
        ok: true,
        accountName: options.name,
        accountUrl: 'https://www.facebook.com/',
        email,
        password: options.password
      };
    }
    manualRequired = true;
    return {
      ok: false,
      needsManual: true,
      message: `Đã gửi form đăng ký Facebook với ${email} — hãy hoàn tất bước xác nhận trong cửa sổ trình duyệt của cụm (mật khẩu: ${options.password}).`,
      email,
      password: options.password
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!manualRequired) await page?.close().catch(() => undefined);
  }
}
