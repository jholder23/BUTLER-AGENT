/**
 * Butler self-test suite: HTTP smoke (e2e) + knowledge pytest + optional UI vitest.
 * Loaded by Electron main and (from repo root) ui-server.js.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} opts
 * @param {string} opts.butlerBaseUrl
 * @param {string} opts.knowledgeUrl
 * @param {string} opts.knowledgeRoot
 * @param {string} [opts.uiRoot]
 * @param {boolean} [opts.packaged=false]
 * @param {string} opts.pythonExe
 */
export async function runButlerSelfTests(opts) {
  const {
    butlerBaseUrl,
    knowledgeUrl,
    knowledgeRoot,
    uiRoot = '',
    packaged = false,
    pythonExe,
  } = opts;

  const results = [];

  const push = (name, ok, detail, output = '') => {
    results.push({
      name,
      ok: !!ok,
      detail: detail != null ? String(detail).slice(0, 2000) : '',
      output: String(output || '').slice(0, 16000),
    });
  };

  try {
    const t0 = Date.now();
    const st = await fetch(`${butlerBaseUrl}/api/status`, { signal: AbortSignal.timeout(25000) });
    let detail = `HTTP ${st.status}`;
    if (st.ok) {
      try {
        const j = await st.json();
        detail = `HTTP ${st.status}, ${Array.isArray(j?.services) ? j.services.length : 0} services`;
      } catch {
        detail = `HTTP ${st.status}`;
      }
    }
    push('e2e.butler_host.status', st.ok, `${detail} (${Date.now() - t0}ms)`);
  } catch (e) {
    push('e2e.butler_host.status', false, String(e?.message || e));
  }

  try {
    const t0 = Date.now();
    const se = await fetch(`${butlerBaseUrl}/api/settings`, { signal: AbortSignal.timeout(15000) });
    let detail = `HTTP ${se.status}`;
    if (se.ok) {
      try {
        const j = await se.json();
        detail = `HTTP ${se.status}, localOnly=${!!j?.localOnly}`;
      } catch {
        detail = `HTTP ${se.status}`;
      }
    }
    push('e2e.butler_host.settings', se.ok, `${detail} (${Date.now() - t0}ms)`);
  } catch (e) {
    push('e2e.butler_host.settings', false, String(e?.message || e));
  }

  try {
    const t0 = Date.now();
    const k = await fetch(`${knowledgeUrl.replace(/\/$/, '')}/count`, { signal: AbortSignal.timeout(8000) });
    push('e2e.knowledge_api.count', k.ok, `HTTP ${k.status} (${Date.now() - t0}ms)`);
  } catch (e) {
    push('e2e.knowledge_api.count', false, String(e?.message || e));
  }

  const testsDir = path.join(knowledgeRoot, 'tests');
  if (fs.existsSync(testsDir) && pythonExe) {
    const pr = spawnSync(pythonExe, ['-m', 'pytest', 'tests', '-q', '--tb=line'], {
      cwd: knowledgeRoot,
      encoding: 'utf8',
      timeout: 300000,
      env: { ...process.env, BUTLER_OFFLINE_TESTS: process.env.BUTLER_OFFLINE_TESTS || '1' },
    });
    const out = `${pr.stdout || ''}\n${pr.stderr || ''}`.trim();
    push('unit.python.knowledge', pr.status === 0, `exit ${pr.status}`, out);
  } else {
    push(
      'unit.python.knowledge',
      false,
      !fs.existsSync(testsDir) ? 'knowledge/tests missing' : 'python not resolved',
      '',
    );
  }

  if (!packaged && uiRoot && fs.existsSync(path.join(uiRoot, 'package.json'))) {
    const vitestMjs = path.join(uiRoot, 'node_modules', 'vitest', 'vitest.mjs');
    if (fs.existsSync(vitestMjs)) {
      const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
      const vr = spawnSync(nodeBin, [vitestMjs, 'run', '--passWithNoTests'], {
        cwd: uiRoot,
        encoding: 'utf8',
        timeout: 180000,
        env: { ...process.env, CI: '1' },
      });
      const out = `${vr.stdout || ''}\n${vr.stderr || ''}`.trim();
      push('unit.ui.vitest', vr.status === 0, `exit ${vr.status}`, out);
    } else {
      push('unit.ui.vitest', true, 'skipped (npm install in ui/ for Vitest)', '');
    }
  } else {
    push('unit.ui.vitest', true, packaged ? 'skipped in packaged app' : 'skipped (no ui root)', '');
  }

  const ok = results.every((r) => r.ok);
  const passed = results.filter((r) => r.ok).length;
  return {
    ok,
    results,
    summary: `${passed}/${results.length} passed`,
  };
}
