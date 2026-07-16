/**
 * Used by dev-entry to avoid starting a second `npm run dev` that would kill the first stack
 * (free:dev-ports + duplicate concurrently).
 */
import net from 'node:net';

function tcpListening(host, port, ms = 1200) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port }, () => {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(ms, () => {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolve(false);
    });
  });
}

async function httpOk(url, ms = 2000) {
  try {
    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), ms);
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(id);
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) return false;
    const data = await res.json();
    return Array.isArray(data?.services);
  } catch {
    return false;
  }
}

/** True when Knowledge /status, ui-server /api/health, and Vite (5173) all look usable. */
export async function butlerDevStackHealthy() {
  const [know, ui, vite] = await Promise.all([
    httpOk('http://127.0.0.1:8765/status'),
    httpOk('http://127.0.0.1:4001/api/health'),
    tcpListening('127.0.0.1', 5173),
  ]);
  return Boolean(know && ui && vite);
}
