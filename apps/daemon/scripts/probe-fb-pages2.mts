import { chromium } from 'patchright';
const profileDir = 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const context = await chromium.launchPersistentContext(profileDir, { headless: false, colorScheme: 'dark', args: ['--force-dark-mode'] });
const page = await context.newPage();
await page.goto('https://www.facebook.com/profile.php?id=61595686858745&sk=pages', { timeout: 60000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
console.log('URL=' + page.url());
console.log('FOUND=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const links = Array.from(document.querySelectorAll('a')).filter(el => visible(el))
    .map(el => ({ href: (el.getAttribute('href') || '').slice(0, 80), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) }))
    .filter(x => x.text !== '' && /pham|nhan|tien|page/i.test(x.text + x.href));
  return JSON.stringify(links.slice(0, 12));
})()`));
await page.screenshot({ path: 'D:/AppData-Migration/Temp/opencode/fb-profile-pages2.png' });
await context.close();
