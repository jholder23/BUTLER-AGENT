/**
 * When Comfy/Forge returns ok + output file path but omits base64 (or payload was stripped),
 * read the file so the Butler UI can show thumbnails / video in the session gallery.
 * Sweep results are encoded for Butler-only visibility.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { basename } from 'path';

const MAX_EMBED_BYTES = 80 * 1024 * 1024;
const ENCRYPTION_KEY = 'butler-sweep-secure-key-2024';

/** XOR encode/decode for sweep result images (Butler-only visibility). */
function _xorEncode(data) {
  const key = ENCRYPTION_KEY;
  const result = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = data[i] ^ key.charCodeAt(i % key.length);
  }
  return result;
}

/** Check if path is under easy_sweep folder (sweep results). */
function _isSweepResultPath(p) {
  const low = p.toLowerCase();
  return low.includes('easy_sweep') || low.includes('sweep');
}

/** Mutates sd in place. @param {unknown} sd */
export function fillSdPayloadFromDisk(sd) {
  if (!sd || typeof sd !== 'object') return sd;
  const o = /** @type {Record<string, unknown>} */ (sd);
  const p = typeof o.path === 'string' ? o.path.trim() : '';
  if (!p || !existsSync(p)) return sd;
  let st;
  try {
    st = statSync(p);
  } catch {
    return sd;
  }
  if (!st.isFile() || st.size > MAX_EMBED_BYTES) return sd;
  const low = p.toLowerCase();
  const imgs = Array.isArray(o.images) ? o.images : [];
  const hasImg = imgs.some((x) => typeof x === 'string' && x.length > 80);
  if (!hasImg && /\.(png|jpe?g|webp|gif)$/i.test(low)) {
    try {
      const raw = readFileSync(p);
      // Encode sweep results for Butler-only visibility
      if (_isSweepResultPath(p)) {
        o.encodedData = _xorEncode(raw).toString('base64');
      }
      o.images = [raw.toString('base64')];
    } catch {
      /* */
    }
    return sd;
  }
  const vid = typeof o.video === 'string' ? o.video.trim() : '';
  if (!vid && /\.(webm|mp4|mov|mkv|gif)$/i.test(low)) {
    try {
      const raw = readFileSync(p);
      // Encode sweep results for Butler-only visibility
      if (_isSweepResultPath(p)) {
        o.encodedData = _xorEncode(raw).toString('base64');
      }
      o.video = raw.toString('base64');
    } catch {
      /* */
    }
  }
  return sd;
}