/** Debug: chọn 1 option trong dropdown Meta (Day) và đọc lại giá trị. */
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

const day = page.locator('[role="combobox"][aria-label="Select day"]');
await day.nth(0).click({ timeout: 8000 }).catch(e => console.log('CLICK-ERR ' + String(e).slice(0, 120)));
await page.waitForTimeout(1500);

console.log('STATE=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const lists = Array.from(document.querySelectorAll('[role="listbox"]'));
  const visLists = lists.filter(l => visible(l));
  const detail = lists.map(l => ({
    visible: visible(l),
    aria: l.getAttribute('aria-label') || '',
    role: l.getAttribute('role'),
    opts: Array.from(l.querySelectorAll('[role="option"], [role="radio"]')).slice(0, 3).map(o => ({
      role: o.getAttribute('role') || '', text: (o.textContent || '').trim().slice(0, 10),
      visible: visible(o)
    }))
  }));
  return JSON.stringify({ total: lists.length, visibleCount: visLists.length, detail });
})()`));

// Thử click option trong listbox visible (giống hàm pickMetaOption)
const clicked = await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const lists = Array.from(document.querySelectorAll('[role="listbox"]')).filter(l => visible(l));
  const list = lists[0];
  if (!list) return 'NO-LISTBOX';
  const items = Array.from(list.querySelectorAll('[role="option"], [role="radio"]'));
  const target = items.find(i => (i.textContent || '').trim() === '1');
  if (!target) return 'NO-OPTION-1 count=' + items.length;
  target.click();
  return 'CLICKED';
})()`);
console.log('CLICK_RESULT=' + clicked);
await page.waitForTimeout(1500);
console.log('COMBO_TEXT=' + await page.evaluate(`(() => {
  const combos = Array.from(document.querySelectorAll('[role="combobox"]'));
  return combos.map(c => (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 20));
})()`));
await page.screenshot({ path: shotDir + '/fb-combo-debug.png' });
console.log('SHOT=' + shotDir + '/fb-combo-debug.png');
await context.close();
