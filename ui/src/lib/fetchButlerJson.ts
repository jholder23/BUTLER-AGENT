import { butlerApiUrl } from './butlerApiBase';

function resolveApiUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === 'string' && input.startsWith('/api')) {
    return butlerApiUrl(input);
  }
  return input;
}

/**
 * Butler UI expects JSON from `/api/*`. HTML (often `<!DOCTYPE`) means wrong server
 * or the Vite proxy cannot reach the Butler API.
 */
export async function fetchButlerJsonWithResponse<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ res: Response; data: T }> {
  const r = await fetch(resolveApiUrl(input), init);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    const text = await r.text();
    const start = text.trimStart().slice(0, 120);
    if (start.startsWith('<!') || start.toLowerCase().startsWith('<html')) {
      const at = typeof r.url === 'string' ? r.url : '';
      const electron = typeof window !== 'undefined' && !!(window as Window & { butlerElectron?: unknown }).butlerElectron;
      throw new Error(
        electron
          ? `Butler API returned HTML instead of JSON (${at || 'response'}). Quit and relaunch Butler.exe so the packaged API (port 4011) is serving this window.`
          : `Butler API returned HTML instead of JSON (${at || 'response'}). Ensure something is listening on port 4001: from the Butler repo root run \`node ui-server.js\`, or use the full dev command \`npm run dev\` (starts the API + Vite).`,
      );
    }
    throw new Error(start || `Expected JSON, got ${r.status} ${r.statusText}`);
  }
  const data = (await r.json()) as T;
  return { res: r, data };
}

export async function fetchButlerJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const { data } = await fetchButlerJsonWithResponse<T>(input, init);
  return data;
}
