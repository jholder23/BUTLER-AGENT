/**
 * Local agent environment variables (plaintext).
 * Stored under BUTLOR_CONFIG/agent-env.json and overlaid onto process.env
 * for MCP host / ui-server (e.g. CONTEXT7_API_KEY).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { getButlorConfigDirAbs } from './butlor-data-root.mjs';

/** @type {Set<string>} */
let overlayKeys = new Set();

export function getAgentEnvFilePath() {
  return path.join(getButlorConfigDirAbs(), 'agent-env.json');
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function normalizeAgentEnvVars(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k || '').trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const val = v == null ? '' : String(v).trim();
    if (val) out[key] = val;
  }
  return out;
}

/**
 * @returns {Record<string, string>}
 */
export function loadAgentEnvVarsFromDisk() {
  const filePath = getAgentEnvFilePath();
  try {
    if (!existsSync(filePath)) return {};
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.vars && typeof parsed.vars === 'object') {
      return normalizeAgentEnvVars(parsed.vars);
    }
    return normalizeAgentEnvVars(parsed);
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, string>} vars
 */
export function saveAgentEnvVarsToDisk(vars) {
  const normalized = normalizeAgentEnvVars(vars);
  const root = getButlorConfigDirAbs();
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
  } catch {
    /* ignore */
  }
  const filePath = getAgentEnvFilePath();
  writeFileSync(filePath, `${JSON.stringify({ vars: normalized }, null, 2)}\n`, 'utf8');
  return normalized;
}

/**
 * Overlay non-empty agent env onto process.env.
 * Keys removed/emptied since the last apply are deleted from process.env
 * (restart picks .env values back up if present).
 * @param {Record<string, string>} [vars]
 * @returns {Record<string, string>}
 */
export function applyAgentEnvVarsToProcess(vars) {
  const next = normalizeAgentEnvVars(vars ?? loadAgentEnvVarsFromDisk());
  for (const key of overlayKeys) {
    if (!(key in next)) {
      try {
        delete process.env[key];
      } catch {
        /* ignore */
      }
    }
  }
  for (const [key, val] of Object.entries(next)) {
    process.env[key] = val;
  }
  overlayKeys = new Set(Object.keys(next));
  return next;
}

/**
 * Load from disk and apply. Call once at ui-server startup.
 * @returns {Record<string, string>}
 */
export function loadAndApplyAgentEnvVars() {
  return applyAgentEnvVarsToProcess(loadAgentEnvVarsFromDisk());
}
