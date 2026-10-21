/** Kiểm tra profile TikTok — bài đăng có thật không (kể cả private). */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.tiktok.com/@lilinlolon552', { timeout: 90_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12_000);
console.log('URL=' + page.url());
console.log('TEXT=' + await page.evaluate(`(() => {
  const main = document.querySelector('div[role="main"]') || document.body;
  return ((main.textContent || '').replace(/\\s+/g, ' ')).slice(0, 500);
})()`));
console.log('VIDEOS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const items = Array.from(document.querySelectorAll('div[data-e2e="user-post-item"], a[href*="/video/"]')).filter(el => visible(el));
  return JSON.stringify(items.slice(0, 8).map(el => ({
    e2e: el.getAttribute('data-e2e') || '', href: (el.getAttribute('href') || '').slice(0, 50),
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
  })));
})()`));
await page.screenshot({ path: shotDir + '/tk-profile.png' });
console.log('SHOT=' + shotDir + '/tk-profile.png');
await context.close();
