/**
 * Code Helper dev mode:
 * - Keeps AI file actions inside a safe sandbox by default
 * - Boots the normal Butler dev stack (Knowledge + ui-server + Electron)
 *
 * Windows PowerShell-friendly: no cross-env dependency needed.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// Default sandbox (can be overridden by user env).
const defaultSandbox = path.join(root, 'projects', 'code-helper');

process.env.CODE_HELPER_PROJECTS_ROOT = process.env.CODE_HELPER_PROJECTS_ROOT || defaultSandbox;
process.env.BUTLER_GLOBAL_PROJECT_ROOT = process.env.BUTLER_GLOBAL_PROJECT_ROOT || process.env.CODE_HELPER_PROJECTS_ROOT;

// Locked-down by default: no full-disk access unless user explicitly enables it.
if (process.env.BUTLER_ALLOW_ANY_PATH === undefined) process.env.BUTLER_ALLOW_ANY_PATH = '0';

// Helpful label in logs / future UI branching.
process.env.BUTLER_VARIANT = process.env.BUTLER_VARIANT || 'code-helper';

const cmd = 'npm run dev:electron';
const child = spawn(cmd, { cwd: root, stdio: 'inherit', shell: true, env: process.env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

