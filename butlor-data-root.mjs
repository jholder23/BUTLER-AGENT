/**
 * Default Butler user-data root. Windows: D:\\butler (override with BUTLOR_CONFIG).
 * Non-Windows: ~/Documents/Butlor unless BUTLOR_CONFIG is set.
 */
import os from 'node:os';
import path from 'node:path';

export function getDefaultButlorRoot() {
  if (process.platform === 'win32') {
    return path.resolve('D:\\butler');
  }
  return path.join(os.homedir(), 'Documents', 'Butlor');
}

export function getButlorConfigDirAbs() {
  const raw = String(process.env.BUTLOR_CONFIG || '').trim();
  return path.resolve(raw || getDefaultButlorRoot());
}
