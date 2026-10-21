/** Dò ô nhập mã xác nhận của Facebook (trang confirmemail.php). */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.facebook.com/confirmemail.php', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9_000);
console.log('URL=' + page.url());
console.log('INPUTS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
    type: el.getAttribute('type') || '', name: el.getAttribute('name') || '', id: el.id || '',
    ph: el.getAttribute('placeholder') || '', aria: el.getAttribute('aria-label') || '',
    inputmode: el.getAttribute('inputmode') || '', maxlength: el.getAttribute('maxlength') || '',
    visible: visible(el)
  }));
  return JSON.stringify(inputs);
})()`));
console.log('BUTTONS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  return JSON.stringify(Array.from(document.querySelectorAll('[role="button"], button')).filter(el => visible(el))
    .map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24)));
})()`));
await page.screenshot({ path: shotDir + '/fb-confirm-input.png' });
console.log('SHOT=' + shotDir + '/fb-confirm-input.png');
await context.close();
