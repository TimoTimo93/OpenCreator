/** Dò DOM các gợi ý hạng mục để click đúng. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
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
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, spec.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { selector, index, value });
  await page.waitForTimeout(1000);
};
await setValue('input[type="text"]', 0, 'Pham Nhan Tu Tien');
const cat = page.locator('input[aria-label*="ạng mục" i], input[aria-label*="category" i]');
await cat.nth(0).fill('Phim').catch(() => undefined);
await page.waitForTimeout(3000);

console.log('SUGGEST_NODES=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const out = [];
  for (const el of Array.from(document.querySelectorAll('div, span, li'))) {
    if (!visible(el)) continue;
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text !== 'Phim' && text !== 'Người tạo thước phim') continue;
    out.push({
      text: text.slice(0, 26), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
      cls: (el.getAttribute('class') || '').slice(0, 34),
      parentCls: (el.parentElement?.getAttribute('class') || '').slice(0, 34),
      parentRole: el.parentElement?.getAttribute('role') || '',
      childCount: el.children.length
    });
    if (out.length > 10) break;
  }
  return JSON.stringify(out);
})()`));

// Thử click vào dòng gợi ý "Người tạo thước phim" (dòng thứ 2) rồi kiểm tra nút
const option = page.locator('li[role="option"]', { hasText: 'Phim' });
console.log('OPTIONS=' + await option.count());
await option.first().click({ timeout: 8000 }).catch(e => console.log('CLICK-ERR ' + String(e).slice(0, 120)));
console.log('PICK=REAL-CLICK');
await page.waitForTimeout(2500);
console.log('BUTTON=' + await page.evaluate(`(() => {
  const btn = document.querySelector('[aria-label="Tạo Trang"]');
  return btn ? ('disabled=' + (btn.getAttribute('aria-disabled') || 'false')) : 'NOT-FOUND';
})()`));
await page.screenshot({ path: 'D:/AppData-Migration/Temp/opencode/fb-category-final.png' });
console.log('SHOT=D:/AppData-Migration/Temp/opencode/fb-category-final.png');
await context.close();
