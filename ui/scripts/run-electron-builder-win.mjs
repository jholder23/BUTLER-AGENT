#!/usr/bin/env node
/**
 * Windows electron-builder wrapper.
 * Disables auto code-sign discovery so winCodeSign's darwin symlinks
 * do not fail on machines without Developer Mode / SeCreateSymbolicLinkPrivilege.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=8192'].filter(Boolean).join(' '),
};
const args = process.argv.slice(2);
const r = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-builder', '--win', ...args],
  { cwd: UI, env, stdio: 'inherit', shell: true },
);
process.exit(r.status == null ? 1 : r.status);
