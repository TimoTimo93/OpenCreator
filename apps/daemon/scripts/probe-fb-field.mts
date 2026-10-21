/** Dò cấu trúc bên trong ô "Hạng mục" (tìm phần tử editable). */
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
console.log('FIELD=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  for (const el of Array.from(document.querySelectorAll('label, div'))) {
    if (!visible(el)) continue;
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text !== 'Hạng mục (Bắt buộc)') continue;
    const nodes = Array.from(el.querySelectorAll('input, textarea, [contenteditable="true"], [role="combobox"], [role="textbox"], div[role="button"]'));
    return JSON.stringify({
      html: el.innerHTML.slice(0, 400),
      nodes: nodes.map(n => ({
        tag: n.tagName.toLowerCase(), type: n.getAttribute('type') || '',
        role: n.getAttribute('role') || '', editable: n.getAttribute('contenteditable') || '',
        ph: n.getAttribute('placeholder') || '', aria: n.getAttribute('aria-label') || '',
        cls: (n.getAttribute('class') || '').slice(0, 30)
      }))
    });
  }
  return 'NOT-FOUND';
})()`));
console.log('ALL_INPUTS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  return JSON.stringify(Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]')).map(el => ({
    tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', editable: el.getAttribute('contenteditable') || '',
    ph: el.getAttribute('placeholder') || '', aria: el.getAttribute('aria-label') || '',
    visible: visible(el), cls: (el.getAttribute('class') || '').slice(0, 24)
  })));
})()`));
await context.close();
