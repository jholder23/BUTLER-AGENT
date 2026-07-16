/**
 * Text → STL for FDM: LLM emits OpenSCAD internally; OpenSCAD CLI renders STL.
 * By default only `.stl` is kept under Butler’s print3d folder (`.scad` is temp-only).
 * Set BUTLER_PRINT3D_OUTPUT=both to also save `.scad` next to the STL.
 */
import path from 'path';
import { homedir, tmpdir } from 'os';
import { mkdir, writeFile, unlink } from 'fs/promises';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { getDefaultButlorRoot } from './butlor-data-root.mjs';

const execFileAsync = promisify(execFile);

function stripEnvQuotes(s) {
  const t = String(s || '').trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/** Repo / user-data .env. dotenv does not override vars that are set to "" — we re-read critical keys from disk when empty. */
let butlerDotenvLoaded = false;

function fillEmptyEnvKeysFromFile(envPath, keys) {
  if (!existsSync(envPath)) return;
  try {
    const parsed = dotenv.parse(readFileSync(envPath, 'utf8'));
    for (const key of keys) {
      if (!(key in parsed)) continue;
      const fileVal = stripEnvQuotes(parsed[key]);
      if (!fileVal) continue;
      const cur = stripEnvQuotes(process.env[key] || '');
      if (!cur) process.env[key] = fileVal;
    }
  } catch {
    /* ignore */
  }
}

function butlerDotenvCandidatePaths() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(moduleDir, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(getDefaultButlorRoot(), '.env'),
  ];
}

/** Call early from ui-server so OpenSCAD path is set before first /api/print3d request. */
export function preloadPrint3dEnv() {
  ensureButlerDotenv();
}

function ensureButlerDotenv() {
  if (butlerDotenvLoaded) return;
  butlerDotenvLoaded = true;
  const keys = ['BUTLER_OPENSCAD', 'OPENSCAD_PATH'];
  try {
    for (const envPath of butlerDotenvCandidatePaths()) {
      if (!existsSync(envPath)) continue;
      dotenv.config({ path: envPath });
      fillEmptyEnvKeysFromFile(envPath, keys);
    }
  } catch {
    /* ignore */
  }
}

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.BUTLER_PRINT3D_MODEL || 'gpt-4o-mini';
const DEFAULT_COMPAT_MODEL = process.env.BUTLER_PRINT3D_COMPAT_MODEL || 'llama3.2';

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

const KNOWLEDGE_API_DEFAULT =
  'http://127.0.0.1:' + String(process.env.KNOWLEDGE_API_PORT || '8765').trim();
const BUTLER_NODE_API_PORT = String(
  process.env.BUTLER_UI_API_PORT || process.env.BUTLER_API_PORT || '4001',
).trim();

/**
 * Flask Knowledge API is mounted at URL origin only. Strips accidental path suffixes and
 * rejects the Butler Node UI API port (default 4001; desktop may use 4011), which would 404
 * on /print3d/openscad and /status.
 */
export function normalizeKnowledgeApiBaseUrl(raw, { logPrefix = '' } = {}) {
  const pre = logPrefix || '';
  const s = String(raw || '').trim();
  if (!s) return KNOWLEDGE_API_DEFAULT;
  let u;
  try {
    u = new URL(s);
  } catch {
    console.warn(`${pre}Invalid KNOWLEDGE_API_URL; using ${KNOWLEDGE_API_DEFAULT}`);
    return KNOWLEDGE_API_DEFAULT;
  }
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (port === BUTLER_NODE_API_PORT) {
    console.warn(
      `${pre}KNOWLEDGE_API_URL uses port ${BUTLER_NODE_API_PORT} (Butler API). Use Python api_server.py on port 8765 — using ${KNOWLEDGE_API_DEFAULT}`,
    );
    return KNOWLEDGE_API_DEFAULT;
  }
  const origin = u.origin;
  if (u.pathname && u.pathname !== '/') {
    console.warn(
      `${pre}KNOWLEDGE_API_URL had a path (${u.pathname}); using origin only: ${origin}`,
    );
  }
  return origin;
}

