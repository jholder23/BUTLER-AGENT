/**
 * Agent environment variables — local plaintext (localStorage + Butlor agent-env.json).
 * Used for MCP keys (CONTEXT7_API_KEY) and other agent/runtime env without editing .env.
 */

export type AgentEnvVarRow = {
  id: string;
  key: string;
  value: string;
};

export const AGENT_ENV_VARS_STORAGE_KEY = 'butler_agent_env_vars_v1';

/** Suggested keys shown as empty rows when nothing is stored yet. */
export const AGENT_ENV_VAR_HINTS: Array<{ key: string; hint: string }> = [
  {
    key: 'CONTEXT7_API_KEY',
    hint: 'Context7 library docs MCP — free API key from context7.com/dashboard',
  },
  {
    key: 'MEMORY_FILE_PATH',
    hint: 'Optional path for MCP memory JSONL (default under Butlor config)',
  },
  {
    key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    hint: 'GitHub MCP if you add a GitHub server',
  },
  {
    key: 'LOCAL_AGENT_MODEL',
    hint: 'Ollama / local model name for agent cascade fallback',
  },
];

function newRowId(): string {
  return `env-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function rowsFromRecord(vars: Record<string, string>): AgentEnvVarRow[] {
  const entries = Object.entries(vars || {}).filter(([k]) => String(k || '').trim());
  if (entries.length === 0) {
    return AGENT_ENV_VAR_HINTS.map((h) => ({
      id: newRowId(),
      key: h.key,
      value: '',
    }));
  }
  const known = new Set(entries.map(([k]) => k));
  const rows: AgentEnvVarRow[] = entries.map(([key, value]) => ({
    id: newRowId(),
    key,
    value: String(value ?? ''),
  }));
  for (const h of AGENT_ENV_VAR_HINTS) {
    if (!known.has(h.key)) {
      rows.push({ id: newRowId(), key: h.key, value: '' });
    }
  }
  return rows;
}

export function recordFromRows(rows: AgentEnvVarRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = String(row.key || '').trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = String(row.value ?? '').trim();
    if (value) out[key] = value;
  }
  return out;
}

export function loadAgentEnvVars(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(AGENT_ENV_VARS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const key = String(k || '').trim();
      if (!key) continue;
      const val = v == null ? '' : String(v).trim();
      if (val) out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
}

export function persistAgentEnvVars(vars: Record<string, string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(AGENT_ENV_VARS_STORAGE_KEY, JSON.stringify(vars));
  } catch {
    /* ignore */
  }
}

/** Push localStorage vars to ui-server (Butlor agent-env.json + process.env). */
export async function syncAgentEnvVarsToHost(
  vars?: Record<string, string>,
): Promise<{ ok: boolean; vars: Record<string, string>; message?: string }> {
  const payload = vars ?? loadAgentEnvVars();
  persistAgentEnvVars(payload);
  try {
    const res = await fetch('/api/agent/env', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vars: payload }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      vars?: Record<string, string>;
      error?: string;
      message?: string;
    };
    if (data.vars && typeof data.vars === 'object') {
      persistAgentEnvVars(data.vars);
    }
    return {
      ok: Boolean(data.ok),
      vars: data.vars && typeof data.vars === 'object' ? data.vars : payload,
      message: data.message || data.error,
    };
  } catch (err) {
    return {
      ok: false,
      vars: payload,
      message: String((err as Error)?.message || err),
    };
  }
}

export async function fetchAgentEnvVarsFromHost(): Promise<Record<string, string>> {
  try {
    const res = await fetch('/api/agent/env');
    if (!res.ok) return loadAgentEnvVars();
    const data = (await res.json()) as { vars?: Record<string, string> };
    if (data.vars && typeof data.vars === 'object') {
      const local = loadAgentEnvVars();
      const merged = { ...data.vars, ...local };
      persistAgentEnvVars(merged);
      return merged;
    }
  } catch {
    /* ignore */
  }
  return loadAgentEnvVars();
}

export function hintForEnvKey(key: string): string | undefined {
  const k = String(key || '').trim();
  return AGENT_ENV_VAR_HINTS.find((h) => h.key === k)?.hint;
}
