import { chromium } from 'patchright';
import { rmSync } from 'node:fs';

const tmpDir = 'D:/AppData-Migration/Temp/opencode/fb-tmp-profile';
rmSync(tmpDir, { recursive: true, force: true });

const context = await chromium.launchPersistentContext(tmpDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.facebook.com/login', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
console.log('URL=' + page.url());
console.log('FIELDS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const inputs = Array.from(document.querySelectorAll('input')).filter(el => visible(el)).map(el => ({
    id: el.id || '', name: el.getAttribute('name') || '', type: el.getAttribute('type') || '',
    ph: el.getAttribute('placeholder') || '', aria: el.getAttribute('aria-label') || ''
  }));
  const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]')).filter(el => visible(el)).map(el => ({
    tag: el.tagName.toLowerCase(), id: el.id || '', name: el.getAttribute('name') || '',
    value: el.getAttribute('value') || '', text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30)
  }));
  return JSON.stringify({ inputs, buttons });
})()`));
await page.screenshot({ path: 'D:/AppData-Migration/Temp/opencode/fb-login.png' });
console.log('SHOT=D:/AppData-Migration/Temp/opencode/fb-login.png');
await context.close();
