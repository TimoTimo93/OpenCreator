/** Kiểm chứng: video đã đăng thực sự tồn tại trên YouTube Studio và TikTok Studio không. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();

// 1) YouTube Studio — danh sách video của kênh
await page.goto('https://studio.youtube.com/channel/UCV99e8Za17Zu_Y5zk_nQoZA/videos/upload', { timeout: 90_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12_000);
console.log('YT_URL=' + page.url());
console.log('YT_ROWS=' + await page.evaluate(`(() => {
  const visible = (el) => el.offsetParent !== null;
  const rows = Array.from(document.querySelectorAll('ytcp-video-row, ytcp-video-list-item, tr')).filter(el => visible(el))
    .map(el => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120))
    .filter(t => t.length > 8);
  return JSON.stringify(rows.slice(0, 8));
})()`));
await page.screenshot({ path: shotDir + '/verify-yt-videos.png' });
console.log('SHOT=' + shotDir + '/verify-yt-videos.png');

// 2) TikTok Studio — danh sách bài đăng
await page.goto('https://www.tiktok.com/tiktokstudio/content/post', { timeout: 90_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(14_000);
console.log('TK_URL=' + page.url());
console.log('TK_TEXT=' + await page.evaluate(`(() => {
  const main = document.querySelector('div[role="main"]') || document.body;
  return ((main.innerText || '').replace(/\\s+/g, ' ')).slice(0, 700);
})()`));
await page.screenshot({ path: shotDir + '/verify-tk-posts.png' });
console.log('SHOT=' + shotDir + '/verify-tk-posts.png');
await context.close();
