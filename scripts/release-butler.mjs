#!/usr/bin/env node
/**
 * Production drop: build Butler (Electron + NSIS) and copy artifacts to a durable folder:
 *   <releaseRoot>/
 *     App/           — portable win-unpacked (Butler.exe, resources, …)
 *     installer/     — NSIS setup *.exe
 *     README.txt
 *
 * Default release root is <repo>/dist-desktop (NOT D:\Butler — on Windows that
 * collides with D:\BUTLER because paths are case-insensitive).
 *
 * Usage (from repo root):
 *   npm run release
 *   npm run desktop
 *   npm run release -- --skip-build     # copy existing ui/dist-app-new only
 *
 * Env:
 *   BUTLER_RELEASE_ROOT  — override output directory (absolute path recommended)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UI = path.join(ROOT, 'ui');
const DIST = path.join(UI, 'dist-app-new');
const UNPACKED = path.join(DIST, 'win-unpacked');

function defaultReleaseRoot() {
  const env = (process.env.BUTLER_RELEASE_ROOT || '').trim();
  if (env) return path.resolve(env);
  // Prefer in-repo dist-desktop so we never clobber the git checkout on
  // case-insensitive Windows (D:\Butler === D:\BUTLER).
  return path.join(ROOT, 'dist-desktop');
}

const skipBuild = process.argv.includes('--skip-build');

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
  }
  fs.cpSync(src, dest, { recursive: true });
}

function findNsisInstaller() {
  if (!fs.existsSync(DIST)) return null;
  const names = fs.readdirSync(DIST);
  const exes = names.filter((n) => {
    if (!n.endsWith('.exe')) return false;
    const p = path.join(DIST, n);
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  const filtered = exes.filter((n) => !/uninst/i.test(n));
  if (!filtered.length) return null;
  const setup = filtered.find((n) => /setup/i.test(n));
  return path.join(DIST, setup || filtered[0]);
}

function upsertEnvLine(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  const trimmed = text.replace(/\s*$/, '');
  return `${trimmed}\r\n\r\n# Packaged desktop ports (avoid clash with npm run dev on 4001/8765)\r\n${line}\r\n`;
}

/** Desktop portable app listens on alternate ports so `npm run dev` can run at the same time. */
function applyDesktopPortsToEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    console.warn('No .env to patch for desktop ports:', envPath);
    return;
  }
  let text = fs.readFileSync(envPath, 'utf8');
  text = upsertEnvLine(text, 'BUTLER_UI_API_PORT', '4011');
  text = upsertEnvLine(text, 'KNOWLEDGE_API_PORT', '8775');
  text = upsertEnvLine(text, 'KNOWLEDGE_API_URL', 'http://127.0.0.1:8775');
  // Separate Comfy instance from dev (8188) — same sd/ComfyUI install, different port + temp dirs.
  text = upsertEnvLine(text, 'COMFYUI_URL', 'http://127.0.0.1:8198');
  text = upsertEnvLine(text, 'USE_COMFYUI', '1');
  // Packaged app must not look under Electron resources\sd (not shipped). Point at repo sd.
  const sdAbs = path.join(ROOT, 'sd');
  text = upsertEnvLine(text, 'SD_PROJECT_PATH', sdAbs);
  fs.writeFileSync(envPath, text, 'utf8');
  console.log('Patched desktop ports in', envPath, '(UI 4011, Knowledge 8775, Comfy 8198, SD', sdAbs + ')');
}

