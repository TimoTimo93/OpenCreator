/**
 * Bot Facebook Dual-Mode:
 * - GRAPH_API: chunked resumable upload qua Graph API chính thức (video lớn
 *   100MB–2GB không đứt), hẹn giờ `scheduled_publish_time` (tối thiểu 10 phút,
 *   tối đa 75 ngày).
 * - BROWSER: Meta Business Suite qua trình duyệt Patchright.
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:https';
import type { Page } from 'patchright';
import { validatePlatformGate } from '../scheduler.js';
import type { SocialExecutionContext, SocialExecutionResult } from '../worker.js';

const FB_API_VERSION = 'v20.0';
const SELECTORS_PATH = new URL('./selectors.json', import.meta.url);

type FbSelectors = {
  business_home_url: string;
  create_post_btn: string;
  photo_video_option: string;
  reel_option: string;
  file_input: string;
  composer_text_box: string;
  next_btn: string;
  schedule_toggle: string;
  publish_btn: string;
};

async function selectors(mode: 'browser'): Promise<FbSelectors> {
  const raw = JSON.parse(await readFile(SELECTORS_PATH, 'utf8')) as { facebook_browser: FbSelectors };
  return raw.facebook_browser;
}

export async function uploadFacebook(context: SocialExecutionContext): Promise<SocialExecutionResult> {
  if (context.cluster.fbMode === 'browser') {
    return uploadViaBrowser(context);
  }
  return uploadViaGraphApi(context);
}

// ---------------------------------------------------------------------------
// Graph API (chunked resumable)
// ---------------------------------------------------------------------------

async function uploadViaGraphApi(context: SocialExecutionContext): Promise<SocialExecutionResult> {
  const fail = (error: string): SocialExecutionResult => ({ status: 'failed', error });
  // Kiểm tra file trước.
  let fileSize = 0;
  try {
    fileSize = (await stat(context.job.videoPath)).size;
  } catch {
    return fail(`File video không tồn tại: ${context.job.videoPath}`);
  }
  if (fileSize <= 0) return fail('File rỗng, không thể upload');
  if (context.fbToken.trim() === '') {
    return fail('Chưa cấu hình Page Access Token Facebook cho cụm — hãy nhập Page ID + Page Access Token trong "Sửa cụm", hoặc chuyển cụm sang chế độ "Business Suite" (trình duyệt) để đăng bằng phiên Facebook đã đăng nhập.');
  }
  if (context.cluster.fbPageId.trim() === '') return fail('Chưa cấu hình Page ID Facebook cho cụm');

  // Ràng buộc hẹn giờ: chỉ schedule nếu trong khoảng [10 phút, 75 ngày].
  const gate = validatePlatformGate('facebook', context.job.scheduledAt, context.now());
  const scheduleEpoch = gate.ok ? Math.floor(new Date(context.job.scheduledAt).getTime() / 1_000) : null;

  const endpoint = `https://graph-video.facebook.com/${FB_API_VERSION}/${context.cluster.fbPageId}/videos`;
  try {
    // GIAI ĐOẠN 1: start
    const start = await callFacebook(
      endpoint, {
        upload_phase: 'start',
        file_size: String(fileSize),
        access_token: context.fbToken
      }, null);
    if (typeof start.upload_session_id !== 'string') {
      return fail(`Facebook start upload: ${describeFbError(start)}`);
    }
    const sessionId: string = start.upload_session_id;
    let startOffset = Number(String(start.start_offset));
    let endOffset = Number(String(start.end_offset));

    // GIAI ĐOẠN 2: transfer — mỗi vòng LOẠI THẺ stream mở đúng phạm vi offset
    // Facebook yêu cầu (protocol chunked resumable chuẩn).
    let guard = 0;
    while (startOffset < endOffset && guard < 100_000) {
      guard += 1;
      const chunk = await readRange(context.job.videoPath, startOffset, endOffset - 1);
      const transfer = await callFacebook(
        endpoint, {
          upload_phase: 'transfer',
          upload_session_id: sessionId,
          start_offset: String(startOffset),
          access_token: context.fbToken
        }, chunk);
      const next = Number(String(transfer.start_offset));
      const nextEnd = Number(String(transfer.end_offset));
      if (!Number.isFinite(next) || transfer.error !== undefined) {
        return fail(`Facebook transfer: ${describeFbError(transfer)}`);
      }
      startOffset = next;
      endOffset = Number.isFinite(nextEnd) ? nextEnd : endOffset;
    }

    // GIAI ĐOẠN 3: finish + hẹn giờ
    const finishPayload: Record<string, string> = {
      upload_phase: 'finish',
      upload_session_id: sessionId,
      title: context.job.title.slice(0, 250),
      description: context.job.description.slice(0, 5_000),
      access_token: context.fbToken
    };
    if (scheduleEpoch !== null) {
      finishPayload.published = 'false';
      finishPayload.scheduled_publish_time = String(scheduleEpoch);
    } else {
      finishPayload.published = 'true';
    }
    const finish = await callFacebook(endpoint, finishPayload, null);
    if (typeof finish.video_id !== 'string' && finish.error !== undefined) {
      return fail(`Facebook finish: ${describeFbError(finish)}`);
    }
    return {
      status: scheduleEpoch !== null ? 'scheduled' : 'published',
      videoId: typeof finish.video_id === 'string' ? finish.video_id : undefined
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function describeFbError(response: Record<string, unknown>): string {
  const error = response.error;
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return String((error as { message: string }).message);
  }
  if (typeof error === 'string') return error;
  if (Object.keys(response).length === 0) return 'phản hồi rỗng';
  return JSON.stringify(response).slice(0, 300);
}

/** Đọc chính xác byte [offset, endOffset] từ file (ráng buộc của FB protocol). */
async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const stream = createReadStream(path, { start, end });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

