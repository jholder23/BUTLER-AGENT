/**
 * Port 8765 is Butler Knowledge API. Sine Language Animation Studio (visualizer assetys/server.py)
 * also defaults to 8765 — when both run, img2img/chat SD routes 404 with a vague "Image edit failed."
 * After kill-port, evict listeners on 8765 that are not api_server.py.
 */
import { execFileSync } from 'node:child_process';
import net from 'node:net';

function tcpListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host }, () => {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
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

async function butlerKnowledgeHealthy() {
  try {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), 2500);
    const res = await fetch('http://127.0.0.1:8765/status', {
      signal: ac.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(id);
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) return false;
    const data = await res.json();
    return Array.isArray(data?.services);
  } catch {
    return false;
  }
}

/** @returns {number} processes killed */
export async function evictNonButler8765() {
  if (process.platform !== 'win32') return 0;
  if (!(await tcpListening(8765))) return 0;
  if (await butlerKnowledgeHealthy()) return 0;

  const ps = [
    '$killed = 0',
    '$conns = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue',
    'foreach ($c in $conns) {',
    '  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess) -ErrorAction SilentlyContinue',
    '  if (-not $p) { continue }',
    '  $cmd = [string]$p.CommandLine',
    '  if ($cmd -match "api_server\\.py") { continue }',
    '  if ($cmd -match "server\\.py" -or $cmd -match "visualizer assetys") {',
    '    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue',
    '    $killed++',
    '  }',
    '}',
    'Write-Output $killed',
  ].join('; ');

  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8' },
    ).trim();
    const n = parseInt(out.split(/\r?\n/).pop() || '0', 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

const selfPath = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
if (invoked && invoked.endsWith('evict-non-butler-8765.mjs')) {
  const n = await evictNonButler8765();
  if (n > 0) {
    console.log(`[dev] Evicted ${n} non-Butler listener(s) from port 8765 (e.g. Sine Language server.py).`);
  }
}
