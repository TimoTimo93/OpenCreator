import { chromium } from 'patchright';

const profileDir = process.argv[2];
const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  colorScheme: 'dark',
  args: ['--force-dark-mode', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble']
});
const page = await context.newPage();
await page.goto('https://www.tiktok.com/', { timeout: 60_000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
const all = await context.cookies();
console.log('ALL=' + JSON.stringify(all.map(c => ({ n: c.name, d: c.domain, len: (c.value || '').length, part: c.partitionKey ?? '' })).filter(c => c.d.includes('tiktok'))));
const filtered = await context.cookies(['https://www.tiktok.com/']);
console.log('FILTERED=' + JSON.stringify(filtered.map(c => ({ n: c.name, d: c.domain, len: (c.value || '').length }))));
await context.close();
