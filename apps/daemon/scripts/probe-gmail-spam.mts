/** Kiểm tra mail Facebook trong Gmail: Inbox + Spam (chụp ảnh từng nơi). */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://mail.google.com/mail/u/0/#inbox', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(11_000);
console.log('TITLE=' + await page.title());

const search = async (keyword: string) => {
  const box = page.locator('input[name="q"][aria-label="Search mail"]');
  await box.nth(0).fill(keyword).catch(() => undefined);
  await box.nth(0).press('Enter').catch(() => undefined);
  await page.waitForTimeout(6_000).catch(() => undefined);
};

// 1) Inbox
await search('Facebook');
console.log('INBOX=' + await page.evaluate(`(() => {
  const main = document.querySelector('div[role="main"]');
  return ((main && main.innerText) || '').replace(/\\s+/g, ' ').slice(0, 400);
})()`));
await page.screenshot({ path: shotDir + '/gmail-inbox-fb.png' });
console.log('SHOT=' + shotDir + '/gmail-inbox-fb.png');

// 2) Spam
await page.goto('https://mail.google.com/mail/u/0/#spam', { timeout: 60_000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
await page.waitForTimeout(9_000).catch(() => undefined);
console.log('SPAM_TITLE=' + await page.title());
console.log('SPAM=' + await page.evaluate(`(() => {
  const main = document.querySelector('div[role="main"]');
  return ((main && main.innerText) || '').replace(/\\s+/g, ' ').slice(0, 400);
})()`));
await page.screenshot({ path: shotDir + '/gmail-spam-fb.png' });
console.log('SHOT=' + shotDir + '/gmail-spam-fb.png');
await context.close();
