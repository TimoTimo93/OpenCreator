/** Dò luồng upload YouTube Studio: bấm Create → menu → ô file. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://studio.youtube.com/channel/UCV99e8Za17Zu_Y5zk_nQoZA/videos/upload', { timeout: 90_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12_000);
console.log('URL=' + page.url());
console.log('FILE_INPUTS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  return JSON.stringify(Array.from(document.querySelectorAll('input[type="file"]')).map(el => ({
    id: el.id || '', name: el.getAttribute('name') || '', cls: (el.getAttribute('class') || '').slice(0, 40),
    visible: visible(el)
  })));
})()`));
console.log('BUTTONS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  return JSON.stringify(Array.from(document.querySelectorAll('button, [role="button"], tp-yt-paper-button')).filter(el => visible(el))
    .map(el => ({ tag: el.tagName.toLowerCase(), aria: el.getAttribute('aria-label') || '', text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 26) }))
    .filter(x => x.text !== '' || x.aria !== '').slice(0, 22));
})()`));
await page.screenshot({ path: shotDir + '/yt-studio-upload.png' });
console.log('SHOT=' + shotDir + '/yt-studio-upload.png');
await context.close();