/** Strip markdown fences and prose; keep OpenSCAD source. */
export function extractOpenScadSource(raw) {
  let t = String(raw || '').trim();
  const fence = /^```(?:openscad)?\s*\n?([\s\S]*?)```/im;
  const m = t.match(fence);
  if (m) t = m[1].trim();
  t = t.replace(/^```openscad\s*/i, '').replace(/```\s*$/m, '').trim();
  return t;
}

/** System text for any LLM that emits OpenSCAD; user message is plain English only (no special commands). */
export const OPENSCAD_EMIT_SYSTEM = `Turn the user's plain-English description into OpenSCAD for FDM 3D printing. Output ONLY compilable OpenSCAD source code—no markdown, no code fences, no explanation. Printable solid (manifold), millimeters, flat bottom near z=0, $fn 48–96 for curves; prefer union/difference/hull/linear_extrude; no import() from URLs; simplify overly complex asks to something that builds.`;

export async function generateOpenScadWithOpenAI({ apiKey, prompt, model = DEFAULT_MODEL }) {
  const userPrompt = String(prompt || '').trim();
  if (!userPrompt) throw new Error('Prompt is required.');
  if (userPrompt.length > 2000) throw new Error('Prompt must be 2000 characters or fewer.');

  const r = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: OPENSCAD_EMIT_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!r.ok) {
    const msg = data?.error?.message || data?.message || text || `OpenAI HTTP ${r.status}`;
    const err = new Error(String(msg).slice(0, 500));
    err.status = r.status;
    throw err;
  }

  const raw = data?.choices?.[0]?.message?.content;
  const scad = extractOpenScadSource(raw);
  if (!scad || scad.length < 10) throw new Error('Model returned empty or unusable OpenSCAD.');
  return { scad, model };
}

/**
 * Knowledge API POST /print3d/openscad → local peepee /chat (BUTLOR_AI_URL). Fully offline from OpenAI.
 */
export async function generateOpenScadViaKnowledgeApi({ knowledgeBaseUrl, prompt, timeoutMs = 300_000 }) {
  const base = normalizeKnowledgeApiBaseUrl(knowledgeBaseUrl);
  if (!base) throw new Error('Knowledge API URL missing.');
  const userPrompt = String(prompt || '').trim();
  if (!userPrompt) throw new Error('Prompt is required.');
  if (userPrompt.length > 2000) throw new Error('Prompt must be 2000 characters or fewer.');
  const url = `${base}/print3d/openscad`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: userPrompt }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    let msg = data?.message || `Knowledge API HTTP ${r.status}`;
    if (r.status === 404) {
      msg =
        data?.message ||
        `Knowledge API HTTP 404 (${url}). Point KNOWLEDGE_API_URL at Python api_server.py (default http://127.0.0.1:8765), not Butler on port 4001. If the URL is correct, pull the latest knowledge/api_server.py (needs POST /print3d/openscad).`;
    }
    const err = new Error(String(msg).slice(0, 800));
    err.status = r.status;
    throw err;
  }
  const scad = extractOpenScadSource(data.raw);
  if (!scad || scad.length < 10) throw new Error('Local model returned empty or unusable OpenSCAD.');
  return { scad, model: data.model || 'local' };
}

