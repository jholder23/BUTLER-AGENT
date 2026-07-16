import type {
  AgentChatMessage,
  AgentCheckpoint,
  AgentRunStatus,
  AgentScanResult,
  AgentTerminalResult,
  AgentToolStep,
  AgentTurnResponse,
} from './agentTypes';
import { fetchAgentEnvVarsFromHost } from './agentEnvVars';
import { AGENT_FREE_PROVIDER_IDS, AGENT_PROVIDERS } from './agentProviders';

export const AGENT_SESSION_ID = 'butler-agent-window';

/** Merge Settings env vars into api_keys so cascade works even if Knowledge missed .env reload. */
async function mergeCascadeApiKeys(
  apiKeys: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...(apiKeys || {}) };
  try {
    const envVars = await fetchAgentEnvVarsFromHost();
    for (const id of AGENT_FREE_PROVIDER_IDS) {
      const meta = AGENT_PROVIDERS.find((p) => p.id === id);
      if (!meta?.envKey) continue;
      const fromEnv = String(envVars[meta.envKey] || '').trim();
      if (!fromEnv) continue;
      if (!String(out[id] || '').trim()) out[id] = fromEnv;
      if (!String(out[meta.envKey] || '').trim()) out[meta.envKey] = fromEnv;
    }
    for (const [k, v] of Object.entries(envVars)) {
      if (!String(out[k] || '').trim() && String(v || '').trim()) out[k] = String(v).trim();
    }
  } catch {
    /* keep caller keys */
  }
  return out;
}

export function defaultAgentProjectRoot(): string {
  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem('butler_agent_cwd');
      if (stored?.trim()) return stored.trim();
    } catch {
      /* ignore */
    }
  }
  return 'D:\\BUTLER';
}

export function persistAgentProjectRoot(cwd: string): void {
  try {
    localStorage.setItem('butler_agent_cwd', cwd.trim());
  } catch {
    /* ignore */
  }
}

export async function openAgentWorkspaceInExplorer(path: string): Promise<void> {
  const p = path.trim();
  if (!p) return;
  const be = window.butlerElectron;
  if (be?.openAgentExplorer) {
    await be.openAgentExplorer(p);
    return;
  }
  await fetch('/api/agent/open-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p }),
  });
}

export async function browseAgentWorkspace(currentPath: string): Promise<string | null> {
  const be = window.butlerElectron;
  if (be?.pickAgentFolder) {
    const r = (await be.pickAgentFolder(currentPath)) as { ok?: boolean; path?: string };
    if (r?.ok && r.path?.trim()) return r.path.trim();
    return null;
  }
  const entered = window.prompt(
    'Select a workspace folder by entering its full path:',
    currentPath || defaultAgentProjectRoot(),
  );
  return entered?.trim() || null;
}

export async function scanAgentWorkspace(cwd: string): Promise<AgentScanResult> {
  const q = new URLSearchParams({
    sessionId: AGENT_SESSION_ID,
    cwd: cwd.trim() || defaultAgentProjectRoot(),
  });
  const res = await fetch(`/api/agent/scan?${q}`);
  return (await res.json().catch(() => ({}))) as AgentScanResult;
}

export async function runAgentTerminalCommand(opts: {
  cwd: string;
  command: string;
  reset?: boolean;
}): Promise<AgentTerminalResult> {
  const res = await fetch('/api/agent/terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: AGENT_SESSION_ID,
      cwd: opts.cwd.trim() || defaultAgentProjectRoot(),
      command: opts.command,
      ...(opts.reset ? { reset: true } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as AgentTerminalResult & { error?: string; message?: string };
  if (!res.ok && !data.command) {
    throw new Error(data.error || data.message || `Terminal request failed (${res.status})`);
  }
  return data;
}

export async function resetAgentTerminal(opts: { cwd: string }): Promise<{
  ok?: boolean;
  shell?: string;
  cwd?: string;
  error?: string;
}> {
  const res = await fetch('/api/agent/terminal/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: AGENT_SESSION_ID,
      cwd: opts.cwd.trim() || defaultAgentProjectRoot(),
    }),
  });
  return (await res.json().catch(() => ({}))) as { ok?: boolean; shell?: string; cwd?: string; error?: string };
}

