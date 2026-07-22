const { app, BrowserWindow, session, shell, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const fsp = require('fs/promises');
const { randomUUID } = require('crypto');
const express = require('express');
const cors = require('cors');
const { exec: cpExec, spawn, execSync } = require('child_process');
const { promisify } = require('util');
const dotenv = require('dotenv');
const OpenAI = require('openai');

// Packaged: ship beside app.asar via extraResources (path.join from inside asar can escape to resources\ and break require).
const _desktopRbHelperPath = app.isPackaged
  ? path.join(process.resourcesPath, 'desktop-rb-helper.cjs')
  : path.join(__dirname, '..', '..', 'desktop-rb-helper.cjs');
const { readDesktopRbBase64Sync } = require(_desktopRbHelperPath);

function getEnvPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.resolve(__dirname, '../../.env');
}
const envPath = getEnvPath();
dotenv.config({ path: envPath });

/** Launch directly into the standalone Agent window (used by the "Butler Agent" exe). */
const AGENT_ONLY = process.argv.includes('--agent-only');

/** Mirror `ui-server.js` POST /chat wait budget — local LM + enrichment uses several hops. */
function getButlerChatAbortMs() {
  const raw = String(process.env.BUTLER_UI_CHAT_TIMEOUT_MS || '').trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n >= 45_000) return Math.min(n, 7_200_000);
  return 840_000;
}

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readButlerLocalOnlyFromConfig() {
  try {
    const cfgPath = getConfigPath();
    if (cfgPath && fs.existsSync(cfgPath)) {
      const data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return !!data.local_only;
    }
  } catch (_) {}
  return false;
}

function readOpenAIKey() {
  if (readButlerLocalOnlyFromConfig()) return '';
  try {
    const cfgPath = getConfigPath();
    let fromConfig = '';
    if (fs.existsSync(cfgPath)) {
      const data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (data.local_only) return '';
      fromConfig = (data.openai_api_key || '').trim();
    }
    if (fromConfig) return fromConfig;
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const m = content.match(/OPENAI_API_KEY\s*=\s*(.+)/m);
      const fromEnvFile = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
      if (fromEnvFile) return fromEnvFile;
    }
    return String(process.env.OPENAI_API_KEY || '').trim();
  } catch (_) {
    return String(process.env.OPENAI_API_KEY || '').trim();
  }
}

async function aiAutoStructureResumeHtml({ html }) {
  const key = readOpenAIKey();
  if (!key) {
    const err = new Error('OpenAI API key not configured');
    err.statusCode = 409;
    throw err;
  }
  const raw = String(html || '').trim();
  if (!raw) {
    const err = new Error('html required');
    err.statusCode = 400;
    throw err;
  }
  const capped = raw.length > 60_000 ? raw.slice(0, 60_000) : raw;

  const client = new OpenAI({ apiKey: key });
  const system = [
    'You are a resume formatter.',
    'Convert the user HTML into a clean, template-friendly HTML fragment for Word/PDF export.',
    'Output MUST be strict JSON: {\"html\": \"<...>\"} with no markdown fences.',
    'Allowed tags ONLY: h1,h2,h3,p,ul,ol,li,blockquote,hr,br.',
    'Use <h1> for the candidate name (exactly one).',
    'Use <h2> for section headings (Experience, Skills, Education, Projects, Certifications, Links, Summary).',
    'Convert bullet-like lines into <ul><li>…</li></ul>.',
    'Remove decorative characters, excessive whitespace, and duplicate headings.',
    'If a section should start on a new page (e.g. Education on long resumes), insert <hr data-pagebreak=\"1\" /> immediately before that <h2>.',
    'Do NOT invent content. Preserve all factual details.',
  ].join('\\n');
  const user = `INPUT_HTML:\\n${capped}`;

  const resp = await client.responses.create({
    model: 'gpt-4o-mini',
    input: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    max_output_tokens: 1600,
  });
  const text = String(resp.output_text || '').trim();
  let out;
  try {
    out = JSON.parse(text);
  } catch (_) {
    const m = text.match(/\\{[\\s\\S]*\\}$/);
    out = m ? JSON.parse(m[0]) : null;
  }
  const htmlOut = String(out && out.html ? out.html : '').trim();
  if (!htmlOut) throw new Error('AI did not return html');
  return htmlOut;
}

/** When Knowledge returns ok + `path` but omits base64, read file so chat + session gallery get data. */
const MAX_SD_EMBED_BYTES = 80 * 1024 * 1024;
function fillSdPayloadFromDisk(sd) {
  if (!sd || typeof sd !== 'object') return;
  const p = typeof sd.path === 'string' ? sd.path.trim() : '';
  if (!p || !fs.existsSync(p)) return;
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return;
  }
  if (!st.isFile() || st.size > MAX_SD_EMBED_BYTES) return;
  const low = p.toLowerCase();
  const imgs = Array.isArray(sd.images) ? sd.images : [];
  const hasImg = imgs.some((x) => typeof x === 'string' && x.length > 80);
  if (!hasImg && /\.(png|jpe?g|webp|gif)$/i.test(low)) {
    try {
      sd.images = [fs.readFileSync(p).toString('base64')];
    } catch (_) {}
    return;
  }
  const vid = typeof sd.video === 'string' ? sd.video.trim() : '';
  if (!vid && /\.(webm|mp4|mov|mkv|gif)$/i.test(low)) {
    try {
      sd.video = fs.readFileSync(p).toString('base64');
    } catch (_) {}
  }
}

function getDefaultButlorRoot() {
  if (process.platform === 'win32') return path.resolve('D:\\butlor');
  return path.join(os.homedir(), 'Documents', 'Butlor');
}

function getButlorConfigDirAbs() {
  const raw = String(process.env.BUTLOR_CONFIG || '').trim();
  return path.resolve(raw || getDefaultButlorRoot());
}

/** One-time warning when AI file actions are allowed to touch any path. */
let warnedButlerAnyPath = false;

function readButlerDevPathsFromConfig() {
  try {
    const cfgPath = getConfigPath();
    if (!fs.existsSync(cfgPath)) return { globalRoot: '', trustedRoots: [], allowAnyPath: false };
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const globalRoot = String(cfg.butler_global_project_root || '').trim();
    const tr = cfg.butler_trusted_roots;
    const trustedRoots = Array.isArray(tr)
      ? tr.map((s) => String(s).trim()).filter(Boolean)
      : typeof tr === 'string'
        ? tr.split(/[;\n|]+/).map((s) => s.trim()).filter(Boolean)
        : [];
    return { globalRoot, trustedRoots, allowAnyPath: !!cfg.butler_allow_any_path };
  } catch (_) {
    return { globalRoot: '', trustedRoots: [], allowAnyPath: false };
  }
}

/** Unrestricted paths: env wins; else Settings → full disk access. */
function isButlerAllowAnyPath() {
  if (process.env.BUTLER_ALLOW_ANY_PATH === '1') return true;
  try {
    return !!readButlerDevPathsFromConfig().allowAnyPath;
  } catch (_) {
    return false;
  }
}

function getEffectiveTrustedRoots() {
  const seen = new Set();
  const out = [];
  const pushRoot = (p) => {
    try {
      const r = path.resolve(p);
      const k = r.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(r);
      }
    } catch (_) {}
  };
  try {
    pushRoot(getDefaultButlorRoot());
  } catch (_) {}
  const env = String(process.env.BUTLER_TRUSTED_ROOTS || '')
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const { trustedRoots: cfgRoots } = readButlerDevPathsFromConfig();
  for (const p of [...env, ...cfgRoots]) {
    pushRoot(p);
  }
  return out;
}

function getEffectiveGlobalProjectRoot() {
  const env = String(process.env.BUTLER_GLOBAL_PROJECT_ROOT || '').trim();
  if (env) return path.resolve(env);
  const { globalRoot } = readButlerDevPathsFromConfig();
  return globalRoot ? path.resolve(globalRoot) : '';
}

/** Shown to the local model so it knows which directories actions may use. */
function buildButlerFilePolicyForModel() {
  const parts = [];
  const g = getEffectiveGlobalProjectRoot();
  if (g) parts.push('project_root is GLOBAL for all chats: ' + g);
  const tr = getEffectiveTrustedRoots();
  if (tr.length) parts.push('TRUSTED_ROOTS (writes and cwd allowed): ' + tr.join('; '));
  if (isButlerAllowAnyPath()) {
    parts.push(
      'FULL DISK ACCESS is ON — write_file, download_file, run_command cwd may use any path. Use responsibly.',
    );
  }
  parts.push(
    'AUTOMATION: Use mode actions aggressively—write_file, download_file, run_command (npm, node, npx, python, git, pip, etc.). For long-running dev servers (vite, "npm run dev", "npm start", nodemon) use run_command with "background": true so the host does not block. Then open_url with http://localhost:PORT so the user can use the app in a browser.',
  );
  parts.push(
    'BUILD REQUESTS: If they ask to build, create, or implement an app (calendar, todo, landing page, etc.), you MUST return mode actions with write_file for each file—do not answer with chat-only "Step 1: create a folder" or paste-for-the-user tutorials; this host applies actions on disk.',
  );
  parts.push(
    'NATURAL LANGUAGE: Users may typo or speak casually ("claendar", "put it in myapp"). Infer intent; use actions. When they name a folder, put files under that name relative to project_root (e.g. myapp/index.html). Act with a sensible default path rather than demanding exact phrasing.',
  );
  parts.push(
    'CURSOR CLI (Code tab): If the user enabled Cursor Agent CLI in the Code workspace, run_command should use their configured agent executable; cwd should be project_root aligned with the same folder they open in Cursor. CLI runs in the shell only—not inside a Cursor IDE chat thread.',
  );
  const devPathsConfigured =
    !!getEffectiveGlobalProjectRoot() || getEffectiveTrustedRoots().length > 0 || isButlerAllowAnyPath();
  if (devPathsConfigured) {
    parts.push(
      'SELF-REBUILD: To rebuild Butler from this source tree, use run_command. If project_root is the repo root (folder containing `ui/` and `knowledge/`), cwd `ui` and command `npm run build:app`. Same from repo root with cwd `.` and command `npm run rebuild-butler` (root package.json). If project_root is already the `ui` folder, cwd `.` and `npm run build:app`. Output: ui/dist-app-new (Windows unpacked app). The running instance cannot hot-swap its own exe—tell the user to quit Butler and launch the new build (or run `npm run dev:app` from ui for dev).',
    );
  }
  return parts.join('\n');
}

const exec = promisify(cpExec);

/** Prefer bundled python-embed in dev (has SpeechRecognition); packaged build always uses resources copy. */
function resolvePythonForStt() {
  if (app.isPackaged && process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'python-embed', 'python.exe');
    if (fs.existsSync(p)) return p;
  }
  const devEmbed = path.join(__dirname, '..', 'python-embed', 'python.exe');
  if (process.platform === 'win32' && fs.existsSync(devEmbed)) return devEmbed;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Dev stack (`npm run dev`) keeps these. Packaged desktop uses alternate defaults so both can run. */
const DEV_UI_API_PORT = 4001;
const DEV_KNOWLEDGE_API_PORT = 8765;
const DEV_COMFY_PORT = 8188;
const DESKTOP_UI_API_PORT = 4011;
const DESKTOP_KNOWLEDGE_API_PORT = 8775;
/** Packaged desktop ComfyUI — same install as dev, different listen port + temp/input roots. */
const DESKTOP_COMFY_PORT = 8198;
const DEV_COMFYUI_URL = 'http://127.0.0.1:' + DEV_COMFY_PORT;
const DESKTOP_COMFYUI_URL = 'http://127.0.0.1:' + DESKTOP_COMFY_PORT;

function parsePortEnv(names, fallback) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const raw = String(process.env[name] || '').trim();
    const n = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(n) && n >= 1 && n <= 65535) return n;
  }
  return fallback;
}

function knowledgePortFromUrlEnv() {
  const raw = String(process.env.KNOWLEDGE_API_URL || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const p = u.port || (u.protocol === 'https:' ? '443' : '80');
    const n = parseInt(p, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 65535) return n;
  } catch (_) {}
  return null;
}

function resolveInitialUiApiPort() {
  return parsePortEnv(
    ['BUTLER_UI_API_PORT', 'BUTLER_API_PORT'],
    app.isPackaged ? DESKTOP_UI_API_PORT : DEV_UI_API_PORT,
  );
}

function resolveInitialKnowledgePort() {
  const fromNamed = parsePortEnv(['KNOWLEDGE_API_PORT', 'BUTLER_KNOWLEDGE_PORT'], null);
  if (fromNamed != null) return fromNamed;
  const fromUrl = knowledgePortFromUrlEnv();
  if (app.isPackaged) {
    // Shared repo .env often still says :8765; packaged desktop must not collide with npm run dev.
    if (fromUrl != null && fromUrl !== DEV_KNOWLEDGE_API_PORT) return fromUrl;
    return DESKTOP_KNOWLEDGE_API_PORT;
  }
  return fromUrl != null ? fromUrl : DEV_KNOWLEDGE_API_PORT;
}

let API_PORT = resolveInitialUiApiPort();
let KNOWLEDGE_API_PORT = resolveInitialKnowledgePort();
const AI_SERVER_PORT = 5000;
let knowledgeApiProcess = null;
let aiServerProcess = null;
let comfyProcess = null;

function parseComfyPortFromUrl(raw, fallback) {
  const fb = fallback != null ? fallback : DEV_COMFY_PORT;
  try {
    const s = String(raw || '').trim().replace(/\/$/, '');
    if (!s) return fb;
    const u = new URL(s.includes('://') ? s : 'http://' + s);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch (_) {
    return fb;
  }
}

/**
 * Packaged desktop defaults to :8198 so it can run beside npm-run-dev Comfy on :8188.
 * Shared repo .env that still says 8188 is treated as "unset" when packaged (same idea as Knowledge 8765).
 */
function resolveComfyUiUrl() {
  const fromEnv = String(process.env.COMFYUI_URL || '').trim().replace(/\/$/, '');
  if (app.isPackaged) {
    if (fromEnv) {
      const port = parseComfyPortFromUrl(fromEnv, null);
      if (port != null && port !== DEV_COMFY_PORT) return fromEnv;
    }
    return DESKTOP_COMFYUI_URL;
  }
  return fromEnv || DEV_COMFYUI_URL;
}

function getComfyUiUrl() {
  return resolveComfyUiUrl();
}

function getComfyListenPort() {
  return parseComfyPortFromUrl(getComfyUiUrl(), app.isPackaged ? DESKTOP_COMFY_PORT : DEV_COMFY_PORT);
}

/** Separate temp/input/output under %TEMP% so desktop + dev Comfy do not share preview/upload dirs. */
function getDesktopComfyTempRoot() {
  const override = String(process.env.BUTLER_COMFY_TEMP_ROOT || '').trim();
  if (override) return path.resolve(override);
  return path.join(os.tmpdir(), 'butler-comfyui-desktop');
}

function syncRuntimePortEnv() {
  process.env.BUTLER_UI_API_PORT = String(API_PORT);
  process.env.KNOWLEDGE_API_PORT = String(KNOWLEDGE_API_PORT);
  process.env.KNOWLEDGE_API_URL = 'http://127.0.0.1:' + KNOWLEDGE_API_PORT;
  process.env.COMFYUI_URL = getComfyUiUrl();
  process.env.USE_COMFYUI = String(process.env.USE_COMFYUI || '1');
  if (app.isPackaged) {
    const tempRoot = getDesktopComfyTempRoot();
    process.env.BUTLER_COMFY_TEMP_ROOT = tempRoot;
    process.env.BUTLER_COMFY_INPUT_DIR = path.join(tempRoot, 'input');
    process.env.COMFYUI_INPUT_DIR = process.env.BUTLER_COMFY_INPUT_DIR;
    process.env.BUTLER_COMFY_OUTPUT_DIR = path.join(tempRoot, 'output');
  }
}

function probeTcpPortInUse(port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(v);
    };
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => {
      try {
        s.destroy();
      } catch (_) {}
      finish(true);
    });
    s.on('error', () => finish(false));
    const t = setTimeout(() => {
      try {
        s.destroy();
      } catch (_) {}
      finish(false);
    }, 800);
  });
}

/** Prefer `preferred`; if busy, try preferred+step, … (packaged dual-run / stray listeners). */
async function resolveFreeListenPort(preferred, { attempts = 8, step = 10 } = {}) {
  const base = Number(preferred) || 0;
  if (!base) return preferred;
  for (let i = 0; i < attempts; i++) {
    const port = base + i * step;
    if (port > 65535) break;
    if (!(await probeTcpPortInUse(port))) return port;
  }
  return base;
}

async function prepareRuntimePorts() {
  if (app.isPackaged) {
    API_PORT = await resolveFreeListenPort(API_PORT);
    KNOWLEDGE_API_PORT = await resolveFreeListenPort(KNOWLEDGE_API_PORT);
  }
  syncRuntimePortEnv();
  if (app.isPackaged) {
    console.log(
      '[Butler] Desktop ports — UI API http://127.0.0.1:' +
        API_PORT +
        ' · Knowledge http://127.0.0.1:' +
        KNOWLEDGE_API_PORT,
    );
  }
}

/** Child ui-server.js we spawned in dev so /api works without a separate terminal (e.g. network monitor). */
let devUiServerChild = null;

async function probeButlerHealthMain() {
  try {
    const r = await fetch('http://127.0.0.1:' + API_PORT + '/api/health', {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return j && j.ok === true && (j.service === 'butler-ui-server' || j.service === 'butler-electron');
  } catch {
    return false;
  }
}

function probePort4001Main() {
  return probeTcpPortInUse(API_PORT);
}

/**
 * Dev: Vite (5173) calls /api on 4001. If nothing responds with Butler /api/health, spawn ui-server.js from the repo root.
 * Packaged builds use the internal API only — not used when app.isPackaged.
 */
async function ensureDevButlerApi() {
  if (app.isPackaged) return;
  let ok = false;
  for (let i = 0; i < 15; i++) {
    ok = await probeButlerHealthMain();
    if (ok) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  const repoRoot = path.join(__dirname, '..', '..');
  const uiServerJs = path.join(repoRoot, 'ui-server.js');
  if (!fs.existsSync(uiServerJs)) {
    console.warn('[Butler dev] ui-server.js not found at ' + uiServerJs);
    return;
  }
  const portBusy = await probePort4001Main();
  if (portBusy) {
    console.warn(
      '[Butler dev] Port ' +
        API_PORT +
        ' is in use but Butler GET /api/health did not respond. Another app may own this port.',
    );
    return;
  }
  console.log('[Butler dev] Starting ui-server.js on port ' + API_PORT + ' (network monitor & /api need this).');
  devUiServerChild = spawn(process.execPath, [uiServerJs], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  devUiServerChild.on('exit', () => {
    devUiServerChild = null;
  });
  for (let i = 0; i < 60; i++) {
    if (await probeButlerHealthMain()) {
      console.log('[Butler dev] Butler API is ready on port ' + API_PORT + '.');
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn('[Butler dev] Timed out waiting for ui-server.js.');
}

/** Python Flask api_server.py — origin only; not Butler Node (4001). */
function normalizeKnowledgeApiBaseUrl(raw, logPrefix) {
  const pre = logPrefix || '';
  const fallback = 'http://127.0.0.1:' + KNOWLEDGE_API_PORT;
  const s = String(raw || '').trim();
  if (!s) return fallback;
  let u;
  try {
    u = new URL(s);
  } catch {
    console.warn(pre + 'Invalid KNOWLEDGE_API_URL; using ' + fallback);
    return fallback;
  }
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (port === String(API_PORT)) {
    console.warn(
      pre +
        'KNOWLEDGE_API_URL uses port ' +
        API_PORT +
        ' (Butler API). Use Python api_server.py on port ' +
        KNOWLEDGE_API_PORT +
        ' — using ' +
        fallback,
    );
    return fallback;
  }
  if (u.pathname && u.pathname !== '/') {
    console.warn(pre + 'KNOWLEDGE_API_URL had a path (' + u.pathname + '); using origin only: ' + u.origin);
  }
  return u.origin;
}

/** Main UI window (for forwarding Butler float state / dock events). */
let mainWindow = null;
/** Frameless always-on-top Butler face window. */
let butlerFloatWindow = null;
let butlerAgentWindow = null;

const sessions = new Map();
const projectsRoot =
  process.env.CODE_HELPER_PROJECTS_ROOT || path.resolve(__dirname, '../../projects/ui');

async function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    await fsp.mkdir(dirPath, { recursive: true });
  }
}

async function ensureProjectRoot(sessionId) {
  const globalRoot = getEffectiveGlobalProjectRoot();
  if (globalRoot) {
    await ensureDir(globalRoot);
    return globalRoot;
  }
  await ensureDir(projectsRoot);
  const projectRoot = path.join(projectsRoot, sessionId);
  await ensureDir(projectRoot);
  return projectRoot;
}

async function resolveAgentProjectRoot(sessionId, cwd) {
  const explicit = String(cwd || '').trim();
  if (explicit) {
    try {
      const resolved = path.resolve(explicit);
      await ensureDir(resolved);
      return resolved;
    } catch (_) {
      /* fall through */
    }
  }
  return ensureProjectRoot(String(sessionId || 'butler-agent'));
}

async function collectFiles(rootDir, { maxFiles = 30, maxBytesPerFile = 4000 } = {}) {
  const results = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full);
      if (
        rel.startsWith('.git') ||
        rel.startsWith('node_modules') ||
        rel.startsWith('dist') ||
        rel.startsWith('build')
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        try {
          const content = await fsp.readFile(full, 'utf8');
          results.push({ path: rel.replace(/\\/g, '/'), snippet: content.slice(0, maxBytesPerFile) });
        } catch {
          // skip binary files
        }
      }
    }
  }
  await walk(rootDir);
  return results;
}

async function runShell(command, cwd) {
  try {
    const { stdout, stderr } = await exec(command, {
      cwd,
      windowsHide: true,
      // electron-builder / vite logs can be large when Butler rebuilds itself
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    return {
      ok: false,
      message: err?.message || String(err),
      stdout: err?.stdout || '',
      stderr: err?.stderr || '',
    };
  }
}

/** Fire-and-forget shell (dev servers). Does not wait for exit. */
function runShellBackground(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('spawn', () => {
      try {
        child.unref();
      } catch (_) {}
      resolve({ ok: true, pid: child.pid });
    });
  });
}

function getKnowledgeDbPath() {
  return path.join(app.getPath('userData'), 'knowledge_db');
}

/** Bundled ai_server.py only when BUTLOR_AI_URL targets its default :5000 (skip for Ollama/LM Studio). */
function shouldStartBundledAiServer() {
  const raw = String(process.env.BUTLOR_AI_URL || process.env.PEEPEEDEE_AI_URL || '').trim();
  if (!raw) return true;
  const hp = parseLlmHostPortElectron(raw);
  return Number(hp.port) === 5000;
}

function startAiServer() {
  try {
    if (aiServerProcess) return;
    if (!shouldStartBundledAiServer()) return;
    const knowledgeDir = app.isPackaged
      ? (process.resourcesPath ? path.join(process.resourcesPath, 'knowledge') : null)
      : path.join(__dirname, '../../knowledge');
    if (!knowledgeDir || !fs.existsSync(knowledgeDir)) return;
    const aiServerPy = path.join(knowledgeDir, 'ai_server.py');
    if (!fs.existsSync(aiServerPy)) return;
    let python;
    let pythonArgs = [aiServerPy];
    if (app.isPackaged) {
      python = path.join(process.resourcesPath, 'python-embed', 'python.exe');
    } else if (process.platform === 'win32') {
      const pyLauncher = path.join(process.env.SystemRoot || 'C:\\Windows', 'py.exe');
      if (fs.existsSync(pyLauncher)) {
        python = pyLauncher;
        pythonArgs = ['-3', aiServerPy];
      } else {
        python = 'python';
      }
    } else {
      python = 'python3';
    }
    const dbPath = getKnowledgeDbPath();
    const envPath = getEnvPath();
    const openaiKey = readOpenAIKey();
    const spawnEnv = {
      ...process.env,
      KNOWLEDGE_DB_PATH: dbPath,
      BUTLOR_ENV_FILE: envPath,
      OPENAI_API_KEY: openaiKey,
    };
    aiServerProcess = spawn(python, pythonArgs, {
      cwd: knowledgeDir,
      env: spawnEnv,
      stdio: 'ignore',
      windowsHide: true,
    });
    aiServerProcess.on('error', () => { aiServerProcess = null; });
    aiServerProcess.on('exit', () => { aiServerProcess = null; });
  } catch (_) {
    aiServerProcess = null;
  }
}

function comfyMainPyExists(sdPath) {
  return !!(sdPath && fs.existsSync(path.join(sdPath, 'ComfyUI', 'main.py')));
}

/** Unpackaged: repo sd/. Packaged: optional resources/sd junction (only if Comfy is actually there). */
function getDefaultButlerSdPath() {
  if (app.isPackaged && process.resourcesPath) {
    return path.join(process.resourcesPath, 'sd');
  }
  return path.resolve(__dirname, '../../sd');
}

/**
 * Packaged Electron does not ship multi-GB ComfyUI under resources/sd.
 * Walk from the exe / resources up to the Butler checkout (or any parent) that has sd/ComfyUI/main.py.
 */
function findSdNearPackagedApp() {
  const seeds = [];
  if (process.resourcesPath) {
    seeds.push(process.resourcesPath);
    seeds.push(path.dirname(process.resourcesPath));
  }
  try {
    seeds.push(path.dirname(app.getPath('exe')));
  } catch (_) {}
  const seen = new Set();
  for (const seed of seeds) {
    let cur = path.resolve(seed);
    for (let i = 0; i < 10; i++) {
      if (!cur || seen.has(cur)) break;
      seen.add(cur);
      const candidate = path.join(cur, 'sd');
      if (comfyMainPyExists(candidate)) return path.resolve(candidate);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

/** Resolve SD_PROJECT_PATH (absolute or relative) to a folder that preferably contains ComfyUI. */
function resolveSdPathValue(raw) {
  const trimmed = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return '';
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  const bases = [];
  if (!app.isPackaged) bases.push(path.resolve(__dirname, '../..'));
  if (process.resourcesPath) {
    bases.push(process.resourcesPath);
    bases.push(path.dirname(process.resourcesPath));
  }
  try {
    bases.push(path.dirname(app.getPath('exe')));
  } catch (_) {}
  for (const base of bases) {
    const resolved = path.resolve(base, trimmed);
    if (comfyMainPyExists(resolved)) return resolved;
  }
  for (const base of bases) {
    let cur = path.resolve(base);
    for (let i = 0; i < 10; i++) {
      const resolved = path.resolve(cur, trimmed);
      if (comfyMainPyExists(resolved)) return resolved;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return path.resolve(bases[0] || process.cwd(), trimmed);
}

function getSdProjectPath() {
  let sdPath = (process.env.SD_PROJECT_PATH || '').trim();
  const pathsToTry = [envPath];
  if (app.isPackaged) {
    pathsToTry.push(path.join(process.resourcesPath, '.env'));
    try {
      pathsToTry.push(path.join(path.dirname(app.getPath('exe')), 'resources', '.env'));
    } catch (_) {}
  }
  for (const p of pathsToTry) {
    if (sdPath) break;
    if (fs.existsSync(p)) {
      try {
        const envContent = fs.readFileSync(p, 'utf8');
        const m = envContent.match(/^\s*SD_PROJECT_PATH\s*=\s*(.+)$/m);
        sdPath = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
      } catch (_) {}
    }
  }
  if (sdPath) {
    const resolved = resolveSdPathValue(sdPath);
    if (comfyMainPyExists(resolved) || fs.existsSync(resolved)) return resolved;
  }
  const primary = getDefaultButlerSdPath();
  if (comfyMainPyExists(primary)) return path.resolve(primary);
  if (app.isPackaged) {
    const near = findSdNearPackagedApp();
    if (near) return near;
  }
  if (fs.existsSync(primary)) return path.resolve(primary);
  const legacy = 'D:\\SD';
  if (comfyMainPyExists(legacy) || fs.existsSync(legacy)) return legacy;
  const commonButler = 'D:\\BUTLER\\sd';
  if (comfyMainPyExists(commonButler)) return commonButler;
  return path.resolve(primary);
}

function parseLlmHostPortElectron(raw) {
  const s = String(raw || '').trim();
  if (!s) return { host: '127.0.0.1', port: 5000 };
  try {
    const u = new URL(s.includes('://') ? s : 'http://' + s);
    const host = u.hostname || '127.0.0.1';
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    return { host, port };
  } catch (_) {
    return { host: '127.0.0.1', port: 5000 };
  }
}

function probeTcpElectron(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port }, () => {
      sock.destroy();
      resolve({ ok: true, detail: 'TCP ' + host + ':' + port + ' open' });
    });
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ ok: false, detail: 'Connection timed out' });
    });
    sock.on('error', (err) => {
      resolve({ ok: false, detail: String(err && err.message ? err.message : err).slice(0, 160) });
    });
  });
}

