#!/usr/bin/env node
/**
 * Runs before orchestrated dev: root + ui npm installs, so `npm run dev` picks up Butler after git pull.
 * Skip: BUTLER_SKIP_DEV_BOOTSTRAP=1
 *
 * Knowledge Python deps stay on `ensure-knowledge-deps` inside `npm run dev:knowledge`.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function bootstrapDevDeps() {
  if (process.env.BUTLER_SKIP_DEV_BOOTSTRAP === '1') return;
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ui = path.join(root, 'ui');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const opts = { stdio: 'inherit', shell: true, env: process.env };
  spawnSync(npm, ['install', '--no-fund'], { ...opts, cwd: root });
  spawnSync(npm, ['install', '--no-fund'], { ...opts, cwd: ui });
}