function writeReadme(releaseRoot, version) {
  const appDir = path.join(releaseRoot, 'App');
  const text = [
    `Butler ${version} — production drop`,
    '',
    'Folders:',
    `  App\\\\          Portable app — run App\\\\Butler.exe or App\\\\Butler-Start.cmd`,
    `  installer\\\\    Windows setup (optional install to Program Files)`,
    '',
    'Desktop: after "npm run release", a shortcut "Butler.lnk" is created on your Desktop',
    'pointing at this portable App\\\\Butler.exe (if the build finished on this machine).',
    '',
    'Dev stack (hot reload): from the git repo run npm run dev / npm run dev:restart — do not use for daily desktop use.',
    'Rebuild this packaged app: from the repo root run npm run desktop  (or cd ui && npm run build:app).',
    '',
    'Running desktop + npm run dev together:',
    '  Dev keeps 8765 (Knowledge), 4001 (UI API), 5173 (Vite), Comfy 8188.',
    '  Packaged desktop uses 8775 / 4011 / Comfy 8198 by default (see App\\\\resources\\\\.env).',
    '  Desktop auto-starts Comfy on 8198 from the same sd\\\\ComfyUI install (separate temp under %TEMP%\\\\butler-comfyui-desktop).',
    '  Or run scripts\\\\start-comfyui-desktop.bat manually. Dev Comfy: scripts\\\\start-comfyui-temp.bat (8188).',
    '  Start either first; if a preferred desktop port is busy, Electron tries the next (+10).',
    '  Do not run npm run free:dev-ports / dev:restart while you need the desktop Knowledge process',
    '  (those scripts only free 8765/4001/5173/5000 — not 8775/4011/8198).',
    '',
    'Local chat (Ollama): set BUTLOR_AI_URL in the repo .env before building, or edit',
    'App\\\\resources\\\\.env after install. Example:',
    '  BUTLOR_AI_URL=http://127.0.0.1:11434/v1',
    '  LOCAL_MODEL=dolphin-llama3:8b',
    'Then: ollama pull <LOCAL_MODEL> and keep Ollama running.',
    '',
    'Knowledge API + embedded Python ship inside the app under resources.',
    'ComfyUI / SD: shared repo sd\\\\ tree. Release sets SD_PROJECT_PATH in App\\\\resources\\\\.env;',
    'Electron also walks up from Butler.exe to find sd\\\\ComfyUI (does not use empty resources\\\\sd).',
    'Desktop Comfy: port 8198, temp %TEMP%\\\\butler-comfyui-desktop, --normalvram --fp16-vae --disable-cuda-malloc --disable-pinned-memory.',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(releaseRoot, 'README.txt'), text, 'utf8');
}

function createDesktopShortcut(exePath) {
  if (process.platform !== 'win32') {
    console.log('Skipping desktop shortcut (not Windows).');
    return;
  }
  if (!fs.existsSync(exePath)) {
    console.warn('Butler.exe missing; skip desktop shortcut:', exePath);
    return;
  }
  process.env.BUTLER_DESKTOP_EXE = exePath;
  process.env.BUTLER_DESKTOP_SHORTCUT_NAME = 'Butler';
  const shortcutScript = path.join(UI, 'scripts', 'desktop-shortcut.js');
  execSync(`node "${shortcutScript}"`, { stdio: 'inherit', env: { ...process.env } });
}

function main() {
  const releaseRoot = defaultReleaseRoot();
  console.log('Release root:', releaseRoot);

  if (!skipBuild) {
    console.log('\nBuilding (ui: clean, icon, prepare-installer, vite, electron-builder)…\n');
    execSync('npm run build:app', {
      cwd: UI,
      stdio: 'inherit',
      env: {
        ...process.env,
        // Avoid winCodeSign symlink privilege failures on Windows without Developer Mode.
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=8192'].filter(Boolean).join(' '),
      },
    });
  }

  if (!fs.existsSync(UNPACKED) || !fs.existsSync(path.join(UNPACKED, 'Butler.exe'))) {
    console.error('Missing', UNPACKED, 'or Butler.exe. Run without --skip-build first.');
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(UI, 'package.json'), 'utf8'));
  const version = pkg.version || '0.0.0';

  const appDest = path.join(releaseRoot, 'App');
  const instDest = path.join(releaseRoot, 'installer');
  console.log('\nCopying portable app ->', appDest);
  copyDir(UNPACKED, appDest);
  applyDesktopPortsToEnvFile(path.join(appDest, 'resources', '.env'));

  fs.mkdirSync(instDest, { recursive: true });
  const nsis = findNsisInstaller();
  if (nsis && fs.existsSync(nsis)) {
    const base = path.basename(nsis);
    const destExe = path.join(instDest, base);
    fs.copyFileSync(nsis, destExe);
    console.log('Copied installer ->', destExe);
  } else {
    console.warn('No NSIS .exe found in dist-app-new (dir build may still be OK).');
  }

  writeReadme(releaseRoot, version);
  console.log('Wrote README.txt');

  const portableExe = path.join(appDest, 'Butler.exe');
  createDesktopShortcut(portableExe);

  console.log('\nDone. Portable:', portableExe);
  if (nsis) console.log('Installer:', path.join(instDest, path.basename(nsis)));
}

main();
