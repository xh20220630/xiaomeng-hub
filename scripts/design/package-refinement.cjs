const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '../..');
const review = path.join(root, 'design/ui-v3/refinement');
const sources = path.join(review, 'assets');
const assets = path.join(root, 'app/assets/ui-v3');
const motion = path.join(root, 'app/assets/motion');
const names = ['conversations', 'projects', 'inbox', 'archive', 'agents', 'settings'];
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

async function main() {
  const manifest = [];
  for (const name of names) {
    const source = path.join(sources, `icon-${name}-source.png`);
    const meta = await sharp(source).metadata();
    if (!meta.hasAlpha) throw new Error(`${name}: source must have real alpha`);
    const output = path.join(assets, `icon-${name}.png`);
    await sharp(source).trim({ threshold: 20 }).resize(216, 216, { fit: 'inside' })
      .extend({ top: 20, bottom: 20, left: 20, right: 20, background: transparent })
      .resize(256, 256, { fit: 'contain', background: transparent })
      .png({ compressionLevel: 9 }).toFile(output);
    manifest.push({ name, source: path.relative(root, source), output: path.relative(root, output), width: 256, height: 256, alpha: true });
  }
  for (const name of ['studio', 'orbit']) {
    await sharp(path.join(sources, `project-${name}-source.png`)).resize(900, 600).png({ compressionLevel: 9 })
      .toFile(path.join(assets, `project-ip-${name}.png`));
  }
  for (const animated of [false, true]) {
    const columns = animated ? 8 : 4;
    const layers = [];
    for (let index = 0; index < 4; index++) {
      for (let frame = 0; frame < (animated ? 16 : 2); frame++) {
        const progress = animated ? frame / 15 : frame;
        const side = Math.round(112 + progress * 16);
        const input = await sharp(path.join(assets, `icon-${names[index]}.png`))
          .resize(side, side).png().toBuffer();
        const position = animated ? index * 16 + frame : index + frame * 4;
        layers.push({ input, left: (position % columns) * 128 + Math.floor((128 - side) / 2), top: Math.floor(position / columns) * 128 + Math.floor((128 - side) / 2) });
      }
    }
    await sharp({ create: { width: columns * 128, height: animated ? 1024 : 256, channels: 4, background: transparent } })
      .composite(layers).png({ compressionLevel: 9 }).toFile(path.join(motion, `ip-tabbar-${animated ? 'atlas' : 'still'}.png`));
  }
  const layers = [];
  const labels = [];
  for (let row = 0; row < 3; row++) {
    const bg = ['#11151b', '#f5f6f2', '#d9f66f'][row];
    layers.push({ input: Buffer.from(`<svg width="1080" height="184"><rect width="1080" height="184" fill="${bg}"/></svg>`), left: 0, top: row * 184 });
    for (let i = 0; i < names.length; i++) {
      const source = path.join(assets, `icon-${names[i]}.png`);
      layers.push({ input: await sharp(source).resize(86, 86).toBuffer(), left: i * 180 + 47, top: row * 184 + 12 });
      layers.push({ input: await sharp(source).resize(32, 32).toBuffer(), left: i * 180 + 74, top: row * 184 + 102 });
      labels.push(`<text x="${i * 180 + 90}" y="${row * 184 + 161}" text-anchor="middle" fill="${row ? '#202620' : '#adb5aa'}" font-size="12" font-family="Arial">${names[i]} / 32px</text>`);
    }
  }
  layers.push({ input: Buffer.from(`<svg width="1080" height="552">${labels.join('')}</svg>`), left: 0, top: 0 });
  await sharp({ create: { width: 1080, height: 552, channels: 4, background: transparent } }).composite(layers).png()
    .toFile(path.join(review, 'icon-review.png'));
  await fs.writeFile(path.join(review, 'asset-manifest.json'), JSON.stringify({ icons: manifest, covers: ['project-ip-studio.png', 'project-ip-orbit.png'], navigation: '16-frame scale transition; original independent PNGs retained' }, null, 2));
  console.log('Exported six independent RGBA icons, two covers, navigation atlases and three-background review.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
