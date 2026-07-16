/**
 * Dev-only: run Knowledge API (8765) and, when needed, the bundled PEEPEEDEE stub (ai_server.py on 5000).
 * Auto-reload on .py changes only when BUTLER_DEV_LIVE=1 (npm run dev -- --live) or BUTLER_API_RELOAD is set.
 *
 * Set BUTLER_AUTO_START_AI_SERVER=0 to never spawn ai_server.py (e.g. you run LM Studio on 5000 yourself).
 *
 * Python **3.13+**: knowledge_store defaults to JSONL (Chroma’s native layer often access-violates on 3.13).
 * Use Python 3.11 LTS + BUTLER_KNOWLEDGE_BACKEND=chroma for full vector RAG, or stay on JSONL for stability.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evictNonButler8765 } from './evict-non-butler-8765.mjs';

/**
 * Resolve a long-lived Windows Python executable.
 * Prefer `python.exe` over `py.exe`: the launcher can exit while leaving an orphan
 * interpreter, which makes this supervisor exit and tears down `concurrently`.
 */
function pythonLaunchForKnowledge() {
  if (process.platform === 'win32') {
    const fromEnv = (process.env.BUTLER_PYTHON || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) {
      return { exe: fromEnv, argsPrefix: [] };
    }
    const pyLauncher = path.join(process.env.SystemRoot || 'C:\\Windows', 'py.exe');
    if (fs.existsSync(pyLauncher)) {
      try {
        const resolved = String(
          execFileSync(pyLauncher, ['-3', '-c', 'import sys; print(sys.executable)'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 8000,
          }),
        )
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .pop();
        if (resolved && fs.existsSync(resolved) && !/WindowsApps/i.test(resolved)) {
          return { exe: resolved, argsPrefix: [] };
        }
      } catch {
        /* fall through */
      }
    }
    const local = process.env.LOCALAPPDATA || '';
    for (const candidate of [
      path.join(local, 'Programs', 'Python', 'Python313', 'python.exe'),
      path.join(local, 'Programs', 'Python', 'Python312', 'python.exe'),
      path.join(local, 'Programs', 'Python', 'Python311', 'python.exe'),
      'C:\\Python313\\python.exe',
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
    ]) {
      if (candidate && fs.existsSync(candidate)) {
        return { exe: candidate, argsPrefix: [] };
      }
    }
    if (fs.existsSync(pyLauncher)) {
      return { exe: pyLauncher, argsPrefix: ['-3'] };
    }
    return { exe: 'python', argsPrefix: [] };
  }
  return { exe: 'python3', argsPrefix: [] };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const knowledgeDir = path.join(root, 'knowledge');

function getButlerConfigPath() {
  if (process.env.BUTLER_CONFIG_PATH) return process.env.BUTLER_CONFIG_PATH;
  const base =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'code-helper-ui')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'code-helper-ui')
        : path.join(os.homedir(), '.config', 'code-helper-ui');
  return path.join(base, 'config.json');
}

const live = process.env.BUTLER_DEV_LIVE === '1';
const explicitReload = process.env.BUTLER_API_RELOAD?.trim();
const reload =
  explicitReload !== undefined && explicitReload !== ''
    ? ['1', 'true', 'yes'].includes(explicitReload.toLowerCase())
    : live;

const env = {
  ...process.env,
  BUTLER_API_RELOAD: reload ? '1' : '0',
};

function localLlmDisabled() {
  const raw = String(env.BUTLER_DISABLE_LOCAL_LLM || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}
try {
  const cfgPath = getButlerConfigPath();
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.local_only) {
      env.BUTLER_LOCAL_ONLY = '1';
      env.OPENAI_API_KEY = '';
    }
  }
} catch {
  /* ignore */
}

/** True if something accepts TCP on host:port (e.g. LM Studio or ai_server already running). */
function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host }, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(1200, () => {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolve(false);
    });
  });
}

/** Match config.py default: PEEPEEDEE on localhost:5000 unless user points elsewhere. */
function shouldAutoStartAiServer() {
  if (localLlmDisabled()) {
    return false;
  }
  if ((process.env.BUTLER_AUTO_START_AI_SERVER || '').trim().toLowerCase() === '0') {
    return false;
  }
  const raw = (process.env.BUTLOR_AI_URL || process.env.PEEPEEDEE_AI_URL || '').trim();
  if (!raw) return true;
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const host = (u.hostname || '').toLowerCase();
    const p = u.port || (u.protocol === 'https:' ? 443 : 80);
    return (host === 'localhost' || host === '127.0.0.1') && String(p) === '5000';
  } catch {
    return false;
  }
}

let aiChild = null;
let apiChild = null;
let aiRestartTimer = null;
let aiCrashCount = 0;
let aiCrashResetTimer = null;
let aiStableTimer = null;

function clearAiTimers() {
  for (const t of [aiRestartTimer, aiCrashResetTimer, aiStableTimer]) {
    if (t) {
      try {
        clearTimeout(t);
      } catch {
        /* ignore */
      }
    }
  }
  aiRestartTimer = null;
  aiCrashResetTimer = null;
  aiStableTimer = null;
}

