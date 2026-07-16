import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { mkdir, writeFile, readdir, readFile, stat, realpath } from 'fs/promises';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  writeSync,
  readdirSync,
  createReadStream,
} from 'fs';
import { exec as cpExec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import net from 'node:net';
import os from 'os';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { Agent, fetch as undiciFetch } from 'undici';

import { getButlorConfigDirAbs, getDefaultButlorRoot } from './butlor-data-root.mjs';

const require = createRequire(import.meta.url);
const { readDesktopRbBase64Sync } = require('./desktop-rb-helper.cjs');
import {
  runPrint3dOpenScadPipeline,
  runPrint3dChatPipeline,
  probeOpenScadInstalled,
  normalizeKnowledgeApiBaseUrl,
  preloadPrint3dEnv,
} from './print3d-openscad.mjs';
import {
  probeTshark,
  probeTsharkForStatusRow,
  listInterfaces,
  startCapture,
  stopCapture,
  getSnapshot,
  quickScan,
  installWiresharkWinget,
  SECURITY_LAB_RESOURCES,
  KALI_TOOLS_RESOURCES,
  INFOOOZE_RESOURCES,
} from './network-monitor.mjs';
import { fillSdPayloadFromDisk } from './sd-fill-from-disk.mjs';
import {
  callMcpTool,
  connectMcpServers,
  disconnectAllMcpServers,
  getDefaultMcpServerConfigs,
  getMcpStatus,
  listConnectedTools,
} from './agent-mcp-host.mjs';
import {
  applyAgentEnvVarsToProcess,
  getAgentEnvFilePath,
  loadAndApplyAgentEnvVars,
  loadAgentEnvVarsFromDisk,
  normalizeAgentEnvVars,
  saveAgentEnvVarsToDisk,
} from './agent-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
{
  const envFile = path.join(__dirname, '.env');
  dotenv.config({ path: envFile });
}
preloadPrint3dEnv();
loadAndApplyAgentEnvVars();

/** SD_PROJECT_PATH: absolute path even when .env uses a relative value (spawn cwd may not be repo root). */
function resolveSdProjectPath(repoRoot) {
  const raw = (process.env.SD_PROJECT_PATH || '').trim();
  if (!raw) return path.join(repoRoot, 'sd');
  return path.resolve(repoRoot, raw);
}

const app = express();
const PORT = (() => {
  const raw = String(process.env.BUTLER_UI_API_PORT || process.env.BUTLER_API_PORT || '4001').trim();
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? n : 4001;
})();
const exec = promisify(cpExec);
const sessions = new Map();

const projectsRoot = process.env.CODE_HELPER_PROJECTS_ROOT || path.resolve(process.cwd(), 'projects', 'ui');

const KNOWLEDGE_API_URL = normalizeKnowledgeApiBaseUrl(process.env.KNOWLEDGE_API_URL, {
  logPrefix: '[ui-server] ',
});

/** Same base as KNOWLEDGE_API_URL — used for fetch() to Python api_server (/chat, /sd/*, …). */
const LOCAL_AI_URL = KNOWLEDGE_API_URL;

/**
 * POST /chat waits on Knowledge end-to-end: multiple POSTs to localhost:5000 (LM) plus Python work — can exceed ~5 minutes.
 * Override with BUTLER_UI_CHAT_TIMEOUT_MS (must be >= 45s; max 2h). Should stay ≥ Knowledge’s peepee timeouts × stacked hops.
 */
function getUiChatFetchTimeoutMs() {
  const raw = String(process.env.BUTLER_UI_CHAT_TIMEOUT_MS || '').trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n >= 45_000) return Math.min(n, 7_200_000);
  // Default: 14m — room for ~2 heavy LM calls + enrichment without AbortSignal killing the POST first.
  return 840_000;
}

/**
 * Global `fetch` uses undici with a default headers/body timeout (~300s) that is shorter than
 * `getUiChatFetchTimeoutMs()`. Flask also sends headers only after the handler finishes, so long
 * LLM work looks like "headers timeout" unless we align undici with our abort budget.
 */
async function fetchKnowledgeLongWait(url, init, timeoutMs = getUiChatFetchTimeoutMs()) {
  const t = Math.max(45_000, Math.min(Number(timeoutMs) || getUiChatFetchTimeoutMs(), 7_200_000));
  const dispatcher = new Agent({
    headersTimeout: t,
    bodyTimeout: t,
    connectTimeout: Math.min(120_000, t),
  });
  try {
    return await undiciFetch(url, { ...init, dispatcher });
  } finally {
    try {
      await dispatcher.close();
    } catch {
      /* ignore */
    }
  }
}

/** Map undici / system errors to a short user-facing line (not everything is a "timeout"). */
function explainKnowledgeFetchFailure(err) {
  const cause = err?.cause;
  const code = cause && typeof cause === 'object' ? cause.code : '';
  const causeName = cause && typeof cause === 'object' ? cause.name : '';
  const msg = String(err?.message || err);
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || causeName === 'HeadersTimeoutError') {
    return {
      status: 504,
      error: 'knowledge_slow',
      message:
        'The Knowledge API did not send a full response in time. That usually means the **local LLM** (default port 5000) is still loading, hung, or restarted — not a missing file on disk. Check Status → local_llm, wait for the model to finish loading, or raise BUTLER_UI_CHAT_TIMEOUT_MS (and BUTLER_PEEPEE_HTTP_TIMEOUT_SEC on the Knowledge process).',
    };
  }
  if (
    code === 'UND_ERR_CONNECT' ||
    code === 'ECONNREFUSED' ||
    /ECONNREFUSED|ENOTFOUND|aggregate error/i.test(msg) ||
    (cause && String(cause.message || '').includes('ECONNREFUSED'))
  ) {
    return {
      status: 503,
      error: 'knowledge_unreachable',
      message:
        'Cannot reach the Knowledge API (usually http://127.0.0.1:8765). Start **npm run dev:knowledge** or your packaged Knowledge service. This is a **connection** failure, not the model refusing a prompt.',
    };
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return {
      status: 504,
      error: 'chat_timeout',
      message: `The chat request hit the wait limit (AbortSignal after ${getUiChatFetchTimeoutMs()} ms). Set BUTLER_UI_CHAT_TIMEOUT_MS on ui-server (≥45000, e.g. 600000 for 10 min) or shorten the task. Also raise BUTLER_PEEPEE_HTTP_TIMEOUT_SEC on Knowledge if the local LLM stalls mid-request.`,
    };
  }
  if (/timeout|timed out/i.test(msg) && !/HeadersTimeoutError/i.test(String(causeName))) {
    return {
      status: 504,
      error: 'chat_timeout',
      message: msg.slice(0, 500),
    };
  }
  return {
    status: 500,
    error: 'chat_failed',
    message: msg.slice(0, 800) || 'Request failed',
  };
}

/** Allow opening only paths under the Butler data root (matches Python butlor_paths). */
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

/** MIME for Range streaming of saved SD / episode clips under the Butler data folder. */
function videoMimeFromFilePath(filePath) {
  const low = String(filePath || '').toLowerCase();
  if (low.endsWith('.webm')) return 'video/webm';
  if (low.endsWith('.mov')) return 'video/quicktime';
  if (low.endsWith('.mkv')) return 'video/x-matroska';
  if (low.endsWith('.m4v')) return 'video/x-m4v';
  if (low.endsWith('.gif')) return 'image/gif';
  return 'video/mp4';
}

/** print3d STL download query: basename only, no traversal. */
function safePrint3dStlQueryName(name) {
  const s = String(name || '').trim();
  if (!s || s.length > 240) return null;
  if (s.includes('..') || s.includes('/') || s.includes('\\')) return null;
  if (!/^[a-zA-Z0-9_.-]+\.stl$/i.test(s)) return null;
  return s;
}

/**
 * Knowledge API may be an older build without `print3d` in /butlor/data_summary; inject the row
 * so Settings → Data folder always lists the 3D print directory.
 */
async function mergePrint3dRowIntoDataSummary(data) {
  if (!data || typeof data !== 'object' || data.ok === false) return data;
  const locs = Array.isArray(data.locations) ? data.locations : [];
  if (locs.some((x) => x && x.id === 'print3d')) return data;
  const root = (data.root && String(data.root).trim()) || getButlorConfigDirAbs();
  const print3dDir = path.join(path.resolve(root), 'print3d');
  await mkdir(print3dDir, { recursive: true });
  let count = 0;
  try {
    const names = await readdir(print3dDir);
    for (const name of names) {
      try {
        const st = await stat(path.join(print3dDir, name));
        if (st.isFile()) count++;
      } catch {
        /* */
      }
    }
  } catch {
    /* */
  }
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
  return { ...data, locations };
}

/**
 * Same payload as Knowledge API GET /butlor/data_summary (knowledge/butlor_paths.py).
 * Used when Python is an older build (404) or unreachable so Settings → Data folder still works.
 */
async function summarizeButlorDataForSettings() {
  const root = getButlorConfigDirAbs();
  await mkdir(root, { recursive: true });

  async function countFilesInDir(dir) {
    try {
      const names = await readdir(dir);
      let n = 0;
      for (const name of names) {
        try {
          const st = await stat(path.join(dir, name));
          if (st.isFile()) n++;
        } catch {
          /* skip */
        }
      }
      return n;
    } catch {
      return 0;
    }
  }

  async function isFile(p) {
    try {
      return (await stat(p)).isFile();
    } catch {
      return false;
    }
  }

  const applications = path.join(root, 'applications');
  const generated = path.join(root, 'generated');
  const print3d = path.join(root, 'print3d');
  await mkdir(print3d, { recursive: true });
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
    const raw = await readFile(jtp, 'utf8');
    const j = JSON.parse(raw);
    jobTracked = Array.isArray(j.jobs) ? j.jobs.length : 0;
  } catch {
    /* no tracker */
  }

  const trainingEnv = String(process.env.BUTLER_TRAINING_LOG || '').trim();
  const trainingPath = trainingEnv ? path.resolve(trainingEnv) : path.join(root, 'butler_training.jsonl');
  if (trainingEnv) {
    await mkdir(path.dirname(trainingPath), { recursive: true }).catch(() => {});
  }

  let trainingLines = 0;
  try {
    const txt = await readFile(trainingPath, 'utf8');
    for (const line of txt.split('\n')) {
      if (line.trim()) trainingLines++;
    }
  } catch {
    /* missing log */
  }

  const gmailC = path.join(root, 'gmail_credentials.json');
  const gmailT = path.join(root, 'gmail_token.json');

  const locations = [
    {
      id: 'root',
      label: 'Butler data folder',
      detail: 'Default: D:\\butler on Windows, else ~/Documents/Butlor. Override with BUTLOR_CONFIG in .env.',
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

  return {
    ok: true,
    root,
    butlor_config_env: envRaw || null,
    locations,
  };
}

function getEnvPath() {
  return path.resolve(__dirname, '.env');
}

/** Same file Electron uses in dev (`ui/electron` → repo `.env`). */
const envPath = getEnvPath();

/**
 * Match Electron `app.getPath('userData')/config.json` (package name code-helper-ui).
 * Override with BUTLER_CONFIG_PATH for tests.
 */
function getConfigPath() {
  if (process.env.BUTLER_CONFIG_PATH) return process.env.BUTLER_CONFIG_PATH;
  const base =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'code-helper-ui')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'code-helper-ui')
        : path.join(os.homedir(), '.config', 'code-helper-ui');
  return path.join(base, 'config.json');
}

function readButlerDevPathsFromConfig() {
  try {
    const cfgPath = getConfigPath();
    if (!existsSync(cfgPath)) return { globalRoot: '', trustedRoots: [], allowAnyPath: false };
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const globalRoot = String(cfg.butler_global_project_root || '').trim();
    const tr = cfg.butler_trusted_roots;
    const trustedRoots = Array.isArray(tr)
      ? tr.map((s) => String(s).trim()).filter(Boolean)
      : typeof tr === 'string'
        ? tr.split(/[;\n|]+/).map((s) => s.trim()).filter(Boolean)
        : [];
    return { globalRoot, trustedRoots, allowAnyPath: !!cfg.butler_allow_any_path };
  } catch {
    return { globalRoot: '', trustedRoots: [], allowAnyPath: false };
  }
}

function isButlerAllowAnyPath() {
  if (process.env.BUTLER_ALLOW_ANY_PATH === '1') return true;
  return !!readButlerDevPathsFromConfig().allowAnyPath;
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
    } catch {
      /* ignore */
    }
  };
  pushRoot(getDefaultButlorRoot());
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

function readButlerLocalOnlyFromConfigFile() {
  try {
    const cfgPath = getConfigPath();
    if (existsSync(cfgPath)) {
      const data = JSON.parse(readFileSync(cfgPath, 'utf8'));
      return !!data.local_only;
    }
  } catch {
    /* */
  }
  return false;
}

function readOpenAIKey() {
  if (readButlerLocalOnlyFromConfigFile()) return '';
  try {
    const cfgPath = getConfigPath();
    let fromConfig = '';
    if (existsSync(cfgPath)) {
      const data = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (data.local_only) return '';
      fromConfig = (data.openai_api_key || '').trim();
    }
    if (fromConfig) return fromConfig;
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf8');
      const m = content.match(/OPENAI_API_KEY\s*=\s*(.+)/m);
      const fromEnvFile = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
      if (fromEnvFile) return fromEnvFile;
    }
    return String(process.env.OPENAI_API_KEY || '').trim();
  } catch {
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
  // Keep request bounded; the export pipeline is not meant for huge embedded images.
  const capped = raw.length > 60_000 ? raw.slice(0, 60_000) : raw;

  const client = new OpenAI({ apiKey: key });
  const system = [
    'You are a resume formatter.',
    'Convert the user HTML into a clean, template-friendly HTML fragment for Word/PDF export.',
    'Output MUST be strict JSON: {"html": "<...>"} with no markdown fences.',
    'Allowed tags ONLY: h1,h2,h3,p,ul,ol,li,blockquote,hr,br.',
    'Use <h1> for the candidate name (exactly one).',
    'Use <h2> for section headings (Experience, Skills, Education, Projects, Certifications, Links, Summary).',
    'Convert bullet-like lines into <ul><li>…</li></ul>.',
    'Remove decorative characters, excessive whitespace, and duplicate headings.',
    'If a section should start on a new page (e.g. Education on long resumes), insert <hr data-pagebreak="1" /> immediately before that <h2>.',
    'Do NOT invent content. Preserve all factual details.',
  ].join('\n');

  const user = `INPUT_HTML:\n${capped}`;

  const resp = await client.responses.create({
    model: 'gpt-4o-mini',
    input: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    max_output_tokens: 1600,
  });
  const text = (resp.output_text || '').trim();
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    // Try to extract JSON object if model accidentally adds text.
    const m = text.match(/\{[\s\S]*\}$/);
    out = m ? JSON.parse(m[0]) : null;
  }
  const htmlOut = String(out?.html || '').trim();
  if (!htmlOut) throw new Error('AI did not return html');
  return htmlOut;
}

/** Client never sends the key; Knowledge API expects openai_api_key. */
function mergeJobBodyWithOpenAiKey(rawBody) {
  const body = { ...(rawBody || {}) };
  const k = String(body.openai_api_key || '').trim();
  if (k) return body;
  const fromServer = readOpenAIKey();
  if (fromServer) body.openai_api_key = fromServer;
  return body;
}

const SD_CONNECTIVITY_TEST_PROMPT =
  'soft pastel abstract gradient wallpaper, high detail, centered composition, 4k, no text — Butler connectivity test image';

/** LLM ``prompt`` in JSON is often safety-scrubbed; local ComfyUI should use the user's exact chat text. */
function sdUserPromptOrModel(userMessage, modelPrompt) {
  const u = String(userMessage ?? '').trim();
  if (u.length >= 2) return u;
  return String(modelPrompt ?? '').trim();
}

/** /test or /text at start or end → Knowledge API sweeps workflows (ComfyUI/workflows/test/ if it has .json, else main folder; matches comfy_helper). */
function img2imgTripleTestRequested(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  const low = s.toLowerCase();
  if (low === '/test' || low === '/text') return true;
  if (low.startsWith('/test ') || low.startsWith('/text ')) return true;
  return /(?:^|\s)\/(?:test|text)\s*$/i.test(s);
}

function parseLlmHostPort(raw) {
  const s = (raw || '').trim();
  if (!s) return { host: '127.0.0.1', port: 5000 };
  try {
    const u = new URL(s.includes('://') ? s : `http://${s}`);
    const host = u.hostname || '127.0.0.1';
    let port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    return { host, port };
  } catch {
    return { host: '127.0.0.1', port: 5000 };
  }
}

function isLocalLlmHost(host) {
  const h = String(host || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port }, () => {
      sock.destroy();
      resolve({ ok: true, detail: `TCP ${host}:${port} open` });
    });
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ ok: false, detail: 'Connection timed out' });
    });
    sock.on('error', (err) => {
      resolve({ ok: false, detail: String(err?.message || err).slice(0, 160) });
    });
  });
}

async function probeHttpGet(url, timeoutMs) {
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 401 || r.status === 403 || r.status === 405) {
      return { ok: true, detail: `HTTP ${r.status} (reachable)` };
    }
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
    return { ok: true, detail: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, detail: String(e?.cause?.message || e?.message || e).slice(0, 180) };
  }
}

