/**
 * Dò trang đăng ký Facebook: nút "Tạo tài khoản mới" → "Tiếp tục với Google".
 * Chụp ảnh từng bước để phân tích chỗ bị chặn.
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
console.log('URL=' + page.url());
console.log('BUTTONS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const nodes = Array.from(document.querySelectorAll('[role="button"], button, a[href*="reg"], a[href*="signup"]'))
    .filter(el => visible(el))
    .map(el => ({
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', id: el.id || '',
      href: el.getAttribute('href') || '', aria: el.getAttribute('aria-label') || '',
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
    }))
    .filter(x => x.text !== '' || x.aria !== '')
    .slice(0, 30);
  return JSON.stringify(nodes);
})()`));
await page.screenshot({ path: shotDir + '/fb-reg-1.png' });
console.log('SHOT=' + shotDir + '/fb-reg-1.png');
await context.close();
