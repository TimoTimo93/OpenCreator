/** Test module Gmail: đọc email + đọc mã 6 số từ mail (tìm theo từ khoá). */
import { chromium } from 'patchright';
import { readGmailAccountEmail, readGmailConfirmationCode } from '../src/social/platforms/gmail.js';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const keyword = process.argv[3] ?? 'TikTok';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const handle = {
  async newPage(url?: string) {
    const page = await context.newPage();
    if (url !== undefined && url !== '') await page.goto(url, { timeout: 60_000, waitUntil: 'domcontentloaded' });
    return page;
  },
  async pages() { return context.pages(); },
  async cookies(urls: string[]) {
    const list = await context.cookies(urls);
    return list.map(c => ({ name: c.name, value: c.value, domain: c.domain }));
  }
};

console.log('EMAIL=' + await readGmailAccountEmail(handle as never));
console.log('CODE(' + keyword + ')=' + await readGmailConfirmationCode(handle as never, keyword));
await context.close();
