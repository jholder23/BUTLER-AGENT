/**
 * Butler Agent MCP runtime host.
 * Spawns/connects MCP servers (stdio / SSE / streamable HTTP) and exposes
 * list/call helpers for ui-server routes and the Python agent bridge.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import path from 'path';
import os from 'os';
import { existsSync, mkdirSync } from 'fs';

/** @typedef {'stdio' | 'sse' | 'http'} McpTransport */
/** @typedef {'idle' | 'coming_online' | 'connected' | 'error' | 'needs_key'} McpStatus */

/**
 * @typedef {object} McpServerConfig
 * @property {string} id
 * @property {string} name
 * @property {McpTransport} transport
 * @property {string} commandOrUrl
 * @property {string} [args]
 * @property {boolean} [enabled]
 * @property {Record<string, string>} [env]
 * @property {Record<string, string>} [headers]
 * @property {string} [envKey] - e.g. CONTEXT7_API_KEY; when set, connect requires process.env[envKey]
 */

/**
 * @typedef {object} McpSession
 * @property {string} id
 * @property {string} name
 * @property {McpTransport} transport
 * @property {McpStatus} status
 * @property {string} [lastError]
 * @property {import('@modelcontextprotocol/sdk/client/index.js').Client} [client]
 * @property {{ close?: () => Promise<void> }} [transportHandle]
 * @property {Array<{ name: string, description?: string, inputSchema?: object }>} tools
 * @property {number} updatedAt
 */

/** @type {Map<string, McpSession>} */
const sessions = new Map();

