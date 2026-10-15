import fs from 'node:fs';

const catalog = JSON.parse(fs.readFileSync('D:/Program Files/OpenCreator/.runtime/generated/creator-presets/catalog.json', 'utf8'));

console.log(`Total presets: ${catalog.presets.length}`);
for (let i = 0; i < catalog.presets.length; i++) {
  const p = catalog.presets[i];
  console.log(`${i + 1}. [${p.id}] ZH: "${p.title['zh-CN']}" | EN: "${p.title['en-US']}"`);
}
