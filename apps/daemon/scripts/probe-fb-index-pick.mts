/** Debug: nút Submit + chọn dropdown theo index (bỏ qua locale). */
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

console.log('BUTTONS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const nodes = Array.from(document.querySelectorAll('[role="button"], button')).filter(el => visible(el));
  return JSON.stringify(nodes.map(el => ({
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
    aria: el.getAttribute('aria-label') || '',
    disabled: el.getAttribute('aria-disabled') || ''
  })).slice(0, 20));
})()`));

// Chọn dropdown theo index: Day 0, Month 0, Year (1995), Gender 0
const pick = async (comboIndex, optionIndex, label) => {
  const combos = page.locator('[role="combobox"]');
  await combos.nth(comboIndex).click({ timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  const res = await page.evaluate(`(() => {
    const visible = (el) => el.offsetParent !== null;
    const lists = Array.from(document.querySelectorAll('[role="listbox"]')).filter(l => visible(l));
    const list = lists[0];
    if (!list) return 'NO-LISTBOX';
    const items = Array.from(list.querySelectorAll('[role="option"], [role="radio"]'));
    const target = items[${optionIndex}];
    if (!target) return 'NO-OPTION count=' + items.length;
    target.click();
    return 'CLICKED ' + (target.textContent || '').trim().slice(0, 14);
  })()`);
  console.log(label + '=' + res);
  await page.waitForTimeout(900);
};

await pick(0, 0, 'DAY');
await pick(1, 0, 'MONTH');
await pick(2, 31, 'YEAR');
await pick(3, 0, 'GENDER');

console.log('COMBOS=' + await page.evaluate(`(() => {
  const combos = Array.from(document.querySelectorAll('[role="combobox"]'));
  return JSON.stringify(combos.map(c => (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24)));
})()`));
await page.screenshot({ path: shotDir + '/fb-combo-index.png' });
console.log('SHOT=' + shotDir + '/fb-combo-index.png');
await context.close();
