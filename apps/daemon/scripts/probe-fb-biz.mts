/** Dò menu "Tạo bài viết" của Meta Business Suite. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://business.facebook.com/latest/home', { timeout: 90_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12_000);
console.log('URL=' + page.url());

const create = page.locator("div[role='button']:has-text('Tạo bài viết'), div[role='button']:has-text('Create post'), div[aria-label*='Tạo']").first();
console.log('CREATE_BTN=' + await create.count());
await create.click({ timeout: 15_000 }).catch(e => console.log('CLICK-ERR ' + String(e).slice(0, 120)));
await page.waitForTimeout(4_000);
console.log('MENU=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="button"], [role="tab"], [role="radio"]')).filter(el => visible(el))
    .map(el => ({ role: el.getAttribute('role') || '', text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 34), aria: el.getAttribute('aria-label') || '' }))
    .filter(x => x.text !== '' && x.text.length < 60);
  return JSON.stringify(items.slice(0, 24));
})()`));
console.log('FILE_INPUTS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  return JSON.stringify(Array.from(document.querySelectorAll('input[type="file"]')).map(el => ({
    accept: el.getAttribute('accept') || '', visible: visible(el), cls: (el.getAttribute('class') || '').slice(0, 30)
  })));
})()`));
await page.screenshot({ path: shotDir + '/fb-biz-menu.png' });
console.log('SHOT=' + shotDir + '/fb-biz-menu.png');
await context.close();