export async function fetchAgentTerminalInfo(): Promise<{
  ok?: boolean;
  shell?: string;
  shell_path?: string;
  cwd?: string | null;
  alive?: boolean;
}> {
  const res = await fetch(
    `/api/agent/terminal?sessionId=${encodeURIComponent(AGENT_SESSION_ID)}`,
  );
  return (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    shell?: string;
    shell_path?: string;
    cwd?: string | null;
    alive?: boolean;
  };
}

export async function fetchAgentStatus(runId: string): Promise<AgentRunStatus | null> {
  const rid = runId.trim();
  if (!rid) return null;
  const res = await fetch(`/api/agent/status?runId=${encodeURIComponent(rid)}`);
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as AgentRunStatus | null;
}

export async function listAgentCheckpoints(): Promise<AgentCheckpoint[]> {
  const res = await fetch(`/api/agent/checkpoints?sessionId=${encodeURIComponent(AGENT_SESSION_ID)}`);
  const data = (await res.json().catch(() => ({}))) as { checkpoints?: AgentCheckpoint[] };
  return Array.isArray(data.checkpoints) ? data.checkpoints : [];
}

export async function createAgentCheckpoint(opts: {
  cwd: string;
  paths?: string[];
  reason?: string;
}): Promise<{ ok?: boolean; checkpoint_id?: string; error?: string }> {
  const res = await fetch('/api/agent/checkpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: AGENT_SESSION_ID,
      cwd: opts.cwd,
      paths: opts.paths || [],
      reason: opts.reason || 'manual',
    }),
  });
  return (await res.json().catch(() => ({}))) as { ok?: boolean; checkpoint_id?: string; error?: string };
}

export async function revertAgentCheckpoint(checkpointId: string): Promise<{
  ok?: boolean;
  restored?: string[];
  errors?: string[];
  error?: string;
}> {
  const res = await fetch('/api/agent/revert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: AGENT_SESSION_ID,
      checkpointId,
    }),
  });
  return (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    restored?: string[];
    errors?: string[];
    error?: string;
  };
}

export async function sendAgentTurn(
  opts: {
    message: string;
    history: AgentChatMessage[];
    cwd: string;
    localOnly?: boolean;
    runId?: string;
    provider?: string;
    apiKeys?: Record<string, string>;
    continue?: boolean;
  },
  onProgress?: (status: AgentRunStatus) => void,
): Promise<AgentTurnResponse> {
  const history = opts.history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-16)
    .map((m) => ({ role: m.role, content: m.content }));

  const runId =
    opts.runId ||
    (typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `run-${Date.now()}`);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  if (onProgress) {
    onProgress({
      run_id: runId,
      status: 'starting',
      message: opts.continue ? 'Continuing agent…' : 'Starting agent…',
      iteration: 0,
      max_iterations: 16,
      steps: [],
    });
    pollTimer = setInterval(() => {
      void fetchAgentStatus(runId).then((st) => {
        if (st) onProgress(st);
      });
    }, 450);
  }

  try {
    const provider = String(opts.provider || 'local').trim().toLowerCase() || 'local';
    const isCascade = provider === 'auto_free' || provider === 'cascade' || provider === 'auto';
    const localOnly = isCascade ? false : Boolean(opts.localOnly) || provider === 'local';
    const apiKeys =
      isCascade || provider !== 'local' ? await mergeCascadeApiKeys(opts.apiKeys) : opts.apiKeys || {};

    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: AGENT_SESSION_ID,
        message: opts.message,
        history,
        cwd: opts.cwd.trim() || defaultAgentProjectRoot(),
        localOnly,
        runId,
        provider,
        api_keys: apiKeys,
        continue: Boolean(opts.continue),
        resume: Boolean(opts.continue),
      }),
    });

    const data = (await res.json().catch(() => ({}))) as AgentTurnResponse & {
      detail?: string;
      traceback?: string;
      error_type?: string;
      upstream_body?: string;
    };
    const detail = formatAgentFailureDetail(data, res.status);
    const hasReply = Boolean(String(data.reply || '').trim());
    const errTrim = String(data.error || '').trim();
    const msgTrim = String(data.message || '').trim();
    const hasExplicitEmptyError =
      Object.prototype.hasOwnProperty.call(data, 'error') && errTrim === '' && !hasReply;
    const hasErrorField = Boolean(errTrim || msgTrim);

    if (!res.ok || (hasErrorField && !hasReply) || hasExplicitEmptyError) {
      throw new Error(detail);
    }
    if (onProgress) {
      onProgress({
        run_id: runId,
        status: 'done',
        message: data.needs_continue ? 'Paused — Continue available.' : 'Finished.',
        steps: data.agent_steps,
        todos: data.todos,
        reply: data.reply,
        iteration: data.agent_steps?.length || 0,
      });
    }
    return { ...data, run_id: data.run_id || runId };
  } finally {
    if (pollTimer) clearInterval(pollTimer);
  }
}