type FacebookCallResponse = Record<string, unknown>;

async function callFacebook(
  endpoint: string,
  fields: Record<string, string>,
  chunk: Buffer | null
): Promise<FacebookCallResponse> {
  // Graph API video dùng multipart/form-data (hoặc binary cho transfer).
  const boundary = `----OpenCreator${Date.now()}`;
  const payload: Array<Promise<Buffer>> = [];
  for (const [key, value] of Object.entries(fields)) {
    payload.push(Promise.resolve(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
    )));
  }
  if (chunk !== null) {
    payload.push(Promise.resolve(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="video_file_chunk"; filename="chunk.mp4"\r\nContent-Type: application/octet-stream\r\n\r\n`
    )));
    payload.push(Promise.resolve(chunk));
  }
  payload.push(Promise.resolve(Buffer.from(`\r\n--${boundary}--\r\n`)));
  const body = Buffer.concat(await Promise.all(payload));
  return new Promise<FacebookCallResponse>((resolvePromise, rejectPromise) => {
    const request = httpRequest(new URL(endpoint), {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length)
      },
      timeout: 120_000
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', data => chunks.push(data as Buffer));
      response.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as FacebookCallResponse;
          resolvePromise(parsed ?? {});
        } catch (error) {
          rejectPromise(new Error(`Facebook API trả JSON lỗi: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
      response.on('error', rejectPromise);
    });
    request.on('error', rejectPromise);
    request.on('timeout', () => {
      request.destroy(new Error('Facebook API quá 120 giây không phản hồi'));
    });
    request.end(body);
  });
}

// ---------------------------------------------------------------------------
// Browser (Meta Business Suite)
// ---------------------------------------------------------------------------

/**
 * Đóng các modal của Meta Business Suite đang che UI (ví dụ hộp minh hoạ
 * GeoIllustrationModal lúc mở lần đầu) — nếu không mọi click sau đó đều bị
 * chặn và upload fail.
 */
async function dismissBusinessModals(page: Page): Promise<void> {
  const skipLabels = [/^bỏ qua$/i, /^skip$/i, /^đóng$/i, /^close$/i, /^không$/i, /^not now$/i, /^bỏ qua tất cả$/i, /^skip all$/i, /^got it$/i, /^hiểu rồi$/i, /^bắt đầu$/i, /^start$/i, /^tiếp tục$/i, /^continue$/i];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const open = await page.evaluate(() => {
      const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
      const modals = Array.from(document.querySelectorAll(
        '[data-surface*="Modal"], [data-visualcompletion="ignore"][role="dialog"], [role="dialog"]'
      )).filter(el => visible(el));
      return modals.length;
    }).catch(() => 0);
    if (!open || open === 0) return;
    const buttons = page.locator('[role="dialog"] button, [data-surface*="Modal"] button, [aria-label*="Close" i], [aria-label*="Đóng" i]');
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
      const close = buttons.first();
      if (await close.isVisible().catch(() => false)) {
        await close.click({ timeout: 5_000 }).catch(() => undefined);
      } else {
        await page.keyboard.press('Escape').catch(() => undefined);
      }
    }
    await page.waitForTimeout(1_500).catch(() => undefined);
  }
}

