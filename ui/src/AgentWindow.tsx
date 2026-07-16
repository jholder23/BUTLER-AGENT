import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ChatBubbleRichText } from './components/ChatBubbleRichText';
import { AgentSettingsPanel } from './components/AgentSettingsPanel';
import { AgentSidebar } from './components/AgentSidebar';
import { AgentBottomPanel, type AgentFooterTab, type TerminalEntry } from './components/AgentBottomPanel';
import { AgentMcpPanel } from './components/AgentMcpPanel';
import { AgentUtilityPanel, useAgentSecretChord } from './components/AgentUtilityPanel';
import {
  AgentFileDiffModal,
  AgentFileDiffStrip,
  collectAgentFileChanges,
  type AgentFileChange,
} from './components/AgentFileDiff';
import {
  browseAgentWorkspace,
  createAgentCheckpoint,
  defaultAgentProjectRoot,
  fetchAgentTerminalInfo,
  listAgentCheckpoints,
  looksLikeIncompleteAgentReply,
  openAgentWorkspaceInExplorer,
  persistAgentProjectRoot,
  resetAgentTerminal,
  runAgentTerminalCommand,
  revertAgentCheckpoint,
  scanAgentWorkspace,
  sendAgentTurn,
  unwrapAgentReply,
} from './lib/agentApi';
import {
  agentThreadFingerprint,
  agentThreadHasContent,
  deleteSavedAgentThread,
  listSavedAgentThreads,
  renameSavedAgentThread,
  saveAgentThread,
  type SavedAgentThread,
} from './lib/agentThreads';
import {
  AGENT_PROVIDERS,
  loadAgentApiKeys,
  loadAgentProvider,
  loadCascadeEnabled,
  persistAgentApiKeys,
  persistAgentProvider,
  persistCascadeEnabled,
  resolveSendProvider,
  type AgentProviderId,
} from './lib/agentProviders';
import { listAgentMcpServers } from './lib/agentMcp';
import {
  fetchAgentEnvVarsFromHost,
  loadAgentEnvVars,
  persistAgentEnvVars,
  recordFromRows,
  rowsFromRecord,
  syncAgentEnvVarsToHost,
  type AgentEnvVarRow,
} from './lib/agentEnvVars';
import { loadAgentTheme, persistAgentTheme, type AgentThemePrefs } from './lib/agentTheme';
import { startPcmRecording, transcribePcmViaButler } from './lib/speechToText';
import type {
  AgentChatMessage,
  AgentCheckpoint,
  AgentRunStatus,
  AgentTodo,
  AgentToolStep,
} from './lib/agentTypes';

const AGENT_SIDEBAR_WIDTH_KEY = 'butler-agent-sidebar-width';
const AGENT_SIDEBAR_OPEN_KEY = 'butler-agent-sidebar-open';
const AGENT_FOOTER_OPEN_KEY = 'butler-agent-footer-open';
const AGENT_FOOTER_TAB_KEY = 'butler-agent-footer-tab';
const AGENT_FOOTER_HEIGHT_KEY = 'butler-agent-footer-height';
const AGENT_BROWSER_MAXIMIZED_KEY = 'butler-agent-browser-maximized';
const AGENT_SIDEBAR_MIN_PX = 220;
const AGENT_SIDEBAR_MAX_PX = 440;
const AGENT_FOOTER_MIN_PX = 160;
const AGENT_FOOTER_MAX_PX = 720;
const AGENT_FOOTER_DEFAULT_PX = 360;
const AGENT_FOOTER_BROWSER_DEFAULT_PX = 420;
const AGENT_CHAT_STICK_PX = 80;

const AGENT_PRODUCT_MODE_KEY = 'butler-agent-product-mode';

type AgentProductMode = 'chat' | 'code';

function readProductMode(): AgentProductMode {
  try {
    const v = localStorage.getItem(AGENT_PRODUCT_MODE_KEY);
    if (v === 'chat' || v === 'code') return v;
  } catch {
    /* ignore */
  }
  return 'code';
}

const WELCOME_MESSAGE: AgentChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content:
    'Butler **Agent** — switch **Chat** (conversation) or **Code** (tools) above. Same thread either way.',
  source: 'Butler',
};

function formatStepTitle(step: AgentToolStep): string {
  if (step.activity) return step.activity;
  if (step.type === 'continue') return `Continuing — ${step.summary?.slice(0, 80) || 'more work'}`;
  if (step.type === 'final') return `Done — ${step.summary?.slice(0, 80) || 'summary'}`;
  const tool = step.tool || 'tool';
  const iter = step.iteration != null ? `#${step.iteration}` : '';
  const elapsed = step.elapsed_sec != null ? ` · ${step.elapsed_sec}s` : '';
  return `${tool}${iter}${elapsed}`;
}