async function probeComfyFromHost(comfyBase) {
  const b = comfyBase.replace(/\/$/, '');
  let baseProbe = { ok: false, detail: '' };
  for (const p of ['/system_stats', '/']) {
    baseProbe = await probeHttpGet(b + p, 3500);
    if (baseProbe.ok) break;
  }
  if (!baseProbe.ok) return baseProbe;
  // Prefer a single-node schema probe — full /object_info can MemoryError under RAM pressure.
  const oi = await probeHttpGet(`${b}/object_info/CheckpointLoaderSimple`, 8000);
  if (!oi.ok) {
    return {
      ok: false,
      detail: `Port answered (${baseProbe.detail}) but API not ready yet — ${oi.detail}. Comfy may still be loading custom nodes; wait and refresh.`,
    };
  }
  return {
    ok: true,
    detail: `Ready (${baseProbe.detail} + node schema OK)`,
  };
}

function parseComfyPortFromEnv() {
  try {
    const raw = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').trim().replace(/\/$/, '');
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return 8188;
  }
}

/** Best-effort: stop whatever is listening on TCP port (dev restart for Knowledge API, etc.). */
function killTcpListenersOnPort(port) {
  const p = Number(port);
  if (!p || p < 1 || p > 65535) return;
  try {
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "$ids = Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($ids) { $ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }"`,
        { stdio: 'ignore', timeout: 20000, windowsHide: true },
      );
    } else {
      try {
        const out = execSync(`lsof -ti:${p}`, { encoding: 'utf8' });
        for (const pid of out.trim().split('\n')) {
          if (pid) execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
        }
      } catch {
        /* no listeners */
      }
    }
  } catch {
    /* ignore */
  }
}

/** Spawn api_server.py / ai_server.py from repo knowledge/ (Windows: prefer py -3 like Comfy spawn). */
function spawnKnowledgeScript(root, fileName) {
  const cwd = path.join(root, 'knowledge');
  const fp = path.join(cwd, fileName);
  if (!existsSync(fp)) return false;
  const opts = { cwd, detached: true, stdio: 'ignore' };
  let child;
  if (process.platform === 'win32') {
    const pyLauncher = path.join(process.env.SystemRoot || 'C:\\Windows', 'py.exe');
    if (existsSync(pyLauncher)) {
      child = spawn(pyLauncher, ['-3', fileName], opts);
    } else {
      child = spawn('python', [fileName], opts);
    }
  } else {
    child = spawn('python3', [fileName], opts);
  }
  child.on('error', (err) => console.error(`[ui-server] spawn ${fileName}:`, err?.message || err));
  child.unref();
  return true;
}

/**
 * Dev/browser: spawn Comfy / Knowledge / ai_server. Knowledge API: frees 8765 then starts a new process.
 */
async function tryRestartServiceFromDevHost(service) {
  const root = path.resolve(__dirname);

  if (service === 'knowledge_api') {
    killTcpListenersOnPort(8765);
    await new Promise((r) => setTimeout(r, 700));
    if (!spawnKnowledgeScript(root, 'api_server.py')) {
      return { ok: false, message: 'Missing knowledge/api_server.py' };
    }
    return {
      ok: true,
      message:
        'Restarted Knowledge API: freed port 8765 if needed and started api_server.py (py -3 on Windows when available). Wait a few seconds, then Refresh.',
    };
  }

  if (service === 'comfyui') {
    const port = parseComfyPortFromEnv();
    killTcpListenersOnPort(port);
    await new Promise((r) => setTimeout(r, 700));
    const sdRoot = resolveSdProjectPath(root);
    const comfyDir = path.join(sdRoot, 'ComfyUI');
    const mainPy = path.join(comfyDir, 'main.py');
    if (!existsSync(mainPy)) return { ok: false, message: 'ComfyUI not found at ' + mainPy };
    const venvWin = path.join(comfyDir, 'venv', 'Scripts', 'python.exe');
    const venvUnix = path.join(comfyDir, 'venv', 'bin', 'python');
    const patchPy = path.join(root, 'scripts', 'patch_comfy_object_info_cache.py');
    const patchPython = process.platform === 'win32' && existsSync(venvWin) ? venvWin : existsSync(venvUnix) ? venvUnix : null;
    if (patchPython && existsSync(patchPy)) {
      try {
        execSync(`"${patchPython}" "${patchPy}"`, {
          cwd: root,
          stdio: 'ignore',
          timeout: 20000,
          windowsHide: true,
        });
      } catch (e) {
        console.warn('[ui-server] object_info cache patch:', e?.message || e);
      }
    }
    // 12GB 4070 should run SDXL FaceID in normal VRAM. cudaMallocAsync on Windows+torch<2.8
    // often causes false "Allocation on device" OOMs during CheckpointLoader — disable it.
    // --disable-pinned-memory: Windows otherwise pins ~40% of system RAM (~13GB on 32GB hosts),
    // which collides with Python safetensors loads and /object_info JSON dumps (MemoryError).
    // Override with COMFYUI_EXTRA_ARGS (e.g. "--lowvram") only if you truly need it.
    const extraArgs = String(
      process.env.COMFYUI_EXTRA_ARGS || '--disable-cuda-malloc --disable-pinned-memory',
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const comfyArgs = ['main.py', ...extraArgs];
    const env = {
      ...process.env,
      SD_PROJECT_PATH: sdRoot,
      COMFYUI_URL: process.env.COMFYUI_URL || 'http://127.0.0.1:8188',
      PYTORCH_CUDA_ALLOC_CONF:
        process.env.PYTORCH_CUDA_ALLOC_CONF || 'expandable_segments:True',
    };
    const logPath = path.join(comfyDir, 'butler-comfy-spawn.log');
    let logFd;
    try {
      logFd = openSync(logPath, 'a');
      writeSync(
        logFd,
        `\n\n===== Butler ComfyUI spawn ${new Date().toISOString()} (cwd=${comfyDir}) args=${comfyArgs.join(' ')} =====\n`,
      );
    } catch (e) {
      console.error('[ui-server] ComfyUI log file:', e?.message || e);
      logFd = null;
    }
    const spawnOpts = {
      cwd: comfyDir,
      detached: true,
      windowsHide: true,
      stdio: logFd != null ? ['ignore', logFd, logFd] : 'ignore',
      env,
    };
    let child;
    if (process.platform === 'win32' && existsSync(venvWin)) {
      child = spawn(venvWin, comfyArgs, spawnOpts);
    } else if (process.platform !== 'win32' && existsSync(venvUnix)) {
      child = spawn(venvUnix, comfyArgs, spawnOpts);
    } else if (process.platform === 'win32') {
      const pyLauncher = path.join(process.env.SystemRoot || 'C:\\Windows', 'py.exe');
      child = existsSync(pyLauncher)
        ? spawn(pyLauncher, ['-3', ...comfyArgs], spawnOpts)
        : spawn(`py -3 ${comfyArgs.map((a) => `"${a}"`).join(' ')}`, [], { ...spawnOpts, shell: true });
    } else {
      child = spawn('python3', comfyArgs, spawnOpts);
    }
    const closeLog = () => {
      if (logFd == null) return;
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }
      logFd = null;
    };
    let spawnError = null;
    let spawnConfirmed = false;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const t = setTimeout(() => {
        closeLog();
        done();
      }, 4000);
      child.once('spawn', () => {
        clearTimeout(t);
        spawnConfirmed = true;
        closeLog();
        done();
      });
      child.once('error', (err) => {
        clearTimeout(t);
        spawnError = err;
        closeLog();
        console.error('[ui-server] ComfyUI spawn:', err?.message || err);
        done();
      });
    });
    child.unref();
    if (spawnError) {
      return {
        ok: false,
        message: `ComfyUI did not start: ${spawnError.message}. See ${logPath}`,
      };
    }
    if (!spawnConfirmed) {
      return {
        ok: false,
        message: `ComfyUI process did not launch within a few seconds (cwd ${comfyDir}). See ${logPath}`,
      };
    }
    return {
      ok: true,
      message:
        `Restarted ComfyUI with ${extraArgs.join(' ') || 'default args'}: freed the Comfy port if needed and started main.py in the background. First load can take several minutes. If 8188 still refuses, see ComfyUI/butler-comfy-spawn.log for Python errors.`,
    };
  }

  if (service === 'local_llm') {
    const llmRaw = (process.env.BUTLOR_AI_URL || process.env.PEEPEEDEE_AI_URL || 'http://localhost:5000').trim();
    const { host, port } = parseLlmHostPort(llmRaw);
    if (!isLocalLlmHost(host)) {
      return {
        ok: false,
        message: `LLM is ${host}:${port} (not this PC). Start or restart that server where it runs; Butler only spawns ai_server.py locally.`,
      };
    }
    killTcpListenersOnPort(port);
    await new Promise((r) => setTimeout(r, 700));
    if (!spawnKnowledgeScript(root, 'ai_server.py')) {
      return { ok: false, message: 'Missing knowledge/ai_server.py' };
    }
    return {
      ok: true,
      message: 'Restarted local LLM helper: freed the LLM TCP port if needed and started ai_server.py in the background.',
    };
  }

  return { ok: false, message: 'Unknown service' };
}

/** Restart every service this dev host can spawn (order: LLM → Comfy → Knowledge API). */
async function tryRestartAllServicesFromDevHost() {
  const comfyOff = ['0', 'false', 'no', 'off'].includes((process.env.USE_COMFYUI || '1').trim().toLowerCase());
  const sequence = ['local_llm'];
  if (!comfyOff) sequence.push('comfyui');
  sequence.push('knowledge_api');
  const parts = [];
  let allOk = true;
  for (const s of sequence) {
    const out = await tryRestartServiceFromDevHost(s);
    if (!out.ok) allOk = false;
    parts.push(`${s}: ${out.message}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    ok: allOk,
    message: parts.join('\n\n'),
  };
}

/** When Knowledge API is down, still list every service with local TCP/HTTP probes from ui-server. */
async function buildStatusFallbackFromHost(knowledgeUrl, errorMessage) {
  const services = [];
  services.push({
    id: 'knowledge_api',
    label: 'Knowledge API',
    ok: false,
    url: knowledgeUrl,
    detail: errorMessage || 'Unreachable',
  });

  const comfyOff = ['0', 'false', 'no', 'off'].includes((process.env.USE_COMFYUI || '1').trim().toLowerCase());
  const comfyUrl = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').trim();
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
    const c = await probeComfyFromHost(comfyUrl);
    services.push({
      id: 'comfyui',
      label: 'ComfyUI (images / video)',
      ok: c.ok,
      url: comfyUrl,
      detail: c.detail,
    });
  }

  const llmRaw = (process.env.BUTLOR_AI_URL || process.env.PEEPEEDEE_AI_URL || 'http://localhost:5000').trim();
  const { host, port } = parseLlmHostPort(llmRaw);
  const llmTcp = await probeTcp(host, port, 2000);
  services.push({
    id: 'local_llm',
    label: 'Local LLM',
    ok: llmTcp.ok,
    url: llmRaw,
    model: process.env.LOCAL_MODEL || 'pepee',
    detail: llmTcp.detail + (llmTcp.ok ? ' — expects POST /chat' : ''),
  });

  const forgeBase = (process.env.SD_API_URL || 'http://127.0.0.1:7860').trim().replace(/\/$/, '');
  const fr = await probeHttpGet(`${forgeBase}/sdapi/v1/sd-models`, 3000);
  services.push({
    id: 'forge_api',
    label: 'Forge / Automatic1111 API',
    ok: fr.ok,
    url: forgeBase,
    detail: fr.detail,
  });

  const sdPath = resolveSdProjectPath(__dirname);
  services.push({
    id: 'sd_project',
    label: 'SD project path',
    ok: existsSync(sdPath),
    detail: sdPath,
  });

  const key = readOpenAIKey();
  services.push({
    id: 'openai_key',
    label: 'OpenAI API key (structured intent)',
    ok: !!key,
    detail: key ? 'Configured (Butler Settings / .env)' : 'Optional — improves routing when local model is weak',
  });

  let tsharkDetail = 'Not checked';
  let tsharkOk = false;
  try {
    const p = await probeTsharkForStatusRow();
    tsharkOk = !!p.ok;
    tsharkDetail = p.detail || (p.ok ? 'tshark OK' : 'Unavailable');
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

/** Fixed order; local rows are the baseline so every service appears even when Knowledge /status fails. */
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

function mergeStatusServices(localServices, apiServices) {
  const byLocal = new Map((localServices || []).map((s) => [s.id, s]));
  const byApi = new Map((apiServices || []).map((s) => [s.id, s]));
  const out = [];
  const seen = new Set();
  for (const id of STATUS_SERVICE_ORDER) {
    const loc = byLocal.get(id);
    const api = byApi.get(id);
    if (!loc && !api) continue;
    out.push(api && loc ? { ...loc, ...api } : api || loc);
    seen.add(id);
  }
  for (const s of apiServices || []) {
    if (s && s.id && !seen.has(s.id)) {
      out.push(s);
      seen.add(s.id);
    }
  }
  return out;
}

async function fetchKnowledge(query, n = 5) {
  if (!query || typeof query !== 'string') return '';
  try {
    const url = `${KNOWLEDGE_API_URL}/knowledge?q=${encodeURIComponent(query)}&n=${n}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return '';
    const data = await res.json();
    const results = data?.results || [];
    if (results.length === 0) return '';
    return results.map((r) => r.content || '').filter(Boolean).join('\n\n---\n\n');
  } catch {
    return '';
  }
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Code Helper is a locked-down learning-only variant.
// Enforce server-side restrictions (UI hiding alone is not sufficient).
const BUTLER_VARIANT = String(process.env.BUTLER_VARIANT || '').trim() || 'butler';
app.use((req, res, next) => {
  try {
    if (BUTLER_VARIANT !== 'code-helper') return next();
    const p = String(req.path || '');
    if (!p.startsWith('/api/')) return next();
    // Allow only the learning assistant and minimal health checks.
    if (p === '/api/health' || p === '/api/chat') return next();
    return res.status(403).json({
      ok: false,
      error: 'code_helper_locked_down',
      message: 'Code Helper is learning-only. This module is disabled in this build.',
    });
  } catch {
    return res.status(403).json({
      ok: false,
      error: 'code_helper_locked_down',
      message: 'Code Helper is learning-only. This module is disabled in this build.',
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'butler-ui-server',
    variant: String(process.env.BUTLER_VARIANT || '').trim() || 'butler',
  });
});

const knowledgeDir = path.resolve(__dirname, 'knowledge');
const cliPy = path.join(knowledgeDir, 'ableton_cli.py');

function runAbletonCli(action, args = []) {
  return new Promise((resolve, reject) => {
    const pyExe = process.platform === 'win32' ? 'py' : 'python3';
    const procArgs = process.platform === 'win32' ? ['-3', cliPy, action, ...args] : [cliPy, action, ...args];
    const proc = spawn(pyExe, procArgs, { cwd: knowledgeDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d) => { out += d.toString(); });
    proc.stderr?.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0 && !out.trim()) resolve({ stdout: '', stderr: err || `Exit ${code}` });
      else resolve({ stdout: out, stderr: err });
    });
    proc.on('error', reject);
  });
}

app.post('/api/ableton', async (req, res) => {
  try {
    const { action, bpm, path: midiPath } = req.body || {};
    if (!existsSync(cliPy)) {
      return res.status(503).json({ ok: false, message: 'Ableton integration not available. Add knowledge/ableton_cli.py' });
    }
    const cmdArgs = [String(action || 'status')];
    if (action === 'tempo' && bpm != null) cmdArgs.push(String(bpm));
    if (action === 'midi') {
      cmdArgs.push(midiPath || path.join(os.homedir(), 'Desktop', 'butlor_drums.mid'));
      if (bpm != null) cmdArgs.push(String(bpm));
    }
    const { stdout, stderr } = await runAbletonCli(action || 'status', cmdArgs.slice(1));
    let data = {};
    try {
      data = JSON.parse(stdout.trim() || '{}');
    } catch {
      data = { ok: false, message: (stdout || stderr || 'Unknown error').trim() };
    }
    if (!data.message && data.ok === false) data.message = stderr || 'Command failed';
    return res.json(data);
  } catch (err) {
    console.error('Ableton API error:', err);
    return res.status(500).json({ ok: false, message: String(err?.message || err) });
  }
});

async function ensureProjectRoot(sessionId) {
  const globalRoot = getEffectiveGlobalProjectRoot();
  if (globalRoot) {
    if (!existsSync(globalRoot)) {
      await mkdir(globalRoot, { recursive: true });
    }
    return globalRoot;
  }
  if (!existsSync(projectsRoot)) {
    await mkdir(projectsRoot, { recursive: true });
  }
  const projectRoot = path.join(projectsRoot, sessionId);
  if (!existsSync(projectRoot)) {
    await mkdir(projectRoot, { recursive: true });
  }
  return projectRoot;
}

/** Agent window: explicit cwd wins, then Settings global root, then session folder. */
async function resolveAgentProjectRoot(sessionId, cwd) {
  const explicit = String(cwd || '').trim();
  if (explicit) {
    try {
      const resolved = path.resolve(explicit);
      if (!existsSync(resolved)) {
        await mkdir(resolved, { recursive: true });
      }
      return resolved;
    } catch {
      /* fall through */
    }
  }
  return ensureProjectRoot(String(sessionId || 'butler-agent'));
}

async function collectFiles(rootDir, { maxFiles = 30, maxBytesPerFile = 4000, maxDepth = 24 } = {}) {
  const results = [];
  const visited = new Set();
  async function walk(dir, depth) {
    if (results.length >= maxFiles || depth > maxDepth) return;
    let canon;
    try {
      canon = await realpath(dir);
    } catch {
      return;
    }
    const key = canon.toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full);
      if (rel.startsWith('.git') || rel.startsWith('node_modules') || rel.startsWith('dist') || rel.startsWith('build')) continue;
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        try {
          const content = await readFile(full, 'utf8');
          results.push({ path: rel.replace(/\\/g, '/'), snippet: content.slice(0, maxBytesPerFile) });
        } catch {
          // ignore binary
        }
      }
    }
  }
  await walk(rootDir, 0);
  return results;
}

/** Env passed to mode:actions run_command so shells can use %LOCAL_AI_URL% / $env:LOCAL_AI_URL (matches normalized KNOWLEDGE_API_URL). */
function getActionShellChildEnv() {
  const base = String(KNOWLEDGE_API_URL || '').trim() || 'http://127.0.0.1:8765';
  return { ...process.env, KNOWLEDGE_API_URL: base, LOCAL_AI_URL: base };
}

/** npm on Windows may try mkdir D:\\node_modules if cwd is a bare drive — reject that. */
function safeRunCommandCwd(rawCwd, projectRoot) {
  const pr = path.resolve(projectRoot);
  const raw =
    rawCwd != null && String(rawCwd).trim() !== '' ? String(rawCwd).trim() : '.';
  const cwd = path.resolve(path.isAbsolute(raw) ? raw : path.join(pr, raw));
  const norm = path.normalize(cwd);
  const noTrail = norm.replace(/[/\\]+$/, '') || norm;
  if (process.platform === 'win32' && /^[a-zA-Z]:$/i.test(noTrail)) return pr;
  if (noTrail === '/' || noTrail === '') return pr;
  return norm;
}

async function runShell(command, cwd) {
  try {
    const { stdout, stderr } = await exec(command, {
      cwd,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: getActionShellChildEnv(),
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

/**
 * Extra apply attempts after failures (each attempt can include several model follow-ups).
 * 0 = fail fast (no follow-up). Default 15 when unset. Capped for safety.
 */
function getActionsAutonomyMaxRetries() {
  const envVal = process.env.BUTLER_ACTIONS_AUTONOMY_ROUNDS;
  const raw = envVal === undefined || envVal === null ? '' : String(envVal).trim();
  if (raw === '') return 15;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 15;
  return Math.min(n, 40);
}

/** How many times to re-ask the model for valid mode "actions" when it returns chat or bad JSON (per apply failure). */
function getActionsAutonomyInnerMax() {
  const envVal = process.env.BUTLER_ACTIONS_AUTONOMY_INNER;
  const raw = envVal === undefined || envVal === null ? '' : String(envVal).trim();
  if (raw === '') return 5;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(n, 12);
}

/** Default on. BUTLER_OWNER_MODE=0|false|off|no disables. */
function isButlerOwnerMode() {
  const v = String(process.env.BUTLER_OWNER_MODE || '')
    .trim()
    .toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  return true;
}

function spawnBackgroundShellCommand(command, cwd) {
  const opts = {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: true,
    env: getActionShellChildEnv(),
  };
  const child = spawn(String(command), opts);
  child.on('error', (err) => {
    console.error('[ui-server] background run_command:', err?.message || err);
  });
  child.unref();
}

async function applyActions(projectRoot, actions = []) {
  const summary = { files: [], downloads: [], commands: [] };
  const list = Array.isArray(actions) ? actions : [];
  for (const action of list) {
    if (!action?.type) continue;
    if (action.type === 'write_file') {
      if (!action.path || typeof action.content !== 'string') continue;
      const rawPath = String(action.path);
      const safeRel = path.isAbsolute(rawPath)
        ? path.relative(projectRoot, rawPath)
        : rawPath.replace(/^([A-Za-z]:)?[\\/]+/, '');
      const target = path.join(projectRoot, safeRel);
      const dir = path.dirname(target);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      await writeFile(target, action.content, 'utf8');
      summary.files.push(safeRel);
    } else if (action.type === 'download_file') {
      if (!action.url || !action.path) continue;
      const res = await fetch(String(action.url));
      if (!res.ok) throw new Error(`Download failed (${res.status}) for ${action.url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const rawPath = String(action.path);
      const safeRel = path.isAbsolute(rawPath)
        ? path.relative(projectRoot, rawPath)
        : rawPath.replace(/^([A-Za-z]:)?[\\/]+/, '');
      const target = path.join(projectRoot, safeRel);
      const dir = path.dirname(target);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      await writeFile(target, buf);
      summary.downloads.push(safeRel);
    } else if (action.type === 'run_command') {
      if (!action.command) continue;
      const rawCwd = action.cwd ? String(action.cwd) : projectRoot;
      const cwd = safeRunCommandCwd(rawCwd, projectRoot);
      if (action.background === true) {
        spawnBackgroundShellCommand(String(action.command), cwd);
        summary.commands.push(`${String(action.command)} (background)`);
        continue;
      }
      const result = await runShell(String(action.command), cwd);
      if (!result.ok) {
        throw new Error(
          `Command failed: ${action.command}\n${result.message}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
        );
      }
      summary.commands.push(String(action.command));
    }
  }
  return summary;
}

/** Shared body for Knowledge API POST /chat (initial user message + autonomy follow-ups). */
function buildKnowledgeChatPayload({
  message,
  history,
  session,
  projectRoot,
  localOnly,
  module,
  codeContext,
  cursorCli,
  initImage,
  attachment,
  sampleFiles,
}) {
  const lo = !!localOnly;
  let effectiveCodeContext =
    typeof codeContext === 'string' && codeContext.trim() ? codeContext.trim().slice(0, 12000) : '';
  if (BUTLER_VARIANT === 'code-helper') {
    try {
      const packPath = path.join(__dirname, 'knowledge', 'code-helper', 'CODE_HELPER_CONTEXT.md');
      const pack = readFileSync(packPath, 'utf8');
      const trimmed = String(pack || '').trim();
      if (trimmed) {
        const prefix = '[Code Helper coaching pack]\n';
        const combined = effectiveCodeContext ? `${prefix}${trimmed}\n\n[User context]\n${effectiveCodeContext}` : `${prefix}${trimmed}`;
        effectiveCodeContext = combined.slice(0, 12000);
      }
    } catch {
      // ignore if pack is missing
    }
  }
  return {
    message,
    // prior window aligned with Knowledge BUTLER_CHAT_HISTORY (default 24)
    prior_messages: Array.isArray(history) ? history.slice(-24) : [],
    known_answers: session.answers,
    sample_files: sampleFiles,
    project_root: projectRoot,
    knowledge_api_url: KNOWLEDGE_API_URL,
    // Cloud chat LLMs off unless BUTLER_CHAT_CLOUD=1 (generation stays local).
    openai_api_key: lo || process.env.BUTLER_CHAT_CLOUD !== '1' ? '' : readOpenAIKey(),
    local_only: !!lo || process.env.BUTLER_CHAT_CLOUD !== '1',
    ...(typeof module === 'string' && module.trim() ? { module_hint: module.trim() } : {}),
    ...(effectiveCodeContext ? { code_context: effectiveCodeContext } : {}),
    ...(cursorCli &&
    typeof cursorCli === 'object' &&
    cursorCli.enabled &&
    typeof cursorCli.command === 'string'
      ? (() => {
          let cmd = String(cursorCli.command).trim().slice(0, 200) || 'agent';
          if (/[&|;\n`$<>]/.test(cmd)) cmd = 'agent';
          return { cursor_cli: { enabled: true, command: cmd } };
        })()
      : {}),
    ...(typeof initImage === 'string' && initImage.trim().length > 80
      ? { init_image: initImage.trim() }
      : {}),
    ...(attachment &&
    typeof attachment === 'object' &&
    attachment !== null &&
    typeof attachment.data_base64 === 'string' &&
    attachment.data_base64.trim().length > 8
      ? {
          attachment: {
            filename: String(attachment.filename || attachment.name || 'attachment').slice(0, 500),
            mime_type: String(attachment.mime_type || attachment.mime || 'application/octet-stream').slice(
              0,
              200,
            ),
            data_base64: attachment.data_base64.trim(),
          },
        }
      : {}),
  };
}

