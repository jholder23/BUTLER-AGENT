#!/usr/bin/env node
/**
 * Patch dist-desktop App asar with electron/main.cjs + fresh ui/dist (View Results / decode).
 * Also refreshes Knowledge comfy_helper + butler_simple_ui on the packaged resources tree.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const asarPath = path.join(ROOT, 'dist-desktop', 'App', 'resources', 'app.asar');
const unpackDir = path.join(ROOT, 'dist-desktop', '_asar_patch');
const asarBin = path.join(ROOT, 'ui', 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
const srcMain = path.join(ROOT, 'ui', 'electron', 'main.cjs');
const srcDist = path.join(ROOT, 'ui', 'dist');
const knowledgeSrc = path.join(ROOT, 'knowledge');
const knowledgeDst = path.join(ROOT, 'dist-desktop', 'App', 'resources', 'knowledge');

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function patchKnowledge() {
  if (!fs.existsSync(knowledgeDst)) {
    console.warn('No packaged knowledge at', knowledgeDst);
    return;
  }
  copyFile(path.join(knowledgeSrc, 'comfy_helper.py'), path.join(knowledgeDst, 'comfy_helper.py'));
  const simpleSrc = path.join(knowledgeSrc, 'butler_simple_ui');
  const simpleDst = path.join(knowledgeDst, 'butler_simple_ui');
  if (fs.existsSync(simpleSrc)) {
    fs.mkdirSync(simpleDst, { recursive: true });
    for (const name of ['__init__.py', 'web']) {
      const from = path.join(simpleSrc, name);
      const to = path.join(simpleDst, name);
      if (!fs.existsSync(from)) continue;
      if (fs.statSync(from).isDirectory()) copyDir(from, to);
      else fs.copyFileSync(from, to);
    }
  }
  console.log('Updated packaged knowledge decode / ButlerSweepSave');
}

function patchAsar() {
  if (!fs.existsSync(asarPath)) throw new Error('missing ' + asarPath);
  if (!fs.existsSync(asarBin)) throw new Error('missing ' + asarBin);
  if (!fs.existsSync(srcMain)) throw new Error('missing ' + srcMain);
  if (!fs.existsSync(srcDist)) throw new Error('missing ui/dist — run npm run build in ui/');

  fs.rmSync(unpackDir, { recursive: true, force: true });
  execSync(`node "${asarBin}" extract "${asarPath}" "${unpackDir}"`, { stdio: 'inherit' });

  const destMain = path.join(unpackDir, 'electron', 'main.cjs');
  if (!fs.existsSync(destMain)) throw new Error('dest main missing: ' + destMain);
  fs.copyFileSync(srcMain, destMain);
  console.log('Updated', destMain);

  const destDist = path.join(unpackDir, 'dist');
  fs.rmSync(destDist, { recursive: true, force: true });
  copyDir(srcDist, destDist);
  console.log('Updated', destDist);

  const bak = asarPath + '.bak-view-results';
  if (!fs.existsSync(bak)) fs.copyFileSync(asarPath, bak);
  const tmp = asarPath + '.new';
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  execSync(`node "${asarBin}" pack "${unpackDir}" "${tmp}"`, { stdio: 'inherit' });
  try {
    fs.rmSync(asarPath, { force: true });
  } catch (e) {
    console.error('Could not replace app.asar (is Butler.exe running?). Packed to', tmp);
    throw e;
  }
  fs.renameSync(tmp, asarPath);
  fs.rmSync(unpackDir, { recursive: true, force: true });
  console.log('Repacked', asarPath);
}

patchKnowledge();
patchAsar();
console.log('Done.');
