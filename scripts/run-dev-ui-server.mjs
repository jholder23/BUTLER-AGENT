/**
 * After wait-on: run ui-server with nodemon only when BUTLER_DEV_LIVE=1.
 * If port 4001 already serves Butler (leftover process), skip starting a duplicate — avoids EADDRINUSE.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = process.env.BUTLER_DEV_LIVE === '1';
const orchestrated = process.env.BUTLER_DEV_ORCHESTRATED === '1';
const opts = { cwd: root, stdio: 'inherit', shell: true, env: process.env };

/** True if something on 4001 responds like Butler's own API (not a random TCP listener). */
async function butlerAlreadyListening() {
  try {
    const r = await fetch('http://127.0.0.1:4001/api/health', { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const j = await r.json();
    return (
      j?.ok === true && (j.service === 'butler-ui-server' || j.service === 'butler-electron')
    );
  } catch {
    return false;
  }
}

async function main() {
  // When started from `npm run dev`, dev-entry already freed ports — always launch a fresh ui-server.
  if (!orchestrated && (await butlerAlreadyListening())) {
    console.log(
      '[api] Butler API already on http://127.0.0.1:4001 — not starting a second ui-server (exit ok)',
    );
    console.log(
      '[api] To pick up ui-server / resume PDF changes, end the old process (or free port 4001) and run dev again.',
    );
    process.exit(0);
  }

  const child = live
    ? spawn(
        'npx',
        [
          'nodemon',
          '--watch',
          'ui-server.js',
          '--watch',
          'index.js',
          '--ext',
          'js,mjs,cjs',
          '--delay',
          '0.5',
          'ui-server.js',
        ],
        opts,
      )
    : spawn('node', ['ui-server.js'], opts);

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

main().catch((e) => {
  console.error('[api] run-dev-ui-server:', e);
  process.exit(1);
});
