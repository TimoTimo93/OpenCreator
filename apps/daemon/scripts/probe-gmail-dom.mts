import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://mail.google.com/mail/u/0/#inbox', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(11_000);
console.log('TITLE=' + await page.title());
console.log('SEARCH=' + await page.evaluate(`(() => {
  const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
    name: el.getAttribute('name') || '', aria: el.getAttribute('aria-label') || '',
    ph: el.getAttribute('placeholder') || '', type: el.getAttribute('type') || ''
  }));
  const rows = Array.from(document.querySelectorAll('[role="listitem"], tr')).slice(0, 5).map(el => ({
    tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
  }));
  return JSON.stringify({ inputs, rows });
})()`));
await page.screenshot({ path: shotDir + '/gmail-dom.png' });
console.log('SHOT=' + shotDir + '/gmail-dom.png');
await context.close();