async function runKnowledgeFollowUpOnce(fixMessage, ctx) {
  const {
    history,
    session,
    projectRoot,
    localOnly,
    module,
    codeContext,
    cursorCli,
    initImage,
    attachment,
    sampleFiles,
  } = ctx;
  const chatMs = getUiChatFetchTimeoutMs();
  const chatRes2 = await fetchKnowledgeLongWait(
    `${LOCAL_AI_URL}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildKnowledgeChatPayload({
          message: fixMessage,
          history,
          session,
          projectRoot,
          localOnly,
          module,
          codeContext,
          cursorCli,
          initImage,
          attachment,
          sampleFiles,
        }),
      ),
      signal: AbortSignal.timeout(chatMs),
    },
    chatMs,
  );
  if (!chatRes2.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await chatRes2.text()).slice(0, 1200);
    } catch {
      /* */
    }
    return { ok: false, httpStatus: chatRes2.status, bodySnippet, parsed: null };
  }
  try {
    const parsed = await chatRes2.json();
    return { ok: true, parsed };
  } catch (e) {
    return { ok: false, httpStatus: chatRes2.status, error: String(e?.message || e), parsed: null };
  }
}

app.get('/api/vram', async (_req, res) => {
  try {
    const r = await fetch(`${KNOWLEDGE_API_URL}/vram`, { signal: AbortSignal.timeout(12000) });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: String(e?.message || e),
      message: 'Could not reach Knowledge /vram. Is Knowledge API up?',
    });
  }
});

app.post('/api/vram/free', async (req, res) => {
  try {
    const r = await fetch(`${KNOWLEDGE_API_URL}/vram/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(45000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({
      ok: false,
      message: String(e?.message || e),
    });
  }
});

app.get('/api/status', async (_req, res) => {
  const STATUS_TIMEOUT_MS = 15000;
  const localPromise = buildStatusFallbackFromHost(KNOWLEDGE_API_URL, '');
  const apiPromise = (async () => {
    try {
      const r = await fetch(`${KNOWLEDGE_API_URL}/status`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      if (!r.ok) {
        return { services: null, error: `Knowledge API HTTP ${r.status}` };
      }
      const data = await r.json();
      return { services: Array.isArray(data.services) ? data.services : [], error: null };
    } catch (e) {
      return { services: null, error: String(e?.message || e) };
    }
  })();

  const [local, api] = await Promise.all([localPromise, apiPromise]);
  let services = mergeStatusServices(local.services, api.services);
  if (api.error) {
    services = services.map((s) =>
      s.id === 'knowledge_api'
        ? { ...s, ok: false, url: KNOWLEDGE_API_URL, detail: String(api.error).slice(0, 220) }
        : s,
    );
  }
  services.unshift({
    id: 'dev_proxy',
    label: 'Browser dev (Vite → ui-server)',
    ok: true,
    url: `http://127.0.0.1:${PORT}`,
    detail: 'API proxy: /api → this process; UI usually on http://localhost:5173',
  });

  const body = {
    generated_at: new Date().toISOString(),
    services,
  };
  if (api.error) {
    body.error = api.error;
    body.status_note = local.status_note;
  }
  return res.json(body);
});

app.post('/api/learn/go', async (req, res) => {
  try {
    const r = await fetch(`${LOCAL_AI_URL}/learn/go`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, message: String(e?.message || e) });
  }
});

app.get('/api/learn/go_status', async (_req, res) => {
  try {
    const r = await fetch(`${LOCAL_AI_URL}/learn/go_status`, { signal: AbortSignal.timeout(12000) });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
  } catch (e) {
    return res.status(502).json({ running: false, error: String(e?.message || e) });
  }
});

