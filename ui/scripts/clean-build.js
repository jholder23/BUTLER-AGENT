#!/usr/bin/env node
/**
 * Cleans build output before installer. Prevents "file in use" errors on Windows.
 * Kills Butler and its children (/T) so embedded Python cannot keep resources\knowledge locked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const UI = path.resolve(__dirname, '..');
const OUT = path.join(UI, 'dist-app-new');
const UNPACKED = path.join(OUT, 'win-unpacked');

function sleepWinMs(ms) {
  if (process.platform !== 'win32') return;
  const sec = Math.max(1, Math.ceil(ms / 1000));
  try {
    execSync(`ping -n ${sec + 1} 127.0.0.1 > nul`, { stdio: 'ignore' });
  } catch (_) {}
}

if (process.platform === 'win32') {
  // /T = terminate child processes (stops python-embed started by Butler)
  try {
    execSync('taskkill /F /T /IM Butler.exe', { stdio: 'ignore' });
  } catch (_) {}
  // Stray python.exe from packaged python-embed (narrow match — not all python.exe)
  const ps1 = path.join(os.tmpdir(), `butler-clean-python-${process.pid}.ps1`);
  try {
    fs.writeFileSync(
      ps1,
      [
        '$p = Get-CimInstance Win32_Process -Filter "Name=\'python.exe\'" -ErrorAction SilentlyContinue |',
        '  Where-Object {',
        '    $_.CommandLine -and ($_.CommandLine -like \'*python-embed*\') -and',
        '    ($_.CommandLine -like \'*win-unpacked*\' -or $_.CommandLine -like \'*dist-app-new*\')',
        '  }',
        '$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
        '',
      ].join('\r\n'),
      'utf8',
    );
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { stdio: 'ignore' });
  } catch (_) {
  } finally {
    try {
      fs.unlinkSync(ps1);
    } catch (_) {}
  }
  sleepWinMs(2500);
}

const RM_OPTS = { recursive: true, force: true, maxRetries: 25, retryDelay: 400 };

function rm(p) {
  if (!fs.existsSync(p)) return true;
  try {
    fs.rmSync(p, RM_OPTS);
    console.log('Removed:', p);
    return true;
  } catch (e) {
    console.warn('Could not remove', p, '-', e.message);
    return false;
  }
}

function renameAsideLockedUnpacked() {
  if (process.platform !== 'win32' || !fs.existsSync(UNPACKED)) return false;
  try {
    fs.mkdirSync(OUT, { recursive: true });
  } catch (_) {}
  const stale = path.join(OUT, `win-unpacked.__stale_${Date.now()}`);
  try {
    fs.renameSync(UNPACKED, stale);
    console.log('Renamed locked win-unpacked to:', stale);
    console.log('Build will use a fresh win-unpacked. Delete the __stale folder when no process has it open.\n');
    return true;
  } catch (e) {
    console.warn('Could not rename locked win-unpacked -', e.message);
    return false;
  }
}

rm(UNPACKED);
let unpackedRenamedAside = false;
if (fs.existsSync(UNPACKED)) {
  unpackedRenamedAside = renameAsideLockedUnpacked();
}

if (fs.existsSync(UNPACKED)) {
  console.error('\nClean failed: dist-app-new\\win-unpacked is still locked.');
  console.error('Close Butler, Explorer windows inside win-unpacked, and any terminal whose cwd is that folder, then retry.\n');
  process.exit(1);
}

if (fs.existsSync(OUT) && !unpackedRenamedAside) {
  rm(OUT);
} else if (unpackedRenamedAside) {
  console.log('Leaving previous tree as win-unpacked.__stale_* under dist-app-new; delete it later when unlocked.\n');
}

console.log('Clean done.\n');