async function probeHttpGetElectron(url, timeoutMs) {
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 401 || r.status === 403 || r.status === 405) {
      return { ok: true, detail: 'HTTP ' + r.status + ' (reachable)' };
    }
    if (!r.ok) return { ok: false, detail: 'HTTP ' + r.status };
    return { ok: true, detail: 'HTTP ' + r.status };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e).slice(0, 180) };
  }
}

async function probeComfyFromHostElectron(comfyBase) {
  const b = comfyBase.replace(/\/$/, '');
  let last = { ok: false, detail: '' };
  for (const p of ['/system_stats', '/']) {
    last = await probeHttpGetElectron(b + p, 3500);
    if (last.ok) return { ok: true, detail: last.detail + ' @ ' + p };
  }
  return last;
}

/** Full service list + local probes when Knowledge GET /status fails (timeout, connection refused, etc.). */
async function buildElectronStatusFallback(localAiUrl, errorMessage) {
  const services = [];
  services.push({
    id: 'knowledge_api',
    label: 'Knowledge API',
    ok: false,
    url: localAiUrl,
    detail: errorMessage || 'Unreachable',
  });

  const comfyOff = ['0', 'false', 'no', 'off'].includes(String(process.env.USE_COMFYUI || '1').trim().toLowerCase());
  const comfyUrl = getComfyUiUrl();
  if (comfyOff) {
    services.push({
      id: 'comfyui',
      label: 'ComfyUI',
      ok: null,
      url: comfyUrl,
      detail: 'USE_COMFYUI disabled',
      skipped: true,
    });
  } else {
    const c = await probeComfyFromHostElectron(comfyUrl);
    services.push({
      id: 'comfyui',
      label: 'ComfyUI (images / video)',
      ok: c.ok,
      url: comfyUrl,
      detail: c.detail,
    });
  }

  const llmRaw = String(
    process.env.BUTLOR_AI_URL || process.env.PEEPEEDEE_AI_URL || 'http://localhost:5000',
  ).trim();
  const hp = parseLlmHostPortElectron(llmRaw);
  const llmTcp = await probeTcpElectron(hp.host, hp.port, 2000);
  services.push({
    id: 'local_llm',
    label: 'Local LLM',
    ok: llmTcp.ok,
    url: llmRaw,
    model: String(process.env.LOCAL_MODEL || 'pepee'),
    detail: llmTcp.detail + (llmTcp.ok ? ' — expects POST /chat' : ''),
  });

  const forgeBase = String(process.env.SD_API_URL || 'http://127.0.0.1:7860')
    .trim()
    .replace(/\/$/, '');
  const fr = await probeHttpGetElectron(forgeBase + '/sdapi/v1/sd-models', 3000);
  services.push({
    id: 'forge_api',
    label: 'Forge / Automatic1111 API',
    ok: fr.ok,
    url: forgeBase,
    detail: fr.detail,
  });

  const sdPath = getSdProjectPath();
  services.push({
    id: 'sd_project',
    label: 'SD project path',
    ok: comfyMainPyExists(sdPath),
    detail: sdPath + (comfyMainPyExists(sdPath) ? '' : ' (ComfyUI/main.py missing — set SD_PROJECT_PATH)'),
  });

  const key = readOpenAIKey();
  services.push({
    id: 'openai_key',
    label: 'OpenAI API key (structured intent)',
    ok: !!key,
    detail: key ? 'Configured (Butler Settings)' : 'Optional — improves routing when local model is weak',
  });

  let tsharkDetail = 'Not checked';
  let tsharkOk = false;
  try {
    const nmPath = path.join(__dirname, app.isPackaged ? '..' : '../..', 'network-monitor.mjs');
    if (fs.existsSync(nmPath)) {
      const { pathToFileURL } = require('url');
      const nm = await import(pathToFileURL(nmPath).href);
      const p = await nm.probeTsharkForStatusRow();
      tsharkOk = !!p.ok;
      tsharkDetail = p.detail || 'Unavailable';
    } else {
      tsharkDetail = 'network-monitor.mjs missing from app files — reinstall or run from dev checkout';
    }
  } catch (e) {
    tsharkDetail = String(e?.message || e).slice(0, 220);
  }
  services.push({
    id: 'network_monitor',
    label: 'Network monitor (tshark / Wireshark CLI)',
    ok: tsharkOk,
    detail: tsharkDetail,
  });

  services.push({
    id: 'agent',
    label: 'Butler agent (JSON chat)',
    ok: null,
    detail: 'Start Knowledge API for Python import / routing status',
  });

  services.push({
    id: 'chroma',
    label: 'Knowledge memory (Chroma)',
    ok: null,
    detail: 'Start Knowledge API for memory store stats',
  });

  return {
    generated_at: new Date().toISOString(),
    error: errorMessage,
    status_note:
      'Knowledge API unreachable — rows below still reflect local checks (Comfy, LLM port, Forge). Start the API for Chroma/agent details from Python.',
    services,
  };
}

const STATUS_SERVICE_ORDER = [
  'knowledge_api',
  'comfyui',
  'local_llm',
  'forge_api',
  'sd_project',
  'openai_key',
  'network_monitor',
  'agent',
  'chroma',
];

function mergeStatusServicesElectron(localServices, apiServices) {
  var byLocal = new Map((localServices || []).map(function (s) { return [s.id, s]; }));
  var byApi = new Map((apiServices || []).map(function (s) { return [s.id, s]; }));
  var out = [];
  var seen = new Set();
  var expectedComfy = getComfyUiUrl();
  for (var i = 0; i < STATUS_SERVICE_ORDER.length; i++) {
    var id = STATUS_SERVICE_ORDER[i];
    var loc = byLocal.get(id);
    var api = byApi.get(id);
    if (!loc && !api) continue;
    if (id === 'comfyui' && loc) {
      // Always show this app's Comfy URL (8198 packaged / 8188 dev). Trust the Electron host
      // probe for ok — never promote a stale Knowledge "ok" while the host probe failed.
      var apiUrl = (api && api.url) || '';
      var detailComfy = loc.detail || (api && api.detail) || '';
      if (loc.ok !== true && api && api.detail && String(api.detail).trim()) {
        detailComfy = (loc.detail ? loc.detail + ' — ' : '') + 'Knowledge: ' + api.detail;
      }
      var mergedComfy = Object.assign({}, api || {}, loc, {
        url: expectedComfy || loc.url || apiUrl || '',
        ok: loc.ok,
        detail: detailComfy,
        label: app.isPackaged
          ? 'ComfyUI · desktop port ' + DESKTOP_COMFY_PORT
          : loc.label || (api && api.label) || 'ComfyUI (images / video)',
      });
      out.push(mergedComfy);
    } else {
      out.push(api && loc ? Object.assign({}, loc, api) : api || loc);
    }
    seen.add(id);
  }
  var list = apiServices || [];
  for (var j = 0; j < list.length; j++) {
    var s = list[j];
    if (s && s.id && !seen.has(s.id)) {
      out.push(s);
      seen.add(s.id);
    }
  }
  return out;
}

/**
 * Spawn ComfyUI main.py. Prefer ComfyUI's venv (absolute path) so it works when Butler is started from Explorer
 * (no `python` on PATH). Then Windows py.exe, then shell `py -3`, then python3.
 * Packaged desktop: --port 8198 + separate temp/input (same Comfy tree as dev on 8188).
 */
function buildComfyLaunchArgs() {
  const args = ['main.py'];
  const port = getComfyListenPort();
  args.push('--port', String(port));

  const extraRaw = String(process.env.COMFYUI_EXTRA_ARGS || '').trim();
  const extraArgs = extraRaw ? extraRaw.split(/\s+/).filter(Boolean) : [];

  if (app.isPackaged) {
    const tempRoot = getDesktopComfyTempRoot();
    try {
      fs.mkdirSync(path.join(tempRoot, 'temp'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, 'input'), { recursive: true });
      fs.mkdirSync(path.join(tempRoot, 'output'), { recursive: true });
    } catch (_) {}
    // Separate dirs avoid collisions with dev Comfy on 8188.
    // Do NOT use --lowvram + --disable-smart-memory here: on Windows that combo forces a
    // hard UNet→CPU unload when VAEDecode loads AutoencoderKL, and torch can AV
    // (null deref / "python.exe - Application Error") after sampling finishes.
    // 12GB (e.g. RTX 4070) runs SDXL FaceID in normal VRAM. Match ui-server defaults + fp16 VAE.
    // Override/add with COMFYUI_EXTRA_ARGS (e.g. "--lowvram --disable-smart-memory") for Wan.
    args.push(
      '--temp-directory',
      tempRoot,
      '--input-directory',
      path.join(tempRoot, 'input'),
      '--output-directory',
      path.join(tempRoot, 'output'),
    );
    if (extraArgs.length) {
      args.push(...extraArgs);
    } else {
      args.push(
        '--normalvram',
        '--fp32-vae',
        '--disable-cuda-malloc',
        '--disable-pinned-memory',
      );
    }
  } else if (extraArgs.length) {
    args.push(...extraArgs);
  } else {
    // Dev Electron: light defaults; prefer start-comfyui-temp.bat when you need Wan lowvram.
    args.push('--disable-cuda-malloc', '--fp32-vae', '--disable-pinned-memory');
  }
  return args;
}

function spawnComfyUIChildProcess() {
  const sdPath = getSdProjectPath();
  const comfyDir = path.join(sdPath, 'ComfyUI');
  const mainPy = path.join(comfyDir, 'main.py');
  if (!sdPath || !fs.existsSync(mainPy)) {
    console.warn('[Butler] ComfyUI: main.py not found at', mainPy);
    return null;
  }
  const comfyUrl = getComfyUiUrl();
  const comfyArgs = buildComfyLaunchArgs();
  const env = {
    ...process.env,
    SD_PROJECT_PATH: sdPath,
    COMFYUI_URL: comfyUrl,
    USE_COMFYUI: '1',
  };
  if (app.isPackaged) {
    const tempRoot = getDesktopComfyTempRoot();
    env.BUTLER_COMFY_TEMP_ROOT = tempRoot;
    env.BUTLER_COMFY_INPUT_DIR = path.join(tempRoot, 'input');
    env.COMFYUI_INPUT_DIR = env.BUTLER_COMFY_INPUT_DIR;
    env.BUTLER_COMFY_OUTPUT_DIR = path.join(tempRoot, 'output');
  }
  console.log('[Butler] Starting ComfyUI on', comfyUrl, 'args=', comfyArgs.slice(1).join(' '));
  let logFd = 'ignore';
  try {
    const logPath = path.join(os.tmpdir(), 'butler-comfyui-spawn.log');
    fs.writeFileSync(
      logPath,
      '[Butler] ' +
        new Date().toISOString() +
        ' Starting ComfyUI ' +
        comfyUrl +
        ' cwd=' +
        comfyDir +
        ' args=' +
        comfyArgs.join(' ') +
        '\n',
      { flag: 'a' },
    );
    logFd = fs.openSync(logPath, 'a');
  } catch (_) {
    logFd = 'ignore';
  }
  const optsBase = {
    cwd: comfyDir,
    env,
    stdio: logFd === 'ignore' ? 'ignore' : ['ignore', logFd, logFd],
    windowsHide: false,
  };
  const venvWin = path.join(comfyDir, 'venv', 'Scripts', 'python.exe');
  const venvUnix = path.join(comfyDir, 'venv', 'bin', 'python');

  if (process.platform === 'win32' && fs.existsSync(venvWin)) {
    return spawn(venvWin, comfyArgs, optsBase);
  }
  if (process.platform !== 'win32' && fs.existsSync(venvUnix)) {
    return spawn(venvUnix, comfyArgs, optsBase);
  }
  if (process.platform === 'win32') {
    const pyLauncher = path.join(process.env.SystemRoot || 'C:\\Windows', 'py.exe');
    if (fs.existsSync(pyLauncher)) {
      return spawn(pyLauncher, ['-3', ...comfyArgs], optsBase);
    }
    return spawn('py -3 ' + comfyArgs.map((a) => '"' + a + '"').join(' '), [], { ...optsBase, shell: true });
  }
  return spawn('python3', comfyArgs, optsBase);
}

function startComfyUI(opts) {
  const force = !!(opts && opts.force);
  try {
    if (comfyProcess) return;
    const port = getComfyListenPort();
    const spawnNow = () => {
      if (comfyProcess) return;
      try {
        const child = spawnComfyUIChildProcess();
        if (!child) return;
        comfyProcess = child;
        comfyProcess.on('error', (err) => {
          console.error('[Butler] ComfyUI failed to start:', err && err.message ? err.message : err);
          comfyProcess = null;
        });
        comfyProcess.on('exit', (code, signal) => {
          if (code !== 0 && code != null) {
            console.warn('[Butler] ComfyUI exited with code', code, signal ? '(' + signal + ')' : '');
          }
          comfyProcess = null;
        });
      } catch (e) {
        console.error('[Butler] ComfyUI:', e && e.message ? e.message : e);
        comfyProcess = null;
      }
    };
    if (force) {
      spawnNow();
      return;
    }
    // If desktop/dev Comfy is already listening (prior launch or start-comfyui-*.bat), do not spawn a second instance.
    probeTcpPortInUse(port).then((busy) => {
      if (busy) {
        console.log('[Butler] ComfyUI already listening on port', port, '— skipping spawn');
        return;
      }
      spawnNow();
    });
  } catch (e) {
    console.error('[Butler] ComfyUI:', e && e.message ? e.message : e);
    comfyProcess = null;
  }
}

function startKnowledgeApi() {
  try {
    if (knowledgeApiProcess) return;
    const knowledgeDir = app.isPackaged
      ? (process.resourcesPath ? path.join(process.resourcesPath, 'knowledge') : null)
      : path.join(__dirname, '../../knowledge');
    if (!knowledgeDir || !fs.existsSync(knowledgeDir)) return;

    const dbPath = getKnowledgeDbPath();
    fs.mkdirSync(dbPath, { recursive: true });
    const envPath = getEnvPath();
    const sdPath = getSdProjectPath();
    const localOnlyCfg = readButlerLocalOnlyFromConfig();
    const env = {
      ...process.env,
      BUTLER_LOCAL_ONLY: localOnlyCfg ? '1' : '0',
      OPENAI_API_KEY: localOnlyCfg ? '' : (readOpenAIKey() || ''),
      KNOWLEDGE_DB_PATH: dbPath,
      BUTLOR_ENV_FILE: envPath,
      KNOWLEDGE_API_PORT: String(KNOWLEDGE_API_PORT),
      KNOWLEDGE_API_URL: 'http://127.0.0.1:' + KNOWLEDGE_API_PORT,
      // Always pin Comfy URL for this app instance (desktop 8198 / dev 8188).
      COMFYUI_URL: getComfyUiUrl(),
      USE_COMFYUI: String(process.env.USE_COMFYUI || '1'),
      ...(sdPath ? { SD_PROJECT_PATH: sdPath } : {}),
    };

    const apiPy = path.join(knowledgeDir, 'api_server.py');
    if (!fs.existsSync(apiPy)) return;

    const python = app.isPackaged
      ? path.join(process.resourcesPath, 'python-embed', 'python.exe')
      : (process.platform === 'win32' ? 'python' : 'python3');
    knowledgeApiProcess = spawn(python, [apiPy], {
      cwd: knowledgeDir,
      env,
      stdio: 'ignore',
      windowsHide: true,
    });
    knowledgeApiProcess.on('error', () => { knowledgeApiProcess = null; });
    knowledgeApiProcess.on('exit', () => { knowledgeApiProcess = null; });
  } catch (_) {
    knowledgeApiProcess = null;
  }
}

function killChildProc(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill();
  } catch (_) {}
}

/** Free port 8765 when a stray or external Knowledge API is still listening (dev or manual python). */
function killTcpListenersOnPort(port) {
  const p = Number(port);
  if (!p || p < 1 || p > 65535) return;
  try {
    if (process.platform === 'win32') {
      execSync(
        'powershell -NoProfile -Command "$ids = Get-NetTCPConnection -LocalPort ' +
          p +
          ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($ids) { $ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }"',
        { stdio: 'ignore', timeout: 20000, windowsHide: true },
      );
    } else {
      try {
        const out = execSync('lsof -ti:' + p, { encoding: 'utf8' });
        out
          .trim()
          .split('\n')
          .forEach(function (pid) {
            if (pid) {
              try {
                execSync('kill -9 ' + pid, { stdio: 'ignore' });
              } catch (_) {}
            }
          });
      } catch (_) {}
    }
  } catch (_) {}
}

function restartManagedComfy() {
  killChildProc(comfyProcess);
  comfyProcess = null;
  const sdPath = getSdProjectPath();
  const mainPy = path.join(sdPath, 'ComfyUI', 'main.py');
  if (!fs.existsSync(mainPy)) {
    return {
      ok: false,
      message:
        'ComfyUI not found at ' +
        mainPy +
        '. Set SD_PROJECT_PATH in App\\resources\\.env to your sd folder (e.g. D:\\BUTLER\\sd), ' +
        'or put/junction ComfyUI there. Desktop does not ship Comfy under Electron resources\\sd.',
    };
  }
  const port = getComfyListenPort();
  killTcpListenersOnPort(port);
  startComfyUI({ force: true });
  return {
    ok: true,
    message: app.isPackaged
      ? 'Starting ComfyUI on port ' + port + '… First load often takes 2–3 minutes.'
      : 'Starting ComfyUI on port ' + port + '… First load often takes 2–3 minutes.',
  };
}

function restartManagedAiServer() {
  killChildProc(aiServerProcess);
  aiServerProcess = null;
  startAiServer();
  return {
    ok: true,
    message: 'Restarted Butler’s ai_server.py (default port 5000). If you use LM Studio on the same port, run only one.',
  };
}

async function restartManagedKnowledgeApi() {
  killChildProc(knowledgeApiProcess);
  knowledgeApiProcess = null;
  killTcpListenersOnPort(KNOWLEDGE_API_PORT);
  await new Promise(function (r) {
    setTimeout(r, 700);
  });
  startKnowledgeApi();
  const up = await waitForKnowledgeApi(15000);
  return up
    ? { ok: true, message: 'Knowledge API is responding on port ' + KNOWLEDGE_API_PORT + '.' }
    : { ok: false, message: 'Knowledge API did not respond in time. Check Python logs and port ' + KNOWLEDGE_API_PORT + '.' };
}

/**
 * Resolve a write path for AI actions. Default: only under projectRoot.
 * Optional: BUTLER_TRUSTED_ROOTS (semicolon-separated), config butler_trusted_roots,
 * BUTLER_GLOBAL_PROJECT_ROOT / config butler_global_project_root (already reflected in projectRoot).
 * Nuclear: BUTLER_ALLOW_ANY_PATH=1 — any absolute/relative path (you are responsible for model output).
 */
function resolveActionPath(projectRoot, rawPath) {
  const raw = String(rawPath || '').trim();
  if (!raw) throw new Error('empty path');

  if (isButlerAllowAnyPath()) {
    if (!warnedButlerAnyPath) {
      warnedButlerAnyPath = true;
      console.warn(
        '[Butler] Full disk access ON — AI file actions and command cwd can target any folder the OS allows.',
      );
    }
    return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(path.resolve(projectRoot), raw);
  }

  const sessionRoot = path.resolve(projectRoot);
  const extraRoots = getEffectiveTrustedRoots();
  const roots = [sessionRoot, ...extraRoots];

  const candidates = [];
  if (path.isAbsolute(raw)) {
    candidates.push(path.resolve(raw));
  } else {
    const norm = raw.replace(/^([A-Za-z]:)?[\\/]+/, '');
    for (const root of roots) {
      candidates.push(path.resolve(root, norm));
    }
  }

  for (const target of candidates) {
    const resolvedTarget = path.resolve(target);
    for (const root of roots) {
      const rr = path.resolve(root);
      const rel = path.relative(rr, resolvedTarget);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return resolvedTarget;
    }
  }

  throw new Error(
    'Path not allowed (outside project sandbox). Add trusted roots or global project in Settings, or enable Full disk access there (or env BUTLER_ALLOW_ANY_PATH=1).',
  );
}

async function applyActions(projectRoot, actions = []) {
  const summary = { files: [], downloads: [], commands: [], backgroundCommands: [], openedUrls: [] };
  const list = Array.isArray(actions) ? actions : [];
  for (const action of list) {
    if (!action?.type) continue;
    if (action.type === 'write_file') {
      if (typeof action.content !== 'string') continue;
      let rawPath = String(action.path || '').trim();
      if (!rawPath) {
        rawPath = action.content.trimStart().toLowerCase().startsWith('<!') ? 'index.html' : 'file.txt';
      }
      const target = resolveActionPath(projectRoot, rawPath);
      const pr = path.resolve(projectRoot);
      const relToSession = path.relative(pr, target);
      const safeRel = relToSession.startsWith('..') ? target : relToSession;
      await ensureDir(path.dirname(target));
      await fsp.writeFile(target, action.content, 'utf8');
      summary.files.push(safeRel);
    } else if (action.type === 'download_file') {
      if (!action.url || !action.path) continue;
      const res = await fetch(String(action.url));
      if (!res.ok) throw new Error('Download failed (' + res.status + ') for ' + action.url);
      const buf = Buffer.from(await res.arrayBuffer());
      const target = resolveActionPath(projectRoot, String(action.path));
      const pr = path.resolve(projectRoot);
      const relToSession = path.relative(pr, target);
      const safeRel = relToSession.startsWith('..') ? target : relToSession;
      await ensureDir(path.dirname(target));
      await fsp.writeFile(target, buf);
      summary.downloads.push(safeRel);
    } else if (action.type === 'run_command') {
      if (!action.command) continue;
      const rawCwd = action.cwd != null && String(action.cwd).trim() !== '' ? String(action.cwd) : '.';
      let cwd;
      if (isButlerAllowAnyPath() && path.isAbsolute(rawCwd)) {
        cwd = path.resolve(rawCwd);
      } else {
        cwd = resolveActionPath(projectRoot, rawCwd);
      }
      const cmdStr = String(action.command);
      const asBackground = action.background === true || action.detached === true;
      if (asBackground) {
        const bg = await runShellBackground(cmdStr, cwd);
        summary.backgroundCommands.push({ command: cmdStr, cwd, pid: bg.pid });
      } else {
        const result = await runShell(cmdStr, cwd);
        if (!result.ok) {
          throw new Error(
            'Command failed: ' + cmdStr + '\n' + result.message + '\nSTDOUT:\n' + result.stdout + '\nSTDERR:\n' + result.stderr,
          );
        }
        summary.commands.push(cmdStr);
      }
    } else if (action.type === 'open_url') {
      const u = String(action.url || '').trim();
      if (!/^https?:\/\//i.test(u)) continue;
      await shell.openExternal(u);
      summary.openedUrls.push(u);
    }
  }
  return summary;
}

function getActionsAutonomyMaxRetries() {
  const envVal = process.env.BUTLER_ACTIONS_AUTONOMY_ROUNDS;
  const raw = envVal === undefined || envVal === null ? '' : String(envVal).trim();
  if (raw === '') return 15;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 15;
  return Math.min(n, 40);
}

function getActionsAutonomyInnerMax() {
  const envVal = process.env.BUTLER_ACTIONS_AUTONOMY_INNER;
  const raw = envVal === undefined || envVal === null ? '' : String(envVal).trim();
  if (raw === '') return 5;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(n, 12);
}

function isButlerOwnerMode() {
  const v = String(process.env.BUTLER_OWNER_MODE || '')
    .trim()
    .toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  return true;
}

function buildKnowledgeChatPayloadForActions({
  message,
  history,
  session,
  projectRoot,
  localOnly,
  openaiKey,
  codeContext,
  cursor_cli,
  hasInitImage,
  reqInitImage,
  chatAttachment,
  sampleFiles,
  moduleHint,
}) {
  const o = {
    message,
    prior_messages: Array.isArray(history) ? history : [],
    known_answers: session.answers,
    sample_files: sampleFiles,
    project_root: projectRoot,
    openai_api_key: localOnly ? '' : (openaiKey || ''),
    local_only: localOnly,
    file_policy: buildButlerFilePolicyForModel() || undefined,
    ...(codeContext.length > 0 ? { code_context: codeContext } : {}),
    ...(cursor_cli ? { cursor_cli } : {}),
    ...(hasInitImage ? { init_image: String(reqInitImage).trim() } : {}),
    ...(chatAttachment ? { attachment: chatAttachment } : {}),
  };
  if (moduleHint && String(moduleHint).trim()) o.module_hint = String(moduleHint).trim().slice(0, 200);
  return o;
}

async function runKnowledgeFollowUpOnceElectron(fixMessage, ctx) {
  const payload = buildKnowledgeChatPayloadForActions({
    message: fixMessage,
    history: ctx.history,
    session: ctx.session,
    projectRoot: ctx.projectRoot,
    localOnly: ctx.localOnly,
    openaiKey: ctx.openaiKey,
    codeContext: ctx.codeContext,
    cursor_cli: ctx.cursor_cli,
    hasInitImage: ctx.hasInitImage,
    reqInitImage: ctx.reqInitImage,
    chatAttachment: ctx.chatAttachment,
    sampleFiles: ctx.sampleFiles,
    moduleHint: ctx.moduleHint,
  });
  const chatRes2 = await fetch(LOCAL_AI_URL + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000),
  });
  if (!chatRes2.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await chatRes2.text()).slice(0, 1200);
    } catch (_) {}
    return { ok: false, httpStatus: chatRes2.status, bodySnippet, parsed: null };
  }
  try {
    const parsed = await chatRes2.json();
    return { ok: true, parsed };
  } catch (e) {
    return { ok: false, httpStatus: chatRes2.status, error: String((e && e.message) || e), parsed: null };
  }
}