function shutdownChildren(sig) {
  clearAiTimers();
  for (const c of [apiChild, aiChild]) {
    if (!c || c.killed) continue;
    try {
      if (process.platform === 'win32') {
        c.kill();
      } else {
        c.kill(sig || 'SIGTERM');
      }
    } catch {
      /* ignore */
    }
  }
}

process.on('SIGINT', () => shutdownChildren('SIGINT'));
process.on('SIGTERM', () => shutdownChildren('SIGTERM'));

function spawnBundledAiServer(reason) {
  const { exe, argsPrefix } = pythonLaunchForKnowledge();
  const tag = reason === 'restart' ? 'Restarting' : 'Starting';
  console.log(
    `[knowledge] ${tag} bundled PEEPEEDEE stub on http://127.0.0.1:5000 (${exe}${argsPrefix.length ? ' ' + argsPrefix.join(' ') : ''} ai_server.py in knowledge/)…`,
  );
  const aiEnv = { ...env };
  // Bundled stub: web on by default with BUTLER_STUB_WEB_FAST (single DDG merge + optional one gather)—actually gets answers locally.
  if (String(aiEnv.BUTLER_STUB_WEB ?? '').trim() === '') {
    aiEnv.BUTLER_STUB_WEB = '1';
  }
  if (String(aiEnv.BUTLER_STUB_WEB_FAST ?? '').trim() === '') {
    aiEnv.BUTLER_STUB_WEB_FAST = '1';
  }
  aiChild = spawn(exe, [...argsPrefix, 'ai_server.py'], {
    cwd: knowledgeDir,
    stdio: 'inherit',
    env: aiEnv,
    shell: false,
    windowsHide: true,
  });
  if (aiStableTimer) clearTimeout(aiStableTimer);
  aiStableTimer = setTimeout(() => {
    aiStableTimer = null;
    if (aiChild && !aiChild.killed) {
      aiCrashCount = 0;
    }
  }, 90_000);
  aiChild.on('error', (err) => {
    console.error('[knowledge] ai_server.py failed to start:', err?.message || err);
  });
  aiChild.on('exit', (code, signal) => {
    aiChild = null;
    if (aiStableTimer) {
      try {
        clearTimeout(aiStableTimer);
      } catch {
        /* ignore */
      }
      aiStableTimer = null;
    }
    console.error(
      '[knowledge] ai_server.py exited' +
        (code != null ? ` (code ${code})` : '') +
        (signal ? ` (${signal})` : '') +
        '. The Knowledge API on 8765 keeps running; only the :5000 LLM helper stopped.',
    );
    if (signal || !shouldAutoStartAiServer()) return;
    aiCrashCount = Math.min(aiCrashCount + 1, 20);
    if (aiCrashResetTimer) clearTimeout(aiCrashResetTimer);
    aiCrashResetTimer = setTimeout(() => {
      aiCrashResetTimer = null;
      aiCrashCount = 0;
    }, 5 * 60_000);
    const backoffMs = Math.min(
      45_000,
      1_600 * Math.pow(2, Math.min(Math.max(aiCrashCount - 1, 0), 5)),
    );
    console.log(`[knowledge] Will retry ai_server.py in ${Math.round(backoffMs / 1000)}s (${aiCrashCount} recent exit(s); stabilizes → counter resets after ~90s up or 5m quiet).`);
    if (aiRestartTimer) clearTimeout(aiRestartTimer);
    aiRestartTimer = setTimeout(() => {
      aiRestartTimer = null;
      if (apiChild && !apiChild.killed) spawnBundledAiServer('restart');
    }, backoffMs);
  });
}

async function main() {
  if (localLlmDisabled()) {
    console.log('[knowledge] BUTLER_DISABLE_LOCAL_LLM=1 — skipping bundled ai_server.py to save VRAM.');
  }
  const peepeeUp = await portInUse(5000);
  if (!peepeeUp && shouldAutoStartAiServer()) {
    spawnBundledAiServer('initial');
    // Brief wait so the first /chat from api_server does not race the stub bind.
    await new Promise((r) => setTimeout(r, 500));
  } else if (!peepeeUp) {
    console.log(
      '[knowledge] Port 5000 is free but BUTLOR_AI_URL / PEEPEEDEE_AI_URL is not localhost:5000 — not starting ai_server.py.',
    );
    console.log(
      '[knowledge] Start your LLM on that URL, or unset those vars to use the default http://localhost:5000 + auto stub.',
    );
  }

  console.log('[knowledge] Starting Knowledge API (api_server.py)…');
  const evicted = await evictNonButler8765();
  if (evicted > 0) {
    console.warn(
      `[knowledge] Evicted ${evicted} non-Butler process(es) from port 8765 (Sine Language server.py also uses 8765).`,
    );
    await new Promise((r) => setTimeout(r, 400));
  }
  const apiPy = pythonLaunchForKnowledge();
  apiChild = spawn(apiPy.exe, [...apiPy.argsPrefix, 'api_server.py'], {
    cwd: knowledgeDir,
    stdio: 'inherit',
    env,
    shell: false,
    windowsHide: true,
  });

  apiChild.on('exit', (code, signal) => {
    clearAiTimers();
    shutdownChildren();
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

main().catch((e) => {
  console.error('[knowledge] run-knowledge-dev:', e);
  shutdownChildren();
  process.exit(1);
});
