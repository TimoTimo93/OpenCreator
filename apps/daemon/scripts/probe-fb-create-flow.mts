/** Điền tên → chọn hạng mục → bấm "Tạo Trang" → xem hộp thoại sau đó. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.facebook.com/pages/create/', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9_000);

const nameInput = page.locator('input[type="text"]');
await nameInput.nth(0).fill('Pham Nhan Tu Tien').catch(() => undefined);
await page.waitForTimeout(1500);
const cat = page.locator('input[aria-label*="ạng mục" i], input[aria-label*="category" i]');
await cat.nth(0).fill('Phim').catch(() => undefined);
await page.waitForTimeout(3000);
const options = page.locator('li[role="option"]');
console.log('OPTIONS=' + await options.count());
await options.nth(0).click({ timeout: 8000 }).catch(e => console.log('OPT-ERR ' + String(e).slice(0, 100)));
await page.waitForTimeout(2000);
console.log('BEFORE_CLICK=' + await page.evaluate(`(() => {
  const btn = document.querySelector('[aria-label="Tạo Trang"]');
  return btn ? ('disabled=' + (btn.getAttribute('aria-disabled') || 'false')) : 'NOT-FOUND';
})()`));

const createBtn = page.locator('[role="button"][aria-label="Tạo Trang"]');
console.log('CREATE_BTN=' + await createBtn.count());
await createBtn.nth(0).click({ timeout: 10_000 }).catch(e => console.log('CREATE-ERR ' + String(e).slice(0, 150)));
await page.waitForTimeout(6000);
console.log('URL_AFTER=' + page.url());
console.log('AFTER=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(el => visible(el))
    .map(el => (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 200));
  const buttons = Array.from(document.querySelectorAll('[role="button"], button')).filter(el => visible(el))
    .map(el => (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 26));
  return JSON.stringify({ dialogs, buttons: buttons.slice(0, 18) });
})()`));
await page.screenshot({ path: shotDir + '/fb-after-create.png' });
console.log('SHOT=' + shotDir + '/fb-after-create.png');
await context.close();
