/**
 * Kiểm chứng luồng đăng ký TikTok MỚI (chọn "Sign up with email" thay vì SĐT)
 * trên BẢN SAO profile cụm — không đụng tới profile thật (đã có tài khoản).
 */
import { chromium } from 'patchright';
import { cpSync, rmSync, existsSync } from 'node:fs';
import { signUpTiktokViaGoogle } from '../src/social/platforms/account-signup.js';

const src = 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const dst = 'D:/AppData-Migration/Temp/opencode/profile-copy';
if (!existsSync(src)) {
  console.log('NO_SOURCE_PROFILE');
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
console.log('COPIED');

const context = await chromium.launchPersistentContext(dst, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});

// Xóa cookie TikTok (giữ cookie Google) → mô phỏng "đăng ký lần đầu".
try {
  await context.clearCookies({ domain: /(^|\.)tiktok\.com$/ });
  console.log('TIKTOK_COOKIES_CLEARED');
} catch (e) {
  console.log('CLEAR_ERR ' + String(e).slice(0, 120));
}

const handle = {
  async newPage(url?: string) {
    const page = await context.newPage();
    if (url !== undefined && url !== '') {
      await page.goto(url, { timeout: 60_000, waitUntil: 'domcontentloaded' });
    }
    return page;
  },
  async pages() {
    return context.pages();
  },
  async cookies(urls: string[]) {
    const list = await context.cookies(urls);
    return list.map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain }));
  }
};

const result = await signUpTiktokViaGoogle(handle as never);
console.log('RESULT=' + JSON.stringify(result));

const pages = context.pages();
for (const page of pages) {
  console.log('PAGE=' + page.url());
}
await context.close();
