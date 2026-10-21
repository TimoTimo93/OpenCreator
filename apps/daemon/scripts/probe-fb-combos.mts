/**
 * Dò cấu trúc các dropdown của form đăng ký Meta (Day / Month / Year / Gender)
 * để biết cách chọn (role=combobox + listbox như TikTok hay không).
 */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.facebook.com/reg', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);

const dump = async (label: string) => {
  const info = await page.evaluate(`(() => {
    const visible = (el) => el.offsetParent !== null;
    const combos = Array.from(document.querySelectorAll('[role="combobox"]'));
    const lists = Array.from(document.querySelectorAll('[role="listbox"], [role="list"]'));
    const shown = lists.filter(l => visible(l)).map(l => ({
      role: l.getAttribute('role'),
      aria: l.getAttribute('aria-label') || '',
      text: (l.textContent || '').replace(/\\s+/g, ' ').slice(0, 90),
      opts: Array.from(l.querySelectorAll('[role="option"], [role="radio"], li')).slice(0, 5).map(o => ({
        role: o.getAttribute('role') || o.tagName.toLowerCase(),
        text: (o.textContent || '').trim().slice(0, 18)
      }))
    }));
    return JSON.stringify({ combos: combos.map(c => ({ aria: c.getAttribute('aria-label') || '', id: c.id, text: (c.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 24) })), shown });
  })()`);
  console.log(label + '=' + info);
};

await dump('BEFORE');

const day = page.locator('[role="combobox"][aria-label="Select day"]');
console.log('DAY_COUNT=' + await day.count());
await day.nth(0).click({ timeout: 8000 }).catch(e => console.log('ERR ' + String(e).slice(0, 100)));
await page.waitForTimeout(1500);
await dump('AFTER_DAY_CLICK');
await page.screenshot({ path: shotDir + '/fb-reg-day.png' });
console.log('SHOT=' + shotDir + '/fb-reg-day.png');
await context.close();
