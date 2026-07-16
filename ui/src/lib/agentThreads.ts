import type { AgentChatMessage } from './agentTypes';

export type SavedAgentThread = {
  id: string;
  title: string;
  savedAt: number;
  cwd: string;
  messages: AgentChatMessage[];
};

export const AGENT_SAVED_THREADS_KEY = 'butler_agent_saved_threads_v1';

const WELCOME_ID = 'welcome';

export function isAgentWelcomeMessage(m: AgentChatMessage): boolean {
  return m.id === WELCOME_ID;
}

export function agentThreadHasContent(messages: AgentChatMessage[]): boolean {
  return messages.some((m) => !isAgentWelcomeMessage(m));
}

export function deriveAgentThreadTitle(messages: AgentChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim());
  if (firstUser) {
    const text = firstUser.content.trim().replace(/\s+/g, ' ');
    return text.length > 56 ? `${text.slice(0, 56)}…` : text;
  }
  const stamp = new Date().toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Agent thread · ${stamp}`;
}

export function agentThreadFingerprint(messages: AgentChatMessage[], cwd: string): string {
  const payload = {
    cwd: cwd.trim(),
    messages: messages
      .filter((m) => !isAgentWelcomeMessage(m))
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        source: m.source,
        steps: m.steps,
        error: m.error,
      })),
  };
  return JSON.stringify(payload);
}

function parseStoredThreads(raw: string | null): SavedAgentThread[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is SavedAgentThread => {
        return (
          !!t &&
          typeof t === 'object' &&
          typeof (t as SavedAgentThread).id === 'string' &&
          typeof (t as SavedAgentThread).title === 'string' &&
          typeof (t as SavedAgentThread).savedAt === 'number' &&
          Array.isArray((t as SavedAgentThread).messages)
        );
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export function listSavedAgentThreads(): SavedAgentThread[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    return parseStoredThreads(localStorage.getItem(AGENT_SAVED_THREADS_KEY));
  } catch {
    return [];
  }
}

function writeSavedAgentThreads(threads: SavedAgentThread[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(AGENT_SAVED_THREADS_KEY, JSON.stringify(threads));
}

export function saveAgentThread(opts: {
  id?: string | null;
  title?: string;
  cwd: string;
  messages: AgentChatMessage[];
}): SavedAgentThread {
  const existing = listSavedAgentThreads();
  const now = Date.now();
  const id =
    opts.id?.trim() ||
    (typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `thread-${now}`);
  const title = opts.title?.trim() || deriveAgentThreadTitle(opts.messages);
  const entry: SavedAgentThread = {
    id,
    title,
    savedAt: now,
    cwd: opts.cwd.trim(),
    messages: opts.messages.map((m) => ({ ...m })),
  };
  const next = [entry, ...existing.filter((t) => t.id !== id)].sort((a, b) => b.savedAt - a.savedAt);
  writeSavedAgentThreads(next);
  return entry;
}

export function deleteSavedAgentThread(id: string): void {
  const trimmed = id.trim();
  if (!trimmed) return;
  const next = listSavedAgentThreads().filter((t) => t.id !== trimmed);
  writeSavedAgentThreads(next);
}

export function renameSavedAgentThread(id: string, title: string): SavedAgentThread | null {
  const trimmed = title.trim();
  if (!trimmed) return null;
  const threads = listSavedAgentThreads();
  const idx = threads.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const updated = { ...threads[idx], title: trimmed };
  threads[idx] = updated;
  writeSavedAgentThreads(threads);
  return updated;
}

export function formatSavedThreadDate(savedAt: number): string {
  return new Date(savedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
