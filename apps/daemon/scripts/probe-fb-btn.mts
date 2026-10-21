import { chromium } from 'patchright';
import { rmSync } from 'node:fs';

const tmpDir = 'D:/AppData-Migration/Temp/opencode/fb-tmp-profile2';
rmSync(tmpDir, { recursive: true, force: true });

const context = await chromium.launchPersistentContext(tmpDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.facebook.com/login', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
console.log('CLICKABLE=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const nodes = Array.from(document.querySelectorAll('[role="button"], button, input[type="submit"], div[aria-label]'))
    .filter(el => visible(el))
    .map(el => ({
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', id: el.id || '',
      name: el.getAttribute('name') || '', aria: el.getAttribute('aria-label') || '',
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24)
    }))
    .filter(x => x.text !== '' || x.aria !== '' || x.name !== '')
    .slice(0, 25);
  return JSON.stringify(nodes);
})()`));
await context.close();
