/**
 * Tạo kênh YouTube (Brand Account) cho tài khoản đã đăng nhập nhưng chưa có
 * kênh — dùng cho module Quản Lý Đa Kênh.
 *
 * Luồng thật: studio.youtube.com → (chưa có kênh) → màn hình "Tạo kênh của
 * bạn" → nhập tên kênh → bấm "Tạo" → vào được Studio ⇒ lấy được
 * channel id (UC…) + tên kênh để lưu vào cụm.
 *
 * Selector bám theo DOM thực tế, có nhiều phương án dự phòng vì Google
 * đổi bố cục thỉnh thoảng. Nếu không tự tạo được ⇒ trả lỗi rõ ràng để
 * người dùng tạo tay (không báo sai trạng thái).
 */

export type YoutubeChannelCreateResult = {
  ok: boolean;
  channelId?: string;
  channelName?: string;
  error?: string;
};

type ChannelPage = {
  url(): string;
  title(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  close(): Promise<void>;
};

const NAME_INPUT_SELECTORS = [
  'input[name="channelName"]',
  'input[id="channelName"]',
  'input[placeholder*="Channel name" i]',
  'input[placeholder*="Tên kênh" i]',
  'input[aria-label*="channel name" i]',
  'input[aria-label*="tên kênh" i]',
  'ytcp-text-field input'
];

const CREATE_BUTTON_SELECTORS = [
  'button:has-text("Create")',
  'button:has-text("Tạo")',
  'ytcp-button#create-button button',
  'button[aria-label*="Create" i]',
  'button[aria-label*="Tạo" i]'
];

async function firstExisting(page: ChannelPage, selectors: string[]): Promise<string | undefined> {
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 2_000 });
      return selector;
    } catch {
      // thử selector tiếp theo
    }
  }
  return undefined;
}

/**
 * Mở trang tạo kênh và điền tên → bấm Tạo.
 * `handle` là tuỳ chọn (bỏ trống ⇒ YouTube tự sinh handle).
 */
export async function createYoutubeChannel(
  handle: { newPage(url?: string): Promise<unknown> },
  options: { name: string; handle?: string }
): Promise<YoutubeChannelCreateResult> {
  const name = options.name.trim();
  if (name === '') return { ok: false, error: 'Cần nhập tên kênh' };
  let page: ChannelPage | undefined;
  try {
    page = await handle.newPage('https://studio.youtube.com/channel/create') as ChannelPage;
    await page.waitForTimeout(4_000);
    const url = page.url();
    if (url.includes('accounts.google.com')) {
      return { ok: false, error: 'Phiên đăng nhập chưa hoàn tất — hãy đăng nhập lại trong cửa sổ trình duyệt của cụm' };
    }
    // Nếu đã có kênh ⇒ studio mở thẳng, không có form tạo.
    const nameInput = await firstExisting(page, NAME_INPUT_SELECTORS);
    if (nameInput === undefined) {
      const current = page.url();
      const channelMatch = /\/channel\/(UC[\w-]+)/.exec(current);
      if (channelMatch?.[1] !== undefined) {
        const title = await page.title();
        return {
          ok: true,
          channelId: channelMatch[1],
          channelName: title.replace(/\s*[-–—]\s*YouTube\s*Studio\s*$/i, '').trim()
        };
      }
      return { ok: false, error: 'Không tìm thấy form tạo kênh trong YouTube Studio — hãy tạo kênh thủ công 1 lần rồi thử lại' };
    }
    await page.fill(nameInput, name);
    const handleInput = 'input[name="vanityChannelUrl"], input[placeholder*="URL" i]';
    try {
      await page.waitForSelector(handleInput, { timeout: 1_500 });
      if (options.handle !== undefined && options.handle.trim() !== '') {
        await page.fill(handleInput, options.handle.trim().replace(/^@/, ''));
      }
    } catch {
      // không có ô handle (chế độ mặc định) — bỏ qua
    }
    const createButton = await firstExisting(page, CREATE_BUTTON_SELECTORS);
    if (createButton === undefined) {
      return { ok: false, error: 'Không tìm thấy nút "Tạo" trong form tạo kênh' };
    }
    await page.click(createButton);
    await page.waitForTimeout(8_000);
    const after = page.url();
    const title = await page.title();
    const channelMatch = /\/channel\/(UC[\w-]+)/.exec(after);
    if (channelMatch?.[1] === undefined) {
      return { ok: false, error: `Tạo kênh chưa hoàn tất (URL: ${after}). Hãy kiểm tra cửa sổ trình duyệt của cụm.` };
    }
    return {
      ok: true,
      channelId: channelMatch[1],
      channelName: title.replace(/\s*[-–—]\s*YouTube\s*Studio\s*$/i, '').trim()
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await page?.close().catch(() => undefined);
  }
}
