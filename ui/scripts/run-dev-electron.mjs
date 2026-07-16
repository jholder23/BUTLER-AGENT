/**
 * Launch Electron with electronmon only when BUTLER_DEV_LIVE=1 (set by root dev-entry).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = process.env.BUTLER_DEV_LIVE === '1';
const opts = { cwd: uiRoot, stdio: 'inherit', shell: true, env: process.env };

const child = live
  ? spawn('npx', ['electronmon', '.'], opts)
  : spawn('npx', ['electron', '.'], opts);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
