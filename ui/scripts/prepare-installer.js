#!/usr/bin/env node
/**
 * Prepares installer assets: embedded Python + deps.
 * Run before: npm run build:app
 * Creates: ui/python-embed/
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const http = require('http');

const ROOT = path.resolve(__dirname, '../..');
const UI = path.resolve(__dirname, '..');
const KNOWLEDGE = path.join(ROOT, 'knowledge');
const PYTHON_EMBED_DIR = path.join(UI, 'python-embed');
const INSTALLERS_DIR = path.join(UI, 'installers');

const PYTHON_EMBED_URL = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip';
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest, { flags: 'w' });
    protocol.get(url, { redirect: 'follow' }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { file.close(); fs.unlinkSync(dest); reject(err); });
  });
}

function run(cmd, opts = {}) {
  console.log('>', cmd);
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

async function main() {
  console.log('Preparing installer assets...\n');

  // 1. Python embed
  if (!fs.existsSync(path.join(PYTHON_EMBED_DIR, 'python.exe'))) {
    console.log('Downloading Python embeddable...');
    fs.mkdirSync(PYTHON_EMBED_DIR, { recursive: true });
    const zipPath = path.join(PYTHON_EMBED_DIR, 'python-embed.zip');
    await download(PYTHON_EMBED_URL, zipPath);

    const unzip = process.platform === 'win32'
      ? `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${PYTHON_EMBED_DIR}' -Force"`
      : `unzip -o "${zipPath}" -d "${PYTHON_EMBED_DIR}"`;
    run(unzip);
    fs.unlinkSync(zipPath);

    // Uncomment import site in python311._pth
    const pthGlob = fs.readdirSync(PYTHON_EMBED_DIR).find(f => f.endsWith('._pth'));
    if (pthGlob) {
      const pthPath = path.join(PYTHON_EMBED_DIR, pthGlob);
      let content = fs.readFileSync(pthPath, 'utf8');
      content = content.replace(/#\s*import\s+site/, 'import site');
      fs.writeFileSync(pthPath, content);
    }

    // Get pip
    const getPipPath = path.join(PYTHON_EMBED_DIR, 'get-pip.py');
    await download(GET_PIP_URL, getPipPath);
    run(`"${path.join(PYTHON_EMBED_DIR, 'python.exe')}" "${getPipPath}" --no-warn-script-location`, { cwd: PYTHON_EMBED_DIR });
    fs.unlinkSync(getPipPath);

    // Install knowledge deps
    const reqPath = path.join(KNOWLEDGE, 'requirements.txt');
    const minimalReqs = [
      'chromadb>=0.4.0',
      'flask>=3.0.0',
      'python-dotenv>=1.0.0',
    ];
    const reqContent = fs.existsSync(reqPath)
      ? fs.readFileSync(reqPath, 'utf8')
      : minimalReqs.join('\n');
    const filtered = reqContent
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      ;
    const finalReqs = filtered.length ? filtered : minimalReqs;
    fs.writeFileSync(path.join(PYTHON_EMBED_DIR, 'reqs.txt'), finalReqs.join('\n'));
    run(`"${path.join(PYTHON_EMBED_DIR, 'python.exe')}" -m pip install -r "${path.join(PYTHON_EMBED_DIR, 'reqs.txt')}" --no-warn-script-location`, { cwd: PYTHON_EMBED_DIR });
    try {
      // Chromium is large; only install when the browser binary is missing.
      const pwChromeHint = path.join(
        PYTHON_EMBED_DIR,
        'Lib',
        'site-packages',
        'playwright',
        'driver',
        'package',
        '.local-browsers',
      );
      const already = fs.existsSync(pwChromeHint) && fs.readdirSync(pwChromeHint).some((n) => /chromium/i.test(n));
      if (already) {
        console.log('Playwright Chromium already present; skip install.');
      } else {
        run(`"${path.join(PYTHON_EMBED_DIR, 'python.exe')}" -m playwright install chromium`, { cwd: PYTHON_EMBED_DIR });
      }
    } catch (e) {
      console.warn('Playwright chromium install skipped (optional for job auto-submit):', e.message);
    }
  } else {
    console.log('Python embed exists. Syncing dependencies...');
    const reqPath = path.join(KNOWLEDGE, 'requirements.txt');
    const minimalReqs = ['chromadb>=0.4.0', 'flask>=3.0.0', 'python-dotenv>=1.0.0'];
    const reqContent = fs.existsSync(reqPath)
      ? fs.readFileSync(reqPath, 'utf8')
      : minimalReqs.join('\n');
    const filtered = reqContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const finalReqs = filtered.length ? filtered : minimalReqs;
    fs.writeFileSync(path.join(PYTHON_EMBED_DIR, 'reqs.txt'), finalReqs.join('\n'));
    run(`"${path.join(PYTHON_EMBED_DIR, 'python.exe')}" -m pip install -r "${path.join(PYTHON_EMBED_DIR, 'reqs.txt')}" --no-warn-script-location`, { cwd: PYTHON_EMBED_DIR });
    try {
      const pwChromeHint = path.join(
        PYTHON_EMBED_DIR,
        'Lib',
        'site-packages',
        'playwright',
        'driver',
        'package',
        '.local-browsers',
      );
      const already = fs.existsSync(pwChromeHint) && fs.readdirSync(pwChromeHint).some((n) => /chromium/i.test(n));
      if (already) {
        console.log('Playwright Chromium already present; skip install.');
      } else {
        run(`"${path.join(PYTHON_EMBED_DIR, 'python.exe')}" -m playwright install chromium`, { cwd: PYTHON_EMBED_DIR });
      }
    } catch (e) {
      console.warn('Playwright chromium install skipped:', e.message);
    }
  }

  // 2. Ensure .env has Butler config for packaged app (Ollama OpenAI-compatible by default)
  const envPath = path.join(ROOT, '.env');
  // Desktop release patches COMFYUI_URL=8198 into dist-desktop; Electron packaged defaults match.
  const defaults = [
    'LOCAL_MODEL=dolphin-llama3:8b',
    'BUTLOR_AI_URL=http://127.0.0.1:11434/v1',
  ];
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of defaults) {
      const key = line.split('=')[0];
      if (!new RegExp(`^\\s*${key}\\s*=`, 'm').test(envContent)) {
        envContent += (envContent.endsWith('\n') ? '' : '\n') + line + '\n';
        fs.writeFileSync(envPath, envContent);
        console.log(`Added ${line} to .env`);
      }
    }
  } else {
    fs.writeFileSync(envPath, defaults.join('\n') + '\n', 'utf8');
    console.log(`Created .env with ${defaults.join(', ')}`);
  }

  console.log('\nDone. Run: npm run build:app');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