const SD_CONNECTIVITY_TEST_PROMPT =
  'soft pastel abstract gradient wallpaper, high detail, centered composition, 4k, no text — Butler connectivity test image';

/** LLM JSON prompt is often scrubbed; local ComfyUI uses the user's exact chat text. */
function sdUserPromptOrModel(userMessage, modelPrompt) {
  const u = String(userMessage ?? '').trim();
  if (u.length >= 2) return u;
  return String(modelPrompt ?? '').trim();
}

/** ComfyUI txt2img — only called after the local model returns mode sd_txt2img (plain-English intent, not regex). */
async function respondWithSdTxt2img({
  txtPrompt,
  sdConnectivityTest,
  session,
  sessionId,
  sessions,
  localAiUrl,
  learnCtx,
  res,
  onImageSuccess,
}) {
  let prompt = String(txtPrompt || '').trim();
  if (sdConnectivityTest && !prompt) {
    prompt = SD_CONNECTIVITY_TEST_PROMPT;
  }
  if (!prompt) {
    return false;
  }
  try {
    const r = await fetch(localAiUrl + '/sd/txt2img', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await r.json();
    fillSdPayloadFromDisk(data);
    if (data.ok && data.images && data.images.length > 0) {
      session.lastGeneratedImage = data.images[0];
      sessions.set(sessionId, session);
      let reply = data.message || "Here's your image.";
      if (sdConnectivityTest) {
        reply += '\n\nGenerated via your local ComfyUI (port ' + getComfyListenPort() + ').';
      }
      try {
        if (typeof onImageSuccess === 'function') onImageSuccess();
      } catch (_) {}
      learnCtx(reply);
      res.json({ reply, source: 'Stable Diffusion', images: data.images, path: data.path });
      return true;
    }
    const reply =
      data.message ||
      'Image generation failed. Start **ComfyUI** (e.g. your `ComfyUI` folder with `python main.py`) so port **' +
      getComfyListenPort() +
      '** is listening, then try again.';
    sessions.set(sessionId, session);
    learnCtx(reply);
    res.json({ reply, source: 'Stable Diffusion' });
    return true;
  } catch (err) {
    const reply =
      'Could not reach the Knowledge API / ComfyUI for images. Start ComfyUI, ensure the Knowledge API is running, then try again.';
    sessions.set(sessionId, session);
    learnCtx(reply);
    res.json({ reply, source: 'Stable Diffusion' });
    return true;
  }
}

function img2imgTripleTestRequested(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  const low = s.toLowerCase();
  if (low === '/test' || low === '/text') return true;
  if (low.startsWith('/test ') || low.startsWith('/text ')) return true;
  return /(?:^|\s)\/(?:test|text)\s*$/i.test(s);
}

async function respondWithSdImg2img({
  prompt,
  userMessage,
  lastImg,
  session,
  sessionId,
  sessions,
  localAiUrl,
  learnCtx,
  res,
  onImageSuccess,
  compareNsfwTriple,
}) {
  const rawUser = String(userMessage || '').trim();
  const userWantsTestSweep = img2imgTripleTestRequested(rawUser);
  const p = (userWantsTestSweep ? rawUser : sdUserPromptOrModel(userMessage, prompt) || 'same style, enhanced').trim();
  const body = { prompt: p || 'high quality, detailed', init_image: lastImg };
  if (!userWantsTestSweep) {
    if (compareNsfwTriple === true) body.compare_nsfw_triple = true;
    if (compareNsfwTriple === false) body.compare_nsfw_triple = false;
  }
  try {
    const imgRes = await fetch(localAiUrl + '/comfy/img2img', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(900000),
    });
    const data = await imgRes.json();
    fillSdPayloadFromDisk(data);
    if (data.ok) {
      if (data.images && data.images.length > 0) {
        session.lastGeneratedImage = data.images[0];
        sessions.set(sessionId, session);
        try {
          if (typeof onImageSuccess === 'function') onImageSuccess();
        } catch (_) {}
      }
      const reply = data.message || 'Image generated.';
      learnCtx(reply);
      res.json({
        reply,
        source: 'Stable Diffusion',
        images: data.images || [],
        path: data.path,
        variant_labels: data.variant_labels,
      });
      return true;
    }
    const reply = data.message || 'Img2img failed.';
    sessions.set(sessionId, session);
    learnCtx(reply);
    res.json({ reply, source: 'Stable Diffusion' });
    return true;
  } catch (err) {
    const reply = 'Img2img failed. ComfyUI (port ' + getComfyListenPort() + ') must be running.';
    sessions.set(sessionId, session);
    learnCtx(reply);
    res.json({ reply, source: 'Stable Diffusion' });
    return true;
  }
}

async function respondWithSdImage2video({ prompt, lastImg, session, sessionId, sessions, localAiUrl, learnCtx, res, onVideoSuccess }) {
  const p = String(prompt || 'smooth motion, cinematic').trim();
  try {
    const imgRes = await fetch(localAiUrl + '/sd/image2video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: p, init_image: lastImg }),
      signal: AbortSignal.timeout(300000),
    });
    const data = await imgRes.json();
    fillSdPayloadFromDisk(data);
    if (data.ok && data.video) {
      try {
        if (typeof onVideoSuccess === 'function') onVideoSuccess();
      } catch (_) {}
      const msg = String(data.message || '');
      const reply =
        msg.trim().length > 0 && !msg.includes('execution_') ? msg : 'Here’s your video — play it below.';
      learnCtx(reply);
      res.json({ reply, source: 'Stable Diffusion', images: data.images || [], video: data.video, path: data.path });
      return true;
    }
    const reply = data.message || 'Image-to-video failed.';
    sessions.set(sessionId, session);
    learnCtx(reply);
    res.json({ reply, source: 'Stable Diffusion' });
    return true;
  } catch (err) {
    const reply =
      'Image-to-video failed. You may need SD_VIDEO_SCRIPT or an extension that exposes /sdapi/v1/video.';
    sessions.set(sessionId, session);
    learnCtx(reply);
    res.json({ reply, source: 'Stable Diffusion' });
    return true;
  }
}

async function respondWithSdTxt2video({ prompt, session, sessionId, sessions, localAiUrl, learnCtx, res, onVideoSuccess }) {
  const p = String(prompt || '').trim();
  if (!p) {
    sessions.set(sessionId, session);
    learnCtx('Describe the video you want (subject, motion, style).');
    res.json({
      reply: 'Describe the video you want (subject, motion, style).',
      source: 'Stable Diffusion',
    });
    return true;
  }
  try {
    const vidRes = await fetch(localAiUrl + '/sd/txt2video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: p }),
      signal: AbortSignal.timeout(300000),
    });
    const data = await vidRes.json();
    fillSdPayloadFromDisk(data);
    if (data.ok && data.video) {
      try {
        if (typeof onVideoSuccess === 'function') onVideoSuccess();
      } catch (_) {}
      const reply =
        data.message && String(data.message).trim().length > 0 && !String(data.message).includes('execution_')
          ? data.message
          : 'Here’s your video — play it below.';
      learnCtx(reply);
      res.json({ reply, source: 'Stable Diffusion', images: data.images || [], video: data.video, path: data.path });
      return true;
    }
    const reply = data.message || 'Text-to-video failed.';
    sessions.set(sessionId, session);
    learnCtx(reply);
    res.json({ reply, source: 'Stable Diffusion' });
    return true;
  } catch (err) {
    const reply =
      'Text-to-video failed. Run Forge/A1111 with a txt2video extension, or set SD_TXT2VIDEO_SCRIPT in .env.';
    sessions.set(sessionId, session);
    learnCtx(reply);
    res.json({ reply, source: 'Stable Diffusion' });
    return true;
  }
}

function waitForKnowledgeApi(maxMs = 8000) {
  const start = Date.now();
  return new Promise((resolve) => {
    function check() {
      fetch('http://127.0.0.1:' + KNOWLEDGE_API_PORT + '/count').then((r) => {
        if (r.ok) return resolve(true);
        if (Date.now() - start > maxMs) return resolve(false);
        setTimeout(check, 300);
      }).catch(() => {
        if (Date.now() - start > maxMs) return resolve(false);
        setTimeout(check, 300);
      });
    }
    check();
  });
}

