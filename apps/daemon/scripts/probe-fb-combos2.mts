import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.facebook.com/reg', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);

const openAndDump = async (aria: string, label: string) => {
  const combo = page.locator(`[role="combobox"][aria-label="${aria}"]`);
  if (await combo.count() === 0) { console.log(label + '=NOT-FOUND'); return; }
  await combo.nth(0).click({ timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  const info = await page.evaluate(`(() => {
    const visible = (el) => el.offsetParent !== null;
    const lists = Array.from(document.querySelectorAll('[role="listbox"]')).filter(l => visible(l));
    if (lists.length === 0) return 'NO-LISTBOX';
    const l = lists[0];
    const opts = Array.from(l.querySelectorAll('[role="option"], [role="radio"]'));
    return JSON.stringify({
      count: opts.length,
      first: opts.slice(0, 4).map(o => (o.textContent || '').trim().slice(0, 16)),
      last: opts.slice(-3).map(o => (o.textContent || '').trim().slice(0, 16)),
      has1995: opts.some(o => (o.textContent || '').trim() === '1995')
    });
  })()`);
  console.log(label + '=' + info);
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(600);
};

await openAndDump('Select month', 'MONTH');
await openAndDump('Select year', 'YEAR');

// Gender: combobox không có aria-label → tìm theo text
const gender = page.locator('[role="combobox"]').filter({ hasText: 'Select your gender' });
console.log('GENDER_COUNT=' + await gender.count());
if (await gender.count() > 0) {
  await gender.nth(0).click({ timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  console.log('GENDER=' + await page.evaluate(`(() => {
    const visible = (el) => el.offsetParent !== null;
    const lists = Array.from(document.querySelectorAll('[role="listbox"]')).filter(l => visible(l));
    if (lists.length === 0) return 'NO-LISTBOX';
    const opts = Array.from(lists[0].querySelectorAll('[role="option"], [role="radio"]'));
    return JSON.stringify({ count: opts.length, items: opts.map(o => (o.textContent || '').trim().slice(0, 16)) });
  })()`));
  await page.screenshot({ path: 'D:/AppData-Migration/Temp/opencode/fb-reg-gender.png' });
}
await context.close();
