/** Dò: (1) nút "Tạo Trang" + ô nhập trên pages/create, (2) link & tên thật trên trang chủ FB. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();

// 1) Trang tạo Page
await page.goto('https://www.facebook.com/pages/create/', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9_000);
console.log('PAGE_CREATE_URL=' + page.url());
console.log('BUTTONS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  return JSON.stringify(Array.from(document.querySelectorAll('[role="button"], button')).filter(el => visible(el))
    .map(el => ({
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 26),
      tag: el.tagName.toLowerCase(),
      aria: el.getAttribute('aria-label') || '',
      disabled: el.getAttribute('aria-disabled') || ''
    })).slice(0, 25));
})()`));
console.log('INPUTS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  return JSON.stringify(Array.from(document.querySelectorAll('input, textarea')).filter(el => visible(el))
    .map(el => ({ type: el.getAttribute('type') || '', ph: el.getAttribute('placeholder') || '', name: el.getAttribute('name') || '' })));
})()`));
await page.screenshot({ path: shotDir + '/fb-page-create-probe.png' });

// 2) Trang chủ: link profile + h1
await page.goto('https://www.facebook.com/', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8_000);
console.log('HOME=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const links = Array.from(document.querySelectorAll('a')).filter(el => visible(el))
    .map(el => ({ href: (el.getAttribute('href') || '').slice(0, 60), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24) }))
    .filter(x => x.href.includes('profile') || x.href.startsWith('/@'));
  const h1s = Array.from(document.querySelectorAll('h1')).filter(el => visible(el))
    .map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30));
  return JSON.stringify({ links: links.slice(0, 8), h1s: h1s.slice(0, 8) });
})()`));
await page.screenshot({ path: shotDir + '/fb-home-probe.png' });
console.log('SHOT=' + shotDir + '/fb-home-probe.png');
await context.close();