/** Build a non-empty error message from agent API JSON (never blank / raw empty JSON). */
export function formatAgentFailureDetail(
  data: {
    error?: string;
    message?: string;
    detail?: string;
    traceback?: string;
    error_type?: string;
    upstream_body?: string;
    mode?: string;
    reply?: string;
  },
  status: number,
): string {
  const err = String(data?.error || '').trim();
  const msg = String(data?.message || '').trim();
  const detail = String(data?.detail || '').trim();
  const tb = String(data?.traceback || '').trim();
  const errType = String(data?.error_type || '').trim();
  const upstream = String(data?.upstream_body || '').trim();
  const primary = err || msg || detail;
  // Detect legacy empty payload: {"error":"","mode":"agent"}
  const looksEmptyJson =
    !primary &&
    (data?.mode === 'agent' || Object.prototype.hasOwnProperty.call(data || {}, 'error'));

  const parts: string[] = [];
  if (primary) {
    if (/^Agent failed \(HTTP /i.test(primary)) parts.push(primary);
    else parts.push(`Agent failed (HTTP ${status}${errType ? `, ${errType}` : ''}): ${primary}`);
  } else if (looksEmptyJson) {
    parts.push(
      `Agent failed (HTTP ${status}${errType ? `, ${errType}` : ''}): empty error from Knowledge (often MemoryError / crash mid-tool after a huge payload).`,
    );
  } else {
    parts.push(`Agent failed (HTTP ${status}${errType ? `, ${errType}` : ''}): unknown error`);
  }
  if (detail && detail !== err && detail !== msg) parts.push(`Detail: ${detail}`);
  if (upstream && upstream !== primary && upstream !== detail) {
    parts.push(`Upstream: ${upstream.slice(0, 800)}`);
  }
  if (tb) parts.push(`Traceback:\n${tb.slice(0, 2500)}`);
  return parts.join('\n').trim() || `Agent failed (HTTP ${status})`;
}

/** Unwrap leaked {"final":"..."} JSON so bubbles show plain text. */
export function unwrapAgentReply(text: string): string {
  const raw = (text || '').trim();
  if (!raw) return '';
  if (!(raw.startsWith('{') && raw.includes('"final"'))) return raw;
  try {
    const obj = JSON.parse(raw) as { final?: unknown; tool?: unknown; name?: unknown };
    if (
      obj &&
      typeof obj === 'object' &&
      obj.final != null &&
      !obj.tool &&
      !obj.name
    ) {
      const inner = String(obj.final).trim();
      if (inner) return inner;
    }
  } catch {
    /* ignore */
  }
  const m = raw.match(/"final"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (m?.[1]) {
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
  }
  return raw;
}

/** Heuristic: last assistant reply still promises work that wasn't done. */
export function looksLikeIncompleteAgentReply(
  text: string,
  steps?: AgentToolStep[],
): boolean {
  const t = unwrapAgentReply(text).toLowerCase();
  if (!t) return false;
  const intent =
    /\blet me\b.+\b(make|implement|apply|edit|update|fix|write|create|change|start|do)\b/i.test(
      t,
    ) ||
    /\bi\s*('ll| will| am going to|'m going to)\b.+\b(implement|apply|edit|update|fix|write|create|change|make)\b/i.test(
      t,
    ) ||
    /\b(make|apply|implement)\s+(these\s+)?(updates?|changes?)\s+now\b/i.test(t);
  if (!intent) return false;
  const mutating = new Set(['edit_file', 'write_file', 'run_shell', 'run_command']);
  const didWork = (steps || []).some(
    (s) => s.type === 'tool' && s.tool && mutating.has(String(s.tool).toLowerCase()),
  );
  return !didWork;
}