/** Ollama, LM Studio, vLLM, etc.: POST {base}/v1/chat/completions */
export async function generateOpenScadWithOpenAiCompat({
  baseUrl,
  prompt,
  model = DEFAULT_COMPAT_MODEL,
  apiKey = '',
}) {
  const root = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!root) throw new Error('Base URL required (e.g. http://127.0.0.1:11434 for Ollama).');
  const userPrompt = String(prompt || '').trim();
  if (!userPrompt) throw new Error('Prompt is required.');
  const url = `${root}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  const k = String(apiKey || '').trim();
  if (k) headers.Authorization = `Bearer ${k}`;
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: OPENSCAD_EMIT_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!r.ok) {
    const msg = data?.error?.message || data?.message || text || `HTTP ${r.status}`;
    const err = new Error(String(msg).slice(0, 500));
    err.status = r.status;
    throw err;
  }
  const raw = data?.choices?.[0]?.message?.content;
  const scad = extractOpenScadSource(raw);
  if (!scad || scad.length < 10) throw new Error('Local server returned empty or unusable OpenSCAD.');
  return { scad, model };
}

/** True when cmd is a filesystem path we should verify exists before exec (not a PATH lookup name). */
function isConcreteOpenScadPath(cmd) {
  const c = String(cmd || '');
  if (path.isAbsolute(c)) return true;
  if (c.startsWith('.')) return true;
  if (c.includes(path.sep)) return true;
  if (process.platform === 'win32' && /^[a-zA-Z]:[/\\]/.test(c)) return true;
  return false;
}

/** Program Files roots even when 32-bit Node / stripped env omits ProgramFiles. */
function windowsProgramFilesRoots() {
  if (process.platform !== 'win32') return [];
  const drive = String(process.env.SystemDrive || 'C:').replace(/[/\\]+$/, '');
  const roots = new Set();
  for (const k of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const v = process.env[k];
    if (v) roots.add(v);
  }
  roots.add(`${drive}\\Program Files`);
  roots.add(`${drive}\\Program Files (x86)`);
  return [...roots];
}

/** PowerShell -EncodedCommand (UTF-16LE) — avoids cmd quoting issues. */
function powershellEncodedCommand(source) {
  return Buffer.from(source, 'utf16le').toString('base64');
}

/** Uninstall registry entries → InstallLocation / DisplayIcon → openscad.com */
async function discoverOpenScadViaRegistryWin32() {
  if (process.platform !== 'win32') return [];
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const psExe = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(psExe)) return [];
  const script = `
