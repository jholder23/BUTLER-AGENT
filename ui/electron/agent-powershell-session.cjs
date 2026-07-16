'use strict';

/**
 * Persistent PowerShell sessions for Butler Agent terminal.
 * Prefers pwsh, falls back to Windows PowerShell. No PTY — stdin/stdout with markers.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** @type {{ exe: string, label: string } | null} */
let cachedShell = null;

function resolvePowerShellExe() {
  if (cachedShell) return cachedShell;
  try {
    const out = execFileSync('where.exe', ['pwsh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    const first = String(out)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && fs.existsSync(s));
    if (first) {
      cachedShell = { exe: first, label: 'pwsh' };
      return cachedShell;
    }
  } catch {
    /* no pwsh on PATH */
  }
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const ps = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(ps)) {
    cachedShell = { exe: ps, label: 'powershell' };
    return cachedShell;
  }
  cachedShell = { exe: 'powershell.exe', label: 'powershell' };
  return cachedShell;
}

/** @type {Map<string, PowerShellSession>} */
const sessions = new Map();

function sessionKey(sessionId) {
  return String(sessionId || 'butler-agent-window').trim() || 'butler-agent-window';
}

class PowerShellSession {
  /**
   * @param {string} key
   * @param {string} cwd
   * @param {NodeJS.ProcessEnv} env
   */
  constructor(key, cwd, env) {
    this.key = key;
    this.cwd = cwd;
    this.env = env;
    this.shell = resolvePowerShellExe();
    /** @type {import('child_process').ChildProcessWithoutNullStreams | null} */
    this.proc = null;
    this.alive = false;
    this.buf = '';
    /** @type {Array<{ begin: string, end: string, resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.waiters = [];
    this.queue = Promise.resolve();
    this.starting = null;
  }

  _onChunk(chunk) {
    this.buf += chunk.toString('utf8');
    this._flushWaiters();
  }

  _flushWaiters() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      const endIdx = this.buf.indexOf(w.end);
      if (endIdx < 0) return;
      const beginIdx = this.buf.indexOf(w.begin);
      if (beginIdx < 0 || beginIdx > endIdx) {
        // Marker noise — drop prefix and keep waiting
        this.buf = this.buf.slice(endIdx + w.end.length);
        continue;
      }
      const body = this.buf.slice(beginIdx + w.begin.length, endIdx);
      const after = this.buf.slice(endIdx + w.end.length);
      // Trailing meta line may be on same buffer after end marker line
      let metaLine = '';
      let rest = after;
      const nl = after.indexOf('\n');
      if (nl >= 0) {
        metaLine = after.slice(0, nl).replace(/\r$/, '');
        rest = after.slice(nl + 1);
      } else if (after.trim()) {
        metaLine = after.replace(/\r$/, '');
        rest = '';
      }
      this.buf = rest;
      clearTimeout(w.timer);
      this.waiters.shift();
      w.resolve({ body, metaLine });
    }
  }

  async ensureStarted() {
    if (this.proc && this.alive) return;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const shell = this.shell;
      let settled = false;
      const child = spawn(
        shell.exe,
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        {
          cwd: this.cwd,
          env: this.env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      this.proc = child;
      this.alive = true;
      this.buf = '';

      child.stdout.on('data', (c) => this._onChunk(c));
      child.stderr.on('data', (c) => this._onChunk(c));
      child.on('exit', () => {
        this.alive = false;
        this.proc = null;
        this.starting = null;
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(new Error('PowerShell session ended'));
        }
      });
      child.on('error', (err) => {
        this.alive = false;
        this.proc = null;
        this.starting = null;
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      // Probe readiness
      const readyId = `rdy_${Date.now().toString(36)}`;
      const begin = `__BUTLER_BEGIN_${readyId}__`;
      const end = `__BUTLER_END_${readyId}__`;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('PowerShell session failed to start (timeout)'));
        }
      }, 15000);
      this.waiters.push({
        begin,
        end,
        timer,
        resolve: () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve();
          }
        },
        reject: (err) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err);
          }
        },
      });
      try {
        child.stdin.write(
          `Write-Output '${begin}'; Write-Output '${end}|0|$((Get-Location).Path)'\n`,
        );
      } catch (err) {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  kill() {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error('PowerShell session reset'));
    }
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    this.alive = false;
    this.buf = '';
    this.starting = null;
  }

  /**
   * @param {string} command
   * @param {number} timeoutMs
   */
  run(command, timeoutMs = 120000) {
    const runOne = async () => {
      await this.ensureStarted();
      if (!this.proc || !this.alive) throw new Error('PowerShell not running');

      const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const begin = `__BUTLER_BEGIN_${id}__`;
      const end = `__BUTLER_END_${id}__`;
      const b64 = Buffer.from(command, 'utf8').toString('base64');

      const script = [
        `$ErrorActionPreference = 'Continue'`,
        `Write-Output '${begin}'`,
        `$__butler_ec = 0`,
        `try {`,
        `  $__butler_bytes = [Convert]::FromBase64String('${b64}')`,
        `  $__butler_cmd = [Text.Encoding]::UTF8.GetString($__butler_bytes)`,
        `  Invoke-Expression -Command $__butler_cmd | Out-String -Width 4096 | Write-Output`,
        `  if ($null -ne $LASTEXITCODE) { $__butler_ec = [int]$LASTEXITCODE }`,
        `} catch {`,
        `  $_ | Out-String -Width 4096 | Write-Output`,
        `  $__butler_ec = 1`,
        `}`,
        `Write-Output ('${end}|' + $__butler_ec + '|' + (Get-Location).Path)`,
        ``,
      ].join('\n');

      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        this.waiters.push({ begin, end, timer, resolve, reject });
        try {
          this.proc.stdin.write(script);
        } catch (err) {
          clearTimeout(timer);
          const idx = this.waiters.findIndex((w) => w.begin === begin);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(err);
        }
      });

      const meta = String(result.metaLine || '');
      // Expected: __BUTLER_END_id__|code|cwd  — end marker already stripped; metaLine is |code|cwd or full
      let code = 0;
      let cwd = this.cwd;
      const m = meta.match(/\|(-?\d+)\|(.*)$/);
      if (m) {
        code = Number(m[1]);
        cwd = (m[2] || '').trim() || this.cwd;
      } else {
        const parts = meta.split('|').filter(Boolean);
        if (parts.length >= 2) {
          code = Number(parts[parts.length - 2]) || 0;
          cwd = parts[parts.length - 1] || this.cwd;
        }
      }
      this.cwd = cwd;
      const body = String(result.body || '').replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      return { stdout: body, code, cwd };
    };

    const next = this.queue.then(runOne, runOne);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/**
 * @param {{ sessionId?: string, cwd: string, command: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} opts
 */
async function runInPowerShellSession(opts) {
  const key = sessionKey(opts.sessionId);
  const cwd = opts.cwd;
  const env = opts.env || process.env;
  let session = sessions.get(key);
  if (!session) {
    session = new PowerShellSession(key, cwd, env);
    sessions.set(key, session);
  }
  const started = Date.now();
  const shell = session.shell;
  try {
    const out = await session.run(String(opts.command || ''), opts.timeoutMs || 120000);
    return {
      ok: out.code === 0,
      command: String(opts.command || ''),
      cwd: out.cwd,
      stdout: out.stdout || '',
      stderr: '',
      code: out.code,
      duration_ms: Date.now() - started,
      shell: shell.label,
      shell_path: shell.exe,
      session: true,
    };
  } catch (err) {
    // Restart next time if process died mid-command
    try {
      session.kill();
    } catch {
      /* ignore */
    }
    sessions.delete(key);
    return {
      ok: false,
      command: String(opts.command || ''),
      cwd: session.cwd || cwd,
      stdout: '',
      stderr: '',
      code: null,
      message: err && err.message ? err.message : String(err),
      duration_ms: Date.now() - started,
      shell: shell.label,
      shell_path: shell.exe,
      session: true,
    };
  }
}

/**
 * @param {{ sessionId?: string, cwd?: string, env?: NodeJS.ProcessEnv }} opts
 */
function resetPowerShellSession(opts = {}) {
  const key = sessionKey(opts.sessionId);
  const prev = sessions.get(key);
  if (prev) {
    prev.kill();
    sessions.delete(key);
  }
  const shell = resolvePowerShellExe();
  if (opts.cwd) {
    const session = new PowerShellSession(key, opts.cwd, opts.env || process.env);
    sessions.set(key, session);
  }
  return { ok: true, shell: shell.label, shell_path: shell.exe };
}

function getPowerShellInfo(sessionId) {
  const key = sessionKey(sessionId);
  const shell = resolvePowerShellExe();
  const session = sessions.get(key);
  return {
    ok: true,
    shell: shell.label,
    shell_path: shell.exe,
    cwd: session ? session.cwd : null,
    alive: !!(session && session.alive),
  };
}

module.exports = {
  resolvePowerShellExe,
  runInPowerShellSession,
  resetPowerShellSession,
  getPowerShellInfo,
};
