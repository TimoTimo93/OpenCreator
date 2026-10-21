/** Dò ô "Hạng mục" (category) trên trang tạo Page + trạng thái nút "Tạo Trang". */
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

// Điền tên Page vào ô text (bỏ qua ô search)
await page.evaluate(`(() => {
  const el = document.querySelector('input[type="text"]');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, 'Pham Nhan Tu Tien');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await page.waitForTimeout(1500);

console.log('CATEGORY_ELEMENTS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const out = [];
  for (const el of Array.from(document.querySelectorAll('[role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [aria-expanded], div'))) {
    if (!visible(el)) continue;
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    const hint = text.toLowerCase();
    if (!hint.includes('hạng mục') && !hint.includes('hang muc') && !hint.includes('category') && el.getAttribute('role') !== 'combobox') continue;
    out.push({
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
      aria: el.getAttribute('aria-label') || '', expanded: el.getAttribute('aria-expanded') || '',
      text: text.slice(0, 40)
    });
    if (out.length > 8) break;
  }
  return JSON.stringify(out);
})()`));

console.log('BUTTON_STATE_BEFORE=' + await page.evaluate(`(() => {
  const btn = document.querySelector('[aria-label="Tạo Trang"], [role="button"][aria-label*="Tạo Trang"]');
  return btn ? (btn.getAttribute('aria-disabled') || 'false') : 'NOT-FOUND';
})()`));
await page.screenshot({ path: shotDir + '/fb-page-filled.png' });
console.log('SHOT=' + shotDir + '/fb-page-filled.png');

// Bấm ô hạng mục rồi xem danh sách
const clicked = await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const nodes = Array.from(document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]')).filter(el => visible(el));
  if (nodes.length === 0) return 'NO-COMBO';
  nodes[0].click();
  return 'CLICKED ' + (nodes[0].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
})()`);
console.log('CATEGORY_CLICK=' + clicked);
await page.waitForTimeout(2000);
console.log('OPTIONS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const lists = Array.from(document.querySelectorAll('[role="listbox"], [role="list"]')).filter(el => visible(el));
  if (lists.length === 0) return 'NO-LIST';
  const items = Array.from(lists[0].querySelectorAll('[role="option"], [role="radio"], li'));
  return JSON.stringify(items.slice(0, 8).map(i => (i.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24)));
})()`));
await page.screenshot({ path: shotDir + '/fb-page-category.png' });
console.log('SHOT=' + shotDir + '/fb-page-category.png');
await context.close();
