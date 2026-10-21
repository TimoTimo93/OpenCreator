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
import type { SocialYouTubeSettings } from '../types.js';

type YtSelectors = {
  upload_url: string;
  create_btn: string;
  upload_menu_item: string;
  file_input: string;
  title_box: string;
  desc_box: string;
  not_for_kids_radio: string;
  for_kids_radio: string;
  tags_input: string;
  visibility_trigger: string;
  next_btn: string;
  schedule_radio: string;
  date_trigger: string;
  date_input: string;
  time_input: string;
  done_btn: string;
  publish_confirm_btn: string;
  published_confirmation: string;
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

/**
 * Đóng các overlay/modal của YouTube Studio đang chặn thao tác (consent,
 * "Welcome", tour hướng dẫn…) — nếu không, mọi click sau đó đều bị overlay
 * chặn và upload fail.
 */
async function dismissStudioOverlays(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // Tour điều hướng của Studio có nút "Skip navigation" → bấm để tắt.
    const skipNav = page.locator("button[aria-label='Skip navigation'], button[aria-label*='Bỏ qua' i]").first();
    if (await skipNav.isVisible().catch(() => false)) {
      await skipNav.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(800).catch(() => undefined);
      continue;
    }
    const open = await page.evaluate(() => {
      const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
      const backdrops = Array.from(document.querySelectorAll('tp-yt-iron-overlay-backdrop[opened]'));
      const dialogs = Array.from(document.querySelectorAll('ytcp-popup-container tp-yt-iron-overlay, ytcp-popup-container'))
        .filter(el => visible(el));
      return backdrops.length + dialogs.length;
    }).catch(() => 0);
    if (!open || open === 0) return;
    // Ưu tiên bấm nút đóng (X) trong overlay; không có thì dùng Escape.
    const closeBtn = page.locator('tp-yt-iron-overlay tp-yt-icon-button button, tp-yt-iron-overlay button[aria-label*="Close" i], tp-yt-iron-overlay button[aria-label*="Đóng" i]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ timeout: 5_000 }).catch(() => undefined);
    } else {
      await page.keyboard.press('Escape').catch(() => undefined);
    }
    await page.waitForTimeout(1_200).catch(() => undefined);
  }
}