function splitArgs(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function normalizeStdioLaunch(command, args) {
  const cmd = String(command || '').trim();
  const argv = Array.isArray(args) ? args : [];
  if (process.platform === 'win32' && /^(npx|npm|npx\.cmd|npm\.cmd)$/i.test(cmd)) {
    return { command: 'cmd.exe', args: ['/c', cmd.replace(/\.cmd$/i, ''), ...argv] };
  }
  return { command: cmd, args: argv };
}

function resolveEnvKey(cfg) {
  if (cfg.envKey) return String(cfg.envKey).trim();
  const blob = `${cfg.id || ''} ${cfg.name || ''} ${cfg.commandOrUrl || ''}`.toLowerCase();
  if (blob.includes('context7')) return 'CONTEXT7_API_KEY';
  if (blob.includes('github') && blob.includes('mcp')) return 'GITHUB_PERSONAL_ACCESS_TOKEN';
  return '';
}

function injectKnownEnv(cfg) {
  /** @type {Record<string, string>} */
  const env = { ...(cfg.env || {}) };
  const keyName = resolveEnvKey(cfg);
  if (keyName && process.env[keyName] && !env[keyName]) {
    env[keyName] = String(process.env[keyName]).trim();
  }
  if ((cfg.id === 'mcp-memory' || /server-memory/i.test(cfg.args || '') || /memory/i.test(cfg.name || '')) &&
      process.env.MEMORY_FILE_PATH &&
      !env.MEMORY_FILE_PATH) {
    env.MEMORY_FILE_PATH = String(process.env.MEMORY_FILE_PATH).trim();
  }
  return env;
}

function injectKnownHeaders(cfg) {
  /** @type {Record<string, string>} */
  const headers = { ...(cfg.headers || {}) };
  const keyName = resolveEnvKey(cfg);
  if (keyName && process.env[keyName]) {
    const val = String(process.env[keyName]).trim();
    if (val) {
      if (keyName === 'CONTEXT7_API_KEY') {
        headers.CONTEXT7_API_KEY = val;
      } else if (keyName === 'GITHUB_PERSONAL_ACCESS_TOKEN') {
        headers.Authorization = headers.Authorization || `Bearer ${val}`;
      } else {
        headers[keyName] = val;
      }
    }
  }
  return headers;
}

function requiresKey(cfg) {
  const keyName = resolveEnvKey(cfg);
  return Boolean(keyName);
}

function hasRequiredKey(cfg) {
  const keyName = resolveEnvKey(cfg);
  if (!keyName) return true;
  return Boolean(String(process.env[keyName] || '').trim());
}

function defaultMemoryFilePath() {
  const root = process.env.BUTLOR_CONFIG || path.join(os.homedir(), 'Documents', 'Butlor');
  const dir = path.join(root, 'mcp-memory');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return path.join(dir, 'memory.jsonl');
}

/**
 * Recommended knowledge/docs MCP servers (no Slack/Notion social tools).
 * Context7 stays disabled until CONTEXT7_API_KEY is present.
 * Memory + Sequential Thinking auto-enable (local, no key).
 */
export function getDefaultMcpServerConfigs() {
  const hasContext7 = Boolean(String(process.env.CONTEXT7_API_KEY || '').trim());
  const memoryPath = String(process.env.MEMORY_FILE_PATH || '').trim() || defaultMemoryFilePath();
  return [
    {
      id: 'mcp-context7',
      name: 'Context7 (library docs)',
      transport: 'http',
      commandOrUrl: 'https://mcp.context7.com/mcp',
      args: '',
      enabled: hasContext7,
      envKey: 'CONTEXT7_API_KEY',
      keyed: hasContext7,
      description:
        'Up-to-date library/framework docs. Set CONTEXT7_API_KEY in Agent Settings → Environment variables (or .env). Disabled until keyed.',
    },
    {
      id: 'mcp-memory',
      name: 'Memory (knowledge graph)',
      transport: 'stdio',
      commandOrUrl: 'npx',
      args: '-y @modelcontextprotocol/server-memory',
      enabled: true,
      keyed: true,
      env: { MEMORY_FILE_PATH: memoryPath },
      description:
        'Persistent entity/relation memory for the agent. Optional MEMORY_FILE_PATH in Agent Settings.',
    },
    {
      id: 'mcp-sequential-thinking',
      name: 'Sequential Thinking',
      transport: 'stdio',
      commandOrUrl: 'npx',
      args: '-y @modelcontextprotocol/server-sequential-thinking',
      enabled: true,
      keyed: true,
      description:
        'Free local structured multi-step reasoning. Use for hard planning / decomposition before coding.',
    },
  ];
}

/**
 * @param {McpServerConfig} cfg
 * @returns {Promise<McpSession>}
 */
async function connectOne(cfg) {
  const id = String(cfg.id || '').trim();
  const name = String(cfg.name || id || 'mcp').trim();
  const transportKind = cfg.transport === 'sse' || cfg.transport === 'http' ? cfg.transport : 'stdio';
  const commandOrUrl = String(cfg.commandOrUrl || '').trim();

  /** @type {McpSession} */
  const session = {
    id,
    name,
    transport: transportKind,
    status: 'coming_online',
    tools: [],
    updatedAt: Date.now(),
  };

  if (!id || !commandOrUrl) {
    session.status = 'error';
    session.lastError = 'id and commandOrUrl are required';
    return session;
  }

  if (requiresKey(cfg) && !hasRequiredKey(cfg)) {
    session.status = 'needs_key';
    session.lastError = `Missing ${resolveEnvKey(cfg)} — set it in Agent Settings → Environment variables (or .env), then reconnect MCP.`;
    return session;
  }

  await disconnectOne(id);

  try {
    const client = new Client({ name: 'butler-agent-mcp', version: '0.1.0' });
    let transportHandle;

    if (transportKind === 'stdio') {
      const argv = splitArgs(cfg.args);
      const launch = normalizeStdioLaunch(commandOrUrl, argv);
      const env = {
        ...getDefaultEnvironment(),
        ...injectKnownEnv(cfg),
      };
      const transport = new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        env,
        stderr: 'pipe',
        cwd: process.cwd(),
      });
      transportHandle = transport;
      await client.connect(transport);
    } else {
      const url = new URL(commandOrUrl);
      const headers = injectKnownHeaders(cfg);
      const requestInit = Object.keys(headers).length ? { headers } : undefined;
      if (transportKind === 'sse') {
        const transport = new SSEClientTransport(url, { requestInit });
        transportHandle = transport;
        await client.connect(transport);
      } else {
        const transport = new StreamableHTTPClientTransport(url, { requestInit });
        transportHandle = transport;
        await client.connect(transport);
      }
    }

    const listed = await client.listTools();
    const tools = Array.isArray(listed?.tools)
      ? listed.tools.map((t) => ({
          name: String(t.name || ''),
          description: t.description ? String(t.description) : undefined,
          inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : undefined,
        }))
      : [];

    session.client = client;
    session.transportHandle = transportHandle;
    session.tools = tools.filter((t) => t.name);
    session.status = 'connected';
    session.lastError = undefined;
    session.updatedAt = Date.now();
    sessions.set(id, session);
    return session;
  } catch (err) {
    session.status = 'error';
    session.lastError = String(err?.message || err).slice(0, 500);
    session.updatedAt = Date.now();
    sessions.set(id, session);
    return session;
  }
}

