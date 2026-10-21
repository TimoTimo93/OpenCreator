/**
 * Kiểm chứng luồng đọc mã xác nhận từ Gmail:
 * tìm kiếm → mở mail đầu tiên → đọc nội dung → rút mã 6 chữ số.
 */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';
const keyword = process.argv[3] ?? 'TikTok';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://mail.google.com/mail/u/0/#inbox', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(11_000);

const search = page.locator('input[name="q"][aria-label="Search mail"]');
await search.nth(0).fill(keyword).catch(() => undefined);
await search.nth(0).press('Enter').catch(() => undefined);
await page.waitForTimeout(6000);
console.log('AFTER_SEARCH_URL=' + page.url());
console.log('ROWS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const out = [];
  const cands = Array.from(document.querySelectorAll('div[role="listitem"], tr.zA, div.adL'));
  for (const el of cands.slice(0, 6)) {
    if (!visible(el)) continue;
    out.push({ tag: el.tagName.toLowerCase(), cls: (el.getAttribute('class') || '').slice(0, 40), text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90) });
  }
  return JSON.stringify(out);
})()`));
await page.screenshot({ path: shotDir + '/gmail-search.png' });
console.log('SHOT=' + shotDir + '/gmail-search.png');

// Mở mail đầu tiên
const opened = await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const cands = Array.from(document.querySelectorAll('div[role="listitem"], tr.zA, div.adL')).filter(el => visible(el));
  const target = cands[0];
  if (!target) return false;
  (target as HTMLElement).click();
  return true;
})()`).catch(() => false);
console.log('OPENED=' + opened);
await page.waitForTimeout(6000);
console.log('BODY=' + await page.evaluate(`(() => {
  const body = (document.querySelector('div[role="main"]') || document.body);
  const text = (body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400);
  const codes = (body.innerText || '').match(/\\b\\d{4,8}\\b/g);
  return JSON.stringify({ text, codes: codes ? codes.slice(0, 6) : [] });
})()`).catch(e => 'ERR ' + String(e).slice(0, 120)));
await page.screenshot({ path: shotDir + '/gmail-mail.png' });
console.log('SHOT=' + shotDir + '/gmail-mail.png');
await context.close();
