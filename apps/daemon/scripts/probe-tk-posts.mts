/** Kiểm tra trang "Bài đăng" của TikTok Studio — xem bài đăng có thật không. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
for (const url of ['https://www.tiktok.com/tiktokstudio/content/post', 'https://www.tiktok.com/tiktokstudio/content/postmanage']) {
  await page.goto(url, { timeout: 90_000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForTimeout(12_000);
  console.log('URL=' + page.url());
  console.log('TEXT=' + await page.evaluate(`(() => {
    const main = document.querySelector('div[role="main"]') || document.body;
    return ((main.innerText || '').replace(/\\s+/g, ' ')).slice(0, 500);
  })()`));
  await page.screenshot({ path: shotDir + '/tk-posts-list.png' });
  console.log('SHOT=' + shotDir + '/tk-posts-list.png');
}
await context.close();