async function uploadViaBrowser(context: SocialExecutionContext): Promise<SocialExecutionResult> {
  const fail = (error: string): SocialExecutionResult => ({ status: 'failed', error });
  if (context.browser === undefined) return fail('Trình duyệt cụm chưa mở');
  let fileSize = 0;
  try {
    fileSize = (await stat(context.job.videoPath)).size;
  } catch {
    return fail(`File video không tồn tại: ${context.job.videoPath}`);
  }
  if (fileSize <= 0) return fail('File rỗng, không thể upload');
  const sel = await selectors('browser');
  const page = await context.browser.newPage() as Page;
  try {
    const pageIdQuery = context.cluster.fbPageId.trim() !== ''
      ? `?asset_id=${encodeURIComponent(context.cluster.fbPageId.trim())}`
      : '';
    await page.goto(new URL(sel.business_home_url + pageIdQuery).toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(4_000);
    await dismissBusinessModals(page);

    const createBtn = page.locator(sel.create_post_btn).first();
    if (!(await createBtn.isVisible().catch(() => false))) {
      return await failedWithScreenshot(page, context, 'Không tìm thấy nút "Tạo bài viết" trên Business Suite (giao diện đổi?)');
    }
    await createBtn.click({ timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    await dismissBusinessModals(page);

    // postType 'reel' (chế độ browser): ưu tiên composer Reel nếu menu có —
    // không thấy thì quay lại luồng bài viết thường (best-effort). 'story'
    // chưa hỗ trợ tự động hóa được.
    if (context.job.platformSettings.facebook?.postType === 'reel') {
      const reelOption = page.locator(sel.reel_option).first();
      if (await reelOption.isVisible().catch(() => false)) {
        await reelOption.click();
        await page.waitForTimeout(1_500);
      }
    }

    const photoVideo = page.locator(sel.photo_video_option).first();
    if (!(await photoVideo.isVisible().catch(() => false))) {
      // Business Suite mới: nút media là "Thêm ảnh/video" (nằm trong composer).
      const altMedia = page.locator("div[role='button']:has-text('Thêm ảnh/video'), div[role='button']:has-text('Add photo/video')").first();
      if (await altMedia.isVisible().catch(() => false)) {
        await altMedia.click({ timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500);
        await dismissBusinessModals(page);
      } else {
        const buttons = await page.evaluate(() => {
          const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;
          return JSON.stringify(Array.from(document.querySelectorAll('[role="button"], button'))
            .filter(el => visible(el))
            .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24))
            .filter(text => text !== '')
            .slice(0, 12));
        }).catch(() => '[]');
        console.log(`[social] Facebook: không thấy nút thêm media — các nút đang có: ${buttons}`);
        return await failedWithScreenshot(page, context, 'Không thấy tùy chọn thêm ảnh/video trong Business Suite (giao diện có thể đã đổi)');
      }
    } else {
      await photoVideo.click({ timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      await dismissBusinessModals(page);
    }

    const fileInput = page.locator(sel.file_input).first();
    await fileInput.waitFor({ state: 'attached', timeout: 30_000 });
    await fileInput.setInputFiles(context.job.videoPath);

    const textBox = page.locator(sel.composer_text_box).first();
    await textBox.waitFor({ state: 'visible', timeout: 45_000 });
    await textBox.click();
    await page.keyboard.type(`${context.job.title}\n${context.job.description}`.slice(0, 4_900), { delay: 20 });

    // Đợi video tải xong (nút Đăng nhá nháy / hiển thị).
    const publishBtn = page.locator(sel.publish_btn).first();
    await publishBtn.waitFor({ state: 'visible', timeout: 600_000 });
    await page.waitForTimeout(2_000);

    const gate = validatePlatformGate('facebook', context.job.scheduledAt, context.now());
    let scheduled = false;
    if (gate.ok) {
      const scheduleToggle = page.locator(sel.schedule_toggle).first();
      if (await scheduleToggle.isVisible().catch(() => false)) {
        await scheduleToggle.click();
        await page.waitForTimeout(1_500);
        await fillScheduleDateTime(page, new Date(context.job.scheduledAt));
        scheduled = true;
      }
    }
    await publishBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await publishBtn.click();
    await page.waitForTimeout(6_000);
    return { status: scheduled ? 'scheduled' : 'published' };
  } catch (error) {
    return await failedWithScreenshot(page, context, error instanceof Error ? error.message : String(error));
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function failedWithScreenshot(page: Page, context: SocialExecutionContext, message: string): Promise<SocialExecutionResult> {
  let screenshotPath: string | undefined;
  try {
    screenshotPath = join(context.screenshotDir, `fb-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
  } catch {
    screenshotPath = undefined;
  }
  return { status: 'failed', error: message, screenshotPath };
}

async function fillScheduleDateTime(page: Page, when: Date): Promise<void> {
  // Best effort: điền input ngày/giờ nếu Business Suite render dạng input.
  const inputs = page.locator('div[role="dialog"] input');
  const count = await inputs.count();
  if (count >= 2) {
    const pad = (value: number): string => String(value).padStart(2, '0');
    await inputs.nth(0).click();
    await inputs.nth(0).fill('');
    await inputs.nth(0).type(`${pad(when.getDate())}/${pad(when.getMonth() + 1)}/${when.getFullYear()}`, { delay: 40 });
    await inputs.nth(1).click();
    await inputs.nth(1).fill('');
    await inputs.nth(1).type(when.toTimeString().slice(0, 5), { delay: 40 });
  }
  await page.keyboard.press('Escape').catch((): Promise<void> => Promise.resolve());
}
