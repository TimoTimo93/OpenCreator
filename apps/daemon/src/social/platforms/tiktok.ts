/**
 * Bot upload TikTok Studio (qua trình duyệt Patchright).
 * Kịch bản: mở Studio → đẩy file → đợi 100% → điền caption/hashtag
 * (typing từng ký tự để pop-up tag kịp xuất hiện) → hẹn giờ → Đăng.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'patchright';
import type { SocialExecutionContext, SocialExecutionResult } from '../worker.js';
import type { SocialTikTokSettings } from '../types.js';

type TkSelectors = {
  upload_url: string;
  file_input: string;
  upload_complete_indicator: string;
  caption_editor: string;
  schedule_radio: string;
  schedule_date_input: string;
  schedule_time_input: string;
  privacy_select: string;
  privacy_option: string;
  switch_control: string;
  post_btn: string;
  cookie_banner_btn: string;
  split_window_not_now_btn: string;
  copyright_popup_btn: string;
  post_now_btn: string;
  post_confirmation: string;
};

const SELECTORS_PATH = new URL('./selectors.json', import.meta.url);

async function selectors(): Promise<TkSelectors> {
  const raw = JSON.parse(await readFile(SELECTORS_PATH, 'utf8')) as { tiktok_studio: TkSelectors };
  return raw.tiktok_studio;
}

export async function uploadTikTokStudio(context: SocialExecutionContext): Promise<SocialExecutionResult> {
  if (context.browser === undefined) {
    return { status: 'failed', error: 'Trình duyệt cụm chưa mở' };
  }
  const sel = await selectors();
  const page = await context.browser.newPage(sel.upload_url) as Page;
  try {
    await page.waitForTimeout(4_000);
    await dismissPopups(page, sel);
    if (/\/login|accounts\.tiktok/.test(new URL(page.url()).pathname)) {
      return { status: 'failed', error: 'Chưa đăng nhập TikTok cho cụm này (mở trình duyệt để đăng nhập)', loginStatus: 'expired' };
    }
    return await uploadFlow(page, context, sel);
  } catch (error) {
    const screenshotPath = await saveScreenshot(page, context);
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      screenshotPath,
      loginStatus: /\/login/.test(page.url()) ? 'expired' : undefined
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function uploadFlow(page: Page, context: SocialExecutionContext, sel: TkSelectors): Promise<SocialExecutionResult> {
  const videoPath = context.job.videoPath;
  if (videoPath === '' || !(await exists(videoPath))) {
    return { status: 'failed', error: `File video không tồn tại: ${videoPath}` };
  }
  // 1. Chọn file.
  const fileInput = page.locator(sel.file_input).first();
  await fileInput.waitFor({ state: 'attached', timeout: 30_000 });
  await fileInput.setInputFiles(videoPath);
  // TikTok hay bật modal "Bật kiểm tra nội dung tự động?" ngay sau khi chọn
  // file ⇒ đóng trước khi điền caption (modal chặn click).
  await page.waitForTimeout(2_500).catch(() => undefined);
  await dismissBlockingModals(page);

  // 2. Caption + hashtag: điền sau khung soạn thảo xuất hiện.
  const editor = page.locator(sel.caption_editor).first();
  await editor.waitFor({ state: 'visible', timeout: 45_000 });
  await editor.click({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await typeWithHashtags(page, context.job.title, context.job.description.slice(0, 2_000));
  await dismissBlockingModals(page);
  // Popup cửa sổ chia màn hình (split window) sau khi nhập caption (bỏ
  // nếu có) — rút gọn từ luồng `tiktok-uploader` cộng đồng.
  await page.waitForTimeout(1_000);
  await clickIfVisible(page, sel.split_window_not_now_btn);

  // 3. Đợi upload 100% (tối đa 5 phút cho file nặng).
  await page.locator(sel.upload_complete_indicator).first()
    .waitFor({ state: 'visible', timeout: 300_000 });
  await page.waitForTimeout(2_000);

  // 3.5. Cấu hình riêng từng job: quyền xem + toggle duet/stitch/bình luận
  // (best-effort — form TikTok đổi thường, không thấy điều khiển thì bỏ qua).
  await applyTikTokSettings(page, sel, context.job.platformSettings.tiktok);

  // 4. Hẹn giờ nếu có (TikTok chỉ nhận lịch ≥20 phút tới ≤10 ngày, phút bội số 5).
  let scheduled = false;
  const scheduledAtMs = new Date(context.job.scheduledAt).getTime();
  if (scheduledAtMs - Date.now() > 20 * 60_000) {
    const scheduleToggle = page.locator(sel.schedule_radio).first();
    if (await scheduleToggle.isVisible().catch(() => false)) {
      await scheduleToggle.click();
      await page.waitForTimeout(1_500);
      await fillSchedule(page, new Date(scheduledAtMs), sel);
      scheduled = true;
    }
  }

  // 5. Đăng / Lên lịch.
  const postBtn = page.locator(sel.post_btn).first();
  await postBtn.scrollIntoViewIfNeeded().catch(() => undefined);
  await postBtn.click();
  await page.waitForTimeout(2_000);
  // Popup bản quyền âm thanh/nhạc nền — chọn "vẫn đăng" nếu xuất hiện
  // (best-effort; TikTok hiện popup xếp.slot khác nhau theo khu vực).
  await clickIfVisible(page, sel.copyright_popup_btn);
  await page.waitForTimeout(1_000);
  // Xác nhận "Post now / Đăng ngay" (modal sau khi bấm Lên lịch hiện hành)
  // — chưa thấy thì bỏ qua.
  await clickIfVisible(page, sel.post_now_btn);
  await page.waitForTimeout(4_000);
  return { status: scheduled ? 'scheduled' : 'published' };
}

/**
 * Đóng các popup cản chu trình đăng: banner cookie, popup cửa sổ chia màn
 * hình — deploy luồng cộng đồng (thêm từng cái, không chặn khi không thấy).
 */
