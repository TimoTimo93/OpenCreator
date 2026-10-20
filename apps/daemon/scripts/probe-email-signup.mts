/**
 * Kiểm chứng nhánh "đăng ký bằng Gmail" của TikTok: mở trang
 * /signup/phone-or-email (mặc định là SĐT) → bấm "Sign up with email" →
 * điền email + mật khẩu → bấm "Send code" → chụp ảnh.
 */
import { chromium } from 'patchright';
import { cpSync, rmSync, existsSync } from 'node:fs';
import { startTiktokEmailSignup } from '../src/social/platforms/account-signup.js';

const src = 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const dst = 'D:/AppData-Migration/Temp/opencode/profile-copy2';
if (!existsSync(src)) {
  console.log('NO_SOURCE_PROFILE');
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });

const context = await chromium.launchPersistentContext(dst, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
try {
  await context.clearCookies({ domain: /(^|\.)tiktok\.com$/ });
} catch (e) {
  console.log('CLEAR_ERR ' + String(e).slice(0, 100));
}

const page = await context.newPage();
await page.goto('https://www.tiktok.com/signup/phone-or-email', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
console.log('URL_BEFORE=' + page.url());
await page.screenshot({ path: 'D:/AppData-Migration/Temp/opencode/tiktok-step1-phone.png' });

const started = await startTiktokEmailSignup(page as never, 'lolinlilin38@gmail.com');
console.log('STARTED=' + JSON.stringify(started));
console.log('URL_AFTER=' + page.url());

const values = await page.evaluate(`(() => {
  const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
    ph: el.getAttribute('placeholder') || '',
    type: el.getAttribute('type') || '',
    value: el.value || ''
  }));
  const body = (document.body && document.body.innerText) || '';
  return JSON.stringify({ inputs, hasCodeHint: body.includes('6-digit') || body.includes('6 chữ số') });
})()`);
console.log('STATE=' + values);
await page.screenshot({ path: 'D:/AppData-Migration/Temp/opencode/tiktok-step2-email.png' });
console.log('SHOT=D:/AppData-Migration/Temp/opencode/tiktok-step2-email.png');
await context.close();
