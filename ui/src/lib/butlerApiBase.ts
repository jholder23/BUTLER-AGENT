/**
 * Vite proxies `/api` → 4001; when the proxy fails, the dev server returns HTML.
 * On Vite loopback ports, call Butler directly on 127.0.0.1:4001.
 * Packaged desktop serves UI + API on the same origin (4011 by default, or +10 bumps) —
 * keep relative `/api` so we do not hit a parallel npm-run-dev stack on 4001 (Comfy 8188).
 * file:// loads prefer desktop 4011 when Electron is present, else 4001.
 */

const VITE_UI_PORTS = new Set(['5173', '5174', '5175', '4173', '4174', '3000']);

function isElectronButlerRuntime(): boolean {
  return typeof window !== 'undefined' && !!(window as Window & { butlerElectron?: unknown }).butlerElectron;
}

export function butlerApiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (typeof window === 'undefined') return p;
  try {
    const { protocol, hostname, port } = window.location;
    if (protocol === 'file:') {
      const apiPort = isElectronButlerRuntime() ? 4011 : 4001;
      return `http://127.0.0.1:${apiPort}${p}`;
    }
    const onLoopback =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
    if (!onLoopback) return p;
    const pnum = port || (protocol === 'https:' ? '443' : '80');
    // Same-origin Butler host (dev ui-server 4001, packaged desktop 4011 / bumped ports).
    if (pnum === '4001' || pnum === '4011' || (!VITE_UI_PORTS.has(pnum) && isElectronButlerRuntime())) {
      return p;
    }
    // Vite (and similar) on loopback: bypass proxy to the npm-run-dev API.
    if (protocol === 'http:' && VITE_UI_PORTS.has(pnum)) {
      return `http://127.0.0.1:4001${p}`;
    }
    // Other loopback http (e.g. preview on a custom port): keep same origin.
    return p;
  } catch {
    return p;
  }
}

/** Same as `fetch` but resolves `/api/*` to Butler correctly for Vite vs packaged desktop. */
export function butlerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof input === 'string' && input.startsWith('/api')) {
    return fetch(butlerApiUrl(input), init);
  }
  return fetch(input, init);
}
