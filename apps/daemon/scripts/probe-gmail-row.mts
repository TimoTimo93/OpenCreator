import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://mail.google.com/mail/u/0/#inbox', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(11_000);
const search = page.locator('input[name="q"][aria-label="Search mail"]');
await search.nth(0).fill('TikTok').catch(() => undefined);
await search.nth(0).press('Enter').catch(() => undefined);
await page.waitForTimeout(6000);
console.log('ANCESTORS=' + await page.evaluate(`(() => {
  const needle = 'You shared some Google Account data';
  let node = null;
  for (const el of Array.from(document.querySelectorAll('span, div'))) {
    if ((el.textContent || '').includes(needle) && el.children.length < 12) { node = el; break; }
  }
  if (!node) return 'NOT-FOUND';
  const chain = [];
  let cur = node;
  for (let i = 0; i < 7 && cur; i += 1) {
    chain.push({
      tag: cur.tagName.toLowerCase(),
      role: cur.getAttribute('role') || '',
      cls: (cur.getAttribute('class') || '').slice(0, 60),
      id: cur.id || '',
      aria: cur.getAttribute('aria-label') || ''
    });
    cur = cur.parentElement;
  }
  return JSON.stringify(chain);
})()`));
await context.close();
