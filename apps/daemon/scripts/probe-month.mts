import { chromium } from 'patchright';
import { writeFileSync } from 'node:fs';

const profileDir = 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.tiktok.com/signup/age-gate', { timeout: 60000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);

const combo = page.locator('div[role="combobox"][data-e2e="select-container"]');
console.log('COMBOS=' + await combo.count());
console.log('COMBO0_TEXT=' + JSON.stringify((await combo.nth(0).innerText().catch(() => '')).slice(0, 40)));

await combo.nth(0).click({ timeout: 8000 }).catch(e => console.log('CLICK-ERR ' + String(e).slice(0, 150)));
await page.waitForTimeout(1800);

const state = await page.evaluate(() => {
  const lists = Array.from(document.querySelectorAll('div[role="listbox"]')).map(lb => ({
    visible: (lb as HTMLElement).offsetParent !== null,
    style: lb.getAttribute('style') ?? '',
    cls: lb.getAttribute('class') ?? '',
    text: (lb.textContent ?? '').replace(/\s+/g, ' ').slice(0, 80),
    optCount: lb.querySelectorAll('[role="option"]').length,
    firstOptions: Array.from(lb.querySelectorAll('[role="option"]')).slice(0, 3).map(o => (o.textContent ?? '').trim().slice(0, 14))
  }));
  return JSON.stringify(lists);
});
console.log('AFTER_CLICK=' + state);

await page.screenshot({ path: 'D:/AppData-Migration/Temp/opencode/tiktok-month-dropdown.png' });
console.log('SHOT=D:/AppData-Migration/Temp/opencode/tiktok-month-dropdown.png');

for (const label of ['Tháng 1', 'January', '1']) {
  const opt = page.getByText(label, { exact: true });
  const n = await opt.count();
  console.log(`BYTEXT ${label} count=${n}`);
  if (n > 0) {
    await opt.first().click({ timeout: 6000 }).catch(e => console.log('  click-err ' + String(e).slice(0, 100)));
    await page.waitForTimeout(1200);
    const comboText = await combo.nth(0).innerText().catch(() => '');
    console.log('  combo0 after = ' + JSON.stringify(comboText.slice(0, 30)));
    if (comboText.trim() !== '' && !comboText.includes('Tháng')) break;
  }
}
await page.screenshot({ path: 'D:/AppData-Migration/Temp/opencode/tiktok-month-after.png' });
await context.close();
