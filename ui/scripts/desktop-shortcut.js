#!/usr/bin/env node
/**
 * Creates a desktop shortcut to Butler.exe (Windows).
 *
 * Env:
 *   BUTLER_DESKTOP_EXE         — full path to Butler.exe
 *                                (default: <repo>/dist-desktop/App/Butler.exe, then
 *                                 ui/dist-app-new/win-unpacked/Butler.exe)
 *   BUTLER_DESKTOP_SHORTCUT_NAME — .lnk name without extension (default: Butler)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

if (process.platform !== 'win32') {
  console.log('Desktop shortcut: Windows only. Skipped.');
  process.exit(0);
}

const UI = path.resolve(__dirname, '..');
const ROOT = path.resolve(UI, '..');
const preferredExe = path.join(ROOT, 'dist-desktop', 'App', 'Butler.exe');
const legacyExe = path.join(UI, 'dist-app-new', 'win-unpacked', 'Butler.exe');
const defaultExe = fs.existsSync(preferredExe) ? preferredExe : legacyExe;
const exePath = (process.env.BUTLER_DESKTOP_EXE || '').trim()
  ? path.resolve(process.env.BUTLER_DESKTOP_EXE.trim())
  : defaultExe;

const shortcutBase = (process.env.BUTLER_DESKTOP_SHORTCUT_NAME || 'Butler').trim() || 'Butler';
const desktop = path.join(os.homedir(), 'Desktop');
const shortcutPath = path.join(desktop, `${shortcutBase}.lnk`);

if (!fs.existsSync(exePath)) {
  console.log('Butler.exe not found:', exePath);
  process.exit(0);
}

const workingDir = path.dirname(exePath);
const rebuildCmd = path.join(workingDir, 'Butler-Rebuild.cmd');
const iconPath = path.join(UI, 'electron', 'icon.ico');
const portableShortcut = !!(process.env.BUTLER_DESKTOP_EXE || '').trim()
  || path.normalize(exePath).toLowerCase() === path.normalize(preferredExe).toLowerCase();
const iconForPs = portableShortcut
  ? `${exePath.replace(/\\/g, '\\\\')},0`
  : fs.existsSync(iconPath)
    ? `${iconPath.replace(/\\/g, '\\\\')},0`
    : `${exePath.replace(/\\/g, '\\\\')},0`;
const rebuildShortcutPath = path.join(desktop, 'Butler Rebuild.lnk');
const rebuildDesktopBat = path.join(UI, '..', 'scripts', 'Butler-Rebuild-To-Desktop.bat');
const rebuildDesktopShortcutPath = path.join(desktop, 'Rebuild Butler (to Desktop).lnk');
const startMenuDir = path.join(
  process.env.APPDATA || '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
);
const startMenuShortcutPath = path.join(startMenuDir, `${shortcutBase}.lnk`);

const escapePs = (p) => p.replace(/\\/g, '\\\\');

// Always launch Butler.exe (not Butler-Start.cmd) so the shortcut cannot drift to an older cmd wrapper.
const mainTarget = exePath;
const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
function Set-ButlerLnk($path) {
  $s = $WshShell.CreateShortcut($path)
  $s.TargetPath = "${escapePs(mainTarget)}"
  $s.WorkingDirectory = "${escapePs(workingDir)}"
  $s.Arguments = ""
  $s.IconLocation = "${iconForPs}"
  $s.Description = "Butler Agent (dist-desktop)"
  $s.Save()
}
Set-ButlerLnk "${escapePs(shortcutPath)}"
$sm = "${escapePs(startMenuShortcutPath)}"
if ($sm -and (Test-Path -LiteralPath "${escapePs(startMenuDir)}")) {
  Set-ButlerLnk $sm
}
$rb = "${escapePs(rebuildShortcutPath)}"
$cmd = "${escapePs(rebuildCmd)}"
if (Test-Path -LiteralPath $cmd) {
  $r = $WshShell.CreateShortcut($rb)
  $r.TargetPath = $cmd
  $r.WorkingDirectory = "${escapePs(workingDir)}"
  $r.IconLocation = "${iconForPs}"
  $r.Save()
}
$deskBat = "${escapePs(rebuildDesktopBat)}"
$deskLnk = "${escapePs(rebuildDesktopShortcutPath)}"
if (Test-Path -LiteralPath $deskBat) {
  $d = $WshShell.CreateShortcut($deskLnk)
  $d.TargetPath = $deskBat
  $d.WorkingDirectory = "${escapePs(path.join(UI, '..'))}"
  $d.IconLocation = "${iconForPs}"
  $d.Description = "Rebuild Butler from source and refresh Desktop\\Butler"
  $d.Save()
}
`;
const tmp = path.join(UI, 'tmp-shortcut.ps1');
fs.writeFileSync(tmp, psScript, 'utf8');
try {
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, {
    stdio: 'inherit',
    timeout: 90000,
  });
  console.log('Desktop shortcut:', `${shortcutBase}.lnk`, '->', exePath);
  if (fs.existsSync(startMenuDir)) {
    console.log('Start Menu shortcut:', `${shortcutBase}.lnk`, '->', exePath);
  }
  if (fs.existsSync(rebuildCmd)) {
    console.log('Desktop shortcut: Butler Rebuild (optional)');
  }
} catch (e) {
  console.warn('Could not create shortcut:', e.message);
} finally {
  try { fs.unlinkSync(tmp); } catch (_) {}
}
