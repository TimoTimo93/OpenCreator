/**
 * Kiểm chứng tạo tài khoản Facebook bằng Gmail của cụm (chụp ảnh từng mốc).
 */
import { chromium } from 'patchright';
import { createFacebookAccountWithGmail } from '../src/social/platforms/facebook-account.js';
import { readGmailConfirmationCode } from '../src/social/platforms/gmail.js';

const profileDir = process.argv[2] ?? 'C:/Users/Admin/.opencreator/data/social/profiles/cluster_bfd74db8';
const shotDir = 'D:/AppData-Migration/Temp/opencode';

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

let fbPage: unknown = null;
const result = await createFacebookAccountWithGmail(
  handle as never,
  { name: 'Lilin Creator', email: 'lolonlilin38@gmail.com', password: 'FbTest12345!x' },
  {
    readConfirmationCode: () => readGmailConfirmationCode(handle as never, 'Facebook'),
    onStage: async (stage) => {
      const pages = context.pages();
      const target = pages.find(p => p.url().includes('facebook.com')) ?? pages[0];
      if (target !== undefined) {
        await target.screenshot({ path: `${shotDir}/fb-create-${stage}.png` }).catch(() => undefined);
        console.log(`STAGE=${stage} URL=${target.url()} SHOT=${shotDir}/fb-create-${stage}.png`);
      }
    }
  }
);
console.log('RESULT=' + JSON.stringify(result));
await context.close();
