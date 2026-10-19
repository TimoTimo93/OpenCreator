/**
 * Bot upload YouTube Studio (qua trình duyệt Patchright).
 * Triển khai theo selector config — kịch bản: mở Studio → Tạo → Tải video lên
 * → điền tiêu đề/mô tả → "Không dành cho trẻ em" → Next x3 → hẹn giờ (nếu có)
 * → Done. Lỗi đăng nhập → loginStatus 'expired' để UI nhắc đăng nhập lại.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'patchright';
import type { SocialExecutionContext, SocialExecutionResult } from '../worker.js';

type YtSelectors = {
  upload_url: string;
  create_btn: string;
  upload_menu_item: string;
  file_input: string;
  title_box: string;
  desc_box: string;
  not_for_kids_radio: string;
  next_btn: string;
  schedule_radio: string;
  date_trigger: string;
  date_input: string;
  time_input: string;
  done_btn: string;
};

const SELECTORS_PATH = new URL('./selectors.json', import.meta.url);

async function selectors(): Promise<YtSelectors> {
  const raw = JSON.parse(await readFile(SELECTORS_PATH, 'utf8')) as {
    youtube_studio: YtSelectors;
  };
  return raw.youtube_studio;
}

export async function uploadYoutubeStudio(context: SocialExecutionContext): Promise<SocialExecutionResult> {
  if (context.browser === undefined) {
    return { status: 'failed', error: 'Trình duyệt cụm chưa mở (không thể upload YouTube không có trình duyệt)' };
  }
  const sel = await selectors();
  const page = await context.browser.newPage(sel.upload_url) as Page;
  try {
    // Chưa đăng nhập → Studio đẩy về accounts.google.com.
    await page.waitForTimeout(4_000);
    if (page.url().includes('accounts.google.com') || page.url().includes('ServiceLogin')) {
      return { status: 'failed', error: 'Chưa đăng nhập YouTube cho cụm này (mở trình duyệt để đăng nhập)', loginStatus: 'expired' };
    }
    return await uploadFlow(page, context, sel);
  } catch (error) {
    const screenshotPath = await saveScreenshot(page, context);
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      screenshotPath,
      loginStatus: page.url().includes('accounts.google.com') ? 'expired' : undefined
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function uploadFlow(page: Page, context: SocialExecutionContext, sel: YtSelectors): Promise<SocialExecutionResult> {
  const videoPath = context.job.videoPath;
  if (videoPath === '' || !(await exists(videoPath))) {
    return { status: 'failed', error: `File video không tồn tại: ${videoPath}` };
  }
  // Bấm Tạo → Tải video lên (nếu nút dựng lại thành menu).
  const createBtn = page.locator(sel.create_btn).first();
  if (await createBtn.isVisible().catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(1_000);
    const uploadItem = page.locator(sel.upload_menu_item).first();
    if (await uploadItem.isVisible().catch(() => false)) {
      await uploadItem.click();
      await page.waitForTimeout(1_500);
    }
  }
  // Đẩy file vào input file.
  const fileInput = page.locator(sel.file_input).first();
  await fileInput.waitFor({ state: 'visible', timeout: 30_000 });
  await fileInput.setInputFiles(videoPath);
  await page.waitForTimeout(5_000);

  // Tiêu đề (max 100 ký tự).
  const titleBox = page.locator(sel.title_box).first();
  await titleBox.waitFor({ state: 'visible', timeout: 45_000 });
  await fillEditable(titleBox, page, context.job.title.slice(0, 100));

  // Mô tả (max 4900 ký tự) nếu khung xuất hiện.
  const descBox = page.locator(sel.desc_box).first();
  if (await descBox.isVisible().catch(() => false)) {
    await fillEditable(descBox, page, context.job.description.slice(0, 4_900));
  }

  // "Không nội dung nhạy cảm trẻ em"
  const notKids = page.locator(sel.not_for_kids_radio).first();
  if (await notKids.isVisible().catch(() => false)) {
    await notKids.scrollIntoViewIfNeeded();
    await notKids.click();
    await page.waitForTimeout(1_000);
  }

  // Next qua 3 bước (Chi tiết → Thành phần → Kiểm tra).
  const nextBtn = page.locator(sel.next_btn).first();
  for (let step = 0; step < 3; step += 1) {
    if (await nextBtn.isVisible().catch(() => false)) {
      await nextBtn.click();
      await page.waitForTimeout(1_500);
    } else {
      break;
    }
  }

  // Hẹn giờ phát sóng.
  const scheduledAtLocal = toLocalParts(context.job.scheduledAt);
  if (scheduledAtLocal !== null && scheduledAtLocal.getTime() - Date.now() > 10 * 60_000) {
    const scheduleRadio = page.locator(sel.schedule_radio).first();
    if (await scheduleRadio.isVisible().catch(() => false)) {
      await scheduleRadio.click();
      await page.waitForTimeout(1_000);
      await page.locator(sel.date_trigger).first().click();
      await page.waitForTimeout(800);
      const dateInput = page.locator(sel.date_input).first();
      await dateInput.click();
      await dateInput.fill('');
      await typeSlowly(page, formatViDate(scheduledAtLocal));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      const timeInput = page.locator(sel.time_input).first();
      await timeInput.click();
      await timeInput.fill('');
      await typeSlowly(page, scheduledAtLocal.toTimeString().slice(0, 5));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1_000);
    } else {
      return { status: 'failed', error: 'Không tìm thấy tùy chọn hẹn giờ YouTube Studio' };
    }
  }

  // Chờ tải lên xong và bấm Done.
  const doneBtn = page.locator(sel.done_btn).first();
  await doneBtn.waitFor({ state: 'visible', timeout: 300_000 });
  await doneBtn.click();
  await page.waitForTimeout(5_000);
  return { status: scheduledAtLocal !== null ? 'scheduled' : 'published' };
}

async function fillEditable(locator: import('patchright').Locator, page: Page, text: string): Promise<void> {
  await locator.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await typeSlowly(page, text);
}

async function typeSlowly(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 30 });
}

function formatViDate(date: Date): string {
  // YT Studio vi-VN: "30 thg 10, 2026"
  return `${date.getDate()} thg ${date.getMonth() + 1}, ${date.getFullYear()}`;
}

/** ISO UTC → Date theo giờ máy (khung giờ người dùng). */
function toLocalParts(iso: string): Date | null {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return new Date(time);
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
    const path = join(context.screenshotDir, `yt-${Date.now()}.png`);
    await page.screenshot({ path, fullPage: false });
    return path;
  } catch {
    return undefined;
  }
}