function todoStatusIcon(status: AgentTodo['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '●';
  if (status === 'cancelled') return '–';
  return '○';
}

function AgentTodoList({
  todos,
  floating,
  compact,
}: {
  todos: AgentTodo[];
  floating?: boolean;
  compact?: boolean;
}) {
  if (!todos.length) return null;
  return (
    <div
      className={`agent-todo-panel${floating ? ' agent-todo-panel--float' : ''}${
        compact ? ' agent-todo-panel--compact' : ''
      }`}
      role="list"
      aria-label="Agent plan"
    >
      <div className="agent-todo-panel-head">{floating ? 'Plan' : 'Completed plan'}</div>
      <ul className="agent-todo-list">
        {todos.map((t) => (
          <li
            key={t.id}
            className={`agent-todo-item agent-todo-item--${t.status}`}
            role="listitem"
          >
            <span className="agent-todo-check" aria-hidden>
              {todoStatusIcon(t.status)}
            </span>
            <span className="agent-todo-text">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentStepBlock({
  step,
  defaultOpen,
  inProgress,
  onOpenDiff,
}: {
  step: AgentToolStep;
  defaultOpen?: boolean;
  inProgress?: boolean;
  onOpenDiff?: (change: AgentFileChange) => void;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const result = step.result;
  const stdout =
    result && typeof result.stdout === 'string' && result.stdout.trim() ? result.stdout : '';
  const stderr =
    result && typeof result.stderr === 'string' && result.stderr.trim() ? result.stderr : '';
  const content =
    result && typeof result.content === 'string' && result.content.trim() ? result.content : '';
  const entries =
    result && Array.isArray(result.entries)
      ? (result.entries as Array<{ name?: string; type?: string }>)
      : null;
  const files =
    result && Array.isArray(result.files) ? (result.files as Array<{ path?: string }>) : null;
  const matches =
    result && Array.isArray(result.matches)
      ? (result.matches as Array<{ file?: string; line?: number; text?: string }>)
      : null;
  const fileChanges = collectAgentFileChanges([step]);
  const primaryChange = fileChanges[0];

  return (
    <div
      className={`agent-step agent-step--${step.type}${inProgress ? ' agent-step--active' : ''}${
        step.in_progress ? ' agent-step--pending' : ''
      }`}
    >
      <button
        type="button"
        className="agent-step-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="agent-step-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        {inProgress || step.in_progress ? (
          <span className="agent-step-spinner" aria-hidden />
        ) : null}
        <span className="agent-step-title">{formatStepTitle(step)}</span>
        {primaryChange ? (
          <span className="agent-step-badge agent-step-badge--diff">diff</span>
        ) : null}
        {inProgress || step.in_progress ? (
          <span className="agent-step-badge agent-step-badge--busy">running</span>
        ) : null}
        {!inProgress && result?.ok === false ? (
          <span className="agent-step-badge agent-step-badge--err">failed</span>
        ) : null}
        {!inProgress && result?.ok === true ? (
          <span className="agent-step-badge agent-step-badge--ok">ok</span>
        ) : null}
      </button>
      {open ? (
        <div className="agent-step-body">
          {primaryChange && onOpenDiff ? (
            <button
              type="button"
              className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
              onClick={() => onOpenDiff(primaryChange)}
            >
              View diff
            </button>
          ) : null}
          {step.args && Object.keys(step.args).length > 0 ? (
            <pre className="agent-step-pre">{JSON.stringify(step.args, null, 2)}</pre>
          ) : null}
          {stdout ? (
            <div className="agent-step-output">
              <div className="agent-step-output-label">stdout</div>
              <pre className="agent-step-pre">{stdout}</pre>
            </div>
          ) : null}
          {stderr ? (
            <div className="agent-step-output">
              <div className="agent-step-output-label">stderr</div>
              <pre className="agent-step-pre agent-step-pre--stderr">{stderr}</pre>
            </div>
          ) : null}
          {content ? (
            <div className="agent-step-output">
              <div className="agent-step-output-label">file</div>
              <pre className="agent-step-pre">{content}</pre>
            </div>
          ) : null}
          {entries ? (
            <ul className="agent-step-dirlist">
              {entries.slice(0, 60).map((e, i) => (
                <li key={`${e.name}-${i}`}>
                  <span className="agent-step-dir-type">{e.type === 'dir' ? '📁' : '📄'}</span> {e.name}
                </li>
              ))}
            </ul>
          ) : null}
          {files ? (
            <ul className="agent-step-dirlist">
              {files.slice(0, 40).map((f, i) => (
                <li key={`${f.path}-${i}`}>{f.path}</li>
              ))}
            </ul>
          ) : null}
          {matches ? (
            <ul className="agent-step-dirlist">
              {matches.slice(0, 30).map((m, i) => (
                <li key={`${m.file}-${m.line}-${i}`}>
                  <code>
                    {m.file}:{m.line}
                  </code>{' '}
                  {m.text}
                </li>
              ))}
            </ul>
          ) : null}
          {result && !stdout && !stderr && !content && !entries && !files && !matches ? (
            <pre className="agent-step-pre">{JSON.stringify(result, null, 2)}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function confirmDiscardUnsaved(): boolean {
  return window.confirm(
    'You have unsaved changes in the current thread. Discard them and continue?',
  );
}

function clampSize(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function readStoredAgentSize(key: string, min: number, max: number): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === '') return null;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    return clampSize(parsed, min, max);
  } catch {
    return null;
  }
}

function readStoredAgentBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === '') return fallback;
    return raw === '1' || raw === 'true';
  } catch {
    return fallback;
  }
}

function readStoredFooterTab(): AgentFooterTab {
  if (typeof window === 'undefined') return 'terminal';
  try {
    const raw = localStorage.getItem(AGENT_FOOTER_TAB_KEY);
    if (raw === 'terminal' || raw === 'browser' || raw === 'output') return raw;
    // Legacy tabs collapsed into Settings
    if (raw === 'workspace' || raw === 'llm' || raw === 'checkpoints') return 'terminal';
  } catch {
    /* ignore */
  }
  return 'terminal';
}

type AgentWindowProps = {
  embedded?: boolean;
  splitView?: boolean;
  standalone?: boolean;
  onBack?: () => void;
  onEnterSplit?: () => void;
  onExitSplit?: () => void;
  onPopOut?: () => void;
  onPopIn?: () => void;
};

export function AgentWindow({
  embedded = false,
  splitView = false,
  standalone = false,
  onBack,
  onEnterSplit,
  onExitSplit,
  onPopOut,
  onPopIn,
}: AgentWindowProps = {}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [messages, setMessages] = useState<AgentChatMessage[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [cwd, setCwd] = useState(defaultAgentProjectRoot);
  const [sending, setSending] = useState(false);
  const [runStatus, setRunStatus] = useState<AgentRunStatus | null>(null);
  const [liveSteps, setLiveSteps] = useState<AgentToolStep[]>([]);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [scanSummary, setScanSummary] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<AgentCheckpoint[]>([]);
  const [checkpointBusy, setCheckpointBusy] = useState(false);
  const [savedThreads, setSavedThreads] = useState<SavedAgentThread[]>(() => listSavedAgentThreads());
  const [loadedThreadId, setLoadedThreadId] = useState<string | null>(null);
  const [savedFingerprint, setSavedFingerprint] = useState(() =>
    agentThreadFingerprint([WELCOME_MESSAGE], defaultAgentProjectRoot()),
  );
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleValue, setEditingTitleValue] = useState('');
  const [agentProvider, setAgentProvider] = useState<AgentProviderId>(() => loadAgentProvider());
  const [cascadeEnabled, setCascadeEnabled] = useState<boolean>(() => loadCascadeEnabled());
  const [apiKeys, setApiKeys] = useState<Record<string, string>>(() => loadAgentApiKeys());
  const [envVarRows, setEnvVarRows] = useState<AgentEnvVarRow[]>(() => rowsFromRecord(loadAgentEnvVars()));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [productMode, setProductMode] = useState<AgentProductMode>(() => readProductMode());
  const [chatSessionId] = useState(
    () => `butler-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const [mcpCount, setMcpCount] = useState(() => listAgentMcpServers().length);
  const [theme, setTheme] = useState<AgentThemePrefs>(() => loadAgentTheme());
  const [threadSearch, setThreadSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeModelLabel, setActiveModelLabel] = useState<string | null>(null);
  const [sidebarWidthPx, setSidebarWidthPx] = useState<number | null>(() =>
    readStoredAgentSize(AGENT_SIDEBAR_WIDTH_KEY, AGENT_SIDEBAR_MIN_PX, AGENT_SIDEBAR_MAX_PX),
  );
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => readStoredAgentBool(AGENT_SIDEBAR_OPEN_KEY, true));
  const [footerOpen, setFooterOpen] = useState<boolean>(() => readStoredAgentBool(AGENT_FOOTER_OPEN_KEY, false));
  const [footerTab, setFooterTab] = useState<AgentFooterTab>(() => readStoredFooterTab());
  const [browserMaximized, setBrowserMaximized] = useState<boolean>(() =>
    readStoredAgentBool(AGENT_BROWSER_MAXIMIZED_KEY, false),
  );
  const [footerHeightPx, setFooterHeightPx] = useState<number>(() => {
    const stored = readStoredAgentSize(AGENT_FOOTER_HEIGHT_KEY, AGENT_FOOTER_MIN_PX, AGENT_FOOTER_MAX_PX);
    if (stored != null) return stored;
    return readStoredFooterTab() === 'browser' ? AGENT_FOOTER_BROWSER_DEFAULT_PX : AGENT_FOOTER_DEFAULT_PX;
  });
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([]);
  const [terminalSessionCwd, setTerminalSessionCwd] = useState(() => defaultAgentProjectRoot());
  const [terminalShellLabel, setTerminalShellLabel] = useState('pwsh');
  const [activeDiff, setActiveDiff] = useState<AgentFileChange | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [liveTodos, setLiveTodos] = useState<AgentTodo[]>([]);
  const cancelledMessageRef = useRef<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const stickChatToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const speechCaptureRef = useRef<{
    stop: () => Promise<{ pcm: ArrayBuffer; sampleRate: number }>;
    stream?: MediaStream;
  } | null>(null);
  const [speechState, setSpeechState] = useState<'idle' | 'listening' | 'transcribing'>('idle');
  const [speechError, setSpeechError] = useState<string | null>(null);

  const currentFingerprint = useMemo(
    () => agentThreadFingerprint(messages, cwd),
    [messages, cwd],
  );
  const isDirty = currentFingerprint !== savedFingerprint;

  const selectedProviderMeta = useMemo(() => {
    const sendId = resolveSendProvider(cascadeEnabled, agentProvider);
    return AGENT_PROVIDERS.find((p) => p.id === sendId) ?? AGENT_PROVIDERS[0];
  }, [agentProvider, cascadeEnabled]);

  const showContinue = useMemo(() => {
    if (productMode !== 'code' || sending) return false;
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.id !== 'welcome');
    if (!last || last.error) return false;
    if (last.needsContinue) return true;
    return looksLikeIncompleteAgentReply(last.content, last.steps);
  }, [messages, sending, productMode]);

  const handleProviderChange = useCallback((next: AgentProviderId) => {
    setAgentProvider(next);
    persistAgentProvider(next);
    if (next === 'auto_free') {
      setCascadeEnabled(true);
      persistCascadeEnabled(true);
    }
  }, []);

  const handleCascadeChange = useCallback(
    (on: boolean) => {
      setCascadeEnabled(on);
      persistCascadeEnabled(on);
      if (on) {
        setAgentProvider('auto_free');
        persistAgentProvider('auto_free');
      } else if (agentProvider === 'auto_free') {
        setAgentProvider('local');
        persistAgentProvider('local');
      }
    },
    [agentProvider],
  );

  const handleApiKeyChange = useCallback((providerId: string, value: string) => {
    setApiKeys((prev) => {
      const next = { ...prev, [providerId]: value };
      persistAgentApiKeys(next);
      return next;
    });
  }, []);

  const handleEnvVarRowsChange = useCallback((rows: AgentEnvVarRow[]) => {
    setEnvVarRows(rows);
    const record = recordFromRows(rows);
    persistAgentEnvVars(record);
  }, []);

  const refreshSavedThreads = useCallback(() => {
    setSavedThreads(listSavedAgentThreads());
  }, []);

  const refreshCheckpoints = useCallback(async () => {
    try {
      const list = await listAgentCheckpoints();
      setCheckpoints(list);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!embedded) document.documentElement.classList.add('butler-agent-root');
    void refreshCheckpoints();
    void (async () => {
      const vars = await fetchAgentEnvVarsFromHost();
      setEnvVarRows(rowsFromRecord(vars));
      await syncAgentEnvVarsToHost(vars);
    })();
    return () => {
      if (!embedded) document.documentElement.classList.remove('butler-agent-root');
    };
  }, [embedded, refreshCheckpoints]);

  useEffect(() => {
    if (!settingsOpen) return;
    const record = recordFromRows(envVarRows);
    const timer = window.setTimeout(() => {
      void syncAgentEnvVarsToHost(record);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [envVarRows, settingsOpen]);

  const onThreadScroll = useCallback(() => {
    const el = threadScrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickChatToBottomRef.current = dist < AGENT_CHAT_STICK_PX;
  }, []);

  useEffect(() => {
    if (!stickChatToBottomRef.current) return;
    const el = threadScrollRef.current;
    if (!el) return;
    // Instant jump avoids smooth-scroll thrash while tokens stream
    el.scrollTop = el.scrollHeight;
  }, [messages, sending, liveSteps, liveTodos, runStatus]);

  useEffect(() => {
    return () => {
      const capture = speechCaptureRef.current;
      speechCaptureRef.current = null;
      capture?.stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    try {
      if (sidebarWidthPx == null) localStorage.removeItem(AGENT_SIDEBAR_WIDTH_KEY);
      else localStorage.setItem(AGENT_SIDEBAR_WIDTH_KEY, String(sidebarWidthPx));
    } catch {
      /* ignore */
    }
  }, [sidebarWidthPx]);

  useEffect(() => {
    try {
      localStorage.setItem(AGENT_FOOTER_HEIGHT_KEY, String(footerHeightPx));
    } catch {
      /* ignore */
    }
  }, [footerHeightPx]);

  useEffect(() => {
    try {
      localStorage.setItem(AGENT_SIDEBAR_OPEN_KEY, sidebarOpen ? '1' : '0');
      localStorage.setItem(AGENT_FOOTER_OPEN_KEY, footerOpen ? '1' : '0');
      localStorage.setItem(AGENT_FOOTER_TAB_KEY, footerTab);
      localStorage.setItem(AGENT_BROWSER_MAXIMIZED_KEY, browserMaximized ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [sidebarOpen, footerOpen, footerTab, browserMaximized]);

  useEffect(() => {
    persistAgentTheme(theme);
  }, [theme]);

  useEffect(() => {
    const onResize = () => {
      setSidebarWidthPx((prev) =>
        prev == null ? null : clampSize(prev, AGENT_SIDEBAR_MIN_PX, AGENT_SIDEBAR_MAX_PX),
      );
      const rootH = rootRef.current?.getBoundingClientRect().height ?? window.innerHeight;
      const maxFooter = Math.min(AGENT_FOOTER_MAX_PX, Math.max(AGENT_FOOTER_MIN_PX, rootH - 220));
      setFooterHeightPx((prev) => clampSize(prev, AGENT_FOOTER_MIN_PX, maxFooter));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const applyWorkspace = useCallback(
    async (nextPath: string, openExplorer = false) => {
      const trimmed = nextPath.trim();
      if (!trimmed) return;
      setCwd(trimmed);
      persistAgentProjectRoot(trimmed);
      if (openExplorer) await openAgentWorkspaceInExplorer(trimmed);
      try {
        const scan = await scanAgentWorkspace(trimmed);
        if (scan.ok) {
          const names = (scan.key_files || []).map((f) => f.name).join(', ');
          const dirs = (scan.top_dirs || []).slice(0, 8).join(', ');
          setScanSummary(
            names || dirs
              ? `Detected: ${names || 'no key files'}${dirs ? ` · dirs: ${dirs}` : ''}`
              : 'Workspace set (empty or no standard project files).',
          );
        }
      } catch {
        setScanSummary(null);
      }
      void refreshCheckpoints();
    },
    [refreshCheckpoints],
  );

  const restoreThreadState = useCallback(
    (thread: SavedAgentThread) => {
      const nextMessages =
        thread.messages.length > 0 ? thread.messages.map((m) => ({ ...m })) : [WELCOME_MESSAGE];
      const nextCwd = thread.cwd?.trim() || defaultAgentProjectRoot();
      setMessages(nextMessages);
      setCwd(nextCwd);
      persistAgentProjectRoot(nextCwd);
      setLoadedThreadId(thread.id);
      setSavedFingerprint(agentThreadFingerprint(nextMessages, nextCwd));
      setLiveSteps([]);
      setRunStatus(null);
      setInput('');
      void applyWorkspace(nextCwd, false);
    },
    [applyWorkspace],
  );

  const resetToNewThread = useCallback(() => {
    const nextCwd = cwd.trim() || defaultAgentProjectRoot();
    setMessages([WELCOME_MESSAGE]);
    setLiveSteps([]);
    setRunStatus(null);
    setInput('');
    setLoadedThreadId(null);
    setSavedFingerprint(agentThreadFingerprint([WELCOME_MESSAGE], nextCwd));
  }, [cwd]);

  const handleBrowse = useCallback(async () => {
    const picked = await browseAgentWorkspace(cwd);
    if (picked) await applyWorkspace(picked, false);
  }, [applyWorkspace, cwd]);

  const openFooterTab = useCallback((tab: AgentFooterTab) => {
    setFooterTab(tab);
    setFooterOpen(true);
    if (tab === 'browser') {
      setFooterHeightPx((prev) =>
        prev < AGENT_FOOTER_BROWSER_DEFAULT_PX ? AGENT_FOOTER_BROWSER_DEFAULT_PX : prev,
      );
    }
  }, []);

  const toggleBrowserMaximized = useCallback(() => {
    setBrowserMaximized((prev) => {
      const next = !prev;
      if (next) {
        setFooterTab('browser');
        setFooterOpen(true);
        setFooterHeightPx((current) =>
          current < AGENT_FOOTER_BROWSER_DEFAULT_PX ? AGENT_FOOTER_BROWSER_DEFAULT_PX : current,
        );
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!browserMaximized) return;
    setFooterTab('browser');
    setFooterOpen(true);
  }, [browserMaximized]);

  useEffect(() => {
    if (!browserMaximized) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setBrowserMaximized(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [browserMaximized]);

  const handleThemeChange = useCallback((prefs: AgentThemePrefs) => {
    setTheme(prefs);
  }, []);

  const setProductModePersist = useCallback((mode: AgentProductMode) => {
    setProductMode(mode);
    try {
      localStorage.setItem(AGENT_PRODUCT_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, []);

  const openUtilityPanel = useCallback(() => {
    if (typeof window !== 'undefined' && window.butlerElectron?.openAgentUtility) {
      void window.butlerElectron.openAgentUtility();
      return;
    }
    setUtilityOpen(true);
  }, []);
  const onSecretLogoDoubleClick = useAgentSecretChord(openUtilityPanel);

  const runChatRequest = useCallback(
    async (opts: {
      message: string;
      history: AgentChatMessage[];
      attachment?: { dataUrl: string; name: string; mime: string } | null;
    }) => {
      setActiveModelLabel('Butler chat');
      setRunStatus({
        status: 'starting',
        message: 'Talking to Butler…',
        iteration: 0,
        max_iterations: 1,
        model_source: 'Butler chat',
      });
      const history = opts.history
        .filter((m) => m.id !== 'welcome' && (m.role === 'user' || m.role === 'assistant'))
        .filter((m) => typeof m.content === 'string' && m.content.trim())
        .slice(-24)
        .map((m) => ({ role: m.role, content: m.content }));
      let initImageB64: string | undefined;
      let fileAttachment:
        | { filename: string; mime_type: string; data_base64: string }
        | undefined;
      const att = opts.attachment;
      if (att?.dataUrl) {
        const s = att.dataUrl.trim();
        const marker = ';base64,';
        const i = s.indexOf(marker);
        if (s.toLowerCase().startsWith('data:') && i > 5) {
          const mime = (s.slice(5, i).trim() || att.mime || 'application/octet-stream').split(';')[0];
          const base64 = s.slice(i + marker.length).replace(/\s/g, '');
          if (mime.toLowerCase().startsWith('image/')) initImageB64 = base64;
          else
            fileAttachment = {
              filename: att.name || 'attachment',
              mime_type: mime || 'application/octet-stream',
              data_base64: base64,
            };
        }
      }
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: chatSessionId,
          message: opts.message,
          history,
          localOnly: true,
          ...(initImageB64 ? { init_image: initImageB64 } : {}),
          ...(fileAttachment ? { attachment: fileAttachment } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        reply?: string;
        message?: string;
        error?: string;
        source?: string;
        images?: string[];
      };
      if (!res.ok) {
        throw new Error(data.message || data.error || `Chat failed (${res.status})`);
      }
      const replyText = String(data.reply || '').trim() || '…';
      const assistantMsg: AgentChatMessage = {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        content: replyText,
        source: data.source || 'Butler',
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setRunStatus(null);
      setActiveModelLabel(data.source || 'Butler');
      return data;
    },
    [chatSessionId],
  );

  const handleUtilitySideSend = useCallback(
    async (
      message: string,
      attachment?: { dataUrl: string; name: string; mime: string } | null,
    ) => {
      setProductModePersist('chat');
      const userMsg: AgentChatMessage = {
        id: String(Date.now()),
        role: 'user',
        content: message,
      };
      setMessages((prev) => [...prev, userMsg]);
      setSending(true);
      try {
        await runChatRequest({
          message,
          history: messages.filter((m) => m.id !== 'welcome'),
          attachment,
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-err`,
            role: 'assistant',
            content: raw.trim() || 'Chat failed.',
            error: true,
            source: 'Butler',
          },
        ]);
        setRunStatus(null);
      } finally {
        setSending(false);
      }
    },
    [messages, runChatRequest, setProductModePersist],
  );

  useEffect(() => {
    const unsub = window.butlerElectron?.onAgentUtilitySideSend?.((payload) => {
      const msg = String(payload?.message || '').trim();
      if (!msg) return;
      void handleUtilitySideSend(msg, payload?.attachment ?? null);
    });
    return () => {
      unsub?.();
    };
  }, [handleUtilitySideSend]);

  const runAgentRequest = useCallback(
    async (opts: {
      message: string;
      history: AgentChatMessage[];
      continue?: boolean;
      statusLabel?: string;
    }) => {
      const providerLabel = selectedProviderMeta.label;
      setActiveModelLabel(providerLabel);
      setRunStatus({
        status: 'starting',
        message: opts.statusLabel || `Starting agent (${providerLabel})…`,
        iteration: 0,
        max_iterations: 16,
        model_source: providerLabel,
      });
      setLiveSteps([]);
      setLiveTodos([]);
      persistAgentProjectRoot(cwd);
      const sendProvider = resolveSendProvider(cascadeEnabled, agentProvider);
      const data = await sendAgentTurn(
        {
          message: opts.message,
          history: opts.history,
          cwd,
          localOnly: sendProvider === 'local',
          provider: sendProvider,
          apiKeys,
          continue: opts.continue,
        },
        (st) => {
          setRunStatus(st);
          if (st.model_source) setActiveModelLabel(st.model_source);
          else if (st.model_used) setActiveModelLabel(st.model_used);
          if (Array.isArray(st.todos) && st.todos.length > 0) {
            setLiveTodos(st.todos as AgentTodo[]);
          }
          if (Array.isArray(st.steps) && st.steps.length > 0) {
            setLiveSteps(st.steps);
          } else if (st.status === 'tool' && st.message) {
            setLiveSteps((prev) => {
              const pending: AgentToolStep = {
                type: 'tool',
                tool: 'working',
                activity: st.message,
                in_progress: true,
                iteration: st.iteration,
              };
              const withoutPending = prev.filter((s) => !s.in_progress);
              return [...withoutPending, pending];
            });
          }
        },
      );
      const replyText =
        unwrapAgentReply(String(data.reply || '').trim()) || 'Done.';
      const steps = Array.isArray(data.agent_steps) ? data.agent_steps : undefined;
      const needsContinue =
        Boolean(data.needs_continue) || looksLikeIncompleteAgentReply(replyText, steps);
      const assistantMsg: AgentChatMessage = {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        content: replyText,
        source: data.source || 'Agent',
        steps,
        todos: Array.isArray(data.todos) ? (data.todos as AgentTodo[]) : undefined,
        needsContinue,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setLiveSteps([]);
      setLiveTodos([]);
      setRunStatus(null);
      if (data.source) setActiveModelLabel(data.source);
      void refreshCheckpoints();
      return data;
    },
    [cwd, refreshCheckpoints, agentProvider, cascadeEnabled, apiKeys, selectedProviderMeta],
  );

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    // If currently sending, queue the message instead
    if (sending) {
      setMessageQueue((prev) => [...prev, trimmed]);
      setInput('');
      return;
    }
    stickChatToBottomRef.current = true;
    cancelledMessageRef.current = trimmed;
    const userMsg: AgentChatMessage = {
      id: String(Date.now()),
      role: 'user',
      content: trimmed,
    };
    setInput('');
    setMessages((prev) => [...prev, userMsg]);
    setSending(true);
    try {
      if (productMode === 'chat') {
        await runChatRequest({
          message: trimmed,
          history: messages.filter((m) => m.id !== 'welcome'),
        });
      } else {
        await runAgentRequest({
          message: trimmed,
          history: messages.filter((m) => m.id !== 'welcome'),
          statusLabel: `Starting agent (${selectedProviderMeta.label})…`,
        });
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg =
        (raw || '').trim() && !/^\{?\s*"?error"?\s*:\s*""/.test(raw.trim())
          ? raw.trim()
          : productMode === 'chat'
            ? 'Chat failed with an empty error.'
            : 'Agent failed with an empty error. Check Knowledge logs for MemoryError / traceback after large tool results.';
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-err`,
          role: 'assistant',
          content: msg,
          error: true,
          source: productMode === 'chat' ? 'Butler' : 'Agent',
        },
      ]);
      setRunStatus(null);
      setLiveSteps([]);
      setLiveTodos([]);
      setActiveModelLabel(null);
    } finally {
      setSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [input, sending, messages, productMode, runChatRequest, runAgentRequest, selectedProviderMeta]);

  const handleContinue = useCallback(async () => {
    if (sending) return;
    const historyBase = messages.filter((m) => m.id !== 'welcome');
    const lastUser = [...historyBase].reverse().find((m) => m.role === 'user');
    const goal =
      (lastUser?.content || '').trim() && lastUser?.content !== 'Continue'
        ? lastUser!.content.trim()
        : [...historyBase]
            .reverse()
            .find((m) => m.role === 'user' && m.content.trim() && m.content.trim() !== 'Continue')
            ?.content.trim() || 'Continue implementing the previous request.';
    const continueMsg: AgentChatMessage = {
      id: `${Date.now()}-continue`,
      role: 'user',
      content: 'Continue',
    };
    setMessages((prev) => [...prev, continueMsg]);
    setSending(true);
    try {
      await runAgentRequest({
        message: goal,
        history: [...historyBase, continueMsg],
        continue: true,
        statusLabel: `Continuing agent (${selectedProviderMeta.label})…`,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg =
        (raw || '').trim() && !/^\{?\s*"?error"?\s*:\s*""/.test(raw.trim())
          ? raw.trim()
          : 'Agent failed with an empty error. Check Knowledge logs for MemoryError / traceback after large tool results.';
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-err`,
          role: 'assistant',
          content: msg,
          error: true,
          source: 'Agent',
        },
      ]);
      setRunStatus(null);
      setLiveSteps([]);
      setLiveTodos([]);
      setActiveModelLabel(null);
    } finally {
      setSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [sending, messages, runAgentRequest, selectedProviderMeta]);

  const stopSpeechCapture = useCallback(async (mode: 'transcribe' | 'cancel') => {
    const capture = speechCaptureRef.current;
    speechCaptureRef.current = null;
    if (!capture) {
      setSpeechState('idle');
      return;
    }
    setSpeechState(mode === 'transcribe' ? 'transcribing' : 'idle');
    try {
      const { pcm, sampleRate } = await capture.stop();
      capture.stream?.getTracks().forEach((track) => track.stop());
      if (mode === 'cancel') {
        setSpeechError(null);
        return;
      }
      const text = await transcribePcmViaButler(pcm, sampleRate);
      setInput((prev) => (prev ? `${prev} ${text}` : text).trim());
      setSpeechError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (err) {
      if (mode === 'transcribe') {
        setSpeechError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSpeechState('idle');
    }
  }, []);

  const startSpeechCapture = useCallback(async () => {
    setSpeechError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setSpeechError('Microphone access is not supported here.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const { stop } = await startPcmRecording(stream);
      speechCaptureRef.current = { stop, stream };
      setSpeechState('listening');
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (err) {
      setSpeechState('idle');
      setSpeechError(
        `Could not access microphone: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, []);

  const handleSpeechToggle = useCallback(async () => {
    if (speechState === 'transcribing') return;
    if (speechState === 'listening') {
      await stopSpeechCapture('transcribe');
      return;
    }
    await startSpeechCapture();
  }, [speechState, startSpeechCapture, stopSpeechCapture]);

  const handleSpeechCancel = useCallback(async () => {
    if (speechState !== 'listening') return;
    await stopSpeechCapture('cancel');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [speechState, stopSpeechCapture]);

  const handleManualCheckpoint = async () => {
    setCheckpointBusy(true);
    try {
      await createAgentCheckpoint({ cwd, reason: 'manual' });
      await refreshCheckpoints();
    } finally {
      setCheckpointBusy(false);
    }
  };

  const handleRevert = async (checkpointId: string) => {
    setCheckpointBusy(true);
    try {
      const result = await revertAgentCheckpoint(checkpointId);
      const restored = result.restored?.length || 0;
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-cp`,
          role: 'assistant',
          content: result.ok
            ? `Restored checkpoint **${checkpointId}** (${restored} file${restored === 1 ? '' : 's'}).`
            : `Revert failed: ${result.error || (result.errors || []).join('; ') || 'unknown error'}`,
          source: 'Agent',
          error: !result.ok,
        },
      ]);
      await refreshCheckpoints();
    } finally {
      setCheckpointBusy(false);
    }
  };

  const handleSaveThread = () => {
    if (!agentThreadHasContent(messages)) {
      window.alert('Nothing to save yet — send at least one message first.');
      return;
    }
    const existing = loadedThreadId
      ? savedThreads.find((t) => t.id === loadedThreadId)
      : undefined;
    let title = existing?.title;
    if (!existing) {
      const entered = window.prompt('Thread title (optional):');
      if (entered === null) return;
      if (entered.trim()) title = entered.trim();
    }
    const saved = saveAgentThread({
      id: loadedThreadId,
      title,
      cwd,
      messages,
    });
    setLoadedThreadId(saved.id);
    setSavedFingerprint(agentThreadFingerprint(messages, cwd));
    refreshSavedThreads();
  };

  const handleLoadThread = (thread: SavedAgentThread) => {
    if (thread.id === loadedThreadId && !isDirty) return;
    if (isDirty && !confirmDiscardUnsaved()) return;
    restoreThreadState(thread);
  };

  const handleDeleteThread = (threadId: string, e: MouseEvent) => {
    e.stopPropagation();
    const thread = savedThreads.find((t) => t.id === threadId);
    if (!thread) return;
    if (!window.confirm(`Delete saved thread "${thread.title}"?`)) return;
    deleteSavedAgentThread(threadId);
    if (loadedThreadId === threadId) {
      setLoadedThreadId(null);
      setSavedFingerprint(currentFingerprint);
    }
    refreshSavedThreads();
  };

  const handleNewThread = () => {
    if (isDirty && !confirmDiscardUnsaved()) return;
    resetToNewThread();
  };

  const startRenameThread = (thread: SavedAgentThread, e: MouseEvent) => {
    e.stopPropagation();
    setEditingTitleId(thread.id);
    setEditingTitleValue(thread.title);
  };

  const commitRenameThread = () => {
    if (!editingTitleId) return;
    const updated = renameSavedAgentThread(editingTitleId, editingTitleValue);
    setEditingTitleId(null);
    setEditingTitleValue('');
    if (updated) refreshSavedThreads();
  };

  const progressPct =
    runStatus?.max_iterations && runStatus.iteration
      ? Math.min(100, Math.round((runStatus.iteration / runStatus.max_iterations) * 100))
      : sending
        ? 8
        : 0;
  const workspaceSummary = `${cwd.trim() || defaultAgentProjectRoot()} · ${
    activeModelLabel || selectedProviderMeta.label
  }${isDirty ? ' · unsaved' : ''}`;
  const terminalStatusText = (() => {
    const last = terminalEntries[0];
    if (!last) return `Persistent ${terminalShellLabel} session — cwd and env stick across commands.`;
    if (last.running) return `Running: ${last.command}`;
    if (last.result?.ok) return `Last command finished in ${last.result.duration_ms ?? 0} ms.`;
    return 'Last command exited with an error code.';
  })();

  const threadFileChanges = useMemo(() => {
    const steps: AgentToolStep[] = [];
    for (const m of messages) {
      if (m.steps?.length) steps.push(...m.steps);
    }
    if (liveSteps.length) steps.push(...liveSteps);
    return collectAgentFileChanges(steps);
  }, [messages, liveSteps]);

  const speechStatusText =
    speechState === 'listening'
      ? 'Listening… click Stop to transcribe or Cancel to discard.'
      : speechState === 'transcribing'
        ? 'Transcribing speech…'
        : speechError;

  const runTerminalCommand = useCallback(async () => {
    const command = terminalCommand.trim();
    if (!command || terminalBusy) return;
    const id = `terminal-${Date.now()}`;
    const sessionCwd = terminalSessionCwd.trim() || cwd;
    setFooterOpen(true);
    setFooterTab('terminal');
    setTerminalBusy(true);
    setTerminalEntries((prev) => [{ id, command, cwd: sessionCwd, running: true }, ...prev].slice(0, 40));
    setTerminalCommand('');
    try {
      const result = await runAgentTerminalCommand({ cwd: sessionCwd, command });
      if (result.shell) setTerminalShellLabel(result.shell);
      if (result.cwd) setTerminalSessionCwd(result.cwd);
      setTerminalEntries((prev) =>
        prev.map((entry) =>
          entry.id === id
            ? { ...entry, running: false, cwd: result.cwd || entry.cwd, result }
            : entry,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTerminalEntries((prev) =>
        prev.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                running: false,
                result: {
                  ok: false,
                  command,
                  cwd: sessionCwd,
                  stdout: '',
                  stderr: '',
                  code: null,
                  message,
                },
              }
            : entry,
        ),
      );
    } finally {
      setTerminalBusy(false);
    }
  }, [cwd, terminalBusy, terminalCommand, terminalSessionCwd]);

  const handleResetTerminal = useCallback(async () => {
    const nextCwd = cwd.trim() || defaultAgentProjectRoot();
    setTerminalBusy(true);
    try {
      const info = await resetAgentTerminal({ cwd: nextCwd });
      if (info.shell) setTerminalShellLabel(info.shell);
      setTerminalSessionCwd(info.cwd || nextCwd);
      setTerminalEntries([]);
    } catch {
      /* ignore */
    } finally {
      setTerminalBusy(false);
    }
  }, [cwd]);

  useEffect(() => {
    void fetchAgentTerminalInfo().then((info) => {
      if (info.shell) setTerminalShellLabel(info.shell);
      if (info.cwd) setTerminalSessionCwd(info.cwd);
    });
  }, []);

  useEffect(() => {
    setTerminalSessionCwd(cwd.trim() || defaultAgentProjectRoot());
    void resetAgentTerminal({ cwd: cwd.trim() || defaultAgentProjectRoot() }).then((info) => {
      if (info.shell) setTerminalShellLabel(info.shell);
    });
  }, [cwd]);

  const onSidebarResizeStart = useCallback((e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rootWidth = rootRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const startX = e.clientX;
    const startWidth =
      sidebarWidthPx ??
      Math.round(sidebarRef.current?.getBoundingClientRect().width ?? AGENT_SIDEBAR_MIN_PX);
    const minWidth = AGENT_SIDEBAR_MIN_PX;
    const maxWidth = Math.min(AGENT_SIDEBAR_MAX_PX, Math.max(minWidth, rootWidth - 420));
    const onMove = (ev: globalThis.MouseEvent) => {
      const dx = ev.clientX - startX;
      setSidebarWidthPx(clampSize(startWidth + dx, minWidth, maxWidth));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidthPx]);

  const onFooterResizeStart = useCallback((e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rootH = rootRef.current?.getBoundingClientRect().height ?? window.innerHeight;
    const startY = e.clientY;
    const startHeight = footerHeightPx;
    const minHeight = AGENT_FOOTER_MIN_PX;
    const maxHeight = Math.min(AGENT_FOOTER_MAX_PX, Math.max(minHeight, rootH - 220));
    const onMove = (ev: globalThis.MouseEvent) => {
      const dy = startY - ev.clientY;
      setFooterHeightPx(clampSize(startHeight + dy, minHeight, maxHeight));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [footerHeightPx]);

  const dequeueAndSend = useCallback(() => {
    setMessageQueue((prev) => {
      const next = prev.slice(1);
      if (prev.length > 0) {
        setInput(prev[0]);
        // Trigger send after state update
        setTimeout(() => void handleSend(), 50);
      }
      return next;
    });
  }, [handleSend]);

  const handleCancelSend = useCallback(() => {
    if (!sending) return;
    const textToRestore = input.trim() || cancelledMessageRef.current || '';
    setCancelRequested(true);
    setSending(false);
    setRunStatus(null);
    setLiveSteps([]);
    setLiveLog([]);
    setInput(textToRestore);
    cancelledMessageRef.current = null;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [sending, input]);

  // Retry a failed message (or any user message)
  const handleRetryMessage = useCallback((msg: AgentChatMessage) => {
    const content = msg.content;
    // Remove the error message and any subsequent messages, then retry the target message
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === msg.id);
      return idx >= 0 ? prev.slice(0, idx) : prev.filter((m) => !m.error);
    });
    setInput(content);
    requestAnimationFrame(() => inputRef.current?.focus());
    setTimeout(() => void handleSend(), 50);
  }, [handleSend]);

  // Process queue when not sending
  useEffect(() => {
    if (!sending && messageQueue.length > 0) {
      void dequeueAndSend();
    }
  }, [sending, messageQueue, dequeueAndSend]);

  // Live logging effect: capture status changes and step details
  const prevRunStatusRef = useRef<AgentRunStatus | null>(null);
  useEffect(() => {
    if (!runStatus) return;
    const prev = prevRunStatusRef.current;
    prevRunStatusRef.current = runStatus;
    if (runStatus.message && runStatus.message !== prev?.message) {
      setLiveLog((prevLog) => {
        const time = new Date().toLocaleTimeString();
        const step = runStatus.iteration ? `step ${runStatus.iteration}` : '';
        const model = runStatus.model_source || runStatus.model_used || '';
        const prefix = [time, step, model].filter(Boolean).join(' · ');
        const entry = `[${prefix}] ${runStatus.message}`;
        return [...prevLog.slice(-49), entry];
      });
    }
    if (Array.isArray(runStatus.steps) && runStatus.steps.length > 0) {
      const latest = runStatus.steps[runStatus.steps.length - 1];
      if (latest?.activity && latest.activity !== prev?.steps?.[prev.steps.length - 1]?.activity) {
        setLiveLog((prevLog) => {
          const time = new Date().toLocaleTimeString();
          const entry = `[${time}] ${latest.activity}${latest.tool ? ` (${latest.tool})` : ''}`;
          return [...prevLog.slice(-49), entry];
        });
      }
    }
  }, [runStatus]);

  return (
    <div
      ref={rootRef}
      className={`agent-window agent-window--theme-${theme.mode} agent-window--accent-${theme.accent}${
        embedded ? ' agent-window--embedded' : ''
      }${splitView ? ' agent-window--split' : ''}${browserMaximized ? ' agent-window--browser-maximized' : ''}`}
      data-agent-theme={theme.mode}
      data-agent-accent={theme.accent}
    >
      {!browserMaximized ? (
        <AgentSidebar
          open={sidebarOpen}
          widthPx={sidebarWidthPx}
          sidebarRef={sidebarRef}
          isDirty={isDirty}
          threadSearch={threadSearch}
          onThreadSearchChange={setThreadSearch}
          searchOpen={searchOpen}
          onToggleSearch={() => setSearchOpen((v) => !v)}
          savedThreads={savedThreads}
          loadedThreadId={loadedThreadId}
          editingTitleId={editingTitleId}
          editingTitleValue={editingTitleValue}
          onEditingTitleValueChange={setEditingTitleValue}
          onNewThread={handleNewThread}
          onOpenMcp={() => setMcpOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onCloseSidebar={() => setSidebarOpen(false)}
          onSecretLogoDoubleClick={onSecretLogoDoubleClick}
          onLoadThread={handleLoadThread}
          onStartRename={startRenameThread}
          onCommitRename={commitRenameThread}
          onCancelRename={() => {
            setEditingTitleId(null);
            setEditingTitleValue('');
          }}
          onDeleteThread={handleDeleteThread}
          onSaveThread={handleSaveThread}
          canSave={agentThreadHasContent(messages)}
          sending={sending}
          mcpCount={mcpCount}
          embedded={embedded}
          splitView={splitView}
          onBack={onBack}
          onEnterSplit={onEnterSplit}
          onExitSplit={onExitSplit}
          standalone={standalone}
          onPopOut={onPopOut}
          onPopIn={onPopIn}
        />
      ) : null}
      {sidebarOpen && !browserMaximized ? (
        <div
          className="agent-window-resize-handle agent-window-resize-handle--vertical"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize. Double-click to reset."
          onMouseDown={onSidebarResizeStart}
          onDoubleClick={(e) => {
            e.preventDefault();
            setSidebarWidthPx(null);
          }}
        />
      ) : null}

      <div className="agent-window-main">
        {!browserMaximized ? (
          <div className="agent-chrome">
          {!sidebarOpen ? (
            <button
              type="button"
              className="agent-icon-btn"
              onClick={() => setSidebarOpen(true)}
              title="Show sidebar"
              aria-label="Show sidebar"
            >
              »
            </button>
          ) : null}
          {!sidebarOpen ? (
            <button
              type="button"
              className="agent-chrome-logo"
              onDoubleClick={onSecretLogoDoubleClick}
              title="Butler Agent"
              aria-label="Butler Agent"
            >
              <img src="./icon.png" alt="" width={28} height={28} draggable={false} />
            </button>
          ) : (
            <span className="agent-chrome-logo agent-chrome-logo--static" aria-hidden>
              <img src="./icon.png" alt="" width={28} height={28} draggable={false} />
            </span>
          )}
          <div className="agent-mode-tabs" role="tablist" aria-label="Mode">
            <button
              type="button"
              role="tab"
              aria-selected={productMode === 'chat'}
              className={`agent-mode-tab${productMode === 'chat' ? ' agent-mode-tab--active' : ''}`}
              onClick={() => setProductModePersist('chat')}
            >
              Chat
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={productMode === 'code'}
              className={`agent-mode-tab${productMode === 'code' ? ' agent-mode-tab--active' : ''}`}
              onClick={() => setProductModePersist('code')}
            >
              Code
            </button>
          </div>
          <div className="agent-chrome-meta">
            <span className="agent-chrome-path" title={cwd}>
              {productMode === 'code' ? workspaceSummary : 'Butler conversation'}
            </span>
            <button
              type="button"
              className="agent-chrome-model"
              title={productMode === 'chat' ? 'Conversational Butler' : selectedProviderMeta.hint}
              onClick={() => setSettingsOpen(true)}
            >
              {productMode === 'chat'
                ? activeModelLabel || 'Butler'
                : activeModelLabel || selectedProviderMeta.label}
            </button>
            {isDirty ? <span className="agent-window-unsaved-label">Unsaved</span> : null}
          </div>
          <div className="agent-chrome-actions">
            {!sidebarOpen && embedded ? (
              <>
                {onEnterSplit || onExitSplit ? (
                  splitView ? (
                    <button
                      type="button"
                      className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                      onClick={onExitSplit}
                    >
                      Single
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                      onClick={onEnterSplit}
                    >
                      Split
                    </button>
                  )
                ) : null}
              </>
            ) : null}
          </div>
          </div>
        ) : null}

        {!browserMaximized && sending && runStatus ? (
          <div className="agent-window-working-banner" role="status" aria-live="polite">
            <span className="agent-pulse" aria-hidden />
            <div className="agent-window-working-text">
              <strong>Working</strong>
              <span className="agent-window-working-step"> · {runStatus.message || 'Planning…'}</span>
              {runStatus.model_source || activeModelLabel ? (
                <span className="agent-window-working-model">
                  {' '}
                  · {runStatus.model_source || activeModelLabel}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {!browserMaximized ? (
          <div className="agent-window-thread-wrap">
            {sending && liveTodos.length > 0 ? <AgentTodoList todos={liveTodos} floating /> : null}
            <div
              ref={threadScrollRef}
              className="agent-window-thread"
              role="log"
              aria-live="polite"
              onScroll={onThreadScroll}
            >
            {messages.map((m) => (
              <div
                key={m.id}
                className={`agent-msg agent-msg--${m.role}${m.error ? ' agent-msg--error' : ''}`}
              >
                <div className="agent-msg-meta">
                  <span className="agent-msg-role">{m.role === 'user' ? 'You' : 'Agent'}</span>
                  {m.source ? <span className="agent-msg-source">{m.source}</span> : null}
                </div>
                <div className="agent-msg-body">
                  <ChatBubbleRichText
                    text={
                      m.role === 'assistant'
                        ? unwrapAgentReply(m.content || '') || '…'
                        : m.content || ''
                    }
                  />
                  {m.role === 'user' ? (
                    <button
                      type="button"
                      className="agent-msg-retry-btn"
                      onClick={() => handleRetryMessage(m)}
                      title="Retry this message"
                    >
                      Retry
                    </button>
                  ) : null}
                  {m.role === 'assistant' &&
                  !m.error &&
                  !sending &&
                  productMode === 'code' &&
                  (m.needsContinue || looksLikeIncompleteAgentReply(m.content, m.steps)) &&
                  m.id ===
                    [...messages].reverse().find((x) => x.role === 'assistant' && !x.error)?.id ? (
                    <button
                      type="button"
                      className="agent-msg-continue-btn"
                      onClick={() => void handleContinue()}
                      title="Resume agent — keep implementing"
                    >
                      Continue
                    </button>
                  ) : null}
                </div>
                {m.todos && m.todos.length > 0 ? <AgentTodoList todos={m.todos} compact /> : null}
                {m.steps && m.steps.length > 0 ? (
                  <div className="agent-msg-steps">
                    {m.steps.map((step, i) => (
                      <AgentStepBlock
                        key={`${m.id}-step-${i}`}
                        step={step}
                        defaultOpen={false}
                        onOpenDiff={setActiveDiff}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {sending ? (
              <div className="agent-msg agent-msg--assistant agent-msg--pending">
                <div className="agent-msg-meta">
                  <span className="agent-msg-role">{productMode === 'chat' ? 'Butler' : 'Agent'}</span>
                </div>
                <div className="agent-msg-body agent-msg-body--pending">
                  <span className="agent-pulse" aria-hidden />
                  {runStatus?.message || (productMode === 'chat' ? 'Thinking…' : 'Working…')}
                </div>
                {liveSteps.length > 0 ? (
                  <div className="agent-msg-steps">
                    {liveSteps.slice(-4).map((step, i, arr) => (
                      <AgentStepBlock
                        key={`live-step-${i}`}
                        step={step}
                        defaultOpen={i === arr.length - 1}
                        inProgress={!!step.in_progress || i === arr.length - 1}
                        onOpenDiff={setActiveDiff}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
              <div ref={threadEndRef} />
            </div>
          </div>
        ) : null}

        {!browserMaximized ? (
          <footer className="agent-window-composer">
            <AgentFileDiffStrip changes={threadFileChanges} onOpen={setActiveDiff} />
            <div className="agent-window-composer-main">
            <textarea
              ref={inputRef}
              className="agent-window-input"
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                productMode === 'chat'
                  ? 'Ask Butler anything…'
                  : 'Ask to scan the project, edit code, run tests, search docs…'
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              disabled={sending}
            />
            {speechStatusText ? (
              <div
                className={`agent-window-speech-status${
                  speechError && speechState === 'idle' ? ' agent-window-speech-status--error' : ''
                }`}
                role="status"
                aria-live="polite"
              >
                {speechStatusText}
              </div>
            ) : null}
            {messageQueue.length > 0 ? (
              <div className="agent-window-queue" title="Queued messages">
                <span className="agent-window-queue-label">Queue:</span>
                {messageQueue.map((q, i) => (
                  <span key={i} className="agent-window-queue-item" title={q}>
                    {q.slice(0, 30)}
                    {q.length > 30 ? '…' : ''}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="agent-window-composer-actions">
            {sending ? (
              <button
                type="button"
                className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                onClick={() => void handleCancelSend()}
              >
                Cancel
              </button>
            ) : null}
            {!sending && showContinue ? (
              <button
                type="button"
                className="agent-window-btn agent-window-btn--continue"
                onClick={() => void handleContinue()}
                title="Resume the agent to finish promised work"
              >
                Continue
              </button>
            ) : null}
            <button
              type="button"
              className={`agent-window-btn agent-window-btn--ghost agent-window-speech-btn${
                speechState === 'listening' ? ' agent-window-speech-btn--active' : ''
              }`}
              onClick={() => void handleSpeechToggle()}
              disabled={sending || speechState === 'transcribing'}
              title={
                speechState === 'listening'
                  ? 'Stop recording and transcribe'
                  : speechState === 'transcribing'
                    ? 'Transcribing speech'
                    : 'Record speech-to-text'
              }
              aria-pressed={speechState === 'listening'}
              aria-label={
                speechState === 'listening'
                  ? 'Stop recording and transcribe'
                  : 'Start speech-to-text recording'
              }
            >
              <span
                className={`agent-window-speech-indicator${
                  speechState === 'listening' ? ' agent-window-speech-indicator--live' : ''
                }`}
                aria-hidden
              />
              {speechState === 'listening'
                ? 'Stop mic'
                : speechState === 'transcribing'
                  ? 'Transcribing…'
                  : 'Dictate'}
            </button>
            {speechState === 'listening' ? (
              <button
                type="button"
                className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                onClick={() => void handleSpeechCancel()}
              >
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              className="agent-window-send"
              onClick={() => void handleSend()}
              disabled={sending || !input.trim()}
            >
              {sending ? 'Working…' : productMode === 'chat' ? 'Send' : 'Send'}
            </button>
            </div>
          </footer>
        ) : null}

        <AgentBottomPanel
          open={browserMaximized ? true : footerOpen}
          heightPx={footerHeightPx}
          tab={footerTab}
          browserMaximized={browserMaximized}
          onTabChange={(tab) => openFooterTab(tab)}
          onToggleOpen={() => {
            if (browserMaximized) {
              setBrowserMaximized(false);
              return;
            }
            setFooterOpen((open) => {
              const next = !open;
              if (next && footerTab === 'browser') {
                setFooterHeightPx((prev) =>
                  prev < AGENT_FOOTER_BROWSER_DEFAULT_PX ? AGENT_FOOTER_BROWSER_DEFAULT_PX : prev,
                );
              }
              return next;
            });
          }}
          onToggleBrowserMaximized={toggleBrowserMaximized}
          onResizeStart={onFooterResizeStart}
          onResetHeight={() =>
            setFooterHeightPx(
              footerTab === 'browser' ? AGENT_FOOTER_BROWSER_DEFAULT_PX : AGENT_FOOTER_DEFAULT_PX,
            )
          }
          cwd={terminalSessionCwd || cwd}
          terminalShellLabel={terminalShellLabel}
          terminalStatusText={terminalStatusText}
          terminalCommand={terminalCommand}
          onTerminalCommandChange={setTerminalCommand}
          onRunTerminal={() => void runTerminalCommand()}
          onClearTerminal={() => setTerminalEntries([])}
          onResetTerminal={() => void handleResetTerminal()}
          terminalBusy={terminalBusy}
          terminalEntries={terminalEntries}
          liveLog={liveLog}
        />

        <AgentFileDiffModal change={activeDiff} onClose={() => setActiveDiff(null)} />

        <AgentSettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          cwd={cwd}
          onCwdChange={(next) => {
            setCwd(next);
            persistAgentProjectRoot(next);
          }}
          onBrowseWorkspace={() => void handleBrowse()}
          onOpenExplorer={() => void openAgentWorkspaceInExplorer(cwd)}
          scanSummary={scanSummary}
          cascadeEnabled={cascadeEnabled}
          onCascadeChange={handleCascadeChange}
          agentProvider={agentProvider}
          onProviderChange={handleProviderChange}
          apiKeys={apiKeys}
          onApiKeyChange={handleApiKeyChange}
          envVarRows={envVarRows}
          onEnvVarRowsChange={handleEnvVarRowsChange}
          checkpoints={checkpoints}
          checkpointBusy={checkpointBusy}
          sending={sending}
          onManualCheckpoint={() => void handleManualCheckpoint()}
          onRevertCheckpoint={(id) => void handleRevert(id)}
          theme={theme}
          onThemeChange={handleThemeChange}
        />

        <AgentUtilityPanel
          open={utilityOpen}
          onClose={() => setUtilityOpen(false)}
          onSideSend={handleUtilitySideSend}
          variant="overlay"
        />

        <AgentMcpPanel
          open={mcpOpen}
          onClose={() => setMcpOpen(false)}
          onServersChanged={(servers) => setMcpCount(servers.length)}
        />
      </div>
    </div>
  );
}
