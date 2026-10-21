/** Dò composer TikTok Studio sau khi tải file: nút Đăng, quyền xem, data-e2e. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';
const video = process.argv[3] ?? 'D:/downloads/opencreator-test-1.mp4';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.tiktok.com/tiktokstudio/upload', { timeout: 90_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10_000);

const fileInput = page.locator("input[type='file'][accept*='video']");
console.log('FILE_INPUT=' + await fileInput.count());
await fileInput.first().setInputFiles(video).catch(e => console.log('SET-ERR ' + String(e).slice(0, 100)));
await page.waitForTimeout(12_000);
await page.screenshot({ path: shotDir + '/tk-composer-probe.png' });
console.log('SHOT=' + shotDir + '/tk-composer-probe.png');

console.log('BUTTONS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const nodes = Array.from(document.querySelectorAll('button, [role="button"], [data-e2e]')).filter(el => visible(el));
  const out = [];
  for (const el of nodes) {
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 26);
    const e2e = el.getAttribute('data-e2e') || '';
    const aria = el.getAttribute('aria-label') || '';
    if (text === '' && e2e === '' && aria === '') continue;
    if (!/đăng|post|len|lịch|schedule|quyền|privacy|ai|upload|chọn|select|bật|bật|next|tiếp|publish|cancel|hủy/i.test(text + ' ' + e2e + ' ' + aria)) continue;
    out.push({ tag: el.tagName.toLowerCase(), text, e2e, aria: aria.slice(0, 26), role: el.getAttribute('role') || '' });
  }
  return JSON.stringify(out.slice(0, 30));
})()`));
console.log('E2E_ALL=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const set = new Set();
  for (const el of Array.from(document.querySelectorAll('[data-e2e]'))) {
    if (!visible(el)) continue;
    set.add(el.getAttribute('data-e2e'));
  }
  return JSON.stringify(Array.from(set).slice(0, 40));
})()`));
console.log('TEXT=' + await page.evaluate(`(() => {
  const main = document.querySelector('div[role="main"]') || document.body;
  return ((main.innerText || '').replace(/\\s+/g, ' ')).slice(0, 600);
})()`));
await context.close();
