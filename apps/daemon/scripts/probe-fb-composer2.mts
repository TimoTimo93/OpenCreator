/** Dò composer Business Suite sau khi bấm "Tạo bài viết" + đóng modal điều khoản. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://business.facebook.com/latest/home?asset_id=1402925122910633', { timeout: 90_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(14_000);
console.log('URL=' + page.url());
await page.screenshot({ path: shotDir + '/fb-biz-home.png' });

// Bấm "Tạo bài viết"
const create = page.locator("div[role='button']:has-text('Tạo bài viết'), div[role='button']:has-text('Create post')").first();
await create.click({ timeout: 15_000 }).catch(e => console.log('CREATE-ERR ' + String(e).slice(0, 100)));
await page.waitForTimeout(5_000);
await page.screenshot({ path: shotDir + '/fb-biz-composer.png' });
console.log('SHOT=' + shotDir + '/fb-biz-composer.png');

console.log('BUTTONS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const nodes = Array.from(document.querySelectorAll('[role="button"], button')).filter(el => visible(el));
  return JSON.stringify(nodes.map(el => ({
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 26),
    aria: (el.getAttribute('aria-label') || '').slice(0, 26),
    surface: (el.getAttribute('data-surface') || '').slice(0, 30)
  })).filter(x => x.text !== '' || x.aria !== '').slice(0, 30));
})()`));
console.log('FILE_INPUTS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  return JSON.stringify(Array.from(document.querySelectorAll('input[type="file"]')).map(el => ({
    accept: el.getAttribute('accept') || '', visible: visible(el)
  })));
})()`));
await context.close();