app.post('/api/status/restart', async (req, res) => {
  const service = String(req.body?.service || '').trim();
  if (!['comfyui', 'knowledge_api', 'local_llm', 'all'].includes(service)) {
    return res.status(400).json({
      ok: false,
      message:
        'Restart supports comfyui, knowledge_api, local_llm, or all (Forge/A1111 is external).',
    });
  }
  try {
    const out =
      service === 'all' ? await tryRestartAllServicesFromDevHost() : await tryRestartServiceFromDevHost(service);
    return res.json({ ok: out.ok, message: out.message });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const {
      message,
      history,
      sessionId = 'default',
      module,
      codeContext,
      cursorCli,
      localOnly,
      init_image: initImage,
      attachment,
    } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    fetch(`${LOCAL_AI_URL}/learn/research_topics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        prior_messages: Array.isArray(history) ? history.slice(-24) : [],
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
        return res.json({ reply: next.prompt || 'Please provide the next value.', source: 'Local' });
      }
    }

    const tCollect = Date.now();
    console.log('[ui-server] /api/chat: collecting sample files…', { sessionId: String(sessionId).slice(0, 80) });
    const sampleFiles = await collectFiles(projectRoot);
    console.log(
      '[ui-server] /api/chat: sample files',
      sampleFiles.length,
      'in',
      Date.now() - tCollect,
      'ms — calling Knowledge /chat…',
    );

    const rawLoc = req.body?.localOnly ?? req.body?.local_only;
    let resolvedLocalOnly = false;
    if (typeof rawLoc === 'boolean') {
      resolvedLocalOnly = rawLoc;
    } else if (rawLoc === 'true' || rawLoc === 1 || rawLoc === '1') {
      resolvedLocalOnly = true;
    } else if (rawLoc === 'false' || rawLoc === 0 || rawLoc === '0') {
      resolvedLocalOnly = false;
    } else {
      resolvedLocalOnly = readButlerLocalOnlyFromConfigFile();
    }
    // Code Helper is offline-only: force local inference regardless of client flags.
    const effectiveLocalOnly = BUTLER_VARIANT === 'code-helper' ? true : resolvedLocalOnly;
    const chatMs = getUiChatFetchTimeoutMs();
    const chatRes = await fetchKnowledgeLongWait(
      `${LOCAL_AI_URL}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildKnowledgeChatPayload({
            message,
            history,
            session,
            projectRoot,
            localOnly: effectiveLocalOnly,
            module,
            codeContext,
            cursorCli,
            initImage,
            attachment,
            sampleFiles,
          }),
        ),
        signal: AbortSignal.timeout(chatMs),
      },
      chatMs,
    );
    if (!chatRes.ok) {
      const errBody = await chatRes.text();
      return res.status(chatRes.status).json({
        error: 'local_ai_unavailable',
        message: chatRes.status === 503 ? (errBody || 'Local AI not available. Start the Knowledge API and your AI server (PEEPEEDEE_AI_URL).') : errBody,
      });
    }
    const parsed = await chatRes.json();
    if (parsed && typeof parsed.mode === 'string') {
      parsed.mode = parsed.mode.toLowerCase().trim();
    }
    const source = parsed.source || 'Local';

    if (parsed.mode === 'chat' && parsed.reply) {
      sessions.set(sessionId, session);
      const body = { reply: parsed.reply, source };
      if (Array.isArray(parsed.agent_steps) && parsed.agent_steps.length > 0) {
        body.agent = true;
        body.agent_steps = parsed.agent_steps;
      }
      return res.json(body);
    }

    if (parsed.mode === 'agent') {
      sessions.set(sessionId, session);
      let reply = parsed.reply || 'Agent finished.';
      if (Array.isArray(parsed.agent_steps) && parsed.agent_steps.length > 0) {
        const toolLines = parsed.agent_steps
          .filter((s) => s && s.type === 'tool')
          .map((s) => `- ${s.tool}: ${s.result?.ok ? 'ok' : s.result?.error || 'done'}`);
        if (toolLines.length > 0) {
          reply += '\n\n**Agent tools:**\n' + toolLines.join('\n');
        }
      }
      return res.json({
        reply,
        source: parsed.source || 'Agent',
        agent: true,
        agent_steps: parsed.agent_steps || [],
      });
    }

    if (parsed.mode === 'questions' && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
      session.pendingQuestions = parsed.questions;
      sessions.set(sessionId, session);
      return res.json({ reply: parsed.questions[0].prompt || 'I need one detail before proceeding.', source });
    }

    if (parsed.mode === 'sd_txt2img') {
      let txtPrompt = sdUserPromptOrModel(message, parsed.prompt);
      const sdConnectivityTest = !!parsed.sd_connectivity_test;
      if (sdConnectivityTest && !txtPrompt) txtPrompt = SD_CONNECTIVITY_TEST_PROMPT;
      if (!txtPrompt) {
        sessions.set(sessionId, session);
        return res.json({
          reply: parsed.reply || 'Describe the image you want in English (subject, style, mood).',
          source,
        });
      }
      try {
        const sdRes = await fetch(`${LOCAL_AI_URL}/sd/txt2img`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: txtPrompt }),
          signal: AbortSignal.timeout(120000),
        });
        const sdData = await sdRes.json();
        fillSdPayloadFromDisk(sdData);
        if (sdData.ok && sdData.images && sdData.images.length > 0) {
          session.lastGeneratedImage = sdData.images[0];
          sessions.set(sessionId, session);
          let imgReply = sdData.message || "Here's your image.";
          if (sdConnectivityTest) {
            imgReply += '\n\nGenerated via your local ComfyUI (port 8188).';
          }
          return res.json({
            reply: imgReply,
            source: 'Stable Diffusion',
            images: sdData.images,
            path: sdData.path,
          });
        }
        sessions.set(sessionId, session);
        return res.json({
          reply:
            sdData.message ||
            'Image generation failed. Start ComfyUI (e.g. port 8188), then try again.',
          source: 'Stable Diffusion',
        });
      } catch {
        sessions.set(sessionId, session);
        return res.json({
          reply:
            'Could not reach the Knowledge API / ComfyUI for images. Start ComfyUI and ensure the Knowledge API is running.',
          source: 'Stable Diffusion',
        });
      }
    }

    if (parsed.mode === 'sd_img2img') {
      const rawInit = typeof initImage === 'string' ? initImage.trim() : '';
      let lastImg = rawInit.length > 80 ? rawInit : session.lastGeneratedImage;
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
      try {
        const userWantsTestSweep = img2imgTripleTestRequested(message);
        const img2imgBody = {
          prompt:
            (userWantsTestSweep
              ? String(message).trim()
              : sdUserPromptOrModel(message, parsed.prompt)) || 'high quality, detailed',
          init_image: lastImg,
        };
        if (!userWantsTestSweep) {
          if (parsed.compare_nsfw_triple === true) img2imgBody.compare_nsfw_triple = true;
          if (parsed.compare_nsfw_triple === false) img2imgBody.compare_nsfw_triple = false;
        }
        const sdRes = await fetch(`${LOCAL_AI_URL}/sd/img2img`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(img2imgBody),
          signal: AbortSignal.timeout(900000),
        });
        const sdData = await sdRes.json();
        fillSdPayloadFromDisk(sdData);
        if (sdData.ok && sdData.images && sdData.images.length > 0) {
          session.lastGeneratedImage = sdData.images[0];
          sessions.set(sessionId, session);
          return res.json({
            reply: sdData.message || "Here's your edited image.",
            source: 'Stable Diffusion',
            images: sdData.images,
            path: sdData.path,
            variant_labels: sdData.variant_labels,
          });
        }
        sessions.set(sessionId, session);
        return res.json({
          reply: sdData.message || 'Image edit failed. Start ComfyUI (e.g. port 8188), then try again.',
          source: 'Stable Diffusion',
        });
      } catch {
        sessions.set(sessionId, session);
        return res.json({
          reply:
            'Could not reach the Knowledge API / ComfyUI for img2img. Start ComfyUI and ensure the Knowledge API is running.',
          source: 'Stable Diffusion',
        });
      }
    }

    if (parsed.mode === 'sd_txt2video') {
      const vidPrompt = sdUserPromptOrModel(message, parsed.prompt);
      if (!vidPrompt) {
        sessions.set(sessionId, session);
        return res.json({
          reply: parsed.reply || 'Describe the video you want (subject, motion, style).',
          source,
        });
      }
      try {
        const sdRes = await fetch(`${LOCAL_AI_URL}/sd/txt2video`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: vidPrompt }),
          signal: AbortSignal.timeout(600000),
        });
        const sdData = await sdRes.json();
        fillSdPayloadFromDisk(sdData);
        if (sdData.ok && sdData.video) {
          sessions.set(sessionId, session);
          const msg = String(sdData.message || '');
          const reply =
            msg.trim().length > 0 && !msg.includes('execution_') ? msg : 'Here’s your video — play it below.';
          return res.json({
            reply,
            source: 'Stable Diffusion',
            images: sdData.images || [],
            video: sdData.video,
            path: sdData.path,
          });
        }
        sessions.set(sessionId, session);
        return res.json({
          reply:
            sdData.message ||
            'Text-to-video failed. Add ComfyUI/workflows/butler_txt2video.json (API), or use Forge txt2video / SD_TXT2VIDEO_SCRIPT — see knowledge/COMFY_VIDEO_SETUP.txt.',
          source: 'Stable Diffusion',
        });
      } catch {
        sessions.set(sessionId, session);
        return res.json({
          reply:
            'Could not reach the Knowledge API for txt2video (long runs need ComfyUI + workflow). Ensure the Knowledge API and ComfyUI are running.',
          source: 'Stable Diffusion',
        });
      }
    }

    if (parsed.mode === 'sd_image2video') {
      const rawInitVid = typeof initImage === 'string' ? initImage.trim() : '';
      let lastForVid = rawInitVid.length > 80 ? rawInitVid : session.lastGeneratedImage;
      if (!lastForVid) lastForVid = readDesktopRbBase64Sync();
      if (!lastForVid) {
        sessions.set(sessionId, session);
        return res.json({
          reply:
            parsed.reply ||
            'Upload an image or generate one first, then ask to animate it or turn it into a video.',
          source,
        });
      }
      try {
        const sdRes = await fetch(`${LOCAL_AI_URL}/sd/image2video`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: sdUserPromptOrModel(message, parsed.prompt) || 'smooth motion, cinematic',
            init_image: lastForVid,
          }),
          signal: AbortSignal.timeout(600000),
        });
        const sdData = await sdRes.json();
        fillSdPayloadFromDisk(sdData);
        if (sdData.ok && sdData.video) {
          sessions.set(sessionId, session);
          const msg = String(sdData.message || '');
          const reply =
            msg.trim().length > 0 && !msg.includes('execution_') ? msg : 'Here’s your video — play it below.';
          return res.json({
            reply,
            source: 'Stable Diffusion',
            images: sdData.images || [],
            video: sdData.video,
            path: sdData.path,
          });
        }
        sessions.set(sessionId, session);
        return res.json({
          reply:
            sdData.message ||
            'Image-to-video failed. Add ComfyUI/workflows/butler_img2video.json (API), or use an SVD extension / SD_VIDEO_SCRIPT — see knowledge/COMFY_VIDEO_SETUP.txt.',
          source: 'Stable Diffusion',
        });
      } catch {
        sessions.set(sessionId, session);
        return res.json({
          reply:
            'Could not reach the Knowledge API for image2video. Ensure the Knowledge API and ComfyUI (with img2video workflow) are running.',
          source: 'Stable Diffusion',
        });
      }
    }

    if (parsed.mode === 'sound_musicgen') {
      const prompt = String(parsed.prompt || parsed.description || '').trim();
      if (!prompt) {
        sessions.set(sessionId, session);
        return res.json({
          reply:
            parsed.reply ||
            'Describe the sound or music you want (genre, mood, instruments, tempo). I will generate a short free local sample (MusicGen).',
          source,
        });
      }
      try {
        const mgRes = await fetch(`${LOCAL_AI_URL}/audio/musicgen`, {
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
          return res.json({
            reply,
            source: 'MusicGen (local)',
            audio: mgData.audio_b64,
            path: mgData.path,
          });
        }
        sessions.set(sessionId, session);
        return res.json({
          reply:
            mgData.message ||
            'MusicGen is not available. Install optional deps: pip install -r knowledge/requirements-audio.txt (free; runs on your PC).',
          source: 'MusicGen (local)',
        });
      } catch {
        sessions.set(sessionId, session);
        return res.json({
          reply:
            'Could not reach the Knowledge API for MusicGen. Ensure api_server.py is running and audio deps are installed.',
          source: 'MusicGen (local)',
        });
      }
    }

    if (parsed.mode === 'print3d') {
      const desc = String(parsed.description || parsed.prompt || '').trim();
      if (!desc) {
        sessions.set(sessionId, session);
        return res.json({
          reply:
            parsed.reply ||
            'Say what you want to print in plain English (shape, size, details). I will save an STL under your Butler data folder (print3d/) when OpenSCAD CLI is installed.',
          source,
        });
      }
      const openaiKey = readOpenAIKey();
      const lo = !!localOnly;
      try {
        await mkdir(getButlorConfigDirAbs(), { recursive: true });
        const result = await runPrint3dChatPipeline({
          butlorDataRoot: getButlorConfigDirAbs(),
          description: desc.slice(0, 2000),
          localOnly: lo,
          hasOpenAiKey: !!openaiKey,
          knowledgeApiUrl: KNOWLEDGE_API_URL,
          openaiApiKey: openaiKey,
        });
        const pathsStr = (result.paths || []).join('\n');
        let reply = (parsed.reply ? String(parsed.reply).trim() + '\n\n' : '') + `3D print (${result.engine}).`;
        if (result.openscad_render_ok) reply += ' STL file saved.';
        else if (result.openscad_hint) reply += ' ' + result.openscad_hint;
        if (pathsStr) reply += '\n\n' + pathsStr;
        sessions.set(sessionId, session);
        return res.json({ reply, source: '3D print', print3d: result });
      } catch (e) {
        sessions.set(sessionId, session);
        return res.json({
          reply:
            '3D print failed: ' +
            String(e?.message || e).slice(0, 500) +
            (lo
              ? ' With Local only: the Knowledge API (8765) calls your **local LLM** at BUTLOR_AI_URL (default http://localhost:5000). If the error mentions :5000, start `knowledge/ai_server.py` (e.g. `py -3 ai_server.py` in that folder) or point BUTLOR_AI_URL at your LM Studio/Ollama endpoint.'
              : ''),
          source,
        });
      }
    }

    if (parsed.mode !== 'actions') {
      return res.json({
        reply:
          parsed.reply ||
          'I could not run that from this dev server (chat, questions, images/video/audio, 3D print, and file actions are wired here). Open the Butler desktop app for jobs, apartments, and other tools—or refine your request.',
        source,
      });
    }

    const maxRetries = getActionsAutonomyMaxRetries();
    const innerMax = getActionsAutonomyInnerMax();
    let currentParsed = parsed;
    const autonomyRounds = [];
    const autonomyLog = [];
    let lastSlotRecoveries = 0;
    const al = (msg) => {
      const line = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
      autonomyLog.push(line);
      // eslint-disable-next-line no-console
      console.log('[Butler autonomy]', msg);
    };

    const followCtx = {
      history,
      session,
      projectRoot,
      localOnly,
      module,
      codeContext,
      cursorCli,
      initImage,
      attachment,
    };

    try {
      al(
        `Starting actions autonomy — up to ${maxRetries + 1} apply round(s), up to ${innerMax} model follow-up(s) per failed apply (env BUTLER_ACTIONS_AUTONOMY_ROUNDS / BUTLER_ACTIONS_AUTONOMY_INNER).`,
      );

      let attempt = 0;
      autonomyLoop: while (attempt <= maxRetries) {
        try {
          al(`Apply round ${attempt + 1}/${maxRetries + 1}: running write_file / run_command on disk…`);
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
            reply = `**Succeeded on apply round ${attempt + 1}.**\n\n${reply}`;
          }
          if (applySummary.files.length || applySummary.downloads.length || applySummary.commands.length) {
            reply += `\n\nChanged ${applySummary.files.length} file(s), downloaded ${applySummary.downloads.length}, ran ${applySummary.commands.length} command(s).`;
          }
          const progress_messages = prevFails.map((r) =>
            r.phase === 'model_not_actions' && r.model_snippet
              ? `**Progress (model not in actions mode)**\n${String(r.error || '').slice(0, 600)}\n\n${String(r.model_snippet).slice(0, 900)}`
              : `**Progress (host error)**\n${String(r.error || '').slice(0, 1800)}`,
          );
          sessions.set(sessionId, session);
          al(`Success — all commands in this plan finished (round ${attempt + 1}).`);
          return res.json({
            reply,
            summary: currentParsed.summary || '',
            nextSteps,
            projectRoot,
            applySummary,
            source,
            autonomy_rounds: autonomyRounds,
            autonomy_log: autonomyLog,
            ...(progress_messages.length > 0 ? { progress_messages } : {}),
          });
        } catch (err) {
          autonomyRounds.push({
            attempt: attempt + 1,
            ok: false,
            phase: 'apply_error',
            error: String(err?.message || err).slice(0, 12000),
          });
          al(
            `Apply failed — ${String(err?.message || err).split('\n')[0].slice(0, 200)}… Continuing: re-asking Knowledge API for a corrected mode:actions plan (not chat).`,
          );

          let sampleFilesRetry = sampleFiles;
          try {
            sampleFilesRetry = await collectFiles(projectRoot);
          } catch {
            sampleFilesRetry = sampleFiles;
          }

          const baseFix =
            `[HOST] Butler could not apply actions (apply round ${attempt + 1} of ${maxRetries + 1}).\n\n` +
            `Error:\n${String(err?.message || err).slice(0, 14000)}\n\n` +
            `Return JSON with mode "actions" only—fix commands, paths, or package names. ` +
            (isButlerOwnerMode()
              ? ''
              : `There is no npm package named "kali-tools" (404 on registry); use real dependencies or document OS-level tools.\n\n`) +
            `Host injects env LOCAL_AI_URL and KNOWLEDGE_API_URL (both = ${KNOWLEDGE_API_URL}) for run_command—use them or literal URLs; do not assume a Node variable LOCAL_AI_URL exists in shell without $env: / %...%. ` +
            `For npm install, cwd must be the directory that contains package.json (often "ui" or "." under project_root), never a bare Windows drive root (D:\\\\) or npm may fail with EPERM mkdir D:\\\\.\n\n` +
            `The user's original request was:\n${message}`;

          let innerFix = baseFix;
          let gotNewActions = false;

          for (let inner = 0; inner < innerMax; inner++) {
            try {
              al(`Continuing — follow-up ${inner + 1}/${innerMax}: POST ${LOCAL_AI_URL}/chat (asking model to fix plan)…`);
              const out = await runKnowledgeFollowUpOnce(innerFix, { ...followCtx, sampleFiles: sampleFilesRetry });
              if (!out.ok) {
                al(`Follow-up HTTP error ${out.httpStatus || '?'}. Will retry inner prompt or next round.`);
                autonomyRounds.push({
                  attempt: attempt + 1,
                  inner: inner + 1,
                  ok: false,
                  phase: 'followup_http',
                  error: out.bodySnippet || `Knowledge API HTTP ${out.httpStatus || '?'}`,
                });
                innerFix =
                  baseFix +
                  `\n\n[Previous follow-up failed (${out.httpStatus || '?'}). Return valid JSON with mode "actions" only.]`;
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
                  `Continuing — model returned new mode:actions (${nextParsed.actions.length} action(s)). Retrying apply from the top of the loop…`,
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
                      `Recovery attempts on final apply round exceeded inner limit (${innerMax}). Stopping.`,
                    );
                    break autonomyLoop;
                  }
                }
                continue autonomyLoop;
              }
              al(
                `Model did not return executable actions (mode=${nextParsed?.mode || '?'}). Trying a stricter prompt (inner ${inner + 1}/${innerMax})…`,
              );
              const snippet =
                nextParsed?.mode === 'chat' && nextParsed.reply
                  ? String(nextParsed.reply).slice(0, 1200)
                  : JSON.stringify(nextParsed || {}).slice(0, 1200);
              autonomyRounds.push({
                attempt: attempt + 1,
                inner: inner + 1,
                ok: false,
                phase: 'model_not_actions',
                error: `Expected mode "actions" with non-empty actions; got mode=${nextParsed?.mode || '?'}`,
                model_snippet: snippet,
              });
              innerFix =
                `[HOST] The Butler host only executes mode "actions" (write_file, run_command, …). ` +
                `You responded with mode "${nextParsed?.mode || '?'}" which cannot run shell commands on disk. ` +
                `Reply again with JSON: {"mode":"actions","summary":"...","actions":[...]}.\n\n` +
                `Error to fix:\n${String(err?.message || err).slice(0, 14000)}\n\n` +
                `User request:\n${message}`;
            } catch (followErr) {
              al(`Follow-up request threw: ${String(followErr?.message || followErr).slice(0, 120)}`);
              autonomyRounds.push({
                attempt: attempt + 1,
                inner: inner + 1,
                ok: false,
                phase: 'followup_exception',
                error: String(followErr?.message || followErr).slice(0, 2000),
              });
              innerFix =
                baseFix +
                `\n\n[Follow-up threw: ${String(followErr?.message || followErr).slice(0, 500)} — return mode "actions" JSON.]`;
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
            ? `**Progress**\n${String(r.error || '').slice(0, 600)}\n\n${String(r.model_snippet).slice(0, 900)}`
            : `**Progress**\n${String(r.error || '').slice(0, 1800)}`,
        );
      sessions.set(sessionId, session);
      al(`Autonomy finished without success. Last error: ${String(lastErr?.error || 'unknown').slice(0, 300)}`);
      const shortFail =
        failProgress.length > 0
          ? `**Stopped after ${autonomyRounds.length} step(s).**\n\n${String(lastErr?.error || 'unknown').slice(0, 3200)}`
          : `Could not complete actions after ${autonomyRounds.length} step(s).\n\nLast error:\n${String(lastErr?.error || 'unknown').slice(0, 4500)}`;
      return res.json({
        reply: shortFail,
        source,
        autonomy_rounds: autonomyRounds,
        autonomy_log: autonomyLog,
        failed: true,
        ...(failProgress.length > 0 ? { progress_messages: failProgress } : {}),
      });
    } catch (autonomyFatal) {
      autonomyLog.push(
        `[${new Date().toISOString().slice(11, 23)}] Fatal error in autonomy block: ${String(autonomyFatal?.message || autonomyFatal).slice(0, 500)}`,
      );
      // eslint-disable-next-line no-console
      console.error('[Butler autonomy] fatal', autonomyFatal);
      sessions.set(sessionId, session);
      return res.status(200).json({
        reply:
          `Actions autonomy hit an unexpected error (logged on server). ${String(autonomyFatal?.message || autonomyFatal).slice(0, 2000)}`,
        source,
        autonomy_rounds: autonomyRounds,
        autonomy_log: autonomyLog,
        failed: true,
      });
    }
  } catch (err) {
    const explained = explainKnowledgeFetchFailure(err);
    // eslint-disable-next-line no-console
    console.error('[ui-server] /api/chat:', err);
    return res.status(explained.status).json({
      error: explained.error,
      message: explained.message,
    });
  }
});

