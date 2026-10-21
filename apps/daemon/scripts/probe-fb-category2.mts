/** Dò ô "Hạng mục" (picker tuỳ chỉnh) — tìm phần tử + hậu quả khi bấm. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.facebook.com/pages/create/', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9_000);

console.log('CATEGORY_NODE=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const out = [];
  for (const el of Array.from(document.querySelectorAll('div, span, label, button, [role="button"]'))) {
    if (!visible(el)) continue;
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text !== 'Hạng mục (Bắt buộc)') continue;
    out.push({
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
      cls: (el.getAttribute('class') || '').slice(0, 40),
      aria: el.getAttribute('aria-label') || '',
      children: el.children.length,
      parentCls: (el.parentElement?.getAttribute('class') || '').slice(0, 40),
      parentRole: el.parentElement?.getAttribute('role') || ''
    });
    if (out.length > 6) break;
  }
  return JSON.stringify(out);
})()`));

// Bấm vào ô hạng mục (bản thân text node) rồi xem sau đó có gì
const clicked = await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  for (const el of Array.from(document.querySelectorAll('label, div[role="presentation"]'))) {
    if (!visible(el)) continue;
    if ((el.textContent || '').replace(/\\s+/g, ' ').trim() !== 'Hạng mục (Bắt buộc)') continue;
    el.click();
    return 'CLICKED ' + el.tagName;
  }
  return 'NOT-FOUND';
})()`);
console.log('CLICK=' + clicked);
await page.waitForTimeout(2500);
await page.screenshot({ path: shotDir + '/fb-category-click.png' });
console.log('AFTER=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], [role="radio"]')).filter(el => visible(el));
  const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="radio"], [role="listbox"] [role="button"]')).filter(el => visible(el))
    .map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30));
  return JSON.stringify({ dialogs: dialogs.length, items: items.slice(0, 10) });
})()`));
console.log('SHOT=' + shotDir + '/fb-category-click.png');
await context.close();
