/**
 * Free TCP ports used by `npm run dev` so a fresh orchestration can bind.
 * Opt out: BUTLER_DEV_NO_KILL_PORTS=1. Extra ports: BUTLER_DEV_KILL_PORTS=8080
 * 5000 is included by default so the bundled PEEPEEDEE stub is not left running after Knowledge dies.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evictNonButler8765 } from './evict-non-butler-8765.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

export async function freeButlerDevPorts() {
  if (process.env.BUTLER_DEV_NO_KILL_PORTS === '1') {
    console.log('[dev] BUTLER_DEV_NO_KILL_PORTS=1 — skipping dev port cleanup.');
    return;
  }
  const extra = (process.env.BUTLER_DEV_KILL_PORTS || '')
    .trim()
    .split(/[,\s]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const ports = [...new Set([8765, 4001, 5173, 5000, ...extra])];
  const cli = path.join(root, 'node_modules', 'kill-port', 'cli.js');
  if (!fs.existsSync(cli)) {
    console.warn('[dev] kill-port not installed (npm i). Skipping port cleanup.');
    return;
  }
  console.log(`[dev] Freeing dev ports (if listeners): ${ports.join(', ')} …`);
  try {
    execFileSync(process.execPath, [cli, ...ports.map(String)], { stdio: 'inherit', cwd: root });
  } catch {
    console.warn('[dev] kill-port exited non-zero (often: nothing listening). Continuing.');
  }
  const evicted = await evictNonButler8765();
  if (evicted > 0) {
    console.warn(
      `[dev] Port 8765 was held by another app (often Sine Language server.py). Evicted ${evicted} process(es).`,
    );
  }
}

const selfPath = path.resolve(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === selfPath) {
  await freeButlerDevPorts();
}