app.post('/api/agent', async (req, res) => {
  try {
    const { message, history, sessionId = 'butler-agent', cwd, localOnly } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    const projectRoot = await resolveAgentProjectRoot(sessionId, cwd);
    const rawLoc = req.body?.localOnly ?? req.body?.local_only ?? localOnly;
    const chatMs = getUiChatFetchTimeoutMs();
    const runId = String(req.body?.runId || req.body?.run_id || randomUUID()).trim();
    const provider = String(req.body?.provider || req.body?.agent_provider || req.body?.modelId || 'local')
      .trim()
      .toLowerCase() || 'local';
    const isCascade = provider === 'auto_free' || provider === 'cascade' || provider === 'auto';
    // Cascade / cloud agent must not be forced local by localOnly defaults.
    let resolvedLocalOnly = true;
    if (isCascade || (provider && provider !== 'local')) {
      resolvedLocalOnly = false;
    } else if (typeof rawLoc === 'boolean') {
      resolvedLocalOnly = rawLoc;
    } else if (rawLoc === 'false' || rawLoc === 0 || rawLoc === '0') {
      resolvedLocalOnly = false;
    } else if (rawLoc === 'true' || rawLoc === 1 || rawLoc === '1') {
      resolvedLocalOnly = true;
    } else {
      resolvedLocalOnly = readButlerLocalOnlyFromConfigFile();
    }
    const apiKeys = req.body?.api_keys || req.body?.apiKeys || {};
    const chatRes = await fetchKnowledgeLongWait(
      `${LOCAL_AI_URL}/chat/agent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          prior_messages: Array.isArray(history) ? history.slice(-16) : [],
          project_root: projectRoot,
          agent: true,
          local_only: resolvedLocalOnly,
          openai_api_key: '',
          run_id: runId,
          session_id: String(sessionId || 'butler-agent'),
          provider,
          api_keys: apiKeys && typeof apiKeys === 'object' ? apiKeys : {},
          continue: Boolean(req.body?.continue || req.body?.resume || req.body?.continue_run),
          resume: Boolean(req.body?.continue || req.body?.resume || req.body?.continue_run),
        }),
        signal: AbortSignal.timeout(chatMs),
      },
      chatMs,
    );

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
      } catch {
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
    const explained = explainKnowledgeFetchFailure(err);
    const errName = err?.name || (err && err.constructor && err.constructor.name) || 'Error';
    const errMsg = String(explained.message || err?.message || err || '').trim() || `${errName} (no message)`;
    const verbose = `Agent failed (HTTP ${explained.status}, ${errName}): ${errMsg}`;
    console.error('[ui-server] /api/agent:', err);
    return res.status(explained.status).json({
      error: verbose,
      message: verbose,
      detail: errMsg,
      error_type: errName,
      mode: 'agent',
    });
  }
});

const AGENT_KEY_FILES = [
  'package.json',
  'README.md',
  'pyproject.toml',
  'requirements.txt',
  'tsconfig.json',
  'Cargo.toml',
  'go.mod',
  '.env.example',
];

function agentRunsDir() {
  return path.join(getButlorConfigDirAbs(), 'agent-runs');
}

function readAgentStatusFile(runId) {
  const rid = String(runId || '').trim();
  if (!rid) return null;
  const fp = path.join(agentRunsDir(), `${rid}.json`);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

async function proxyKnowledgeAgentJson(method, knowledgePath, body) {
  const url = `${LOCAL_AI_URL}${knowledgePath}`;
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

app.get('/api/agent/status', async (req, res) => {
  try {
    const runId = String(req.query.runId || req.query.run_id || '').trim();
    if (!runId) return res.status(400).json({ ok: false, error: 'runId required' });
    const local = readAgentStatusFile(runId);
    if (local) return res.json({ ok: true, ...local });
    const proxied = await proxyKnowledgeAgentJson('GET', `/agent/status?run_id=${encodeURIComponent(runId)}`);
    return res.status(proxied.status).json(proxied.data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get('/api/agent/checkpoints', async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || req.query.session_id || 'butler-agent').trim();
    const proxied = await proxyKnowledgeAgentJson(
      'GET',
      `/agent/checkpoints?session_id=${encodeURIComponent(sessionId)}`,
    );
    return res.status(proxied.status).json(proxied.data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/api/agent/checkpoint', async (req, res) => {
  try {
    const { sessionId, cwd, project_root, paths, reason, label } = req.body || {};
    const projectRoot = await resolveAgentProjectRoot(sessionId, cwd || project_root);
    const proxied = await proxyKnowledgeAgentJson('POST', '/agent/checkpoint', {
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

app.post('/api/agent/revert', async (req, res) => {
  try {
    const { sessionId, checkpointId, checkpoint_id, id } = req.body || {};
    const cp = String(checkpointId || checkpoint_id || id || '').trim();
    if (!cp) return res.status(400).json({ ok: false, error: 'checkpointId required' });
    const proxied = await proxyKnowledgeAgentJson('POST', '/agent/revert', {
      session_id: String(sessionId || 'butler-agent'),
      checkpoint_id: cp,
    });
    return res.status(proxied.status).json(proxied.data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/api/agent/open-path', async (req, res) => {
  try {
    const target = String(req.body?.path || '').trim();
    if (!target) return res.status(400).json({ ok: false, error: 'path required' });
    if (!existsSync(target)) {
      await mkdir(target, { recursive: true });
    }
    if (process.platform === 'win32') {
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
    return res.json({ ok: true, path: target });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

const {
  runInPowerShellSession,
  resetPowerShellSession,
  getPowerShellInfo,
} = require('./ui/electron/agent-powershell-session.cjs');

app.get('/api/agent/terminal', (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || 'butler-agent-window').trim();
    return res.json(getPowerShellInfo(sessionId));
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/api/agent/terminal/reset', async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || 'butler-agent-window').trim();
    const rawCwd = String(req.body?.cwd || '').trim();
    const projectRoot = await resolveAgentProjectRoot(sessionId, rawCwd);
    const cwd = safeRunCommandCwd(rawCwd || projectRoot, projectRoot);
    const info = resetPowerShellSession({
      sessionId,
      cwd,
      env: getActionShellChildEnv(),
    });
    return res.json({ ...info, cwd });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/api/agent/terminal', async (req, res) => {
  const started = Date.now();
  try {
    const sessionId = String(req.body?.sessionId || 'butler-agent-window').trim();
    const rawCwd = String(req.body?.cwd || '').trim();
    const command = String(req.body?.command || '').trim();
    if (!command) {
      return res.status(400).json({
        ok: false,
        command: '',
        cwd: rawCwd || '',
        stdout: '',
        stderr: '',
        code: null,
        message: 'command required',
        duration_ms: Date.now() - started,
      });
    }
    const projectRoot = await resolveAgentProjectRoot(sessionId, rawCwd);
    const cwd = safeRunCommandCwd(rawCwd || projectRoot, projectRoot);
    if (req.body?.reset) {
      resetPowerShellSession({ sessionId, cwd, env: getActionShellChildEnv() });
    }
    const result = await runInPowerShellSession({
      sessionId,
      cwd,
      command,
      env: getActionShellChildEnv(),
      timeoutMs: 120000,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      command: String(req.body?.command || ''),
      cwd: String(req.body?.cwd || ''),
      stdout: '',
      stderr: '',
      code: null,
      message: String(err?.message || err),
      duration_ms: Date.now() - started,
    });
  }
});

app.get('/api/agent/scan', async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || 'butler-agent').trim();
    const cwd = String(req.query.cwd || '').trim();
    const projectRoot = await resolveAgentProjectRoot(sessionId, cwd);
    const found = [];
    for (const name of AGENT_KEY_FILES) {
      const fp = path.join(projectRoot, name);
      if (!existsSync(fp)) continue;
      let snippet = '';
      try {
        snippet = (await readFile(fp, 'utf8')).slice(0, 400);
      } catch {
        /* binary */
      }
      found.push({ name, path: fp, snippet });
    }
    let topDirs = [];
    try {
      topDirs = (await readdir(projectRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => e.name)
        .slice(0, 20);
    } catch {
      /* ignore */
    }
    return res.json({ ok: true, project_root: projectRoot, key_files: found, top_dirs: topDirs });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/** Local agent env vars (plaintext) — Settings → Environment variables / agent-env.json. */
app.get('/api/agent/env', (_req, res) => {
  try {
    const vars = loadAgentEnvVarsFromDisk();
    return res.json({
      ok: true,
      vars,
      path: getAgentEnvFilePath(),
      keyed: {
        CONTEXT7_API_KEY: Boolean(String(process.env.CONTEXT7_API_KEY || '').trim()),
        MEMORY_FILE_PATH: Boolean(String(process.env.MEMORY_FILE_PATH || '').trim()),
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err), vars: {} });
  }
});

app.put('/api/agent/env', (req, res) => {
  try {
    const body = req.body || {};
    const incoming =
      body.vars && typeof body.vars === 'object'
        ? body.vars
        : body.env && typeof body.env === 'object'
          ? body.env
          : body;
    const saved = saveAgentEnvVarsToDisk(normalizeAgentEnvVars(incoming));
    applyAgentEnvVarsToProcess(saved);
    return res.json({
      ok: true,
      vars: saved,
      path: getAgentEnvFilePath(),
      message: 'Environment variables saved locally (this machine only).',
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err), vars: {} });
  }
});

/** MCP runtime: Node hosts stdio/HTTP servers; Python agent calls tools via this bridge. */
app.get('/api/agent/mcp/defaults', (_req, res) => {
  try {
    return res.json({ ok: true, servers: getDefaultMcpServerConfigs() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get('/api/agent/mcp/status', (_req, res) => {
  try {
    return res.json(getMcpStatus());
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get('/api/agent/mcp/tools', (_req, res) => {
  try {
    const tools = listConnectedTools();
    return res.json({ ok: true, tools, count: tools.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/api/agent/mcp/connect', async (req, res) => {
  try {
    const body = req.body || {};
    const envPayload =
      (body.env && typeof body.env === 'object' && body.env) ||
      (body.vars && typeof body.vars === 'object' && body.vars) ||
      null;
    if (envPayload) {
      const merged = {
        ...loadAgentEnvVarsFromDisk(),
        ...normalizeAgentEnvVars(envPayload),
      };
      saveAgentEnvVarsToDisk(merged);
      applyAgentEnvVarsToProcess(merged);
    } else {
      loadAndApplyAgentEnvVars();
    }
    let servers = Array.isArray(body.servers) ? body.servers : null;
    if (!servers || servers.length === 0) {
      servers = getDefaultMcpServerConfigs().filter((s) => s.enabled);
    }
    const result = await connectMcpServers(servers);
    return res.json(result);
  } catch (err) {
    console.error('[ui-server] /api/agent/mcp/connect:', err);
    return res.status(500).json({
      ok: false,
      message: String(err?.message || err),
      servers: [],
      tools: [],
    });
  }
});

app.post('/api/agent/mcp/call', async (req, res) => {
  try {
    const body = req.body || {};
    const serverId = String(body.serverId || body.server_id || '').trim();
    const tool = String(body.tool || body.name || '').trim();
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    const result = await callMcpTool(serverId, tool, args);
    return res.json(result);
  } catch (err) {
    console.error('[ui-server] /api/agent/mcp/call:', err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/api/agent/mcp/disconnect', async (_req, res) => {
  try {
    const result = await disconnectAllMcpServers();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get('/api/settings', (req, res) => {
  const key = readOpenAIKey();
  const masked = key ? `sk-...${key.slice(-4)}` : '';
  const cfgPath = getConfigPath();
  let localOnly = false;
  let voiceMode = false;
  let butlerGlobalProjectRoot = '';
  let butlerTrustedRootsText = '';
  let butlerAllowAnyPath = false;
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      localOnly = !!cfg.local_only;
      voiceMode = !!cfg.voice_mode;
      butlerGlobalProjectRoot = String(cfg.butler_global_project_root || '').trim();
      const tr = cfg.butler_trusted_roots;
      butlerTrustedRootsText = Array.isArray(tr) ? tr.join('\n') : String(tr || '').trim();
      butlerAllowAnyPath = !!cfg.butler_allow_any_path;
    } catch {
      /* ignore */
    }
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

app.post('/api/settings', (req, res) => {
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
    if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
    let config = {};
    if (existsSync(cfgPath)) {
      try {
        config = JSON.parse(readFileSync(cfgPath, 'utf8'));
      } catch {
        /* ignore */
      }
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
    writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
    process.env.OPENAI_API_KEY = config.local_only ? '' : (config.openai_api_key || '');
    if (existsSync(envPath)) {
      let envContent = readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/OPENAI_API_KEY\s*=.*/g, '');
      const keyVal = config.local_only ? '' : (config.openai_api_key || '');
      if (keyVal) envContent = envContent.trimEnd() + (envContent ? '\n' : '') + `OPENAI_API_KEY=${keyVal}\n`;
      writeFileSync(envPath, envContent, 'utf8');
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/api/butlor/data_summary', async (_req, res) => {
  try {
    const r = await fetch(`${KNOWLEDGE_API_URL}/butlor/data_summary`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const data = await r.json();
      return res.json(await mergePrint3dRowIntoDataSummary(data));
    }
    if (r.status === 404 || r.status >= 500) {
      return res.json(await summarizeButlorDataForSettings());
    }
    const t = await r.text();
    const shortErr =
      t && t.length < 480 && !/^\s*</.test(t) ? t : (r.statusText || String(r.status));
    return res.status(r.status).json({ ok: false, error: shortErr });
  } catch (e) {
    try {
      return res.json(await summarizeButlorDataForSettings());
    } catch {
      return res.status(503).json({ ok: false, error: String(e?.message || e) });
    }
  }
});

app.post('/api/open_path', async (req, res) => {
  const p = String(req.body?.path || '').trim();
  const action = String(req.body?.action || 'open').trim();
  if (!p) return res.status(400).json({ ok: false, error: 'path required' });
  if (!pathIsUnderButlor(p)) return res.status(403).json({ ok: false, error: 'Path must be under the Butler data folder' });
  try {
    const { execFile } = await import('child_process');
    let st;
    try {
      st = await stat(p);
    } catch {
      st = null;
    }
    if (action === 'reveal' && st?.isFile()) {
      if (process.platform === 'win32') {
        const norm = path.normalize(p);
        const esc = norm.replace(/"/g, '""');
        execSync(`explorer.exe /select,"${esc}"`, {
          windowsHide: true,
          stdio: 'ignore',
          shell: true,
        });
      } else if (process.platform === 'darwin') {
        const { execFile } = await import('child_process');
        execFile('open', ['-R', p], () => {});
      } else {
        const dir = path.dirname(p);
        await mkdir(dir, { recursive: true }).catch(() => {});
        const { execFile } = await import('child_process');
        execFile('xdg-open', [dir], () => {});
      }
      return res.json({ ok: true });
    }
    let openTarget = p;
    if (st?.isFile()) openTarget = path.dirname(p);
    openTarget = path.normalize(openTarget);
    await mkdir(openTarget, { recursive: true }).catch(() => {});
    if (process.platform === 'win32') {
      const q = `"${openTarget.replace(/"/g, '""')}"`;
      execSync(`explorer.exe ${q}`, { windowsHide: true, stdio: 'ignore', shell: true });
    } else if (process.platform === 'darwin') {
      const { execFile } = await import('child_process');
      execFile('open', [openTarget], () => {});
    } else {
      const { execFile } = await import('child_process');
      execFile('xdg-open', [openTarget], () => {});
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/jobs/profile', async (req, res) => {
  try {
    const r = await fetch(`${KNOWLEDGE_API_URL}/jobs/profile`, { signal: AbortSignal.timeout(8000) });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, message: String(e?.message || e) });
  }
});

app.post('/api/jobs/profile', async (req, res) => {
  try {
    const r = await fetch(`${KNOWLEDGE_API_URL}/jobs/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, message: String(e?.message || e) });
  }
});

app.post('/api/jobs/tailor_resume', async (req, res) => {
  try {
    const r = await fetch(`${KNOWLEDGE_API_URL}/jobs/tailor_resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mergeJobBodyWithOpenAiKey(req.body)),
      signal: AbortSignal.timeout(120000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, message: String(e?.message || e) });
  }
});

app.post('/api/jobs/cover_letter', async (req, res) => {
  try {
    const r = await fetch(`${KNOWLEDGE_API_URL}/jobs/cover_letter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mergeJobBodyWithOpenAiKey(req.body)),
      signal: AbortSignal.timeout(60000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, message: String(e?.message || e) });
  }
});

app.post('/api/jobs/resume_template', async (req, res) => {
  try {
    const r = await fetch(`${KNOWLEDGE_API_URL}/jobs/resume_template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(60000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, message: String(e?.message || e) });
  }
});

app.post('/api/jobs/resume_auto_structure', async (req, res) => {
  try {
    const body = req.body || {};
    const html = String(body.html || '').trim();
    const out = await aiAutoStructureResumeHtml({ html });
    return res.status(200).json({ ok: true, html: out });
  } catch (e) {
    const code = typeof e?.statusCode === 'number' ? e.statusCode : 500;
    return res.status(code).json({ ok: false, message: String(e?.message || e) });
  }
});

app.post('/api/jobs/resume_pdf', async (req, res) => {
  try {
    const body = req.body || {};
    const html = String(body.html || '').trim();
    if (!html) {
      return res.status(400).json({ ok: false, message: 'html required' });
    }
    const styleId = String(
      body.style_id ?? body.styleId ?? body.template ?? body.template_id ?? 'standard',
    )
      .toLowerCase()
      .trim();
    console.log('[resume_pdf] template', styleId, 'stem', String(body.filename_stem || body.filenameStem || '').slice(0, 60));
    const fn =
      String(body.filename_stem || body.filenameStem || 'resume')
        .replace(/[^\w\-]+/g, '_')
        .slice(0, 80) || 'resume';

    const savePdfToDataFolder = async (buf) => {
      const root = getButlorConfigDirAbs();
      const dir = path.join(root, 'resumes');
      await mkdir(dir, { recursive: true });
      const outPath = path.join(dir, `${fn}.pdf`);
      await writeFile(outPath, buf);
      return outPath;
    };

    const { renderResumeHtmlToPdfBuffer } = await import('./resumePdfKit.mjs');
    const pdfBytes = await renderResumeHtmlToPdfBuffer(html, styleId);
    if (!Buffer.isBuffer(pdfBytes) || pdfBytes.length < 10) {
      throw new Error('Resume PDF generator returned empty or invalid buffer');
    }
    const outPath = await savePdfToDataFolder(pdfBytes);
    res.setHeader('X-Butler-Saved-Path', outPath);
    res.setHeader('X-Butler-Template', styleId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fn}.pdf"`);
    return res.status(200).send(pdfBytes);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[resume_pdf] error:', e);
    return res.status(500).type('application/json').json({ ok: false, message: String(e?.message || e) });
  }
});

