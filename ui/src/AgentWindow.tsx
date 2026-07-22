import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ChatBubbleRichText } from './components/ChatBubbleRichText';
import { AgentSettingsPanel } from './components/AgentSettingsPanel';
import { AgentSidebar } from './components/AgentSidebar';
import { AgentBottomPanel, type AgentFooterTab, type TerminalEntry } from './components/AgentBottomPanel';
import { AgentMcpPanel } from './components/AgentMcpPanel';
import { AgentSpotifyPanel } from './components/AgentSpotifyPanel';
import { AgentTodoPanel } from './components/AgentTodoPanel';
import { AgentUtilityPanel, useAgentSecretChord } from './components/AgentUtilityPanel';
import { VoiceConversationStage } from './components/VoiceConversationStage';
import {
  loadChatFormality,
  loadPulseColors,
  type PulseColors,
} from './lib/chatModePrefs';
import {
  AgentFileDiffModal,
  AgentFileDiffStrip,
  SelfEditReviewBanner,
  collectAgentFileChanges,
  type AgentFileChange,
} from './components/AgentFileDiff';
import {
  acceptSelfEditReview,
  AGENT_CWD_BEFORE_SELF_EDIT_KEY,
  AGENT_SESSION_ID,
  browseAgentWorkspace,
  BUTLER_SOURCE_WORKSPACE_WARNING,
  createAgentCheckpoint,
  defaultAgentProjectRoot,
  defaultButlerSourceRoot,
  fetchAgentTerminalInfo,
  fetchAgentTerminalShells,
  fetchSelfEditReview,
  fetchSelfEditReviewChanges,
  listAgentCheckpoints,
  listSelfEditReviews,
  looksLikeButlerSourceRoot,
  looksLikeIncompleteAgentReply,
  openAgentWorkspaceInExplorer,
  persistAgentProjectRoot,
  rejectSelfEditReview,
  resetAgentTerminal,
  runAgentTerminalCommand,
  revertAgentCheckpoint,
  scanAgentWorkspace,
  sendAgentTurn,
  unwrapAgentReply,
} from './lib/agentApi';
import type { AgentShellInfo } from './lib/agentTypes';
import {
  agentThreadFingerprint,
  agentThreadHasContent,
  deleteSavedAgentThread,
  isAgentWelcomeMessage,
  listSavedAgentThreads,
  renameSavedAgentThread,
  saveAgentThread,
  type SavedAgentThread,
} from './lib/agentThreads';
import {
  listAgentWorkspacePaths,
  loadExpandedWorkspaceKeys,
  persistExpandedWorkspaceKeys,
  rememberAgentWorkspace,
  workspaceExpandKey,
} from './lib/agentWorkspaces';
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
import {
  looksLikeOpenBrowserAsk,
  openAgentBrowserPopout,
  OPEN_BROWSER_CHAT_REPLY,
} from './lib/openBrowserChat';
import { startPcmRecording, transcribePcmViaButler } from './lib/speechToText';
import { cancelNeuralSpeech, isNeuralSpeaking, speakNeural } from './lib/neuralTts';
import { startVoiceModePcmAutoListen } from './voiceModeAutoListen';
import { SilentScreenCapture, type ScreenCaptureFrame } from './lib/screenAssistCapture';
import {
  getScreenLookModeEnabled,
  setScreenLookModeEnabled,
  subscribeScreenAssistPrefs,
} from './lib/screenAssistPrefs';
import type {
  AgentChatMessage,
  AgentCheckpoint,
  AgentRunStatus,
  AgentTodo,
  AgentToolStep,
  SelfEditReview,
} from './lib/agentTypes';
const SCREEN_LOOK_INTERVAL_MS = 6500;
const AGENT_SIDEBAR_WIDTH_KEY = 'butler-agent-sidebar-width';
const AGENT_SIDEBAR_OPEN_KEY = 'butler-agent-sidebar-open';
const AGENT_FOOTER_OPEN_KEY = 'butler-agent-footer-open';
const AGENT_FOOTER_TAB_KEY = 'butler-agent-footer-tab';
const AGENT_FOOTER_HEIGHT_KEY = 'butler-agent-footer-height';
const AGENT_SIDEBAR_MIN_PX = 220;
const AGENT_SIDEBAR_MAX_PX = 440;
const AGENT_FOOTER_MIN_PX = 160;
const AGENT_FOOTER_MAX_PX = 720;
const AGENT_FOOTER_DEFAULT_PX = 360;
const AGENT_CHAT_STICK_PX = 80;

const AGENT_PRODUCT_MODE_KEY = 'butler-agent-product-mode';
/** Settings: pre-check "Override tests" on self-edit reviews when tests are missing. */
const AGENT_SELF_EDIT_ACCEPT_WITHOUT_TESTS_KEY = 'butler-self-edit-accept-without-tests';

type AgentProductMode = 'chat' | 'code' | 'self-edit';

/** Keep the latest review at the top of the durable Reviews sidebar list. */
function reviewListKey(review: SelfEditReview | null | undefined): string {
  if (!review) return '';
  return (
    String(review.review_id || '').trim() ||
    String(review.session_id || '').trim() ||
    String(review.checkpoint_id || '').trim() ||
    String(review.run_id || '').trim()
  );
}

function upsertPendingReview(reviews: SelfEditReview[], review: SelfEditReview): SelfEditReview[] {
  const key = reviewListKey(review);
  const rest = key
    ? reviews.filter((r) => reviewListKey(r) !== key)
    : reviews.filter((r) => r !== review);
  return [review, ...rest];
}

function isCodingProductMode(mode: AgentProductMode): boolean {
  return mode === 'code' || mode === 'self-edit';
}