async function startInternalApiServer() {
  const api = express();
  /** Chrome Private Network Access: public HTTPS (Firebase) → localhost / LAN API. */
  api.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (String(req.headers['access-control-request-private-network'] || '') === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    next();
  });
  /** Open CORS for local SPA / Firebase Hosting / phone-on-LAN browsers. */
  api.use(
    cors({
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'Access-Control-Request-Private-Network',
      ],
      maxAge: 86400,
    }),
  );
  api.use(express.json({ limit: '80mb' }));

  api.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'butler-electron' });
  });

  const LOCAL_AI_URL = normalizeKnowledgeApiBaseUrl(process.env.KNOWLEDGE_API_URL, '[Butler] ');

  function pathIsUnderButlor(candidate) {
    const root = path.resolve(getButlorConfigDirAbs());
    const c = path.resolve(candidate);
    const rel = path.relative(root, c);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
    if (process.platform === 'win32') {
      const rl = root.toLowerCase().replace(/[/\\]+$/, '');
      const cl = c.toLowerCase();
      return cl === rl || cl.startsWith(rl + '\\');
    }
    return false;
  }

  function safePrint3dStlQueryName(name) {
    const s = String(name || '').trim();
    if (!s || s.length > 240) return null;
    if (s.includes('..') || s.includes('/') || s.includes('\\')) return null;
    if (!/^[a-zA-Z0-9_.-]+\.stl$/i.test(s)) return null;
    return s;
  }

  const learnFromConversation = (userMsg, assistantReply, topic = 'conversation') => {
    const content = 'User: ' + userMsg + '\n\nAssistant: ' + assistantReply;
    if (content.length < 16) return;
    const t = String(topic || 'conversation').slice(0, 100);
    fetch(LOCAL_AI_URL + '/learn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, topic: t, source: 'chat' }),
    }).catch(() => {});
  };

  const learnIntent = (userMsg, mode, params) => {
    if (!userMsg || !mode) return;
    fetch(LOCAL_AI_URL + '/learn/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_message: userMsg, mode, params }),
    }).catch(() => {});
  };

  /** Logs structured tool/file/command work into the knowledge store (+ optional background research). */
  const learnActivity = (line, kind, opts = {}) => {
    const l = String(line || '').trim();
    if (l.length < 4) return;
    const body = {
      line: l.slice(0, 4000),
      kind: String(kind || 'activity').slice(0, 100),
    };
    const rh = opts.research_hint != null ? String(opts.research_hint).trim() : '';
    if (rh) body.research_hint = rh.slice(0, 500);
    fetch(LOCAL_AI_URL + '/learn/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  };

  const recordApplySummaryLearning = (userMsg, applySummary) => {
    if (!applySummary) return;
    const parts = [];
    if (applySummary.files?.length) parts.push('Wrote: ' + applySummary.files.join(', '));
    if (applySummary.downloads?.length) parts.push('Downloaded: ' + applySummary.downloads.join(', '));
    if (applySummary.commands?.length) parts.push('Ran: ' + applySummary.commands.join(' | '));
    if (applySummary.backgroundCommands?.length) {
      parts.push('Background: ' + applySummary.backgroundCommands.map((b) => b.command).join(' | '));
    }
    if (applySummary.openedUrls?.length) parts.push('Opened: ' + applySummary.openedUrls.join(', '));
    if (!parts.length) return;
    const line =
      'Butler actions — ' +
      parts.join('. ') +
      '\nUser request: ' +
      String(userMsg || '').slice(0, 800);
    learnActivity(line, 'apply_actions', { research_hint: String(userMsg || '').slice(0, 400) });
  };

  api.get('/api/settings', (req, res) => {
    const key = readOpenAIKey();
    const masked = key ? ('sk-...' + key.slice(-4)) : '';
    const cfgPath = getConfigPath();
    let localOnly = false;
    let voiceMode = false;
    let butlerGlobalProjectRoot = '';
    let butlerTrustedRootsText = '';
    let butlerAllowAnyPath = false;
    if (fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        localOnly = !!cfg.local_only;
        voiceMode = !!cfg.voice_mode;
        butlerGlobalProjectRoot = String(cfg.butler_global_project_root || '').trim();
        const tr = cfg.butler_trusted_roots;
        butlerTrustedRootsText = Array.isArray(tr)
          ? tr.join('\n')
          : String(tr || '').trim();
        butlerAllowAnyPath = !!cfg.butler_allow_any_path;
      } catch (_) {}
    }
    const effectiveGlobal = getEffectiveGlobalProjectRoot();
    const effectiveTrusted = getEffectiveTrustedRoots();
    return res.json({
      openaiApiKey: masked,
      hasKey: !!key,
      localOnly,
      voiceMode,
      butlerGlobalProjectRoot,
      butlerTrustedRootsText,
      butlerAllowAnyPath,
      butlerDevEffective: {
        globalProjectRoot: effectiveGlobal || null,
        trustedRoots: effectiveTrusted,
        allowAnyPath: isButlerAllowAnyPath(),
      },
    });
  });

  api.post('/api/tests/run', async (req, res) => {
    try {
      const { pathToFileURL } = require('url');
      const selfModUrl = pathToFileURL(path.join(__dirname, 'butler-selftest.mjs')).href;
      const { runButlerSelfTests } = await import(selfModUrl);
      const knowRoot =
        app.isPackaged && process.resourcesPath
          ? path.join(process.resourcesPath, 'knowledge')
          : path.join(__dirname, '../../knowledge');
      const uiRoot = path.join(__dirname, '..');
      const out = await runButlerSelfTests({
        butlerBaseUrl: 'http://127.0.0.1:' + API_PORT,
        knowledgeUrl: LOCAL_AI_URL,
        knowledgeRoot: knowRoot,
        uiRoot,
        packaged: app.isPackaged,
        pythonExe: resolvePythonForStt(),
      });
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e?.message || e), results: [] });
    }
  });

  api.get('/api/status', async (req, res) => {
    const STATUS_TIMEOUT_MS = 15000;
    const localPromise = buildElectronStatusFallback(LOCAL_AI_URL, '');
    const apiPromise = (async () => {
      try {
        const r = await fetch(LOCAL_AI_URL + '/status', { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
        if (!r.ok) {
          return { services: null, error: 'Knowledge API HTTP ' + r.status };
        }
        const data = await r.json();
        const list = Array.isArray(data.services) ? data.services : [];
        return { services: list, error: null };
      } catch (e) {
        return { services: null, error: String((e && e.message) || e) };
      }
    })();

    const [local, api] = await Promise.all([localPromise, apiPromise]);
    let services = mergeStatusServicesElectron(local.services, api.services);
    if (api.error) {
      services = services.map(function (s) {
        if (s.id !== 'knowledge_api') return s;
        return Object.assign({}, s, {
          ok: false,
          url: LOCAL_AI_URL,
          detail: String(api.error).slice(0, 220),
        });
      });
    }
    const comfy = comfyProcess && !comfyProcess.killed;
    const aiUp = aiServerProcess && !aiServerProcess.killed;
    const knowledgeUp = knowledgeApiProcess && !knowledgeApiProcess.killed;
    services.unshift({
      id: 'butler_spawned',
      label: 'Processes started by Butler',
      ok: true,
      detail:
        (comfy ? 'ComfyUI child: yes' : 'ComfyUI child: no') +
        ' · ' +
        (aiUp ? 'ai_server.py: yes' : 'ai_server.py: no') +
        ' · ' +
        (knowledgeUp ? 'Knowledge API child: yes' : 'Knowledge API child: no'),
    });
    services.unshift({
      id: 'butler_host',
      label: 'Butler app (this window)',
      ok: true,
      detail: app.isPackaged ? 'Packaged build' : 'Development',
    });

    const body = {
      generated_at: new Date().toISOString(),
      services: services,
    };
    if (api.error) {
      body.error = api.error;
      body.status_note = local.status_note;
    }
    return res.json(body);
  });

  api.post('/api/status/restart', async (req, res) => {
    const service = String(req.body?.service || '').trim();
    try {
      let out;
      if (service === 'all') {
        const msgs = [];
        let allOk = true;
        const rLlm = restartManagedAiServer();
        msgs.push('local_llm: ' + rLlm.message);
        allOk = allOk && rLlm.ok;
        const comfyOff = ['0', 'false', 'no', 'off'].includes(
          String(process.env.USE_COMFYUI || '1')
            .trim()
            .toLowerCase(),
        );
        if (!comfyOff) {
          const rC = restartManagedComfy();
          msgs.push('comfyui: ' + rC.message);
          allOk = allOk && rC.ok;
        } else {
          msgs.push('comfyui: skipped (USE_COMFYUI off)');
        }
        const rK = await restartManagedKnowledgeApi();
        msgs.push('knowledge_api: ' + rK.message);
        allOk = allOk && rK.ok;
        out = { ok: allOk, message: msgs.join('\n\n') };
      } else if (service === 'comfyui') out = restartManagedComfy();
      else if (service === 'local_llm') out = restartManagedAiServer();
      else if (service === 'knowledge_api') out = await restartManagedKnowledgeApi();
      else {
        return res.status(400).json({ ok: false, message: 'Unknown or unsupported service: ' + service });
      }
      return res.json({ ok: !!out.ok, message: out.message });
    } catch (e) {
      return res.status(500).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  api.post('/api/learn/go', async (req, res) => {
    try {
      const r = await fetch(LOCAL_AI_URL + '/learn/go', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
        signal: AbortSignal.timeout(20000),
      });
      const data = await r.json().catch(() => ({}));
      return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
    } catch (e) {
      return res.status(502).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  api.get('/api/learn/go_status', async (_req, res) => {
    try {
      const r = await fetch(LOCAL_AI_URL + '/learn/go_status', { signal: AbortSignal.timeout(12000) });
      const data = await r.json().catch(() => ({}));
      return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
    } catch (e) {
      return res.status(502).json({ running: false, error: String((e && e.message) || e) });
    }
  });

  api.post('/api/settings', (req, res) => {
    try {
      const {
        openaiApiKey,
        localOnly,
        voiceMode,
        butlerGlobalProjectRoot,
        butlerTrustedRootsText,
        butlerAllowAnyPath,
      } = req.body || {};
      const cfgPath = getConfigPath();
      const cfgDir = path.dirname(cfgPath);
      if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
      let config = {};
      if (fs.existsSync(cfgPath)) {
        try {
          config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        } catch (_) {}
      }
      if (typeof openaiApiKey === 'string') config.openai_api_key = openaiApiKey.trim();
      if (typeof localOnly === 'boolean') config.local_only = localOnly;
      if (typeof voiceMode === 'boolean') config.voice_mode = voiceMode;
      if (typeof butlerGlobalProjectRoot === 'string') {
        config.butler_global_project_root = butlerGlobalProjectRoot.trim();
      }
      if (typeof butlerTrustedRootsText === 'string') {
        config.butler_trusted_roots = butlerTrustedRootsText
          .split(/[\n;|]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (typeof butlerAllowAnyPath === 'boolean') {
        config.butler_allow_any_path = butlerAllowAnyPath;
      }
      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
      process.env.OPENAI_API_KEY = config.local_only ? '' : (config.openai_api_key || '');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent.replace(/OPENAI_API_KEY\s*=.*/g, '');
        const keyVal = config.local_only ? '' : (config.openai_api_key || '');
        if (keyVal) envContent = envContent.trimEnd() + (envContent ? '\n' : '') + 'OPENAI_API_KEY=' + keyVal + '\n';
        fs.writeFileSync(envPath, envContent, 'utf8');
      }
      if (aiServerProcess) {
        aiServerProcess.kill();
        aiServerProcess = null;
        setTimeout(() => startAiServer(), 500);
      }
      if (typeof localOnly === 'boolean' || typeof openaiApiKey === 'string') {
        void restartManagedKnowledgeApi().catch(function (e) {
          console.error('[Butler] Knowledge API restart after settings:', e && e.message ? e.message : e);
        });
      }
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  function isAllowedListingUrl(u) {
    try {
      const x = new URL(u);
      if (x.protocol !== 'http:' && x.protocol !== 'https:') return false;
      const h = x.hostname.replace(/^www\./, '').toLowerCase();
      const ok = [
        'facebook.com',
        'marketplace.facebook.com',
        'zillow.com',
        'apartments.com',
        'craigslist.org',
        'realtor.com',
        'rent.com',
        'redfin.com',
        'trulia.com',
      ];
      return ok.some((d) => h === d || h.endsWith('.' + d));
    } catch (_) {
      return false;
    }
  }

  api.post('/api/facebook/open-marketplace', async (req, res) => {
    try {
      const r = await fetch(LOCAL_AI_URL + '/facebook/open_marketplace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const data = await r.json();
      return res.status(r.ok ? 200 : 502).json(data);
    } catch (e) {
      return res.status(502).json({ ok: false, message: String(e?.message || e) });
    }
  });

  api.post('/api/facebook/detect-chrome-profile', async (req, res) => {
    try {
      const r = await fetch(LOCAL_AI_URL + '/facebook/detect_chrome_profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
        signal: AbortSignal.timeout(20000),
      });
      const data = await r.json();
      return res.status(r.ok ? 200 : 502).json(data);
    } catch (e) {
      return res.status(502).json({ ok: false, message: String(e?.message || e) });
    }
  });

  api.post('/api/open-external', (req, res) => {
    try {
      const preset = req.body?.preset;
      if (preset === 'facebook_marketplace') {
        shell.openExternal('https://www.facebook.com/marketplace');
        return res.json({ ok: true });
      }
      const url = String(req.body?.url || '').trim();
      if (!url || !isAllowedListingUrl(url)) {
        return res.status(400).json({ ok: false, message: 'URL not allowed' });
      }
      shell.openExternal(url);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, message: String(e?.message || e) });
    }
  });

  async function invokeAbletonAction(body) {
    const { action, bpm, path: midiPath, style } = body || {};
    const knowledgeDir = app.isPackaged
      ? (process.resourcesPath ? path.join(process.resourcesPath, 'knowledge') : null)
      : path.join(__dirname, '../../knowledge');
    const cliPy = knowledgeDir ? path.join(knowledgeDir, 'ableton_cli.py') : null;
    let pythonCmd = app.isPackaged
      ? path.join(process.resourcesPath, 'python-embed', 'python.exe')
      : (process.platform === 'win32' ? 'python' : 'python3');
    if (!app.isPackaged && process.platform === 'win32') {
      const pyExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'py.exe');
      if (fs.existsSync(pyExe)) pythonCmd = pyExe;
    }
    if (!cliPy || !fs.existsSync(cliPy)) {
      return { ok: false, message: 'Ableton integration not available (cli: ' + cliPy + ')' };
    }
    const cmdArgs = [cliPy, String(action || 'status')];
    if (action === 'tempo' && bpm != null) cmdArgs.push(String(bpm));
    if (action === 'midi') {
      cmdArgs.push(midiPath || path.join(os.homedir(), 'Desktop', 'butlor_drums.mid'));
      cmdArgs.push(bpm != null ? String(bpm) : '120');
      if (style) cmdArgs.push(String(style));
    }
    const usePyLauncher = pythonCmd.endsWith('py.exe');
    const procArgs = usePyLauncher ? ['-3', ...cmdArgs] : cmdArgs;
    const procEnv = { ...process.env, PYTHONPATH: knowledgeDir };
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const proc = spawn(pythonCmd, procArgs, {
        cwd: knowledgeDir,
        env: procEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      proc.stdout?.on('data', (d) => { out += d.toString(); });
      proc.stderr?.on('data', (d) => { err += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0 && !out.trim()) resolve({ stdout: '', stderr: err || ('Process exited with code ' + code) });
        else resolve({ stdout: out, stderr: err });
      });
      proc.on('error', (e) => reject(e));
    });
    let data = {};
    try {
      data = JSON.parse(stdout.trim() || '{}');
    } catch (_) {
      data = { ok: false, message: (stdout || stderr || 'Unknown error').trim() };
    }
    if (!data.message && data.ok === false) data.message = data.message || stderr || 'Command failed';
    return data;
  }

  api.post('/api/ableton', async (req, res) => {
    try {
      const data = await invokeAbletonAction(req.body || {});
      return res.json(data);
    } catch (err) {
      console.error('Ableton API error:', err);
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.get('/api/jobs/interviews', async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
      const r = await fetch(LOCAL_AI_URL + '/jobs/interviews?days=' + days, { signal: AbortSignal.timeout(5000) });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.get('/api/jobs/tracker', async (req, res) => {
    try {
      const r = await fetch(LOCAL_AI_URL + '/jobs/tracker', { signal: AbortSignal.timeout(5000) });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.post('/api/jobs/add', async (req, res) => {
    try {
      const r = await fetch(LOCAL_AI_URL + '/jobs/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
        signal: AbortSignal.timeout(10000),
      });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.post('/api/jobs/tailor_resume', async (req, res) => {
    try {
      const body = { ...(req.body || {}), openai_api_key: readOpenAIKey() };
      const r = await fetch(LOCAL_AI_URL + '/jobs/tailor_resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.get('/api/jobs/emails', async (req, res) => {
    try {
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const r = await fetch(LOCAL_AI_URL + '/jobs/emails?limit=' + limit, { signal: AbortSignal.timeout(15000) });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.post('/api/gigs/run', async (req, res) => {
    try {
      const body = { ...(req.body || {}), openai_api_key: readOpenAIKey() };
      const r = await fetch(LOCAL_AI_URL + '/gigs/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.get('/api/gigs/queue', async (req, res) => {
    try {
      const r = await fetch(LOCAL_AI_URL + '/gigs/queue', { signal: AbortSignal.timeout(5000) });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.get('/api/gigs/discover', async (req, res) => {
    try {
      const skills = encodeURIComponent(req.query.skills || 'frontend development');
      const r = await fetch(LOCAL_AI_URL + '/gigs/discover?skills=' + encodeURIComponent(skills) + '&limit=10', { signal: AbortSignal.timeout(15000) });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.post('/api/jobs/auto_apply', async (req, res) => {
    try {
      const body = { ...(req.body || {}), openai_api_key: readOpenAIKey() };
      const r = await fetch(LOCAL_AI_URL + '/jobs/auto_apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  async function summarizeButlorDataForSettingsMain() {
    const envRaw = String(process.env.BUTLOR_CONFIG || '').trim();
    const root = getButlorConfigDirAbs();
    await fsp.mkdir(root, { recursive: true });
    async function countFilesInDir(dir) {
      try {
        const names = await fsp.readdir(dir);
        let n = 0;
        for (const name of names) {
          try {
            const st = await fsp.stat(path.join(dir, name));
            if (st.isFile()) n++;
          } catch (_) {}
        }
        return n;
      } catch (_) {
        return 0;
      }
    }
    async function isFile(p) {
      try {
        return (await fsp.stat(p)).isFile();
      } catch (_) {
        return false;
      }
    }
    const applications = path.join(root, 'applications');
    const generated = path.join(root, 'generated');
    const print3d = path.join(root, 'print3d');
    await fsp.mkdir(print3d, { recursive: true });
    const jtp = path.join(root, 'job_tracker.json');
    const profileP = path.join(root, 'profile.json');
    const comfyP = path.join(root, 'comfy_config.json');
    const aptTxt = path.join(root, 'apartment_listings_latest.txt');
    const aptJson = path.join(root, 'apartment_listings_latest.json');
    const gigsP = path.join(root, 'gigs.json');
    const paymentP = path.join(root, 'payment_config.json');
    const strategiesP = path.join(root, 'money_strategies.json');
    let jobTracked = 0;
    try {
      const raw = await fsp.readFile(jtp, 'utf8');
      const j = JSON.parse(raw);
      jobTracked = Array.isArray(j.jobs) ? j.jobs.length : 0;
    } catch (_) {}
    const trainingEnv = String(process.env.BUTLER_TRAINING_LOG || '').trim();
    const trainingPath = trainingEnv ? path.resolve(trainingEnv) : path.join(root, 'butler_training.jsonl');
    if (trainingEnv) {
      await fsp.mkdir(path.dirname(trainingPath), { recursive: true }).catch(() => {});
    }
    let trainingLines = 0;
    try {
      const txt = await fsp.readFile(trainingPath, 'utf8');
      for (const line of txt.split('\n')) {
        if (line.trim()) trainingLines++;
      }
    } catch (_) {}
    const gmailC = path.join(root, 'gmail_credentials.json');
    const gmailT = path.join(root, 'gmail_token.json');
    const locations = [
      {
        id: 'root',
        label: 'Butler data folder',
        detail: 'Default: D:\\butlor on Windows, else ~/Documents/Butlor. Override with BUTLOR_CONFIG in .env.',
        path: root,
        kind: 'folder',
        count: await countFilesInDir(root),
        count_label: 'files in root',
      },
      {
        id: 'applications',
        label: 'Job application materials',
        detail: 'Tailored resumes & cover letters per posting (from job search / auto-apply).',
        path: applications,
        kind: 'folder',
        count: await countFilesInDir(applications),
        count_label: 'files',
      },
      {
        id: 'generated',
        label: 'Generated images & videos (disk)',
        detail: 'Copies saved from Stable Diffusion / Comfy workflows.',
        path: generated,
        kind: 'folder',
        count: await countFilesInDir(generated),
        count_label: 'files',
      },
      {
        id: 'print3d',
        label: '3D print (STL)',
        detail: 'STL from chat (print3d) or /api/print3d/generate.',
        path: print3d,
        kind: 'folder',
        count: await countFilesInDir(print3d),
        count_label: 'files',
      },
      {
        id: 'profile',
        label: 'profile.json',
        detail: 'Résumé HTML/text, name, email, optional Indeed/Facebook fields.',
        path: profileP,
        kind: 'file',
        count: (await isFile(profileP)) ? 1 : 0,
        count_label: 'present',
      },
      {
        id: 'job_tracker',
        label: 'job_tracker.json',
        detail: 'Tracked applications and interview notes.',
        path: jtp,
        kind: 'file',
        count: jobTracked,
        count_label: 'tracked jobs',
      },
      {
        id: 'training_log',
        label: 'butler_training.jsonl',
        detail: 'Append-only learning log (unless BUTLER_TRAINING_LOG points elsewhere).',
        path: trainingPath,
        kind: 'file',
        count: trainingLines,
        count_label: 'lines',
      },
      {
        id: 'apartments',
        label: 'Apartment search outputs',
        detail: 'apartment_config.json, apartment_listings_latest.txt/.json, dated runs.',
        path: root,
        kind: 'folder',
        count: ((await isFile(aptTxt)) ? 1 : 0) + ((await isFile(aptJson)) ? 1 : 0),
        count_label: 'latest listing files',
      },
      {
        id: 'comfy_config',
        label: 'comfy_config.json',
        detail: 'ComfyUI workflow preferences.',
        path: comfyP,
        kind: 'file',
        count: (await isFile(comfyP)) ? 1 : 0,
        count_label: 'present',
      },
      {
        id: 'gmail',
        label: 'Gmail API (optional)',
        detail: 'gmail_credentials.json, gmail_token.json for job-email features.',
        path: root,
        kind: 'folder',
        count: ((await isFile(gmailC)) ? 1 : 0) + ((await isFile(gmailT)) ? 1 : 0),
        count_label: 'credential files',
      },
      {
        id: 'gigs',
        label: 'Gigs / payment (optional)',
        detail: 'gigs.json, money_strategies.json, payment_config.json',
        path: root,
        kind: 'folder',
        count:
          ((await isFile(gigsP)) ? 1 : 0) +
          ((await isFile(paymentP)) ? 1 : 0) +
          ((await isFile(strategiesP)) ? 1 : 0),
        count_label: 'config files',
      },
    ];
    return { ok: true, root, butlor_config_env: envRaw || null, locations };
  }

  async function mergePrint3dRowIntoDataSummary(data) {
    if (!data || typeof data !== 'object' || data.ok === false) return data;
    const locs = Array.isArray(data.locations) ? data.locations : [];
    if (locs.some((x) => x && x.id === 'print3d')) return data;
    const root = (data.root && String(data.root).trim()) || getButlorConfigDirAbs();
    const print3dDir = path.join(path.resolve(root), 'print3d');
    await fsp.mkdir(print3dDir, { recursive: true });
    let count = 0;
    try {
      const names = await fsp.readdir(print3dDir);
      for (const name of names) {
        try {
          const st = await fsp.stat(path.join(print3dDir, name));
          if (st.isFile()) count++;
        } catch (_) {}
      }
    } catch (_) {}
    const row = {
      id: 'print3d',
      label: '3D print (STL)',
      detail: 'STL from chat (print3d) or /api/print3d/generate.',
      path: print3dDir,
      kind: 'folder',
      count,
      count_label: 'files',
    };
    const genIdx = locs.findIndex((x) => x && x.id === 'generated');
    const locations =
      genIdx >= 0 ? [...locs.slice(0, genIdx + 1), row, ...locs.slice(genIdx + 1)] : [...locs, row];
    return Object.assign({}, data, { locations });
  }

  api.get('/api/butlor/data_summary', async (_req, res) => {
    try {
      const r = await fetch(LOCAL_AI_URL + '/butlor/data_summary', { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const data = await r.json();
        return res.json(await mergePrint3dRowIntoDataSummary(data));
      }
      if (r.status === 404 || r.status >= 500) {
        return res.json(await summarizeButlorDataForSettingsMain());
      }
      const t = await r.text();
      const shortErr =
        t && t.length < 480 && !/^\s*</.test(t) ? t : (r.statusText || String(r.status));
      return res.status(r.status).json({ ok: false, error: shortErr });
    } catch (err) {
      try {
        return res.json(await summarizeButlorDataForSettingsMain());
      } catch (_) {
        return res.status(503).json({ ok: false, error: String(err?.message || err) });
      }
    }
  });

  api.post('/api/open_path', async (req, res) => {
    const p = String(req.body?.path || '').trim();
    const action = String(req.body?.action || 'open').trim();
    if (!p) return res.status(400).json({ ok: false, error: 'path required' });
    if (!pathIsUnderButlor(p)) return res.status(403).json({ ok: false, error: 'Path must be under the Butler data folder' });
    try {
      let st;
      try {
        st = await fsp.stat(p);
      } catch (_) {
        st = null;
      }
      const normP = path.normalize(p);
      if (action === 'reveal' && st && st.isFile()) {
        shell.showItemInFolder(normP);
        return res.json({ ok: true });
      }
      let openTarget = normP;
      if (st && st.isFile()) openTarget = path.dirname(normP);
      openTarget = path.normalize(openTarget);
      if (!fs.existsSync(openTarget)) await fsp.mkdir(openTarget, { recursive: true });
      const openErr = await shell.openPath(openTarget);
      if (openErr) return res.json({ ok: false, error: openErr });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  api.get('/api/jobs/profile', async (req, res) => {
    try {
      const r = await fetch(LOCAL_AI_URL + '/jobs/profile', { signal: AbortSignal.timeout(5000) });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.json({});
    }
  });

  api.post('/api/jobs/profile', async (req, res) => {
    try {
      const r = await fetch(LOCAL_AI_URL + '/jobs/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
        signal: AbortSignal.timeout(5000),
      });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.post('/api/jobs/resume_template', async (req, res) => {
    try {
      const r = await fetch(LOCAL_AI_URL + '/jobs/resume_template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
        signal: AbortSignal.timeout(60000),
      });
      const data = await r.json();
      return res.status(r.ok ? 200 : r.status).json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.post('/api/jobs/resume_pdf', async (req, res) => {
    try {
      const body = req.body || {};
      const html = String(body.html || '').trim();
      if (!html) {
        return res.status(400).json({ ok: false, message: 'html required' });
      }
      const styleId = String(body.style_id ?? body.styleId ?? 'standard');
      const fn =
        String(body.filename_stem || body.filenameStem || 'resume')
          .replace(/[^\w\-]+/g, '_')
          .slice(0, 80) || 'resume';

      const { pathToFileURL } = require('url');
      const repoBase = app.isPackaged ? path.join(__dirname, '..') : path.join(__dirname, '..', '..');
      const kitPath = path.join(repoBase, 'resumePdfKit.mjs');
      if (!fs.existsSync(kitPath)) {
        throw new Error('resumePdfKit.mjs not found at ' + kitPath);
      }
      const { renderResumeHtmlToPdfBuffer } = await import(pathToFileURL(kitPath).href);
      const pdfBytes = await renderResumeHtmlToPdfBuffer(html, styleId);
      const buf = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);
      if (buf.length < 10) {
        throw new Error('Resume PDF generator returned empty buffer');
      }
      try {
        const root = getButlorConfigDirAbs();
        const dir = path.join(root, 'resumes');
        await fsp.mkdir(dir, { recursive: true });
        const outPath = path.join(dir, fn + '.pdf');
        await fsp.writeFile(outPath, buf);
        res.setHeader('X-Butler-Saved-Path', outPath);
      } catch (wErr) {
        console.warn('[resume_pdf] Could not write to data folder:', wErr?.message || wErr);
      }
      res.setHeader('X-Butler-Template', styleId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="' + fn + '.pdf"');
      return res.status(200).send(buf);
    } catch (err) {
      console.error('[resume_pdf]', err);
      return res.status(500).type('application/json').json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.post('/api/jobs/resume_docx', async (req, res) => {
    try {
      const body = req.body || {};
      const html = String(body.html || '').trim();
      if (!html) {
        return res.status(400).json({ ok: false, message: 'html required' });
      }
      const styleId = String(body.style_id ?? body.styleId ?? 'harvard');
      const fn =
        String(body.filename_stem || body.filenameStem || 'resume')
          .replace(/[^\w\-]+/g, '_')
          .slice(0, 80) || 'resume';

      const { pathToFileURL } = require('url');
      const repoBase = app.isPackaged ? path.join(__dirname, '..') : path.join(__dirname, '..', '..');
      const docxKitPath = path.join(repoBase, 'resumeDocxKit.mjs');
      if (!fs.existsSync(docxKitPath)) {
        throw new Error('resumeDocxKit.mjs not found at ' + docxKitPath);
      }
      const { renderResumeHtmlToDocxBuffer } = await import(pathToFileURL(docxKitPath).href);
      const docxBytes = await renderResumeHtmlToDocxBuffer(html, styleId);
      const buf = Buffer.isBuffer(docxBytes) ? docxBytes : Buffer.from(docxBytes);
      if (buf.length < 10) {
        throw new Error('Resume DOCX generator returned empty buffer');
      }
      try {
        const root = getButlorConfigDirAbs();
        const dir = path.join(root, 'resumes');
        await fsp.mkdir(dir, { recursive: true });
        const outPath = path.join(dir, fn + '.docx');
        await fsp.writeFile(outPath, buf);
        res.setHeader('X-Butler-Saved-Path', outPath);
      } catch (wErr) {
        console.warn('[resume_docx] Could not write to data folder:', wErr?.message || wErr);
      }
      res.setHeader('X-Butler-Template', styleId);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      res.setHeader('Content-Disposition', 'attachment; filename="' + fn + '.docx"');
      return res.status(200).send(buf);
    } catch (err) {
      console.error('[resume_docx]', err);
      return res.status(500).type('application/json').json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.post('/api/jobs/resume_auto_structure', async (req, res) => {
    try {
      const body = req.body || {};
      const html = String(body.html || '').trim();
      const out = await aiAutoStructureResumeHtml({ html });
      return res.status(200).json({ ok: true, html: out });
    } catch (err) {
      const code = typeof err?.statusCode === 'number' ? err.statusCode : 500;
      return res.status(code).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.post('/api/jobs/cover_letter', async (req, res) => {
    try {
      const body = { ...(req.body || {}), openai_api_key: readOpenAIKey() };
      const r = await fetch(LOCAL_AI_URL + '/jobs/cover_letter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, message: String(err?.message || err) });
    }
  });

  api.post('/api/speech-to-text', async (req, res) => {
    try {
      const { audio, pcm, sampleRate } = req.body || {};
      const usePcm = pcm != null && typeof pcm === 'string' && sampleRate != null;
      if (!usePcm && (typeof audio !== 'string' || !audio)) {
        return res.status(400).json({ error: 'Send pcm+sampleRate (preferred) or legacy audio (base64 WAV).' });
      }
      const buf = Buffer.from(usePcm ? pcm : audio, 'base64');
      if (buf.length < 500) {
        return res.status(400).json({ error: 'audio too short' });
      }
      let sttArgs;
      const tmpPath = usePcm
        ? path.join(os.tmpdir(), 'butlor-stt-' + Date.now() + '.pcm')
        : path.join(os.tmpdir(), 'butlor-stt-' + Date.now() + '.wav');
      fs.writeFileSync(tmpPath, buf);
      if (usePcm) {
        const rate = Math.round(Number(sampleRate));
        if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) {
          try { fs.unlinkSync(tmpPath); } catch (_) {}
          return res.status(400).json({ error: 'Invalid sampleRate (use 8000–192000).' });
        }
        sttArgs = ['--pcm-s16le', String(rate), tmpPath];
      } else {
        sttArgs = [tmpPath];
      }
      const knowledgeDir = app.isPackaged
        ? (process.resourcesPath ? path.join(process.resourcesPath, 'knowledge') : null)
        : path.join(__dirname, '../../knowledge');
      const sttPy = knowledgeDir ? path.join(knowledgeDir, 'stt.py') : null;
      const python = resolvePythonForStt();
      if (!sttPy || !fs.existsSync(sttPy)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        return res.status(503).json({ error: 'Speech-to-text not available (missing knowledge/stt.py).' });
      }
      const { stdout, stderr, code } = await new Promise((resolve, reject) => {
        const proc = spawn(python, [sttPy, ...sttArgs], {
          cwd: knowledgeDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        proc.stdout?.on('data', (d) => { out += d.toString(); });
        proc.stderr?.on('data', (d) => { err += d.toString(); });
        proc.on('close', (exitCode) => resolve({ stdout: out, stderr: err, code: exitCode }));
        proc.on('error', reject);
      });
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      const text = (stdout || '').trim();
      const errTrim = (stderr || '').trim();
      if (!text) {
        if (errTrim) {
          return res.status(503).json({ error: 'Speech-to-text failed: ' + errTrim, text: '' });
        }
        if (code !== 0 && code != null) {
          return res.status(503).json({
            error: 'Speech-to-text process failed (exit ' + code + '). Check that SpeechRecognition is installed in python-embed.',
            text: '',
          });
        }
        return res.status(503).json({
          error:
            'No transcript returned. Needs internet for Google recognition. If this persists, check Windows microphone privacy for Butler.',
          text: '',
        });
      }
      return res.json({ text });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  api.get('/api/print3d/key-check', async (_req, res) => {
    const openaiConfigured = !!readOpenAIKey();
    const { pathToFileURL } = require('url');
    const modPath = app.isPackaged
      ? path.join(process.resourcesPath, 'print3d-openscad.mjs')
      : path.join(__dirname, '../../print3d-openscad.mjs');
    let openscad_cli = { installed: false, command: null };
    try {
      if (fs.existsSync(modPath)) {
        const { probeOpenScadInstalled } = await import(pathToFileURL(modPath).href);
        openscad_cli = await probeOpenScadInstalled();
      }
    } catch (_) {
      /* */
    }
    let knowledge_api_ok = false;
    try {
      const c = await fetch(LOCAL_AI_URL + '/count', { signal: AbortSignal.timeout(4000) });
      knowledge_api_ok = c.ok;
    } catch (_) {
      /* */
    }
    const compatUrlEnv = String(process.env.BUTLER_PRINT3D_V1_URL || '').trim();
    return res.json({
      ok: true,
      provider: 'openscad_llm',
      engines: ['openai', 'knowledge', 'compat'],
      openai_configured: openaiConfigured,
      knowledge_api_ok,
      knowledge_api_url: LOCAL_AI_URL,
      openscad_cli,
      compat_url_env_set: !!compatUrlEnv,
      hint:
        openaiConfigured || knowledge_api_ok
          ? null
          : 'STL from chat needs Knowledge API + local LLM, or an OpenAI key when Local only is off. Optional: BUTLER_PRINT3D_V1_URL. Install OpenSCAD CLI to compile. BUTLER_PRINT3D_OUTPUT=both keeps .scad files.',
    });
  });

  api.get('/api/print3d/stl', async (req, res) => {
    try {
      const q = String(req.query.f || req.query.file || '').trim();
      const safe = safePrint3dStlQueryName(q);
      if (!safe) {
        return res.status(400).type('text/plain').send('Invalid or missing filename');
      }
      const print3dDir = path.join(getButlorConfigDirAbs(), 'print3d');
      const full = path.resolve(path.join(print3dDir, safe));
      if (!pathIsUnderButlor(full)) {
        return res.status(403).type('text/plain').send('Forbidden');
      }
      const rel = path.relative(path.resolve(print3dDir), full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return res.status(403).type('text/plain').send('Forbidden');
      }
      const buf = await fsp.readFile(full);
      res.setHeader('Content-Type', 'model/stl');
      res.setHeader('Content-Disposition', `inline; filename="${safe}"`);
      res.send(buf);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return res.status(404).type('text/plain').send('Not found');
      }
      return res.status(500).type('text/plain').send('Read failed');
    }
  });

  api.post('/api/print3d/generate', async (req, res) => {
    try {
      const { prompt, model, engine, compat_url, compat_model, compat_api_key, output } = req.body || {};
      let eng = String(engine || 'openai').toLowerCase();
      if (!['openai', 'knowledge', 'compat'].includes(eng)) eng = 'openai';
      const outFmt = String(output || '').trim().toLowerCase() === 'both' ? 'both' : 'stl';

      const openai = readOpenAIKey();
      if (eng === 'openai' && !openai) {
        return res.status(400).json({
          ok: false,
          message:
            'Cloud engine needs an OpenAI key in Settings, or choose Local (Knowledge API) / OpenAI-compatible.',
        });
      }

      const compatBase =
        (typeof compat_url === 'string' && compat_url.trim()) || String(process.env.BUTLER_PRINT3D_V1_URL || '').trim();
      if (eng === 'compat' && !compatBase) {
        return res.status(400).json({
          ok: false,
          message:
            'OpenAI-compatible engine needs a base URL (e.g. http://127.0.0.1:11434) or BUTLER_PRINT3D_V1_URL in .env.',
        });
      }

      const { pathToFileURL } = require('url');
      const modPath = app.isPackaged
        ? path.join(process.resourcesPath, 'print3d-openscad.mjs')
        : path.join(__dirname, '../../print3d-openscad.mjs');
      if (!fs.existsSync(modPath)) {
        return res.status(503).json({
          ok: false,
          message: 'print3d-openscad.mjs is missing from this build. Reinstall Butler or run from dev checkout.',
        });
      }
      const { runPrint3dOpenScadPipeline } = await import(pathToFileURL(modPath).href);
      const root = getButlorConfigDirAbs();
      await fsp.mkdir(root, { recursive: true });
      const logLines = [];
      const result = await runPrint3dOpenScadPipeline({
        engine: eng,
        openaiApiKey: openai,
        knowledgeApiUrl: LOCAL_AI_URL,
        compatBaseUrl: compatBase,
        compatModel: typeof compat_model === 'string' ? compat_model.trim() : '',
        compatApiKey: typeof compat_api_key === 'string' ? compat_api_key.trim() : '',
        butlorDataRoot: root,
        prompt,
        output: outFmt,
        model: typeof model === 'string' && model.trim() ? model.trim() : undefined,
        onProgress: (e) => {
          if (e && e.message) {
            logLines.push(e.message);
            if (logLines.length > 24) logLines.shift();
          }
        },
      });
      return res.json({
        ok: true,
        engine: result.engine,
        llm_model: result.llm_model,
        output: result.output,
        scad_path: result.scad_path,
        stl_path: result.stl_path,
        paths: result.paths,
        openscad_render_ok: result.openscad_render_ok,
        openscad_command: result.openscad_command,
        openscad_hint: result.openscad_hint,
        log: logLines.slice(-10),
      });
    } catch (e) {
      const sc = Number(e && e.status);
      const code = Number.isFinite(sc) && sc >= 400 && sc < 600 ? sc : 500;
      return res.status(code).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  /**
   * True when the user likely wants Butler to write files / scaffold (not a tutorial in chat).
   * Skips OpenAI-first and the generic-chat OpenAI fallback so /chat JSON → applyActions runs.
   */
  function looksLikeBuildOrFileRequest(text) {
    const m = String(text || '').toLowerCase();
    if (m.length < 6) return false;
    const buildVerb = /\b(build|create|make|scaffold|implement|code|generate|set\s*up|add)\b/.test(m);
    // Avoid "create a calendar event" — require software-ish nouns or "calendar app" / calendar + web stack.
    const softwareArtifact =
      /\b(web\s*)?(app|application)\b/.test(m) ||
      /\bwebsite|web\s*site|webpage\b/.test(m) ||
      /\blanding\s+page\b/.test(m) ||
      /\bdashboard\b/.test(m) ||
      /\bgame\b/.test(m) ||
      /\bchrome\s+extension\b/.test(m) ||
      /\b(api|microservice)\b/.test(m) ||
      /\bcalendar\s+app\b/.test(m) ||
      /\btodo\s+app\b/.test(m) ||
      /\bapp\b[\s\S]{0,48}\bcalendar\b/.test(m) ||
      /\bcalendar\b[\s\S]{0,48}\bapp\b/.test(m) ||
      (/\bcalendar\b/.test(m) &&
        /\b(html|css|javascript|\bjs\b|web|browser|desktop|folder|file|vite|react)\b/.test(m));
    const fileTarget =
      /\b(write|save|put|drop|place)\b[\s\S]{0,40}\b(file|files|folder|directory|desktop|project)\b/.test(m) ||
      /\bon\s+(my\s+)?desktop\b/.test(m) ||
      /\bin\s+(a\s+)?folder\b/.test(m) ||
      /\bproject\s+root\b/.test(m);
    const codeHint =
      /\b(index\.html|package\.json|styles?\.css|script\.js|vite|next\.js|react|npm\s+init|tailwind)\b/.test(m);
    if (buildVerb && softwareArtifact) return true;
    if (buildVerb && fileTarget) return true;
    if (codeHint && (buildVerb || /\bnew\b/.test(m))) return true;
    return false;
  }

  /**
   * Natural LLM conversation (OpenAI). Optional ableton tool—no regex routing on the client.
   */
  async function runButlerOpenAiLlmChat(
    client,
    message,
    history,
    initImageB64,
    codeContext = '',
    cursorCliForOpenAi = null,
  ) {
    const abletonTool = {
      type: 'function',
      function: {
        name: 'ableton',
        description:
          'Control Ableton Live when the user wants the app to act on their session: connection status, play/stop transport, list tracks, set tempo/BPM, generate a drum MIDI pattern, build a dubstep-style session with samples, or scan the sample library.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'play', 'stop', 'tracks', 'tempo', 'midi', 'dubstep', 'samples'],
            },
            bpm: { type: 'number', description: 'Tempo or pattern BPM when action is tempo or midi.' },
          },
          required: ['action'],
        },
      },
    };

    const diagramTool = {
      type: 'function',
      function: {
        name: 'generate_diagram',
        description:
          "Generate one image with the user's local Stable Diffusion (ComfyUI) via Butler's API—text-to-image, diagrams, flowcharts, UI mockups, illustrations, or artwork. Call this when they want visuals, Stable Diffusion, ComfyUI, or text-to-image; do NOT tell them to pip install torch/diffusers or that you cannot run commands. One call per answer when a picture helps.",
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                'Rich English description of what to draw: layout, components, arrows/flow, labels, colors, style (e.g. "microservices diagram with API gateway, three services, database").',
            },
          },
          required: ['prompt'],
        },
      },
    };

    const isCodeHelperVariant = String(process.env.BUTLER_VARIANT || '').trim() === 'code-helper';
    let system =
      'You are Butler, a personal AI assistant. Reply in natural language—warm, clear, and conversational. The user never has to pick a "mode" or use special commands; they just talk. Infer jobs, code, images, apartment search, Ableton, and everything else from normal English.\n\n' +
      'The user is always the authority. If you are unsure, ask one short follow-up.\n\n' +
      'When they ask to build, create, or implement software (apps, sites, calendar, games): do NOT give Step-by-step "create a folder / paste this HTML" tutorials—this chat path cannot write files. Say briefly that Butler will create files through the main pipeline (turn off OpenAI-first if needed) or ask one clarifying question.\n\n' +
      'When they want code, fixes, or local apps: in Local mode the host applies JSON actions—write_file, download_file, run_command (npm, node, git, python, etc.), open_url. Use run_command with background:true for dev servers (vite, npm run dev); then open_url to http://localhost:PORT. Full disk access may be on in Settings—paths can be absolute anywhere. To rebuild Butler from source: cwd `ui`, `npm run build:app`, or repo root `npm run rebuild-butler`; they must restart the packaged exe.\n\n' +
      'Apartments: Butler runs real rental search from the app (Documents/Butlor, Listings, Facebook Marketplace)—do not substitute generic static HTML apartment tutorials unless they explicitly want a website project.\n\n' +
      'You can discuss jobs, resumes, gigs, apartments, music production, code, and everyday topics. ' +
      'When they clearly want Ableton Live to do something (not just music theory), call the ableton function with the right action. ' +
      'For tempo or drum patterns, set bpm when they specify a number; otherwise omit bpm for midi (defaults apply server-side).\n\n' +
      'When they want text-to-image, Stable Diffusion, ComfyUI, or any illustration, call generate_diagram with a rich prompt—Butler runs ComfyUI locally (HTTP), not Python snippets in chat. ' +
      'Never say you are unable to modify files, run commands, or install ML stacks for this—use the tool when appropriate. ' +
      'After a successful image, briefly describe what it shows. If generation fails, say ComfyUI/Knowledge API may be off—do not invent Hugging Face setup steps as if that were required inside Butler.';

    if (isCodeHelperVariant) {
      system +=
        '\n\n[Code Helper mode — learning only]\n' +
        'You are Code Helper: a learning-only assistant. Your entire purpose is to help the user learn to code (web/full-stack) and prepare for a career in software development.\n' +
        'Stay within: explanations, step-by-step learning plans, exercises, project ideas, debugging help, code review, portfolio guidance, interview practice, and job-search strategy.\n' +
        'Do NOT help with non-learning modules (apartments, music/Ableton, Stable Diffusion/images, 3D printing, network monitoring, automation). If asked, briefly say this build is for coding + career prep only, then redirect to a coding-relevant alternative.\n' +
        'CRITICAL: Do NOT ask the user for personal identifying information (real name, email, phone, address, passwords, employer names, school names, social links). If a resume/cover letter is requested, use placeholders like NAME, EMAIL, CITY, COMPANY, SCHOOL and label them as placeholders.\n' +
        'Ask only technical, task-focused questions needed to help them learn.\n' +
        'CRITICAL: This build must remain offline-first. Never suggest enabling cloud models or using OpenAI keys; assume local-only inference.';
    }

    const cc = String(codeContext || '').trim();
    if (cc.length > 0) {
      system += '\n\n[Background — code / project context from Butler]\n' + cc.slice(0, 12000);
    }
    const oci = cursorCliForOpenAi && typeof cursorCliForOpenAi === 'object' && cursorCliForOpenAi.enabled;
    if (oci) {
      let ocmd = typeof cursorCliForOpenAi.command === 'string' ? cursorCliForOpenAi.command.trim() : 'agent';
      if (!ocmd) ocmd = 'agent';
      if (ocmd.length > 200) ocmd = ocmd.slice(0, 200);
      if (/[&|;\n`$<>]/.test(ocmd)) ocmd = 'agent';
      system +=
        '\n\n[Cursor CLI enabled in Butler] Use run_command with `' +
        ocmd.replace(/`/g, "'") +
        '` and headless `-p` per Cursor docs; they ran `agent login` once; Butler project root should match their Cursor workspace folder. Shell only—not a Cursor IDE chat thread.';
    }

    const hist = (Array.isArray(history) ? history.slice(-16) : []).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    let userContent;
    const imgRaw = typeof initImageB64 === 'string' ? initImageB64.trim() : '';
    if (imgRaw.length > 80) {
      const b64 = imgRaw.replace(/^data:image\/\w+;base64,/, '');
      userContent = [
        { type: 'text', text: message || 'The user attached an image.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
      ];
    } else {
      userContent = message;
    }

    const messages = [
      { role: 'system', content: system },
      ...hist,
      { role: 'user', content: userContent },
    ];

    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools: isCodeHelperVariant ? [] : [abletonTool, diagramTool],
      tool_choice: 'auto',
    });

    const msg = completion.choices[0]?.message;
    if (!msg) return { reply: '' };

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const tc = msg.tool_calls[0];
      if (tc.type === 'function' && tc.function) {
        const fname = tc.function.name;
        let toolPayload = '';
        let diagramImages = undefined;

        if (fname === 'ableton') {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch (_) {}
          const atBody = { action: args.action || 'status', bpm: args.bpm };
          const atResult = await invokeAbletonAction(atBody);
          toolPayload =
            typeof atResult.message === 'string'
              ? atResult.message
              : JSON.stringify(atResult);
        } else if (fname === 'generate_diagram') {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch (_) {}
          const rawPrompt = (args.prompt || '').trim();
          if (!rawPrompt) {
            toolPayload = JSON.stringify({ ok: false, message: 'No image prompt was provided.' });
          } else {
            const sdPrompt =
              `${rawPrompt}, clean educational diagram or schematic illustration, clear composition, legible text and labels, infographic or textbook style, soft even lighting, light neutral background, highly detailed`;
            const neg =
              'blurry, illegible text, watermark, cropped, nsfw, photorealistic human face, cluttered mess, dark muddy, low resolution';
            try {
              const diagramWorkflow = (process.env.BUTLER_DIAGRAM_TXT2IMG_WORKFLOW || '').trim();
              const sdBody = {
                prompt: sdPrompt,
                negative_prompt: neg,
                width: 1024,
                height: 768,
              };
              if (diagramWorkflow) sdBody.workflow = diagramWorkflow;
              const r = await fetch(LOCAL_AI_URL + '/sd/txt2img', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sdBody),
                signal: AbortSignal.timeout(360000),
              });
              const data = await r.json();
              fillSdPayloadFromDisk(data);
              if (data.ok && data.images && data.images.length > 0) {
                diagramImages = data.images;
                toolPayload = JSON.stringify({
                  ok: true,
                  message:
                    'Image generated successfully. The app shows it under your reply—summarize what it depicts and connect it to the user question.',
                });
              } else {
                toolPayload = JSON.stringify({
                  ok: false,
                  message: data.message || 'ComfyUI did not return an image.',
                });
              }
            } catch (err) {
              toolPayload = JSON.stringify({
                ok: false,
                message: 'Could not reach local ComfyUI / Knowledge API for images: ' + (err?.message || String(err)),
              });
            }
          }
        } else {
          toolPayload = JSON.stringify({ ok: false, message: 'Unknown tool: ' + fname });
        }

        const followUp = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: system },
            ...hist,
            { role: 'user', content: userContent },
            {
              role: 'assistant',
              content: msg.content || null,
              tool_calls: msg.tool_calls,
            },
            {
              role: 'tool',
              tool_call_id: tc.id,
              content: toolPayload,
            },
          ],
        });
        const text = (followUp.choices[0]?.message?.content || '').trim();
        return { reply: text || toolPayload, images: diagramImages };
      }
    }

    const text = (msg.content || '').trim();
    return { reply: text };
  }

  api.post('/api/chat', async (req, res) => {
    try {
      const { message, history, sessionId = 'default', localOnly: reqLocalOnly, init_image: reqInitImage } = req.body || {};
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message is required' });
      }

      const codeContext =
        typeof req.body?.codeContext === 'string' ? String(req.body.codeContext).trim().slice(0, 12000) : '';
      const rawCursorCli = req.body?.cursorCli;
      let cursor_cli = null;
      if (rawCursorCli && typeof rawCursorCli === 'object' && rawCursorCli.enabled) {
        let ccmd = typeof rawCursorCli.command === 'string' ? rawCursorCli.command.trim() : 'agent';
        if (!ccmd) ccmd = 'agent';
        if (ccmd.length > 200) ccmd = ccmd.slice(0, 200);
        if (/[&|;\n`$<>]/.test(ccmd)) ccmd = 'agent';
        cursor_cli = { enabled: true, command: ccmd };
      }
      const learnCtx = (assistantReply) => learnFromConversation(message, assistantReply, 'conversation');

      fetch(LOCAL_AI_URL + '/learn/research_topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          prior_messages: Array.isArray(history) ? history.slice(-12) : [],
        }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});

      const projectRoot = await ensureProjectRoot(String(sessionId));
      const session = sessions.get(sessionId) || { answers: {}, pendingQuestions: [] };

      if (session.pendingQuestions.length > 0) {
        const current = session.pendingQuestions.shift();
        session.answers[current.id] = message;
        sessions.set(sessionId, session);
        if (session.pendingQuestions.length > 0) {
          const next = session.pendingQuestions[0];
          const reply = next.prompt || 'Please provide the next value.';
          learnCtx(reply);
          return res.json({ reply, source: 'Local (' + (process.env.LOCAL_MODEL || 'AI') + ')' });
        }
        // Just finished last question—if it was apartment setup, save config
        if (current?.id?.startsWith('apt_')) {
          const config = {
            location: session.answers.apt_location || session.answers.location,
            max_rent: session.answers.apt_max_rent || session.answers.max_rent,
            bedrooms: session.answers.apt_bedrooms || session.answers.bedrooms,
            run_at: '08:00',
          };
          try {
            await fetch(LOCAL_AI_URL + '/apartments/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(config),
              signal: AbortSignal.timeout(5000),
            });
          } catch (_) {}
          const reply =
            "Saved! I'll search apartments in " +
            config.location +
            ' (max $' +
            config.max_rent +
            ', ' +
            config.bedrooms +
            ' bed). Results save to your Documents/Butlor folder (apartment_listings_latest.txt) each morning at 8am. Ask me to run the apartment search whenever you want results now.';
          learnCtx(reply);
          learnActivity(
            'Apartment search configured: ' +
              JSON.stringify({ location: config.location, max_rent: config.max_rent, bedrooms: config.bedrooms }),
            'apartments_config_saved',
            { research_hint: String(message || '').slice(0, 400) },
          );
          learnIntent(message, 'apartments_config_saved', {
            location: String(config.location || ''),
            max_rent: String(config.max_rent || ''),
            bedrooms: String(config.bedrooms || ''),
          });
          return res.json({ reply, source: 'Apartments' });
        }
      }

      const rawLocal = req.body?.localOnly ?? req.body?.local_only;
      let localOnly = false;
      if (typeof rawLocal === 'boolean') {
        localOnly = rawLocal;
      } else if (rawLocal === 'true' || rawLocal === 1 || rawLocal === '1') {
        localOnly = true;
      } else if (rawLocal === 'false' || rawLocal === 0 || rawLocal === '0') {
        localOnly = false;
      } else {
        localOnly = readButlerLocalOnlyFromConfig();
      }
      const openaiKey = localOnly ? '' : readOpenAIKey();

      const hasInitImage = typeof reqInitImage === 'string' && reqInitImage.trim().length > 80;

      const rawAtt = req.body?.attachment;
      let chatAttachment = null;
      if (
        rawAtt &&
        typeof rawAtt === 'object' &&
        rawAtt !== null &&
        typeof rawAtt.data_base64 === 'string' &&
        rawAtt.data_base64.trim().length > 8
      ) {
        chatAttachment = {
          filename: String(rawAtt.filename || rawAtt.name || 'attachment').slice(0, 500),
          mime_type: String(rawAtt.mime_type || rawAtt.mime || 'application/octet-stream').slice(0, 200),
          data_base64: rawAtt.data_base64.trim(),
        };
      }

      const moduleHint = typeof req.body?.module === 'string' ? String(req.body.module).trim().slice(0, 200) : '';

      // Cloud OpenAI first is opt-in (local model + /learn + web runs first by default). Set BUTLER_OPENAI_FIRST=1 to restore old behavior.
      const openaiFirst =
        process.env.BUTLER_OPENAI_FIRST === '1' ||
        process.env.BUTLOR_OPENAI_FIRST === '1' ||
        !!req.body?.openaiFirst;
      const buildOrFiles = looksLikeBuildOrFileRequest(message);
      if (openaiFirst && openaiKey && !localOnly && !hasInitImage && !chatAttachment && !buildOrFiles) {
        try {
          const { default: OpenAI } = await import('openai');
          const client = new OpenAI({ apiKey: openaiKey });
          const llmOut = await runButlerOpenAiLlmChat(client, message, history, '', codeContext, cursor_cli);
          if (llmOut && llmOut.reply) {
            if (llmOut.images && llmOut.images[0]) {
              session.lastGeneratedImage = llmOut.images[0];
            }
            sessions.set(sessionId, session);
            learnCtx(llmOut.reply);
            return res.json({
              reply: llmOut.reply,
              source: llmOut.images?.length ? 'OpenAI + Stable Diffusion' : 'OpenAI',
              images: llmOut.images || undefined,
            });
          }
        } catch (llmErr) {
          console.error('OpenAI LLM chat failed:', llmErr?.message || llmErr);
        }
      }

      const sampleFiles = await collectFiles(projectRoot);

      const chatRes = await fetch(LOCAL_AI_URL + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          prior_messages: Array.isArray(history) ? history : [],
          known_answers: session.answers,
          sample_files: sampleFiles,
          project_root: projectRoot,
          // When Local only is on, do not send the key to Knowledge API — agent skips OpenAI structured passes.
          openai_api_key: localOnly ? '' : (openaiKey || ''),
          local_only: localOnly,
          file_policy: buildButlerFilePolicyForModel() || undefined,
          ...(codeContext.length > 0 ? { code_context: codeContext } : {}),
          ...(cursor_cli ? { cursor_cli } : {}),
          ...(hasInitImage ? { init_image: String(reqInitImage).trim() } : {}),
          ...(chatAttachment ? { attachment: chatAttachment } : {}),
          ...(moduleHint ? { module_hint: moduleHint } : {}),
        }),
        signal: AbortSignal.timeout(getButlerChatAbortMs()),
      });
      if (!chatRes.ok) {
        const errBody = await chatRes.text();
        let errMsg = errBody;
        try {
          const errObj = JSON.parse(errBody);
          errMsg = errObj.error || errObj.message || errBody;
        } catch (_) {}
        return res.status(chatRes.status).json({
          error: 'local_ai_unavailable',
          message: chatRes.status === 503 ? (errMsg || 'Local AI not available. Start the Knowledge API and your model server.') : errMsg,
        });
      }
      let parsed = await chatRes.json();
      if (parsed && typeof parsed.mode === 'string') {
        parsed.mode = parsed.mode.toLowerCase().trim();
      }
      const source = parsed.source || ('Local (' + (process.env.LOCAL_MODEL || 'AI') + ')');

      if (parsed.mode === 'apartments_setup') {
        try {
          const r = await fetch(LOCAL_AI_URL + '/apartments/config', { signal: AbortSignal.timeout(5000) });
          const cfg = await r.json();
          session.pendingQuestions = [
            { id: 'apt_location', prompt: 'Which city or area should we search?' },
            { id: 'apt_max_rent', prompt: 'What monthly rent cap should we use?' },
            { id: 'apt_bedrooms', prompt: 'How many bedrooms?' },
          ];
          session.answers = { ...cfg };
          sessions.set(sessionId, session);
          const prefix = session.answers.apt_location ? 'Updating apartment search. ' : '';
          const reply = prefix + session.pendingQuestions[0].prompt;
          learnCtx(reply);
          learnIntent(message, 'apartments_setup', {});
          return res.json({ reply, source: 'Apartments' });
        } catch (_) {
          sessions.set(sessionId, session);
          const reply = parsed.reply || 'Could not start apartment setup. Is the Knowledge API running?';
          learnCtx(reply);
          return res.json({ reply, source: 'Apartments' });
        }
      }
      if (parsed.mode === 'apartments_show_config') {
        try {
          const r = await fetch(LOCAL_AI_URL + '/apartments/config', { signal: AbortSignal.timeout(5000) });
          const cfg = await r.json();
          const intro = String(parsed.reply || '').trim();
          const block = cfg.location || cfg.max_rent || cfg.bedrooms
            ? 'Current apartment search config:\n• Location: ' + (cfg.location || '—') + '\n• Max rent: ' + (cfg.max_rent || '—') + '\n• Bedrooms: ' + (cfg.bedrooms || '—') + '\n• Run at: ' + (cfg.run_at || '08:00') + '\n• Results file: Documents/Butlor/apartment_listings_latest.txt'
            : 'No apartment search is saved yet—you can configure location, rent cap, and bedrooms when you want.';
          const reply = intro ? intro + '\n\n' + block : block;
          sessions.set(sessionId, session);
          learnCtx(reply);
          learnIntent(message, 'apartments_show_config', {
            has_saved: !!(cfg.location || cfg.max_rent || cfg.bedrooms),
          });
          return res.json({ reply, source: 'Apartments' });
        } catch (_) {
          sessions.set(sessionId, session);
          return res.json({ reply: parsed.reply || 'Could not load apartment config.', source: 'Apartments' });
        }
      }
      if (parsed.mode === 'apartments_run') {
        try {
          const r = await fetch(LOCAL_AI_URL + '/apartments/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(60000),
          });
          const data = await r.json();
          const reply = data.ok
            ? data.message
            : (data.message || 'Apartment search failed. Set up apartment search first.');
          sessions.set(sessionId, session);
          learnCtx(reply);
          if (data.ok) {
            learnIntent(message, 'apartments_run', { query: (data.query || '').slice(0, 120) });
            learnActivity(
              'apartments_run completed. query=' + String(data.query || '').slice(0, 200),
              'apartments_run',
              { research_hint: String(message || '').slice(0, 400) },
            );
          }
          return res.json({
            reply,
            source: 'Apartments',
            listings: data.listings || [],
            query: data.query || '',
            paths: data.paths || null,
            facebookCount: data.facebook_count,
            ok: !!data.ok,
          });
        } catch (err) {
          const reply = 'Could not run apartment search. Make sure the Knowledge API is running.';
          sessions.set(sessionId, session);
          learnCtx(reply);
          return res.json({ reply, source: 'Apartments', listings: [], ok: false });
        }
      }

      if (parsed.mode === 'jobs_prepare_materials') {
        const urls = Array.isArray(parsed.urls)
          ? parsed.urls
              .map((u) => String(u).trim())
              .filter((u) => {
                const s = u.toLowerCase();
                return s.startsWith('http://') || s.startsWith('https://');
              })
          : [];
        if (urls.length === 0) {
          sessions.set(sessionId, session);
          const reply =
            parsed.reply ||
            'I need at least one job posting link in your message so I can tailor materials.';
          learnCtx(reply);
          return res.json({ reply, source });
        }
        try {
          const role = String(parsed.role || 'full stack developer').trim() || 'full stack developer';
          const r = await fetch(LOCAL_AI_URL + '/jobs/prepare_from_urls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls, role, openai_api_key: openaiKey }),
            signal: AbortSignal.timeout(120000),
          });
          const data = await r.json();
          const reply = data.ok ? data.message : (data.message || 'Could not prepare materials.');
          sessions.set(sessionId, session);
          learnCtx(reply);
          if (data.ok) learnIntent(message, 'jobs_prepare_materials', { urls_count: urls.length, role });
          return res.json({ reply, source: 'Butler' });
        } catch (err) {
          sessions.set(sessionId, session);
          return res.json({
            reply: 'Prepare materials failed: ' + (err?.message || err) + '. Is the Knowledge API running?',
            source: 'Butler',
          });
        }
      }

      if (parsed.mode === 'jobs_add') {
        const company = String(parsed.company || '').trim();
        const role = String(parsed.role || '').trim();
        if (!company || !role) {
          sessions.set(sessionId, session);
          const reply = parsed.reply || 'I need both a company name and a role title to add a job.';
          learnCtx(reply);
          return res.json({ reply, source: 'Jobs' });
        }
        try {
          const r = await fetch(LOCAL_AI_URL + '/jobs/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ company, role, status: 'applied' }),
            signal: AbortSignal.timeout(5000),
          });
          const data = await r.json();
          if (data.ok) {
            const reply =
              'Added: ' + role + ' at ' + company + '. I\'ll track it. Set an interview date when you get one.';
            sessions.set(sessionId, session);
            learnCtx(reply);
            learnIntent(message, 'jobs_add', { company, role });
            return res.json({ reply, source: 'Jobs' });
          }
        } catch (_) {}
        sessions.set(sessionId, session);
        return res.json({ reply: parsed.reply || 'Could not add that job.', source: 'Jobs' });
      }

      if (parsed.mode === 'jobs_check_email') {
        try {
          const r = await fetch(LOCAL_AI_URL + '/jobs/emails?limit=20', { signal: AbortSignal.timeout(15000) });
          const data = await r.json();
          if (data.ok && data.interview_invites?.length > 0) {
            const lines = data.interview_invites.map((i) =>
              '• ' + i.subject + ' (from: ' + i.from + ') – dates: ' + ((i.extracted_dates || []).join(', ') || 'see email'),
            );
            const reply = 'Found ' + data.interview_invites.length + ' email(s) that might be interview-related:\n\n' + lines.join('\n') + '\n\nCheck your inbox for details.';
            sessions.set(sessionId, session);
            learnCtx(reply);
            learnIntent(message, 'jobs_check_email', { invites: data.interview_invites.length });
            return res.json({ reply, source: 'Jobs' });
          }
          const reply = data.ok
            ? 'No obvious interview-related emails in recent messages. Make sure Gmail is configured (credentials + token in Documents/Butlor).'
            : (data.message || 'Could not fetch emails.');
          sessions.set(sessionId, session);
          learnCtx(reply);
          if (data.ok) learnIntent(message, 'jobs_check_email', { invites: 0 });
          return res.json({ reply, source: 'Jobs' });
        } catch (err) {
          sessions.set(sessionId, session);
          return res.json({ reply: parsed.reply || 'Could not check email.', source: 'Jobs' });
        }
      }

      if (parsed.mode === 'jobs_upcoming_interviews') {
        try {
          const r = await fetch(LOCAL_AI_URL + '/jobs/interviews?days=14', { signal: AbortSignal.timeout(5000) });
          const data = await r.json();
          if (data.ok && Array.isArray(data.interviews) && data.interviews.length > 0) {
            const lines = data.interviews.map((i) => '• ' + i.role + ' at ' + i.company + ' – ' + (i.interview_date || 'TBD'));
            const reply = 'Upcoming interviews (next 14 days):\n\n' + lines.join('\n');
            sessions.set(sessionId, session);
            learnCtx(reply);
            learnIntent(message, 'jobs_upcoming_interviews', { count: data.interviews.length });
            return res.json({ reply, source: 'Jobs' });
          }
          const reply = data.ok
            ? 'No upcoming interviews in the next 14 days. Add jobs and set interview dates when you get them.'
            : (data.message || 'Could not load interviews.');
          sessions.set(sessionId, session);
          learnCtx(reply);
          if (data.ok) learnIntent(message, 'jobs_upcoming_interviews', { count: 0 });
          return res.json({ reply, source: 'Jobs' });
        } catch (err) {
          sessions.set(sessionId, session);
          return res.json({ reply: parsed.reply || 'Could not load interviews.', source: 'Jobs' });
        }
      }

      if (parsed.mode === 'open_cursor') {
        const cursorExe =
          process.platform === 'win32'
            ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor', 'Cursor.exe')
            : 'cursor';
        const cmd = process.platform === 'win32' ? cursorExe : 'cursor';
        const canLaunch = process.platform !== 'win32' ? true : fs.existsSync(cursorExe);
        if (canLaunch) {
          const child = spawn(cmd, [projectRoot], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.on('error', () => {});
          child.unref();
        }
        sessions.set(sessionId, session);
        const reply = canLaunch
          ? (parsed.reply ? parsed.reply + '\n\n' : '') + 'Opening your project in Cursor.\n\nProject folder: ' + projectRoot
          : (parsed.reply ? parsed.reply + '\n\n' : '') +
            'Couldn\'t find Cursor. On Windows it\'s usually at:\n' +
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor') +
            '\n\nYou can open the folder manually:\n' +
            projectRoot;
        learnCtx(reply);
        if (canLaunch) learnIntent(message, 'open_cursor', {});
        return res.json({ reply, source });
      }

      if (parsed.mode === 'project_where') {
        sessions.set(sessionId, session);
        const base = 'Your project is saved at:\n' + projectRoot + '\n\nOpen that folder to see your files.';
        const reply = parsed.reply ? base + '\n\n' + parsed.reply : base;
        learnCtx(reply);
        learnIntent(message, 'project_where', { path: projectRoot });
        return res.json({ reply, source });
      }

      if (parsed.mode === 'sd_txt2img') {
        const dispatched = await respondWithSdTxt2img({
          txtPrompt: sdUserPromptOrModel(message, parsed.prompt),
          sdConnectivityTest: !!parsed.sd_connectivity_test,
          session,
          sessionId,
          sessions,
          localAiUrl: LOCAL_AI_URL,
          learnCtx,
          res,
          onImageSuccess: () => {
            learnIntent(message, 'sd_txt2img', {
              prompt: String(parsed.prompt || '').slice(0, 240),
              connectivity_test: !!parsed.sd_connectivity_test,
            });
            learnActivity(
              'sd_txt2img succeeded. Image prompt: ' + String(parsed.prompt || '').slice(0, 400),
              'sd_txt2img',
              { research_hint: String(message || '').slice(0, 400) },
            );
          },
        });
        if (dispatched) return;
        sessions.set(sessionId, session);
        return res.json({
          reply: parsed.reply || 'Describe the image you want in English (subject, style, mood).',
          source,
        });
      }

      if (parsed.mode === 'sd_img2img') {
        let lastImg = (hasInitImage ? String(reqInitImage).trim() : '') || session.lastGeneratedImage;
        if (!lastImg) lastImg = readDesktopRbBase64Sync();
        if (!lastImg) {
          sessions.set(sessionId, session);
          return res.json({
            reply:
              parsed.reply ||
              'Upload an image in the chat UI or generate one first, then ask to edit or restyle it.',
            source,
          });
        }
        await respondWithSdImg2img({
          prompt: sdUserPromptOrModel(message, parsed.prompt),
          userMessage: message,
          lastImg,
          session,
          sessionId,
          sessions,
          localAiUrl: LOCAL_AI_URL,
          learnCtx,
          res,
          compareNsfwTriple: parsed.compare_nsfw_triple,
          onImageSuccess: () => {
            learnIntent(message, 'sd_img2img', { prompt: String(parsed.prompt || '').slice(0, 240) });
            learnActivity(
              'sd_img2img succeeded. Edit prompt: ' + String(parsed.prompt || '').slice(0, 400),
              'sd_img2img',
              { research_hint: String(message || '').slice(0, 400) },
            );
          },
        });
        return;
      }

      if (parsed.mode === 'sd_image2video') {
        let lastImg = (hasInitImage ? String(reqInitImage).trim() : '') || session.lastGeneratedImage;
        if (!lastImg) lastImg = readDesktopRbBase64Sync();
        if (!lastImg) {
          sessions.set(sessionId, session);
          return res.json({
            reply: parsed.reply || 'Upload a still image first, then ask to animate it.',
            source,
          });
        }
        await respondWithSdImage2video({
          prompt: sdUserPromptOrModel(message, parsed.prompt),
          lastImg,
          session,
          sessionId,
          sessions,
          localAiUrl: LOCAL_AI_URL,
          learnCtx,
          res,
          onVideoSuccess: () => {
            learnIntent(message, 'sd_image2video', { prompt: String(parsed.prompt || '').slice(0, 240) });
            learnActivity(
              'sd_image2video succeeded. Motion prompt: ' + String(parsed.prompt || '').slice(0, 400),
              'sd_image2video',
              { research_hint: String(message || '').slice(0, 400) },
            );
          },
        });
        return;
      }

      if (parsed.mode === 'sd_txt2video') {
        const dispatched = await respondWithSdTxt2video({
          prompt: sdUserPromptOrModel(message, parsed.prompt),
          session,
          sessionId,
          sessions,
          localAiUrl: LOCAL_AI_URL,
          learnCtx,
          res,
          onVideoSuccess: () => {
            learnIntent(message, 'sd_txt2video', { prompt: String(parsed.prompt || '').slice(0, 240) });
            learnActivity(
              'sd_txt2video succeeded. Prompt: ' + String(parsed.prompt || '').slice(0, 400),
              'sd_txt2video',
              { research_hint: String(message || '').slice(0, 400) },
            );
          },
        });
        if (dispatched) return;
        sessions.set(sessionId, session);
        return res.json({
          reply: parsed.reply || 'Describe the video you want in English (subject, motion, mood).',
          source,
        });
      }

      if (parsed.mode === 'sound_musicgen') {
        const prompt = String(parsed.prompt || parsed.description || '').trim();
        if (!prompt) {
          sessions.set(sessionId, session);
          const q =
            parsed.reply ||
            'Describe the sound or music you want (genre, mood, instruments). I will generate a short free local sample (MusicGen).';
          learnCtx(q);
          return res.json({ reply: q, source });
        }
        try {
          const mgRes = await fetch(LOCAL_AI_URL + '/audio/musicgen', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt.slice(0, 800) }),
            signal: AbortSignal.timeout(600000),
          });
          const mgData = await mgRes.json().catch(() => ({}));
          if (mgData.ok && mgData.audio_b64) {
            sessions.set(sessionId, session);
            const reply =
              (parsed.reply ? String(parsed.reply).trim() + '\n\n' : '') +
              (mgData.message || 'Here is your generated audio — play it below.');
            learnCtx(reply);
            try {
              learnIntent(message, 'sound_musicgen', { prompt: prompt.slice(0, 280) });
              learnActivity(
                'sound_musicgen saved. ' + prompt.slice(0, 320),
                'sound_musicgen',
                { research_hint: String(message || '').slice(0, 400) },
              );
            } catch (_) {}
            return res.json({
              reply,
              source: 'MusicGen (local)',
              audio: mgData.audio_b64,
              path: mgData.path,
            });
          }
          sessions.set(sessionId, session);
          const fail =
            mgData.message ||
            'MusicGen is not available. Install: pip install -r knowledge/requirements-audio.txt (free; runs on your PC).';
          learnCtx(fail);
          return res.json({ reply: fail, source: 'MusicGen (local)' });
        } catch (err) {
          sessions.set(sessionId, session);
          const fail =
            'MusicGen request failed: ' +
            String((err && err.message) || err).slice(0, 400) +
            ' Ensure the Knowledge API is running.';
          learnCtx(fail);
          return res.json({ reply: fail, source: 'MusicGen (local)' });
        }
      }

      if (
        parsed.mode === 'spotify_seo_create' ||
        parsed.mode === 'spotify_seo_maintain' ||
        parsed.mode === 'spotify_seo_cycle' ||
        parsed.mode === 'spotify_seo_status'
      ) {
        const spotifyMode = parsed.mode;
        const pathByMode = {
          spotify_seo_status: '/spotify/status',
          spotify_seo_create: '/spotify/seo/create',
          spotify_seo_maintain: '/spotify/seo/maintain',
          spotify_seo_cycle: '/spotify/seo/cycle',
        };
        const path = pathByMode[spotifyMode];
        const isGet = spotifyMode === 'spotify_seo_status';
        try {
          const body = {
            niche: parsed.niche || '',
            niches: Array.isArray(parsed.niches) ? parsed.niches : undefined,
            name: parsed.name || undefined,
            keywords: parsed.keywords || undefined,
            dry_run: !!parsed.dry_run,
          };
          const spRes = await fetch(LOCAL_AI_URL + path, {
            method: isGet ? 'GET' : 'POST',
            headers: isGet ? undefined : { 'Content-Type': 'application/json' },
            body: isGet ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
          });
          const spData = await spRes.json().catch(() => ({}));
          sessions.set(sessionId, session);
          let reply =
            (parsed.reply ? String(parsed.reply).trim() + '\n\n' : '') +
            (spData.message || (spData.ok ? 'Done.' : 'Spotify SEO request failed.'));
          if (spData.playlist && spData.playlist.url) {
            reply += '\n' + spData.playlist.url;
          }
          if (Array.isArray(spData.playlists) && spData.playlists.length) {
            const lines = spData.playlists
              .slice(0, 12)
              .map((p) => `- ${(p && p.name) || 'playlist'}: ${(p && p.url) || p.id || ''}`)
              .join('\n');
            reply += '\n\n' + lines;
          }
          if (!spData.ok && spData.connected === false) {
            reply +=
              '\n\nConnect Spotify: set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env, then run `npm run spotify:oauth` (or `python knowledge/spotify_oauth_setup.py`).';
          }
          learnCtx(reply);
          try {
            learnIntent(message, spotifyMode, {
              niche: String(parsed.niche || '').slice(0, 120),
            });
          } catch (_) {}
          return res.json({
            reply,
            source: 'Spotify SEO',
            spotify: spData,
          });
        } catch (err) {
          sessions.set(sessionId, session);
          const fail =
            'Spotify SEO request failed: ' +
            String((err && err.message) || err).slice(0, 400) +
            ' Ensure the Knowledge API is running.';
          learnCtx(fail);
          return res.json({ reply: fail, source: 'Spotify SEO' });
        }
      }

      if (
        parsed.mode === 'artist_project_show' ||
        parsed.mode === 'artist_project_update' ||
        parsed.mode === 'artist_project_sync'
      ) {
        const artMode = parsed.mode;
        try {
          let artRes;
          if (artMode === 'artist_project_show') {
            artRes = await fetch(LOCAL_AI_URL + '/artist/project', {
              method: 'GET',
              signal: AbortSignal.timeout(30000),
            });
          } else if (artMode === 'artist_project_sync') {
            artRes = await fetch(LOCAL_AI_URL + '/artist/project/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                source: parsed.source || 'all',
                artist_id: parsed.artist_id || parsed.artistId || undefined,
                force: !!parsed.force,
              }),
              signal: AbortSignal.timeout(120000),
            });
          } else {
            const updates = {};
            const keys = [
              'artist_name',
              'aliases',
              'bio',
              'tagline',
              'location',
              'genres',
              'subgenres',
              'moods',
              'themes',
              'keywords',
              'seo_niches',
              'similar_artists',
              'collaborators',
              'spotify_artist_ids',
              'track_uris',
              'track_titles',
              'target_audience',
              'brand_voice',
              'do_not_associate',
              'notes',
              'bpm_ranges',
              'cities',
            ];
            for (const k of keys) {
              if (parsed[k] != null && parsed[k] !== '') updates[k] = parsed[k];
            }
            artRes = await fetch(LOCAL_AI_URL + '/artist/project', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(updates),
              signal: AbortSignal.timeout(30000),
            });
          }
          const artData = await artRes.json().catch(() => ({}));
          sessions.set(sessionId, session);
          const proj = artData.project || {};
          let reply =
            (parsed.reply ? String(parsed.reply).trim() + '\n\n' : '') +
            (artData.message || (artData.ok ? 'Artist project updated.' : 'Artist project request failed.'));
          if (proj.artist_name) reply += `\n\nArtist: ${proj.artist_name}`;
          if (Array.isArray(proj.genres) && proj.genres.length) {
            reply += `\nGenres: ${proj.genres.slice(0, 10).join(', ')}`;
          }
          if (Array.isArray(proj.seo_niches) && proj.seo_niches.length) {
            reply += `\nSEO niches: ${proj.seo_niches.slice(0, 10).join(', ')}`;
          }
          if (Array.isArray(proj.keywords) && proj.keywords.length) {
            reply += `\nKeywords: ${proj.keywords.slice(0, 12).join(', ')}`;
          }
          if (Array.isArray(proj.similar_artists) && proj.similar_artists.length) {
            reply += `\nSimilar: ${proj.similar_artists.slice(0, 8).join(', ')}`;
          }
          if (Array.isArray(proj.track_titles) && proj.track_titles.length) {
            reply += `\nTracks: ${proj.track_titles.slice(0, 10).join(', ')}`;
          }
          learnCtx(reply);
          try {
            learnIntent(message, artMode, { artist: String(proj.artist_name || '').slice(0, 80) });
          } catch (_) {}
          return res.json({ reply, source: 'Artist project', artist_project: artData });
        } catch (err) {
          sessions.set(sessionId, session);
          const fail =
            'Artist project request failed: ' +
            String((err && err.message) || err).slice(0, 400) +
            ' Ensure the Knowledge API is running.';
          learnCtx(fail);
          return res.json({ reply: fail, source: 'Artist project' });
        }
      }

      if (parsed.mode === 'print3d') {
        const desc = String(parsed.description || parsed.prompt || '').trim();
        if (!desc) {
          sessions.set(sessionId, session);
          const q =
            parsed.reply ||
            'Describe the part in plain English—shape, size, details. I will save an STL under your Butler data folder (print3d/) when OpenSCAD CLI is installed.';
          learnCtx(q);
          return res.json({ reply: q, source });
        }
        const modPath = app.isPackaged
          ? path.join(process.resourcesPath, 'print3d-openscad.mjs')
          : path.join(__dirname, '../../print3d-openscad.mjs');
        if (!fs.existsSync(modPath)) {
          sessions.set(sessionId, session);
          const q = '3D print support is missing from this build. Reinstall Butler or run from a dev checkout.';
          learnCtx(q);
          return res.json({ reply: q, source });
        }
        try {
          const { pathToFileURL } = require('url');
          const { runPrint3dChatPipeline } = await import(pathToFileURL(modPath).href);
          await fsp.mkdir(getButlorConfigDirAbs(), { recursive: true });
          const result = await runPrint3dChatPipeline({
            butlorDataRoot: getButlorConfigDirAbs(),
            description: desc.slice(0, 2000),
            localOnly,
            hasOpenAiKey: !!openaiKey,
            knowledgeApiUrl: LOCAL_AI_URL,
            openaiApiKey: openaiKey,
          });
          const pathsStr = (result.paths || []).join('\n');
          let reply = (parsed.reply ? String(parsed.reply).trim() + '\n\n' : '') + `3D print (${result.engine}).`;
          if (result.openscad_render_ok) reply += ' STL file saved.';
          else if (result.openscad_hint) reply += ' ' + result.openscad_hint;
          if (pathsStr) reply += '\n\n' + pathsStr;
          sessions.set(sessionId, session);
          learnCtx(reply);
          try {
            learnIntent(message, 'print3d', { description: desc.slice(0, 280) });
            learnActivity(
              'print3d saved. ' + desc.slice(0, 320),
              'print3d',
              { research_hint: String(message || '').slice(0, 400) },
            );
          } catch (_) {}
          return res.json({ reply, source: '3D print', print3d: result });
        } catch (err) {
          sessions.set(sessionId, session);
          const fail =
            '3D print failed: ' +
            String((err && err.message) || err).slice(0, 500) +
            (localOnly
              ? ' With Local only: Knowledge API (8765) calls your **local LLM** at BUTLOR_AI_URL (default port 5000). If you see :5000 refused, run `knowledge/ai_server.py` or set BUTLOR_AI_URL to LM Studio/Ollama.'
              : '');
          learnCtx(fail);
          return res.json({ reply: fail, source });
        }
      }

      // AI understood intent: execute instead of replying with chat
      if (parsed.mode === 'jobs_auto_apply') {
        try {
          const description = (parsed.description || '').trim();
          const role = (parsed.role || 'software engineer').trim();
          const location = (parsed.location || '').trim();
          const maxJobs = Math.min(20, Math.max(1, parseInt(parsed.max_jobs, 10) || 10));
          const autoSubmit = !!parsed.auto_submit;
          const body = { max_jobs: maxJobs, openai_api_key: readOpenAIKey(), auto_submit: autoSubmit };
          if (description) body.description = description;
          else Object.assign(body, { role, location });
          const r = await fetch(LOCAL_AI_URL + '/jobs/auto_apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180000),
          });
          const data = await r.json();
          const reply = data.ok
            ? data.message
            : (data.message || 'Auto-apply failed. Add your resume to Documents/Butlor/profile.json and set OpenAI key in settings.');
          sessions.set(sessionId, session);
          learnCtx(reply);
          if (data.ok) {
            learnIntent(message, 'jobs_auto_apply', description ? { description, max_jobs: maxJobs, auto_submit: autoSubmit } : { role, location, max_jobs: maxJobs, auto_submit: autoSubmit });
            learnActivity(
              'jobs_auto_apply completed. ' +
                (description ? 'description: ' + description.slice(0, 280) : 'role=' + role + ' location=' + location),
              'jobs_auto_apply',
              { research_hint: String(message || '').slice(0, 400) },
            );
          }
          return res.json({ reply, source: 'Butler' });
        } catch (err) {
          sessions.set(sessionId, session);
          learnCtx(parsed.reply || 'Job apply failed.');
          return res.json({ reply: parsed.reply || 'Could not run auto-apply. Is the Knowledge API running?', source });
        }
      }
      if (parsed.mode === 'gigs_run') {
        try {
          const skills = (parsed.skills || 'frontend development, transcription').trim();
          const maxGigs = Math.min(10, Math.max(1, parseInt(parsed.max_gigs, 10) || 5));
          const r = await fetch(LOCAL_AI_URL + '/gigs/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              skills,
              max_gigs: maxGigs,
              openai_api_key: readOpenAIKey(),
            }),
            signal: AbortSignal.timeout(120000),
          });
          const data = await r.json();
          let reply = data.ok ? data.message : (data.message || 'Gig run failed.');
          if (data.ok && data.queued && data.urls?.length) {
            data.urls.forEach((url) => { try { shell.openExternal(url); } catch (_) {} });
          }
          if (data.ok && data.gigs_path && fs.existsSync(data.gigs_path)) {
            try { shell.openPath(data.gigs_path); } catch (_) {}
            reply += '\n\nOpened gigs in your browser and proposals file.';
          }
          sessions.set(sessionId, session);
          learnCtx(reply);
          if (data.ok) {
            learnIntent(message, 'gigs_run', { skills, max_gigs: maxGigs });
            learnActivity(
              'gigs_run completed. skills=' + skills.slice(0, 200) + ' max_gigs=' + maxGigs,
              'gigs_run',
              { research_hint: String(message || '').slice(0, 400) },
            );
          }
          return res.json({ reply, source: 'Butler' });
        } catch (err) {
          sessions.set(sessionId, session);
          learnCtx(parsed.reply || 'Gigs failed.');
          return res.json({ reply: parsed.reply || 'Could not run gigs.', source });
        }
      }

      const isFallbackMsg = (r) =>
        typeof r === 'string' &&
        (r.includes('I\'m still learning from our conversations') ||
          (r.includes('I\'m here for you') && r.includes('learn your style')));

      // True only for short canned *greetings* from the local model — used for OpenAI rescue + one build hint.
      // Do NOT use this to replace normal chat replies (too many false positives; users saw a stuck canned message).
      const isGenericFallback = (r) => {
        if (typeof r !== 'string') return false;
        const t = r.trim();
        const n = t.length;
        const low = t.replace(/\u2019/g, "'").replace(/\u2018/g, "'").toLowerCase();
        if (low.includes('how can i help you today') && n < 260) return true;
        if ((low.includes("i'm here for you") || low.includes('i am here for you')) && n < 220) return true;
        if (low.includes('chat with me about anything') && n < 200) return true;
        if (low.includes('learn your style') && n < 250) return true;
        return false;
      };

      const BUILD_REQUEST_LOCAL_MODEL_FALLBACK =
        'Your local model returned chat instead of JSON actions, and OpenAI structured intent did not produce actions either. Save your OpenAI key in Settings (Save), restart the Knowledge API (python api_server.py), and try again. If it persists, check that the key is valid and that outbound HTTPS to api.openai.com works. Your phrasing is fine.';

      // When local model returns generic greeting, try OpenAI if available (disable with BUTLER_OPENAI_FALLBACK=0)
      const openaiFallbackEnabled = process.env.BUTLER_OPENAI_FALLBACK !== '0';
      const tryOpenAIForGeneric =
        openaiFallbackEnabled &&
        !localOnly &&
        parsed.mode === 'chat' &&
        parsed.reply &&
        (isFallbackMsg(parsed.reply) || isGenericFallback(parsed.reply)) &&
        openaiKey &&
        !buildOrFiles;

      if (tryOpenAIForGeneric) {
        try {
          const { default: OpenAI } = await import('openai');
          const client = new OpenAI({ apiKey: openaiKey });
          const fallbackMessages = [
            { role: 'system', content: 'You are Butler, the user\'s AI. Build web apps (HTML, CSS, JS). User is always right. Be helpful and actionable.' },
            ...(Array.isArray(history) ? history.slice(-6) : []).map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
            })),
            { role: 'user', content: message },
          ];
          const completion = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: fallbackMessages,
          });
          const reply = (completion.choices[0]?.message?.content || '').trim();
          if (reply) {
            sessions.set(sessionId, session);
            learnCtx(reply);
            return res.json({ reply, source: 'OpenAI' });
          }
        } catch (err) {
          console.error('OpenAI fallback failed:', err?.message || err);
        }
      }

      if (parsed.mode === 'chat' && parsed.reply) {
        const reply =
          isGenericFallback(parsed.reply) && buildOrFiles
            ? BUILD_REQUEST_LOCAL_MODEL_FALLBACK
            : String(parsed.reply);
        sessions.set(sessionId, session);
        learnCtx(reply);
        return res.json({ reply, source });
      }

      if (parsed.mode === 'questions' && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
        session.pendingQuestions = parsed.questions;
        sessions.set(sessionId, session);
        const q = parsed.questions[0].prompt || 'I need one detail before proceeding.';
        learnCtx(q);
        return res.json({ reply: q, source });
      }

      if (parsed.mode !== 'actions') {
        let reply = parsed.reply || 'I could not determine actions to run. Please refine your request.';
        if (isGenericFallback(reply) && buildOrFiles) {
          reply = BUILD_REQUEST_LOCAL_MODEL_FALLBACK;
        }
        learnCtx(reply);
        return res.json({ reply, source });
      }

      const maxRetries = getActionsAutonomyMaxRetries();
      const innerMax = getActionsAutonomyInnerMax();
      let currentParsed = parsed;
      const autonomyRounds = [];
      const autonomyLog = [];
      let lastSlotRecoveries = 0;
      const al = (msg) => {
        const line = '[' + new Date().toISOString().slice(11, 23) + '] ' + msg;
        autonomyLog.push(line);
        console.log('[Butler autonomy]', msg);
      };

      const followCtx = {
        history,
        session,
        projectRoot,
        localOnly,
        openaiKey,
        codeContext,
        cursor_cli,
        hasInitImage,
        reqInitImage,
        chatAttachment,
        sampleFiles,
        moduleHint,
      };

      try {
        al(
          'Starting actions autonomy — up to ' +
            (maxRetries + 1) +
            ' apply round(s), up to ' +
            innerMax +
            ' model follow-up(s) per failed apply (env BUTLER_ACTIONS_AUTONOMY_ROUNDS / BUTLER_ACTIONS_AUTONOMY_INNER).',
        );

        let attempt = 0;
        autonomyLoop: while (attempt <= maxRetries) {
          try {
            al('Apply round ' + (attempt + 1) + '/' + (maxRetries + 1) + ': running write_file / run_command on disk…');
            const applySummary = await applyActions(projectRoot, currentParsed.actions || []);
          const prevFails = autonomyRounds.filter((r) => r.ok === false);
          autonomyRounds.push({
            attempt: attempt + 1,
            ok: true,
            summary: currentParsed.summary || '',
            applySummary,
          });

          const nextSteps = Array.isArray(currentParsed.next_steps) ? currentParsed.next_steps : [];
          let reply = currentParsed.summary || 'Applied changes to your project.';
          if (prevFails.length > 0) {
            reply = '**Succeeded on apply round ' + (attempt + 1) + '.**\n\n' + reply;
          }
          const bg = applySummary.backgroundCommands || [];
          const opened = applySummary.openedUrls || [];
          if (
            applySummary.files.length ||
            applySummary.downloads.length ||
            applySummary.commands.length ||
            bg.length ||
            opened.length
          ) {
            reply +=
              '\n\nChanged ' +
              applySummary.files.length +
              ' file(s), downloaded ' +
              applySummary.downloads.length +
              ', ran ' +
              applySummary.commands.length +
              ' command(s)' +
              (bg.length ? ', started ' + bg.length + ' background process(es)' : '') +
              (opened.length ? ', opened ' + opened.length + ' URL(s)' : '') +
              '.';
          }
          if (bg.length) {
            reply +=
              '\n\nBackground: ' +
              bg.map((b) => String(b.command) + (b.pid ? ' (pid ' + b.pid + ')' : '')).join('; ');
          }
          if (opened.length) {
            reply += '\n\nOpened in browser: ' + opened.join(', ');
          }
          reply += '\n\nProject folder: ' + projectRoot;

          const progress_messages = prevFails.map((r) =>
            r.phase === 'model_not_actions' && r.model_snippet
              ? '**Progress (model not in actions mode)**\n' +
                  String(r.error || '').slice(0, 600) +
                  '\n\n' +
                  String(r.model_snippet).slice(0, 900)
              : '**Progress (host error)**\n' + String(r.error || '').slice(0, 1800),
          );

            sessions.set(sessionId, session);
            recordApplySummaryLearning(message, applySummary);
            learnCtx(reply);
            try {
              learnIntent(message, 'code_actions', {
                files: (applySummary.files || []).slice(0, 15).join(';'),
                downloads: (applySummary.downloads || []).length,
                commands: (applySummary.commands || []).length,
                background: (applySummary.backgroundCommands || []).length,
                opened_urls: (applySummary.openedUrls || []).length,
              });
            } catch (_) {}

            al('Success — all commands in this plan finished (round ' + (attempt + 1) + ').');
            const okPayload = {
              reply,
              summary: currentParsed.summary || '',
              nextSteps,
              projectRoot,
              applySummary,
              source,
              autonomy_rounds: autonomyRounds,
              autonomy_log: autonomyLog,
            };
            if (progress_messages.length > 0) okPayload.progress_messages = progress_messages;
            return res.json(okPayload);
          } catch (err) {
            autonomyRounds.push({
              attempt: attempt + 1,
              ok: false,
              phase: 'apply_error',
              error: String((err && err.message) || err).slice(0, 12000),
            });
            al(
              'Apply failed — ' +
                String((err && err.message) || err)
                  .split('\n')[0]
                  .slice(0, 200) +
                '… Continuing: re-asking Knowledge API for a corrected mode:actions plan.',
            );

          let sampleFilesRetry = sampleFiles;
          try {
            sampleFilesRetry = await collectFiles(projectRoot);
          } catch (_) {
            sampleFilesRetry = sampleFiles;
          }

          const baseFix =
            '[HOST] Butler could not apply actions (apply round ' +
            (attempt + 1) +
            ' of ' +
            (maxRetries + 1) +
            ').\n\n' +
            'Error:\n' +
            String((err && err.message) || err).slice(0, 14000) +
            '\n\n' +
            'Return JSON with mode "actions" only—fix commands, paths, or package names. ' +
            (isButlerOwnerMode()
              ? ''
              : 'There is no npm package named "kali-tools" (404 on registry); use real dependencies or document OS-level tools.\n\n') +
            "The user's original request was:\n" +
            message;

          let innerFix = baseFix;
          let gotNewActions = false;

            for (let inner = 0; inner < innerMax; inner++) {
              try {
                al(
                  'Continuing — follow-up ' +
                    (inner + 1) +
                    '/' +
                    innerMax +
                    ': POST ' +
                    LOCAL_AI_URL +
                    '/chat (asking model to fix plan)…',
                );
                const out = await runKnowledgeFollowUpOnceElectron(innerFix, {
                  ...followCtx,
                  sampleFiles: sampleFilesRetry,
                });
                if (!out.ok) {
                  al('Follow-up HTTP error ' + (out.httpStatus || '?') + '. Will retry inner prompt or next round.');
                  autonomyRounds.push({
                    attempt: attempt + 1,
                    inner: inner + 1,
                    ok: false,
                    phase: 'followup_http',
                    error: out.bodySnippet || 'Knowledge API HTTP ' + (out.httpStatus || '?'),
                  });
                  innerFix =
                    baseFix +
                    '\n\n[Previous follow-up failed (' +
                    (out.httpStatus || '?') +
                    '). Return valid JSON with mode "actions" only.]';
                  continue;
                }
                const nextParsed = out.parsed;
                if (nextParsed && typeof nextParsed.mode === 'string') {
                  nextParsed.mode = nextParsed.mode.toLowerCase().trim();
                }
                if (
                  nextParsed &&
                  nextParsed.mode === 'actions' &&
                  Array.isArray(nextParsed.actions) &&
                  nextParsed.actions.length > 0
                ) {
                  currentParsed = nextParsed;
                  gotNewActions = true;
                  al(
                    'Continuing — model returned new mode:actions (' +
                      nextParsed.actions.length +
                      ' action(s)). Retrying apply from the top of the loop…',
                  );
                  autonomyRounds.push({
                    attempt: attempt + 1,
                    inner: inner + 1,
                    ok: true,
                    phase: 'new_actions_from_model',
                    summary: nextParsed.summary || '',
                  });
                  if (attempt < maxRetries) {
                    attempt++;
                    lastSlotRecoveries = 0;
                  } else {
                    lastSlotRecoveries++;
                    if (lastSlotRecoveries > innerMax) {
                      al(
                        'Recovery attempts on final apply round exceeded inner limit (' +
                          innerMax +
                          '). Stopping.',
                      );
                      break autonomyLoop;
                    }
                  }
                  continue autonomyLoop;
                }
                al(
                  'Model did not return executable actions (mode=' +
                    (nextParsed && nextParsed.mode ? nextParsed.mode : '?') +
                    '). Trying stricter prompt (inner ' +
                    (inner + 1) +
                    '/' +
                    innerMax +
                    ')…',
                );
                const snippet =
                  nextParsed && nextParsed.mode === 'chat' && nextParsed.reply
                    ? String(nextParsed.reply).slice(0, 1200)
                    : JSON.stringify(nextParsed || {}).slice(0, 1200);
                autonomyRounds.push({
                  attempt: attempt + 1,
                  inner: inner + 1,
                  ok: false,
                  phase: 'model_not_actions',
                  error: 'Expected mode "actions" with non-empty actions; got mode=' + (nextParsed && nextParsed.mode ? nextParsed.mode : '?'),
                  model_snippet: snippet,
                });
                innerFix =
                  '[HOST] The Butler host only executes mode "actions" (write_file, run_command, …). ' +
                  'You responded with mode "' +
                  (nextParsed && nextParsed.mode ? nextParsed.mode : '?') +
                  '" which cannot run shell commands on disk. ' +
                  'Reply again with JSON: {"mode":"actions","summary":"...","actions":[...]}.\n\n' +
                  'Error to fix:\n' +
                  String((err && err.message) || err).slice(0, 14000) +
                  '\n\n' +
                  'User request:\n' +
                  message;
              } catch (followErr) {
                al('Follow-up request threw: ' + String((followErr && followErr.message) || followErr).slice(0, 120));
                autonomyRounds.push({
                  attempt: attempt + 1,
                  inner: inner + 1,
                  ok: false,
                  phase: 'followup_exception',
                  error: String((followErr && followErr.message) || followErr).slice(0, 2000),
                });
                innerFix =
                  baseFix +
                  '\n\n[Follow-up threw: ' +
                  String((followErr && followErr.message) || followErr).slice(0, 500) +
                  ' — return mode "actions" JSON.]';
              }
            }

            if (!gotNewActions) {
              al('Could not obtain new mode:actions after inner follow-ups. Stopping autonomy.');
              break autonomyLoop;
            }
          }
        }

        const lastErr = autonomyRounds.filter((r) => r.ok === false).pop();
        const failProgress = autonomyRounds
          .filter((r) => r.ok === false)
          .map((r) =>
            r.phase === 'model_not_actions' && r.model_snippet
              ? '**Progress**\n' + String(r.error || '').slice(0, 600) + '\n\n' + String(r.model_snippet).slice(0, 900)
              : '**Progress**\n' + String(r.error || '').slice(0, 1800),
          );
        sessions.set(sessionId, session);
        al('Autonomy finished without success. Last error: ' + String((lastErr && lastErr.error) || 'unknown').slice(0, 300));
        const shortFail =
          failProgress.length > 0
            ? '**Stopped after ' +
              autonomyRounds.length +
              ' step(s).**\n\n' +
              String((lastErr && lastErr.error) || 'unknown').slice(0, 3200)
            : 'Could not complete actions after ' +
              autonomyRounds.length +
              ' step(s).\n\nLast error:\n' +
              String((lastErr && lastErr.error) || 'unknown').slice(0, 4500);
        learnCtx(shortFail);
        const failPayload = {
          reply: shortFail,
          source,
          autonomy_rounds: autonomyRounds,
          autonomy_log: autonomyLog,
          failed: true,
        };
        if (failProgress.length > 0) failPayload.progress_messages = failProgress;
        return res.json(failPayload);
      } catch (autonomyFatal) {
        autonomyLog.push(
          '[' +
            new Date().toISOString().slice(11, 23) +
            '] Fatal error in autonomy block: ' +
            String((autonomyFatal && autonomyFatal.message) || autonomyFatal).slice(0, 500),
        );
        console.error('[Butler autonomy] fatal', autonomyFatal);
        sessions.set(sessionId, session);
        learnCtx(String((autonomyFatal && autonomyFatal.message) || autonomyFatal));
        return res.status(200).json({
          reply:
            'Actions autonomy hit an unexpected error (see server log). ' +
            String((autonomyFatal && autonomyFatal.message) || autonomyFatal).slice(0, 2000),
          source,
          autonomy_rounds: autonomyRounds,
          autonomy_log: autonomyLog,
          failed: true,
        });
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'chat_failed', message: String(err?.message || err) });
    }
  });

  api.post('/api/agent', async (req, res) => {
    try {
      const { message, history, sessionId = 'butler-agent', cwd } = req.body || {};
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message is required' });
      }

      const projectRoot = await resolveAgentProjectRoot(sessionId, cwd);
      const rawLoc = req.body?.localOnly ?? req.body?.local_only;
      const runId = String(req.body?.runId || req.body?.run_id || randomUUID()).trim();
      const provider = String(req.body?.provider || req.body?.agent_provider || req.body?.modelId || 'local')
        .trim()
        .toLowerCase() || 'local';
      const isCascade = provider === 'auto_free' || provider === 'cascade' || provider === 'auto';
      let localOnly = true;
      if (isCascade || (provider && provider !== 'local')) {
        localOnly = false;
      } else if (typeof rawLoc === 'boolean') {
        localOnly = rawLoc;
      } else if (rawLoc === 'false' || rawLoc === 0 || rawLoc === '0') {
        localOnly = false;
      } else if (rawLoc === 'true' || rawLoc === 1 || rawLoc === '1') {
        localOnly = true;
      } else {
        localOnly = readButlerLocalOnlyFromConfig();
      }

      const apiKeys = req.body?.api_keys || req.body?.apiKeys || {};
      // Merge desktop env keys so cascade works even if the renderer forgot to send them.
      const envKeyMap = {
        gemini: 'GEMINI_API_KEY',
        groq: 'GROQ_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        mistral: 'MISTRAL_API_KEY',
        cohere: 'COHERE_API_KEY',
      };
      const mergedKeys = Object.assign({}, typeof apiKeys === 'object' && apiKeys ? apiKeys : {});
      Object.keys(envKeyMap).forEach(function (pid) {
        var envName = envKeyMap[pid];
        var fromEnv = String(process.env[envName] || '').trim();
        if (!fromEnv) return;
        if (!String(mergedKeys[pid] || '').trim()) mergedKeys[pid] = fromEnv;
        if (!String(mergedKeys[envName] || '').trim()) mergedKeys[envName] = fromEnv;
      });

      const chatRes = await fetch(LOCAL_AI_URL + '/chat/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          prior_messages: Array.isArray(history) ? history.slice(-16) : [],
          project_root: projectRoot,
          agent: true,
          local_only: localOnly,
          openai_api_key: '',
          run_id: runId,
          session_id: String(sessionId || 'butler-agent'),
          provider,
          api_keys: mergedKeys,
          continue: Boolean(req.body?.continue || req.body?.resume || req.body?.continue_run),
          resume: Boolean(req.body?.continue || req.body?.resume || req.body?.continue_run),
        }),
        signal: AbortSignal.timeout(getButlerChatAbortMs()),
      });

      if (!chatRes.ok) {
        const errBody = await chatRes.text();
        const bodySnippet = String(errBody || '').slice(0, 1200);
        let errMsg = '';
        let errType = '';
        let traceback = '';
        try {
          const errObj = JSON.parse(errBody);
          errMsg = String(errObj.error || errObj.message || errObj.detail || '').trim();
          errType = String(errObj.error_type || '').trim();
          traceback = String(errObj.traceback || '').trim().slice(0, 2000);
          if (!errMsg && bodySnippet) errMsg = bodySnippet;
        } catch (_) {
          errMsg = bodySnippet;
        }
        if (!errMsg) {
          errMsg =
            chatRes.status === 503
              ? 'Agent unavailable. Start Knowledge API and your local model.'
              : `Knowledge /chat/agent returned HTTP ${chatRes.status} with an empty error body.`;
        }
        const verbose = [
          `Agent failed (HTTP ${chatRes.status}${errType ? `, ${errType}` : ''}): ${errMsg}`,
          bodySnippet && bodySnippet !== errMsg ? `Upstream body: ${bodySnippet}` : '',
          traceback ? `Traceback:\n${traceback}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return res.status(chatRes.status).json({
          error: verbose,
          message: verbose,
          detail: errMsg,
          error_type: errType || undefined,
          traceback: traceback || undefined,
          upstream_status: chatRes.status,
          upstream_body: bodySnippet || undefined,
          mode: 'agent',
        });
      }

      const parsed = await chatRes.json();
      const parsedErr = String(parsed?.error || '').trim();
      if (parsedErr && !String(parsed?.reply || '').trim()) {
        const verbose = `Agent failed (HTTP ${chatRes.status}): ${parsedErr}`;
        return res.status(500).json({
          error: verbose,
          message: verbose,
          detail: parsedErr,
          traceback: parsed?.traceback ? String(parsed.traceback).slice(0, 2000) : undefined,
          mode: parsed?.mode || 'agent',
        });
      }
      return res.json({
        reply: parsed.reply || '',
        source: parsed.source || 'Agent',
        mode: parsed.mode || 'agent',
        agent_steps: Array.isArray(parsed.agent_steps) ? parsed.agent_steps : [],
        todos: Array.isArray(parsed.todos) ? parsed.todos : [],
        project_root: projectRoot,
        run_id: parsed.run_id || runId,
        model_used: parsed.model_used || '',
        agent_provider: parsed.agent_provider || provider,
        fallback_chain: Array.isArray(parsed.fallback_chain) ? parsed.fallback_chain : undefined,
        needs_continue: Boolean(parsed.needs_continue),
      });
    } catch (err) {
      const errName = err?.name || (err && err.constructor && err.constructor.name) || 'Error';
      const errMsg = String(err?.message || err || '').trim() || `${errName} (no message)`;
      const verbose = `Agent proxy failed (${errName}): ${errMsg}`;
      console.error('[Butler] /api/agent:', err);
      return res.status(500).json({
        error: verbose,
        message: verbose,
        detail: errMsg,
        error_type: errName,
        mode: 'agent',
      });
    }
  });

  function agentRunsDirElectron() {
    return path.join(getButlorConfigDirAbs(), 'agent-runs');
  }

  function readAgentStatusFileElectron(runId) {
    const rid = String(runId || '').trim();
    if (!rid) return null;
    const fp = path.join(agentRunsDirElectron(), `${rid}.json`);
    if (!fs.existsSync(fp)) return null;
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  async function proxyKnowledgeAgentJsonElectron(method, knowledgePath, body) {
    const url = LOCAL_AI_URL + knowledgePath;
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    };
    if (body != null) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  }

  api.get('/api/agent/status', async (req, res) => {
    try {
      const runId = String(req.query.runId || req.query.run_id || '').trim();
      if (!runId) return res.status(400).json({ ok: false, error: 'runId required' });
      const local = readAgentStatusFileElectron(runId);
      if (local) return res.json({ ok: true, ...local });
      const proxied = await proxyKnowledgeAgentJsonElectron('GET', `/agent/status?run_id=${encodeURIComponent(runId)}`);
      return res.status(proxied.status).json(proxied.data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  api.get('/api/agent/cascade-status', async (req, res) => {
    try {
      const provider = String(req.query.provider || req.query.selected || 'auto_free').trim() || 'auto_free';
      const probe = String(req.query.probe || '').trim().toLowerCase();
      const qs = `provider=${encodeURIComponent(provider)}${probe === '1' || probe === 'true' ? '&probe=1' : ''}`;
      const proxied = await proxyKnowledgeAgentJsonElectron('GET', `/agent/cascade-status?${qs}`);
      return res.status(proxied.status).json(proxied.data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  api.post('/api/agent/cascade-status', async (req, res) => {
    try {
      const body = req.body || {};
      const proxied = await proxyKnowledgeAgentJsonElectron('POST', '/agent/cascade-status', {
        provider: body.provider || body.selected || 'auto_free',
        api_keys: body.api_keys || body.apiKeys || {},
        probe: true,
      });
      return res.status(proxied.status).json(proxied.data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  api.get('/api/agent/checkpoints', async (req, res) => {
    try {
      const sessionId = String(req.query.sessionId || req.query.session_id || 'butler-agent').trim();
      const proxied = await proxyKnowledgeAgentJsonElectron(
        'GET',
        `/agent/checkpoints?session_id=${encodeURIComponent(sessionId)}`,
      );
      return res.status(proxied.status).json(proxied.data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  api.post('/api/agent/checkpoint', async (req, res) => {
    try {
      const { sessionId, cwd, project_root, paths, reason, label } = req.body || {};
      const projectRoot = await resolveAgentProjectRoot(sessionId, cwd || project_root);
      const proxied = await proxyKnowledgeAgentJsonElectron('POST', '/agent/checkpoint', {
        session_id: String(sessionId || 'butler-agent'),
        project_root: projectRoot,
        paths: Array.isArray(paths) ? paths : [],
        reason: String(reason || label || 'manual'),
      });
      return res.status(proxied.status).json(proxied.data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  api.post('/api/agent/revert', async (req, res) => {
    try {
      const { sessionId, checkpointId, checkpoint_id, id } = req.body || {};
      const cp = String(checkpointId || checkpoint_id || id || '').trim();
      if (!cp) return res.status(400).json({ ok: false, error: 'checkpointId required' });
      const proxied = await proxyKnowledgeAgentJsonElectron('POST', '/agent/revert', {
        session_id: String(sessionId || 'butler-agent'),
        checkpoint_id: cp,
      });
      return res.status(proxied.status).json(proxied.data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  api.post('/api/agent/open-path', async (req, res) => {
    try {
      const target = String(req.body?.path || '').trim();
      if (!target) return res.status(400).json({ ok: false, error: 'path required' });
      if (!fs.existsSync(target)) await fsp.mkdir(target, { recursive: true });
      const errMsg = await shell.openPath(target);
      if (errMsg) return res.status(500).json({ ok: false, error: errMsg });
      return res.json({ ok: true, path: target });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  api.get('/api/agent/scan', async (req, res) => {
    try {
      const sessionId = String(req.query.sessionId || 'butler-agent').trim();
      const cwd = String(req.query.cwd || '').trim();
      const projectRoot = await resolveAgentProjectRoot(sessionId, cwd);
      const keyNames = ['package.json', 'README.md', 'pyproject.toml', 'requirements.txt', 'tsconfig.json'];
      const found = [];
      for (const name of keyNames) {
        const fp = path.join(projectRoot, name);
        if (!fs.existsSync(fp)) continue;
        let snippet = '';
        try {
          snippet = fs.readFileSync(fp, 'utf8').slice(0, 400);
        } catch (_) {}
        found.push({ name, path: fp, snippet });
      }
      let topDirs = [];
      try {
        topDirs = fs
          .readdirSync(projectRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
          .map((e) => e.name)
          .slice(0, 20);
      } catch (_) {}
      return res.json({ ok: true, project_root: projectRoot, key_files: found, top_dirs: topDirs });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  api.post('/api/butler/rebuild', (_req, res) => {
    try {
      const uiDir = app.isPackaged
        ? path.join(path.dirname(process.execPath), '..', '..')
        : path.join(__dirname, '..');
      if (!fs.existsSync(path.join(uiDir, 'package.json'))) {
        return res.json({
          ok: false,
          message:
            'Could not find ui/package.json beside this install. Use a full dev checkout, or open a terminal in your Butler repo ui folder and run: npm run build:app',
        });
      }
      if (process.platform !== 'win32') {
        return res.json({
          ok: false,
          message:
            'Rebuild from Settings is Windows-only. In a terminal: cd to your Butler repo ui folder, then npm run build:app. Quit Butler and launch the new build when finished.',
        });
      }
      const safeUi = uiDir.replace(/"/g, '""');
      spawn('cmd.exe', ['/c', 'start', 'Rebuild Butler', 'cmd', '/k', `cd /d "${safeUi}" && npm run build:app`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      }).unref();
      return res.json({
        ok: true,
        message:
          'Opened a console window running npm run build:app in the ui folder. When the build finishes, quit Butler and launch the new app from ui\\dist-app-new\\win-unpacked (or your desktop shortcut).',
      });
    } catch (e) {
      return res.status(500).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  // -----------------------------
  // Image SD routes (mirror ui-server.js → Knowledge /sd/* + local preset store)
  // -----------------------------
  const EASY_SWEEP_PRESETS = new Set([
    '01_face_lock',
    '02_soft_face',
    '03_balanced',
    '04_prompt_lean',
    '05_action_first',
    '06_strong_prompt',
    '07_low_cfg_face',
    '08_mid_cfg',
    '09_high_cfg',
    '10_short_end',
    '11_long_end',
    '12_soft_lora',
    '13_mid_lora',
    '14_high_lora',
    '15_v2_soft',
    '16_v2_strong',
    '17_cfg60_mid',
    '18_cfg65_mid',
    '19_steps_high',
    '20_high_lora_face',
  ]);

  const EASY_PROMPT_FIELD_KEYS = [
    'details',
    'avoid',
    'action',
    'pose',
    'outfit',
    'scene',
    'mode',
    'sweep_seed',
    'balance',
    'framing',
    'emphasize_action',
    'hands_in_frame',
    'frontal_face',
    'photoreal',
    'preset',
  ];

  /** Electron historically used D:\butlor; ui-server uses D:\butler (repo). Prefer the file that exists. */
  function easyPromptPresetsPath() {
    const candidates = [];
    const primary = path.join(getButlorConfigDirAbs(), 'easy-img2img-prompt-presets.json');
    candidates.push(primary);
    if (process.platform === 'win32') {
      const shared = path.join(path.resolve('D:\\butler'), 'easy-img2img-prompt-presets.json');
      if (shared.toLowerCase() !== primary.toLowerCase()) candidates.push(shared);
    }
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return primary;
  }

  function readEasyPromptPresetStore() {
    try {
      const parsed = JSON.parse(fs.readFileSync(easyPromptPresetsPath(), 'utf8'));
      return {
        version: 1,
        presets: Array.isArray(parsed?.presets) ? parsed.presets : [],
      };
    } catch {
      return { version: 1, presets: [] };
    }
  }

  function cleanEasyPromptFields(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const key of EASY_PROMPT_FIELD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = raw[key];
    }
    return Object.keys(out).length === EASY_PROMPT_FIELD_KEYS.length ? out : null;
  }

  function easySweepPaths() {
    const comfyRoot = path.join(getSdProjectPath(), 'ComfyUI');
    const outputRoot = path.join(comfyRoot, 'output');
    return {
      outputRoot,
      sweepDir: path.join(outputRoot, 'easy_sweep'),
      winnersPath: path.join(outputRoot, 'butler_easy_sweep_winners.json'),
    };
  }

  function presetFromEasySweepFilename(filename) {
    const base = String(filename || '').replace(/\\/g, '/').split('/').pop() || '';
    const match = base.match(
      /^(.+?)_(?:single|sweep_winners|sweep_20)(?:_r.+?)?_s\d+_\d+(?:_\d+)?\.(?:png|jpe?g|webp)$/i,
    );
    const preset = match?.[1] || '';
    return EASY_SWEEP_PRESETS.has(preset) ? preset : '';
  }

  function easySweepRunGroupKey(relPath) {
    const normalized = String(relPath || '').replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length >= 2 && parts[0] === 'easy_sweep') {
      return parts[1];
    }
    const base = parts[parts.length - 1] || '';
    const withRun = base.match(
      /^(.+?_(?:single|sweep_winners|sweep_20)_r.+?)(?:_s\d+)(?:_\d+)?\.(?:png|jpe?g|webp)$/i,
    );
    if (withRun?.[1]) return withRun[1];
    const modeMatch = base.match(
      /^(.+?)_(sweep_20|sweep_winners|single)_s\d+(?:_\d+)?\.(?:png|jpe?g|webp)$/i,
    );
    if (modeMatch?.[2]) {
      return 'legacy_' + modeMatch[2];
    }
    return '';
  }

  function readEasySweepWinners(winnersPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(winnersPath, 'utf8'));
      return {
        files: Array.isArray(parsed?.files) ? parsed.files.map(String) : [],
        presets: Array.isArray(parsed?.presets) ? parsed.presets.map(String) : [],
      };
    } catch {
      return { files: [], presets: [] };
    }
  }

  async function collectSweepImages(sweepDir) {
    const results = [];
    async function walk(dir, relPrefix) {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(full, rel);
        } else if (entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name)) {
          results.push({ full, rel });
        }
      }
    }
    await walk(sweepDir, '');
    return results;
  }

  function knowledgeSdUnreachableMessage(err) {
    const msg = String(err?.message || err || '');
    const comfy = getComfyUiUrl();
    if (/ECONNREFUSED|fetch failed|network|ENOTFOUND|timed out|TimeoutError|AbortError/i.test(msg)) {
      return (
        `Could not reach Knowledge API at ${LOCAL_AI_URL} (${msg}). ` +
        `Ensure Knowledge is running and ComfyUI is up on ${comfy}.`
      );
    }
    return msg || 'Image edit failed.';
  }

  api.get('/api/sd/img2img/prompt-presets', (_req, res) => {
    const store = readEasyPromptPresetStore();
    return res.json({
      ok: true,
      presets: store.presets.map((preset) => ({
        id: String(preset?.id || ''),
        name: String(preset?.name || ''),
        updated_at: String(preset?.updated_at || ''),
        payload_base64: String(preset?.payload_base64 || ''),
      })),
    });
  });

  api.post('/api/sd/img2img/prompt-presets', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim().slice(0, 80);
      const fields = cleanEasyPromptFields(req.body?.fields);
      if (!name) return res.status(400).json({ ok: false, message: 'Preset name is required.' });
      if (!fields) {
        return res.status(400).json({ ok: false, message: 'Preset must contain every Easy Prompt input.' });
      }
      const store = readEasyPromptPresetStore();
      const now = new Date().toISOString();
      const payloadBase64 = Buffer.from(JSON.stringify(fields), 'utf8').toString('base64');
      const requestedId = String(req.body?.id || '').trim();
      const existing = store.presets.find(
        (preset) =>
          (requestedId && String(preset?.id || '') === requestedId) ||
          String(preset?.name || '').toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
      if (existing) {
        existing.name = name;
        existing.updated_at = now;
        existing.payload_base64 = payloadBase64;
      } else {
        store.presets.push({
          id: randomUUID(),
          name,
          updated_at: now,
          payload_base64: payloadBase64,
        });
      }
      store.presets.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const file = easyPromptPresetsPath();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8');
      const saved = existing || store.presets.find((preset) => preset.name === name);
      return res.json({
        ok: true,
        preset: saved,
        message: existing ? `Updated prompt preset "${name}".` : `Saved prompt preset "${name}".`,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, message: String(e?.message || e) });
    }
  });

  api.delete('/api/sd/img2img/prompt-presets/:id', async (req, res) => {
    try {
      const id = String(req.params?.id || '').trim();
      const store = readEasyPromptPresetStore();
      const before = store.presets.length;
      store.presets = store.presets.filter((preset) => String(preset?.id || '') !== id);
      if (store.presets.length === before) {
        return res.status(404).json({ ok: false, message: 'Prompt preset not found.' });
      }
      const file = easyPromptPresetsPath();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8');
      return res.json({ ok: true, message: 'Prompt preset deleted.' });
    } catch (e) {
      return res.status(500).json({ ok: false, message: String(e?.message || e) });
    }
  });

  api.get('/api/sd/img2img/sweep-results', async (_req, res) => {
    try {
      const { sweepDir, winnersPath } = easySweepPaths();
      await fsp.mkdir(sweepDir, { recursive: true });
      const winnerState = readEasySweepWinners(winnersPath);
      const selected = new Set(winnerState.files);
      const images = await collectSweepImages(sweepDir);
      const runs = new Map();
      for (const { full, rel } of images) {
        const runKey = easySweepRunGroupKey(rel);
        if (!runKey) continue;
        const preset = presetFromEasySweepFilename(rel);
        if (!preset) continue;
        const info = await fsp.stat(full);
        const item = {
          filename: rel,
          preset,
          modified_at: info.mtime.toISOString(),
          bytes: info.size,
          winner: selected.has(rel),
          image_url: `/api/sd/img2img/sweep-image/${encodeURIComponent(rel)}?v=${Math.round(info.mtimeMs)}`,
        };
        const run = runs.get(runKey) || { items: [], latest: '' };
        run.items.push(item);
        if (!run.latest || run.latest < item.modified_at) {
          run.latest = item.modified_at;
        }
        runs.set(runKey, run);
      }
      const runGroups = [...runs.entries()]
        .map(([key, run]) => {
          const sortedItems = run.items.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
          return {
            key,
            label: key.replace(/^easy_sweep\//, ''),
            item_count: sortedItems.length,
            latest: run.latest,
            items: sortedItems,
          };
        })
        .sort((a, b) => b.latest.localeCompare(a.latest));
      const latestRunKey = runGroups.length > 0 ? runGroups[0].key : '';
      const latestItems = runGroups.length > 0 ? runGroups[0].items : [];
      return res.json({
        ok: true,
        items: latestItems.slice(0, 120),
        run_groups: runGroups,
        latest_run_key: latestRunKey,
        winner_files: winnerState.files,
        winner_presets: winnerState.presets,
        output_path: sweepDir,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, message: String(e?.message || e), items: [] });
    }
  });

  api.get('/api/sd/img2img/sweep-image/*', async (req, res) => {
    const relPath = String(req.params[0] || '').replace(/\\/g, '/');
    if (!relPath || !/\.(?:png|jpe?g|webp|enc)$/i.test(relPath)) {
      return res.status(400).json({ ok: false, message: 'Invalid sweep image filename.' });
    }
    if (relPath.includes('..')) {
      return res.status(400).json({ ok: false, message: 'Invalid path.' });
    }
    try {
      const { sweepDir } = easySweepPaths();
      const full = path.join(sweepDir, relPath.split('/').join(path.sep));
      const info = await fsp.stat(full);
      if (!info.isFile()) throw new Error('Not a file');

      const rawData = fs.readFileSync(full);
      const ENCRYPTION_KEY = 'butler-sweep-secure-key-2024';
      if (relPath.toLowerCase().endsWith('.enc')) {
        const decoded = Buffer.alloc(rawData.length);
        for (let i = 0; i < rawData.length; i++) {
          decoded[i] = rawData[i] ^ ENCRYPTION_KEY.charCodeAt(i % ENCRYPTION_KEY.length);
        }
        res.setHeader('Cache-Control', 'private, max-age=60');
        res.setHeader('Content-Type', 'image/png');
        return res.send(decoded);
      }

      const encoded = Buffer.alloc(rawData.length);
      for (let i = 0; i < rawData.length; i++) {
        encoded[i] = rawData[i] ^ ENCRYPTION_KEY.charCodeAt(i % ENCRYPTION_KEY.length);
      }

      res.setHeader('Cache-Control', 'private, max-age=60');
      res.setHeader('Content-Type', 'image/png');
      return res.send(encoded);
    } catch {
      return res.status(404).json({ ok: false, message: 'Sweep image not found.' });
    }
  });

  api.post('/api/sd/img2img/sweep-winners', async (req, res) => {
    try {
      const requested = Array.isArray(req.body?.files) ? req.body.files.map(String) : [];
      const { outputRoot, sweepDir, winnersPath } = easySweepPaths();
      await fsp.mkdir(sweepDir, { recursive: true });
      const files = [];
      const presets = [];
      for (const raw of requested) {
        const relPath = String(raw || '').replace(/\\/g, '/');
        if (!relPath || relPath.includes('..') || !/\.(?:png|jpe?g|webp|enc)$/i.test(relPath)) continue;
        const preset = presetFromEasySweepFilename(relPath);
        if (!preset) continue;
        const full = path.join(sweepDir, relPath.split('/').join(path.sep));
        if (!fs.existsSync(full)) continue;
        files.push(relPath);
        if (!presets.includes(preset)) presets.push(preset);
      }
      await fsp.mkdir(outputRoot, { recursive: true });
      await fsp.writeFile(
        winnersPath,
        JSON.stringify({ updated_at: new Date().toISOString(), files, presets }, null, 2) + '\n',
        'utf8',
      );
      return res.json({
        ok: true,
        files,
        presets,
        message: presets.length
          ? `Saved ${files.length} winning image(s) across ${presets.length} preset(s).`
          : 'Winner selection cleared; sweep_winners will use the default preset winners.',
      });
    } catch (e) {
      return res.status(500).json({ ok: false, message: String(e?.message || e) });
    }
  });

  api.get('/api/sd/checkpoints', async (_req, res) => {
    try {
      const r = await fetch(LOCAL_AI_URL + '/sd/checkpoints', {
        signal: AbortSignal.timeout(20000),
      });
      const data = await r.json().catch(() => ({}));
      return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
    } catch (e) {
      return res.status(502).json({ ok: false, message: knowledgeSdUnreachableMessage(e), checkpoints: [] });
    }
  });

  api.post('/api/sd/checkpoints', async (req, res) => {
    try {
      const checkpoint = String(req.body?.checkpoint || '').trim();
      if (!checkpoint) return res.status(400).json({ ok: false, message: 'checkpoint required' });
      const r = await fetch(LOCAL_AI_URL + '/sd/checkpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkpoint }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await r.json().catch(() => ({}));
      return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
    } catch (e) {
      return res.status(502).json({ ok: false, message: knowledgeSdUnreachableMessage(e) });
    }
  });

  api.post('/api/sd/txt2img', async (req, res) => {
    try {
      const prompt = String(req.body?.prompt || '').trim();
      if (!prompt) return res.status(400).json({ ok: false, message: 'prompt required', images: [] });
      const negativePrompt = String(req.body?.negative_prompt || '').trim();
      const width = Math.max(384, Math.min(1536, Math.round(Number(req.body?.width) || 768)));
      const height = Math.max(384, Math.min(1536, Math.round(Number(req.body?.height) || 1024)));
      const workflow = String(req.body?.workflow || '').trim();
      const stepsNum = Number(req.body?.steps);
      const cfgNum = Number(req.body?.cfg);
      const body = {
        prompt,
        negative_prompt: negativePrompt,
        width,
        height,
        ...(workflow ? { workflow } : {}),
        ...(Number.isFinite(stepsNum) && stepsNum > 0 ? { steps: Math.round(stepsNum) } : {}),
        ...(Number.isFinite(cfgNum) && cfgNum > 0 ? { cfg: cfgNum } : {}),
      };
      const r = await fetch(LOCAL_AI_URL + '/sd/txt2img', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      const data = await r.json().catch(() => ({}));
      fillSdPayloadFromDisk(data);
      return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
    } catch (e) {
      return res.status(502).json({ ok: false, message: knowledgeSdUnreachableMessage(e), images: [] });
    }
  });

  api.post('/api/sd/img2img', async (req, res) => {
    try {
      const initImage = String(req.body?.init_image || req.body?.image || '').trim();
      if (initImage.length < 80) {
        return res.status(400).json({ ok: false, message: 'init_image (base64) required', images: [] });
      }
      const prompt = String(req.body?.prompt || '').trim() || 'high quality, detailed';
      const negativePrompt = String(req.body?.negative_prompt || '').trim();
      const workflow = String(req.body?.workflow || '').trim();
      const filename = String(req.body?.filename || req.body?.upload_filename || '').trim();
      const poseImage = String(req.body?.pose_image || req.body?.pose_image_b64 || '').trim();
      const poseFilename = String(req.body?.pose_filename || req.body?.pose_upload_filename || '').trim();
      const poseStrength = Number(req.body?.pose_strength);
      const poseEndPercent = Number(req.body?.pose_end_percent);
      const body = {
        prompt,
        init_image: initImage,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        ...(workflow ? { workflow } : {}),
        ...(filename ? { filename } : {}),
        ...(poseImage.length >= 80 ? { pose_image: poseImage } : {}),
        ...(poseFilename ? { pose_filename: poseFilename } : {}),
        ...(Number.isFinite(poseStrength) ? { pose_strength: poseStrength } : {}),
        ...(Number.isFinite(poseEndPercent) ? { pose_end_percent: poseEndPercent } : {}),
      };
      if (req.body?.easy_prompt && typeof req.body.easy_prompt === 'object') {
        body.easy_prompt = req.body.easy_prompt;
      }
      if (req.body?.compare_nsfw_triple === true) body.compare_nsfw_triple = true;
      if (req.body?.compare_nsfw_triple === false) body.compare_nsfw_triple = false;
      const r = await fetch(LOCAL_AI_URL + '/sd/img2img', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('application/json')) {
        const text = (await r.text()).slice(0, 400);
        const wrongApp =
          r.status === 404
            ? `Knowledge API route missing on ${LOCAL_AI_URL} (HTTP 404). Expected /sd/img2img — check Knowledge is on port ${KNOWLEDGE_API_PORT}.`
            : `Knowledge API returned non-JSON (HTTP ${r.status}). ${text.slice(0, 180)}`;
        return res.status(502).json({ ok: false, message: wrongApp, images: [] });
      }
      const data = await r.json().catch(() => ({}));
      fillSdPayloadFromDisk(data);
      if (!r.ok && !data.message) {
        data.message =
          data.message ||
          `Knowledge API HTTP ${r.status}. Ensure Knowledge is running on ${LOCAL_AI_URL} and ComfyUI on ${getComfyUiUrl()}.`;
        data.ok = false;
      }
      return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
    } catch (e) {
      return res.status(502).json({ ok: false, message: knowledgeSdUnreachableMessage(e), images: [] });
    }
  });

  const nmPath = path.join(__dirname, app.isPackaged ? '..' : '../..', 'network-monitor.mjs');
  if (fs.existsSync(nmPath)) {
    try {
      const { pathToFileURL } = require('url');
      const nm = await import(pathToFileURL(nmPath).href);
      api.get('/api/network-monitor/probe', async (_req, res) => {
        try {
          const p = await nm.probeTshark();
          return res.json(p);
        } catch (e) {
          return res.status(500).json({ ok: false, error: String(e?.message || e) });
        }
      });
      api.get('/api/network-monitor/interfaces', async (_req, res) => {
        try {
          const out = await nm.listInterfaces();
          return res.json(out);
        } catch (e) {
          return res.status(500).json({ ok: false, error: String(e?.message || e), interfaces: [] });
        }
      });
      api.post('/api/network-monitor/start', async (req, res) => {
        try {
          const iface = req.body?.iface != null ? String(req.body.iface) : '';
          const bpf = req.body?.bpf != null ? String(req.body.bpf) : '';
          const out = await nm.startCapture({ iface: iface || undefined, bpf: bpf || undefined });
          if (!out.ok) return res.status(400).json(out);
          return res.json(out);
        } catch (e) {
          return res.status(500).json({ ok: false, error: String(e?.message || e) });
        }
      });
      api.post('/api/network-monitor/stop', (_req, res) => {
        try {
          const out = nm.stopCapture();
          return res.json(out);
        } catch (e) {
          return res.status(500).json({ ok: false, error: String(e?.message || e) });
        }
      });
      api.get('/api/network-monitor/snapshot', (_req, res) => {
        try {
          return res.json(nm.getSnapshot({ maxEvents: 120, maxAlerts: 60 }));
        } catch (e) {
          return res.status(500).json({ ok: false, error: String(e?.message || e) });
        }
      });
      api.get('/api/security-lab', (_req, res) => {
        res.json(nm.SECURITY_LAB_RESOURCES);
      });
      api.get('/api/kali-tools', (_req, res) => {
        res.json(nm.KALI_TOOLS_RESOURCES);
      });
      api.get('/api/infoooze', (_req, res) => {
        res.json(nm.INFOOOZE_RESOURCES);
      });
      api.post('/api/network-monitor/quick-scan', async (req, res) => {
        try {
          const body = req.body || {};
          const seconds = body.seconds != null ? Number(body.seconds) : undefined;
          const iface = body.iface != null ? String(body.iface) : undefined;
          const bpf = body.bpf != null ? String(body.bpf) : undefined;
          const out = await nm.quickScan({ seconds, iface, bpf });
          if (!out.ok) return res.status(400).json(out);
          return res.json(out);
        } catch (e) {
          return res.status(500).json({ ok: false, error: String(e?.message || e) });
        }
      });
      api.post('/api/network-monitor/install-wireshark', async (_req, res) => {
        try {
          const out = await nm.installWiresharkWinget();
          if (!out.ok) return res.status(400).json(out);
          return res.json(out);
        } catch (e) {
          return res.status(500).json({ ok: false, error: String(e?.message || e) });
        }
      });
    } catch (e) {
      console.warn('[Butler] network-monitor routes:', e?.message || e);
    }
  }

  /** Unmatched /api (wrong method or path): Express default 404 is HTML and breaks JSON clients. */
  api.use('/api', (req, res) => {
    const p = String(req.path || '');
    let hint;
    if (req.method === 'GET' && p === '/network-monitor/quick-scan') {
      hint = 'Use POST with JSON body { seconds?, iface?, bpf? } (Settings → Network monitor → Scan).';
    } else if (p.startsWith('/sd/')) {
      hint =
        'Desktop UI API is missing this SD route (not a ComfyUI failure). Update/repack Electron main, or use the Vite+ui-server stack.';
    }
    res.status(404).json({
      ok: false,
      error: `No handler for ${req.method} ${req.originalUrl || req.path}`,
      ...(hint ? { setup_hint: hint } : {}),
    });
  });

  const distDir = path.resolve(__dirname, '../dist');
  api.use(express.static(distDir));
  api.get('*', (req, res) => {
    // Do not SPA-fallback API routes — otherwise unknown GET /api/... returns index.html
    // and the UI throws "Unexpected token '<'" on response.json().
    if (String(req.path || '').startsWith('/api')) {
      return res.status(404).type('application/json').json({
        ok: false,
        error: 'Unknown API route',
        path: req.path,
      });
    }
    res.sendFile(path.join(distDir, 'index.html'));
  });

  return new Promise((resolve, reject) => {
    const maxRetries = app.isPackaged ? 7 : 0;
    const tryListen = (port, remaining) => {
      const bindHost = String(process.env.BUTLER_UI_API_HOST || '0.0.0.0').trim() || '0.0.0.0';
      const server = api.listen(port, bindHost, () => {
        API_PORT = port;
        process.env.BUTLER_UI_API_PORT = String(API_PORT);
        console.log(
          'Butler internal server running at http://' +
            bindHost +
            ':' +
            API_PORT +
            ' (localhost + LAN)',
        );
        resolve(server);
      });
      server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && remaining > 0) {
          const next = port + 10;
          console.warn('[Butler] Port ' + port + ' in use — trying ' + next);
          try {
            server.close();
          } catch (_) {}
          tryListen(next, remaining - 1);
          return;
        }
        reject(err);
      });
    };
    tryListen(API_PORT, maxRetries);
  });
}

function getButlerFloatUrl() {
  const isDev = !app.isPackaged;
  return isDev
    ? 'http://localhost:5173/#float-butler'
    : 'http://localhost:' + API_PORT + '/#float-butler';
}

function getButlerAgentUrl() {
  const isDev = !app.isPackaged;
  return isDev
    ? 'http://localhost:5173/#agent'
    : 'http://localhost:' + API_PORT + '/#agent';
}

function createButlerAgentWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  try {
    mainWindow.webContents.executeJavaScript("window.location.hash = 'agent';", true).catch(() => {});
  } catch (_) {}
  return mainWindow;
}

function createButlerFloatWindow() {
  const preloadPath = path.join(__dirname, 'preload.cjs');
  if (butlerFloatWindow && !butlerFloatWindow.isDestroyed()) {
    butlerFloatWindow.show();
    return butlerFloatWindow;
  }
  butlerFloatWindow = new BrowserWindow({
    width: 304,
    height: 340,
    minWidth: 200,
    minHeight: 200,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });
  butlerFloatWindow.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') {
    try {
      butlerFloatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (_) {}
  }
  const pt = screen.getCursorScreenPoint();
  const b = butlerFloatWindow.getBounds();
  butlerFloatWindow.setPosition(Math.round(pt.x - b.width / 2), Math.round(pt.y - b.height / 2));

  butlerFloatWindow.loadURL(getButlerFloatUrl());
  butlerFloatWindow.on('closed', () => {
    butlerFloatWindow = null;
  });
  return butlerFloatWindow;
}

ipcMain.on('butler-float-sync', (_event, payload) => {
  if (butlerFloatWindow && !butlerFloatWindow.isDestroyed()) {
    butlerFloatWindow.webContents.send('butler-float-state', payload);
  }
});

function computeButlerDockFlyPayload() {
  if (!butlerFloatWindow || butlerFloatWindow.isDestroyed()) return null;
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    const floatB = butlerFloatWindow.getBounds();
    const content = mainWindow.getContentBounds();
    const cx = floatB.x + floatB.width / 2;
    const cy = floatB.y + Math.round(floatB.height * 0.4);
    const fromX = cx - content.x;
    const fromY = cy - content.y;
    const spherePx = Math.max(56, Math.min(252, Math.min(floatB.width - 36, floatB.height - 88)));
    if (!Number.isFinite(fromX) || !Number.isFinite(fromY)) return null;
    return { fromX, fromY, spherePx };
  } catch (_) {
    return null;
  }
}

ipcMain.on('butler-float-mic-toggle', (event) => {
  if (!butlerFloatWindow || butlerFloatWindow.isDestroyed()) return;
  if (event.sender !== butlerFloatWindow.webContents) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('butler-voice-mic-toggle');
  }
});

ipcMain.on('butler-float-hide-request', (event) => {
  if (!butlerFloatWindow || butlerFloatWindow.isDestroyed()) return;
  if (event.sender !== butlerFloatWindow.webContents) return;
  const flyPayload = computeButlerDockFlyPayload();
  butlerFloatWindow.hide();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (flyPayload) {
      mainWindow.webContents.send('butler-float-dock-fly', flyPayload);
    } else {
      mainWindow.webContents.send('butler-float-docked');
    }
  }
});

ipcMain.handle('butler-float-dock-animate', async () => {
  if (!butlerFloatWindow || butlerFloatWindow.isDestroyed() || !butlerFloatWindow.isVisible()) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('butler-float-docked');
    }
    return;
  }
  const flyPayload = computeButlerDockFlyPayload();
  butlerFloatWindow.hide();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (flyPayload) {
      mainWindow.webContents.send('butler-float-dock-fly', flyPayload);
    } else {
      mainWindow.webContents.send('butler-float-docked');
    }
  }
});

ipcMain.handle('butler-float-open', async () => {
  createButlerFloatWindow();
});

ipcMain.handle('butler-agent-open', async () => {
  createButlerAgentWindow();
});

ipcMain.handle('butler-agent-popout', async () => {
  createButlerAgentStandaloneWindow();
});

ipcMain.handle('butler-agent-popin', async () => {
  if (butlerAgentWindow && !butlerAgentWindow.isDestroyed()) {
    butlerAgentWindow.close();
    butlerAgentWindow = null;
  }
});

function createButlerAgentStandaloneWindow() {
  if (butlerAgentWindow && !butlerAgentWindow.isDestroyed()) {
    butlerAgentWindow.show();
    return butlerAgentWindow;
  }
  const preloadPath = path.join(__dirname, 'preload.cjs');
  butlerAgentWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 600,
    minHeight: 400,
    resizable: true,
    title: 'Butler Agent',
    backgroundColor: '#0d0a06',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      webviewTag: true,
    },
  });
  butlerAgentWindow.on('closed', () => {
    butlerAgentWindow = null;
  });
  const isDev = !app.isPackaged;
  if (isDev) {
    butlerAgentWindow.loadURL('http://localhost:5173/#agent-standalone');
  } else {
    butlerAgentWindow.loadURL('http://localhost:' + API_PORT + '/#agent-standalone');
  }
  return butlerAgentWindow;
}

ipcMain.handle('butler-open-external-url', async (_event, targetUrl) => {
  const url = String(targetUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('butler-agent-pick-folder', async (_event, defaultPath) => {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    defaultPath: defaultPath && String(defaultPath).trim() ? String(defaultPath).trim() : undefined,
    title: 'Select workspace folder',
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('butler-agent-open-explorer', async (_event, targetPath) => {
  const p = String(targetPath || '').trim();
  if (!p) return { ok: false, error: 'path required' };
  if (!fs.existsSync(p)) {
    try {
      await fsp.mkdir(p, { recursive: true });
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
  const errMsg = await shell.openPath(p);
  if (errMsg) return { ok: false, error: errMsg };
  return { ok: true, path: p };
});

ipcMain.handle('butler-float-hide', async () => {
  if (butlerFloatWindow && !butlerFloatWindow.isDestroyed()) {
    butlerFloatWindow.hide();
  }
});

ipcMain.handle('butler-float-close', async () => {
  if (butlerFloatWindow && !butlerFloatWindow.isDestroyed()) {
    butlerFloatWindow.close();
    butlerFloatWindow = null;
  }
});

function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.cjs');
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Butler',
    backgroundColor: '#0d0a06',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      webviewTag: true,
    },
  });

  mainWindow.on('close', () => {
    if (butlerFloatWindow && !butlerFloatWindow.isDestroyed()) {
      butlerFloatWindow.close();
      butlerFloatWindow = null;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadURL('http://localhost:' + API_PORT);
  }
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'display-capture'];
    callback(allowed.includes(permission));
  });

  try {
    await prepareRuntimePorts();
  } catch (_) {
    syncRuntimePortEnv();
  }

  // Start AI server + Knowledge API + Stable Diffusion in both dev and packaged mode
  try {
    startAiServer();
    await new Promise((r) => setTimeout(r, 1500));
    startKnowledgeApi();
    startComfyUI();
    await waitForKnowledgeApi(8000);
  } catch (_) {
    /* skip - app still opens */
  }
  if (app.isPackaged) {
    startInternalApiServer()
      .then(() => (AGENT_ONLY ? createButlerAgentStandaloneWindow() : createWindow()))
      .catch((err) => {
        console.error('Failed to start internal server:', err);
        const { dialog } = require('electron');
        dialog.showErrorBox('Butler', 'Could not start: ' + (err?.message || err));
      });
  } else {
    // Dev: prefer internal API; if 4001 is taken or health fails, spawn ui-server.js so /api works from Vite without another terminal.
    (async () => {
      try {
        await startInternalApiServer();
      } catch (err) {
        if (err && err.code === 'EADDRINUSE') {
          console.warn(
            '[Butler dev] Port ' +
              API_PORT +
              ' in use — another process may be Butler (e.g. ui-server.js).',
          );
        } else {
          console.error('Failed to start API server:', err);
        }
      }
      await ensureDevButlerApi();
      if (AGENT_ONLY) createButlerAgentStandaloneWindow();
      else createWindow();
    })();
  }
});

app.on('will-quit', () => {
  if (devUiServerChild && !devUiServerChild.killed) {
    try {
      devUiServerChild.kill('SIGTERM');
    } catch (_) {}
    devUiServerChild = null;
  }
});

app.on('window-all-closed', () => {
  if (butlerAgentWindow && !butlerAgentWindow.isDestroyed()) {
    // Keep the standalone agent window alive when the main window closes.
    return;
  }
  if (aiServerProcess) {
    aiServerProcess.kill();
    aiServerProcess = null;
  }
  if (knowledgeApiProcess) {
    knowledgeApiProcess.kill();
    knowledgeApiProcess = null;
  }
  if (comfyProcess) {
    comfyProcess.kill();
    comfyProcess = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

