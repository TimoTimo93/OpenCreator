/**
 * Bước 1: dò form đăng ký Meta/Facebook (tên, ngày sinh, giới tính, email, mật khẩu).
 * Bước 2: kiểm tra Gmail trong profile cụm có đăng nhập không (để đọc mã xác nhận).
 */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.facebook.com/reg', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
console.log('FIELDS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const inputs = Array.from(document.querySelectorAll('input, select, [role="combobox"], [role="radio"]'))
    .filter(el => visible(el))
    .map(el => ({
      tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', name: el.getAttribute('name') || '',
      id: el.id || '', role: el.getAttribute('role') || '', aria: el.getAttribute('aria-label') || '',
      ph: el.getAttribute('placeholder') || '', text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24)
    }));
  return JSON.stringify(inputs);
})()`));
await page.evaluate(`(() => { window.scrollTo(0, document.body.scrollHeight); })()`).catch(() => undefined);
await page.waitForTimeout(2500);
await page.screenshot({ path: shotDir + '/fb-reg-2.png' });
console.log('SHOT=' + shotDir + '/fb-reg-2.png');

// Gmail: đã đăng nhập trong profile cụm chưa?
const mail = await context.newPage();
await mail.goto('https://mail.google.com/mail/u/0/#inbox', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await mail.waitForTimeout(12_000);
console.log('MAIL_URL=' + mail.url());
console.log('MAIL_TITLE=' + await mail.title());
await mail.screenshot({ path: shotDir + '/gmail-inbox.png' });
console.log('SHOT=' + shotDir + '/gmail-inbox.png');
await context.close();