app.post('/api/jobs/resume_docx', async (req, res) => {
  try {
    const body = req.body || {};
    const html = String(body.html || '').trim();
    if (!html) {
      return res.status(400).json({ ok: false, message: 'html required' });
    }
    const styleId = String(
      body.style_id ?? body.styleId ?? body.template ?? body.template_id ?? 'harvard',
    )
      .toLowerCase()
      .trim();
    console.log(
      '[resume_docx] template',
      styleId,
      'stem',
      String(body.filename_stem || body.filenameStem || '').slice(0, 60),
    );
    const fn =
      String(body.filename_stem || body.filenameStem || 'resume')
        .replace(/[^\w\-]+/g, '_')
        .slice(0, 80) || 'resume';

    const saveDocxToDataFolder = async (buf) => {
      const root = getButlorConfigDirAbs();
      const dir = path.join(root, 'resumes');
      await mkdir(dir, { recursive: true });
      const outPath = path.join(dir, `${fn}.docx`);
      await writeFile(outPath, buf);
      return outPath;
    };

    const { renderResumeHtmlToDocxBuffer } = await import('./resumeDocxKit.mjs');
    const docxBytes = await renderResumeHtmlToDocxBuffer(html, styleId);
    if (!Buffer.isBuffer(docxBytes) || docxBytes.length < 10) {
      throw new Error('Resume DOCX generator returned empty or invalid buffer');
    }
    const outPath = await saveDocxToDataFolder(docxBytes);
    res.setHeader('X-Butler-Saved-Path', outPath);
    res.setHeader('X-Butler-Template', styleId);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fn}.docx"`);
    return res.status(200).send(docxBytes);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[resume_docx] error:', e);
    return res.status(500).type('application/json').json({ ok: false, message: String(e?.message || e) });
  }
});

function resolvePythonForUiServerTests() {
  const embed = path.join(__dirname, 'ui', 'python-embed', 'python.exe');
  if (existsSync(embed)) return embed;
  return process.platform === 'win32' ? 'python' : 'python3';
}

app.post('/api/tests/run', async (req, res) => {
  try {
    const { pathToFileURL } = await import('node:url');
    const selfPath = path.join(__dirname, 'ui', 'electron', 'butler-selftest.mjs');
    const { runButlerSelfTests } = await import(pathToFileURL(selfPath).href);
    const knowledgeRoot = path.join(__dirname, 'knowledge');
    const uiRoot = path.join(__dirname, 'ui');
    const out = await runButlerSelfTests({
      butlerBaseUrl: `http://127.0.0.1:${PORT}`,
      knowledgeUrl: KNOWLEDGE_API_URL,
      knowledgeRoot,
      uiRoot,
      packaged: false,
      pythonExe: resolvePythonForUiServerTests(),
    });
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e), results: [] });
  }
});

/** Same behavior as Electron `main.cjs` — Vite dev proxies `/api` here, so PCM / mic STT works without the packaged app. */
app.post('/api/speech-to-text', async (req, res) => {
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
      ? path.join(os.tmpdir(), `butlor-stt-${Date.now()}.pcm`)
      : path.join(os.tmpdir(), `butlor-stt-${Date.now()}.wav`);
    writeFileSync(tmpPath, buf);
    if (usePcm) {
      const rate = Math.round(Number(sampleRate));
      if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* */
        }
        return res.status(400).json({ error: 'Invalid sampleRate (use 8000–192000).' });
      }
      sttArgs = ['--pcm-s16le', String(rate), tmpPath];
    } else {
      sttArgs = [tmpPath];
    }
    const sttPy = path.join(knowledgeDir, 'stt.py');
    const python = resolvePythonForUiServerTests();
    if (!existsSync(sttPy)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* */
      }
      return res.status(503).json({ error: 'Speech-to-text not available (missing knowledge/stt.py).' });
    }
    const { stdout, stderr, code } = await new Promise((resolve, reject) => {
      const proc = spawn(python, [sttPy, ...sttArgs], {
        cwd: knowledgeDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      proc.stdout?.on('data', (d) => {
        out += d.toString();
      });
      proc.stderr?.on('data', (d) => {
        err += d.toString();
      });
      proc.on('close', (exitCode) => resolve({ stdout: out, stderr: err, code: exitCode }));
      proc.on('error', reject);
    });
    try {
      unlinkSync(tmpPath);
    } catch {
      /* */
    }
    const text = (stdout || '').trim();
    const errTrim = (stderr || '').trim();
    if (!text) {
      if (errTrim) {
        return res.status(503).json({ error: `Speech-to-text failed: ${errTrim}`, text: '' });
      }
      if (code !== 0 && code != null) {
        return res.status(503).json({
          error:
            `Speech-to-text process failed (exit ${code}). Install deps in ui/python-embed or use system Python with SpeechRecognition.`,
          text: '',
        });
      }
      return res.status(503).json({
        error:
          'No transcript returned. Needs internet for Google recognition. Check Windows microphone privacy for Butler.',
        text: '',
      });
    }
    return res.json({ text });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/api/print3d/key-check', async (_req, res) => {
  const openaiConfigured = !!readOpenAIKey();
  let openscad_cli = { installed: false, command: null };
  try {
    openscad_cli = await probeOpenScadInstalled();
  } catch {
    /* optional */
  }
  let knowledge_api_ok = false;
  try {
    const c = await fetch(`${KNOWLEDGE_API_URL}/count`, { signal: AbortSignal.timeout(4000) });
    knowledge_api_ok = c.ok;
  } catch {
    /* */
  }
  const compatUrlEnv = String(process.env.BUTLER_PRINT3D_V1_URL || '').trim();
  return res.json({
    ok: true,
    provider: 'openscad_llm',
    engines: ['openai', 'knowledge', 'compat'],
    openai_configured: openaiConfigured,
    knowledge_api_ok,
    knowledge_api_url: KNOWLEDGE_API_URL,
    openscad_cli,
    compat_url_env_set: !!compatUrlEnv,
    hint:
      openaiConfigured || knowledge_api_ok
        ? null
        : 'For STL from chat: Knowledge API + local LLM (BUTLOR_AI_URL), or an OpenAI key when Local only is off. Optional: BUTLER_PRINT3D_V1_URL. Install OpenSCAD CLI to compile mesh. Set BUTLER_PRINT3D_OUTPUT=both to also save .scad files.',
  });
});

app.get('/api/print3d/stl', async (req, res) => {
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
    const buf = await readFile(full);
    res.setHeader('Content-Type', 'model/stl');
    res.setHeader('Content-Disposition', `inline; filename="${safe}"`);
    res.send(buf);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return res.status(404).type('text/plain').send('Not found');
    }
    return res.status(500).type('text/plain').send('Read failed');
  }
});

