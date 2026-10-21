import { chromium } from 'patchright';

const profileDir = process.argv[2];
const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.tiktok.com/', { timeout: 60000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
console.log('URL=' + page.url());
console.log('TITLE=' + await page.title());
console.log('PROFILE_LINK=' + await page.evaluate(`(() => {
  const sels = ['a[data-e2e="profile-icon"]', 'a[href*="/@"]', 'a[href*="profile.php"]', 'a[data-e2e="profile-avatar"]'];
  const out = [];
  for (const sel of sels) {
    const els = Array.from(document.querySelectorAll(sel));
    for (const el of els.slice(0, 2)) {
      out.push({ sel, href: el.getAttribute('href') || '', text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30) });
    }
  }
  return JSON.stringify(out);
})()`));
console.log('NAMES=' + await page.evaluate(`(() => {
  const sels = ['h1', '[data-e2e="user-title"]', 'strong[data-e2e="user-title"]', '[data-e2e="unique-username"]', '[data-e2e="profile-username"]'];
  const out = [];
  for (const sel of sels) {
    const els = Array.from(document.querySelectorAll(sel));
    for (const el of els.slice(0, 2)) out.push({ sel, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) });
  }
  return JSON.stringify(out);
})()`));
await page.screenshot({ path: 'D:/AppData-Migration/Temp/opencode/tiktok-home-loggedin.png' });
await context.close();
