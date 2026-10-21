/** Kiểm tra các Page đã tạo trong tài khoản Facebook. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.facebook.com/pages/', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9_000);
console.log('URL=' + page.url());
console.log('PAGES=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const names = Array.from(document.querySelectorAll('a[href*="/pages/"], a[href*="page_id"]')).filter(el => visible(el))
    .map(el => ({ href: (el.getAttribute('href') || '').slice(0, 60), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) }))
    .filter(x => x.text !== '');
  return JSON.stringify(names.slice(0, 12));
})()`));
await page.screenshot({ path: shotDir + '/fb-pages-list.png' });
console.log('SHOT=' + shotDir + '/fb-pages-list.png');
await context.close();
