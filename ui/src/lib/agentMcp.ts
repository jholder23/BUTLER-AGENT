/**
 * MCP server config persistence + connect to Butler ui-server MCP host.
 * Runtime lives in agent-mcp-host.mjs; agent tools mcp_list / mcp_call use the bridge.
 */

import { loadAgentEnvVars, syncAgentEnvVarsToHost } from './agentEnvVars';

export type AgentMcpTransport = 'stdio' | 'sse' | 'http';

export type AgentMcpServerConfig = {
  id: string;
  name: string;
  transport: AgentMcpTransport;
  /** stdio command, or URL for sse/http */
  commandOrUrl: string;
  args: string;
  enabled: boolean;
  status: 'idle' | 'coming_online' | 'connected' | 'error' | 'needs_key';
  lastError?: string;
  description?: string;
  envKey?: string;
  createdAt: number;
  updatedAt: number;
};

export const AGENT_MCP_SERVERS_KEY = 'butler_agent_mcp_servers_v1';
export const AGENT_MCP_SEEDED_KEY = 'butler_agent_mcp_seeded_v1';

/** Client-side fallback defaults (server /api/agent/mcp/defaults is authoritative for keyed flags). */
export const FALLBACK_DEFAULT_MCP_SERVERS: Omit<
  AgentMcpServerConfig,
  'createdAt' | 'updatedAt' | 'status'
>[] = [
  {
    id: 'mcp-context7',
    name: 'Context7 (library docs)',
    transport: 'http',
    commandOrUrl: 'https://mcp.context7.com/mcp',
    args: '',
    enabled: false,
    envKey: 'CONTEXT7_API_KEY',
    description:
      'Up-to-date library docs. Set CONTEXT7_API_KEY in Agent Settings → Environment variables (or .env).',
  },
  {
    id: 'mcp-memory',
    name: 'Memory (knowledge graph)',
    transport: 'stdio',
    commandOrUrl: 'npx',
    args: '-y @modelcontextprotocol/server-memory',
    enabled: true,
    description: 'Persistent entity/relation memory. Optional MEMORY_FILE_PATH in Agent Settings.',
  },
  {
    id: 'mcp-sequential-thinking',
    name: 'Sequential Thinking',
    transport: 'stdio',
    commandOrUrl: 'npx',
    args: '-y @modelcontextprotocol/server-sequential-thinking',
    enabled: true,
    description: 'Free local multi-step reasoning for hard planning before coding.',
  },
];

