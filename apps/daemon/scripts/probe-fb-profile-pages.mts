/** Tìm Page đã tạo trong trang cá nhân Facebook + lấy Page ID. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.facebook.com/profile.php?id=61595686858745', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9_000);
console.log('URL=' + page.url());
console.log('PROFILE=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const h1 = Array.from(document.querySelectorAll('h1')).filter(el => visible(el)).map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40));
  const tabs = Array.from(document.querySelectorAll('[role="tab"], a')).filter(el => visible(el))
    .map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24)).filter(t => t !== '');
  return JSON.stringify({ h1, tabs: tabs.slice(0, 14) });
})()`));
await page.screenshot({ path: shotDir + '/fb-profile.png' });

// Mở tab "Trang" (Pages) nếu có
const pagesTab = page.locator('[role="tab"]', { hasText: 'Trang' });
console.log('PAGES_TAB=' + await pagesTab.count());
if (await pagesTab.count() > 0) {
  await pagesTab.first().click({ timeout: 8000 }).catch(e => console.log('TAB-ERR ' + String(e).slice(0, 100)));
  await page.waitForTimeout(6000);
  console.log('PAGES_FOUND=' + await page.evaluate(`(() => {
    const visible = (el) => el.offsetParent !== null;
    const links = Array.from(document.querySelectorAll('a[href*="page_id"], a[href*="/pages/"], a[href*="id="]')).filter(el => visible(el))
      .map(el => ({ href: (el.getAttribute('href') || '').slice(0, 70), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) }))
      .filter(x => x.text !== '');
    return JSON.stringify(links.slice(0, 12));
  })()`));
  await page.screenshot({ path: shotDir + '/fb-profile-pages.png' });
  console.log('SHOT=' + shotDir + '/fb-profile-pages.png');
}
await context.close();