async function clickIfVisible(page: Page, selector: string): Promise<void> {
  try {
    const target = page.locator(selector).first();
    if (await target.isVisible().catch(() => false)) {
      await target.click();
      await page.waitForTimeout(600);
    }
  } catch {
    // Không chặn luồng đăng.
  }
}

async function dismissPopups(page: Page, sel: TkSelectors): Promise<void> {
  await clickIfVisible(page, sel.cookie_banner_btn);
}

/**
 * Đóng các modal của TikTok Studio đang chặn thao tác (ví dụ "Bật kiểm tra
 * nội dung tự động?" sau khi chọn file) — overlay này chặn mọi click nên
 * upload fail. Ưu tiên nút "bỏ qua" (Hủy / Bỏ qua / Không / Not now),
 * không có thì dùng Escape.
 */
async function dismissBlockingModals(page: Page): Promise<void> {
  const skipLabels = [/^hủy$/i, /^hủy bỏ qua$/i, /^bỏ qua$/i, /^không$/i, /^để sau$/i, /^not now$/i, /^skip$/i, /^cancel$/i, /^close$/i, /^đóng$/i, /^next$/i, /^tiếp$/i, /^tiếp tục$/i, /^done$/i, /^hoàn tất$/i, /^xong$/i];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const open = await page.evaluate(() => {
      const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
      const overlays = Array.from(document.querySelectorAll(
        '.TUXModal-overlay, [data-floating-ui-portal] [role="dialog"], #react-joyride-portal, [data-test-id="joyride"]'
      )).filter(el => visible(el));
      return overlays.length;
    }).catch(() => 0);
    if (!open || open === 0) return;
    const buttons = page.locator('.TUXModal-overlay button, [data-floating-ui-portal] [role="dialog"] button, #react-joyride-portal button');
    const count = await buttons.count().catch(() => 0);
    let clicked = false;
    for (let index = 0; index < count; index += 1) {
      const text = (await buttons.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (text === '' || !skipLabels.some(pattern => pattern.test(text))) continue;
      await buttons.nth(index).click({ timeout: 5_000 }).catch(() => undefined);
      clicked = true;
      break;
    }
    if (!clicked) {
      // Tour của TikTok (react-joyride) thường có nút "Skip"/"Bỏ qua" ở góc.
      const joyrideSkip = page.locator("#react-joyride-portal [data-test-id*='skip' i], #react-joyride-portal button:has-text('Skip'), #react-joyride-portal button:has-text('Bỏ qua')").first();
      if (await joyrideSkip.isVisible().catch(() => false)) {
        await joyrideSkip.click({ timeout: 5_000 }).catch(() => undefined);
      } else {
        await page.keyboard.press('Escape').catch(() => undefined);
      }
    }
    await page.waitForTimeout(1_200).catch(() => undefined);
  }
}

/** Điền caption từng từ; từ #hashtag gõ chậm kèm Enter để pop-up tag kịp mở. */
async function typeWithHashtags(page: Page, title: string, description: string): Promise<void> {
  const words = `${title} ${description}`.split(/\s+/).filter(word => word !== '');
  for (const word of words) {
    if (word.startsWith('#') && word.length > 1) {
      await page.keyboard.type(word, { delay: 50 });
      await page.waitForTimeout(1_200);
      await page.keyboard.press('Enter');
    } else {
      await page.keyboard.type(`${word} `, { delay: 30 });
    }
  }
}

