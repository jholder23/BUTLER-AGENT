/**
 * Root dev orchestration: sets BUTLER_DEV_LIVE from --live, then runs concurrently.
 * Before services start: installs root + ui npm deps (skip with BUTLER_SKIP_DEV_BOOTSTRAP=1).
 * Python deps still install via `ensure-knowledge-deps` inside dev:knowledge.
 * Usage from ADM/scripts: `npm run dev` — same behavior.
 * CLI: npm run dev [-- --live]   |   npm run dev:electron [-- --live]
 *
 * Duplicate guard: if Knowledge (8765), ui-server (4001), and Vite (5173) already respond,
 * exits 0 without killing ports — prevents a second `npm run dev` or agent run from wiping
 * your first concurrently session.
 * Restart: Ctrl+C in the running dev terminal, then `npm run dev`, `npm run dev:restart`,
 * `npm run dev -- --force`, or BUTLER_DEV_FORCE=1 npm run dev
 *
 * When starting fresh or forcing, frees those ports first so restarts replace stale listeners.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrapDevDeps } from './bootstrap-dev-deps.mjs';
import { butlerDevStackHealthy } from './dev-stack-health.mjs';
import { freeButlerDevPorts } from './free-butler-dev-ports.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const args = process.argv.slice(2);
const live = args.includes('--live');
const electron = args.includes('--electron');
const force = args.includes('--force') || process.env.BUTLER_DEV_FORCE === '1';

process.env.BUTLER_DEV_LIVE = live ? '1' : '0';
process.env.BUTLER_DEV_ORCHESTRATED = '1';
/** Large enough for slow localhost:5000 (stub synthesis) + chained Knowledge LLM hops. Override in shell if needed. */
if (!process.env.BUTLER_PEEPEE_HTTP_TIMEOUT_SEC) {
  process.env.BUTLER_PEEPEE_HTTP_TIMEOUT_SEC = '420';
}
if (!process.env.BUTLER_UI_CHAT_TIMEOUT_MS) {
  process.env.BUTLER_UI_CHAT_TIMEOUT_MS = '840000';
}
bootstrapDevDeps();

if (!force) {
  try {
    if (await butlerDevStackHealthy()) {
      console.log(
        '[dev] Butler dev stack already up (8765 Knowledge, 4001 API, 5173 Vite). Not starting again.',
      );
      console.log(
        '[dev] To replace it: stop the existing dev terminal, or run `npm run dev:restart`, or `npm run dev -- --force`.',
      );
      process.exit(0);
    }
  } catch {
    /* proceed with normal start */
  }
}

await freeButlerDevPorts();
// Let OS release listeners (Windows especially) before concurrently re-binds the same ports.
if (force) {
  await new Promise((r) => setTimeout(r, 800));
}

const cmd = electron
  ? 'npx concurrently -n knowledge,api,desk -c blue,green,cyan "npm run dev:knowledge" "npm run dev:ui-server" "wait-on tcp:127.0.0.1:8765 tcp:127.0.0.1:4001 && npm run dev:app --prefix ui"'
  : 'npx concurrently -n knowledge,api,vite -c blue,green,magenta "npm run dev:knowledge" "npm run dev:ui-server" "npm run dev:vite"';

const child = spawn(cmd, {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
