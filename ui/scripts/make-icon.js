#!/usr/bin/env node
/**
 * Builds icon.ico from vector source (electron/icon.svg) or falls back to icon.png.
 * Outputs: electron/icon.png, public/icon.png (1024²), electron/icon.ico
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'electron');
const publicDir = path.join(root, 'public');
const svgPath = path.join(electronDir, 'icon.svg');
const pngPath = path.join(electronDir, 'icon.png');
const icoPath = path.join(electronDir, 'icon.ico');
const publicPng = path.join(publicDir, 'icon.png');
const squarePath = path.join(electronDir, 'icon-256.png');

async function main() {
  let sharp, pngToIco;
  try {
    sharp = require('sharp');
    const pkg = require('png-to-ico');
    pngToIco = pkg.default || pkg;
  } catch (e) {
    console.log('Installing sharp and png-to-ico...');
    const { execSync } = require('child_process');
    execSync('npm install sharp png-to-ico --no-save --prefix "' + root + '"', { stdio: 'inherit' });
    sharp = require('sharp');
    const pkg2 = require('png-to-ico');
    pngToIco = pkg2.default || pkg2;
  }

  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  if (fs.existsSync(svgPath)) {
    const svgBuf = fs.readFileSync(svgPath);
    await sharp(svgBuf)
      .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(pngPath);
    console.log('Rasterized', svgPath, '->', pngPath);
  } else {
    await sharp(pngPath)
      .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(pngPath);
  }

  fs.copyFileSync(pngPath, publicPng);
  console.log('Copied ->', publicPng);

  await sharp(pngPath)
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(squarePath);

  const icoBuf = await pngToIco(squarePath);
  fs.writeFileSync(icoPath, icoBuf);
  try {
    fs.unlinkSync(squarePath);
  } catch (_) {}
  console.log('Created', icoPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