const TK_PRIVACY_LABELS: Record<NonNullable<SocialTikTokSettings['privacy']>, RegExp> = {
  public: /mọi người|công khai|everyone|public/i,
  friends: /bạn bè|friends/i,
  private: /riêng tư|chỉ mình tôi|private|only me/i
};

const TK_TOGGLE_LABELS: Partial<Record<keyof SocialTikTokSettings, RegExp>> = {
  allowComments: /bình luận|comment/i,
  allowDuet: /duet|dằn đôi/i,
  allowStitch: /stitch|ghép/i,
  directPost: /direct post|đăng trực tiếp/i
};

/**
 * Áp dụng cấu hình TikTok vào form upload: dropdown "Ai có thể xem" + các
 * toggle (bình luận/Duet/Stitch/Direct post). Best-effort — điều khiển không
 * thấy (DOM đổi/gói khu vực khác) thì bỏ qua, không chặn việc đăng.
 */
async function applyTikTokSettings(
  page: Page,
  sel: TkSelectors,
  settings?: SocialTikTokSettings
): Promise<void> {
  if (settings === undefined) return;
  const privacy = settings.privacy;
  if (privacy !== undefined) {
    try {
      const select = page.locator(sel.privacy_select).first();
      if (await select.isVisible().catch(() => false)) {
        await select.click();
        await page.waitForTimeout(800);
        const option = page.locator(sel.privacy_option)
          .filter({ hasText: TK_PRIVACY_LABELS[privacy] })
          .first();
        await option.click({ timeout: 5_000 });
        await page.waitForTimeout(500);
      }
    } catch {
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
  for (const key of ['allowComments', 'allowDuet', 'allowStitch', 'directPost'] as const) {
    const desired = settings[key];
    if (desired === undefined) continue;
    await toggleByLabel(page, sel, TK_TOGGLE_LABELS[key]!, desired);
  }
}

/** Bật/tắt một công tắc theo nhãn (aria-label hoặc văn bản dòng chứa nó). */
async function toggleByLabel(page: Page, sel: TkSelectors, label: RegExp, desired: boolean): Promise<void> {
  try {
    const controls = page.locator(sel.switch_control);
    const count = await controls.count();
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      const ownLabel = await control.getAttribute('aria-label').catch(() => null) ?? '';
      const rowText = await control.locator('xpath=ancestor::*[self::div or self::label][1]')
        .textContent()
        .catch(() => '') ?? '';
      const text = `${ownLabel} ${rowText}`;
      if (!label.test(text)) continue;
      const checked = await control.getAttribute('aria-checked').catch(() => null)
        ?? (await control.locator('input[type="checkbox"]').first().isChecked().catch(() => false) ? 'true' : 'false');
      if ((checked === 'true') !== desired) {
        await control.click().catch(() => undefined);
        await page.waitForTimeout(400);
      }
      return;
    }
  } catch {
    // Bỏ qua — không chặn luồng đăng.
  }
}

async function fillSchedule(page: Page, when: Date, sel: TkSelectors): Promise<void> {
  // TikTok scheduler chỉ nhận phút bội số 5 (chuẩn `tiktok-uploader` fwd).
  const rounded = new Date(when.getTime());
  rounded.setSeconds(0, 0);
  rounded.setMinutes(rounded.getMinutes() - (rounded.getMinutes() % 5));
  const dateInput = page.locator(sel.schedule_date_input).first();
  if (await dateInput.isVisible().catch(() => false)) {
    await dateInput.click();
    await dateInput.fill('');
    await dateInput.type(formatISODate(rounded), { delay: 40 });
    const timeInput = page.locator(sel.schedule_time_input).first();
    if (await timeInput.isVisible().catch(() => false)) {
      await timeInput.click();
      await timeInput.fill('');
      await timeInput.type(rounded.toTimeString().slice(0, 5), { delay: 40 });
    }
    await page.keyboard.press('Escape');
  }
}

function formatISODate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, { flag: 'r' });
    return true;
  } catch {
    return false;
  }
}

async function saveScreenshot(page: Page, context: SocialExecutionContext): Promise<string | undefined> {
  try {
    const path = join(context.screenshotDir, `tk-${Date.now()}.png`);
    await page.screenshot({ path, fullPage: false });
    return path;
  } catch {
    return undefined;
  }
}
