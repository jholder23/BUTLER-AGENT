#!/usr/bin/env node
/**
 * Patch dist-desktop App asar + .env for desktop Comfy on 8198 (no full rebuild).
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
const envPath = path.join(ROOT, 'dist-desktop', 'App', 'resources', '.env');

function upsertEnvLine(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  const trimmed = text.replace(/\s*$/, '');
  return `${trimmed}\r\n\r\n# Packaged desktop ports (avoid clash with npm run dev)\r\n${line}\r\n`;
}

function patchEnv() {
  if (!fs.existsSync(envPath)) {
    console.warn('No .env at', envPath);
    return;
  }
  let text = fs.readFileSync(envPath, 'utf8');
  text = upsertEnvLine(text, 'BUTLER_UI_API_PORT', '4011');
  text = upsertEnvLine(text, 'KNOWLEDGE_API_PORT', '8775');
  text = upsertEnvLine(text, 'KNOWLEDGE_API_URL', 'http://127.0.0.1:8775');
  text = upsertEnvLine(text, 'COMFYUI_URL', 'http://127.0.0.1:8198');
  text = upsertEnvLine(text, 'USE_COMFYUI', '1');
  text = upsertEnvLine(text, 'SD_PROJECT_PATH', path.join(ROOT, 'sd'));
  fs.writeFileSync(envPath, text, 'utf8');
  console.log('Patched', envPath);
}

function patchAsar() {
  if (!fs.existsSync(asarPath)) throw new Error('missing ' + asarPath);
  if (!fs.existsSync(asarBin)) throw new Error('missing ' + asarBin);
  if (!fs.existsSync(srcMain)) throw new Error('missing ' + srcMain);
  fs.rmSync(unpackDir, { recursive: true, force: true });
  execSync(`node "${asarBin}" extract "${asarPath}" "${unpackDir}"`, { stdio: 'inherit' });
  const destMain = path.join(unpackDir, 'electron', 'main.cjs');
  if (!fs.existsSync(destMain)) throw new Error('dest main missing: ' + destMain);
  fs.copyFileSync(srcMain, destMain);
  console.log('Updated', destMain);
  const bak = asarPath + '.bak';
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

function writeReadme() {
  const readme = path.join(ROOT, 'dist-desktop', 'README.txt');
  if (!fs.existsSync(readme)) return;
  let text = fs.readFileSync(readme, 'utf8');
  if (text.includes('Comfy 8198')) return;
  text = text.replace(
    /Running desktop \+ npm run dev together:[\s\S]*?Do not run npm run free:dev-ports[\s\S]*?\r?\n/,
    [
      'Running desktop + npm run dev together:',
      '  Dev keeps 8765 (Knowledge), 4001 (UI API), 5173 (Vite), Comfy 8188.',
      '  Packaged desktop uses 8775 / 4011 / Comfy 8198 by default (see App\\resources\\.env).',
      '  Desktop auto-starts Comfy on 8198 from the same sd\\ComfyUI install (separate temp under %TEMP%\\butler-comfyui-desktop).',
      '  Or run scripts\\start-comfyui-desktop.bat manually. Dev Comfy: scripts\\start-comfyui-temp.bat (8188).',
      '  Start either first; if a preferred desktop port is busy, Electron tries the next (+10).',
      '  Do not run npm run free:dev-ports / dev:restart while you need the desktop Knowledge process',
      '  (those scripts only free 8765/4001/5173/5000 — not 8775/4011/8198).',
      '',
      '',
    ].join('\r\n'),
  );
  text = text.replace(
    /ComfyUI \/ SD: still expected[\s\S]*?\r?\n/,
    'ComfyUI / SD: shared repo sd\\ tree (or SD_PROJECT_PATH). Desktop uses COMFYUI_URL=http://127.0.0.1:8198.\r\n',
  );
  fs.writeFileSync(readme, text, 'utf8');
  console.log('Updated', readme);
}

patchEnv();
patchAsar();
writeReadme();
console.log('Done.');
