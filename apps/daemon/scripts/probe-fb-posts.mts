/** Kiểm chứng bài đăng Facebook trên Page (có thật không). */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.facebook.com/1402925122910633', { timeout: 90_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12_000);
console.log('URL=' + page.url());
console.log('POSTS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const items = Array.from(document.querySelectorAll('a[href*="/videos/"], a[href*="/reel/"], a[href*="video_id="]')).filter(el => visible(el));
  return JSON.stringify(items.slice(0, 6).map(el => (el.getAttribute('href') || '').slice(0, 80)));
})()`));
console.log('TEXT=' + await page.evaluate(`(() => {
  const main = document.querySelector('div[role="main"]') || document.body;
  return ((main.textContent || '').replace(/\\s+/g, ' ')).slice(0, 350);
})()`));
await page.screenshot({ path: shotDir + '/fb-page-posts.png' });
console.log('SHOT=' + shotDir + '/fb-page-posts.png');
await context.close();
