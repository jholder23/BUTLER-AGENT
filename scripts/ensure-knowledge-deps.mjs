#!/usr/bin/env node
/**
 * Best-effort pip install for knowledge/requirements.txt before starting the API.
 * Set SKIP_KNOWLEDGE_PIP=1 to skip (e.g. CI or frozen venv).
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

if (process.env.SKIP_KNOWLEDGE_PIP === '1') {
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = path.join(root, 'knowledge', 'requirements.txt');
const args = ['-m', 'pip', 'install', '-r', req, '-q'];
const opts = { stdio: 'inherit', cwd: root };

for (const cmd of ['python', 'py', 'python3']) {
  const pyArgs = cmd === 'py' ? ['-3', ...args] : args;
  const r = spawnSync(cmd, pyArgs, {
    ...opts,
    shell: process.platform === 'win32',
  });
  if (r.status === 0) process.exit(0);
}

console.error('Could not install knowledge dependencies. Install Python, then: pip install -r knowledge/requirements.txt');
process.exit(1);
