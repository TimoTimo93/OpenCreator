/** Điền tên + gõ từ khoá hạng mục → chọn gợi ý → kiểm tra nút "Tạo Trang" bật chưa. */
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

const setValue = async (selector: string, index: number, value: string) => {
  await page.evaluate((arg) => {
    const spec = arg;
    const el = document.querySelectorAll(spec.selector)[spec.index];
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, spec.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { selector, index, value });
  await page.waitForTimeout(1200);
};

await setValue('input[type="text"]', 0, 'Pham Nhan Tu Tien');
console.log('NAME_SET');

// Bấm ô hạng mục (input[type=search] có aria-label "Hạng mục (Bắt buộc)") rồi gõ
const categoryInput = page.locator('input[aria-label*="ạng mục" i], input[aria-label*="category" i]');
console.log('CATEGORY_INPUTS=' + await categoryInput.count());
await categoryInput.nth(0).fill('Phim').catch(e => console.log('FILL-ERR ' + String(e).slice(0, 100)));
await page.waitForTimeout(3000);
console.log('SUGGESTIONS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const out = [];
  for (const el of Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="radio"], div'))) {
    if (!visible(el)) continue;
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text === '' || text.length > 40) continue;
    if (!/phim|video|content|nội dung|phim ảnh/i.test(text)) continue;
    out.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text: text.slice(0, 34) });
    if (out.length > 8) break;
  }
  return JSON.stringify(out);
})()`));
await page.screenshot({ path: shotDir + '/fb-category-typed.png' });
console.log('SHOT=' + shotDir + '/fb-category-typed.png');

// Bấm gợi ý đầu tiên
const picked = await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  for (const el of Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="radio"]'))) {
    if (!visible(el)) continue;
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text === '' || text.length > 40) continue;
    if (!/phim|video|content|nội dung/i.test(text)) continue;
    el.click();
    return 'PICKED ' + text.slice(0, 30);
  }
  return 'NO-SUGGESTION';
})()`);
console.log('PICK=' + picked);
await page.waitForTimeout(2500);
console.log('BUTTON=' + await page.evaluate(`(() => {
  const btn = document.querySelector('[aria-label="Tạo Trang"]');
  return btn ? ('disabled=' + (btn.getAttribute('aria-disabled') || 'false')) : 'NOT-FOUND';
})()`));
await page.screenshot({ path: shotDir + '/fb-category-picked.png' });
console.log('SHOT=' + shotDir + '/fb-category-picked.png');
await context.close();