async function disconnectOne(id) {
  const prev = sessions.get(id);
  if (!prev) return;
  try {
    await prev.client?.close?.();
  } catch {
    /* ignore */
  }
  try {
    await prev.transportHandle?.close?.();
  } catch {
    /* ignore */
  }
  sessions.delete(id);
}

/**
 * @param {McpServerConfig[]} configs
 */
export async function connectMcpServers(configs) {
  const list = Array.isArray(configs) ? configs : [];
  const enabled = list.filter((c) => c && c.enabled !== false);
  const results = [];
  for (const cfg of enabled) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await connectOne(cfg));
  }
  // Drop sessions that were not in this connect batch (disabled / removed)
  const keep = new Set(enabled.map((c) => String(c.id || '')));
  for (const id of [...sessions.keys()]) {
    if (!keep.has(id)) {
      // eslint-disable-next-line no-await-in-loop
      await disconnectOne(id);
    }
  }
  const connected = results.filter((r) => r.status === 'connected').length;
  const needsKey = results.filter((r) => r.status === 'needs_key').length;
  const errors = results.filter((r) => r.status === 'error').length;
  return {
    ok: connected > 0 || (enabled.length === 0 && errors === 0 && needsKey === 0),
    connected,
    needs_key: needsKey,
    errors,
    servers: results.map(publicSession),
    tools: listConnectedTools(),
    message: summarizeConnect(connected, needsKey, errors, enabled.length),
  };
}

function summarizeConnect(connected, needsKey, errors, attempted) {
  if (attempted === 0) return 'No enabled MCP servers to connect.';
  const parts = [];
  if (connected) parts.push(`${connected} connected`);
  if (needsKey) parts.push(`${needsKey} waiting for API key`);
  if (errors) parts.push(`${errors} failed`);
  return parts.join('; ') || 'Connect finished.';
}

function publicSession(s) {
  return {
    id: s.id,
    name: s.name,
    transport: s.transport,
    status: s.status,
    lastError: s.lastError,
    toolCount: Array.isArray(s.tools) ? s.tools.length : 0,
    updatedAt: s.updatedAt,
  };
}

export function getMcpStatus() {
  const servers = [...sessions.values()].map(publicSession);
  return {
    ok: true,
    servers,
    tools: listConnectedTools(),
    connected: servers.filter((s) => s.status === 'connected').length,
  };
}

export function listConnectedTools() {
  /** @type {Array<{ serverId: string, serverName: string, name: string, description?: string, inputSchema?: object }>} */
  const out = [];
  for (const s of sessions.values()) {
    if (s.status !== 'connected') continue;
    for (const t of s.tools || []) {
      out.push({
        serverId: s.id,
        serverName: s.name,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      });
    }
  }
  return out;
}

/**
 * @param {string} serverId
 * @param {string} toolName
 * @param {Record<string, unknown>} [args]
 */
export async function callMcpTool(serverId, toolName, args = {}) {
  const sid = String(serverId || '').trim();
  const name = String(toolName || '').trim();
  if (!sid || !name) {
    return { ok: false, error: 'serverId and tool are required' };
  }
  const session = sessions.get(sid);
  if (!session || session.status !== 'connected' || !session.client) {
    return { ok: false, error: `MCP server not connected: ${sid || '(missing id)'}` };
  }
  try {
    const result = await session.client.callTool({
      name,
      arguments: args && typeof args === 'object' ? args : {},
    });
    return {
      ok: !result?.isError,
      serverId: sid,
      tool: name,
      isError: Boolean(result?.isError),
      content: result?.content ?? [],
      structuredContent: result?.structuredContent,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 800), serverId: sid, tool: name };
  }
}

export async function disconnectAllMcpServers() {
  const ids = [...sessions.keys()];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await disconnectOne(id);
  }
  return { ok: true, disconnected: ids.length };
}
