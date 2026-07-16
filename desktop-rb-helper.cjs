/**
 * Default reference image for SD img2img / image2video when the user sends no upload:
 * first existing file among Desktop/rb, rb.png, rb.jpg, … (Windows: User Desktop + OneDrive Desktop).
 *
 * Disable: set BUTLER_SD_DESKTOP_RB=0
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const NAMES = ['rb', 'rb.png', 'rb.jpg', 'rb.jpeg', 'rb.webp', 'rb.gif'];
const MAX_BYTES = 80 * 1024 * 1024;

function _desktopDirs() {
  const out = [];
  const h = os.homedir();
  if (process.platform === 'win32') {
    out.push(path.join(h, 'Desktop'));
    const od = process.env.OneDrive;
    if (od) out.push(path.join(od, 'Desktop'));
    const pub = process.env.PUBLIC;
    if (pub) out.push(path.join(pub, 'Desktop'));
  } else {
    out.push(path.join(h, 'Desktop'));
    const xdg = process.env.XDG_DESKTOP_DIR;
    if (xdg) out.push(xdg);
  }
  return [...new Set(out.map((p) => path.normalize(p)))];
}

function _looksLikeRasterImage(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  return false;
}

function readDesktopRbBase64Sync() {
  if (process.env.BUTLER_SD_DESKTOP_RB === '0' || process.env.BUTLER_SD_DESKTOP_RB === 'false') {
    return '';
  }
  for (const desk of _desktopDirs()) {
    if (!desk) continue;
    try {
      if (!fs.existsSync(desk) || !fs.statSync(desk).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of NAMES) {
      const full = path.join(desk, name);
      try {
        if (!fs.existsSync(full)) continue;
        const st = fs.statSync(full);
        if (!st.isFile() || st.size < 32 || st.size > MAX_BYTES) continue;
        const buf = fs.readFileSync(full);
        const ext = path.extname(name).toLowerCase();
        if (ext === '' && !_looksLikeRasterImage(buf)) continue;
        return buf.toString('base64');
      } catch {
        /* next */
      }
    }
  }
  return '';
}

module.exports = { readDesktopRbBase64Sync };