/** Voice/self-edit: user is asking Butler to change his own product code. */
function looksLikeSelfEditAsk(text: string): boolean {
  const t = (text || '').trim().toLowerCase();
  if (!t || t.length < 4) return false;
  if (/\bself[- ]?edit\b/.test(t)) return true;
  if (
    /\b(edit|fix|change|patch|update|modify|refactor)\b[\s\S]{0,48}\b(yourself|your (own )?(code|source|ui|agent|repo)|butler)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(butler('s)? (own )?(code|source|repo|agent|ui|checkout))\b/.test(t)) return true;
  if (/\b(agentwindow|butler_agent|agent_llm|allow_self_edit)\b/.test(t)) return true;
  return false;
}

/**
 * Narrow phatic/smalltalk only — safe for casual /api/chat while Self-edit or Code is on.
 * Everything else in those modes uses the coding agent (default).
 */
function looksLikePurePhatic(text: string): boolean {
  const t = (text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?…]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 72) return false;
  if (looksLikeCodingTask(t) || looksLikeSelfEditAsk(t)) return false;
  if (
    /\b(fix|change|edit|update|add|remove|build|make|implement|refactor|debug|write|create|patch|modify|bug|error|file|code|button|ui|mode|tab|setting|workspace|self[- ]?edit)\b/.test(
      t,
    )
  ) {
    return false;
  }
  return (
    /^(hi|hey|hello|yo|sup|howdy)( there| butler)?$/.test(t) ||
    /^(thanks|thank you|thx|ty)( (so )?much)?$/.test(t) ||
    /^(ok|okay|cool|nice|great|awesome|got it|sounds good|alright|sure|yep|yeah|yup|nope|nah)$/.test(
      t,
    ) ||
    /^(good (morning|afternoon|evening|night)|how are you|how's it going|whats? up|what'?s up)$/.test(
      t,
    ) ||
    /^(bye|goodbye|see you|later)$/.test(t) ||
    /^(lol|haha|lmao|heh)$/.test(t)
  );
}

/** Voice/chat → Code-agent handoff: user wants repo/file edits, not small talk. */
function looksLikeCodingTask(text: string): boolean {
  const t = (text || '').trim().toLowerCase();
  if (!t || t.length < 4) return false;

  // Stay in Butler chat for image/job tools and pure Q&A.
  if (
    /\b(txt2img|img2img|comfy(?:ui)?|stable diffusion)\b/.test(t) ||
    /\b(generate|draw|paint|render)\b[\s\S]{0,48}\b(image|picture|photo|video|anime)\b/.test(t) ||
    /\b(job application|apply to jobs|cover letter|upwork|\bgigs?\b)\b/.test(t)
  ) {
    return false;
  }
  const qaOnly =
    /\b(what(?:'s|s| is)|who is|explain|how does|why does|tell me about|define)\b/.test(t) &&
    !/\b(fix|implement|write|refactor|add|change|edit|build|create|debug|scaffold)\b/.test(t);
  if (qaOnly) return false;

  const action =
    /\b(fix|implement|refactor|debug|scaffold|patch|migrate|wire(?:\s+up)?|hook(?:\s+up)?)\b/.test(
      t,
    ) ||
    /\b(write|add|create|build|make|update|change|edit|rename|delete|remove|install)\b/.test(t);
  const target =
    /\b(code|file|function|component|module|class|bug|error|test|api|endpoint|script|repo|project|app|website|site|ui|feature|button|css|html|tsx?|jsx?|typescript|javascript|python|react|hook)\b/.test(
      t,
    ) ||
    /\bmy (code|project|repo|app|site|website)\b/.test(t) ||
    /\bin (the|this|my) (code|project|repo|file|folder|directory)\b/.test(t);

  if (action && target) return true;

  return (
    /\bfix (this|the|my|that|a |an )\b/.test(t) ||
    /\bfix (a |an |the )?(bug|error|issue|crash)\b/.test(t) ||
    /\b(write (some |the )?code|code (this|that|it)|implement (this|that|it))\b/.test(t) ||
    /\b(refactor|pull request|unit test|typecheck|type-check|\blint\b)\b/.test(t)
  );
}

function formatTodosChecklistSpeech(todos: AgentTodo[]): string {
  const items = todos
    .map((t) => String(t.content || '').trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!items.length) return '';
  if (items.length === 1) return `Here's the plan: ${items[0]}.`;
  const body = items.map((c, i) => `${i + 1}. ${c}`).join('. ');
  return `Here's the plan: ${body}.`;
}

function readProductMode(): AgentProductMode {
  try {
    const v = localStorage.getItem(AGENT_PRODUCT_MODE_KEY);
    if (v === 'chat' || v === 'code' || v === 'self-edit') return v;
  } catch {
    /* ignore */
  }
  return 'code';
}

function readAcceptWithoutTestsPref(): boolean {
  try {
    return localStorage.getItem(AGENT_SELF_EDIT_ACCEPT_WITHOUT_TESTS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAcceptWithoutTestsPref(on: boolean): void {
  try {
    localStorage.setItem(AGENT_SELF_EDIT_ACCEPT_WITHOUT_TESTS_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

type ChatAttach = { dataUrl: string; name: string; mime: string };

function parseComposerDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const s = dataUrl.trim();
  const marker = ';base64,';
  const i = s.indexOf(marker);
  if (!s.toLowerCase().startsWith('data:') || i < 5) return null;
  const mime = s.slice(5, i).trim() || 'application/octet-stream';
  const base64 = s.slice(i + marker.length).replace(/\s/g, '');
  if (!base64) return null;
  return { mime, base64 };
}

async function compressComposerImage(dataUrl: string, maxSide = 1280, q = 0.82): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w0 = img.naturalWidth || img.width;
        const h0 = img.naturalHeight || img.height;
        const scale = Math.min(1, maxSide / Math.max(w0, h0, 1));
        const w = Math.max(1, Math.round(w0 * scale));
        const h = Math.max(1, Math.round(h0 * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', q));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function fileToChatAttach(file: File): Promise<ChatAttach | null> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });
  if (!dataUrl) return null;
  let mime =
    parseComposerDataUrl(dataUrl)?.mime.split(';')[0].trim() || file.type || 'application/octet-stream';
  let outUrl = dataUrl;
  if (mime.toLowerCase().startsWith('image/')) {
    outUrl = await compressComposerImage(dataUrl);
    mime = 'image/jpeg';
  }
  return { dataUrl: outUrl, name: file.name || 'attachment', mime };
}

function screenFrameToAttach(frame: ScreenCaptureFrame): ChatAttach {
  return { dataUrl: frame.dataUrl, name: frame.name || 'live-screen.jpg', mime: frame.mime || 'image/jpeg' };
}

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
    if (raw === 'terminal' || raw === 'output') return raw;
    // Legacy tabs collapsed into Settings
    if (raw === 'workspace' || raw === 'llm' || raw === 'checkpoints' || raw === 'browser') return 'terminal';
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
  /** App-owned voice conversation (mic + TTS). */
  voiceMode?: boolean;
  /** Pulse / glow when listening or speaking. */
  voiceAlive?: boolean;
  voiceToggleBusy?: boolean;
  onToggleVoiceMode?: () => void;
  /** App-owned mic mute (waveform toggles this while voice mode is on). */
  micMuted?: boolean;
  onToggleMicMute?: () => void;
  /** Register sink so App continuous STT feeds Agent Chat instead of the hidden main chat. */
  onRegisterVoiceSink?: (sink: ((text: string) => void) | null) => void;
  /** Speak Butler chat replies aloud while voice mode is on. */
  onSpeakReply?: (text: string) => void;
  /** Tell App to pause STT while Agent is sending. */
  onVoiceBusyChange?: (busy: boolean) => void;
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
  voiceMode = false,
  voiceAlive = false,
  voiceToggleBusy = false,
  onToggleVoiceMode,
  micMuted = false,
  onToggleMicMute,
  onRegisterVoiceSink,
  onSpeakReply,
  onVoiceBusyChange,
}: AgentWindowProps = {}) {
  /** When App owns voice (embedded), use props; otherwise AgentWindow runs its own loop (standalone). */
  const voiceOwnedByApp = typeof onToggleVoiceMode === 'function';
  const rootRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [cwd, setCwd] = useState(defaultAgentProjectRoot);
  const [sending, setSending] = useState(false);
  const [runStatus, setRunStatus] = useState<AgentRunStatus | null>(null);
  const [liveSteps, setLiveSteps] = useState<AgentToolStep[]>([]);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [scanSummary, setScanSummary] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<AgentCheckpoint[]>([]);
  const [checkpointBusy, setCheckpointBusy] = useState(false);
  const [selfEditReview, setSelfEditReview] = useState<SelfEditReview | null>(null);
  const [selfEditReviewBusy, setSelfEditReviewBusy] = useState(false);
  const [acceptWithoutTests, setAcceptWithoutTests] = useState(() => readAcceptWithoutTestsPref());
  const [pendingReviews, setPendingReviews] = useState<SelfEditReview[]>([]);
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const [reviewFileChanges, setReviewFileChanges] = useState<AgentFileChange[]>([]);
  const [savedThreads, setSavedThreads] = useState<SavedAgentThread[]>(() => listSavedAgentThreads());
  const [loadedThreadId, setLoadedThreadId] = useState<string | null>(null);
  const [workspaceListTick, setWorkspaceListTick] = useState(0);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => {
    const keys = loadExpandedWorkspaceKeys();
    if (keys.length > 0) return new Set(keys);
    // Expand active cwd on first visit.
    return new Set([workspaceExpandKey(defaultAgentProjectRoot())]);
  });
  const [savedFingerprint, setSavedFingerprint] = useState(() =>
    agentThreadFingerprint([], defaultAgentProjectRoot(), 'code'),
  );
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleValue, setEditingTitleValue] = useState('');
  const [agentProvider, setAgentProvider] = useState<AgentProviderId>(() => loadAgentProvider());
  const [cascadeEnabled, setCascadeEnabled] = useState<boolean>(() => loadCascadeEnabled());
  const [apiKeys, setApiKeys] = useState<Record<string, string>>(() => loadAgentApiKeys());
  const [envVarRows, setEnvVarRows] = useState<AgentEnvVarRow[]>(() => rowsFromRecord(loadAgentEnvVars()));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pulseColors, setPulseColors] = useState<PulseColors>(() => loadPulseColors());
  const [mcpOpen, setMcpOpen] = useState(false);
  const [spotifyOpen, setSpotifyOpen] = useState(false);
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [rebuildBusy, setRebuildBusy] = useState(false);
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
  const [footerHeightPx, setFooterHeightPx] = useState<number>(() => {
    const stored = readStoredAgentSize(AGENT_FOOTER_HEIGHT_KEY, AGENT_FOOTER_MIN_PX, AGENT_FOOTER_MAX_PX);
    return stored ?? AGENT_FOOTER_DEFAULT_PX;
  });
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([]);
  const [terminalSessionCwd, setTerminalSessionCwd] = useState(() => defaultAgentProjectRoot());
  const [terminalShellId, setTerminalShellId] = useState(() => {
    try {
      const stored = localStorage.getItem('butler_agent_terminal_shell');
      if (stored === 'pwsh' || stored === 'powershell' || stored === 'cmd' || stored === 'bash') {
        return stored;
      }
    } catch {
      /* ignore */
    }
    return 'pwsh';
  });
  const [terminalShellLabel, setTerminalShellLabel] = useState('PowerShell');
  const [terminalShells, setTerminalShells] = useState<AgentShellInfo[]>([]);
  const agentShellSeenRef = useRef<Set<string>>(new Set());
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
  const [localVoiceMode, setLocalVoiceMode] = useState(false);
  const [localVoiceBusy, setLocalVoiceBusy] = useState(false);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [localUserSpeaking, setLocalUserSpeaking] = useState(false);
  const [localMicMuted, setLocalMicMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [chatAttachment, setChatAttachment] = useState<{
    dataUrl: string;
    name: string;
    mime: string;
  } | null>(null);
  const [composerDragOver, setComposerDragOver] = useState(false);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const [screenSharing, setScreenSharing] = useState(false);
  const [screenShareBusy, setScreenShareBusy] = useState(false);
  const [screenShareError, setScreenShareError] = useState<string | null>(null);
  const [screenLookMode, setScreenLookMode] = useState(() => getScreenLookModeEnabled());
  const screenCaptureRef = useRef<SilentScreenCapture | null>(null);
  const screenLookInFlightRef = useRef(false);
  const localVoicePauseRef = useRef(false);
  const chatAbortRef = useRef<AbortController | null>(null);
  const localSpeakingRef = useRef(false);
  const sendingRef = useRef(false);
  const effectiveVoiceMode = voiceOwnedByApp ? voiceMode : localVoiceMode;
  const effectiveMicMuted = voiceOwnedByApp ? !!micMuted : localMicMuted;
  const effectiveVoiceAlive = voiceOwnedByApp
    ? voiceAlive && !effectiveMicMuted
    : !effectiveMicMuted && (localSpeaking || localUserSpeaking || micLevel > 0.08);
  const effectiveVoiceToggleBusy = voiceOwnedByApp ? voiceToggleBusy : localVoiceBusy;
  const effectiveVoiceModeRef = useRef(effectiveVoiceMode);
  effectiveVoiceModeRef.current = effectiveVoiceMode;
  const speakReplyRef = useRef<(text: string) => void>(() => {});
  const submitFromVoiceRef = useRef<(text: string) => void>(() => {});
  const waveBarHeights = useMemo(() => {
    if (effectiveMicMuted) return ['4px', '4px', '4px', '4px', '4px'];
    const L = Math.max(0, Math.min(1, micLevel));
    // Symmetric Copilot-style bars that grow with mic energy.
    const mid = 6 + L * 14;
    const near = 5 + L * 10;
    const edge = 4 + L * 6;
    return [edge, near, mid, near, edge].map((h) => `${Math.round(h)}px`);
  }, [micLevel, effectiveMicMuted]);

  const currentFingerprint = useMemo(
    () => agentThreadFingerprint(messages, cwd, productMode),
    [messages, cwd, productMode],
  );
  const isDirty = currentFingerprint !== savedFingerprint;

  const selectedProviderMeta = useMemo(() => {
    const sendId = resolveSendProvider(cascadeEnabled, agentProvider);
    return AGENT_PROVIDERS.find((p) => p.id === sendId) ?? AGENT_PROVIDERS[0];
  }, [agentProvider, cascadeEnabled]);

  const showContinue = useMemo(() => {
    if (!isCodingProductMode(productMode) || sending) return false;
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
    // Immediate sync so Allow self-edit / API keys hit the host without waiting
    // for the settings debounce (Knowledge reads agent-env.json each write).
    void syncAgentEnvVarsToHost(record);
  }, []);

  const refreshSavedThreads = useCallback(() => {
    setSavedThreads(listSavedAgentThreads());
  }, []);

  const refreshWorkspaceList = useCallback(() => {
    setWorkspaceListTick((n) => n + 1);
  }, []);

  const sidebarWorkspaces = useMemo(() => {
    void workspaceListTick;
    return listAgentWorkspacePaths({
      currentCwd: cwd,
      threadCwds: savedThreads.map((t) => t.cwd).filter(Boolean),
    });
  }, [cwd, savedThreads, workspaceListTick]);

  const refreshCheckpoints = useCallback(async () => {
    try {
      const list = await listAgentCheckpoints();
      setCheckpoints(list);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshSelfEditReview = useCallback(async (opts?: {
    prefer?: SelfEditReview | null;
  }): Promise<number> => {
    try {
      const [one, list] = await Promise.all([fetchSelfEditReview(), listSelfEditReviews()]);
      let reviews = list.reviews || [];
      if (opts?.prefer) {
        reviews = upsertPendingReview(reviews, opts.prefer);
      }
      setPendingReviews(reviews);
      if (one.pending && one.review) {
        setSelfEditReview(one.review);
        return reviews.length;
      }
      if (opts?.prefer) {
        setSelfEditReview(opts.prefer);
        return reviews.length;
      }
      if (reviews.length > 0) {
        const match =
          reviews.find((r) => (r.session_id || '') === AGENT_SESSION_ID) || reviews[0];
        setSelfEditReview(match);
      } else {
        setSelfEditReview(null);
        setReviewFileChanges([]);
      }
      return reviews.length;
    } catch {
      if (opts?.prefer) {
        setSelfEditReview(opts.prefer);
        setPendingReviews((prev) => upsertPendingReview(prev, opts.prefer!));
        return 1;
      }
      return 0;
    }
  }, []);

  const loadReviewChanges = useCallback(async (review: SelfEditReview | null) => {
    if (!review) {
      setReviewFileChanges([]);
      return;
    }
    try {
      const out = await fetchSelfEditReviewChanges({
        sessionId: review.session_id || undefined,
      });
      setReviewFileChanges(Array.isArray(out.changes) ? out.changes : []);
    } catch {
      setReviewFileChanges([]);
    }
  }, []);

  const handleSelectReview = useCallback(
    (review: SelfEditReview) => {
      setSelfEditReview(review);
      setReviewPanelOpen(true);
      void loadReviewChanges(review);
    },
    [loadReviewChanges],
  );

  useEffect(() => {
    if (!embedded) document.documentElement.classList.add('butler-agent-root');
    void refreshCheckpoints();
    void refreshSelfEditReview();
    const retry = window.setTimeout(() => {
      void refreshSelfEditReview();
    }, 2500);
    void (async () => {
      const vars = await fetchAgentEnvVarsFromHost();
      setEnvVarRows(rowsFromRecord(vars));
      await syncAgentEnvVarsToHost(vars);
    })();
    return () => {
      window.clearTimeout(retry);
      if (!embedded) document.documentElement.classList.remove('butler-agent-root');
    };
  }, [embedded, refreshCheckpoints, refreshSelfEditReview]);

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
    } catch {
      /* ignore */
    }
  }, [sidebarOpen, footerOpen, footerTab]);

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
    async (nextPath: string, openExplorer = false, opts?: { skipButlerWarn?: boolean }) => {
      const trimmed = nextPath.trim();
      if (!trimmed) return;
      if (!opts?.skipButlerWarn && looksLikeButlerSourceRoot(trimmed)) {
        const ok = window.confirm(BUTLER_SOURCE_WORKSPACE_WARNING);
        if (!ok) return;
      }
      setCwd(trimmed);
      persistAgentProjectRoot(trimmed);
      rememberAgentWorkspace(trimmed);
      refreshWorkspaceList();
      setExpandedWorkspaces((prev) => {
        const next = new Set(prev);
        next.add(workspaceExpandKey(trimmed));
        persistExpandedWorkspaceKeys([...next]);
        return next;
      });
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
    [refreshCheckpoints, refreshWorkspaceList],
  );

  const setSelfEditEnvFlag = useCallback((on: boolean): Promise<void> => {
    return new Promise((resolve) => {
      setEnvVarRows((prev) => {
        const key = 'BUTLER_ALLOW_SELF_EDIT';
        const others = prev.filter((r) => r.key.trim() !== key);
        const next = on
          ? [
              ...others,
              {
                id: `env-self-edit-${Date.now().toString(36)}`,
                key,
                value: '1',
              },
            ]
          : others;
        const record = recordFromRows(next);
        persistAgentEnvVars(record);
        void syncAgentEnvVarsToHost(record).finally(() => resolve());
        return next;
      });
    });
  }, []);

  const setProductModePersist = useCallback(
    (mode: AgentProductMode) => {
      const prev = productMode;
      setProductMode(mode);
      try {
        localStorage.setItem(AGENT_PRODUCT_MODE_KEY, mode);
      } catch {
        /* ignore */
      }

      if (mode === 'self-edit' && prev !== 'self-edit') {
        try {
          const current = cwd.trim();
          const butlerRoot = defaultButlerSourceRoot();
          if (current && !looksLikeButlerSourceRoot(current)) {
            localStorage.setItem(AGENT_CWD_BEFORE_SELF_EDIT_KEY, current);
          }
          void setSelfEditEnvFlag(true);
          void applyWorkspace(butlerRoot, false, { skipButlerWarn: true });
          setMessages((m) => [
            ...m,
            {
              id: `${Date.now()}-self-edit-on`,
              role: 'assistant',
              content:
                'Self-edit mode ON. Workspace → Butler repo, writes unlocked with Accept/Reject + tests gate. ' +
                'Checkpoint before large changes. Typed/voice turns use the coding agent; only short greetings stay on casual chat.',
              source: 'Agent',
            },
          ]);
        } catch {
          void setSelfEditEnvFlag(true);
        }
        return;
      }

      if (prev === 'self-edit' && mode !== 'self-edit') {
        void setSelfEditEnvFlag(false);
        try {
          const restore = localStorage.getItem(AGENT_CWD_BEFORE_SELF_EDIT_KEY)?.trim();
          localStorage.removeItem(AGENT_CWD_BEFORE_SELF_EDIT_KEY);
          if (restore && !looksLikeButlerSourceRoot(restore)) {
            void applyWorkspace(restore, false, { skipButlerWarn: true });
          }
        } catch {
          /* ignore */
        }
      }
    },
    [applyWorkspace, cwd, productMode, setSelfEditEnvFlag],
  );

  // If Self-edit was last selected, re-assert ALLOW_SELF_EDIT after reload.
  useEffect(() => {
    if (productMode !== 'self-edit') return;
    void setSelfEditEnvFlag(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot sync only
  }, []);

  const restoreThreadState = useCallback(
    (thread: SavedAgentThread) => {
      // Drop legacy welcome seeds so restored threads stay blank until real messages.
      const nextMessages = thread.messages
        .filter((m) => !isAgentWelcomeMessage(m))
        .map((m) => ({ ...m }));
      const nextCwd = thread.cwd?.trim() || defaultAgentProjectRoot();
      const nextMode: AgentProductMode =
        thread.productMode === 'chat' ||
        thread.productMode === 'code' ||
        thread.productMode === 'self-edit'
          ? thread.productMode
          : nextMessages.some((m) => Array.isArray(m.steps) && m.steps.length > 0)
            ? 'code'
            : readProductMode();
      setMessages(nextMessages);
      setCwd(nextCwd);
      persistAgentProjectRoot(nextCwd);
      setProductModePersist(nextMode);
      setLoadedThreadId(thread.id);
      setSavedFingerprint(agentThreadFingerprint(nextMessages, nextCwd, nextMode));
      setLiveSteps([]);
      setRunStatus(null);
      setInput('');
      void applyWorkspace(nextCwd, false);
    },
    [applyWorkspace, setProductModePersist],
  );

  const handleToggleWorkspaceExpand = useCallback((workspacePath: string) => {
    const key = workspaceExpandKey(workspacePath);
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persistExpandedWorkspaceKeys([...next]);
      return next;
    });
  }, []);

  const handleSelectWorkspace = useCallback(
    async (workspacePath: string) => {
      const trimmed = workspacePath.trim();
      if (!trimmed) return;
      const key = workspaceExpandKey(trimmed);
      setExpandedWorkspaces((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        persistExpandedWorkspaceKeys([...next]);
        return next;
      });
      await applyWorkspace(trimmed, false);
    },
    [applyWorkspace],
  );

  const handleAddWorkspace = useCallback(async () => {
    const picked = await browseAgentWorkspace(cwd);
    if (!picked) return;
    await applyWorkspace(picked, false);
  }, [applyWorkspace, cwd]);

  const handleNewThreadInWorkspace = useCallback(
    async (workspacePath: string) => {
      if (isDirty && !confirmDiscardUnsaved()) return;
      const nextCwd = workspacePath.trim() || defaultAgentProjectRoot();
      await applyWorkspace(nextCwd, false);
      setMessages([]);
      setLiveSteps([]);
      setRunStatus(null);
      setInput('');
      setLoadedThreadId(null);
      setSavedFingerprint(agentThreadFingerprint([], nextCwd, productMode));
    },
    [applyWorkspace, isDirty, productMode],
  );

  const [threadSaveNotice, setThreadSaveNotice] = useState<string | null>(null);
  const handleBrowse = useCallback(async () => {
    const picked = await browseAgentWorkspace(cwd);
    if (picked) await applyWorkspace(picked, false);
  }, [applyWorkspace, cwd]);

  const openFooterTab = useCallback((tab: AgentFooterTab) => {
    setFooterTab(tab);
    setFooterOpen(true);
  }, []);





  const appendLiveLog = useCallback((line: string) => {
    const time = new Date().toLocaleTimeString();
    setLiveLog((prev) => [...prev.slice(-49), `[${time}] ${line}`]);
  }, []);

  const triggerDesktopRebuild = useCallback(
    async (fast = true) => {
      if (rebuildBusy) return;
      setRebuildBusy(true);
      openFooterTab('output');
      appendLiveLog(
        fast
          ? 'Starting fast desktop rebuild (vite + asar patch)…'
          : 'Starting full desktop rebuild…',
      );
      try {
        const res = await fetch('/api/butler/rebuild', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fast }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
        const msg = data.message || (data.ok ? 'Rebuild started.' : 'Rebuild failed.');
        appendLiveLog(msg);
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-rebuild`,
            role: 'assistant',
            content: msg,
            source: 'Agent',
            error: !data.ok,
          },
        ]);
      } catch (err) {
        const msg = `Rebuild request failed: ${String((err as Error)?.message || err)}`;
        appendLiveLog(msg);
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-rebuild-err`,
            role: 'assistant',
            content: msg,
            source: 'Agent',
            error: true,
          },
        ]);
      } finally {
        setRebuildBusy(false);
      }
    },
    [appendLiveLog, openFooterTab, rebuildBusy],
  );

  const handleThemeChange = useCallback((prefs: AgentThemePrefs) => {
    setTheme(prefs);
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
        .slice(effectiveVoiceMode ? -6 : -24)
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
      const ac = new AbortController();
      chatAbortRef.current = ac;
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ac.signal,
          body: JSON.stringify({
            sessionId: chatSessionId,
            message: opts.message,
            history,
            localOnly: true,
            voice_conversation: !!effectiveVoiceModeRef.current,
            chat_formality: loadChatFormality(),
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
          open_browser?: boolean;
          openBrowser?: boolean;
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
        if (data.open_browser || data.openBrowser) {
          openAgentBrowserPopout();
        }
        if (effectiveVoiceModeRef.current && replyText && replyText !== '…') {
          speakReplyRef.current(replyText);
        }
        return data;
      } finally {
        if (chatAbortRef.current === ac) chatAbortRef.current = null;
      }
    },
    [chatSessionId],
  );

  const latestScreenAttach = useCallback((): ChatAttach | null => {
    const cap = screenCaptureRef.current;
    if (!cap?.isActive()) return null;
    const frame = cap.getLatestFrame();
    return frame ? screenFrameToAttach(frame) : null;
  }, []);

  const stopScreenShare = useCallback(async () => {
    const cap = screenCaptureRef.current;
    screenCaptureRef.current = null;
    setScreenSharing(false);
    setScreenShareError(null);
    if (cap) {
      try {
        await cap.stop();
      } catch {
        /* */
      }
    }
  }, []);

  const startScreenShare = useCallback(async () => {
    if (screenCaptureRef.current?.isActive()) {
      setScreenSharing(true);
      return;
    }
    setScreenShareBusy(true);
    setScreenShareError(null);
    try {
      await screenCaptureRef.current?.stop();
      const cap = new SilentScreenCapture({
        maxSide: 896,
        quality: 0.55,
        intervalMs: 280,
        onStopped: () => {
          if (screenCaptureRef.current === cap) {
            screenCaptureRef.current = null;
            setScreenSharing(false);
          }
        },
        onError: (err) => {
          setScreenShareError(err.message || 'Screen capture failed');
        },
      });
      screenCaptureRef.current = cap;
      await cap.start();
      setScreenSharing(true);
    } catch (err) {
      screenCaptureRef.current = null;
      setScreenSharing(false);
      const msg = err instanceof Error ? err.message : String(err);
      setScreenShareError(msg.trim() || 'Could not start screen share');
    } finally {
      setScreenShareBusy(false);
    }
  }, []);

  const handleToggleScreenShare = useCallback(() => {
    if (screenSharing || screenCaptureRef.current?.isActive()) {
      void stopScreenShare();
      return;
    }
    void startScreenShare();
  }, [screenSharing, startScreenShare, stopScreenShare]);

  useEffect(() => {
    return () => {
      void screenCaptureRef.current?.stop();
      screenCaptureRef.current = null;
    };
  }, []);

  useEffect(() => subscribeScreenAssistPrefs(() => setScreenLookMode(getScreenLookModeEnabled())), []);

  // Optional idle glance — default off. Never runs every video frame.
  useEffect(() => {
    if (!screenSharing || !screenLookMode) return;
    const tick = () => {
      if (screenLookInFlightRef.current || sendingRef.current) return;
      const frame = screenCaptureRef.current?.getLatestFrame();
      if (!frame?.dataUrl) return;
      const parsed = parseComposerDataUrl(frame.dataUrl);
      if (!parsed?.base64) return;
      screenLookInFlightRef.current = true;
      void fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: chatSessionId,
          message:
            'Glance only: one short clause naming the main app/UI on screen. No advice unless asked.',
          history: [],
          localOnly: true,
          init_image: parsed.base64,
        }),
      })
        .catch(() => undefined)
        .finally(() => {
          screenLookInFlightRef.current = false;
        });
    };
    const id = window.setInterval(tick, SCREEN_LOOK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [screenSharing, screenLookMode, chatSessionId]);

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
          attachment: attachment || latestScreenAttach(),
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
    [messages, runChatRequest, setProductModePersist, latestScreenAttach],
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
      /** Voice chat → code agent: speak checklist once + final reply only (no tool noise). */
      voiceCodingHandoff?: boolean;
    }) => {
      const providerLabel = selectedProviderMeta.label;
      const voiceHandoff = Boolean(opts.voiceCodingHandoff);
      let checklistSpoken = false;
      const AUTO_CONTINUE_MAX = 4;
      const ac = new AbortController();
      try {
        chatAbortRef.current?.abort();
      } catch {
        /* */
      }
      chatAbortRef.current = ac;
      setCancelRequested(false);
      setActiveModelLabel(providerLabel);
      setRunStatus({
        status: 'starting',
        message: opts.statusLabel || `Starting agent (${providerLabel})…`,
        iteration: 0,
        max_iterations: 48,
        model_source: providerLabel,
      });
      setLiveSteps([]);
      setLiveTodos([]);
      agentShellSeenRef.current.clear();
      persistAgentProjectRoot(cwd);
      const sendProvider = resolveSendProvider(cascadeEnabled, agentProvider);

      const onProgress = (st: AgentRunStatus) => {
        setRunStatus(st);
        if (st.model_source) setActiveModelLabel(st.model_source);
        else if (st.model_used) setActiveModelLabel(st.model_used);
        if (Array.isArray(st.todos) && st.todos.length > 0) {
          setLiveTodos(st.todos as AgentTodo[]);
          if (voiceHandoff && effectiveVoiceModeRef.current && !checklistSpoken) {
            checklistSpoken = true;
            const checklist = formatTodosChecklistSpeech(st.todos as AgentTodo[]);
            if (checklist) speakReplyRef.current(checklist);
          }
        }
        if (Array.isArray(st.steps) && st.steps.length > 0) {
          setLiveSteps(st.steps);
          // Mirror agent shell tools into the Terminal panel (live stdout while running).
          for (const step of st.steps) {
            const tool = String(step.tool || '').toLowerCase();
            if (tool !== 'run_shell' && tool !== 'run_command') continue;
            const cmd = String(step.args?.command || '').trim();
            if (!cmd) continue;
            const stepKey = `agent-shell-${step.iteration ?? 0}-${tool}-${cmd.slice(0, 80)}`;
            const result = step.result || {};
            const stdout = String(result.stdout || '');
            const stderr = String(result.stderr || '');
            const running = Boolean(step.in_progress);
            const cwdPath = String(step.args?.cwd || st.project_root || cwd || '').trim();
            setFooterOpen(true);
            setFooterTab('terminal');
            setTerminalEntries((prev) => {
              const existing = prev.find((e) => e.id === stepKey);
              if (!existing && !agentShellSeenRef.current.has(stepKey)) {
                agentShellSeenRef.current.add(stepKey);
              }
              const nextEntry: TerminalEntry = {
                id: stepKey,
                command: cmd,
                cwd: cwdPath || existing?.cwd || cwd,
                source: 'agent',
                shellLabel: 'Agent',
                running,
                liveStdout: running ? stdout || stderr : undefined,
                result: running
                  ? undefined
                  : {
                      ok: result.ok !== false && !result.error,
                      command: cmd,
                      cwd: cwdPath || existing?.cwd || cwd,
                      stdout,
                      stderr,
                      code:
                        typeof result.exit_code === 'number'
                          ? result.exit_code
                          : result.ok === false
                            ? 1
                            : 0,
                      message: result.error ? String(result.error) : undefined,
                    },
              };
              if (existing) {
                return prev.map((e) => (e.id === stepKey ? { ...e, ...nextEntry } : e));
              }
              return [nextEntry, ...prev].slice(0, 80);
            });
          }
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
      };

      let data: Awaited<ReturnType<typeof sendAgentTurn>> | null = null;
      let mergedSteps: AgentToolStep[] = [];
      let lastTodos: AgentTodo[] | undefined;
      let replyText = 'Done.';
      let needsContinue = false;
      let round = 0;

      while (round <= AUTO_CONTINUE_MAX) {
        if (ac.signal.aborted) {
          throw new DOMException('Agent turn aborted', 'AbortError');
        }
        const isContinue = Boolean(opts.continue) || round > 0;
        if (round > 0) {
          setRunStatus({
            status: 'starting',
            message: `Auto-continuing (${round}/${AUTO_CONTINUE_MAX})…`,
            iteration: 0,
            max_iterations: 48,
            model_source: providerLabel,
          });
        }
        data = await sendAgentTurn(
          {
            message: opts.message,
            history: opts.history,
            cwd,
            localOnly: sendProvider === 'local',
            provider: sendProvider,
            apiKeys,
            continue: isContinue,
            signal: ac.signal,
          },
          onProgress,
        );
        const steps = Array.isArray(data.agent_steps) ? data.agent_steps : [];
        mergedSteps = [...mergedSteps, ...steps];
        if (Array.isArray(data.todos) && data.todos.length > 0) {
          lastTodos = data.todos as AgentTodo[];
        }
        replyText = unwrapAgentReply(String(data.reply || '').trim()) || 'Done.';
        needsContinue =
          Boolean(data.needs_continue) || looksLikeIncompleteAgentReply(replyText, steps);
        if (!needsContinue || round >= AUTO_CONTINUE_MAX) break;
        round += 1;
      }

      if (!data) {
        throw new Error('Agent returned no response');
      }

      const assistantMsg: AgentChatMessage = {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        content: replyText,
        source: data.source || (voiceHandoff ? 'Butler' : 'Agent'),
        steps: mergedSteps.length > 0 ? mergedSteps : undefined,
        todos: lastTodos,
        needsContinue,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setLiveSteps([]);
      setLiveTodos([]);
      setRunStatus(null);
      if (data.source) setActiveModelLabel(data.source);
      void refreshCheckpoints();
      if (data.needs_review && data.self_edit_review) {
        setSelfEditReview(data.self_edit_review);
        setPendingReviews((prev) => upsertPendingReview(prev, data.self_edit_review!));
        void loadReviewChanges(data.self_edit_review);
        // Prefer the turn payload so a slow/empty list API cannot wipe Reviews.
        void refreshSelfEditReview({ prefer: data.self_edit_review });
      } else {
        void refreshSelfEditReview();
      }
      if (voiceHandoff && effectiveVoiceModeRef.current) {
        if (data.needs_review) {
          speakReplyRef.current(
            data.self_edit_review?.voice_hint || 'Review the diffs when you are ready',
          );
        } else if (replyText) {
          speakReplyRef.current(replyText);
        }
      }
      return { ...data, agent_steps: mergedSteps, needs_continue: needsContinue, reply: replyText };
    },
    [
      cwd,
      refreshCheckpoints,
      refreshSelfEditReview,
      loadReviewChanges,
      agentProvider,
      cascadeEnabled,
      apiKeys,
      selectedProviderMeta,
    ],
  );

  const sendPrompt = useCallback(
    async (raw: string, opts?: { clearInput?: boolean }) => {
      const trimmed = raw.trim();
      const attach = chatAttachment || latestScreenAttach();
      if (!trimmed && !attach) return;
      // If currently sending, queue the message instead
      if (sending) {
        if (trimmed) setMessageQueue((prev) => [...prev, trimmed]);
        if (opts?.clearInput !== false) setInput('');
        return;
      }
      if (looksLikeOpenBrowserAsk(trimmed) && !chatAttachment && !latestScreenAttach()) {
        stickChatToBottomRef.current = true;
        const userMsg: AgentChatMessage = {
          id: String(Date.now()),
          role: 'user',
          content: trimmed,
        };
        const assistantMsg: AgentChatMessage = {
          id: `${Date.now()}-browser`,
          role: 'assistant',
          content: OPEN_BROWSER_CHAT_REPLY,
          source: 'Butler',
        };
        if (opts?.clearInput !== false) setInput('');
        setChatAttachment(null);
        setMessages((prev) => [...prev, userMsg, assistantMsg]);
        openAgentBrowserPopout();
        requestAnimationFrame(() => inputRef.current?.focus());
        return;
      }
      stickChatToBottomRef.current = true;
      cancelledMessageRef.current = trimmed || (attach ? `(image: ${attach.name})` : '');
      const userMsg: AgentChatMessage = {
        id: String(Date.now()),
        role: 'user',
        content: trimmed || (attach ? `📷 ${attach.name}` : ''),
      };
      if (opts?.clearInput !== false) setInput('');
      setChatAttachment(null);
      setMessages((prev) => [...prev, userMsg]);
      setSending(true);
      try {
        const history = messages.filter((m) => m.id !== 'welcome');
        const screenCtx =
          !!attach &&
          !chatAttachment &&
          !!screenCaptureRef.current?.isActive() &&
          attach.name === 'live-screen.jpg';
        const selfEditAsk = looksLikeSelfEditAsk(trimmed);
        const codingAsk = looksLikeCodingTask(trimmed) || selfEditAsk;
        const purePhatic = looksLikePurePhatic(trimmed);
        // Self-edit / Code default to the coding agent. Chat mode stays casual unless
        // voice hands off a coding ask. Only narrow phatic stays on /api/chat in Self-edit.
        const useChatPath =
          productMode === 'chat' ||
          (productMode === 'self-edit' && purePhatic) ||
          (productMode !== 'self-edit' && screenCtx && !codingAsk);
        if (useChatPath) {
          const voiceCoding =
            !!effectiveVoiceModeRef.current && codingAsk;
          if (voiceCoding) {
            if (selfEditAsk && productMode !== 'self-edit') {
              setProductModePersist('self-edit');
            }
            await runAgentRequest({
              message: trimmed || (attach ? `I attached an image: ${attach.name}` : ''),
              history,
              statusLabel: `Starting coding agent (${selectedProviderMeta.label})…`,
              voiceCodingHandoff: true,
            });
          } else {
            await runChatRequest({
              message: trimmed || 'What do you see in this image?',
              history,
              attachment: attach,
            });
          }
        } else {
          if (selfEditAsk && productMode === 'code') {
            setProductModePersist('self-edit');
          }
          await runAgentRequest({
            message: trimmed || (attach ? `I attached an image: ${attach.name}` : ''),
            history,
            statusLabel: `Starting agent (${selectedProviderMeta.label})…`,
            voiceCodingHandoff: !!effectiveVoiceModeRef.current,
          });
        }
      } catch (err) {
        const aborted =
          (err instanceof DOMException && err.name === 'AbortError') ||
          (typeof (err as { name?: string })?.name === 'string' &&
            (err as { name: string }).name === 'AbortError') ||
          /abort/i.test(String((err as { message?: string })?.message || ''));
        if (aborted) {
          setRunStatus(null);
          setLiveSteps([]);
          setLiveTodos([]);
          return;
        }
        const errRaw = err instanceof Error ? err.message : String(err);
        const msg =
          (errRaw || '').trim() && !/^\{?\s*"?error"?\s*:\s*""/.test(errRaw.trim())
            ? errRaw.trim()
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
        if (effectiveVoiceModeRef.current && msg) speakReplyRef.current(msg);
      } finally {
        setSending(false);
        setCancelRequested(false);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    },
    [
      sending,
      messages,
      productMode,
      runChatRequest,
      runAgentRequest,
      selectedProviderMeta,
      chatAttachment,
      latestScreenAttach,
      setProductModePersist,
    ],
  );

  const handleSend = useCallback(async () => {
    await sendPrompt(input);
  }, [input, sendPrompt]);

  const submitFromVoice = useCallback(
    (text: string) => {
      // Keep Self-edit / Code mode across voice turns — do NOT force Chat
      // (that used to clear BUTLER_ALLOW_SELF_EDIT mid-conversation).
      const trimmed = text.trim();
      if (!trimmed) return;
      // While Butler is still speaking, ignore STT echo / bleed. Real barge-in
      // cancels TTS first (onBargeInStart), then the transcript arrives.
      if (localSpeakingRef.current || isNeuralSpeaking()) {
        return;
      }
      if (looksLikeOpenBrowserAsk(trimmed)) {
        stickChatToBottomRef.current = true;
        const userMsg: AgentChatMessage = {
          id: String(Date.now()),
          role: 'user',
          content: trimmed,
        };
        const assistantMsg: AgentChatMessage = {
          id: `${Date.now()}-browser`,
          role: 'assistant',
          content: OPEN_BROWSER_CHAT_REPLY,
          source: 'Butler',
        };
        setMessages((prev) => [...prev, userMsg, assistantMsg]);
        openAgentBrowserPopout();
        return;
      }
      // Barge-in while a turn is in flight: abort chat TTS/request when possible.
      if (sending) {
        cancelNeuralSpeech();
        setLocalSpeaking(false);
        try {
          chatAbortRef.current?.abort();
        } catch {
          /* */
        }
      }
      stickChatToBottomRef.current = true;
      const userMsg: AgentChatMessage = {
        id: String(Date.now()),
        role: 'user',
        content: trimmed,
      };
      setMessages((prev) => [...prev, userMsg]);
      setSending(true);
      const selfEditAsk = looksLikeSelfEditAsk(trimmed);
      const coding = looksLikeCodingTask(trimmed) || selfEditAsk;
      const purePhatic = looksLikePurePhatic(trimmed);
      const useAgent = isCodingProductMode(productMode) ? !purePhatic : coding;
      const history = messages.filter((m) => m.id !== 'welcome');
      const screenAttach = latestScreenAttach();
      void (async () => {
        try {
          if (useAgent) {
            if (selfEditAsk && productMode !== 'self-edit') {
              setProductModePersist('self-edit');
            }
            await runAgentRequest({
              message: trimmed,
              history,
              statusLabel: `Starting coding agent (${selectedProviderMeta.label})…`,
              voiceCodingHandoff: true,
            });
          } else {
            await runChatRequest({
              message: trimmed,
              history,
              attachment: screenAttach,
            });
          }
        } catch (err) {
          const aborted =
            (err instanceof Error && err.name === 'AbortError') ||
            (typeof (err as { message?: string })?.message === 'string' &&
              /abort/i.test(String((err as { message?: string }).message)));
          if (aborted) return;
          const errRaw = err instanceof Error ? err.message : String(err);
          const msg =
            (errRaw || '').trim() && !/^\{?\s*"?error"?\s*:\s*""/.test(errRaw.trim())
              ? errRaw.trim()
              : useAgent
                ? 'Coding agent failed with an empty error.'
                : 'Chat failed with an empty error.';
          setMessages((prev) => [
            ...prev,
            {
              id: `${Date.now()}-err`,
              role: 'assistant',
              content: msg,
              error: true,
              source: useAgent ? 'Agent' : 'Butler',
            },
          ]);
          setRunStatus(null);
          setLiveSteps([]);
          setLiveTodos([]);
          if (effectiveVoiceModeRef.current && msg) speakReplyRef.current(msg);
        } finally {
          setSending(false);
        }
      })();
    },
    [
      sending,
      messages,
      productMode,
      runChatRequest,
      runAgentRequest,
      setProductModePersist,
      selectedProviderMeta,
      latestScreenAttach,
    ],
  );
  submitFromVoiceRef.current = submitFromVoice;

  const speakAgentReply = useCallback(
    (text: string) => {
      if (voiceOwnedByApp) {
        onSpeakReply?.(text);
        return;
      }
      if (!text?.trim() || typeof window === 'undefined') return;
      cancelNeuralSpeech();
      setLocalSpeaking(false);
      void speakNeural(text, {
        onStart: () => setLocalSpeaking(true),
        onEnd: () => setLocalSpeaking(false),
        onError: (err) => {
          console.warn('[Butler speakAgentReply]', err?.message || err);
          setLocalSpeaking(false);
        },
      });
    },
    [voiceOwnedByApp, onSpeakReply],
  );
  speakReplyRef.current = speakAgentReply;

  useEffect(() => {
    if (!onRegisterVoiceSink) return;
    // Voice sink: Chat presentation; coding asks hand off to Code agent under the hood.
    onRegisterVoiceSink(submitFromVoice);
    return () => onRegisterVoiceSink(null);
  }, [onRegisterVoiceSink, submitFromVoice]);

  useEffect(() => {
    onVoiceBusyChange?.(sending);
  }, [sending, onVoiceBusyChange]);

  useEffect(() => {
    // Mute pauses STT / barge-in; keep mic open otherwise so the user can interrupt TTS.
    localVoicePauseRef.current = localMicMuted;
    localSpeakingRef.current = localSpeaking;
    sendingRef.current = sending;
  }, [sending, localSpeaking, localMicMuted]);

  useEffect(() => {
    if (effectiveVoiceMode) return;
    setLocalMicMuted(false);
    // Reveal transcript after voice call — land at the latest messages.
    stickChatToBottomRef.current = true;
    requestAnimationFrame(() => {
      threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }, [effectiveVoiceMode]);

  useEffect(() => {
    if (voiceOwnedByApp) return;
    let cancelled = false;
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((s: { voiceMode?: boolean }) => {
        if (!cancelled && s?.voiceMode) setLocalVoiceMode(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [voiceOwnedByApp]);

  useEffect(() => {
    if (voiceOwnedByApp || !localVoiceMode) {
      setLocalUserSpeaking(false);
      setMicLevel(0);
      return;
    }
    const ac = new AbortController();
    const stopInner = startVoiceModePcmAutoListen({
      shouldPause: () => localVoicePauseRef.current,
      elevatedThreshold: () => localSpeakingRef.current || isNeuralSpeaking(),
      onBargeInStart: () => {
        cancelNeuralSpeech();
        setLocalSpeaking(false);
        try {
          chatAbortRef.current?.abort();
        } catch {
          /* */
        }
      },
      onTranscript: (text) => submitFromVoiceRef.current(text),
      signal: ac.signal,
      onUtteranceActive: (active) => setLocalUserSpeaking(active),
      onLevel: (level) => setMicLevel(level),
      onMicAccessFailed: (msg) => setSpeechError(msg),
      onSttFailed: (msg) => setSpeechError(`Speech-to-text: ${msg}`),
    });
    return () => {
      ac.abort();
      stopInner();
      setLocalUserSpeaking(false);
      setMicLevel(0);
    };
  }, [voiceOwnedByApp, localVoiceMode]);

  /** When App owns STT, still meter the mic so the waveform reacts. */
  useEffect(() => {
    if (!voiceOwnedByApp || !voiceMode) {
      if (voiceOwnedByApp) setMicLevel(0);
      return;
    }
    let cancelled = false;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let raf = 0;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (cancelled) return;
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i]! - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          setMicLevel(Math.max(0, Math.min(1, (rms - 0.02) / 0.25)));
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        /* mic already requested by App voice loop */
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      void ctx?.close();
      stream?.getTracks().forEach((t) => t.stop());
      setMicLevel(0);
    };
  }, [voiceOwnedByApp, voiceMode]);

  const handleToggleVoiceMode = useCallback(() => {
    if (voiceOwnedByApp) {
      // Do not force Chat — preserves Self-edit / Code + BUTLER_ALLOW_SELF_EDIT.
      onToggleVoiceMode?.();
      return;
    }
    const next = !localVoiceMode;
    if (!next) {
      setLocalVoiceMode(false);
      setLocalMicMuted(false);
      setLocalSpeaking(false);
      setMicLevel(0);
      cancelNeuralSpeech();
      void fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceMode: false }),
      }).catch(() => {});
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setSpeechError('No microphone API here. Use the Butler desktop app.');
      return;
    }
    setLocalVoiceBusy(true);
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        setSpeechError(null);
        // Keep current product mode (Self-edit/Code) when starting voice.
        setLocalMicMuted(false);
        setLocalVoiceMode(true);
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voiceMode: true }),
        }).catch(() => {});
      } catch (err) {
        const name =
          err && typeof err === 'object' && 'name' in err ? String((err as DOMException).name) : '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setSpeechError('Microphone blocked. Allow mic access for Butler.');
        } else if (name === 'NotFoundError') {
          setSpeechError('No microphone found.');
        } else {
          setSpeechError('Could not access the microphone.');
        }
      } finally {
        setLocalVoiceBusy(false);
      }
    })();
  }, [voiceOwnedByApp, onToggleVoiceMode, localVoiceMode]);

  const handleToggleMicMute = useCallback(() => {
    if (voiceOwnedByApp) {
      onToggleMicMute?.();
      return;
    }
    setLocalMicMuted((m) => !m);
  }, [voiceOwnedByApp, onToggleMicMute]);

  /** Waveform: start voice when off; mute/unmute mic while in voice mode (exit is End voice chat). */
  const handleWaveformClick = useCallback(() => {
    if (!effectiveVoiceMode) {
      handleToggleVoiceMode();
      return;
    }
    handleToggleMicMute();
  }, [effectiveVoiceMode, handleToggleVoiceMode, handleToggleMicMute]);

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
        // When turning off speech-to-text, transcribe any captured audio and populate the input
        try {
          const text = await transcribePcmViaButler(pcm, sampleRate);
          setInput((prev) => (prev ? `${prev} ${text}` : text).trim());
        } catch {
          // If transcription fails, just clear and focus
        }
        setSpeechError(null);
        requestAnimationFrame(() => inputRef.current?.focus());
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

  const handleRevertLastCheckpoint = useCallback(async () => {
    const latest = checkpoints[0];
    if (!latest?.id) {
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-cp-empty`,
          role: 'assistant',
          content: 'No checkpoints yet. Auto-checkpoints run before file edits, or save one in Settings.',
          source: 'Agent',
        },
      ]);
      return;
    }
    const label = latest.file_count
      ? `${latest.id} (${latest.file_count} file${latest.file_count === 1 ? '' : 's'})`
      : latest.id;
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Revert to latest checkpoint?\n\n${label}${latest.reason ? `\n${latest.reason}` : ''}`)
    ) {
      return;
    }
    await handleRevert(latest.id);
  }, [checkpoints]);

  const handleAcceptSelfEdit = useCallback(async (opts?: { force?: boolean }) => {
    const force = Boolean(opts?.force);
    if (
      force &&
      typeof window !== 'undefined' &&
      !window.confirm(
        'Accept these self-edit changes without tests?\n\n' +
          'Product behavior may be untested. Prefer adding tests when you can.',
      )
    ) {
      return;
    }
    setSelfEditReviewBusy(true);
    try {
      const out = await acceptSelfEditReview({
        force,
        sessionId: selfEditReview?.session_id || undefined,
      });
      if (!out.ok) {
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-self-edit-accept`,
            role: 'assistant',
            content: out.message || out.error || 'Accept blocked — tests required.',
            source: 'Agent',
            error: true,
          },
        ]);
        if (out.review) setSelfEditReview(out.review);
        return;
      }
      setSelfEditReview(null);
      setPendingReviews([]);
      setReviewFileChanges([]);
      setReviewPanelOpen(false);
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-self-edit-accept`,
          role: 'assistant',
          content: force
            ? 'Self-edit changes accepted (tests override).'
            : 'Self-edit changes accepted.',
          source: 'Agent',
        },
      ]);
      await refreshCheckpoints();
      await refreshSelfEditReview();
    } finally {
      setSelfEditReviewBusy(false);
    }
  }, [refreshCheckpoints, refreshSelfEditReview, selfEditReview?.session_id]);

  const handleRejectSelfEdit = useCallback(async () => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Reject & revert self-edit changes to the pre-edit checkpoint?')
    ) {
      return;
    }
    setSelfEditReviewBusy(true);
    try {
      const out = await rejectSelfEditReview({
        sessionId: selfEditReview?.session_id || undefined,
      });
      const restored = out.restored?.length || 0;
      const deleted = out.deleted?.length || 0;
      setSelfEditReview(null);
      setPendingReviews([]);
      setReviewFileChanges([]);
      setReviewPanelOpen(false);
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-self-edit-reject`,
          role: 'assistant',
          content: out.ok
            ? `Self-edit rejected — restored ${restored} file${restored === 1 ? '' : 's'}${
                deleted ? `, deleted ${deleted} new file${deleted === 1 ? '' : 's'}` : ''
              }.`
            : `Reject failed: ${out.error || (out.errors || []).join('; ') || 'unknown error'}`,
          source: 'Agent',
          error: !out.ok,
        },
      ]);
      await refreshCheckpoints();
      await refreshSelfEditReview();
    } finally {
      setSelfEditReviewBusy(false);
    }
  }, [refreshCheckpoints, refreshSelfEditReview, selfEditReview?.session_id]);

  const handleSaveThread = () => {
    if (!agentThreadHasContent(messages)) {
      setThreadSaveNotice('Nothing to save yet — send a message first.');
      window.setTimeout(() => setThreadSaveNotice(null), 3200);
      return;
    }
    try {
      const existing = loadedThreadId
        ? savedThreads.find((t) => t.id === loadedThreadId)
        : undefined;
      // Electron often stubs window.prompt → null (which used to abort save). Auto-title instead.
      const saved = saveAgentThread({
        id: loadedThreadId,
        title: existing?.title,
        cwd,
        messages,
        productMode,
      });
      rememberAgentWorkspace(cwd);
      refreshWorkspaceList();
      setLoadedThreadId(saved.id);
      setSavedFingerprint(agentThreadFingerprint(messages, cwd, productMode));
      refreshSavedThreads();
      setThreadSaveNotice(
        `Saved ${
          productMode === 'chat' ? 'chat' : productMode === 'self-edit' ? 'self-edit' : 'code'
        } thread “${saved.title}”`,
      );
      window.setTimeout(() => setThreadSaveNotice(null), 2800);
    } catch (err) {
      setThreadSaveNotice(
        `Could not save thread: ${err instanceof Error ? err.message : String(err)}`,
      );
      window.setTimeout(() => setThreadSaveNotice(null), 4200);
    }
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
    if (!last) {
      return `Persistent ${terminalShellLabel} session — cwd sticks; agent shell tools stream here.`;
    }
    if (last.running) return `Running: ${last.command}`;
    if (last.result?.ok) return `Last command finished in ${last.result.duration_ms ?? 0} ms.`;
    return 'Last command exited with an error code.';
  })();

  const applyShellInfo = useCallback((info: {
    shell?: string;
    shell_label?: string;
    shells?: AgentShellInfo[];
  }) => {
    if (Array.isArray(info.shells) && info.shells.length) setTerminalShells(info.shells);
    if (info.shell_label) setTerminalShellLabel(info.shell_label);
    else if (info.shell) {
      const hit = (info.shells || terminalShells).find((s) => s.id === info.shell);
      setTerminalShellLabel(hit?.label || info.shell);
    }
  }, [terminalShells]);

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
    setTerminalEntries((prev) =>
      [
        {
          id,
          command,
          cwd: sessionCwd,
          running: true,
          liveStdout: '',
          source: 'user' as const,
          shellLabel: terminalShellLabel,
        },
        ...prev,
      ].slice(0, 80),
    );
    setTerminalCommand('');
    try {
      const result = await runAgentTerminalCommand({
        cwd: sessionCwd,
        command,
        shell: terminalShellId,
        stream: true,
        onChunk: (text) => {
          setTerminalEntries((prev) =>
            prev.map((entry) =>
              entry.id === id
                ? { ...entry, liveStdout: `${entry.liveStdout || ''}${text}` }
                : entry,
            ),
          );
        },
      });
      if (result.shell_label) setTerminalShellLabel(result.shell_label);
      else if (result.shell) {
        const hit = terminalShells.find((s) => s.id === result.shell);
        setTerminalShellLabel(hit?.label || result.shell);
      }
      if (result.cwd) setTerminalSessionCwd(result.cwd);
      setTerminalEntries((prev) =>
        prev.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                running: false,
                liveStdout: undefined,
                cwd: result.cwd || entry.cwd,
                result,
              }
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
                liveStdout: undefined,
                result: {
                  ok: false,
                  command,
                  cwd: sessionCwd,
                  stdout: entry.liveStdout || '',
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
  }, [cwd, terminalBusy, terminalCommand, terminalSessionCwd, terminalShellId, terminalShellLabel, terminalShells]);

  const handleResetTerminal = useCallback(async () => {
    const nextCwd = cwd.trim() || defaultAgentProjectRoot();
    setTerminalBusy(true);
    try {
      const info = await resetAgentTerminal({ cwd: nextCwd, shell: terminalShellId });
      applyShellInfo(info);
      setTerminalSessionCwd(info.cwd || nextCwd);
      setTerminalEntries((prev) => prev.filter((e) => e.source === 'agent'));
    } catch {
      /* ignore */
    } finally {
      setTerminalBusy(false);
    }
  }, [applyShellInfo, cwd, terminalShellId]);

  const handleTerminalShellChange = useCallback(
    async (shellId: string) => {
      if (!shellId || shellId === terminalShellId || terminalBusy) return;
      setTerminalShellId(shellId);
      try {
        localStorage.setItem('butler_agent_terminal_shell', shellId);
      } catch {
        /* ignore */
      }
      const nextCwd = terminalSessionCwd.trim() || cwd.trim() || defaultAgentProjectRoot();
      setTerminalBusy(true);
      try {
        const info = await resetAgentTerminal({ cwd: nextCwd, shell: shellId });
        applyShellInfo(info);
        const hit = terminalShells.find((s) => s.id === shellId);
        if (hit) setTerminalShellLabel(hit.label);
      } catch {
        /* ignore */
      } finally {
        setTerminalBusy(false);
      }
    },
    [applyShellInfo, cwd, terminalBusy, terminalSessionCwd, terminalShellId, terminalShells],
  );

  useEffect(() => {
    void Promise.all([fetchAgentTerminalInfo(terminalShellId), fetchAgentTerminalShells()]).then(
      ([info, shells]) => {
        if (shells.length) setTerminalShells(shells);
        applyShellInfo({ ...info, shells: shells.length ? shells : info.shells });
        if (info.cwd) setTerminalSessionCwd(info.cwd);
        const preferred = shells.find((s) => s.id === terminalShellId && s.available);
        if (!preferred) {
          const fallback =
            shells.find((s) => s.id === 'pwsh' && s.available) ||
            shells.find((s) => s.id === 'powershell' && s.available) ||
            shells.find((s) => s.available);
          if (fallback && fallback.id !== terminalShellId) {
            setTerminalShellId(fallback.id);
            setTerminalShellLabel(fallback.label);
            try {
              localStorage.setItem('butler_agent_terminal_shell', fallback.id);
            } catch {
              /* ignore */
            }
          }
        }
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once
  }, []);

  useEffect(() => {
    setTerminalSessionCwd(cwd.trim() || defaultAgentProjectRoot());
    void resetAgentTerminal({
      cwd: cwd.trim() || defaultAgentProjectRoot(),
      shell: terminalShellId,
    }).then((info) => {
      applyShellInfo(info);
    });
    // Intentionally omit terminalShellId — shell changes use handleTerminalShellChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    try {
      chatAbortRef.current?.abort();
    } catch {
      /* */
    }
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
      }${splitView ? ' agent-window--split' : ''}${
        effectiveVoiceMode ? ' agent-window--voice-mode' : ''
      }${
        effectiveVoiceMode && localSpeaking
          ? ' agent-window--voice-speaking'
          : effectiveVoiceMode && (localUserSpeaking || micLevel > 0.12)
            ? ' agent-window--voice-user'
            : effectiveVoiceMode && effectiveVoiceAlive
              ? ' agent-window--voice-alive'
              : ''
      }`}
      data-agent-theme={theme.mode}
      data-agent-accent={theme.accent}
    >
      <AgentSidebar
          open={sidebarOpen}
          widthPx={sidebarWidthPx}
          sidebarRef={sidebarRef}
          isDirty={isDirty}
          threadSearch={threadSearch}
          onThreadSearchChange={setThreadSearch}
          searchOpen={searchOpen}
          onToggleSearch={() => setSearchOpen((v) => !v)}
          workspaces={sidebarWorkspaces}
          activeCwd={cwd}
          expandedWorkspaces={expandedWorkspaces}
          onToggleWorkspaceExpand={handleToggleWorkspaceExpand}
          onSelectWorkspace={(path) => void handleSelectWorkspace(path)}
          onAddWorkspace={() => void handleAddWorkspace()}
          onNewThreadInWorkspace={(path) => void handleNewThreadInWorkspace(path)}
          savedThreads={savedThreads}
          loadedThreadId={loadedThreadId}
          editingTitleId={editingTitleId}
          editingTitleValue={editingTitleValue}
          onEditingTitleValueChange={setEditingTitleValue}
          onOpenMcp={() => setMcpOpen(true)}
          onOpenSpotify={() => setSpotifyOpen(true)}
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
          saveNotice={threadSaveNotice}
          sending={sending}
          mcpCount={mcpCount}
          pendingReviews={pendingReviews}
          activeReviewId={
            selfEditReview?.review_id ||
            selfEditReview?.session_id ||
            selfEditReview?.checkpoint_id ||
            selfEditReview?.run_id ||
            null
          }
          onSelectReview={handleSelectReview}
          embedded={embedded}
          splitView={splitView}
          onBack={onBack}
          onEnterSplit={onEnterSplit}
          onExitSplit={onExitSplit}
          standalone={standalone}
          onPopOut={onPopOut}
          onPopIn={onPopIn}
        />
      {sidebarOpen ? (
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
        {effectiveVoiceMode ? (
          <div className="agent-window__voice-aura" aria-hidden>
            <span className="agent-window__voice-aura-wash agent-window__voice-aura-wash--butler">
              <span className="agent-window__voice-aura-bloom" />
            </span>
            <span className="agent-window__voice-aura-wash agent-window__voice-aura-wash--mid">
              <span className="agent-window__voice-aura-bloom" />
            </span>
            <span className="agent-window__voice-aura-wash agent-window__voice-aura-wash--user">
              <span className="agent-window__voice-aura-bloom" />
            </span>
          </div>
        ) : null}
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
            <button
              type="button"
              role="tab"
              aria-selected={productMode === 'self-edit'}
              className={`agent-mode-tab agent-mode-tab--self-edit${
                productMode === 'self-edit' ? ' agent-mode-tab--active' : ''
              }`}
              onClick={() => setProductModePersist('self-edit')}
              title="Edit Butler's own repo (enables self-edit + Accept/Reject)"
            >
              Self-edit
            </button>
          </div>
          <div className="agent-chrome-meta">
            {isCodingProductMode(productMode) ? (
              <span className="agent-chrome-path" title={cwd}>
                {productMode === 'self-edit' ? `Self-edit · ${workspaceSummary}` : workspaceSummary}
              </span>
            ) : null}
            {isDirty ? <span className="agent-window-unsaved-label">Unsaved</span> : null}
          </div>
          <div className="agent-chrome-actions">
            <button
              type="button"
              className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
              onClick={() => void handleRevertLastCheckpoint()}
              disabled={sending || checkpointBusy || checkpoints.length === 0}
              title={
                checkpoints[0]
                  ? `Revert to latest checkpoint (${checkpoints[0].id})`
                  : 'No checkpoints yet'
              }
            >
              Revert
            </button>
            <button
              type="button"
              className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
              onClick={() => void triggerDesktopRebuild(true)}
              disabled={rebuildBusy}
              title="Fast rebuild: vite build + patch dist-desktop app.asar"
            >
              {rebuildBusy ? 'Rebuild…' : 'Rebuild'}
            </button>
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

        {sending && runStatus ? (
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

        <div className="agent-window-thread-wrap">
            {effectiveVoiceMode ? (
              <>
                {sending && liveTodos.length > 0 ? (
                  <AgentTodoPanel todos={liveTodos} steps={liveSteps} />
                ) : null}
                <VoiceConversationStage
                  micLevel={effectiveMicMuted ? 0 : micLevel}
                  userSpeaking={
                    !effectiveMicMuted && !localSpeaking && (localUserSpeaking || micLevel > 0.12)
                  }
                  butlerSpeaking={localSpeaking}
                  thinking={sending && !localSpeaking}
                  micMuted={effectiveMicMuted}
                  pulseColors={pulseColors}
                  onEnd={() => handleToggleVoiceMode()}
                />
              </>
            ) : (
              <>
            {sending && liveTodos.length > 0 ? <AgentTodoPanel todos={liveTodos} steps={liveSteps} /> : null}
            {sending && isCodingProductMode(productMode) && (
              <div className="agent-window-coding-banner" role="status" aria-live="polite">
                <span className="agent-window-coding-spinner" aria-hidden />
                <span>Coding…</span>
              </div>
            )}
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
                  <span className="agent-msg-role">
                    {m.role === 'user' ? 'You' : productMode === 'chat' ? 'Butler' : 'Agent'}
                  </span>
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
                  isCodingProductMode(productMode) &&
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
              </>
            )}
          </div>

        {!effectiveVoiceMode ? (
          <footer className="agent-window-composer">
            {selfEditReview ? (
              <SelfEditReviewBanner
                review={selfEditReview}
                changes={threadFileChanges}
                busy={selfEditReviewBusy || checkpointBusy || sending}
                overrideTestsDefault={acceptWithoutTests}
                onOpenDiff={setActiveDiff}
                onAccept={(opts) => void handleAcceptSelfEdit(opts)}
                onReject={() => void handleRejectSelfEdit()}
              />
            ) : (
              <AgentFileDiffStrip changes={threadFileChanges} onOpen={setActiveDiff} />
            )}
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
            {screenSharing || screenShareError ? (
              <div
                className={`agent-window-screen-status${
                  screenShareError ? ' agent-window-screen-status--error' : ''
                }`}
                role="status"
                aria-live="polite"
              >
                <span className="agent-window-screen-status-dot" aria-hidden />
                <span className="agent-window-screen-status-label">
                  {screenShareError
                    ? screenShareError
                    : 'Sharing screen — Butler sees each message'}
                </span>
                <button
                  type="button"
                  className="agent-window-screen-status-stop"
                  onClick={() => void stopScreenShare()}
                >
                  Stop
                </button>
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
            {chatAttachment ? (
              <div className="agent-window-attach-chip" title={chatAttachment.name}>
                {chatAttachment.mime.toLowerCase().startsWith('image/') ? (
                  <img src={chatAttachment.dataUrl} alt="" className="agent-window-attach-thumb" />
                ) : null}
                <span className="agent-window-attach-name">{chatAttachment.name}</span>
                <button
                  type="button"
                  className="agent-window-attach-clear"
                  onClick={() => setChatAttachment(null)}
                  aria-label="Remove attachment"
                >
                  ×
                </button>
              </div>
            ) : null}
            <div
              className={`agent-window-composer-row${composerDragOver ? ' agent-window-composer-row--drag' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setComposerDragOver(true);
              }}
              onDragLeave={() => setComposerDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setComposerDragOver(false);
                const f = e.dataTransfer?.files?.[0];
                if (!f) return;
                void fileToChatAttach(f).then((att) => {
                  if (att) setChatAttachment(att);
                });
              }}
            >
              <input
                ref={chatFileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  void fileToChatAttach(f).then((att) => {
                    if (att) setChatAttachment(att);
                  });
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="agent-composer-icon-btn agent-composer-icon-btn--attach"
                onClick={() => chatFileInputRef.current?.click()}
                disabled={sending}
                title="Attach image (or paste / drop)"
                aria-label="Attach image"
              >
                📎
              </button>
              <button
                type="button"
                className={`agent-composer-icon-btn agent-composer-icon-btn--screen${
                  screenSharing ? ' agent-composer-icon-btn--screen-on' : ''
                }`}
                onClick={() => handleToggleScreenShare()}
                disabled={sending || screenShareBusy}
                title={
                  screenSharing
                    ? 'Stop sharing screen'
                    : 'Share screen — every message includes what you see (no preview)'
                }
                aria-pressed={screenSharing}
                aria-label={screenSharing ? 'Stop sharing screen' : 'Share screen'}
              >
                {screenShareBusy ? '…' : 'Share'}
              </button>
              <textarea
                ref={inputRef}
                className="agent-window-input"
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  screenSharing
                    ? 'Ask about what’s on your screen…'
                    : productMode === 'chat'
                      ? 'Ask Butler anything… (paste or drop images)'
                      : productMode === 'self-edit'
                        ? 'Ask Butler to change his own code… (Accept/Reject after writes)'
                        : 'Ask to scan the project, edit code, run tests, search docs…'
                }
                onPaste={(e) => {
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  for (const item of Array.from(items)) {
                    if (!item.type.startsWith('image/')) continue;
                    e.preventDefault();
                    const f = item.getAsFile();
                    if (!f) continue;
                    void fileToChatAttach(f).then((att) => {
                      if (att) setChatAttachment(att);
                    });
                    break;
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                disabled={sending}
              />
              <div className="agent-window-composer-actions">
                {sending ? (
                  <button
                    type="button"
                    className="agent-composer-icon-btn"
                    onClick={() => void handleCancelSend()}
                    title="Cancel"
                    aria-label="Cancel"
                  >
                    ✕
                  </button>
                ) : null}
                {!sending && showContinue ? (
                  <button
                    type="button"
                    className="agent-composer-icon-btn agent-composer-icon-btn--accent"
                    onClick={() => void handleContinue()}
                    title="Resume the agent to finish promised work"
                  >
                    →
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`agent-composer-icon-btn agent-composer-icon-btn--speech${
                    speechState === 'listening' ? ' agent-composer-icon-btn--active' : ''
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
                      : speechState === 'transcribing'
                        ? 'Transcribing speech'
                        : 'Start speech-to-text recording'
                  }
                >
                  {speechState === 'transcribing' ? '…' : '🎤'}
                </button>
                <button
                  type="button"
                  className="agent-composer-icon-btn agent-composer-icon-btn--send"
                  onClick={() => void handleSend()}
                  disabled={
                    sending || (!input.trim() && !chatAttachment && !latestScreenAttach())
                  }
                  title={sending ? 'Working…' : 'Send'}
                  aria-label={sending ? 'Working' : 'Send'}
                >
                  {sending ? '…' : '↑'}
                </button>
                <button
                  type="button"
                  className={`agent-composer-icon-btn agent-voice-wave-btn${
                    effectiveVoiceMode ? ' agent-voice-wave-btn--active' : ''
                  }${
                    effectiveVoiceMode && effectiveVoiceAlive ? ' agent-voice-wave-btn--alive' : ''
                  }${effectiveVoiceMode && effectiveMicMuted ? ' agent-voice-wave-btn--muted' : ''}`}
                  onClick={() => handleWaveformClick()}
                  disabled={effectiveVoiceToggleBusy}
                  title={
                    !effectiveVoiceMode
                      ? 'Voice conversation — speak with Butler (Chat)'
                      : effectiveMicMuted
                        ? 'Unmute microphone'
                        : 'Mute microphone'
                  }
                  aria-pressed={effectiveVoiceMode && !effectiveMicMuted}
                  aria-label={
                    !effectiveVoiceMode
                      ? 'Start voice conversation'
                      : effectiveMicMuted
                        ? 'Unmute microphone'
                        : 'Mute microphone'
                  }
                >
                  <span className="agent-voice-wave-btn__bars" aria-hidden>
                    {waveBarHeights.map((h, i) => (
                      <span
                        key={i}
                        className="agent-voice-wave-btn__bar"
                        style={{ ['--bar-h' as string]: h }}
                      />
                    ))}
                  </span>
                </button>
              </div>
            </div>
          </footer>
        ) : null}

        {effectiveVoiceMode ? (
          <footer className="agent-window-composer agent-window-composer--voice-only">
            {screenSharing || screenShareError ? (
              <div
                className={`agent-window-screen-status${
                  screenShareError ? ' agent-window-screen-status--error' : ''
                }`}
                role="status"
                aria-live="polite"
              >
                <span className="agent-window-screen-status-dot" aria-hidden />
                <span className="agent-window-screen-status-label">
                  {screenShareError
                    ? screenShareError
                    : 'Sharing screen — each voice turn includes it'}
                </span>
                <button
                  type="button"
                  className="agent-window-screen-status-stop"
                  onClick={() => void stopScreenShare()}
                >
                  Stop
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                onClick={() => handleToggleScreenShare()}
                disabled={screenShareBusy}
                title="Share screen for this voice session"
              >
                {screenShareBusy ? 'Starting…' : 'Share screen'}
              </button>
            )}
            <button
              type="button"
              className={`agent-composer-icon-btn agent-voice-wave-btn agent-voice-wave-btn--active${
                effectiveVoiceAlive ? ' agent-voice-wave-btn--alive' : ''
              }${effectiveMicMuted ? ' agent-voice-wave-btn--muted' : ''}`}
              onClick={() => handleWaveformClick()}
              disabled={effectiveVoiceToggleBusy}
              title={effectiveMicMuted ? 'Unmute microphone' : 'Mute microphone'}
              aria-pressed={!effectiveMicMuted}
              aria-label={effectiveMicMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              <span className="agent-voice-wave-btn__bars" aria-hidden>
                {waveBarHeights.map((h, i) => (
                  <span
                    key={i}
                    className="agent-voice-wave-btn__bar"
                    style={{ ['--bar-h' as string]: h }}
                  />
                ))}
              </span>
            </button>
          </footer>
        ) : null}

        {effectiveVoiceMode ? (
          <span className="agent-window__voice-aura-floor" aria-hidden>
            <span className="agent-window__voice-aura-floor-wash agent-window__voice-aura-floor-wash--butler" />
            <span className="agent-window__voice-aura-floor-wash agent-window__voice-aura-floor-wash--mid" />
            <span className="agent-window__voice-aura-floor-wash agent-window__voice-aura-floor-wash--user" />
          </span>
        ) : null}

        <AgentBottomPanel
          open={footerOpen}
          heightPx={footerHeightPx}
          tab={footerTab}
          onTabChange={(tab) => openFooterTab(tab)}
          onToggleOpen={() => {
            setFooterOpen((open) => !open);
          }}

          onResizeStart={onFooterResizeStart}
          onResetHeight={() => setFooterHeightPx(AGENT_FOOTER_DEFAULT_PX)}
          cwd={terminalSessionCwd || cwd}
          terminalShellLabel={terminalShellLabel}
          terminalShellId={terminalShellId}
          terminalShells={terminalShells}
          onTerminalShellChange={(id) => void handleTerminalShellChange(id)}
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
          onClose={() => {
            setPulseColors(loadPulseColors());
            setSettingsOpen(false);
          }}
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
          onRevertLastCheckpoint={() => void handleRevertLastCheckpoint()}
          onRebuildDesktop={() => void triggerDesktopRebuild(true)}
          rebuildBusy={rebuildBusy}
          theme={theme}
          onThemeChange={handleThemeChange}
          productMode={productMode}
          onProductModeChange={setProductModePersist}
          acceptWithoutTests={acceptWithoutTests}
          onAcceptWithoutTestsChange={(on) => {
            writeAcceptWithoutTestsPref(on);
            setAcceptWithoutTests(on);
          }}
          screenLookMode={screenLookMode}
          onScreenLookModeChange={(on) => {
            setScreenLookModeEnabled(on);
            setScreenLookMode(on);
          }}
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

        <AgentSpotifyPanel open={spotifyOpen} onClose={() => setSpotifyOpen(false)} />
      </div>
    </div>
  );
}