function parseServers(raw: string | null): AgentMcpServerConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is AgentMcpServerConfig => {
        return (
          !!s &&
          typeof s === 'object' &&
          typeof (s as AgentMcpServerConfig).id === 'string' &&
          typeof (s as AgentMcpServerConfig).name === 'string' &&
          typeof (s as AgentMcpServerConfig).commandOrUrl === 'string'
        );
      })
      .map((s) => ({
        ...s,
        transport: (s.transport === 'sse' || s.transport === 'http' ? s.transport : 'stdio') as AgentMcpTransport,
        args: typeof s.args === 'string' ? s.args : '',
        enabled: !!s.enabled,
        status:
          s.status === 'connected' ||
          s.status === 'error' ||
          s.status === 'coming_online' ||
          s.status === 'needs_key'
            ? s.status
            : 'idle',
        description: typeof s.description === 'string' ? s.description : undefined,
        envKey: typeof s.envKey === 'string' ? s.envKey : undefined,
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function listAgentMcpServers(): AgentMcpServerConfig[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    return parseServers(localStorage.getItem(AGENT_MCP_SERVERS_KEY));
  } catch {
    return [];
  }
}

function writeServers(servers: AgentMcpServerConfig[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(AGENT_MCP_SERVERS_KEY, JSON.stringify(servers));
  } catch {
    /* ignore */
  }
}

export function saveAgentMcpServer(
  input: Omit<AgentMcpServerConfig, 'id' | 'createdAt' | 'updatedAt' | 'status'> & {
    id?: string;
    status?: AgentMcpServerConfig['status'];
    lastError?: string;
  },
): AgentMcpServerConfig {
  const now = Date.now();
  const existing = listAgentMcpServers();
  const id = input.id || `mcp-${now.toString(36)}`;
  const prev = existing.find((s) => s.id === id);
  const next: AgentMcpServerConfig = {
    id,
    name: input.name.trim() || 'Untitled server',
    transport: input.transport,
    commandOrUrl: input.commandOrUrl.trim(),
    args: input.args.trim(),
    enabled: input.enabled,
    status: input.status || prev?.status || 'idle',
    lastError: input.lastError !== undefined ? input.lastError : prev?.lastError,
    description: input.description ?? prev?.description,
    envKey: input.envKey ?? prev?.envKey,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
  };
  const others = existing.filter((s) => s.id !== id);
  writeServers([next, ...others]);
  return next;
}

export function deleteAgentMcpServer(id: string): void {
  writeServers(listAgentMcpServers().filter((s) => s.id !== id));
}

export function setAgentMcpServerEnabled(id: string, enabled: boolean): AgentMcpServerConfig | null {
  const existing = listAgentMcpServers();
  const target = existing.find((s) => s.id === id);
  if (!target) return null;
  return saveAgentMcpServer({ ...target, enabled });
}

export function markAgentMcpComingOnline(): AgentMcpServerConfig[] {
  const next = listAgentMcpServers().map((s) =>
    s.enabled
      ? {
          ...s,
          status: 'coming_online' as const,
          lastError: undefined,
          updatedAt: Date.now(),
        }
      : { ...s, status: 'idle' as const, updatedAt: Date.now() },
  );
  writeServers(next);
  return next;
}

function mergeStatusFromHost(
  local: AgentMcpServerConfig[],
  hostServers: Array<{
    id?: string;
    status?: string;
    lastError?: string;
  }>,
): AgentMcpServerConfig[] {
  const byId = new Map(hostServers.map((s) => [String(s.id || ''), s]));
  const now = Date.now();
  return local.map((s) => {
    const remote = byId.get(s.id);
    if (!remote) {
      return s.enabled ? { ...s, status: 'idle' as const, updatedAt: now } : s;
    }
    const st = remote.status;
    const status: AgentMcpServerConfig['status'] =
      st === 'connected' || st === 'error' || st === 'coming_online' || st === 'needs_key'
        ? st
        : 'idle';
    return {
      ...s,
      status,
      lastError: remote.lastError ? String(remote.lastError) : undefined,
      updatedAt: now,
    };
  });
}

async function fetchDefaultMcpServerDefs(): Promise<typeof FALLBACK_DEFAULT_MCP_SERVERS> {
  let defaults = FALLBACK_DEFAULT_MCP_SERVERS;
  try {
    const res = await fetch('/api/agent/mcp/defaults');
    if (res.ok) {
      const data = (await res.json()) as { servers?: typeof FALLBACK_DEFAULT_MCP_SERVERS };
      if (Array.isArray(data.servers) && data.servers.length) {
        defaults = data.servers.map((s) => ({
          id: String(s.id),
          name: String(s.name),
          transport: (s.transport === 'sse' || s.transport === 'http' ? s.transport : 'stdio') as AgentMcpTransport,
          commandOrUrl: String(s.commandOrUrl || ''),
          args: typeof s.args === 'string' ? s.args : '',
          enabled: !!s.enabled,
          envKey: typeof (s as { envKey?: string }).envKey === 'string' ? (s as { envKey?: string }).envKey : undefined,
          description:
            typeof (s as { description?: string }).description === 'string'
              ? (s as { description?: string }).description
              : undefined,
        }));
      }
    }
  } catch {
    /* use fallback */
  }
  return defaults;
}

/** Seed / merge knowledge MCP defaults (does not overwrite user edits for existing ids). */
export async function ensureDefaultMcpServers(): Promise<AgentMcpServerConfig[]> {
  const existing = listAgentMcpServers();
  let seeded = false;
  try {
    seeded = localStorage.getItem(AGENT_MCP_SEEDED_KEY) === '1';
  } catch {
    /* ignore */
  }

  const defaults = await fetchDefaultMcpServerDefs();
  const now = Date.now();
  const byId = new Map(existing.map((s) => [s.id, s]));
  let changed = false;

  // First-time seed when empty.
  if (existing.length === 0 && !seeded) {
    const next: AgentMcpServerConfig[] = defaults.map((d, i) => ({
      ...d,
      status: 'idle' as const,
      createdAt: now - i,
      updatedAt: now - i,
    }));
    writeServers(next);
    try {
      localStorage.setItem(AGENT_MCP_SEEDED_KEY, '1');
    } catch {
      /* ignore */
    }
    return next;
  }

  // Merge newly introduced defaults (e.g. Sequential Thinking) without clobbering user configs.
  for (const d of defaults) {
    if (byId.has(d.id)) continue;
    byId.set(d.id, {
      ...d,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    });
    changed = true;
  }
  if (changed) {
    const merged = Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    writeServers(merged);
    try {
      localStorage.setItem(AGENT_MCP_SEEDED_KEY, '1');
    } catch {
      /* ignore */
    }
    return merged;
  }

  try {
    localStorage.setItem(AGENT_MCP_SEEDED_KEY, '1');
  } catch {
    /* ignore */
  }
  return existing;
}

/** Connect enabled servers via ui-server MCP host. */
export async function connectAgentMcpServers(): Promise<{
  ok: boolean;
  message: string;
  servers: AgentMcpServerConfig[];
  tools?: Array<{ serverId: string; name: string; description?: string }>;
}> {
  const envVars = loadAgentEnvVars();
  await syncAgentEnvVarsToHost(envVars);

  // Auto-enable Context7 once a key is available locally.
  if (String(envVars.CONTEXT7_API_KEY || '').trim()) {
    const ctx = listAgentMcpServers().find((s) => s.id === 'mcp-context7');
    if (ctx && !ctx.enabled) {
      saveAgentMcpServer({ ...ctx, enabled: true });
    }
  }

  const local = markAgentMcpComingOnline();
  const payload = {
    env: envVars,
    servers: local
      .filter((s) => s.enabled)
      .map((s) => ({
        id: s.id,
        name: s.name,
        transport: s.transport,
        commandOrUrl: s.commandOrUrl,
        args: s.args,
        enabled: true,
        envKey: s.envKey,
      })),
  };

  try {
    const res = await fetch('/api/agent/mcp/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      message?: string;
      servers?: Array<{ id?: string; status?: string; lastError?: string }>;
      tools?: Array<{ serverId: string; name: string; description?: string }>;
      error?: string;
    };
    const merged = mergeStatusFromHost(listAgentMcpServers(), data.servers || []);
    writeServers(merged);
    return {
      ok: Boolean(data.ok),
      message: data.message || data.error || (data.ok ? 'Connected.' : 'Connect failed.'),
      servers: merged,
      tools: data.tools,
    };
  } catch (err) {
    const failed = listAgentMcpServers().map((s) =>
      s.enabled
        ? {
            ...s,
            status: 'error' as const,
            lastError: String((err as Error)?.message || err),
            updatedAt: Date.now(),
          }
        : s,
    );
    writeServers(failed);
    return {
      ok: false,
      message: `MCP host unreachable: ${String((err as Error)?.message || err)}. Is ui-server on :4001?`,
      servers: failed,
    };
  }
}

export async function fetchAgentMcpStatus(): Promise<{
  ok: boolean;
  servers: AgentMcpServerConfig[];
  tools: Array<{ serverId: string; name: string; description?: string }>;
}> {
  try {
    const res = await fetch('/api/agent/mcp/status');
    const data = (await res.json()) as {
      ok?: boolean;
      servers?: Array<{ id?: string; status?: string; lastError?: string }>;
      tools?: Array<{ serverId: string; name: string; description?: string }>;
    };
    const merged = mergeStatusFromHost(listAgentMcpServers(), data.servers || []);
    writeServers(merged);
    return { ok: Boolean(data.ok), servers: merged, tools: data.tools || [] };
  } catch {
    return { ok: false, servers: listAgentMcpServers(), tools: [] };
  }
}
