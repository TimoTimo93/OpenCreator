/**
 * Tạo kênh YouTube (Brand Account) cho tài khoản đã đăng nhập nhưng chưa có
 * kênh — dùng cho module Quản Lý Đa Kênh.
 *
 * Thực tế (đã kiểm chứng bằng ảnh chụp trình duyệt cụm): khi tài khoản chưa
 * có kênh, truy cập `youtube.com` sẽ tự mở modal **"How you'll appear"** với
 * ô *Name*, ô *Handle* và nút *Create Channel* (không phải trang studio/channel
 * create riêng). Ta điền tên → bấm Create → đọc lại handle/channel id.
 *
 * Selector bám theo DOM thật: các ô nhập nằm trong custom element nên không
 * có name/id ⇒ định vị theo thứ tự input hiển thị (bỏ ô tìm kiếm & file).
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
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  locator(selector: string): {
    nth(index: number): {
      fill(value: string): Promise<void>;
      count(): Promise<number>;
    };
    count(): Promise<number>;
    first(): { click(): Promise<void> };
  };
  getByRole(role: string, options: { name: string | RegExp; exact?: boolean }): {
    first(): { click(): Promise<void>; count(): Promise<number> };
  };
  evaluate<T>(fn: (arg?: unknown) => T, arg?: unknown): Promise<T>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
};

const CREATE_MODAL_TEXT = "How you'll appear";

async function waitForText(page: ChannelPage, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page
      .evaluate((needle: unknown) => {
        const value = typeof needle === 'string' ? needle : '';
        return document.body?.innerText?.includes(value) ?? false;
      }, text)
      .catch(() => false);
    if (found) return true;
    await page.waitForTimeout(1_000);
  }
  return false;
}

/**
 * Mở trang chủ YouTube (modal tạo kênh tự hiện nếu chưa có kênh), điền tên →
 * bấm "Create Channel" → đọc lại handle/channel id đã tạo.
 */
export async function createYoutubeChannel(
  handle: { newPage(url?: string): Promise<unknown> },
  options: { name: string; handle?: string }
): Promise<YoutubeChannelCreateResult> {
  const name = options.name.trim();
  if (name === '') return { ok: false, error: 'Cần nhập tên kênh' };
  let page: ChannelPage | undefined;
  try {
    // Mở "Create channel" của YouTube Studio — URL này chuyển về youtube.com và
    // tự mở modal "How you'll appear" (đã kiểm chứng bằng ảnh trình duyệt cụm).
    page = await handle.newPage('https://studio.youtube.com/channel/create') as ChannelPage;
    await page.waitForTimeout(6_000);
    const url = page.url();
    if (url.includes('accounts.google.com')) {
      return { ok: false, error: 'Phiên đăng nhập chưa hoàn tất — hãy đăng nhập lại trong cửa sổ trình duyệt của cụm' };
    }
    const hasModal = await waitForText(page, CREATE_MODAL_TEXT, 12_000);
    if (!hasModal) {
      // Không có modal tạo kênh ⇒ tài khoản đã có kênh: đọc handle/id hiện tại.
      await page.goto('https://www.youtube.com/@me').catch(() => undefined);
      await page.waitForTimeout(3_000);
      const current = page.url();
      const channelMatch = /\/channel\/(UC[\w-]+)/.exec(current);
      const handleMatch = /youtube\.com\/@([\w.\-]+)/.exec(current);
      if (channelMatch?.[1] !== undefined) {
        const title = await page.title().catch(() => '');
        return {
          ok: true,
          channelId: channelMatch[1],
          channelName: title.replace(/\s*[-–—]\s*YouTube\s*$/i, '').trim()
        };
      }
      return {
        ok: false,
        error: handleMatch?.[1] === undefined
          ? 'Không mở được form tạo kênh (tài khoản có thể chưa hoàn tất đăng nhập)'
          : 'Tài khoản đã có kênh — hãy bấm "Lưu Phiên" để cập nhật thông tin kênh'
      };
    }

    // Ô nhập: bỏ qua ô tìm kiếm (name=search_query), ô file và ô checkbox;
    // còn lại đúng 2 ô theo thứ tự DOM: Name rồi Handle.
    const textInputs = page.locator('input:not([type="file"]):not([type="checkbox"]):not([name="search_query"])');
    const count = await textInputs.count();
    if (count === 0) {
      return { ok: false, error: 'Không tìm thấy ô nhập tên kênh trong modal "How you\'ll appear"' };
    }
    await textInputs.nth(0).fill(name);
    const wantedHandle = (options.handle ?? '').trim().replace(/^@/, '');
    if (count > 1 && wantedHandle !== '') {
      await textInputs.nth(1).fill(wantedHandle);
    }

    const createButton = page.getByRole('button', { name: 'Create Channel' });
    if (await createButton.first().count() === 0) {
      return { ok: false, error: 'Không tìm thấy nút "Create Channel" trong modal tạo kênh' };
    }
    await createButton.first().click();
    await page.waitForTimeout(9_000);
    // Đọc lại kênh vừa tạo: ưu tiên link kênh trong menu avatar, sau đó tới URL.
    await page
      .click('ytd-topbar-menu-button #avatar-btn, #avatar-btn, ytd-topbar-menu-button', { timeout: 5_000 })
      .catch(() => undefined);
    await page.waitForTimeout(2_500);
    const ownHandle = await page
      .evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href^="/@"]'));
        for (const link of links) {
          const href = link.getAttribute('href') ?? '';
          if (href.length > 2) return href;
        }
        return '';
      })
      .catch(() => '');
    const after = page.url();
    const title = await page.title().catch(() => '');
    const channelMatch = /\/channel\/(UC[\w-]+)/.exec(after);
    const handleFromUrl = /youtube\.com\/@([\w.\-]+)/.exec(after);
    const handleValue = ownHandle !== ''
      ? ownHandle.replace(/^\//, '')
      : handleFromUrl?.[1] !== undefined ? `@${handleFromUrl[1]}` : '';
    if (channelMatch?.[1] === undefined && handleValue === '') {
      return { ok: false, error: `Đã bấm Create nhưng chưa xác nhận được kênh (URL: ${after}). Kiểm tra cửa sổ trình duyệt của cụm.` };
    }
    const channelName = title.replace(/\s*[-–—]\s*YouTube\s*$/i, '').trim();
    // Tên kênh thật lấy từ trang kênh (tiêu đề Studio chỉ là "Channel dashboard").
    let realName = channelName !== '' && channelName !== 'YouTube' ? channelName : name;
    if (channelMatch?.[1] !== undefined) {
      await page.goto(`https://www.youtube.com/channel/${channelMatch[1]}`).catch(() => undefined);
      await page.waitForTimeout(3_500);
      const channelTitle = await page.title().catch(() => '');
      const cleaned = channelTitle.replace(/\s*[-–—]\s*YouTube\s*$/i, '').trim();
      if (cleaned !== '' && cleaned !== 'YouTube') realName = cleaned;
    }
    return {
      ok: true,
      ...(channelMatch?.[1] === undefined ? {} : { channelId: channelMatch[1] }),
      channelName: realName
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await page?.close().catch(() => undefined);
  }
}
