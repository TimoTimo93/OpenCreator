/** Debug hàm đọc email Gmail: in ra title + các email tìm thấy trong body. */
import { chromium } from 'patchright';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
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
const { readGmailAccountEmail } = await import('../src/social/platforms/gmail.js');
console.log('MODULE_EMAIL=' + await readGmailAccountEmail(handle as never));

// In title + các email trong body để đối chiếu
const page = await context.newPage();
await page.goto('https://mail.google.com/mail/u/0/#inbox', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12_000);
const title = await page.title();
console.log('TITLE=' + title);
console.log('TITLE_MAIL=' + JSON.stringify(title.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? ''));
console.log('BODY_MAILS=' + await page.evaluate(`(() => {
  const main = document.querySelector('div[role="main"]');
  const text = (main && main.textContent) || '';
  const all = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g) || [];
  return JSON.stringify(Array.from(new Set(all)).slice(0, 8));
})()`));
await context.close();
