/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import { spawn, type ChildProcess } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const uiServerEntry = path.join(repoRoot, 'ui-server.js');

function probePort4001(): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(v);
    };
    const s = net.createConnection({ port: 4001, host: '127.0.0.1' }, () => {
      try {
        s.destroy();
      } catch {
        /* */
      }
      finish(true);
    });
    s.on('error', () => finish(false));
    const t = setTimeout(() => {
      try {
        s.destroy();
      } catch {
        /* */
      }
      finish(false);
    }, 800);
  });
}

async function waitForPort4001(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await probePort4001()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** True only if Butler’s own ui-server / Electron API is responding — not some other process bound to 4001. */
async function probeButlerHealth(): Promise<boolean> {
  try {
    const r = await fetch('http://127.0.0.1:4001/api/health', { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const j = (await r.json()) as { ok?: boolean; service?: string };
    return (
      j?.ok === true && (j.service === 'butler-ui-server' || j.service === 'butler-electron')
    );
  } catch {
    return false;
  }
}

async function waitForButlerHealth(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await probeButlerHealth()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * If nothing listens on 4001, spawn `node ui-server.js` from the Butler repo root so `/api` proxy works.
 * Skip with BUTLER_SKIP_UI_SERVER=1. When root `npm run dev` already started the API, port is up — no duplicate.
 */
function butlerAutoUiServerPlugin(): Plugin {
  let child: ChildProcess | null = null;
  const startIfNeeded = async (label: string) => {
    if (process.env.BUTLER_SKIP_UI_SERVER === '1') return;
    let healthy = await probeButlerHealth();
    for (let i = 0; i < 8 && !healthy; i++) {
      await new Promise((r) => setTimeout(r, 250));
      healthy = await probeButlerHealth();
    }
    if (healthy) {
      console.log(`[vite] ${label}: Butler API already running on http://127.0.0.1:4001`);
      return;
    }
    if (await probePort4001()) {
      console.warn(
        `[vite] ${label}: port 4001 is in use but Butler GET /api/health did not respond. Another app may own 4001, or Butler is still starting. If this persists, free port 4001 and run: node ui-server.js (repo root)`,
      );
      return;
    }
    const node = process.execPath;
    child = spawn(node, [uiServerEntry], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.warn(
          `[vite] ${label}: ui-server.js exited (${code}). From repo root run: node ui-server.js`,
        );
      }
      child = null;
    });
    const ok = await waitForButlerHealth(45000);
    if (ok) {
      console.log(`[vite] ${label}: Butler API ready at http://127.0.0.1:4001`);
    } else {
      console.warn(
        `[vite] ${label}: timed out waiting for Butler on 4001. From repo root run: node ui-server.js`,
      );
    }
  };
  return {
    name: 'butler-auto-ui-server',
    configureServer() {
      void startIfNeeded('dev server');
      return () => {
        if (child && !child.killed) {
          try {
            child.kill('SIGTERM');
          } catch {
            /* */
          }
          child = null;
        }
      };
    },
    configurePreviewServer() {
      void startIfNeeded('preview');
      return () => {
        if (child && !child.killed) {
          try {
            child.kill('SIGTERM');
          } catch {
            /* */
          }
          child = null;
        }
      };
    },
  };
}

/** Root `npm run dev` sets BUTLER_DEV_LIVE=0 unless --live. Solo `npm run dev` in ui/ leaves env unset → HMR on. */
const viteHmr =
  process.env.BUTLER_DEV_LIVE === undefined
    ? true
    : process.env.BUTLER_DEV_LIVE === '1';

export default defineConfig({
  plugins: [react(), butlerAutoUiServerPlugin()],
  root: '.',
  base: './',
  resolve: {
    alias: {
      '@resume-docx-presets': path.join(repoRoot, 'resume-docx-presets.json'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    hmr: viteHmr,
    proxy: {
      // Long Butler chats wait on Knowledge + local LLM; avoid proxy/socket timeouts before the first byte.
      '/api': {
        target: 'http://127.0.0.1:4001',
        changeOrigin: true,
        timeout: 7_200_000,
        proxyTimeout: 7_200_000,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            try {
              proxyReq.setTimeout(0);
            } catch {
              /* ignore */
            }
          });
        },
      },
    },
  },
  preview: {
    port: 4173,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4001',
        changeOrigin: true,
        timeout: 7_200_000,
        proxyTimeout: 7_200_000,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            try {
              proxyReq.setTimeout(0);
            } catch {
              /* ignore */
            }
          });
        },
      },
    },
  },
});