$out = New-Object System.Collections.Generic.List[string]
$bases = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
foreach ($base in $bases) {
  if (-not (Test-Path $base)) { continue }
  Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object {
    $prop = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (-not $prop -or -not $prop.DisplayName) { return }
    if ($prop.DisplayName -notmatch '(?i)openscad') { return }
    $dir = $null
    if ($prop.InstallLocation -and $prop.InstallLocation.Trim().Length -gt 0) {
      $dir = $prop.InstallLocation.Trim().TrimEnd("\\")
    } elseif ($prop.DisplayIcon) {
      $di = ($prop.DisplayIcon -replace ",\\d+\\s*$", "").Trim()
      if ($di) { $dir = Split-Path -Parent $di }
    }
    if ($dir) {
      $com = Join-Path $dir 'openscad.com'
      if (Test-Path $com) { $out.Add($com) }
    }
  }
}
$out | Select-Object -Unique | ForEach-Object { Write-Output $_ }
`.trim();
  try {
    const { stdout } = await execFileAsync(
      psExe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        powershellEncodedCommand(script),
      ],
      { windowsHide: true, timeout: 20_000, maxBuffer: 256 * 1024 },
    );
    const lines = String(stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return [...new Set(lines.filter((p) => existsSync(p)))];
  } catch {
    return [];
  }
}

/** Windows: OpenSCAD often installs as "OpenSCAD 2021.01" under Program Files, not plain "OpenSCAD". */
function discoverOpenScadInstallDirs() {
  const found = [];
  const roots = windowsProgramFilesRoots();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      for (const ent of readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if (!/^openscad/i.test(ent.name)) continue;
        for (const exe of ['openscad.com', 'openscad.exe']) {
          const p = path.join(root, ent.name, exe);
          if (existsSync(p)) found.push(p);
        }
      }
    } catch {
      /* ignore */
    }
  }
  const la = process.env.LOCALAPPDATA;
  if (la) {
    for (const exe of ['openscad.com', 'openscad.exe']) {
      const p = path.join(la, 'Programs', 'OpenSCAD', exe);
      if (existsSync(p)) found.push(p);
    }
  }
  return found;
}

/** First match from `where.exe` (user PATH as seen by this process — Electron may differ from your terminal). */
async function resolveOpenScadWhereWin32(name) {
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const whereBin = path.join(sysRoot, 'System32', 'where.exe');
  if (!existsSync(whereBin)) return null;
  try {
    const { stdout } = await execFileAsync(whereBin, [name], {
      windowsHide: true,
      timeout: 12_000,
      maxBuffer: 64 * 1024,
    });
    const line = String(stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    return line && existsSync(line) ? line : null;
  } catch {
    return null;
  }
}

/** existsSync can be wrong under sandboxes; WOW64 can point 32-bit Node at the wrong Program Files. */
function win32TryOpenScadDespiteMissingStat(p) {
  if (process.platform !== 'win32') return false;
  const s = String(p).toLowerCase().replace(/\//g, '\\');
  return /\\openscad\.com$/i.test(s) && /program files|openscad/i.test(s);
}

function spawnOpenScadAsync(cmd, args, timeoutMs) {
  const raw = String(cmd);
  const exe =
    process.platform === 'win32' && !/^".*"$/.test(raw) && /\s/.test(raw)
      ? `"${raw.replace(/"/g, '\\"')}"`
      : raw;
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(exe, args, {
      windowsHide: true,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const t = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* */
      }
      if (!settled) {
        settled = true;
        reject(new Error(`OpenSCAD timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      fn();
    };
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      done(() => reject(err));
    });
    child.on('close', (code) => {
      if (code === 0) done(() => resolve({ stderr }));
      else {
        const err = new Error(stderr || `OpenSCAD exited with code ${code}`);
        err.stderr = stderr;
        err.code = code;
        done(() => reject(err));
      }
    });
  });
}

/** Typical Windows installer folder names (OpenSCAD does not ship a bare `openscad` — only .com / .exe). */
function openScadWindowsDirGuesses() {
  const dirNames = [
    'OpenSCAD 2025.01',
    'OpenSCAD 2024.01',
    'OpenSCAD 2023.01',
    'OpenSCAD 2021.01',
    'OpenSCAD',
    'OpenSCAD-2021.01',
  ];
  const paths = [];
  for (const base of windowsProgramFilesRoots()) {
    for (const d of dirNames) {
      for (const exe of ['openscad.com', 'openscad.exe']) {
        paths.push(path.join(base, d, exe));
      }
    }
  }
  return paths;
}

/**
 * Standard install locations (winget / openscad.org). Tried after BUTLER_OPENSCAD — no stat gate so we still exec if env is wrong or missing.
 */
function openScadWindowsHardcodedComPaths() {
  if (process.platform !== 'win32') return [];
  return [
    'C:\\Program Files\\OpenSCAD\\openscad.com',
    'C:\\Program Files (x86)\\OpenSCAD\\openscad.com',
    'C:\\Program Files\\OpenSCAD 2021.01\\openscad.com',
    'C:\\Program Files\\OpenSCAD 2023.01\\openscad.com',
    'C:\\Program Files\\OpenSCAD 2024.01\\openscad.com',
    'C:\\Program Files\\OpenSCAD 2025.01\\openscad.com',
  ];
}

/** Known installer folders × openscad.com only (Windows CLI is .com; .exe is often not on PATH — avoid cmd “not recognized”). */
function openScadWindowsKnownComPaths() {
  if (process.platform !== 'win32') return [];
  const bases = windowsProgramFilesRoots();
  const dirs = [
    'OpenSCAD',
    'OpenSCAD 2021.01',
    'OpenSCAD 2023.01',
    'OpenSCAD 2024.01',
    'OpenSCAD 2025.01',
    'OpenSCAD-2021.01',
  ];
  const seen = new Set();
  const out = [];
  for (const b of bases) {
    for (const d of dirs) {
      const p = path.join(b, d, 'openscad.com');
      if (!seen.has(p) && existsSync(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

function openScadCandidates() {
  ensureButlerDotenv();
  let envExe = stripEnvQuotes(process.env.BUTLER_OPENSCAD || process.env.OPENSCAD_PATH || '');
  const fromEnv = envExe ? [envExe] : [];

  if (process.platform === 'win32') {
    const hardcoded = openScadWindowsHardcodedComPaths().filter((p) => !fromEnv.includes(p));
    const winKnown = openScadWindowsKnownComPaths().filter((p) => !fromEnv.includes(p) && !hardcoded.includes(p));
    const discovered = discoverOpenScadInstallDirs();
    const staticPaths = openScadWindowsDirGuesses();
    // No bare openscad.com on Windows — not on PATH; env + hardcoded paths above are enough.
    return [...fromEnv, ...hardcoded, ...winKnown, ...discovered, ...staticPaths];
  }

  return [...fromEnv, 'openscad'];
}

/** Env → registry install dir → PATH (where) → disk guesses / hardcoded. */
async function buildOpenScadCandidatesOrdered() {
  const seen = new Set();
  const candidates = [];
  function add(c) {
    if (!c || seen.has(c)) return;
    seen.add(c);
    candidates.push(c);
  }
  if (process.platform === 'win32') {
    ensureButlerDotenv();
    const envExe = stripEnvQuotes(process.env.BUTLER_OPENSCAD || process.env.OPENSCAD_PATH || '');
    if (envExe) add(envExe);
    for (const p of await discoverOpenScadViaRegistryWin32()) add(p);
    const w = await resolveOpenScadWhereWin32('openscad.com');
    if (w) add(w);
    for (const c of openScadCandidates()) add(c);
    return candidates;
  }
  for (const c of openScadCandidates()) add(c);
  return candidates;
}

/**
 * @returns {{ ok: boolean, command?: string, stderr?: string }}
 */
export async function renderScadToStl(scadPath, stlPath) {
  const candidates = await buildOpenScadCandidatesOrdered();

  let lastErr = '';
  const args = ['-o', stlPath, scadPath];
  const tryExec = async (cmd, viaShell) => {
    if (viaShell) {
      await spawnOpenScadAsync(cmd, args, 180_000);
      return;
    }
    await execFileAsync(cmd, args, {
      timeout: 180_000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
  };

  for (const cmd of candidates) {
    if (isConcreteOpenScadPath(cmd) && !existsSync(cmd) && !win32TryOpenScadDespiteMissingStat(cmd)) continue;
    try {
      await tryExec(cmd, false);
      return { ok: true, command: cmd };
    } catch (e) {
      lastErr = e?.stderr ? String(e.stderr) : String(e?.message || e);
      const tryShell =
        process.platform === 'win32' &&
        !isConcreteOpenScadPath(cmd) &&
        (/ENOENT|spawn .* ENOENT/i.test(lastErr) ||
          /not recognized as an internal or external command|not.*batch file/i.test(lastErr));
      if (tryShell) {
        try {
          await tryExec(cmd, true);
          return { ok: true, command: `${cmd} (shell)` };
        } catch (e2) {
          lastErr = e2?.stderr ? String(e2.stderr) : String(e2?.message || e2);
        }
      }
      const tryShellConcrete =
        process.platform === 'win32' &&
        isConcreteOpenScadPath(cmd) &&
        (existsSync(cmd) || win32TryOpenScadDespiteMissingStat(cmd)) &&
        (/ENOENT|spawn .* ENOENT|EACCES|not recognized as an internal or external command|not.*batch file|^Error: spawn/i.test(
          lastErr,
        ));
      if (tryShellConcrete) {
        try {
          await tryExec(cmd, true);
          return { ok: true, command: `${cmd} (shell)` };
        } catch (e2) {
          lastErr = e2?.stderr ? String(e2.stderr) : String(e2?.message || e2);
        }
      }
    }
  }
  const enoent =
    /ENOENT|spawn .* ENOENT|not recognized as an internal or external command|not.*batch file/i.test(lastErr);
  const hint = enoent
    ? ' OpenSCAD CLI not found. Install from https://openscad.org/ — then set BUTLER_OPENSCAD in .env to the full path of openscad.com (e.g. C:\\Program Files\\OpenSCAD 2021.01\\openscad.com). Packaged Butler often does not see the same PATH as PowerShell.'
    : '';
  return {
    ok: false,
    stderr:
      (lastErr.slice(0, 800) || 'OpenSCAD failed or is not installed.') + hint,
  };
}

/** Quick check for CLI (optional STL export). */
export async function probeOpenScadInstalled() {
  const candidates = await buildOpenScadCandidatesOrdered();
  for (const cmd of candidates) {
    if (isConcreteOpenScadPath(cmd) && !existsSync(cmd) && !win32TryOpenScadDespiteMissingStat(cmd)) continue;
    try {
      await execFileAsync(cmd, ['--version'], { timeout: 8000, windowsHide: true });
      return { installed: true, command: cmd };
    } catch {
      if (process.platform === 'win32' && isConcreteOpenScadPath(cmd) && win32TryOpenScadDespiteMissingStat(cmd)) {
        try {
          await spawnOpenScadAsync(cmd, ['--version'], 8000);
          return { installed: true, command: `${cmd} (shell)` };
        } catch {
          /* try next candidate */
        }
      }
    }
  }
  return { installed: false, command: null };
}

/** Matches former Settings logic: Local only → Knowledge/local LLM; else OpenAI if key; else OpenAI-compat URL if set; else Knowledge. */
export function resolvePrint3dEngineFromPolicy({ localOnly, hasOpenAiKey }) {
  const compat = String(process.env.BUTLER_PRINT3D_V1_URL || '').trim();
  if (localOnly) return 'knowledge';
  if (hasOpenAiKey) return 'openai';
  if (compat) return 'compat';
  return 'knowledge';
}

/**
 * Run 3D pipeline from chat: engine from policy + env; description is raw user wording.
 * @param {object} opts
 * @param {string} opts.butlorDataRoot
 * @param {string} opts.description
 * @param {boolean} opts.localOnly
 * @param {boolean} opts.hasOpenAiKey
 * @param {string} opts.knowledgeApiUrl
 * @param {string} [opts.openaiApiKey]
 * @param {(e: { message?: string }) => void} [opts.onProgress]
 */
export async function runPrint3dChatPipeline(opts) {
  const {
    butlorDataRoot,
    description,
    localOnly,
    hasOpenAiKey,
    knowledgeApiUrl,
    openaiApiKey,
    onProgress,
  } = opts;
  const engine = resolvePrint3dEngineFromPolicy({ localOnly, hasOpenAiKey });
  const compatBase = String(process.env.BUTLER_PRINT3D_V1_URL || '').trim();
  const cm = String(process.env.BUTLER_PRINT3D_COMPAT_MODEL || '').trim();
  const ck = String(process.env.BUTLER_PRINT3D_COMPAT_KEY || '').trim();
  return runPrint3dOpenScadPipeline({
    engine,
    butlorDataRoot,
    prompt: description,
    openaiApiKey,
    knowledgeApiUrl,
    compatBaseUrl: engine === 'compat' ? compatBase : '',
    compatModel: cm || undefined,
    compatApiKey: ck || undefined,
    onProgress,
  });
}

/**
 * @param {object} opts
 * @param {'openai'|'knowledge'|'compat'} [opts.engine]
 * @param {string} [opts.openaiApiKey]
 * @param {string} [opts.knowledgeApiUrl]
 * @param {string} [opts.compatBaseUrl]
 * @param {string} [opts.compatModel]
 * @param {string} [opts.compatApiKey]
 * @param {'both'|'stl'} [opts.output] — `stl` (default): temp `.scad` only; Butler folder gets `.stl` if compile succeeds. `both`: keep `.scad` in print3d too.
 */
export async function runPrint3dOpenScadPipeline(opts) {
  const {
    butlorDataRoot,
    prompt,
    model,
    onProgress,
    engine = 'openai',
    openaiApiKey,
    knowledgeApiUrl,
    compatBaseUrl,
    compatModel,
    compatApiKey,
  } = opts;

  const rawOut = String(opts.output || process.env.BUTLER_PRINT3D_OUTPUT || 'stl')
    .trim()
    .toLowerCase();
  const outputStlOnly = rawOut === 'stl';

  let scad;
  let sourceModel;
  const eng = String(engine || 'openai').toLowerCase();

  if (eng === 'knowledge') {
    onProgress?.({ message: 'Knowledge API → local LLM (offline from OpenAI)…' });
    const out = await generateOpenScadViaKnowledgeApi({
      knowledgeBaseUrl: knowledgeApiUrl,
      prompt,
    });
    scad = out.scad;
    sourceModel = out.model;
  } else if (eng === 'compat') {
    const base = String(compatBaseUrl || '').trim() || String(process.env.BUTLER_PRINT3D_V1_URL || '').trim();
    if (!base) throw new Error('Set base URL for OpenAI-compatible server (e.g. Ollama http://127.0.0.1:11434).');
    onProgress?.({ message: 'OpenAI-compatible server → OpenSCAD…' });
    const out = await generateOpenScadWithOpenAiCompat({
      baseUrl: base,
      prompt,
      model: compatModel || DEFAULT_COMPAT_MODEL,
      apiKey: compatApiKey,
    });
    scad = out.scad;
    sourceModel = out.model;
  } else {
    if (!String(openaiApiKey || '').trim()) throw new Error('OpenAI API key required for cloud engine (or switch engine to Local).');
    onProgress?.({ message: 'OpenAI → OpenSCAD…' });
    const out = await generateOpenScadWithOpenAI({
      apiKey: openaiApiKey.trim(),
      prompt,
      model: model || DEFAULT_MODEL,
    });
    scad = out.scad;
    sourceModel = out.model;
  }

  const outDir = path.join(butlorDataRoot, 'print3d');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `${stamp}_${slugify(prompt) || 'model'}`;
  const stlPath = path.join(outDir, `${base}.stl`);
  const scadPath = outputStlOnly
    ? path.join(tmpdir(), `butler-print3d-${base}.scad`)
    : path.join(outDir, `${base}.scad`);

  await writeFile(scadPath, scad, 'utf8');
  onProgress?.({
    message: outputStlOnly
      ? 'Rendering STL (intermediate CAD is temporary)…'
      : 'Saved .scad in print3d — rendering STL with OpenSCAD (if installed)…',
  });

  const render = await renderScadToStl(scadPath, stlPath);
  let scadPathOut = null;
  const paths = [];

  async function removeTempScad() {
    if (!outputStlOnly) return;
    try {
      await unlink(scadPath);
    } catch {
      /* */
    }
  }

  if (render.ok) {
    await removeTempScad();
    paths.push(stlPath);
    if (!outputStlOnly) {
      scadPathOut = scadPath;
      paths.unshift(scadPath);
    }
  } else {
    await removeTempScad();
    if (!outputStlOnly) {
      scadPathOut = scadPath;
      paths.push(scadPath);
    }
  }

  let hint = null;
  if (!render.ok) {
    const baseHint =
      render.stderr ||
      'Install OpenSCAD from https://openscad.org/ and put openscad.com (Windows) or openscad on PATH.';
    hint = outputStlOnly
      ? `${baseHint} No STL was saved; no CAD file was kept in your Butler folder.`
      : `${baseHint} A .scad file is in your print3d folder—you can open it in OpenSCAD and export STL manually.`;
  }

  return {
    engine: eng,
    llm_model: sourceModel,
    output: outputStlOnly ? 'stl' : 'both',
    scad_path: scadPathOut,
    stl_path: render.ok ? stlPath : null,
    paths,
    openscad_render_ok: render.ok,
    openscad_command: render.command || null,
    openscad_hint: hint,
  };
}