async function uploadFlow(page: Page, context: SocialExecutionContext, sel: YtSelectors): Promise<SocialExecutionResult> {
  const videoPath = context.job.videoPath;
  if (videoPath === '' || !(await exists(videoPath))) {
    return { status: 'failed', error: `File video không tồn tại: ${videoPath}` };
  }
  await dismissStudioOverlays(page);
  // Ô file của Studio luôn bị ẩn ⇒ phải chờ 'attached' chứ không phải 'visible'.
  const fileInput = page.locator(sel.file_input).first();
  if (await fileInput.count().catch(() => 0) === 0) {
    // Mở hộp thoại tải video: nút "Upload videos" ở trang video, hoặc Create → Tải video lên.
    const uploadVideos = page.locator("button[aria-label='Upload videos'], button[aria-label='Tải video lên']").first();
    if (await uploadVideos.isVisible().catch(() => false)) {
      await uploadVideos.click({ timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(2_500).catch(() => undefined);
    } else {
      const createBtn = page.locator(sel.create_btn).first();
      if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click({ timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(1_000);
        const uploadItem = page.locator(sel.upload_menu_item).first();
        if (await uploadItem.isVisible().catch(() => false)) {
          await uploadItem.click({ timeout: 10_000 }).catch(() => undefined);
          await page.waitForTimeout(1_500);
        }
      }
    }
    await dismissStudioOverlays(page);
  }
  // Hộp thoại "Upload videos" mới chỉ tạo ô input sau khi bấm "Select files".
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await fileInput.count().catch(() => 0) > 0) break;
    const selectFiles = page.locator("button[aria-label='Select files'], button:has-text('Select files'), button:has-text('Chọn tệp')").first();
    if (await selectFiles.isVisible().catch(() => false)) {
      await selectFiles.click({ timeout: 8_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500).catch(() => undefined);
    } else {
      break;
    }
  }
  await fileInput.waitFor({ state: 'attached', timeout: 45_000 });
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

  // Thẻ (tags) nằm ở trang "Chi tiết" — điền ngay sau mô tả (best-effort).
  await fillYoutubeTags(page, sel, context.job.platformSettings.youtube);

  // "Không nội dung nhạy cảm trẻ em" — hoặc "Dành cho trẻ em" nếu job chỉ định.
  const madeForKids = context.job.platformSettings.youtube?.madeForKids === true;
  if (madeForKids) {
    const forKids = page.locator(sel.for_kids_radio).first();
    if (await forKids.isVisible().catch(() => false)) {
      await forKids.scrollIntoViewIfNeeded();
      await forKids.click();
      await page.waitForTimeout(1_000);
    }
  } else {
    const notKids = page.locator(sel.not_for_kids_radio).first();
    if (await notKids.isVisible().catch(() => false)) {
      await notKids.scrollIntoViewIfNeeded();
      await notKids.click();
      await page.waitForTimeout(1_000);
    }
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

  // Quyền xem (Công khai/Không công khai/Riêng tư) ở bước cuối (best-effort).
  await selectYoutubeVisibility(page, sel, context.job.platformSettings.youtube);

  // Hẹn giờ phát sóng.
  const scheduledAtLocal = toLocalParts(context.job.scheduledAt);
  const publishingNow = scheduledAtLocal === null || scheduledAtLocal.getTime() - Date.now() <= 10 * 60_000;
  if (!publishingNow) {
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
  } else {
    // Đăng ngay ⇒ PHẢI chọn "Công khai" (radio PUBLIC trong UI mới), nếu không
    // YouTube lưu video thành "Draft" và không ai xem được.
    const publicRadio = page.locator("tp-yt-paper-radio-button[name='PUBLIC'], tp-yt-paper-radio-button#public-radio-button").first();
    if (await publicRadio.isVisible().catch(() => false)) {
      await publicRadio.scrollIntoViewIfNeeded().catch(() => undefined);
      await publicRadio.click({ timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
    }
  }

  // Chờ tải lên xong và bấm Save (UI mới dùng nút "Save"; bản cũ là
  // ytcp-button#done-button) — không bấm thì video chỉ ở trạng thái Draft.
  const saveBtn = page.locator("ytcp-button#done-button, button[aria-label='Save'], button[aria-label='Lưu'], button:has-text('Save')").first();
  await saveBtn.waitFor({ state: 'visible', timeout: 300_000 });
  await saveBtn.click({ timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(3_000);
  // Bước "Kiểm tra/Quyền" hoàn tất → hộp thoại xác nhận phát hành (laid out
  // theo cấu trúc luồng youtube_uploader_selenium cộng đồng): best-effort —
  // nếu duỗi ra "Publish/Đăng" trong dialog thì bấm, không thấy thì bỏ qua.
  try {
    const confirmBtn = page.locator(sel.publish_confirm_btn).first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click();
      await page.waitForTimeout(2_000);
    }
  } catch {
    // Không chặn luồng.
  }
  await page.waitForTimeout(3_000);
  // Kiểm chứng: video phải được publish (không còn là "Draft") — nếu không thì
  // báo lỗi thay vì trả "published" (trước đây app báo thành công dù chỉ lưu nháp).
  const draft = await verifyYoutubeNotDraft(page, context.job.title);
  if (draft === 'draft') {
    return { status: 'failed', error: 'YouTube lưu video thành "Draft" (chưa công khai) — cần chọn "Công khai" ở bước Quyền xem rồi bấm Save/Đăng lại.' };
  }
  return { status: scheduledAtLocal !== null ? 'scheduled' : 'published' };
}

/** Mở danh sách video của kênh và kiểm tra video vừa đăng có còn là "Draft" không. */
async function verifyYoutubeNotDraft(page: Page, title: string): Promise<'draft' | 'ok' | 'unknown'> {
  try {
    const channelId = /\/channel\/([A-Za-z0-9_-]+)/.exec(page.url())?.[1] ?? '';
    if (channelId === '') return 'unknown';
    await page.goto(`https://studio.youtube.com/channel/${channelId}/videos/upload`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(8_000);
    const state = await page.evaluate((arg: unknown) => {
      const expected = (typeof arg === 'string' ? arg : '').trim();
      const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
      const rows = Array.from(document.querySelectorAll('ytcp-video-row, tr')).filter(el => visible(el));
      for (const row of rows) {
        const text = (row.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (expected !== '' && !text.includes(expected.slice(0, 30))) continue;
        if (/Draft|Nháp|draft/i.test(text)) return 'draft';
        return 'ok';
      }
      return 'unknown';
    }, title);
    return state === 'draft' ? 'draft' : state === 'ok' ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function fillEditable(locator: import('patchright').Locator, page: Page, text: string): Promise<void> {
  await locator.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await typeSlowly(page, text);
}

/**
 * Điền tags YouTube (Studio giới hạn ~500 ký tự tổng — đã cắt khi validate).
 * Best-effort: ô thẻ thường ẩn sau "Hiển thị thêm"; không thấy → bỏ qua.
 */
async function fillYoutubeTags(page: Page, sel: YtSelectors, settings?: SocialYouTubeSettings): Promise<void> {
  const tags = settings?.tags ?? [];
  if (tags.length === 0) return;
  try {
    const tagsInput = page.locator(sel.tags_input).first();
    if (!(await tagsInput.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true).catch(() => false))) return;
    await tagsInput.scrollIntoViewIfNeeded().catch(() => undefined);
    await tagsInput.click();
    for (const tag of tags.slice(0, 30)) {
      await page.keyboard.type(tag, { delay: 20 });
      await page.keyboard.press(',');
      await page.waitForTimeout(150);
    }
  } catch {
    // Không chặn luồng upload nếu form đổi.
  }
}

const VISIBILITY_LABELS: Record<NonNullable<SocialYouTubeSettings['privacy']>, RegExp> = {
  public: /công khai|public/i,
  unlisted: /không công khai|unlisted/i,
  private: /riêng tư|private/i
};

/** Chọn quyền xem trong dropdown trang cuối của Studio (best-effort). */
async function selectYoutubeVisibility(
  page: Page,
  sel: YtSelectors,
  settings?: SocialYouTubeSettings
): Promise<void> {
  const privacy = settings?.privacy;
  if (privacy === undefined) return;
  try {
    const trigger = page.locator(sel.visibility_trigger).first();
    if (!(await trigger.isVisible().catch(() => false))) return;
    await trigger.click();
    await page.waitForTimeout(1_000);
    const option = page
      .locator("[role='option'], tp-yt-paper-item, ytcp-visibility-radio-button")
      .filter({ hasText: VISIBILITY_LABELS[privacy] })
      .first();
    await option.click({ timeout: 5_000 });
    await page.waitForTimeout(800);
  } catch {
    await page.keyboard.press('Escape').catch(() => undefined);
  }
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