app.post('/api/butler/rebuild', (_req, res) => {
  try {
    const uiDir = path.join(__dirname, 'ui');
    if (!existsSync(path.join(uiDir, 'package.json'))) {
      return res.json({
        ok: false,
        message:
          'No ui/package.json next to this server. Run from the Butler repo root with ui-server.js in the root, or rebuild manually: cd ui && npm run build:app',
      });
    }
    if (process.platform !== 'win32') {
      return res.json({
        ok: false,
        message:
          'Rebuild from Settings is Windows-only. In a terminal: cd ui && npm run build:app (from your Butler repo).',
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
        'Opened a console window running npm run build:app. When done, restart Butler from ui\\dist-app-new\\win-unpacked if you use the packaged app.',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

app.get('/api/network-monitor/probe', async (_req, res) => {
  try {
    const p = await probeTshark();
    return res.json(p);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/network-monitor/interfaces', async (_req, res) => {
  try {
    const out = await listInterfaces();
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e), interfaces: [] });
  }
});

app.post('/api/network-monitor/start', async (req, res) => {
  try {
    const iface = req.body?.iface != null ? String(req.body.iface) : '';
    const bpf = req.body?.bpf != null ? String(req.body.bpf) : '';
    const out = await startCapture({ iface: iface || undefined, bpf: bpf || undefined });
    if (!out.ok) return res.status(400).json(out);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/network-monitor/stop', (_req, res) => {
  try {
    const out = stopCapture();
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/network-monitor/snapshot', (_req, res) => {
  try {
    return res.json(getSnapshot({ maxEvents: 120, maxAlerts: 60 }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** One button: probe tshark, capture ~12s on default interface, return heuristic “suspicious” summary. */
app.post('/api/network-monitor/quick-scan', async (req, res) => {
  try {
    const body = req.body || {};
    const seconds = body.seconds != null ? Number(body.seconds) : undefined;
    const iface = body.iface != null ? String(body.iface) : undefined;
    const bpf = body.bpf != null ? String(body.bpf) : undefined;
    const out = await quickScan({ seconds, iface, bpf });
    if (!out.ok) return res.status(400).json(out);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/network-monitor/install-wireshark', async (_req, res) => {
  try {
    const out = await installWiresharkWinget();
    if (!out.ok) return res.status(400).json(out);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/security-lab', (_req, res) => {
  res.json(SECURITY_LAB_RESOURCES);
});

app.get('/api/kali-tools', (_req, res) => {
  res.json(KALI_TOOLS_RESOURCES);
});

app.get('/api/infoooze', (_req, res) => {
  res.json(INFOOOZE_RESOURCES);
});

app.post('/api/print3d/generate', async (req, res) => {
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
          'Cloud engine needs an OpenAI key in Settings, or choose “Local (Knowledge API)” / “OpenAI-compatible” for offline generation.',
      });
    }

    const compatBase =
      (typeof compat_url === 'string' && compat_url.trim()) || String(process.env.BUTLER_PRINT3D_V1_URL || '').trim();
    if (eng === 'compat' && !compatBase) {
      return res.status(400).json({
        ok: false,
        message:
          'OpenAI-compatible engine needs a base URL (e.g. http://127.0.0.1:11434 for Ollama) or set BUTLER_PRINT3D_V1_URL in .env.',
      });
    }

    const root = getButlorConfigDirAbs();
    await mkdir(root, { recursive: true });
    const logLines = [];
    const result = await runPrint3dOpenScadPipeline({
      engine: eng,
      openaiApiKey: openai,
      knowledgeApiUrl: KNOWLEDGE_API_URL,
      compatBaseUrl: compatBase,
      compatModel: typeof compat_model === 'string' ? compat_model.trim() : '',
      compatApiKey: typeof compat_api_key === 'string' ? compat_api_key.trim() : '',
      butlorDataRoot: root,
      prompt,
      output: outFmt,
      model: typeof model === 'string' && model.trim() ? model.trim() : undefined,
      onProgress: (e) => {
        if (e?.message) {
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
    const sc = Number(e?.status);
    const code = Number.isFinite(sc) && sc >= 400 && sc < 600 ? sc : 500;
    return res.status(code).json({ ok: false, message: String(e?.message || e) });
  }
});

// -----------------------------
// Visualizer / playlist pre-render (offline, queued)
// -----------------------------

function safeStem(raw, fallback = 'track') {
  const s = String(raw || '').trim() || fallback;
  const cleaned = s
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

async function ensureVisualizerDirs() {
  const root = getButlorConfigDirAbs();
  const outDir = path.join(root, 'generated', 'visualizers');
  const stateDir = path.join(root, 'visualizers');
  await mkdir(outDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { root, outDir, stateDir };
}

function getVisualizerQueuePath(stateDir) {
  return path.join(stateDir, 'queue.json');
}

async function readVisualizerQueue(stateDir) {
  const qPath = getVisualizerQueuePath(stateDir);
  try {
    const raw = await readFile(qPath, 'utf8');
    const parsed = JSON.parse(raw);
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    return { jobs };
  } catch {
    return { jobs: [] };
  }
}

async function writeVisualizerQueue(stateDir, queue) {
  const qPath = getVisualizerQueuePath(stateDir);
  const data = { version: 1, updated_at: new Date().toISOString(), jobs: queue.jobs || [] };
  await writeFile(qPath, JSON.stringify(data, null, 2), 'utf8');
}

function getBundledFfmpegDirAbs() {
  // Keep tools under the Butler data folder so packaged + dev both work.
  return path.join(getButlorConfigDirAbs(), 'tools', 'ffmpeg');
}

function resolveBundledFfmpegBins() {
  const base = getBundledFfmpegDirAbs();
  const exe = process.platform === 'win32' ? '.exe' : '';
  // Most common layout when extracted from ffmpeg-release-essentials.zip:
  // <base>/ffmpeg-*/bin/ffmpeg.exe
  // We'll probe a few known paths and also scan one level deep if needed.
  const direct = {
    ffmpeg: path.join(base, 'bin', `ffmpeg${exe}`),
    ffprobe: path.join(base, 'bin', `ffprobe${exe}`),
  };
  if (existsSync(direct.ffmpeg) && existsSync(direct.ffprobe)) return direct;

  try {
    const kids = existsSync(base) ? readdirSync(base, { withFileTypes: true }) : [];
    for (const d of kids) {
      if (!d.isDirectory()) continue;
      const cand = {
        ffmpeg: path.join(base, d.name, 'bin', `ffmpeg${exe}`),
        ffprobe: path.join(base, d.name, 'bin', `ffprobe${exe}`),
      };
      if (existsSync(cand.ffmpeg) && existsSync(cand.ffprobe)) return cand;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function probeFfmpegBins(bins) {
  try {
    const ffmpegCmd = bins?.ffmpeg ? `"${bins.ffmpeg.replace(/"/g, '""')}" -version` : 'ffmpeg -version';
    const r = await runShell(ffmpegCmd, __dirname);
    if (r.ok) return { ok: true };
    return { ok: false, detail: (r.stderr || r.message || 'ffmpeg not found').slice(0, 220) };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 220) };
  }
}

async function ensureFfmpegInstalled({ autoInstall } = { autoInstall: true }) {
  const bundled = resolveBundledFfmpegBins();
  const bundledOk = await probeFfmpegBins(bundled);
  if (bundled && bundledOk.ok) return { ok: true, ...bundled, source: 'bundled' };

  const pathOk = await probeFfmpegBins(null);
  if (pathOk.ok) return { ok: true, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', source: 'path' };

  if (!autoInstall || process.platform !== 'win32') {
    return { ok: false, detail: pathOk.detail || 'ffmpeg not available' };
  }

  // Auto-install on Windows: download and extract a known static build into the Butler data folder.
  // We use PowerShell's Invoke-WebRequest + Expand-Archive to avoid extra npm deps.
  const base = getBundledFfmpegDirAbs();
  await mkdir(base, { recursive: true });
  const zipPath = path.join(base, 'ffmpeg.zip');
  const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
  const ps = [
    `$ProgressPreference='SilentlyContinue'`,
    `$ErrorActionPreference='Stop'`,
    `$base='${base.replace(/'/g, "''")}'`,
    `$zip='${zipPath.replace(/'/g, "''")}'`,
    `if (Test-Path $zip) { Remove-Item -Force $zip }`,
    `Invoke-WebRequest -Uri '${url}' -OutFile $zip`,
    // Clear old extracted folders except zip
    `Get-ChildItem -LiteralPath $base -Force | Where-Object { $_.Name -ne 'ffmpeg.zip' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
    `Expand-Archive -LiteralPath $zip -DestinationPath $base -Force`,
  ].join('; ');
  const cmd = `powershell -NoProfile -Command "${ps.replace(/"/g, '""')}"`;
  const dl = await runShell(cmd, __dirname);
  if (!dl.ok) {
    return { ok: false, detail: (dl.stderr || dl.message || 'ffmpeg download failed').slice(0, 320) };
  }

  const after = resolveBundledFfmpegBins();
  const afterOk = await probeFfmpegBins(after);
  if (after && afterOk.ok) return { ok: true, ...after, source: 'bundled' };

  return { ok: false, detail: afterOk.detail || 'ffmpeg install did not complete' };
}

async function ffprobeJson(inputPath, bins) {
  const quoted = `"${String(inputPath).replace(/"/g, '""')}"`;
  const ffprobeExe = bins?.ffprobe && bins.ffprobe !== 'ffprobe' ? `"${bins.ffprobe.replace(/"/g, '""')}"` : 'ffprobe';
  const cmd = `${ffprobeExe} -v error -print_format json -show_format -show_streams ${quoted}`;
  const r = await runShell(cmd, __dirname);
  if (!r.ok) return { ok: false, error: (r.stderr || r.message || 'ffprobe failed').slice(0, 300) };
  try {
    return { ok: true, data: JSON.parse(r.stdout || '{}') };
  } catch {
    return { ok: true, data: {} };
  }
}

function buildFfmpegVisualizerArgs({ inputPath, outPath, title, artist, template, width, height, fps }) {
  const w = Number(width) || 1280;
  const h = Number(height) || 720;
  const f = Number(fps) || 30;
  const t = String(template || 'waves').toLowerCase();
  const textTitle = String(title || '').trim();
  const textArtist = String(artist || '').trim();
  const overlay = [textTitle, textArtist].filter(Boolean).join('  —  ');

  // Audio-reactive visuals from ffmpeg filters (no Python deps).
  // - waves: showwaves + subtle glow
  // - spectrum: showspectrum
  const videoFilter =
    t === 'spectrum'
      ? `showspectrum=s=${w}x${h}:mode=combined:color=intensity:scale=log:slide=scroll:fps=${f},format=yuv420p`
      : `showwaves=s=${w}x${h}:mode=line:colors=0x66ccff|0xff66cc:rate=${f},format=yuv420p`;

  const drawText =
    overlay.length > 0
      ? `,drawtext=fontcolor=white:fontsize=${Math.round(Math.max(20, h * 0.04))}:x=(w-text_w)/2:y=h-(text_h*2):box=1:boxcolor=0x00000088:boxborderw=14:text='${overlay
          .replace(/\\/g, '\\\\')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\\\'")
          .replace(/\n/g, ' ')}'`
      : '';

  const vf = videoFilter + drawText;

  // Note: we re-encode audio to AAC for broad compatibility.
  return [
    '-y',
    '-i',
    inputPath,
    '-filter_complex',
    vf,
    '-map',
    '0:a:0',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    outPath,
  ];
}

let visualizerWorkerStarted = false;
let visualizerWorkerBusy = false;

async function runVisualizerJob(job) {
  const { outDir } = await ensureVisualizerDirs();
  const inputPath = String(job?.input_path || '').trim();
  if (!inputPath) throw new Error('Missing input_path');
  if (!existsSync(inputPath)) throw new Error(`Audio file not found: ${inputPath}`);

  const bins = await ensureFfmpegInstalled({ autoInstall: true });
  if (!bins.ok) throw new Error(`Visualizer engine missing: ${bins.detail || 'ffmpeg not available'}`);

  const stemBase = safeStem(job?.output_stem || job?.title || path.basename(inputPath, path.extname(inputPath)) || 'track');
  const outPath = path.join(outDir, `${stemBase}.mp4`);

  const args = buildFfmpegVisualizerArgs({
    inputPath,
    outPath,
    title: job?.title,
    artist: job?.artist,
    template: job?.template || 'waves',
    width: job?.width,
    height: job?.height,
    fps: job?.fps,
  });

  await new Promise((resolve, reject) => {
    const ffmpegExe = bins.ffmpeg && bins.ffmpeg !== 'ffmpeg' ? bins.ffmpeg : 'ffmpeg';
    const proc = spawn(ffmpegExe, args, { cwd: __dirname, windowsHide: true });
    let err = '';
    proc.stderr?.on('data', (d) => {
      err += d.toString();
      if (err.length > 20000) err = err.slice(-20000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${err.slice(-1200)}`));
    });
  });

  return { outPath };
}

async function startVisualizerWorkerIfNeeded() {
  if (visualizerWorkerStarted) return;
  visualizerWorkerStarted = true;

  setInterval(async () => {
    if (visualizerWorkerBusy) return;
    visualizerWorkerBusy = true;
    try {
      const { stateDir } = await ensureVisualizerDirs();
      const queue = await readVisualizerQueue(stateDir);
      const idx = queue.jobs.findIndex((j) => j && j.status === 'queued');
      if (idx < 0) return;

      const job = queue.jobs[idx];
      job.status = 'running';
      job.started_at = new Date().toISOString();
      job.updated_at = job.started_at;
      await writeVisualizerQueue(stateDir, queue);

      try {
        const result = await runVisualizerJob(job);
        job.status = 'done';
        job.output_path = result.outPath;
        job.finished_at = new Date().toISOString();
        job.updated_at = job.finished_at;
        job.error = '';
      } catch (e) {
        job.status = 'error';
        job.error = String(e?.message || e).slice(0, 2400);
        job.finished_at = new Date().toISOString();
        job.updated_at = job.finished_at;
      }

      queue.jobs[idx] = job;
      await writeVisualizerQueue(stateDir, queue);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[visualizer-worker]', e?.message || e);
    } finally {
      visualizerWorkerBusy = false;
    }
  }, 1500);
}

app.get('/api/visualizer/probe', async (_req, res) => {
  const ffBins = await ensureFfmpegInstalled({ autoInstall: true });
  const { outDir, stateDir } = await ensureVisualizerDirs();
  return res.json({
    ok: true,
    ffmpeg: ffBins.ok
      ? { ok: true, source: ffBins.source, ffmpeg: ffBins.ffmpeg, ffprobe: ffBins.ffprobe }
      : { ok: false, detail: ffBins.detail || 'ffmpeg not available' },
    output_dir: outDir,
    state_dir: stateDir,
  });
});

app.post('/api/visualizer/analyze', async (req, res) => {
  try {
    const inputPath = String(req.body?.path || req.body?.input_path || '').trim();
    if (!inputPath) return res.status(400).json({ ok: false, message: 'path required' });
    if (!existsSync(inputPath)) return res.status(404).json({ ok: false, message: 'file not found' });
    const bins = await ensureFfmpegInstalled({ autoInstall: true });
    if (!bins.ok) return res.status(503).json({ ok: false, message: `Visualizer engine missing: ${bins.detail}` });
    const meta = await ffprobeJson(inputPath, bins);
    return res.json({ ok: true, path: inputPath, ffprobe: meta.data || {} });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

app.get('/api/visualizer/jobs', async (_req, res) => {
  const { stateDir } = await ensureVisualizerDirs();
  const queue = await readVisualizerQueue(stateDir);
  return res.json({ ok: true, jobs: queue.jobs });
});

app.post('/api/visualizer/queue', async (req, res) => {
  try {
    const bins = await ensureFfmpegInstalled({ autoInstall: true });
    if (!bins.ok) return res.status(503).json({ ok: false, message: `Visualizer engine missing: ${bins.detail}` });

    const body = req.body || {};
    const tracks = Array.isArray(body.tracks) ? body.tracks : [];
    const template = String(body.template || 'waves').toLowerCase();
    const lookahead = body.lookahead != null ? Math.max(1, Math.min(500, Number(body.lookahead) || 0)) : 50;
    const nowCount = body.default_first_n != null ? Math.max(0, Math.min(30, Number(body.default_first_n) || 0)) : 3;

    if (tracks.length === 0) {
      return res.status(400).json({ ok: false, message: 'tracks[] required (each track needs path)' });
    }

    const { stateDir } = await ensureVisualizerDirs();
    const queue = await readVisualizerQueue(stateDir);

    const existingKey = new Set(
      queue.jobs
        .map((j) => String(j?.input_path || '').toLowerCase())
        .filter(Boolean),
    );

    const toAdd = tracks.slice(0, lookahead);
    const newJobs = [];
    for (let i = 0; i < toAdd.length; i++) {
      const t = toAdd[i] || {};
      const inputPath = String(t.path || t.input_path || '').trim();
      if (!inputPath) continue;
      const k = inputPath.toLowerCase();
      if (existingKey.has(k)) continue;
      existingKey.add(k);

      const title = String(t.title || '').trim();
      const artist = String(t.artist || '').trim();
      const outputStem = safeStem(
        t.output_stem ||
          (title && artist ? `${artist} - ${title}` : title || path.basename(inputPath, path.extname(inputPath))),
      );

      newJobs.push({
        id: `viz_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        status: 'queued',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        input_path: inputPath,
        title,
        artist,
        output_stem: outputStem,
        template: i < nowCount ? 'waves' : template,
        width: t.width,
        height: t.height,
        fps: t.fps,
        error: '',
      });
    }

    queue.jobs.push(...newJobs);
    await writeVisualizerQueue(stateDir, queue);
    await startVisualizerWorkerIfNeeded();

    return res.json({ ok: true, queued: newJobs.length, total: queue.jobs.length });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

app.post('/api/visualizer/render_now', async (req, res) => {
  try {
    const bins = await ensureFfmpegInstalled({ autoInstall: true });
    if (!bins.ok) return res.status(503).json({ ok: false, message: `Visualizer engine missing: ${bins.detail}` });
    const job = req.body || {};
    const inputPath = String(job.path || job.input_path || '').trim();
    if (!inputPath) return res.status(400).json({ ok: false, message: 'path required' });
    const result = await runVisualizerJob({
      input_path: inputPath,
      title: job.title,
      artist: job.artist,
      template: job.template || 'waves',
      width: job.width,
      height: job.height,
      fps: job.fps,
      output_stem: job.output_stem,
    });
    return res.json({ ok: true, output_path: result.outPath });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// -----------------------------
// Image-to-image (ComfyUI via Knowledge API)
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

function easyPromptPresetsPath() {
  return path.join(getButlorConfigDirAbs(), 'easy-img2img-prompt-presets.json');
}

function readEasyPromptPresetStore() {
  try {
    const parsed = JSON.parse(readFileSync(easyPromptPresetsPath(), 'utf8'));
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

app.get('/api/sd/img2img/prompt-presets', (_req, res) => {
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

app.post('/api/sd/img2img/prompt-presets', async (req, res) => {
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
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8');
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

app.delete('/api/sd/img2img/prompt-presets/:id', async (req, res) => {
  try {
    const id = String(req.params?.id || '').trim();
    const store = readEasyPromptPresetStore();
    const before = store.presets.length;
    store.presets = store.presets.filter((preset) => String(preset?.id || '') !== id);
    if (store.presets.length === before) {
      return res.status(404).json({ ok: false, message: 'Prompt preset not found.' });
    }
    const file = easyPromptPresetsPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(store, null, 2) + '\n', 'utf8');
    return res.json({ ok: true, message: 'Prompt preset deleted.' });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

function easySweepPaths() {
  const comfyRoot = path.join(resolveSdProjectPath(path.resolve(__dirname)), 'ComfyUI');
  const outputRoot = path.join(comfyRoot, 'output');
  return {
    outputRoot,
    sweepDir: path.join(outputRoot, 'easy_sweep'),
    winnersPath: path.join(outputRoot, 'butler_easy_sweep_winners.json'),
  };
}

function presetFromEasySweepFilename(filename) {
  // New format: easy_sweep/<run_folder>/<preset>_<mode>_s<seed>_<idx>.png
  // The basename is the last path segment after the final separator.
  const base = String(filename || '').replace(/\\/g, '/').split('/').pop() || '';
  const match = base.match(
    /^(.+?)_(?:single|sweep_winners|sweep_20)(?:_r.+?)?_s\d+_\d+(?:_\d+)?\.(?:png|jpe?g|webp)$/i,
  );
  const preset = match?.[1] || '';
  return EASY_SWEEP_PRESETS.has(preset) ? preset : '';
}

function easySweepRunGroupKey(relPath) {
  // New layout: easy_sweep/<run_folder>/<preset>_<mode>_s<seed>_<idx>.png
  // The run group key is the run_folder (the directory containing the image).
  const normalized = String(relPath || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  // parts[0] should be 'easy_sweep', parts[1] is the run folder
  if (parts.length >= 2 && parts[0] === 'easy_sweep') {
    return parts[1];
  }
  // Fallback for legacy flat files (no subfolder, no run ID):
  // Files like 02_soft_face_sweep_20_s1_000.png — group all sweep_20 files
  // that share the same mode together as one legacy run.
  const base = parts[parts.length - 1] || '';
  // First try: files with _r<run_id> suffix
  const withRun = base.match(
    /^(.+?_(?:single|sweep_winners|sweep_20)_r.+?)(?:_s\d+)(?:_\d+)?\.(?:png|jpe?g|webp)$/i,
  );
  if (withRun?.[1]) return withRun[1];
  // Legacy flat files without run ID: group by mode (sweep_20, sweep_winners, single)
  // All sweep_20 files from the old format go into one "legacy_sweep_20" group.
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
    const parsed = JSON.parse(readFileSync(winnersPath, 'utf8'));
    return {
      files: Array.isArray(parsed?.files) ? parsed.files.map(String) : [],
      presets: Array.isArray(parsed?.presets) ? parsed.presets.map(String) : [],
    };
  } catch {
    return { files: [], presets: [] };
  }
}

/** Recursively walk sweepDir and collect all image files with their relative paths. */
async function collectSweepImages(sweepDir) {
  const results = [];
  async function walk(dir, relPrefix) {
    const entries = await readdir(dir, { withFileTypes: true });
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

app.get('/api/sd/img2img/sweep-results', async (_req, res) => {
  try {
    const { sweepDir, winnersPath } = easySweepPaths();
    await mkdir(sweepDir, { recursive: true });
    const winnerState = readEasySweepWinners(winnersPath);
    const selected = new Set(winnerState.files);
    const images = await collectSweepImages(sweepDir);
    const runs = new Map();
    for (const { full, rel } of images) {
      const runKey = easySweepRunGroupKey(rel);
      if (!runKey) continue;
      const preset = presetFromEasySweepFilename(rel);
      if (!preset) continue;
      const info = await stat(full);
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

app.get('/api/sd/img2img/sweep-image/*', async (req, res) => {
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
    const info = await stat(full);
    if (!info.isFile()) throw new Error('Not a file');
    
    const fs = require('fs');
    const rawData = fs.readFileSync(full);
    
    // Handle encoded .enc files - decode them
    if (relPath.toLowerCase().endsWith('.enc')) {
      const ENCRYPTION_KEY = 'butler-sweep-secure-key-2024';
      const decoded = Buffer.alloc(rawData.length);
      for (let i = 0; i < rawData.length; i++) {
        decoded[i] = rawData[i] ^ ENCRYPTION_KEY.charCodeAt(i % ENCRYPTION_KEY.length);
      }
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.setHeader('Content-Type', 'image/png');
      return res.send(decoded);
    }
    
    // Encode all sweep result images for Butler-only visibility
    const ENCRYPTION_KEY = 'butler-sweep-secure-key-2024';
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

app.post('/api/sd/img2img/sweep-winners', async (req, res) => {
  try {
    const requested = Array.isArray(req.body?.files) ? req.body.files.map(String) : [];
    const { outputRoot, sweepDir, winnersPath } = easySweepPaths();
    await mkdir(sweepDir, { recursive: true });
    const files = [];
    const presets = [];
    for (const raw of requested) {
      const relPath = String(raw || '').replace(/\\/g, '/');
      if (!relPath || relPath.includes('..') || !/\.(?:png|jpe?g|webp|enc)$/i.test(relPath)) continue;
      const preset = presetFromEasySweepFilename(relPath);
      if (!preset) continue;
      const full = path.join(sweepDir, relPath.split('/').join(path.sep));
      if (!existsSync(full)) continue;
      files.push(relPath);
      if (!presets.includes(preset)) presets.push(preset);
    }
    await mkdir(outputRoot, { recursive: true });
    await writeFile(
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

app.get('/api/sd/checkpoints', async (_req, res) => {
  try {
    const r = await fetch(`${KNOWLEDGE_API_URL}/sd/checkpoints`, {
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, message: String(e?.message || e), checkpoints: [] });
  }
});

app.post('/api/sd/checkpoints', async (req, res) => {
  try {
    const checkpoint = String(req.body?.checkpoint || '').trim();
    if (!checkpoint) return res.status(400).json({ ok: false, message: 'checkpoint required' });
    const r = await fetch(`${KNOWLEDGE_API_URL}/sd/checkpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkpoint }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, message: String(e?.message || e) });
  }
});

app.post('/api/sd/txt2img', async (req, res) => {
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
    const r = await fetch(`${KNOWLEDGE_API_URL}/sd/txt2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    const data = await r.json().catch(() => ({}));
    fillSdPayloadFromDisk(data);
    return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, message: String(e?.message || e), images: [] });
  }
});

app.post('/api/sd/img2img', async (req, res) => {
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
    const r = await fetch(`${KNOWLEDGE_API_URL}/sd/img2img`, {
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
          ? `Knowledge API route missing on ${KNOWLEDGE_API_URL} (HTTP 404). Another app may be using port 8765 — run npm run dev:restart from the Butler repo.`
          : `Knowledge API returned non-JSON (HTTP ${r.status}). ${text.slice(0, 180)}`;
      return res.status(502).json({ ok: false, message: wrongApp, images: [] });
    }
    const data = await r.json().catch(() => ({}));
    fillSdPayloadFromDisk(data);
    if (!r.ok && !data.message) {
      data.message =
        data.message ||
        `Knowledge API HTTP ${r.status}. Ensure Butler Knowledge API is running on ${KNOWLEDGE_API_URL} (npm run dev:restart).`;
      data.ok = false;
    }
    return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, message: String(e?.message || e), images: [] });
  }
});

// -----------------------------
// Animate from prompt (free local video stack via Knowledge API)
// -----------------------------

app.post('/api/animate/txt2video', async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, message: 'prompt required' });
    const aspect = String(req.body?.aspect || '').trim().toLowerCase();
    const aspectHint =
      aspect === 'ultrawide' || aspect === '21:9'
        ? ' Aspect ratio 21:9 ultra-wide.'
        : aspect === 'super_ultrawide' || aspect === '32:9'
          ? ' Aspect ratio 32:9 super ultra-wide (Odyssey G9).'
        : aspect === 'vertical' || aspect === '9:16'
          ? ' Aspect ratio 9:16 vertical.'
          : aspect === 'square' || aspect === '1:1'
            ? ' Aspect ratio 1:1 square.'
            : aspect === 'cinema' || aspect === '2.39:1'
              ? ' Aspect ratio 2.39:1 cinema widescreen.'
              : '';
    const r = await fetch(`${KNOWLEDGE_API_URL}/sd/txt2video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt + aspectHint }),
      // Video can take a while.
      signal: AbortSignal.timeout(20 * 60 * 1000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status >= 400 ? r.status : 502).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, message: String(e?.message || e) });
  }
});

// Stream a video file under the Butler data folder (Range supported for <video> playback).
app.get('/api/media/video', async (req, res) => {
  try {
    const p = String(req.query?.path || '').trim();
    if (!p) return res.status(400).json({ ok: false, error: 'path required' });
    const full = path.resolve(p);
    if (!pathIsUnderButlor(full)) {
      return res.status(403).json({ ok: false, error: 'Path must be under the Butler data folder' });
    }
    const st = await stat(full).catch(() => null);
    if (!st || !st.isFile()) return res.status(404).json({ ok: false, error: 'Not found' });

    const size = st.size || 0;
    const range = String(req.headers.range || '').trim();
    const mime = videoMimeFromFilePath(full);

    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      if (!m) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : Math.max(0, size - 1);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      res.status(206);
      res.setHeader('Content-Type', mime);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      createReadStream(full, { start, end }).pipe(res);
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(size));
    res.setHeader('Accept-Ranges', 'bytes');
    createReadStream(full).pipe(res);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -----------------------------
// Episode generator (prompt -> multi-shot animatic episode, local + free)
// -----------------------------

function episodeDirs() {
  const root = getButlorConfigDirAbs();
  const base = path.join(root, 'episodes');
  const jobsPath = path.join(base, 'queue.json');
  return { root, base, jobsPath };
}

async function ensureEpisodeDirs() {
  const { base } = episodeDirs();
  await mkdir(base, { recursive: true });
  return episodeDirs();
}

async function readEpisodeQueue() {
  const { jobsPath } = await ensureEpisodeDirs();
  try {
    const raw = await readFile(jobsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    return { jobs };
  } catch {
    return { jobs: [] };
  }
}

async function writeEpisodeQueue(queue) {
  const { jobsPath } = await ensureEpisodeDirs();
  const data = { version: 1, updated_at: new Date().toISOString(), jobs: queue.jobs || [] };
  await writeFile(jobsPath, JSON.stringify(data, null, 2), 'utf8');
}

function newEpisodeJobId() {
  return `ep_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safeJsonParse(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}$/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function clampInt(n, lo, hi, fallback) {
  const v = Number.parseInt(String(n ?? ''), 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

function buildOriginalEpisodeSpecPrompt(userPrompt, opts) {
  const style = String(opts?.style || 'adult_sci_fi_comedy_animatic').slice(0, 80);
  const minutes = clampInt(opts?.minutes, 1, 30, 6);
  const shots = clampInt(opts?.shots, 3, 60, Math.max(8, Math.min(36, minutes * 5)));
  const continuity = String(opts?.continuity || 'loose').slice(0, 30);
  const aspect = String(opts?.aspect || '').trim().toLowerCase();
  const aspectHint =
    aspect === 'ultrawide' || aspect === '21:9'
      ? 'Aspect ratio: 21:9 ultra-wide.'
      : aspect === 'super_ultrawide' || aspect === '32:9'
        ? 'Aspect ratio: 32:9 super ultra-wide (Odyssey G9).'
      : aspect === 'vertical' || aspect === '9:16'
        ? 'Aspect ratio: 9:16 vertical.'
        : aspect === 'square' || aspect === '1:1'
          ? 'Aspect ratio: 1:1.'
          : aspect === 'cinema' || aspect === '2.39:1'
            ? 'Aspect ratio: 2.39:1 cinema widescreen.'
            : 'Aspect ratio: 16:9.';

  // IP safety: do not request copyrighted show characters. Generate original cast + setting.
  return [
    'Return STRICT JSON only.',
    'Create an ORIGINAL animated episode plan (do not reference any copyrighted characters, franchises, or show names).',
    `Target length: ${minutes} minute(s). Style: ${style}. Continuity: ${continuity}.`,
    aspectHint,
    `Generate exactly ${shots} shots with short action, camera, and visual prompt text.`,
    '',
    'JSON schema:',
    '{',
    '  "title": "string",',
    '  "logline": "string",',
    '  "cast": [{"name":"string","description":"string","voice":"string"}],',
    '  "setting": "string",',
    '  "scenes": [{"id":"s1","summary":"string","shots":[{"id":"sh01","seconds":6,"visual_prompt":"string","dialogue":[{"speaker":"string","line":"string"}],"sfx":["string"],"music":"string"}]}],',
    '  "global_negative_prompt": "string"',
    '}',
    '',
    'Constraints:',
    '- Keep shot seconds between 3 and 12.',
    '- visual_prompt must be self-contained: characters + action + environment + camera + lighting + art style.',
    '- Dialogue lines must be short (<= 14 words each) for fast local rendering.',
    '- Keep cast size 2–5.',
    '',
    'USER_PROMPT:',
    String(userPrompt || '').slice(0, 4000),
  ].join('\n');
}

function detectDisallowedIpRequest(text) {
  const s = String(text || '').toLowerCase();
  // Keep this intentionally small; we’re not trying to police everything, just avoid direct “make X show” requests.
  const bad = [
    'rick and morty',
    'rick & morty',
    'morty',
    'rick sanchez',
    'adult swim',
  ];
  return bad.some((k) => s.includes(k));
}

async function callKnowledgeChatForJsonEpisodeSpec(promptText) {
  // Use Knowledge API chat routing; local_only encourages using local LLM stack when configured.
  const payload = buildKnowledgeChatPayload({
    message: promptText,
    history: [],
    session: { answers: {}, pendingQuestions: [] },
    projectRoot: path.resolve(projectsRoot),
    localOnly: true,
    module: 'episode_generator',
    codeContext: '',
    cursorCli: null,
    initImage: null,
    attachment: null,
    sampleFiles: [],
  });
  const epMs = getUiChatFetchTimeoutMs();
  const r = await fetchKnowledgeLongWait(
    `${KNOWLEDGE_API_URL}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(epMs),
    },
    epMs,
  );
  const data = await r.json().catch(() => ({}));
  // Knowledge API responses vary; prefer reply/content fields.
  const text = String(data?.reply || data?.content || data?.message?.content || '').trim();
  return { ok: r.ok, data, text };
}

function fallbackEpisodeSpec(userPrompt, opts) {
  const minutes = clampInt(opts?.minutes, 1, 30, 6);
  const shots = clampInt(opts?.shots, 3, 60, Math.max(10, Math.min(30, minutes * 5)));
  const baseStyle = String(opts?.render_style || 'stylized 2D animation, clean lines, bold color, smooth motion').slice(
    0,
    180,
  );
  const cast = [
    { name: 'Nova', description: 'Curious engineer with a reckless streak.', voice: 'neutral_female' },
    { name: 'Watt', description: 'Deadpan scientist, allergic to feelings.', voice: 'neutral_male' },
  ];
  const setting = 'A cluttered garage-lab on the edge of a neon desert city.';
  const scene = {
    id: 's1',
    summary: 'A gadget misfires and drags the duo into escalating weirdness.',
    shots: Array.from({ length: shots }).map((_, i) => {
      const sid = String(i + 1).padStart(2, '0');
      return {
        id: `sh${sid}`,
        seconds: 6,
        visual_prompt: `${baseStyle}. ${setting}. Nova and Watt. Action: ${i === 0 ? 'introduce the lab and the unstable device' : i === shots - 1 ? 'resolve with a chaotic but funny outcome' : 'escalate the malfunction in a surprising way'}. Camera: cinematic medium shot, gentle handheld. Lighting: vibrant neon rim light, soft fill.`,
        dialogue:
          i % 3 === 0
            ? [
                { speaker: 'Nova', line: 'Okay, this is definitely fine.' },
                { speaker: 'Watt', line: 'Statistically, it is not fine.' },
              ]
            : [],
        sfx: i % 2 === 0 ? ['buzz', 'zap'] : ['whirr'],
        music: 'light synth pulse',
      };
    }),
  };
  return {
    title: 'The Device That Should Not Be',
    logline: `Two inventors trigger a cascade of weird physics. Prompt: ${String(userPrompt || '').slice(0, 120)}`,
    cast,
    setting,
    scenes: [scene],
    global_negative_prompt: 'blurry, low quality, jpeg artifacts, text, watermark, extra limbs',
  };
}

function flattenShots(spec) {
  const scenes = Array.isArray(spec?.scenes) ? spec.scenes : [];
  const out = [];
  for (const sc of scenes) {
    const shots = Array.isArray(sc?.shots) ? sc.shots : [];
    for (const sh of shots) {
      if (!sh || !sh.id) continue;
      out.push({ scene_id: sc?.id || '', ...sh });
    }
  }
  return out;
}

async function saveBase64Mp4ToFile(b64, outPath) {
  const raw = String(b64 || '').trim();
  if (!raw || raw.length < 120) throw new Error('No video bytes returned');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 200) throw new Error('Video buffer too small');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, buf);
  return outPath;
}

async function ffmpegConcatMp4({ inputs, outPath }) {
  const bins = await ensureFfmpegInstalled({ autoInstall: true });
  if (!bins.ok) throw new Error(`ffmpeg missing: ${bins.detail || 'not available'}`);
  if (!inputs || inputs.length === 0) throw new Error('No inputs to stitch');
  await mkdir(path.dirname(outPath), { recursive: true });
  const listTxt = inputs
    .map((p) => `file '${String(p).replace(/'/g, "'\\''")}'`)
    .join('\n');
  const tmpList = path.join(os.tmpdir(), `butler-ep-${Date.now()}-concat.txt`);
  await writeFile(tmpList, listTxt, 'utf8');
  const ffmpegExe = bins.ffmpeg && bins.ffmpeg !== 'ffmpeg' ? bins.ffmpeg : 'ffmpeg';
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', tmpList, '-c', 'copy', outPath];
  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegExe, args, { cwd: __dirname, windowsHide: true });
    let err = '';
    proc.stderr?.on('data', (d) => {
      err += d.toString();
      if (err.length > 24000) err = err.slice(-24000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg concat failed (${code}): ${err.slice(-1200)}`));
    });
  });
  try {
    await unlink(tmpList);
  } catch {
    /* ignore */
  }
  return outPath;
}

let episodeWorkerStarted = false;
let episodeWorkerBusy = false;

async function updateEpisodeJob(jobId, patch) {
  const q = await readEpisodeQueue();
  const idx = q.jobs.findIndex((j) => j && j.id === jobId);
  if (idx < 0) return null;
  const cur = q.jobs[idx];
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  q.jobs[idx] = next;
  await writeEpisodeQueue(q);
  return next;
}

async function runEpisodeJob(job) {
  const { base } = await ensureEpisodeDirs();
  const jobDir = path.join(base, job.id);
  await mkdir(jobDir, { recursive: true });

  const log = [];
  const logPush = async (line) => {
    const s = `[${new Date().toISOString()}] ${line}`;
    log.push(s);
    if (log.length > 200) log.shift();
    await updateEpisodeJob(job.id, { log: log.slice(-80) });
  };

  await logPush('Planning episode (LLM -> JSON spec)…');
  let spec = null;
  try {
    if (detectDisallowedIpRequest(job.prompt)) {
      await logPush('Note: prompt requested a specific copyrighted show; generating an original episode instead.');
    }
    const promptText = buildOriginalEpisodeSpecPrompt(job.prompt, job.options || {});
    const chat = await callKnowledgeChatForJsonEpisodeSpec(promptText);
    spec = safeJsonParse(chat.text);
    if (!spec) throw new Error('Could not parse JSON episode spec from model');
  } catch (e) {
    await logPush(`Planner fallback: ${String(e?.message || e).slice(0, 220)}`);
    spec = fallbackEpisodeSpec(job.prompt, job.options || {});
  }

  const specPath = path.join(jobDir, 'episode_spec.json');
  await writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8');
  await updateEpisodeJob(job.id, { spec_path: specPath, title: spec.title || job.title || '' });

  const shots = flattenShots(spec);
  const maxShots = clampInt(job.options?.shots, 3, 60, 18);
  const selected = shots.slice(0, maxShots);
  if (selected.length === 0) throw new Error('No shots generated');

  await logPush(`Rendering ${selected.length} shot(s) via local video stack…`);
  const clipPaths = [];

  for (let i = 0; i < selected.length; i++) {
    const sh = selected[i];
    const pct = Math.round((i / selected.length) * 100);
    await updateEpisodeJob(job.id, { progress: pct, stage: `render_shot_${i + 1}/${selected.length}` });
    await logPush(`Shot ${i + 1}/${selected.length} ${sh.id}: generating clip…`);

    const prompt = String(sh.visual_prompt || '').trim() || String(job.prompt || '').trim();
    // Retry a couple times; local video stacks can fail while models load.
    let lastErr = '';
    let vidB64 = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await fetch(`${KNOWLEDGE_API_URL}/sd/txt2video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: AbortSignal.timeout(20 * 60 * 1000),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data?.ok !== false && String(data?.video || '').trim()) {
        vidB64 = String(data.video).trim();
        lastErr = '';
        break;
      }
      lastErr = String(data?.message || `txt2video failed (HTTP ${r.status})`).slice(0, 900);
      await logPush(`Shot ${sh.id} attempt ${attempt}/3 failed: ${lastErr.slice(0, 220)}`);
      // Small backoff to let Comfy finish loading custom nodes.
      await new Promise((rr) => setTimeout(rr, 1200 * attempt));
    }
    if (!vidB64) {
      await logPush(`Shot ${sh.id} failed permanently: ${lastErr}`);
      throw new Error(lastErr || 'Shot generation failed');
    }

    const outClip = path.join(jobDir, 'clips', `${String(sh.id).replace(/[^\w-]+/g, '_')}.mp4`);
    await saveBase64Mp4ToFile(vidB64, outClip);
    clipPaths.push(outClip);
    await updateEpisodeJob(job.id, { last_clip_path: outClip });
  }

  await logPush('Stitching clips…');
  await updateEpisodeJob(job.id, { stage: 'stitch', progress: 95 });
  const finalPath = path.join(jobDir, 'episode.mp4');
  await ffmpegConcatMp4({ inputs: clipPaths, outPath: finalPath });

  await updateEpisodeJob(job.id, {
    stage: 'done',
    progress: 100,
    output_path: finalPath,
  });
  await logPush(`Done: ${finalPath}`);

  return finalPath;
}

async function startEpisodeWorkerIfNeeded() {
  if (episodeWorkerStarted) return;
  episodeWorkerStarted = true;
  setInterval(async () => {
    if (episodeWorkerBusy) return;
    episodeWorkerBusy = true;
    try {
      const q = await readEpisodeQueue();
      const idx = q.jobs.findIndex((j) => j && j.status === 'queued');
      if (idx < 0) return;
      const job = q.jobs[idx];
      job.status = 'running';
      job.started_at = new Date().toISOString();
      job.updated_at = job.started_at;
      q.jobs[idx] = job;
      await writeEpisodeQueue(q);
      try {
        await runEpisodeJob(job);
        job.status = 'done';
        job.finished_at = new Date().toISOString();
        job.updated_at = job.finished_at;
        job.error = '';
      } catch (e) {
        job.status = 'error';
        job.error = String(e?.message || e).slice(0, 2400);
        job.finished_at = new Date().toISOString();
        job.updated_at = job.finished_at;
      }
      q.jobs[idx] = job;
      await writeEpisodeQueue(q);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[episode-worker]', e?.message || e);
    } finally {
      episodeWorkerBusy = false;
    }
  }, 2000);
}

app.get('/api/episode/jobs', async (_req, res) => {
  const q = await readEpisodeQueue();
  return res.json({ ok: true, jobs: q.jobs || [] });
});

app.post('/api/episode/queue', async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, message: 'prompt required' });
    const opts = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {};
    const shots = clampInt(opts.shots, 3, 60, 18);
    const minutes = clampInt(opts.minutes, 1, 30, 6);
    const aspect = String(opts.aspect || '').trim().toLowerCase();

    const q = await readEpisodeQueue();
    const id = newEpisodeJobId();
    const job = {
      id,
      status: 'queued',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      prompt,
      title: String(req.body?.title || '').trim(),
      options: {
        ...opts,
        shots,
        minutes,
        aspect,
      },
      stage: 'queued',
      progress: 0,
      output_path: '',
      spec_path: '',
      error: '',
      log: [],
    };
    q.jobs.push(job);
    await writeEpisodeQueue(q);
    await startEpisodeWorkerIfNeeded();
    return res.json({ ok: true, id, queued: 1 });
  } catch (e) {
    return res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

/** After all /api routes: Express default 404 is HTML and breaks clients expecting JSON. */
app.use('/api', (req, res) => {
  const hint =
    req.method === 'GET' && req.path === '/network-monitor/quick-scan'
      ? 'Use POST with JSON body { seconds?, iface?, bpf? } (Settings → Network monitor → Scan).'
      : undefined;
  res.status(404).json({
    ok: false,
    error: `No handler for ${req.method} ${req.originalUrl || req.path}`,
    ...(hint ? { setup_hint: hint } : {}),
  });
});

app.listen(PORT, () => {
  const label = BUTLER_VARIANT === 'code-helper' ? 'Code Helper' : 'Butler';
  // eslint-disable-next-line no-console
  console.log(`${label} UI API running at http://localhost:${PORT}`);
  // Pre-connect knowledge/docs MCP defaults (Memory; Context7 only if CONTEXT7_API_KEY set).
  const defaults = getDefaultMcpServerConfigs().filter((s) => s.enabled);
  if (defaults.length) {
    connectMcpServers(defaults)
      .then((r) => {
        // eslint-disable-next-line no-console
        console.log(
          `[mcp] auto-connect: ${r.message} (${(r.tools || []).length} tools)`,
        );
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[mcp] auto-connect failed:', err?.message || err);
      });
  }
});

