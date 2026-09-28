const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '../..');
const design = path.join(root, 'design/live-notifications-v1');
const flutter = path.join(root, 'app/assets/live-notifications');
const android = path.join(root, 'app/android/app/src/main/res/drawable-nodpi');

async function main() {
  await fs.mkdir(flutter, { recursive: true });
  const manifest = [];
  for (const name of ['running', 'approval', 'completed', 'offline']) {
    const source = path.join(design, 'sources', `${name}.png`);
    const output = path.join(flutter, `${name}.png`);
    await sharp(source).resize(256, 256).png({ compressionLevel: 9 }).toFile(output);
    await fs.copyFile(output, path.join(android, `meng_live_${name}.png`));
    manifest.push({ name, source: path.relative(root, source), file: path.relative(root, output), width: 256, height: 256, background: 'intentional opaque ink; clipped by native/Flutter views', bytes: (await fs.stat(output)).size });
  }
  const avatar = path.join(root, 'app/assets/ui-v3/mascot-avatar.png');
  if (!(await sharp(avatar).metadata()).hasAlpha) throw new Error('Tracker needs a genuine alpha source');
  await sharp(avatar).resize(96, 96).png().toFile(path.join(android, 'meng_live_tracker.png'));
  await fs.writeFile(path.join(design, 'asset-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
