import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ButlerAvatar3D } from './ButlerAvatar3D';
import { ButlerDockFlyOverlay, type ButlerDockFlyPayload } from './ButlerDockFlyOverlay';
import { WebButlerFloat, type WebButlerFloatHandle } from './WebButlerFloat';
import { StartupSplash } from './StartupSplash';
import { StlPreview } from './StlPreview';
import { AgentWindow } from './AgentWindow';
import { startVoiceModePcmAutoListen } from './voiceModeAutoListen';
import { chunkTextForSpeech } from './lib/speechStrip';
import {
  downloadResumeDocx,
  plainLinesToHtml,
  prepareResumeHtmlForExport,
  resumePlainFromProfile,
  stripHtmlToPlain,
} from './lib/resumeHtml';
import { ResumePdfStyleModal } from './components/ResumePdfStyleModal';
import { ChatMediaEmbeds } from './components/ChatMediaEmbeds';
import { ButlerMiniStatusStrip } from './components/ButlerMiniStatusStrip';
import { extractUrls } from './components/chatUrlUtils';
import { ChatBubbleRichText } from './components/ChatBubbleRichText';
import { VisualizerPanel } from './components/VisualizerPanel';
import { AnimationGeneratorPanel } from './components/AnimationGeneratorPanel';
import { SecretMenuImageTools, type PoseReferenceImage } from './components/SecretMenuImageTools';
import { VramSettingsPanel } from './components/VramSettingsPanel';
import { fetchButlerJsonWithResponse } from './lib/fetchButlerJson';
import { butlerFetch } from './lib/butlerApiBase';
import { useNetworkMonitorWatch } from './useNetworkMonitorWatch';
import {
  getNetworkMonitorBpfHint,
  getNetworkMonitorIfaceHint,
  getNetworkMonitorNotifyEnabled,
  getNetworkMonitorWatchEnabled,
  setNetworkMonitorBpfHint,
  setNetworkMonitorIfaceHint,
  setNetworkMonitorNotifyEnabled,
  setNetworkMonitorWatchEnabled,
} from './networkMonitorPrefs';
import { ResumeRichEditor } from './ResumeRichEditor';
import { SECRET_MENU_NSFW_PROMPT_SNIPPETS } from './secretMenuNsfwPrompts';

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  }
}

/** Base64 for raw PCM bytes (browser-safe, avoids stack limits on large buffers). */
function uint8ToBase64(u8: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    const sub = u8.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(binary);
}

/** Match express.json({ limit: '10mb' }) in ui-server.js and ui/electron/main.cjs — SD/img2img refs are often >512 KB. */
const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function isElectronButler(): boolean {
  return typeof window !== 'undefined' && !!window.butlerElectron;
}

type ButlerWorkspaceView = 'chat' | 'agent' | 'split';

function readButlerWorkspaceViewFromHash(): ButlerWorkspaceView {
  if (typeof window === 'undefined') return 'chat';
  const hash = window.location.hash.replace(/^#/, '').trim().toLowerCase();
  if (hash === 'agent-split') return 'split';
  if (hash === 'agent') return 'agent';
  return 'chat';
}

function writeButlerWorkspaceViewHash(view: ButlerWorkspaceView): void {
  if (typeof window === 'undefined') return;
  const nextHash = view === 'agent' ? '#agent' : view === 'split' ? '#agent-split' : '';
  if (window.location.hash === nextHash) return;
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
  window.history.replaceState(null, '', nextUrl);
}

/**
 * Voice convo defaults to Web Speech in browsers. In Electron, Chromium’s SpeechRecognition often
 * fires `audio-capture` repeatedly even when the mic works for getUserMedia—so push-to-talk STT
 * works but “hands-free” does not. Use the same PCM → /api/speech-to-text path as the degraded mode.
 */
function preferVoiceConvoPcmOverWebSpeech(): boolean {
  if (isElectronButler()) return true;
  if (typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent || '')) return true;
  return false;
}

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const s = dataUrl.trim();
  const marker = ';base64,';
  const i = s.indexOf(marker);
  if (!s.toLowerCase().startsWith('data:') || i < 5) return null;
  const mime = s.slice(5, i).trim() || 'application/octet-stream';
  const base64 = s.slice(i + marker.length).replace(/\s/g, '');
  if (!base64) return null;
  return { mime, base64 };
}

function pickBritishTtsVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (!voices?.length) return null;
  const gb = voices.filter((v) => v.lang.toLowerCase().startsWith('en-gb'));
  const rank = (v: SpeechSynthesisVoice) => {
    const n = v.name.toLowerCase();
    let s = 0;
    if (n.includes('natural')) s += 6;
    if (n.includes('neural')) s += 6;
    if (n.includes('premium')) s += 3;
    if (n.includes('sonia') || n.includes('ryan') || n.includes('libby') || n.includes('maisie')) s += 2;
    return s;
  };
  if (gb.length) return [...gb].sort((a, b) => rank(b) - rank(a))[0];
  const ie = voices.find((v) => v.lang.toLowerCase().startsWith('en-ie'));
  if (ie) return ie;
  const au = voices.find((v) => v.lang.toLowerCase().startsWith('en-au'));
  if (au) return au;
  return voices.find((v) => v.lang.toLowerCase().startsWith('en')) || voices[0] || null;
}

function keyboardEventTargetIsEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable || !!el.closest('[contenteditable="true"]');
}

/**
 * Capture mono s16le PCM; server wraps with Python's wave module so speech_recognition always gets a valid WAV.
 */
async function startPcmRecording(stream: MediaStream): Promise<{
  stop: () => Promise<{ pcm: ArrayBuffer; sampleRate: number }>;
}> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    await ctx.resume();
  } catch {
    /* still try recording */
  }
  const sampleRate = ctx.sampleRate;
  const src = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Int16Array[] = [];
  const gain = ctx.createGain();
  gain.gain.value = 0;

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    chunks.push(out);
  };

  src.connect(processor);
  processor.connect(gain);
  gain.connect(ctx.destination);

  return {
    stop: () =>
      new Promise((resolve) => {
        processor.disconnect();
        src.disconnect();
        void ctx.close();

        const totalLen = chunks.reduce((a, c) => a + c.length, 0);
        const merged = new Int16Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }

        resolve({ pcm: merged.buffer, sampleRate });
      }),
  };
}

function JobsPanel({
  onResult,
  onCancel,
  jobAction,
  setJobAction,
  loading,
  setLoading,
  profileBaseHtml,
  requestResumePdfExport,
}: {
  onResult: (content: string, source?: string) => void;
  onCancel: () => void;
  jobAction: 'tailor' | 'cover' | null;
  setJobAction: (a: 'tailor' | 'cover' | null) => void;
  loading: boolean;
  setLoading: (v: boolean) => void;
  profileBaseHtml: string;
  requestResumePdfExport: (html: string, filenameStem: string) => void;
}) {
  const [baseHtml, setBaseHtml] = useState(() => (profileBaseHtml?.trim() ? profileBaseHtml : '<p><br></p>'));
  const [postingUrl, setPostingUrl] = useState('');
  const [jobDesc, setJobDesc] = useState('');
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [userContext, setUserContext] = useState('');

  useEffect(() => {
    setBaseHtml(profileBaseHtml?.trim() ? profileBaseHtml : '<p><br></p>');
  }, [profileBaseHtml]);

  // No "tailored" draft state: tailoring replaces `baseHtml` directly.

  const runTailor = async () => {
    const plain = stripHtmlToPlain(baseHtml);
    const urlOk = /^https?:\/\//i.test(postingUrl.trim());
    if (!plain.trim()) {
      onResult('Please add resume content.');
      return;
    }
    if (!jobDesc.trim() && !urlOk) {
      onResult('Paste a job description or enter a posting URL (https://…).');
      return;
    }
    setLoading(true);
    try {
      const payload = {
        base_resume: plain,
        base_resume_html: baseHtml,
        posting_url: postingUrl.trim(),
        job_description: jobDesc,
        company,
        role,
        user_context: userContext,
        save_materials: true,
      };

      const postWithRetry = async () => {
        const doPost = () =>
          fetch('/api/jobs/tailor_resume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

        try {
          return await doPost();
        } catch (e: unknown) {
          const msg = (e as Error)?.message || String(e);
          // When the dev proxy sees a connection reset, retry once (tailoring can be compute-heavy).
          if (/ECONNRESET|socket hang up/i.test(msg)) {
            await new Promise((r) => setTimeout(r, 750));
            return await doPost();
          }
          throw e;
        }
      };

      const res = await postWithRetry();
      const data = await res.json();
      if (data.ok && (data.content_html || data.content)) {
        const th: string =
          data.content_html || plainLinesToHtml(String(data.content || ''));
        // Tailor should just update the editor content (main "test input"),
        // not force an export/download in the tailor panel.
        setBaseHtml(th);
        let msg = stripHtmlToPlain(th);
        if (data.cover_letter) {
          msg += `\n\n--- COVER LETTER ---\n\n${data.cover_letter}`;
        }
        if (data.app_file) {
          msg += `\n\nSaved resume & cover letter to:\n${data.app_file}`;
        }
        onResult(msg, 'Jobs');
      } else {
        onResult(data?.message || 'Failed. Add OpenAI key in settings.');
      }
    } catch (e: unknown) {
      onResult((e as Error)?.message || 'Request failed.');
    } finally {
      setLoading(false);
    }
  };

  const runCoverLetter = async () => {
    if (!jobDesc.trim()) {
      onResult('Please paste the job description.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/jobs/cover_letter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_description: jobDesc, company, role, user_context: userContext }),
      });
      const data = await res.json();
      if (data.ok && data.content) {
        onResult(data.content, 'Jobs');
      } else {
        onResult(data?.message || 'Failed. Add OpenAI key in settings.');
      }
    } catch (e: unknown) {
      onResult((e as Error)?.message || 'Request failed.');
    } finally {
      setLoading(false);
    }
  };

  const createPdfFromEditor = () => {
    if (!stripHtmlToPlain(baseHtml).trim()) {
      window.alert('Add résumé text in the editor first.');
      return;
    }
    requestResumePdfExport(baseHtml, 'resume');
  };

  if (jobAction === 'tailor') {
    const stem =
      [company, role].filter((x) => x.trim()).join('_').replace(/\s+/g, '_') || 'resume_tailored';
    return (
      <div className="jobs-resume-panel">
        <p className="jobs-resume-hint">
          Use the editor below like Word (headings, bold, lists). Tailor resume updates this editor with a job-specific version (no export here).
        </p>
        <label className="jobs-resume-label">Your resume</label>
        <div className="resume-editor-page-wrap">
          <ResumeRichEditor value={baseHtml} onChange={setBaseHtml} placeholder="Resume…" />
        </div>
        <label className="jobs-resume-label">Job posting URL</label>
        <input
          className="jobs-resume-input"
          type="url"
          placeholder="https://… (Indeed, LinkedIn, company site — we fetch the page when description below is short)"
          value={postingUrl}
          onChange={(e) => setPostingUrl(e.target.value)}
        />
        <label className="jobs-resume-label jobs-resume-label--spaced">Job description (optional if URL above)</label>
        <textarea
          className="jobs-resume-textarea"
          placeholder="Paste job description, or rely on the URL"
          value={jobDesc}
          onChange={(e) => setJobDesc(e.target.value)}
          rows={5}
        />
        <div className="jobs-resume-row">
          <input
            className="jobs-resume-input"
            placeholder="Company (optional)"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
          <input className="jobs-resume-input" placeholder="Role (optional)" value={role} onChange={(e) => setRole(e.target.value)} />
        </div>
        <textarea
          className="jobs-resume-textarea"
          placeholder="About you (optional — used for the saved cover letter)"
          value={userContext}
          onChange={(e) => setUserContext(e.target.value)}
          rows={2}
        />
        <div className="jobs-resume-actions">
          <button type="button" className="butler-btn" onClick={() => void runTailor()} disabled={loading}>
            {loading ? '…' : 'Tailor resume'}
          </button>
          <button type="button" className="butler-btn butler-btn-secondary" onClick={onCancel} disabled={loading}>
            Done
          </button>
        </div>
      </div>
    );
  }
  if (jobAction === 'cover') {
    return (
      <div className="jobs-resume-panel jobs-resume-panel--compact">
        <textarea
          className="jobs-resume-textarea"
          placeholder="Job description"
          value={jobDesc}
          onChange={(e) => setJobDesc(e.target.value)}
          rows={4}
        />
        <div className="jobs-resume-row">
          <input className="jobs-resume-input" placeholder="Company" value={company} onChange={(e) => setCompany(e.target.value)} />
          <input className="jobs-resume-input" placeholder="Role" value={role} onChange={(e) => setRole(e.target.value)} />
        </div>
        <textarea
          className="jobs-resume-textarea"
          placeholder="About you (optional)"
          value={userContext}
          onChange={(e) => setUserContext(e.target.value)}
          rows={2}
        />
        <div className="jobs-resume-actions">
          <button type="button" className="butler-btn" onClick={() => void runCoverLetter()} disabled={loading}>
            {loading ? '…' : 'Generate cover letter'}
          </button>
          <button type="button" className="butler-btn butler-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="jobs-resume-panel">
      <p className="jobs-resume-hint">
        Edit your résumé below, then <strong>Create PDF</strong> — pick a template; export uses <strong>PDFKit</strong> (programmatic layouts, US Letter). Use toolbar{' '}
        <strong>Heading 1–2</strong> for name and section titles. <strong>Tailor resume</strong> adjusts for a specific job.
      </p>
      <label className="jobs-resume-label">Résumé</label>
      <div className="resume-editor-page-wrap">
        <ResumeRichEditor value={baseHtml} onChange={setBaseHtml} placeholder="Your résumé…" />
      </div>
      <div className="jobs-resume-row" style={{ marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="butler-btn" onClick={() => createPdfFromEditor()} disabled={loading}>
          {loading ? '…' : 'Create PDF'}
        </button>
      </div>
      <div className="jobs-resume-actions" style={{ marginTop: 12 }}>
        <button type="button" className="butler-btn" onClick={() => setJobAction('tailor')}>
          Tailor resume
        </button>
        <button type="button" className="butler-btn" onClick={() => setJobAction('cover')}>
          Cover letter
        </button>
      </div>
    </div>
  );
}

type ButlerDevEffective = {
  globalProjectRoot: string | null;
  trustedRoots: string[];
  allowAnyPath: boolean;
};

type Settings = {
  openaiApiKey: string;
  hasKey: boolean;
  localOnly?: boolean;
  voiceMode?: boolean;
  butlerGlobalProjectRoot?: string;
  butlerTrustedRootsText?: string;
  butlerAllowAnyPath?: boolean;
  butlerDevEffective?: ButlerDevEffective;
};

/** Row from GET /api/butlor/data_summary (Knowledge API /butlor/data_summary). */
type ButlorLocationRow = {
  id: string;
  label: string;
  detail?: string;
  path: string;
  kind: string;
  count: number;
  count_label?: string;
};

const CODE_WORKSPACE_CONTEXT_KEY = 'butler-code-workspace-context';
const CODE_CURSOR_CLI_ENABLED_KEY = 'butler-code-cursor-cli-enabled';
const CODE_CURSOR_CLI_COMMAND_KEY = 'butler-code-cursor-cli-command';
const EXPAND_CODE_PANEL_KEY = 'butler-expand-code-panel';
const EXPAND_CODE_BACKGROUND_KEY = 'butler-expand-code-background';
const EXPAND_CODE_CLI_KEY = 'butler-expand-code-cli';
const EXPAND_JOBS_PANEL_KEY = 'butler-expand-jobs-panel';
const EXPAND_STATUS_SETTINGS_KEY = 'butler-expand-status-in-settings';
const EXPAND_NETWORK_MONITOR_KEY = 'butler-expand-network-monitor';
const EXPAND_SECURITY_LAB_KEY = 'butler-expand-security-lab';
const EXPAND_KALI_TOOLS_KEY = 'butler-expand-kali-tools';
const EXPAND_INFOOOZE_KEY = 'butler-expand-infoooze';
const EXPAND_VISUALIZER_KEY = 'butler-expand-visualizer';
const EXPAND_ANIMATION_GENERATOR_KEY = 'butler-expand-animation-generator';
const ACTIVITY_LOG_MODAL_POS_KEY = 'butler-activity-log-modal-pos';
const BUTLER_THEME_KEY = 'butler-theme';

function readStoredThemeDark(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(BUTLER_THEME_KEY) === 'dark';
  } catch {
    return false;
  }
}

function loadActivityLogModalPos(): { left: number; top: number } {
  if (typeof window === 'undefined') return { left: 80, top: 100 };
  try {
    const raw = localStorage.getItem(ACTIVITY_LOG_MODAL_POS_KEY);
    if (raw) {
      const j = JSON.parse(raw) as { left?: unknown; top?: unknown };
      if (typeof j.left === 'number' && typeof j.top === 'number') {
        return { left: j.left, top: j.top };
      }
    }
  } catch {
    /* ignore */
  }
  return {
    left: Math.max(24, Math.round(window.innerWidth / 2 - 260)),
    top: Math.max(24, Math.round(window.innerHeight / 2 - 200)),
  };
}

const CHAT_SECTION_HEIGHT_KEY = 'butler-ui-chat-section-px';
const APP_HEADER_HEIGHT_KEY = 'butler-ui-header-px';
const SPLIT_CHAT_WIDTH_KEY = 'butler-ui-split-chat-width-px';
/** Main composer ↑/↓ history — persisted so `npm run dev` / refresh keeps last sends. */
const CHAT_PROMPT_HISTORY_MAX = 100;
const CHAT_PROMPT_HISTORY_STORAGE_KEY = 'butler_chat_prompt_history_v1';

function readStoredChatPromptHistory(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CHAT_PROMPT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const x of parsed) {
      if (typeof x !== 'string') continue;
      const t = x.trim();
      if (t) out.push(t);
    }
    return out.slice(-CHAT_PROMPT_HISTORY_MAX);
  } catch {
    return [];
  }
}

function persistChatPromptHistory(lines: string[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      CHAT_PROMPT_HISTORY_STORAGE_KEY,
      JSON.stringify(lines.slice(-CHAT_PROMPT_HISTORY_MAX)),
    );
  } catch {
    /* quota / private mode */
  }
}

const LS_STEALTH_IMAGE_ATTACH = 'butler_stealth_image_attachment';
const LS_SECRET_MENU_OPEN = 'butler_secret_menu_open';
const LS_SECRET_MENU_MINIMIZED = 'butler_secret_menu_minimized';

function readStoredStealthImageAttach(): boolean {
  try {
    return localStorage.getItem(LS_STEALTH_IMAGE_ATTACH) === '1';
  } catch {
    return false;
  }
}

const LS_UTILITY_PANEL_MODAL_WH = 'butler_utility_panel_modal_wh';
const UTILITY_PANEL_MIN_W = 300;
const UTILITY_PANEL_MIN_H = 360;
const UTILITY_PANEL_DEFAULT_W = 520;
const UTILITY_PANEL_DEFAULT_H = 560;

function readStoredUtilityPanelModalSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(LS_UTILITY_PANEL_MODAL_WH);
    if (!raw) return { w: UTILITY_PANEL_DEFAULT_W, h: UTILITY_PANEL_DEFAULT_H };
    const j = JSON.parse(raw) as { w?: unknown; h?: unknown };
    const w = typeof j.w === 'number' && Number.isFinite(j.w) ? j.w : UTILITY_PANEL_DEFAULT_W;
    const h = typeof j.h === 'number' && Number.isFinite(j.h) ? j.h : UTILITY_PANEL_DEFAULT_H;
    const maxW = typeof window !== 'undefined' ? Math.min(window.innerWidth * 0.96, 920) : 920;
    const maxH = typeof window !== 'undefined' ? Math.min(window.innerHeight * 0.92, 900) : 900;
    return {
      w: Math.round(Math.min(Math.max(w, UTILITY_PANEL_MIN_W), maxW)),
      h: Math.round(Math.min(Math.max(h, UTILITY_PANEL_MIN_H), maxH)),
    };
  } catch {
    return { w: UTILITY_PANEL_DEFAULT_W, h: UTILITY_PANEL_DEFAULT_H };
  }
}

function clampUtilityPanelSize(w: number, h: number): { w: number; h: number } {
  const maxW = typeof window !== 'undefined' ? Math.min(window.innerWidth * 0.96, 920) : 920;
  const maxH = typeof window !== 'undefined' ? Math.min(window.innerHeight * 0.92, 900) : 900;
  return {
    w: Math.round(Math.min(Math.max(w, UTILITY_PANEL_MIN_W), maxW)),
    h: Math.round(Math.min(Math.max(h, UTILITY_PANEL_MIN_H), maxH)),
  };
}

/** Drag / stored-height floor so the chat never stays a thin strip (was 280 and felt broken). */
const MIN_CHAT_SECTION_PX = 380;
/** Hard cap (matches former app-shell max) so the chat card cannot grow past the viewport band. */
const CHAT_SECTION_MAX_CAP_PX = 920;
const CHAT_SECTION_VIEWPORT_RESERVE_PX = 120;
const APP_HEADER_MIN_PX = 96;
const APP_HEADER_MAX_PX = 260;
const SPLIT_PANE_MIN_PX = 360;

function getChatSectionMaxPx(): number {
  if (typeof window === 'undefined') return CHAT_SECTION_MAX_CAP_PX;
  const fromViewport = Math.round(window.innerHeight - CHAT_SECTION_VIEWPORT_RESERVE_PX);
  return Math.max(MIN_CHAT_SECTION_PX, Math.min(CHAT_SECTION_MAX_CAP_PX, fromViewport));
}
function clampLayout(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function readStoredLayoutPx(key: string, min: number, max: number): number | null {
  try {
    const v = localStorage.getItem(key);
    if (v == null || v === '') return null;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return null;
    return clampLayout(n, min, max);
  } catch {
    return null;
  }
}

function readStoredChatSectionPx(): number | null {
  return readStoredLayoutPx(CHAT_SECTION_HEIGHT_KEY, MIN_CHAT_SECTION_PX, getChatSectionMaxPx());
}

function getSplitChatMaxPx(totalWidth: number): number {
  return Math.max(SPLIT_PANE_MIN_PX, totalWidth - SPLIT_PANE_MIN_PX);
}

/** Shown as the Code tab background until the user replaces it (first visit only). */
const DEFAULT_CODE_CURSOR_AGENT_BACKGROUND = `Setup (human + Butler): Install the Cursor CLI from Cursor’s docs, run agent login once in a normal terminal. In Butler → Settings, set Global project root to the same repo folder you open in Cursor so run_command cwd matches your workspace.

Delegation: When I ask to use Cursor’s agent, Butler should use mode actions with run_command (not the IDE chat). Use the executable from the Code tab (default: agent on PATH). This runs in the shell only—it does not attach to a specific Cursor chat thread.

- Headless / print-only: agent -p "one clear line describing the task"
- When I want the CLI to apply file edits: add --force if the Cursor CLI version supports it (see current docs).

If auth fails, remind me to run agent login again. You may combine Butler write_file with a CLI pass when useful.`;

function readStoredCodeWorkspaceContext(): string {
  try {
    const s = localStorage.getItem(CODE_WORKSPACE_CONTEXT_KEY);
    if (s !== null) return s;
  } catch {
    /* ignore */
  }
  return DEFAULT_CODE_CURSOR_AGENT_BACKGROUND;
}

function readStoredCodeCursorCliEnabled(): boolean {
  try {
    const v = localStorage.getItem(CODE_CURSOR_CLI_ENABLED_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
    return true;
  } catch {
    return true;
  }
}

function readStoredCodeCursorCliCommand(): string {
  try {
    const v = localStorage.getItem(CODE_CURSOR_CLI_COMMAND_KEY);
    if (v != null && v.trim()) return v.trim().slice(0, 200);
  } catch {
    /* ignore */
  }
  return 'agent';
}

/** End prompt with `--r` (optional spaces) to show returned SD images in the chat thread; stripped before the API sees the text. */
const PROMPT_INLINE_IMAGE_SUFFIX = /\s*--r\s*$/i;

function parsePromptWithOptionalInlineImageSuffix(rawInput: string): {
  rawTrimmed: string;
  messageForApi: string;
  showReplyImagesInChat: boolean;
} {
  const rawTrimmed = rawInput.trim();
  const showReplyImagesInChat = PROMPT_INLINE_IMAGE_SUFFIX.test(rawTrimmed);
  const messageForApi = showReplyImagesInChat ? rawTrimmed.replace(/\s*--r\s*$/i, '').trim() : rawTrimmed;
  return { rawTrimmed, messageForApi, showReplyImagesInChat };
}

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** User message sent from the utility side composer (not the main input). */
  belowStairs?: boolean;
  source?: string;
  images?: string[];
  /** When set with images, renders thumbnails in the bubble (user used --r suffix on the prompt). */
  inlineImages?: boolean;
  /** Labels for each image (e.g. variant names from the generator) */
  variantLabels?: string[];
  /** Base64 or data URL from local SD video endpoints */
  video?: string;
  /** Raw base64 WAV from local MusicGen */
  audio?: string;
  /** Interactive STL preview (orbit) after print3d chat success */
  stlPreview?: { url: string; filename: string };
};

/** Raw base64 from Butler SD/Comfy is often WebM (SaveWEBM); defaulting to MP4 breaks playback in chat. */
function sniffVideoMimeFromRawBase64(b64: string): string {
  const clean = b64.replace(/\s/g, '');
  if (clean.length < 16) return 'video/mp4';
  const mod4 = clean.length % 4;
  const pad = mod4 ? '='.repeat(4 - mod4) : '';
  let slice = clean.slice(0, 200);
  while (slice.length % 4) slice = slice.slice(0, -1);
  try {
    const bin = atob(slice + pad);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    if (u.length >= 8 && u[4] === 0x66 && u[5] === 0x74 && u[6] === 0x79 && u[7] === 0x70) return 'video/mp4';
    if (u.length >= 4 && u[0] === 0x1a && u[1] === 0x45 && u[2] === 0xdf && u[3] === 0xa3) return 'video/webm';
    if (
      u.length >= 12 &&
      u[0] === 0x52 &&
      u[1] === 0x49 &&
      u[2] === 0x46 &&
      u[3] === 0x46 &&
      u[8] === 0x57 &&
      u[9] === 0x45 &&
      u[10] === 0x42 &&
      u[11] === 0x50
    )
      return 'video/webp';
    if (u.length >= 6 && u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) return 'image/gif';
  } catch {
    /* ignore */
  }
  return 'video/mp4';
}

function mediaAudioSrc(audioB64: string): string {
  const s = String(audioB64).trim();
  if (!s) return '';
  if (s.startsWith('data:')) return s;
  return `data:audio/wav;base64,${s.replace(/\s/g, '')}`;
}

function mediaVideoSrc(video: string): string {
  const s = String(video).trim();
  if (!s) return '';
  if (/^(data:|https?:|blob:)/i.test(s)) return s;
  if (s.startsWith('/api/media/video')) return s;
  const mime = sniffVideoMimeFromRawBase64(s);
  return `data:${mime};base64,${s}`;
}

/** User messages use full `data:…` URLs; assistant SD images are often raw base64. */
function chatInlineImageSrc(img: string): string {
  const s = String(img).trim();
  if (s.startsWith('data:')) return s;
  return `data:image/png;base64,${s}`;
}

/** Basename from absolute STL path (Windows or POSIX). */
function print3dStlBasename(stlPath: string): string | null {
  const norm = String(stlPath || '').replace(/\\/g, '/');
  const name = norm.split('/').pop() || '';
  if (!name || !/^[a-zA-Z0-9_.-]+\.stl$/i.test(name)) return null;
  return name;
}

type ChatTab = {
  id: string;
  sessionId: string;
  label: string;
  messages: Message[];
  isSending: boolean;
  /** Live trace of the current / last send (host + HTTP steps). */
  sendLog: string[];
};

type StatusServiceRow = {
  id: string;
  label: string;
  ok?: boolean | null;
  url?: string;
  detail?: string;
  model?: string;
  skipped?: boolean;
};

type StatusPayload = {
  generated_at?: string;
  error?: string;
  status_note?: string;
  services?: StatusServiceRow[];
};

const STATUS_RESTARTABLE = new Set(['comfyui', 'knowledge_api', 'local_llm']);

function ButlerStatusPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [restartingId, setRestartingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { res: r, data: j } = await fetchButlerJsonWithResponse<StatusPayload>('/api/status');
      setData(j);
      if (!r.ok) setErr(j.error || r.statusText || 'Request failed');
    } catch (e) {
      setErr(String((e as Error).message));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const doRestart = useCallback(
    async (id: string) => {
      setRestartingId(id);
      try {
        const r = await fetch('/api/status/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service: id }),
        });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string };
        const extra =
          id === 'all'
            ? isElectronButler()
              ? '\n\nComfyUI can take 1–3 minutes after restart. This tab refreshes again in ~5s and ~20s; you can also click Refresh anytime.'
              : '\n\nComfyUI often needs 1–3 minutes before it answers (dev port 8188). Knowledge API usually comes up in a few seconds. This tab will refresh again automatically in ~5s and ~20s; you can also click Refresh anytime.'
            : id === 'comfyui' && isElectronButler()
              ? '\n\nGive it 1–3 minutes, then Refresh. Desktop Comfy listens on port 8198.'
              : '';
        window.alert((j.message || (j.ok ? 'Restart requested.' : 'Restart failed.')) + extra);
        await load();
        if (id === 'all') {
          window.setTimeout(() => void load(), 5000);
          window.setTimeout(() => void load(), 20000);
        }
      } catch (e) {
        window.alert(String((e as Error).message));
      } finally {
        setRestartingId(null);
      }
    },
    [load],
  );

  return (
    <div className="status-panel">
      <div className="status-panel-header">
        <p className="status-panel-lede">
          {isElectronButler()
            ? 'Desktop Butler services (Knowledge 8775, ComfyUI 8198, UI API 4011). Values refresh from local probes and the Knowledge API when reachable.'
            : 'All services are listed every time; values refresh from local probes and the Knowledge API when it is reachable. Use this when chat or image generation fails to connect.'}
        </p>
        <div className="status-panel-actions">
          <button type="button" className="status-refresh-btn" onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="status-refresh-btn"
            title="Restart local LLM helper, ComfyUI (if enabled), then Knowledge API"
            onClick={() => void doRestart('all')}
            disabled={loading || restartingId !== null}
          >
            {restartingId === 'all' ? 'Restarting…' : 'Restart all'}
          </button>
        </div>
      </div>
      {err && !(data?.services && data.services.length) ? <p className="status-error">{err}</p> : null}
      {data?.status_note ? <p className="status-note">{data.status_note}</p> : null}
      {data?.error ? <p className="status-warn">Knowledge API: {data.error}</p> : null}
      <div className="status-table-wrap">
        <table className="status-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Status</th>
              <th>URL / detail</th>
              <th className="status-th-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.services ?? []).map((s) => {
              const skipped = !!s.skipped;
              const ok = s.ok === true;
              const bad = s.ok === false;
              const badge = skipped ? '—' : ok ? 'Up' : bad ? 'Down' : '?';
              const cls = skipped
                ? 'status-pill status-pill-muted'
                : ok
                  ? 'status-pill status-pill-ok'
                  : bad
                    ? 'status-pill status-pill-bad'
                    : 'status-pill status-pill-muted';
              // Knowledge API: always offer Restart so Python / .env changes can reload (dev + desktop).
              // Other restartable services: only when down (start Comfy/LLM when port was free).
              const showRestart =
                !skipped && STATUS_RESTARTABLE.has(s.id) && (s.id === 'knowledge_api' || bad);
              return (
                <tr key={s.id}>
                  <td className="status-td-label">
                    <span className="status-label-text">{s.label}</span>
                    {s.model ? <span className="status-model-tag">{s.model}</span> : null}
                  </td>
                  <td>
                    <span className={cls}>{badge}</span>
                  </td>
                  <td className="status-td-detail">
                    {s.url ? (
                      <code className="status-url" title={s.url}>
                        {s.url}
                      </code>
                    ) : null}
                    {s.detail ? <div className="status-detail">{s.detail}</div> : null}
                  </td>
                  <td className="status-td-actions">
                    {showRestart ? (
                      <button
                        type="button"
                        className="status-restart-btn"
                        disabled={restartingId === s.id || restartingId === 'all' || loading}
                        onClick={() => void doRestart(s.id)}
                      >
                        {restartingId === s.id ? 'Starting…' : 'Restart'}
                      </button>
                    ) : null}
                    {bad && s.id === 'openai_key' ? (
                      <button type="button" className="status-restart-btn status-restart-btn--secondary" onClick={onOpenSettings}>
                        Settings
                      </button>
                    ) : null}
                    {bad && s.id === 'forge_api' ? (
                      <span className="status-action-hint">Start A1111 / Forge manually</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data?.generated_at ? (
        <p className="status-meta">Snapshot: {new Date(data.generated_at).toLocaleString()}</p>
      ) : null}
    </div>
  );
}

type NetIfRow = { index: string; label: string };

type QuickScanAlert = {
  id?: number;
  t?: string;
  kind?: string;
  severity?: string;
  detail?: string;
  context?: unknown;
};

type QuickScanResult = {
  ok?: boolean;
  error?: string;
  setup_hint?: string;
  probe?: { ok?: boolean; path?: string; version?: string; error?: string };
  seconds?: number;
  iface?: string;
  ifaceLabel?: string;
  eventsSeen?: number;
  suspicious?: { headline?: string; high?: number; medium?: number; low?: number; total?: number };
  alerts?: QuickScanAlert[];
  disclaimer?: string;
};

function NetworkMonitorPanel() {
  const [watchWhileOpen, setWatchWhileOpen] = useState(getNetworkMonitorWatchEnabled);
  const [notifySuspicious, setNotifySuspicious] = useState(getNetworkMonitorNotifyEnabled);
  const [probe, setProbe] = useState<{
    ok?: boolean;
    path?: string;
    version?: string;
    error?: string;
    setup_hint?: string;
    can_install_winget?: boolean;
    auto_wireshark?: boolean;
  } | null>(null);
  const [ifaces, setIfaces] = useState<NetIfRow[]>([]);
  const [iface, setIface] = useState(() => getNetworkMonitorIfaceHint() || '1');
  const [bpf, setBpf] = useState(() => getNetworkMonitorBpfHint());
  const [snap, setSnap] = useState<{
    running?: boolean;
    startedAt?: string | null;
    events?: Array<{ t?: string; raw?: string; dns?: string; sni?: string; dst?: string }>;
    alerts?: Array<{ t?: string; kind?: string; severity?: string; detail?: string }>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ifErr, setIfErr] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanResult, setScanResult] = useState<QuickScanResult | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [scanErrHint, setScanErrHint] = useState<string | null>(null);
  const [wingetBusy, setWingetBusy] = useState(false);

  const loadProbe = useCallback(async () => {
    try {
      const { data: j } = await fetchButlerJsonWithResponse<typeof probe>('/api/network-monitor/probe', {
        signal: AbortSignal.timeout(620000),
      });
      setProbe(j);
    } catch (e) {
      setProbe({ ok: false, error: String((e as Error).message) });
    }
  }, []);

  const loadIfaces = useCallback(async () => {
    setIfErr(null);
    try {
      const { data: j } = await fetchButlerJsonWithResponse<{
        ok?: boolean;
        interfaces?: NetIfRow[];
        error?: string;
      }>('/api/network-monitor/interfaces');
      if (!j.ok) setIfErr(j.error || 'Could not list interfaces');
      setIfaces(Array.isArray(j.interfaces) ? j.interfaces : []);
    } catch (e) {
      setIfErr(String((e as Error).message));
      setIfaces([]);
    }
  }, []);

  const refreshSnap = useCallback(async () => {
    try {
      const { data: j } = await fetchButlerJsonWithResponse<typeof snap>('/api/network-monitor/snapshot');
      setSnap(j);
    } catch {
      /* */
    }
  }, []);

  useEffect(() => {
    void loadProbe();
  }, [loadProbe]);

  useEffect(() => {
    if (probe?.ok) void loadIfaces();
  }, [probe?.ok, loadIfaces]);

  useEffect(() => {
    void refreshSnap();
    const t = window.setInterval(() => void refreshSnap(), 2500);
    return () => window.clearInterval(t);
  }, [refreshSnap]);

  useEffect(() => {
    setNetworkMonitorIfaceHint(iface);
  }, [iface]);
  useEffect(() => {
    setNetworkMonitorBpfHint(bpf);
  }, [bpf]);

  const runQuickScan = async () => {
    setScanBusy(true);
    setScanErr(null);
    setScanErrHint(null);
    setScanResult(null);
    try {
      const body: { seconds: number; iface?: string; bpf?: string } = { seconds: 12 };
      const i = iface.trim();
      const b = bpf.trim();
      if (i) body.iface = i;
      if (b) body.bpf = b;
      const { res: r, data: j } = await fetchButlerJsonWithResponse<QuickScanResult>('/api/network-monitor/quick-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok || !j.ok) {
        setScanErr(j.error || `Scan failed (${r.status})`);
        setScanErrHint(j.setup_hint || null);
        return;
      }
      setScanResult(j);
      void refreshSnap();
    } catch (e) {
      const msg = String((e as Error).message || e);
      setScanErr(msg.includes('abort') ? 'Scan timed out — try again or run Butler as administrator for capture.' : msg);
    } finally {
      setScanBusy(false);
    }
  };

  const runWingetInstallWireshark = async () => {
    setWingetBusy(true);
    try {
      const { res: r, data: j } = await fetchButlerJsonWithResponse<{
        ok?: boolean;
        message?: string;
        error?: string;
        hint?: string;
        log?: string;
      }>('/api/network-monitor/install-wireshark', {
        method: 'POST',
        signal: AbortSignal.timeout(620000),
      });
      if (!r.ok || !j.ok) {
        window.alert((j.error || 'winget install failed') + (j.hint ? `\n\n${j.hint}` : ''));
        return;
      }
      window.alert(j.message || 'Install finished. Restart Butler if tshark still does not appear, then use Re-check.');
      void loadProbe();
    } catch (e) {
      window.alert(String((e as Error).message));
    } finally {
      setWingetBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      const { res: r, data: j } = await fetchButlerJsonWithResponse<{ ok?: boolean; message?: string; error?: string }>(
        '/api/network-monitor/start',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ iface: iface.trim() || '1', bpf: bpf.trim() }),
        },
      );
      if (!r.ok || !j.ok) window.alert(j.error || j.message || 'Start failed');
      await refreshSnap();
    } catch (e) {
      window.alert(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await butlerFetch('/api/network-monitor/stop', { method: 'POST' });
      await refreshSnap();
    } finally {
      setBusy(false);
    }
  };

  const sus = scanResult?.suspicious;
  const alertTone =
    sus && (sus.high || 0) > 0
      ? 'settings-learn-status--warn'
      : sus && (sus.medium || 0) > 0
        ? 'settings-learn-status-line'
        : 'settings-status';

  return (
    <div className="settings-network-monitor">
      <p className="settings-desc" style={{ marginTop: 0 }}>
        Passive capture on <strong>your PC</strong> via <strong>tshark</strong> (Wireshark CLI). With monitoring on, Butler keeps
        capture running while the app is open and can <strong>notify</strong> you when medium/high heuristic patterns appear—not a
        full IDS.
      </p>
      <p className="settings-desc">
        {probe?.ok ? (
          <span className="settings-status">
            ✓ {probe.version || probe.path || 'tshark OK'}
            {probe.auto_wireshark ? (
              <span className="settings-desc" style={{ display: 'block', marginTop: 6, fontSize: '0.85rem', fontWeight: 400 }}>
                Installed automatically via winget on first check. Restart Butler if capture still fails (PATH refresh).
              </span>
            ) : null}
          </span>
        ) : (
          <span className="settings-learn-status-line settings-learn-status--warn">
            {probe?.error || 'tshark not detected.'}
            {probe?.setup_hint ? (
              <span className="settings-desc" style={{ display: 'block', marginTop: 8, fontWeight: 400 }}>
                {probe.setup_hint}
              </span>
            ) : (
              !probe?.error && (
                <span className="settings-desc" style={{ display: 'block', marginTop: 8, fontWeight: 400 }}>
                  Install Wireshark or set <code>BUTLER_TSHARK_PATH</code> in <code>.env</code>.
                </span>
              )
            )}
          </span>
        )}
      </p>

      {!probe?.ok ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <button type="button" className="settings-save" disabled={wingetBusy} onClick={() => void loadProbe()}>
            Re-check tshark
          </button>
          {probe?.can_install_winget ? (
            <button
              type="button"
              className="settings-save"
              disabled={wingetBusy}
              onClick={() => void runWingetInstallWireshark()}
            >
              {wingetBusy ? 'Installing…' : 'Install Wireshark (winget)'}
            </button>
          ) : null}
        </div>
      ) : null}

      {probe?.ok ? (
        <div
          style={{
            marginBottom: 14,
            padding: '12px 14px',
            borderRadius: 8,
            background: 'var(--butler-panel-bg, rgba(0,0,0,0.08))',
            border: '1px solid var(--butler-border, rgba(255,255,255,0.08))',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={watchWhileOpen}
              onChange={(e) => {
                const v = e.target.checked;
                setWatchWhileOpen(v);
                setNetworkMonitorWatchEnabled(v);
                if (!v) setNotifySuspicious(false);
                if (!v) setNetworkMonitorNotifyEnabled(false);
              }}
              style={{ marginTop: 3 }}
            />
            <span style={{ fontSize: '0.95rem' }}>
              <strong>Monitor while Butler is open</strong>
              <span className="settings-learn-status-line settings-learn-status--muted" style={{ display: 'block', marginTop: 4, fontSize: '0.82rem' }}>
                Keeps tshark running in the background (uses the interface and optional BPF below). Turn off to stop capture.
              </span>
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: watchWhileOpen ? 'pointer' : 'not-allowed', opacity: watchWhileOpen ? 1 : 0.55 }}>
            <input
              type="checkbox"
              checked={notifySuspicious && watchWhileOpen}
              disabled={!watchWhileOpen}
              onChange={async (e) => {
                const v = e.target.checked;
                setNotifySuspicious(v);
                setNetworkMonitorNotifyEnabled(v);
                if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') {
                  await Notification.requestPermission();
                }
              }}
              style={{ marginTop: 3 }}
            />
            <span style={{ fontSize: '0.95rem' }}>
              <strong>Alert on suspicious activity</strong>
              <span className="settings-learn-status-line settings-learn-status--muted" style={{ display: 'block', marginTop: 4, fontSize: '0.82rem' }}>
                Desktop notification when new <strong>medium</strong> or <strong>high</strong> heuristic alerts appear (not low-severity noise).
              </span>
            </span>
          </label>
          {watchWhileOpen ? (
            <p className="settings-learn-status-line" style={{ margin: '12px 0 0', fontSize: '0.88rem' }}>
              {snap?.running ? (
                <>
                  <span className="settings-status">● Live</span>
                  {snap?.startedAt ? ` — since ${new Date(snap.startedAt).toLocaleString()}` : null}
                </>
              ) : (
                <span className="settings-learn-status-line settings-learn-status--muted">Starting or waiting for capture…</span>
              )}
            </p>
          ) : null}
        </div>
      ) : null}

      <div style={{ margin: '14px 0 16px' }}>
        <button
          type="button"
          className="settings-save"
          style={{ fontSize: '1rem', padding: '10px 18px' }}
          onClick={() => void runQuickScan()}
          disabled={scanBusy || !probe?.ok}
        >
          {scanBusy ? 'Scanning network (~12s)…' : 'Run 12s sample scan'}
        </button>
        <p className="settings-learn-status-line settings-learn-status--muted" style={{ marginTop: 8, fontSize: '0.82rem' }}>
          Optional one-shot: captures ~12 seconds then stops (same heuristics as live monitoring). Install Wireshark; on Windows run
          Butler as administrator if capture fails.
        </p>
      </div>

      {scanErr ? (
        <div style={{ marginBottom: 10 }}>
          <p className="settings-learn-status-line settings-learn-status--warn">{scanErr}</p>
          {scanErrHint ? (
            <p className="settings-desc" style={{ marginTop: 6, fontSize: '0.85rem' }}>
              {scanErrHint}
            </p>
          ) : null}
        </div>
      ) : null}

      {scanResult?.ok && sus ? (
        <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 8, background: 'var(--butler-panel-bg, rgba(0,0,0,0.12))' }}>
          <p className={alertTone} style={{ margin: 0, fontWeight: 600 }}>
            {sus.headline}
          </p>
          <p className="settings-learn-status-line settings-learn-status--muted" style={{ margin: '6px 0 0', fontSize: '0.82rem' }}>
            Interface: {scanResult.ifaceLabel || scanResult.iface || '—'} · Events seen: {scanResult.eventsSeen ?? 0} · Window:{' '}
            {scanResult.seconds ?? '?'}s
          </p>
          {scanResult.disclaimer ? (
            <p className="settings-learn-status-line settings-learn-status--muted" style={{ margin: '8px 0 0', fontSize: '0.78rem' }}>
              {scanResult.disclaimer}
            </p>
          ) : null}
          {(scanResult.alerts || []).length > 0 ? (
            <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: '0.85rem', maxHeight: 200, overflow: 'auto' }}>
              {(scanResult.alerts || []).map((a, i) => (
                <li key={a.id != null ? `a-${a.id}` : `${a.t}-${a.kind}-${i}`}>
                  <span className="settings-learn-status--muted">{a.severity}</span> {a.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-desc" style={{ margin: '10px 0 0', fontSize: '0.85rem' }}>
              No pattern matches in this window (traffic may still be present).
            </p>
          )}
        </div>
      ) : null}

      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', fontSize: '0.9rem' }}>Advanced: manual capture & raw feed</summary>
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            {ifaces.length === 0 ? (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: '0.88rem' }}>Interface #</span>
                <input
                  className="settings-input"
                  style={{ width: 56 }}
                  value={iface}
                  onChange={(e) => setIface(e.target.value)}
                  spellCheck={false}
                />
              </label>
            ) : null}
            <button type="button" className="settings-save" onClick={() => void loadIfaces()} disabled={busy}>
              List interfaces
            </button>
          </div>
          {ifErr ? <p className="settings-learn-status-line settings-learn-status--warn">{ifErr}</p> : null}
          {ifaces.length > 0 ? (
            <select
              className="settings-input"
              style={{ maxWidth: '100%', marginBottom: 10 }}
              value={iface}
              onChange={(e) => setIface(e.target.value)}
            >
              {ifaces.map((x) => (
                <option key={x.index} value={x.index}>
                  {x.index}. {x.label}
                </option>
              ))}
            </select>
          ) : null}
          <label style={{ display: 'block', fontSize: '0.88rem', marginBottom: 4 }}>
            Optional BPF filter (e.g. <code>host 192.168.1.1</code>) — used by live monitoring and the 12s sample when set
          </label>
          <input
            className="settings-input"
            style={{ width: '100%', maxWidth: '100%', marginBottom: 10 }}
            value={bpf}
            onChange={(e) => setBpf(e.target.value)}
            placeholder="Leave empty for all traffic (can be noisy)"
            spellCheck={false}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button type="button" className="settings-save" onClick={() => void start()} disabled={busy || !probe?.ok}>
              {busy ? '…' : 'Start capture'}
            </button>
            <button type="button" className="settings-save" onClick={() => void stop()} disabled={busy}>
              Stop
            </button>
          </div>
          <p className="settings-desc" style={{ fontSize: '0.85rem' }}>
            Status:{' '}
            <strong>{snap?.running ? 'capturing' : 'idle'}</strong>
            {snap?.startedAt ? ` · since ${new Date(snap.startedAt).toLocaleString()}` : ''}
          </p>
          {snap?.alerts && snap.alerts.length > 0 ? (
            <div style={{ marginBottom: 12 }}>
              <strong style={{ fontSize: '0.9rem' }}>Alerts (heuristic)</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: '0.82rem', maxHeight: 140, overflow: 'auto' }}>
                {snap.alerts
                  .slice()
                  .reverse()
                  .slice(0, 24)
                  .map((a, i) => (
                    <li key={`${a.t}-${i}`}>
                      <span className="settings-learn-status--muted">{a.severity}</span> {a.detail}
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
          <details>
            <summary style={{ cursor: 'pointer', fontSize: '0.88rem' }}>Recent lines (raw)</summary>
            <pre className="settings-selftest-pre" style={{ maxHeight: 200, marginTop: 8, fontSize: '0.75rem' }} tabIndex={0}>
              {(snap?.events || [])
                .slice()
                .reverse()
                .slice(0, 40)
                .map((e) => e.raw || '')
                .join('\n') || '—'}
            </pre>
          </details>
        </div>
      </details>
    </div>
  );
}

function SecurityLabPanel() {
  const [data, setData] = useState<{
    disclaimer?: string;
    resources?: Array<{ title?: string; url?: string; detail?: string }>;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/security-lab');
        setData(await r.json());
      } catch {
        setData(null);
      }
    })();
  }, []);

  return (
    <div className="settings-security-lab">
      {data?.disclaimer ? (
        <p className="settings-desc" style={{ marginTop: 0 }}>
          {data.disclaimer}
        </p>
      ) : null}
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.88rem' }}>
        {(data?.resources || []).map((r) => (
          <li key={r.url} style={{ marginBottom: 8 }}>
            <a href={r.url} target="_blank" rel="noreferrer">
              {r.title}
            </a>
            {r.detail ? <div className="settings-learn-status-line settings-learn-status--muted">{r.detail}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function KaliToolsPanel() {
  const [data, setData] = useState<{
    disclaimer?: string;
    intro?: string;
    categories?: Array<{
      title?: string;
      detail?: string;
      tools?: Array<{ name?: string; url?: string; detail?: string }>;
    }>;
    more?: { title?: string; url?: string; detail?: string };
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/kali-tools');
        setData(await r.json());
      } catch {
        setData(null);
      }
    })();
  }, []);

  return (
    <div className="settings-kali-tools">
      {data?.disclaimer ? (
        <p className="settings-desc" style={{ marginTop: 0 }}>
          {data.disclaimer}
        </p>
      ) : null}
      {data?.intro ? <p className="settings-desc">{data.intro}</p> : null}
      {(data?.categories || []).map((cat) => (
        <div key={cat.title} style={{ marginBottom: 14 }}>
          <strong style={{ fontSize: '0.92rem' }}>{cat.title}</strong>
          {cat.detail ? (
            <div className="settings-learn-status-line settings-learn-status--muted" style={{ fontSize: '0.82rem', marginTop: 2 }}>
              {cat.detail}
            </div>
          ) : null}
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: '0.86rem' }}>
            {(cat.tools || []).map((t) => (
              <li key={`${cat.title}-${t.name}-${t.url}`} style={{ marginBottom: 6 }}>
                <a href={t.url} target="_blank" rel="noreferrer">
                  {t.name}
                </a>
                {t.detail ? (
                  <span className="settings-learn-status--muted" style={{ marginLeft: 6, fontSize: '0.82rem' }}>
                    — {t.detail}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {data?.more?.url ? (
        <p className="settings-desc" style={{ marginTop: 8, fontSize: '0.85rem' }}>
          <a href={data.more.url} target="_blank" rel="noreferrer">
            {data.more.title || 'Full tool index'}
          </a>
          {data.more.detail ? (
            <span className="settings-learn-status--muted" style={{ marginLeft: 6 }}>
              {data.more.detail}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function InfooozePanel() {
  const [data, setData] = useState<{
    intro?: string;
    install_lines?: string[];
    links?: Array<{ title?: string; url?: string }>;
    features?: string[];
    cli_options?: Array<{ short?: string; long?: string; desc?: string }>;
    examples?: Array<{ cmd?: string; note?: string }>;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/infoooze');
        setData(await r.json());
      } catch {
        setData(null);
      }
    })();
  }, []);

  return (
    <div className="settings-infoooze">
      {data?.intro ? <p className="settings-desc" style={{ marginTop: 0 }}>{data.intro}</p> : null}
      {data?.install_lines && data.install_lines.length > 0 ? (
        <pre
          className="settings-selftest-pre"
          style={{ marginTop: 10, fontSize: '0.78rem', maxHeight: 120, overflow: 'auto' }}
          tabIndex={0}
        >
          {data.install_lines.join('\n')}
        </pre>
      ) : null}
      {data?.links && data.links.length > 0 ? (
        <ul style={{ margin: '12px 0 0', paddingLeft: 18, fontSize: '0.88rem' }}>
          {data.links.map((l) => (
            <li key={l.url} style={{ marginBottom: 6 }}>
              <a href={l.url} target="_blank" rel="noreferrer">
                {l.title}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {data?.features && data.features.length > 0 ? (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.9rem' }}>Features ({data.features.length})</summary>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: '0.82rem', maxHeight: 160, overflow: 'auto' }}>
            {data.features.map((f) => (
              <li key={f} style={{ marginBottom: 4 }}>
                {f}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {data?.cli_options && data.cli_options.length > 0 ? (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.9rem' }}>CLI flags</summary>
          <div style={{ marginTop: 8, overflowX: 'auto' }}>
            <table className="settings-status-table" style={{ fontSize: '0.78rem', width: '100%' }}>
              <thead>
                <tr>
                  <th className="status-td-label">Short</th>
                  <th className="status-td-label">Long</th>
                  <th className="status-td-label">Description</th>
                </tr>
              </thead>
              <tbody>
                {data.cli_options.map((o) => (
                  <tr key={o.long}>
                    <td>
                      <code>{o.short}</code>
                    </td>
                    <td>
                      <code>{o.long}</code>
                    </td>
                    <td className="status-td-detail">{o.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
      {data?.examples && data.examples.length > 0 ? (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.9rem' }}>Examples</summary>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: '0.82rem' }}>
            {data.examples.map((ex) => (
              <li key={ex.cmd} style={{ marginBottom: 8 }}>
                <code style={{ fontSize: '0.8rem' }}>{ex.cmd}</code>
                {ex.note ? (
                  <span className="settings-learn-status--muted" style={{ marginLeft: 8, fontSize: '0.78rem' }}>
                    {ex.note}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function readExpandablePref(key: string, defaultOpen: boolean): boolean {
  try {
    const s = localStorage.getItem(key);
    if (s === '0') return false;
    if (s === '1') return true;
    return defaultOpen;
  } catch {
    return defaultOpen;
  }
}

function ExpandableModuleSection({
  storageKey,
  title,
  defaultOpen = true,
  children,
}: {
  storageKey: string;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => readExpandablePref(storageKey, defaultOpen));
  const panelId = useId();
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, open ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [open, storageKey]);
  return (
    <div className="module-toolbar module-toolbar-expandable">
      <button
        type="button"
        className="module-toolbar-expandable-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span className="module-toolbar-label module-toolbar-expandable-label">{title}</span>
        <span className="module-toolbar-expandable-chevron" aria-hidden>
          {open ? '▼' : '▶'}
        </span>
      </button>
      {open ? (
        <div id={panelId} className="module-toolbar-expandable-panel">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function ExpandableSubSection({
  storageKey,
  title,
  defaultOpen = true,
  children,
}: {
  storageKey: string;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => readExpandablePref(storageKey, defaultOpen));
  const panelId = useId();
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, open ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [open, storageKey]);
  return (
    <div className="expandable-subsection">
      <button
        type="button"
        className="expandable-subsection-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span className="expandable-subsection-title">{title}</span>
        <span className="expandable-subsection-chevron" aria-hidden>
          {open ? '▼' : '▶'}
        </span>
      </button>
      {open ? (
        <div id={panelId} className="expandable-subsection-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}

const createTab = (opts?: { isCodeHelper?: boolean }): ChatTab => ({
  id: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  label: 'Chat',
  messages: [
    {
      id: 'welcome',
      role: 'assistant',
      content: opts?.isCodeHelper
        ? "I'm Code Helper. I’m here to guide you from zero → job‑ready full‑stack developer. Ask coding questions, request exercises, or tell me what you want to build."
        : "I'm Butler. Ask for anything in plain English—code, jobs, images, gigs, fixes—no modes or special phrasing.",
      source: 'Local',
    },
  ],
  isSending: false,
  sendLog: [],
});

const initialTab = createTab();
export const App: React.FC<{ agentOnlyShell?: boolean }> = ({ agentOnlyShell = false }) => {
  const headerRef = useRef<HTMLElement>(null);
  const appMainRef = useRef<HTMLElement>(null);
  const [showStartupSplash, setShowStartupSplash] = useState(true);
  const [agentView, setAgentView] = useState<ButlerWorkspaceView>(() =>
    agentOnlyShell ? 'agent' : readButlerWorkspaceViewFromHash(),
  );
  const [agentMounted, setAgentMounted] = useState(() =>
    agentOnlyShell ? true : readButlerWorkspaceViewFromHash() !== 'chat',
  );
  const dismissStartupSplash = useCallback(() => {
    setShowStartupSplash(false);
  }, []);
  const [tabs, setTabs] = useState<ChatTab[]>([initialTab]);
  const [activeTabId, setActiveTabId] = useState<string>(initialTab.id);
  const [butlerVariant, setButlerVariant] = useState<'butler' | 'code-helper' | string>('butler');
  const isCodeHelperVariant = butlerVariant === 'code-helper';
  const [settings, setSettings] = useState<Settings>({
    openaiApiKey: '',
    hasKey: false,
  });
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [input, setInput] = useState('');
  /** Last main-composer sends (oldest → newest), max CHAT_PROMPT_HISTORY_MAX — shell-style ↑/↓; restored from localStorage. */
  const chatPromptHistoryRef = useRef<string[]>(readStoredChatPromptHistory());
  /** null = editing; 0 = newest history line; larger = older lines. */
  const chatHistoryDepthRef = useRef<number | null>(null);
  /** Draft before first ↑ while browsing. */
  const chatHistoryDraftRef = useRef('');
  const [isListening, setIsListening] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [jobAction, setJobAction] = useState<'tailor' | 'cover' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSubTab, setSettingsSubTab] = useState<'general' | 'data' | 'vram'>('general');
  const [animationGenOpen, setAnimationGenOpen] = useState(false);
  const [animationGenMinimized, setAnimationGenMinimized] = useState(false);
  const [butlorDataSummary, setButlorDataSummary] = useState<{
    ok?: boolean;
    root?: string;
    butlor_config_env?: string | null;
    locations?: ButlorLocationRow[];
    error?: string;
  } | null>(null);
  const [butlorDataLoading, setButlorDataLoading] = useState(false);
  const [butlorDataError, setButlorDataError] = useState<string | null>(null);
  const [darkMode, setDarkMode] = useState(readStoredThemeDark);
  const settingsModalTitleId = useId();
  const secretMenuTitleId = useId();
  const activityLogModalTitleId = useId();
  const [profileOpen, setProfileOpen] = useState(false);
  const profileModalTitleId = useId();
  const activityLogModalPosRef = useRef(loadActivityLogModalPos());
  const [activityLogModalPos, setActivityLogModalPos] = useState(() => activityLogModalPosRef.current);
  const [activityLogModalOpen, setActivityLogModalOpen] = useState(false);
  const [activityLogDrag, setActivityLogDrag] = useState<{
    startX: number;
    startY: number;
    origLeft: number;
    origTop: number;
  } | null>(null);
  const [jobLoading, setJobLoading] = useState(false);
  const [resumePdfModalOpen, setResumePdfModalOpen] = useState(false);
  const [resumePdfPending, setResumePdfPending] = useState<{
    html: string;
    filenameStem: string;
    showJobLoading: boolean;
  } | null>(null);
  const [resumePdfPreview, setResumePdfPreview] = useState<{
    url: string;
    filename: string;
    savedPath?: string;
  } | null>(null);
  const [resumeDocxLastInput, setResumeDocxLastInput] = useState<{ html: string; filenameStem: string } | null>(null);
  const resumePdfPreviewBlobUrlRef = useRef<string | null>(null);
  const dismissResumePdfPreview = useCallback(() => {
    if (resumePdfPreviewBlobUrlRef.current) {
      URL.revokeObjectURL(resumePdfPreviewBlobUrlRef.current);
      resumePdfPreviewBlobUrlRef.current = null;
    }
    setResumePdfPreview(null);
  }, []);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((j) => {
        const v = typeof j?.variant === 'string' ? j.variant.trim() : '';
        if (v) {
          setButlerVariant(v);
          if (v === 'code-helper') {
            // Replace the initial welcome message verbiage for this variant.
            setTabs((prev) => {
              if (!prev.length) return [createTab({ isCodeHelper: true })];
              const first = prev[0];
              if (!first?.messages?.length) return prev;
              if (first.messages[0]?.id !== 'welcome') return prev;
              const nextFirst: ChatTab = {
                ...first,
                messages: [
                  {
                    ...first.messages[0],
                    content:
                      "I'm Code Helper. I’m here to guide you from zero → job‑ready full‑stack developer. Ask coding questions, request exercises, or tell me what you want to build.",
                  },
                  ...first.messages.slice(1),
                ],
              };
              return [nextFirst, ...prev.slice(1)];
            });
          }
        }
      })
      .catch(() => {
        // ignore
      });
  }, []);

  useEffect(() => {
    return () => {
      if (resumePdfPreviewBlobUrlRef.current) {
        URL.revokeObjectURL(resumePdfPreviewBlobUrlRef.current);
      }
    };
  }, []);

  const [speechSupported, setSpeechSupported] = useState(false);
  const [profile, setProfile] = useState<{
    name?: string;
    email?: string;
    phone?: string;
    base_resume?: string;
    base_resume_html?: string;
    has_resume_template?: boolean;
    indeed_use_chrome_profile?: boolean;
    chrome_profile_path?: string;
    indeed_email?: string;
    indeed_password?: string;
    facebook_use_chrome_profile?: boolean;
    facebook_email?: string;
    facebook_password?: string;
    facebook_chrome_profile_directory?: string;
  } | null>(null);
  const [chatAttachment, setChatAttachment] = useState<{
    dataUrl: string;
    name: string;
    mime: string;
  } | null>(null);
  const [stealthImageAttach, setStealthImageAttach] = useState(readStoredStealthImageAttach);
  const [codeWorkspaceContext, setCodeWorkspaceContext] = useState(readStoredCodeWorkspaceContext);
  const [codeCursorCliEnabled, setCodeCursorCliEnabled] = useState(readStoredCodeCursorCliEnabled);
  const [codeCursorCliCommand, setCodeCursorCliCommand] = useState(readStoredCodeCursorCliCommand);
  const [avatarSpeaking, setAvatarSpeaking] = useState(false);
  const [setupName, setSetupName] = useState('');
  const [setupEmail, setSetupEmail] = useState('');
  const [setupPhone, setSetupPhone] = useState('');
  const [setupResumeHtml, setSetupResumeHtml] = useState('<p><br></p>');
  const [setupIndeedChromeProfile, setSetupIndeedChromeProfile] = useState(false);
  const [setupChromeProfilePath, setSetupChromeProfilePath] = useState('');
  const [setupIndeedEmail, setSetupIndeedEmail] = useState('');
  const [setupIndeedPassword, setSetupIndeedPassword] = useState('');
  const [setupFacebookUseChrome, setSetupFacebookUseChrome] = useState(false);
  const [setupFacebookEmail, setSetupFacebookEmail] = useState('');
  const [setupFacebookPassword, setSetupFacebookPassword] = useState('');
  const [setupFacebookChromeDir, setSetupFacebookChromeDir] = useState('');
  const [setupFacebookDetectStatus, setSetupFacebookDetectStatus] = useState('');
  const [setupSaving, setSetupSaving] = useState(false);
  const [voiceFaceMinimized, setVoiceFaceMinimized] = useState(false);
  const [dockFlySession, setDockFlySession] = useState<ButlerDockFlyPayload | null>(null);
  const voiceHeaderDockTargetRef = useRef<HTMLDivElement>(null);
  const webButlerFloatRef = useRef<WebButlerFloatHandle>(null);
  const [browserSpeechOk, setBrowserSpeechOk] = useState(false);
  /** After repeated Web Speech `network` errors (common in Electron / offline), use PCM + server STT instead. */
  const [webSpeechDegraded, setWebSpeechDegraded] = useState(false);
  /** From Permissions API when the browser exposes `microphone` (Chromium / Electron). */
  const [micBrowserPermission, setMicBrowserPermission] = useState<'granted' | 'denied' | 'prompt' | null>(null);
  const [micTestBusy, setMicTestBusy] = useState(false);
  const [micTestOutcome, setMicTestOutcome] = useState<'idle' | 'ok' | 'error'>('idle');
  const [micTestMessage, setMicTestMessage] = useState('');
  /** Shown in chat when conversation mode cannot use the mic or STT fails to start. */
  /** User mutes their mic during voice conversation (STT paused until unmuted). */
  const [voiceMicMuted, setVoiceMicMuted] = useState(false);
  const [voiceConversationError, setVoiceConversationError] = useState<string | null>(null);
  const [voiceEnableBusy, setVoiceEnableBusy] = useState(false);
  /** Web Speech / PCM: mic picked up speech-level audio. */
  const [voiceConvoUserSpeaking, setVoiceConvoUserSpeaking] = useState(false);
  /** Short preview of last transcript Butler received from your voice. */
  const [voiceConvoHeardPreview, setVoiceConvoHeardPreview] = useState<string | null>(null);
  const voiceHeardClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [devGlobalRootDraft, setDevGlobalRootDraft] = useState('');
  const [devTrustedRootsDraft, setDevTrustedRootsDraft] = useState('');
  type GoLearnStatus = {
    running?: boolean;
    stage?: string;
    topics_total?: number;
    topics_done?: number;
    chunks_added?: number;
    current_topic?: string;
    last_error?: string;
    started_at?: number;
    finished_at?: number;
    chroma_chunks_total?: number | null;
    error?: string;
  };
  const [goLearnStatus, setGoLearnStatus] = useState<GoLearnStatus | null>(null);
  const [goLearnBusy, setGoLearnBusy] = useState(false);
  const goLearnPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [selfTestRunning, setSelfTestRunning] = useState(false);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildMessage, setRebuildMessage] = useState<string | null>(null);
  const [selfTestResult, setSelfTestResult] = useState<{
    ok?: boolean;
    summary?: string;
    message?: string;
    results?: { name: string; ok: boolean; detail?: string; output?: string }[];
  } | null>(null);
  const [secretMenuOpen, setSecretMenuOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_SECRET_MENU_OPEN) === '1';
    } catch {
      return false;
    }
  });
  const [secretMenuFlavor, setSecretMenuFlavor] = useState<'qwe' | null>(null);
  /** Composer inside the utility panel only — does not use the main chat textarea. */
  const [secretMenuChatInput, setSecretMenuChatInput] = useState('');
  const [secretMenuAttachment, setSecretMenuAttachment] = useState<{
    dataUrl: string;
    name: string;
    mime: string;
  } | null>(null);
  /** Utility panel: generated image gallery is hidden until expanded (keeps the panel compact). */
  const [secretMenuGeneratedGalleryOpen, setSecretMenuGeneratedGalleryOpen] = useState(false);
  const [secretMenuPoseReference, setSecretMenuPoseReference] = useState<PoseReferenceImage | null>(null);
  const [secretMenuMinimized, setSecretMenuMinimized] = useState(false);
  const [utilityPanelModalSize, setUtilityPanelModalSize] = useState(readStoredUtilityPanelModalSize);
  const utilityPanelSizeLiveRef = useRef(utilityPanelModalSize);
  utilityPanelSizeLiveRef.current = utilityPanelModalSize;
  const utilityPanelResizeDragRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [belowStairsStatus, setBelowStairsStatus] = useState<
    'idle' | 'pending' | 'done' | 'error'
  >('idle');
  const [belowStairsStatusDetail, setBelowStairsStatusDetail] = useState<string | null>(null);
  const belowStairsStatusClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qweChordRef = useRef({ q: false, w: false, e: false });
  const [chatSectionHeightPx, setChatSectionHeightPx] = useState<number | null>(() => readStoredChatSectionPx());
  const [appHeaderHeightPx, setAppHeaderHeightPx] = useState<number | null>(() =>
    readStoredLayoutPx(APP_HEADER_HEIGHT_KEY, APP_HEADER_MIN_PX, APP_HEADER_MAX_PX),
  );
  const [splitChatWidthPx, setSplitChatWidthPx] = useState<number | null>(() =>
    readStoredLayoutPx(SPLIT_CHAT_WIDTH_KEY, SPLIT_PANE_MIN_PX, 1200),
  );

  useEffect(() => {
    if (agentOnlyShell) {
      setAgentMounted(true);
      return;
    }
    const onHashChange = () => {
      const nextView = readButlerWorkspaceViewFromHash();
      setAgentView(nextView);
      if (nextView !== 'chat') setAgentMounted(true);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [agentOnlyShell]);

  const showAgentView = useCallback(
    (nextView: Exclude<ButlerWorkspaceView, 'chat'>) => {
      setAgentMounted(true);
      setAgentView(nextView);
      if (!agentOnlyShell) writeButlerWorkspaceViewHash(nextView);
    },
    [agentOnlyShell],
  );

  const showChatOnlyView = useCallback(() => {
    setAgentView('chat');
    if (!agentOnlyShell) writeButlerWorkspaceViewHash('chat');
  }, [agentOnlyShell]);

  useNetworkMonitorWatch();

  const triggerDesktopRebuild = useCallback(() => {
    setRebuildBusy(true);
    setRebuildMessage(null);
    return fetch('/api/butler/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then((r) => r.json().catch(() => ({ ok: false, message: 'Invalid response' })))
      .then((d: { ok?: boolean; message?: string }) => {
        setRebuildMessage(
          typeof d?.message === 'string' && d.message.trim()
            ? d.message
            : d?.ok
              ? 'Started rebuild.'
              : 'Rebuild could not be started.',
        );
      })
      .catch((e: Error) => setRebuildMessage(e?.message || String(e)))
      .finally(() => setRebuildBusy(false));
  }, []);

  const triggerSelfTest = useCallback(() => {
    setSelfTestRunning(true);
    setSelfTestResult(null);
    return fetch('/api/tests/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then((r) => r.json().catch(() => ({ ok: false, message: 'Invalid JSON response', results: [] })))
      .then((d) => setSelfTestResult(d))
      .catch((e: Error) => setSelfTestResult({ ok: false, message: e?.message || String(e), results: [] }))
      .finally(() => setSelfTestRunning(false));
  }, []);

  const onSecretHeaderDoubleClick = useCallback((e: React.MouseEvent) => {
    const k = qweChordRef.current;
    if (!k.q || !k.w || !k.e) return;
    e.preventDefault();
    setSecretMenuFlavor('qwe');
    setSecretMenuOpen(true);
    setSecretMenuMinimized(false);
  }, []);

  useEffect(() => {
    const setChordKey = (code: string, down: boolean) => {
      if (code === 'KeyQ') qweChordRef.current.q = down;
      else if (code === 'KeyW') qweChordRef.current.w = down;
      else if (code === 'KeyE') qweChordRef.current.e = down;
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (keyboardEventTargetIsEditable(e.target)) return;
      setChordKey(e.code, true);
    };
    const onUp = (e: KeyboardEvent) => {
      setChordKey(e.code, false);
    };
    const resetChord = () => {
      qweChordRef.current = { q: false, w: false, e: false };
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', resetChord);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', resetChord);
    };
  }, []);

  useEffect(() => {
    try {
      if (chatSectionHeightPx == null) localStorage.removeItem(CHAT_SECTION_HEIGHT_KEY);
      else localStorage.setItem(CHAT_SECTION_HEIGHT_KEY, String(chatSectionHeightPx));
    } catch {
      /* ignore quota */
    }
  }, [chatSectionHeightPx]);

  useEffect(() => {
    try {
      if (appHeaderHeightPx == null) localStorage.removeItem(APP_HEADER_HEIGHT_KEY);
      else localStorage.setItem(APP_HEADER_HEIGHT_KEY, String(appHeaderHeightPx));
    } catch {
      /* ignore quota */
    }
  }, [appHeaderHeightPx]);

  useEffect(() => {
    try {
      if (splitChatWidthPx == null) localStorage.removeItem(SPLIT_CHAT_WIDTH_KEY);
      else localStorage.setItem(SPLIT_CHAT_WIDTH_KEY, String(splitChatWidthPx));
    } catch {
      /* ignore quota */
    }
  }, [splitChatWidthPx]);

  useEffect(() => {
    const onResize = () => {
      setChatSectionHeightPx((h) => {
        if (h == null) return null;
        const cap = getChatSectionMaxPx();
        return h > cap ? cap : h;
      });
      setAppHeaderHeightPx((h) =>
        h == null ? null : clampLayout(h, APP_HEADER_MIN_PX, APP_HEADER_MAX_PX),
      );
      setSplitChatWidthPx((w) => {
        if (w == null) return null;
        const totalWidth = appMainRef.current?.getBoundingClientRect().width ?? window.innerWidth;
        return clampLayout(w, SPLIT_PANE_MIN_PX, getSplitChatMaxPx(totalWidth));
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const sub = window.butlerElectron?.onButlerFloatDocked;
    if (!sub) return;
    return sub(() => setVoiceFaceMinimized(true));
  }, []);

  useEffect(() => {
    const sub = window.butlerElectron?.onButlerFloatDockFly;
    if (!sub) return;
    return sub((p) => {
      if (p && typeof p.fromX === 'number' && typeof p.fromY === 'number') {
        const d =
          typeof p.spherePx === 'number' && p.spherePx > 0 ? p.spherePx : 252;
        setDockFlySession({
          fromCenter: { x: p.fromX, y: p.fromY },
          fromDiameter: d,
        });
      } else {
        setVoiceFaceMinimized(true);
      }
    });
  }, []);

  const completeDockFly = useCallback(() => {
    setDockFlySession(null);
    setVoiceFaceMinimized(true);
  }, []);

  useEffect(() => {
    if (!settings.voiceMode) setDockFlySession(null);
  }, [settings.voiceMode]);

  useEffect(() => {
    const be = window.butlerElectron;
    if (!be) return;
    if (!settings.voiceMode) {
      void be.closeButlerFloat();
      return;
    }
    if (voiceFaceMinimized || dockFlySession) {
      void be.hideButlerFloat();
    } else {
      void be.openButlerFloat();
    }
  }, [settings.voiceMode, voiceFaceMinimized, dockFlySession]);

  useEffect(() => {
    const be = window.butlerElectron;
    if (!be?.syncButlerFloat) return;
    if (!settings.voiceMode) return;
    const activeSending = tabs.find((t) => t.id === activeTabId)?.isSending;
    const voicePaused = !!(avatarSpeaking || activeSending);
    be.syncButlerFloat({
      speaking: avatarSpeaking,
      voiceActive: true,
      userSpeaking: voiceConvoUserSpeaking,
      heardPreview: voiceConvoHeardPreview,
      voicePaused,
      micMuted: voiceMicMuted,
    });
  }, [
    avatarSpeaking,
    tabs,
    activeTabId,
    settings.voiceMode,
    voiceConvoUserSpeaking,
    voiceConvoHeardPreview,
    voiceMicMuted,
  ]);

  useEffect(() => {
    try {
      localStorage.setItem(CODE_WORKSPACE_CONTEXT_KEY, codeWorkspaceContext);
    } catch {
      /* ignore quota */
    }
  }, [codeWorkspaceContext]);

  useEffect(() => {
    try {
      localStorage.setItem(CODE_CURSOR_CLI_ENABLED_KEY, codeCursorCliEnabled ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [codeCursorCliEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(CODE_CURSOR_CLI_COMMAND_KEY, codeCursorCliCommand);
    } catch {
      /* ignore */
    }
  }, [codeCursorCliCommand]);

  const sendLogPreRef = useRef<HTMLPreElement>(null);
  const codeContextTaRef = useRef<HTMLTextAreaElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const secretMenuChatInputRef = useRef<HTMLTextAreaElement>(null);
  const chatPanelRef = useRef<HTMLElement | null>(null);

  const attachCodeContextTa = useCallback((el: HTMLTextAreaElement | null) => {
    codeContextTaRef.current = el;
    if (el) {
      el.style.height = '0px';
      el.style.height = `${Math.min(Math.max(el.scrollHeight, 72), 360)}px`;
    }
  }, []);

  const resizeCodeContextTa = useCallback(() => {
    const el = codeContextTaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 72), 360)}px`;
  }, []);

  const resizeChatInput = useCallback(() => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 52), 220)}px`;
  }, []);

  const applySecretMenuPromptSnippet = useCallback((snippet: string) => {
    const t = snippet.trim();
    if (!t) return;
    setSecretMenuChatInput((prev) => {
      const p = prev.trim();
      return p ? `${p}\n\n${t}` : t;
    });
    requestAnimationFrame(() => secretMenuChatInputRef.current?.focus());
  }, []);

  const onUtilityPanelResizePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const { w, h } = utilityPanelSizeLiveRef.current;
    utilityPanelResizeDragRef.current = { x: e.clientX, y: e.clientY, w, h };
  }, []);

  const onUtilityPanelResizePointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = utilityPanelResizeDragRef.current;
    if (!d) return;
    const nw = d.w + (e.clientX - d.x);
    const nh = d.h + (e.clientY - d.y);
    const next = clampUtilityPanelSize(nw, nh);
    utilityPanelSizeLiveRef.current = next;
    setUtilityPanelModalSize(next);
  }, []);

  const onUtilityPanelResizePointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (utilityPanelResizeDragRef.current) {
      utilityPanelResizeDragRef.current = null;
      try {
        localStorage.setItem(LS_UTILITY_PANEL_MODAL_WH, JSON.stringify(utilityPanelSizeLiveRef.current));
      } catch {
        /* ignore */
      }
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    resizeCodeContextTa();
  }, [codeWorkspaceContext, resizeCodeContextTa]);

  useEffect(() => {
    resizeChatInput();
  }, [input, resizeChatInput]);

  const recognitionRef = useRef<{
    stop: () => Promise<{ pcm: ArrayBuffer; sampleRate: number }>;
    stream?: MediaStream;
  } | null>(null);
  const continuousRecognitionRef = useRef<SpeechRecognition | null>(null);
  const voiceModeRef = useRef<boolean>(!!settings.voiceMode);
  /** Pause STT while Butler speaks or a chat request is in flight (avoids echo / double-send). */
  const voicePauseRef = useRef(false);
  const prevVoicePausedRef = useRef(false);
  /** Exponential backoff when restarting continuous recognition after benign errors. */
  const voiceRecoBackoffMsRef = useRef(400);
  const voiceNetworkErrorsRef = useRef<{ count: number; windowStart: number }>({ count: 0, windowStart: 0 });
  /** Web Speech `audio-capture` bursts (often spurious on stop/restart or Electron). */
  const voiceAudioCaptureErrorsRef = useRef<{ count: number; windowStart: number }>({ count: 0, windowStart: 0 });
  const voiceMiscErrorLogAtRef = useRef(0);
  const chatWindowRef = useRef<HTMLDivElement | null>(null);
  const lastLocalOnlyToggleRef = useRef<number>(0);
  const sendRef = useRef<
    (
      messageOverride?: string,
      opts?: {
        omitMainChatAttachment?: boolean;
        belowStairsAttachment?: { dataUrl: string; name: string; mime: string } | null;
        fromBelowStairs?: boolean;
      },
    ) => void | Promise<void>
  >(() => {});

  const pulseVoiceHeard = useCallback((snippet: string) => {
    const s = snippet.trim().slice(0, 72);
    if (!s) return;
    setVoiceConvoHeardPreview(s);
    if (voiceHeardClearTimerRef.current) clearTimeout(voiceHeardClearTimerRef.current);
    voiceHeardClearTimerRef.current = setTimeout(() => {
      setVoiceConvoHeardPreview(null);
      voiceHeardClearTimerRef.current = null;
    }, 2600);
  }, []);

  const useWebSpeechContinuous =
    browserSpeechOk && !webSpeechDegraded && !preferVoiceConvoPcmOverWebSpeech();

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const addChatTab = () => {
    const t = createTab();
    setTabs((prev) => [...prev, t]);
    setActiveTabId(t.id);
  };
  const closeChatTab = (id: string) => {
    const filtered = tabs.filter((t) => t.id !== id);
    const next = filtered.length ? filtered : [createTab()];
    setTabs(next);
    if (activeTabId === id) setActiveTabId(next[0].id);
  };
  const updateTab = (id: string, updater: Partial<ChatTab> | ((t: ChatTab) => Partial<ChatTab>)) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...(typeof updater === 'function' ? updater(t) : updater) } : t)),
    );
  };

  /** Thumbnails for session stills; includes SD **video** replies (txt2video / image2video) which often have `video` but no `images`. */
  const generatedImageGalleryItems = useMemo(() => {
    type Item = { key: string; tabLabel: string; kind: 'image' | 'video'; src: string; caption?: string };
    const items: Item[] = [];
    for (const t of tabs) {
      for (const m of t.messages) {
        if (m.role !== 'assistant') continue;
        if (m.images?.length) {
          m.images.forEach((img, i) => {
            items.push({
              key: `${t.id}-${m.id}-img-${i}`,
              tabLabel: t.label,
              kind: 'image',
              src: chatInlineImageSrc(img),
              caption: m.variantLabels?.[i],
            });
          });
        }
        if (m.video) {
          items.push({
            key: `${t.id}-${m.id}-vid`,
            tabLabel: t.label,
            kind: 'video',
            src: mediaVideoSrc(m.video),
            caption: 'Video',
          });
        }
      }
    }
    return items.reverse();
  }, [tabs]);

  useEffect(() => {
    const el = sendLogPreRef.current;
    if (el && activeTab?.sendLog?.length) {
      el.scrollTop = el.scrollHeight;
    }
  }, [activeTab?.sendLog, activeTab?.id]);

  useEffect(() => {
    const html = document.documentElement;
    if (darkMode) html.classList.add('theme-dark');
    else html.classList.remove('theme-dark');
    try {
      localStorage.setItem(BUTLER_THEME_KEY, darkMode ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
  }, [darkMode]);

  useEffect(() => {
    if (!activityLogModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActivityLogModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activityLogModalOpen]);

  useEffect(() => {
    if (!activityLogDrag) return;
    const { startX, startY, origLeft, origTop } = activityLogDrag;
    const pad = 8;
    const onMove = (e: MouseEvent) => {
      let nl = origLeft + (e.clientX - startX);
      let nt = origTop + (e.clientY - startY);
      const maxL = Math.max(pad, window.innerWidth - 200);
      const maxT = Math.max(pad, window.innerHeight - 100);
      nl = Math.min(Math.max(pad, nl), maxL);
      nt = Math.min(Math.max(pad, nt), maxT);
      const next = { left: nl, top: nt };
      activityLogModalPosRef.current = next;
      setActivityLogModalPos(next);
    };
    const onUp = () => {
      setActivityLogDrag(null);
      try {
        localStorage.setItem(ACTIVITY_LOG_MODAL_POS_KEY, JSON.stringify(activityLogModalPosRef.current));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [activityLogDrag]);

  const resetActivityLogModalPosition = useCallback(() => {
    try {
      localStorage.removeItem(ACTIVITY_LOG_MODAL_POS_KEY);
    } catch {
      /* ignore */
    }
    const p = loadActivityLogModalPos();
    activityLogModalPosRef.current = p;
    setActivityLogModalPos(p);
  }, []);

  const speakReply = (text: string) => {
    if (!text?.trim() || typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    setAvatarSpeaking(false);
    const chunks = chunkTextForSpeech(text);
    if (!chunks.length) return;
    const voices = window.speechSynthesis.getVoices();
    const preferred = pickBritishTtsVoice(voices);
    let idx = 0;
    const speakNext = () => {
      if (idx >= chunks.length) {
        setAvatarSpeaking(false);
        return;
      }
      const u = new SpeechSynthesisUtterance(chunks[idx]);
      idx += 1;
      u.lang = 'en-GB';
      u.rate = 0.92;
      u.pitch = 1;
      if (preferred) u.voice = preferred;
      u.onstart = () => setAvatarSpeaking(true);
      u.onend = speakNext;
      u.onerror = () => setAvatarSpeaking(false);
      window.speechSynthesis.speak(u);
    };
    speakNext();
  };

  const stopAssistantSpeech = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
    setAvatarSpeaking(false);
  }, []);

  useEffect(() => {
    if (!settings.voiceMode || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopAssistantSpeech();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settings.voiceMode, stopAssistantSpeech]);

  useEffect(() => {
    setSpeechSupported(!!(navigator.mediaDevices?.getUserMedia));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as Window & { webkitSpeechRecognition?: new () => SpeechRecognition };
    setBrowserSpeechOk(!!(window.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  useEffect(() => {
    if (settings.voiceMode) setVoiceFaceMinimized(false);
  }, [settings.voiceMode]);

  useEffect(() => {
    if (!settings.voiceMode || typeof window === 'undefined' || !window.speechSynthesis) return;
    const id = window.setInterval(() => {
      setAvatarSpeaking(window.speechSynthesis.speaking);
    }, 90);
    return () => window.clearInterval(id);
  }, [settings.voiceMode]);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      const load = () => window.speechSynthesis.getVoices();
      load();
      window.speechSynthesis.onvoiceschanged = load;
    }
  }, []);

  useEffect(() => {
    if (!settingsOpen || settingsSubTab !== 'data') return;
    let cancelled = false;
    setButlorDataLoading(true);
    setButlorDataError(null);
    fetch('/api/butlor/data_summary')
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          root?: string;
          butlor_config_env?: string | null;
          locations?: ButlorLocationRow[];
        };
        const raw = d.error || '';
        const friendly =
          /<!doctype|<html[\s>]/i.test(raw) || raw.length > 800
            ? 'Could not reach the data summary endpoint. Restart ui-server / Butler and the Knowledge API, then open this tab again.'
            : raw;
        if (!r.ok) throw new Error(friendly || r.statusText || 'Failed to load');
        if (d.ok === false) throw new Error(friendly || 'Failed to load');
        return d;
      })
      .then((d) => {
        if (!cancelled) {
          setButlorDataSummary(d);
          setButlorDataLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setButlorDataError(String(e instanceof Error ? e.message : e));
          setButlorDataLoading(false);
          setButlorDataSummary(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, settingsSubTab]);

  const openButlorPath = useCallback(async (targetPath: string, action: 'open' | 'reveal' = 'open') => {
    try {
      const r = await fetch('/api/open_path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: targetPath, action }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || d.ok === false) {
        window.alert(
          d.error ||
            'Could not open that location. Restart the Butler app' +
              (isElectronButler() ? ' (desktop API on 4011)' : ' or ui-server (port 4001)') +
              ' and try again.',
        );
      }
    } catch (e) {
      window.alert(String(e));
    }
  }, []);

  const openGeneratedDiskFolder = useCallback(async () => {
    try {
      const r = await fetch('/api/butlor/data_summary');
      const d = (await r.json().catch(() => ({}))) as {
        locations?: { id?: string; path?: string }[];
      };
      const gen = d.locations?.find((l) => l && l.id === 'generated');
      const p = gen?.path && String(gen.path).trim();
      if (p) await openButlorPath(p, 'open');
      else
        window.alert(
          'Could not resolve the generated folder. Make sure the Butler host (' +
            (isElectronButler() ? 'port 4011' : 'port 4001') +
            ') is running and try again.',
        );
    } catch (e) {
      window.alert(String(e));
    }
  }, [openButlorPath]);

  useEffect(() => {
    const el = chatWindowRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeTab?.messages, activeTabId]);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) =>
        setSettings((prev) => {
          if (lastLocalOnlyToggleRef.current && Date.now() - lastLocalOnlyToggleRef.current < 3000) {
            return { ...d, localOnly: prev.localOnly };
          }
          return d;
        }),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    setDevGlobalRootDraft(settings.butlerGlobalProjectRoot || '');
    setDevTrustedRootsDraft(settings.butlerTrustedRootsText || '');
  }, [settingsOpen, settings.butlerGlobalProjectRoot, settings.butlerTrustedRootsText]);

  useEffect(() => {
    if (!settingsOpen && !profileOpen && !secretMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (secretMenuOpen) {
        setSecretMenuOpen(false);
        return;
      }
      if (profileOpen) setProfileOpen(false);
      else setSettingsOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [settingsOpen, profileOpen, secretMenuOpen]);

  useEffect(() => {
    return () => {
      if (belowStairsStatusClearTimerRef.current) {
        clearTimeout(belowStairsStatusClearTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen && !profileOpen && !secretMenuOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [settingsOpen, profileOpen, secretMenuOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const permApi = navigator.permissions;
    if (!permApi?.query) {
      setMicBrowserPermission(null);
      return;
    }
    let status: PermissionStatus | undefined;
    let cancelled = false;
    const sync = () => {
      if (status && !cancelled) {
        setMicBrowserPermission(status.state as 'granted' | 'denied' | 'prompt');
      }
    };
    permApi
      .query({ name: 'microphone' as PermissionName })
      .then((p) => {
        if (cancelled) return;
        status = p;
        sync();
        p.addEventListener('change', sync);
      })
      .catch(() => {
        if (!cancelled) setMicBrowserPermission(null);
      });
    return () => {
      cancelled = true;
      if (status) status.removeEventListener('change', sync);
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (isCodeHelperVariant) return;
    fetch('/api/jobs/profile')
      .then((r) => r.json())
      .then((p) => {
        setProfile(p || {});
        setSetupName(p?.name || '');
        setSetupEmail(p?.email || '');
        setSetupPhone(p?.phone || '');
        setSetupResumeHtml(
          p?.base_resume_html?.trim() ? p.base_resume_html : plainLinesToHtml(p?.base_resume || ''),
        );
        setSetupIndeedChromeProfile(!!p?.indeed_use_chrome_profile);
        setSetupChromeProfilePath(p?.chrome_profile_path || '');
        setSetupIndeedEmail(p?.indeed_email || '');
        setSetupIndeedPassword(p?.indeed_password || '');
        setSetupFacebookUseChrome(!!p?.facebook_use_chrome_profile);
        setSetupFacebookEmail(p?.facebook_email || '');
        setSetupFacebookPassword(p?.facebook_password || '');
        setSetupFacebookChromeDir(p?.facebook_chrome_profile_directory || '');
        const needs = !resumePlainFromProfile(p) || !p?.name || !p?.email;
        setProfileOpen(!!needs);
      })
      .catch(() => setProfile({}));
  }, [isCodeHelperVariant]);

  voiceModeRef.current = settings.voiceMode;

  useEffect(() => {
    voicePauseRef.current = !!avatarSpeaking || !!activeTab?.isSending || voiceMicMuted;
  }, [avatarSpeaking, activeTab?.isSending, voiceMicMuted]);

  useEffect(() => {
    const be = window.butlerElectron;
    if (!be?.onVoiceMicToggle) return;
    return be.onVoiceMicToggle(() => {
      setVoiceMicMuted((m) => !m);
    });
  }, []);

  useEffect(() => {
    if (!settings.voiceMode) {
      setAvatarSpeaking(false);
      setWebSpeechDegraded(false);
      setVoiceConversationError(null);
      setVoiceConvoUserSpeaking(false);
      setVoiceConvoHeardPreview(null);
      setVoiceMicMuted(false);
      if (voiceHeardClearTimerRef.current) {
        clearTimeout(voiceHeardClearTimerRef.current);
        voiceHeardClearTimerRef.current = null;
      }
      voiceRecoBackoffMsRef.current = 400;
      voiceNetworkErrorsRef.current = { count: 0, windowStart: 0 };
      if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
    }
  }, [settings.voiceMode]);

  useEffect(() => {
    if (avatarSpeaking || activeTab?.isSending) setVoiceConvoUserSpeaking(false);
  }, [avatarSpeaking, activeTab?.isSending]);

  // Voice mode: browser SpeechRecognition. Paused while TTS or chat is sending. Uses sendRef for latest send().
  useEffect(() => {
    if (!settings.voiceMode || !useWebSpeechContinuous) {
      const old = continuousRecognitionRef.current;
      if (old) {
        try {
          old.stop();
        } catch (_) {}
        continuousRecognitionRef.current = null;
      }
      return;
    }
    const SpeechRecognitionCtor =
      window.SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;
    const rec = new SpeechRecognitionCtor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = 'en-GB';
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      voiceRecoBackoffMsRef.current = 400;
      voiceNetworkErrorsRef.current = { count: 0, windowStart: 0 };
      voiceAudioCaptureErrorsRef.current = { count: 0, windowStart: 0 };
    };
    type RecExt = SpeechRecognition & {
      onspeechstart: ((this: SpeechRecognition, ev: Event) => void) | null;
      onspeechend: ((this: SpeechRecognition, ev: Event) => void) | null;
      onsoundstart: ((this: SpeechRecognition, ev: Event) => void) | null;
      onsoundend: ((this: SpeechRecognition, ev: Event) => void) | null;
    };
    const recExt = rec as RecExt;
    recExt.onspeechstart = () => {
      if (!voiceModeRef.current || voicePauseRef.current) return;
      setVoiceConvoUserSpeaking(true);
    };
    recExt.onspeechend = () => setVoiceConvoUserSpeaking(false);
    recExt.onsoundstart = () => {
      if (!voiceModeRef.current || voicePauseRef.current) return;
      setVoiceConvoUserSpeaking(true);
    };
    recExt.onsoundend = () => setVoiceConvoUserSpeaking(false);

    rec.onresult = (e: SpeechRecognitionEvent) => {
      if (voicePauseRef.current) return;
      const last = e.results.length - 1;
      const seg = e.results[last]?.[0];
      const transcript = (seg?.transcript || '').trim();
      if (!transcript) return;
      if (!e.results[last]?.isFinal) return;
      pulseVoiceHeard(transcript);
      void sendRef.current(transcript);
    };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setWebSpeechDegraded(true);
        setVoiceConversationError(
          'Browser speech recognition was blocked. Switched to server listening—allow the microphone if prompted.',
        );
        const now = Date.now();
        if (now - voiceMiscErrorLogAtRef.current > 15000) {
          voiceMiscErrorLogAtRef.current = now;
          console.warn('Voice recognition: microphone / speech permission denied');
        }
        return;
      }
      if (e.error === 'aborted') return;
      if (e.error === 'no-speech') return;
      if (e.error === 'network') {
        const now = Date.now();
        const w = voiceNetworkErrorsRef.current;
        if (now - w.windowStart > 20000) {
          w.windowStart = now;
          w.count = 0;
        }
        w.count += 1;
        voiceRecoBackoffMsRef.current = Math.min(
          10000,
          Math.max(1200, Math.round((voiceRecoBackoffMsRef.current || 400) * 1.55)),
        );
        const threshold = isElectronButler() ? 2 : 5;
        if (w.count >= threshold) {
          setWebSpeechDegraded(true);
          setVoiceConversationError(
            'Web Speech keeps failing (often offline or blocked). Using the local mic + server speech-to-text instead.',
          );
          voiceRecoBackoffMsRef.current = 400;
        }
        return;
      }
      if (e.error === 'audio-capture') {
        // Common when we `stop()` for TTS / send — not a real mic failure.
        if (voicePauseRef.current) return;
        const now = Date.now();
        const w = voiceAudioCaptureErrorsRef.current;
        if (now - w.windowStart > 25000) {
          w.windowStart = now;
          w.count = 0;
        }
        w.count += 1;
        voiceRecoBackoffMsRef.current = Math.min(6000, Math.max(800, (voiceRecoBackoffMsRef.current || 400) * 2));
        const threshold = isElectronButler() ? 3 : 5;
        if (w.count >= threshold) {
          setWebSpeechDegraded(true);
          setVoiceConversationError(
            'Browser speech could not read the microphone reliably. Switched to local mic + server speech-to-text.',
          );
          w.count = 0;
          voiceRecoBackoffMsRef.current = 400;
          return;
        }
        if (now - voiceMiscErrorLogAtRef.current > 25000) {
          voiceMiscErrorLogAtRef.current = now;
          console.warn(
            'Voice recognition: no microphone input (audio-capture). If this keeps happening, Butler will switch to server listening. Check mic permissions and exclusive mode in other apps.',
          );
        }
        return;
      }
      const now = Date.now();
      if (now - voiceMiscErrorLogAtRef.current > 12000) {
        voiceMiscErrorLogAtRef.current = now;
        console.warn('Voice recognition:', e.error);
      }
    };
    rec.onend = () => {
      if (continuousRecognitionRef.current !== rec || !voiceModeRef.current) return;
      const delay = voiceRecoBackoffMsRef.current;
      window.setTimeout(() => {
        if (continuousRecognitionRef.current !== rec || !voiceModeRef.current) return;
        if (voicePauseRef.current) return;
        try {
          rec.start();
        } catch (_) {}
      }, delay);
    };
    continuousRecognitionRef.current = rec;
    if (!voicePauseRef.current) {
      try {
        rec.start();
      } catch (err) {
        console.warn('Could not start continuous voice:', err);
        setWebSpeechDegraded(true);
        setVoiceConversationError(
          'Could not start browser listening. Using microphone + server speech-to-text instead (requires Python STT in the app).',
        );
      }
    }
    return () => {
      continuousRecognitionRef.current = null;
      recExt.onspeechstart = null;
      recExt.onspeechend = null;
      recExt.onsoundstart = null;
      recExt.onsoundend = null;
      setVoiceConvoUserSpeaking(false);
      try {
        rec.stop();
      } catch (_) {}
    };
  }, [settings.voiceMode, useWebSpeechContinuous, pulseVoiceHeard]);

  useEffect(() => {
    const rec = continuousRecognitionRef.current;
    if (!rec || !settings.voiceMode || !useWebSpeechContinuous) {
      prevVoicePausedRef.current = voicePauseRef.current;
      return;
    }
    const paused = voicePauseRef.current;
    const prev = prevVoicePausedRef.current;
    if (paused && !prev) {
      try {
        rec.stop();
      } catch (_) {}
    }
    if (!paused && prev) {
      window.setTimeout(() => {
        if (voicePauseRef.current || continuousRecognitionRef.current !== rec || !voiceModeRef.current) return;
        try {
          rec.start();
        } catch (_) {}
      }, 420);
    }
    prevVoicePausedRef.current = paused;
  }, [avatarSpeaking, activeTab?.isSending, voiceMicMuted, settings.voiceMode, useWebSpeechContinuous]);

  // Voice mode without Web Speech: continuous mic + server STT (hands-free).
  useEffect(() => {
    if (!settings.voiceMode || !speechSupported) return;
    if (useWebSpeechContinuous) return;
    const ac = new AbortController();
    const stopInner = startVoiceModePcmAutoListen({
      shouldPause: () => voicePauseRef.current,
      onTranscript: (text) => {
        pulseVoiceHeard(text);
        void sendRef.current(text);
      },
      signal: ac.signal,
      onMicAccessFailed: (msg) => setVoiceConversationError(msg),
      onSttFailed: (msg) =>
        setVoiceConversationError(
          `Speech-to-text: ${msg}. Packaged Butler needs Python embed + SpeechRecognition (run installer / prepare-installer).`,
        ),
      onUtteranceActive: (active) => setVoiceConvoUserSpeaking(active),
    });
    return () => {
      ac.abort();
      stopInner();
      setVoiceConvoUserSpeaking(false);
    };
  }, [settings.voiceMode, speechSupported, useWebSpeechContinuous, pulseVoiceHeard, voiceMicMuted]);

  const scanFacebookChromeProfile = async () => {
    setSetupFacebookDetectStatus('Scanning Chrome profiles…');
    try {
      const res = await fetch('/api/facebook/detect-chrome-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: setupFacebookEmail.trim() || undefined,
          chrome_profile_path: setupChromeProfilePath.trim() || undefined,
          save: true,
        }),
      });
      const d = await res.json();
      if (d?.ok && d.profile_directory) {
        setSetupFacebookChromeDir(d.profile_directory);
        if (d.chrome_profile_path) setSetupChromeProfilePath(d.chrome_profile_path);
        setSetupFacebookUseChrome(true);
        setSetupFacebookDetectStatus(
          `Found Chrome folder “${d.profile_directory}” (${d.matches?.length ?? 0} match(es)). Saved to profile.`,
        );
        void fetch('/api/jobs/profile')
          .then((r) => r.json())
          .then((p) => setProfile(p || {}))
          .catch(() => {});
      } else {
        setSetupFacebookDetectStatus(d?.message || 'No Chrome profile found for that email.');
      }
    } catch (e: unknown) {
      setSetupFacebookDetectStatus((e as Error)?.message || 'Scan failed.');
    }
  };

  const saveProfile = async () => {
    if (!setupName.trim() || !setupEmail.trim()) return;
    setSetupSaving(true);
    try {
      const res = await fetch('/api/jobs/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: setupName.trim(),
          email: setupEmail.trim(),
          phone: setupPhone.trim(),
          base_resume: stripHtmlToPlain(setupResumeHtml).trim(),
          base_resume_html: setupResumeHtml,
          indeed_use_chrome_profile: setupIndeedChromeProfile,
          chrome_profile_path: setupChromeProfilePath.trim() || undefined,
          indeed_email: setupIndeedEmail.trim() || undefined,
          indeed_password: setupIndeedPassword || undefined,
          facebook_use_chrome_profile: setupFacebookUseChrome,
          facebook_email: setupFacebookEmail.trim() || undefined,
          facebook_password: setupFacebookPassword || undefined,
          facebook_chrome_profile_directory: setupFacebookChromeDir.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data?.ok !== false) {
        setProfile({
          name: setupName,
          email: setupEmail,
          phone: setupPhone,
          base_resume: stripHtmlToPlain(setupResumeHtml),
          base_resume_html: setupResumeHtml,
          indeed_use_chrome_profile: setupIndeedChromeProfile,
          chrome_profile_path: setupChromeProfilePath.trim() || undefined,
          indeed_email: setupIndeedEmail.trim() || undefined,
          indeed_password: setupIndeedPassword || undefined,
          facebook_use_chrome_profile: setupFacebookUseChrome,
          facebook_email: setupFacebookEmail.trim() || undefined,
          facebook_password: setupFacebookPassword || undefined,
          facebook_chrome_profile_directory: setupFacebookChromeDir.trim() || undefined,
        });
        setProfileOpen(false);
      }
    } finally {
      setSetupSaving(false);
    }
  };

  const saveSettings = async (updates?: {
    openaiApiKey?: string;
    localOnly?: boolean;
    voiceMode?: boolean;
    butlerGlobalProjectRoot?: string;
    butlerTrustedRootsText?: string;
    butlerAllowAnyPath?: boolean;
  }) => {
    setSettingsSaving(true);
    try {
      const body: Record<string, unknown> = {};
      const savingDevPathsOnly =
        updates &&
        updates.openaiApiKey === undefined &&
        updates.localOnly === undefined &&
        updates.voiceMode === undefined &&
        updates.butlerAllowAnyPath === undefined &&
        (updates.butlerGlobalProjectRoot !== undefined || updates.butlerTrustedRootsText !== undefined);
      const savingAllowAnyOnly =
        updates &&
        updates.openaiApiKey === undefined &&
        updates.localOnly === undefined &&
        updates.voiceMode === undefined &&
        updates.butlerGlobalProjectRoot === undefined &&
        updates.butlerTrustedRootsText === undefined &&
        updates.butlerAllowAnyPath !== undefined;
      if (updates?.openaiApiKey !== undefined) body.openaiApiKey = updates.openaiApiKey;
      else if (!savingDevPathsOnly && !savingAllowAnyOnly && apiKeyInput) body.openaiApiKey = apiKeyInput;
      if (updates?.localOnly !== undefined) body.localOnly = updates.localOnly;
      else body.localOnly = settings.localOnly;
      if (updates?.voiceMode !== undefined) body.voiceMode = updates.voiceMode;
      else body.voiceMode = settings.voiceMode;
      if (updates?.butlerGlobalProjectRoot !== undefined) body.butlerGlobalProjectRoot = updates.butlerGlobalProjectRoot;
      if (updates?.butlerTrustedRootsText !== undefined) body.butlerTrustedRootsText = updates.butlerTrustedRootsText;
      if (updates?.butlerAllowAnyPath !== undefined) body.butlerAllowAnyPath = updates.butlerAllowAnyPath;
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        if (updates?.localOnly !== undefined) {
          setSettings((s) => ({ ...s, localOnly: updates!.localOnly }));
        } else if (updates?.voiceMode !== undefined) {
          setSettings((s) => ({ ...s, voiceMode: updates!.voiceMode }));
        } else if (
          updates?.butlerGlobalProjectRoot !== undefined ||
          updates?.butlerTrustedRootsText !== undefined ||
          updates?.butlerAllowAnyPath !== undefined
        ) {
          const updated = await fetch('/api/settings').then((r) => r.json());
          setSettings(updated);
        } else {
          const updated = await fetch('/api/settings').then((r) => r.json());
          setSettings(updated);
          if (updates?.openaiApiKey !== undefined) setApiKeyInput('');
        }
      } else if (updates?.localOnly !== undefined) {
        setSettings((s) => ({ ...s, localOnly: !updates!.localOnly }));
      } else if (updates?.voiceMode !== undefined) {
        setSettings((s) => ({ ...s, voiceMode: !updates!.voiceMode }));
      } else if (updates?.butlerAllowAnyPath !== undefined) {
        setSettings((s) => ({ ...s, butlerAllowAnyPath: !updates!.butlerAllowAnyPath }));
      }
    } finally {
      setSettingsSaving(false);
    }
  };

  const saveApiKey = () => saveSettings({ openaiApiKey: apiKeyInput });

  const activateVoiceFromHeader = useCallback(async () => {
    if (!settings.voiceMode) {
      setSettings((s) => ({ ...s, voiceMode: true }));
      await saveSettings({ voiceMode: true });
    }
    setVoiceFaceMinimized(false);
    const be = (window as unknown as { butlerElectron?: { beginButlerDockFlyFromFloat?: () => void } }).butlerElectron;
    if (be?.beginButlerDockFlyFromFloat) {
      void Promise.resolve(be.beginButlerDockFlyFromFloat()).catch(() => {});
      return;
    }
    if (!isElectronButler()) {
      const fly = webButlerFloatRef.current?.getDockFlyMetrics?.();
      if (fly) {
        setDockFlySession(fly);
        return;
      }
    }
  }, [settings.voiceMode, saveSettings]);

  const requestMicrophoneAccess = useCallback(async () => {
    setMicTestBusy(true);
    setMicTestOutcome('idle');
    setMicTestMessage('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicTestOutcome('error');
      setMicTestMessage(
        'No microphone API in this context. Use the Butler desktop app or a secure (HTTPS) page, and ensure a mic is connected.',
      );
      setMicTestBusy(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicTestOutcome('ok');
      setMicTestMessage(
        'Microphone access works. Turn on “Voice conversation” above and speak; if Windows blocked Butler earlier, allow it in Privacy settings (see below).',
      );
      setVoiceConversationError(null);
      try {
        const p = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
        if (p) setMicBrowserPermission(p.state as 'granted' | 'denied' | 'prompt');
      } catch {
        /* ignore */
      }
    } catch (err) {
      setMicTestOutcome('error');
      const name = err && typeof err === 'object' && 'name' in err ? String((err as DOMException).name) : '';
      const msg = err instanceof Error ? err.message : String(err);
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setMicTestMessage(
          'Permission denied. On Windows: Settings → Privacy & security → Microphone → enable access and allow desktop apps. Then try again.',
        );
      } else if (name === 'NotFoundError') {
        setMicTestMessage('No microphone was found. Plug in a mic or headset and try again.');
      } else {
        setMicTestMessage(msg || 'Could not open the microphone.');
      }
    } finally {
      setMicTestBusy(false);
    }
  }, []);

  const toggleLocalOnly = () => {
    const next = !settings.localOnly;
    lastLocalOnlyToggleRef.current = Date.now();
    setSettings((s) => ({ ...s, localOnly: next }));
    saveSettings({ localOnly: next });
  };

  const fetchGoLearnStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/learn/go_status');
      const j = (await r.json()) as GoLearnStatus;
      setGoLearnStatus(j);
    } catch {
      setGoLearnStatus({
        error: isElectronButler()
          ? 'Could not reach Knowledge API (desktop expects port 8775)'
          : 'Could not reach Knowledge API (is it running on port 8765?)',
      });
    }
  }, []);

  const startGoLearn = useCallback(async () => {
    setGoLearnBusy(true);
    try {
      const r = await fetch('/api/learn/go', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = (await r.json()) as { ok?: boolean; message?: string };
      window.alert(j.message || (j.ok ? 'Started.' : 'Request failed.'));
      await fetchGoLearnStatus();
    } catch (e) {
      window.alert(String((e as Error).message));
    } finally {
      setGoLearnBusy(false);
    }
  }, [fetchGoLearnStatus]);

  useEffect(() => {
    if (!settingsOpen) {
      if (goLearnPollRef.current) {
        clearInterval(goLearnPollRef.current);
        goLearnPollRef.current = null;
      }
      return;
    }
    void fetchGoLearnStatus();
    goLearnPollRef.current = setInterval(() => void fetchGoLearnStatus(), 4000);
    return () => {
      if (goLearnPollRef.current) {
        clearInterval(goLearnPollRef.current);
        goLearnPollRef.current = null;
      }
    };
  }, [settingsOpen, fetchGoLearnStatus]);

  const send = async (
    messageOverride?: string,
    opts?: {
      omitMainChatAttachment?: boolean;
      belowStairsAttachment?: { dataUrl: string; name: string; mime: string } | null;
      /** When true, never read the main composer — avoids leaking main input into below-stairs sends (and vice versa). */
      fromBelowStairs?: boolean;
    },
  ) => {
    /** Side-composer sends must never read or leave text in the main textarea (same flag pair as handleSecretMenuSend). */
    const sideComposerSend =
      opts?.fromBelowStairs === true || opts?.omitMainChatAttachment === true;
    const promptSource = sideComposerSend
      ? String(messageOverride ?? '')
      : (messageOverride ?? input);
    const { rawTrimmed, messageForApi: trimmed, showReplyImagesInChat } =
      parsePromptWithOptionalInlineImageSuffix(promptSource);
    if (!trimmed || !activeTab || activeTab.isSending) return;
    if (!sideComposerSend) {
      const line = rawTrimmed.trim();
      if (line) {
        const arr = chatPromptHistoryRef.current;
        if (!arr.length || arr[arr.length - 1] !== line) {
          arr.push(line);
          if (arr.length > CHAT_PROMPT_HISTORY_MAX) arr.shift();
          persistChatPromptHistory(arr);
        }
      }
      chatHistoryDepthRef.current = null;
      chatHistoryDraftRef.current = '';
    }
    const usedBelowStairs = !!opts?.omitMainChatAttachment;
    const attachPayload = usedBelowStairs ? (opts?.belowStairsAttachment ?? null) : chatAttachment;
    const tabId = activeTab.id;
    const stamp = () =>
      new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const logLine = (line: string) => {
      updateTab(tabId, (t) => ({
        sendLog: [...(t.sendLog ?? []).slice(-28), `${stamp()}  ${line}`],
      }));
    };
    const fromSideComposer = !!opts?.fromBelowStairs;
    const userMessage: Message | null = fromSideComposer
      ? null
      : {
          id: String(Date.now()),
          role: 'user',
          content: rawTrimmed,
        };
    const isFirstUserMsg = activeTab.messages.every((m) => m.role !== 'user');
    const newLabel = isFirstUserMsg ? (trimmed.slice(0, 20) + (trimmed.length > 20 ? '…' : '')) : activeTab.label;
    updateTab(tabId, {
      messages: userMessage ? [...activeTab.messages, userMessage] : activeTab.messages,
      isSending: true,
      sendLog: [
        fromSideComposer
          ? `${stamp()}  Side composer: queued (prompt not shown in chat)`
          : `${stamp()}  Queued your message`,
      ],
      ...(isFirstUserMsg && newLabel && !fromSideComposer ? { label: newLabel } : {}),
    });
    if (sideComposerSend) setInput('');
    else if (!messageOverride) setInput('');
    if (opts?.fromBelowStairs) {
      if (belowStairsStatusClearTimerRef.current) {
        clearTimeout(belowStairsStatusClearTimerRef.current);
        belowStairsStatusClearTimerRef.current = null;
      }
      setBelowStairsStatus('pending');
      setBelowStairsStatusDetail(null);
    }
    logLine(`Butler${settings.localOnly ? ' · local-only model' : ''}`);
    if (codeWorkspaceContext.trim()) {
      logLine(`Background context attached (${codeWorkspaceContext.trim().length} chars)`);
    }
    if (codeCursorCliEnabled) {
      logLine(`Cursor Agent CLI hint on (command: ${(codeCursorCliCommand || 'agent').trim().slice(0, 60) || 'agent'})`);
    }
    if (usedBelowStairs) {
      if (attachPayload) {
        const img = attachPayload.mime.startsWith('image/');
        logLine(
          img
            ? 'Side composer: attached image (img→img / img→video when applicable)'
            : `Side composer: attached file ${attachPayload.name} (${attachPayload.mime})`,
        );
      } else {
        logLine('Side composer send — no attachment');
      }
    } else if (chatAttachment) {
      const img = chatAttachment.mime.startsWith('image/');
      logLine(
        img
          ? 'Attached image (img→img / img→video when applicable)'
          : `Attached file: ${chatAttachment.name} (${chatAttachment.mime})`,
      );
    }
    logLine('POST /api/chat → Butler host (may call Knowledge API / local model)…');
    if (showReplyImagesInChat) logLine('--r suffix: reply images will show in chat when returned');

    const t0 = performance.now();
    try {
      const parsedAtt = attachPayload ? parseDataUrl(attachPayload.dataUrl) : null;
      const initImageB64 =
        parsedAtt && parsedAtt.mime.split(';')[0].trim().toLowerCase().startsWith('image/')
          ? parsedAtt.base64
          : undefined;
      const fileAttachment =
        parsedAtt &&
        attachPayload &&
        !parsedAtt.mime.split(';')[0].trim().toLowerCase().startsWith('image/')
          ? {
              filename: attachPayload.name,
              mime_type: attachPayload.mime || 'application/octet-stream',
              data_base64: parsedAtt.base64,
            }
          : undefined;
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeTab.sessionId,
          message: trimmed,
          // Recent thread only (skip welcome); host maps this to Knowledge prior_messages.
          history: activeTab.messages
            .filter((m) => m.id !== 'welcome' && (m.role === 'user' || m.role === 'assistant'))
            .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
            .slice(-24)
            .map((m) => ({ role: m.role, content: m.content })),
          localOnly: settings.localOnly,
          ...(initImageB64 ? { init_image: initImageB64 } : {}),
          ...(fileAttachment ? { attachment: fileAttachment } : {}),
          ...(codeWorkspaceContext.trim()
            ? { codeContext: codeWorkspaceContext.trim().slice(0, 12000) }
            : {}),
          ...(codeCursorCliEnabled
            ? {
                cursorCli: {
                  enabled: true,
                  command: (codeCursorCliCommand || 'agent').trim().slice(0, 200) || 'agent',
                },
              }
            : {}),
        }),
      });
      logLine(`HTTP ${res.status} · ${Math.round(performance.now() - t0)} ms to first byte`);
      logLine('Reading response body…');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.message || data?.error || `Request failed (${res.status})`;
        logLine(`Error from host: ${String(msg).slice(0, 200)}`);
        throw new Error(msg);
      }
      const autonomyLogLines = Array.isArray(data?.autonomy_log)
        ? (data.autonomy_log as string[]).filter((s) => typeof s === 'string' && s.trim().length > 0)
        : [];
      if (autonomyLogLines.length > 0) {
        logLine('Autonomy trace (continuing after failures until success or limits):');
        for (const line of autonomyLogLines) {
          logLine(line);
        }
      }
      logLine(data?.source ? `Source: ${data.source}` : 'Reply payload received');
      if (data?.applySummary) {
        const a = data.applySummary;
        const bits = [
          a.files?.length ? `${a.files.length} file(s)` : '',
          a.commands?.length ? `${a.commands.length} command(s)` : '',
          a.downloads?.length ? `${a.downloads.length} download(s)` : '',
        ].filter(Boolean);
        if (bits.length) logLine(`Actions: ${bits.join(', ')}`);
      }
      const ar = data?.autonomy_rounds as Array<{ ok?: boolean; attempt?: number }> | undefined;
      if (Array.isArray(ar) && ar.length > 1) {
        logLine(
          `Action autonomy: ${ar.length} round(s) (${ar.filter((x) => x.ok === false).length} failed before success or stop)`,
        );
      }
      const assistantContent =
        data?.reply ||
        (data?.summary
          ? `${data.summary}${data.nextSteps?.length ? `\n\nNext:\n- ${data.nextSteps.join('\n- ')}` : ''}`
          : '') ||
        'I made some changes – please check your project files.';
      const progressMsgs = Array.isArray(data?.progress_messages)
        ? (data.progress_messages as string[]).filter((s) => typeof s === 'string' && s.trim().length > 0)
        : [];
      const vl = data?.variant_labels;
      const p3 = data?.print3d as { openscad_render_ok?: boolean; stl_path?: string } | undefined;
      const stlName =
        p3?.openscad_render_ok && typeof p3.stl_path === 'string' ? print3dStlBasename(p3.stl_path) : null;
      const stlPreview =
        stlName != null
          ? { url: `/api/print3d/stl?f=${encodeURIComponent(stlName)}`, filename: stlName }
          : undefined;
      const hasReplyImages = Array.isArray(data?.images) && data.images.length > 0;
      /** Side composer: append Butler's reply (and images) so the thread + session gallery update; only the user prompt is omitted. Inline images without requiring --r. */
      const assistantMessage: Message = {
        id: `${Date.now()}-assistant`,
        role: 'assistant',
        content: String(assistantContent),
        source: data?.source || 'OpenAI',
        images: data?.images,
        inlineImages: !!(hasReplyImages && (showReplyImagesInChat || usedBelowStairs)),
        variantLabels: Array.isArray(vl) ? vl.map((x: unknown) => String(x)) : undefined,
        video: (() => {
          const v = typeof data?.video === 'string' ? data.video.trim() : '';
          if (v) return v;
          const p = typeof data?.path === 'string' ? data.path.trim() : '';
          if (p && /\.(mp4|webm|mov|mkv|m4v)$/i.test(p)) {
            return `/api/media/video?path=${encodeURIComponent(p)}`;
          }
          return undefined;
        })(),
        audio: typeof data?.audio === 'string' ? data.audio : undefined,
        stlPreview,
      };
      logLine(
        `Done in ${(performance.now() - t0) / 1000}s — ${
          sideComposerSend
            ? 'side composer: Butler reply added to this tab (your prompt stays out of the thread)'
            : 'showing reply'
        }`,
      );
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem('BUTLER_VERBOSE_MEDIA_EMBEDS') === '1') {
          const u = extractUrls(String(assistantContent));
          logLine(`Media embed debug: ${u.length} http(s) URL(s) detected in reply`);
          for (const x of u.slice(0, 5)) logLine(`  → ${x.length > 160 ? `${x.slice(0, 160)}…` : x}`);
        }
      } catch {
        /* ignore */
      }
      const progressMessagesAsAssistant: Message[] =
        progressMsgs.length > 0 && !hasReplyImages
          ? progressMsgs.map((text, i) => ({
              id: `${Date.now()}-progress-${i}`,
              role: 'assistant' as const,
              content: text,
              source: 'Butler',
            }))
          : [];
      updateTab(tabId, (t) => ({
        messages: [...t.messages, ...progressMessagesAsAssistant, assistantMessage],
        isSending: false,
      }));
      if (opts?.fromBelowStairs) {
        setBelowStairsStatus('done');
        setBelowStairsStatusDetail(null);
        belowStairsStatusClearTimerRef.current = setTimeout(() => {
          setBelowStairsStatus('idle');
          setBelowStairsStatusDetail(null);
          belowStairsStatusClearTimerRef.current = null;
        }, 12000);
      }
      if (!sideComposerSend && settings.voiceMode) speakReply(String(assistantContent));
      if (usedBelowStairs && attachPayload?.mime.startsWith('image/')) setSecretMenuAttachment(null);
      else if (!usedBelowStairs && chatAttachment?.mime.startsWith('image/')) setChatAttachment(null);
    } catch (e: any) {
      const errMsg =
        e?.message ||
        (isElectronButler()
          ? 'Something went wrong. Make sure Butler.exe is running (desktop API on http://localhost:4011).'
          : 'Something went wrong. Make sure the API server is running on http://localhost:4001.');
      logLine(`Failed after ${(performance.now() - t0) / 1000}s`);
      updateTab(tabId, (t) => ({
        messages: [...t.messages, { id: `${Date.now()}-error`, role: 'assistant' as const, content: errMsg }],
        isSending: false,
      }));
      if (opts?.fromBelowStairs) {
        setBelowStairsStatus('error');
        setBelowStairsStatusDetail(errMsg.slice(0, 200));
        belowStairsStatusClearTimerRef.current = setTimeout(() => {
          setBelowStairsStatus('idle');
          setBelowStairsStatusDetail(null);
          belowStairsStatusClearTimerRef.current = null;
        }, 16000);
      }
      if (!sideComposerSend && settings.voiceMode) speakReply(errMsg);
      // eslint-disable-next-line no-console
      console.error(e);
    }
  };

  sendRef.current = send;

  const handleSecretMenuSend = useCallback(async () => {
    const raw = secretMenuChatInput;
    const { messageForApi } = parsePromptWithOptionalInlineImageSuffix(raw);
    if (!messageForApi.trim()) return;
    if (!activeTab || activeTab.isSending) return;
    const att = secretMenuAttachment;
    setSecretMenuChatInput('');
    setInput('');
    const opts = {
      omitMainChatAttachment: true as const,
      belowStairsAttachment: att,
      fromBelowStairs: true as const,
    };
    const p = sendRef.current(raw, opts);
    requestAnimationFrame(() => setSecretMenuOpen(false));
    await p;
  }, [secretMenuChatInput, secretMenuAttachment, activeTab]);

  const voiceConvoPausedUi =
    !!settings.voiceMode && (!!avatarSpeaking || !!activeTab?.isSending || voiceMicMuted);

  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    const el = e.currentTarget;
    const hist = chatPromptHistoryRef.current;

    if (e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const atDocStart = el.selectionStart === 0 && el.selectionEnd === 0;
      if (atDocStart && hist.length > 0) {
        e.preventDefault();
        let depth = chatHistoryDepthRef.current;
        if (depth === null) {
          chatHistoryDraftRef.current = el.value;
          depth = 0;
        } else if (depth < hist.length - 1) {
          depth += 1;
        } else {
          return;
        }
        chatHistoryDepthRef.current = depth;
        const idx = hist.length - 1 - depth;
        setInput(hist[idx] ?? '');
        requestAnimationFrame(() => {
          resizeChatInput();
          const ta = chatInputRef.current;
          if (ta) {
            ta.selectionStart = 0;
            ta.selectionEnd = 0;
          }
        });
        return;
      }
    }

    if (e.key === 'ArrowDown' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const atDocEnd =
        el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
      if (atDocEnd && hist.length > 0 && chatHistoryDepthRef.current !== null) {
        e.preventDefault();
        const depth = chatHistoryDepthRef.current!;
        if (depth > 0) {
          chatHistoryDepthRef.current = depth - 1;
          const d = chatHistoryDepthRef.current!;
          const idx = hist.length - 1 - d;
          setInput(hist[idx] ?? '');
        } else {
          chatHistoryDepthRef.current = null;
          setInput(chatHistoryDraftRef.current);
        }
        requestAnimationFrame(() => {
          resizeChatInput();
          const ta = chatInputRef.current;
          if (ta) {
            const len = ta.value.length;
            ta.selectionStart = len;
            ta.selectionEnd = len;
          }
        });
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const copyMessageToClipboard = async (m: Message) => {
    let text = m.content;
    if (m.images?.length) {
      text += m.inlineImages
        ? `\n\n[This reply includes ${m.images.length} image(s) shown in the chat above.]`
        : '\n\n[This reply includes ' +
          m.images.length +
          ' image(s) — open the utility panel from the header → Image library to view, or save from the viewer.]';
    }
    if (m.audio) {
      text += '\n\n[This message includes audio — use the player in the chat bubble.]';
    }
    if (m.video) {
      text += '\n\n[This message includes a video in the chat bubble — use the player controls to open or save if your browser allows.]';
    }
    if (m.stlPreview) {
      text += '\n\n[This message includes a 3D STL preview in the chat — drag to rotate.]';
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(m.id);
      window.setTimeout(() => {
        setCopiedMessageId((cur) => (cur === m.id ? null : cur));
      }, 2000);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopiedMessageId(m.id);
        window.setTimeout(() => {
          setCopiedMessageId((cur) => (cur === m.id ? null : cur));
        }, 2000);
      } catch {
        /* ignore */
      }
    }
  };

  const toggleSpeech = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('Microphone access is not supported.');
      return;
    }

    if (isListening) {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      setIsListening(false);
      if (typeof rec?.stop === 'function') {
        try {
          const { pcm, sampleRate } = await rec.stop();
          rec.stream?.getTracks().forEach((t) => t.stop());
          const pcmU8 = new Uint8Array(pcm);
          if (pcmU8.length < 500) {
            alert('Recording too short. Speak for at least a second.');
            return;
          }
          const pcmB64 = uint8ToBase64(pcmU8);
          const res = await fetch('/api/speech-to-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pcm: pcmB64, sampleRate: Math.round(sampleRate) }),
          });
          const data = await res.json().catch(() => ({}));
          const text = data?.text?.trim();
          if (text) {
            setInput((prev) => (prev ? `${prev} ${text}` : text).trim());
          } else {
            const errMsg = data?.error || (res.ok ? 'Could not understand audio. Speak clearly and try again. (Speech-to-text needs internet.)' : 'Speech recognition failed.');
            alert(errMsg);
          }
        } catch (e) {
          alert('Speech recognition failed: ' + (e instanceof Error ? e.message : String(e)));
        }
      }
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const { stop } = await startPcmRecording(stream);
      recognitionRef.current = { stop, stream };
      setIsListening(true);
    } catch (err) {
      alert('Could not access microphone: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const onChatSectionResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const panelEl = chatPanelRef.current;
      const startY = e.clientY;
      const startH: number =
        chatSectionHeightPx != null
          ? chatSectionHeightPx
          : panelEl
            ? Math.round(panelEl.getBoundingClientRect().height)
            : 520;
      const onMove = (ev: MouseEvent) => {
        const panel = chatPanelRef.current;
        if (!panel) return;
        // Use viewport space below the chat panel — not app-main height (that shrinks with the panel and traps you at min).
        const panelTop = panel.getBoundingClientRect().top;
        const bottomMargin = 32;
        const byVisible = Math.round(window.innerHeight - panelTop - bottomMargin);
        const maxH = Math.max(
          MIN_CHAT_SECTION_PX,
          Math.min(getChatSectionMaxPx(), byVisible),
        );
        const dy = ev.clientY - startY;
        setChatSectionHeightPx(clampLayout(startH + dy, MIN_CHAT_SECTION_PX, maxH));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [chatSectionHeightPx],
  );

  const onHeaderResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH =
        appHeaderHeightPx ??
        Math.round(headerRef.current?.getBoundingClientRect().height ?? APP_HEADER_MIN_PX);
      const onMove = (ev: MouseEvent) => {
        const dy = ev.clientY - startY;
        setAppHeaderHeightPx(clampLayout(startH + dy, APP_HEADER_MIN_PX, APP_HEADER_MAX_PX));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [appHeaderHeightPx],
  );

  const onSplitPaneResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const mainRect = appMainRef.current?.getBoundingClientRect();
      if (!mainRect) return;
      const startX = e.clientX;
      const startW =
        splitChatWidthPx ??
        Math.round(chatPanelRef.current?.getBoundingClientRect().width ?? Math.max(SPLIT_PANE_MIN_PX, mainRect.width / 2));
      const maxW = getSplitChatMaxPx(mainRect.width);
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        setSplitChatWidthPx(clampLayout(startW + dx, SPLIT_PANE_MIN_PX, maxW));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [splitChatWidthPx],
  );

  return (
    <>
      {showStartupSplash ? <StartupSplash onComplete={dismissStartupSplash} /> : null}
      <div className="app-root">
      <div className="app-shell">
        <header
          ref={headerRef}
          className="app-header"
          style={appHeaderHeightPx != null ? { height: appHeaderHeightPx } : undefined}
        >
          <div className="app-header-top">
            <div className="app-title">
              {settings.voiceMode ? (
                <>
                  <div ref={voiceHeaderDockTargetRef} className="app-header-butler-slot" aria-hidden>
                    {voiceFaceMinimized ? (
                      <div
                        className="app-logo-3d app-logo-3d--clickable"
                        title="Voice mode — click to expand Butler"
                        onClick={() => void activateVoiceFromHeader()}
                        onDoubleClick={onSecretHeaderDoubleClick}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            void activateVoiceFromHeader();
                          }
                        }}
                      >
                        <ButlerAvatar3D speaking={avatarSpeaking} voiceActive layout="header" />
                      </div>
                    ) : (
                      <div
                        className="app-logo-voice-placeholder"
                        onDoubleClick={onSecretHeaderDoubleClick}
                        role="presentation"
                      />
                    )}
                  </div>
                  <button
                    type="button"
                    className="voice-expand-face-btn"
                    onClick={() => {
                      if (voiceFaceMinimized) {
                        setVoiceFaceMinimized(false);
                        return;
                      }
                      const be = window.butlerElectron;
                      if (be?.beginButlerDockFlyFromFloat) {
                        void be.beginButlerDockFlyFromFloat();
                        return;
                      }
                      if (!isElectronButler()) {
                        const fly = webButlerFloatRef.current?.getDockFlyMetrics();
                        if (fly) {
                          setDockFlySession(fly);
                          return;
                        }
                      }
                      setVoiceFaceMinimized(true);
                    }}
                    title={voiceFaceMinimized ? 'Show floating Butler' : 'Dock Butler to header'}
                  >
                    {voiceFaceMinimized ? 'Show Butler' : 'Dock Butler'}
                  </button>
                </>
              ) : (
                <img
                  src="./icon.png"
                  alt=""
                  className="app-logo app-logo-interactive"
                  width={40}
                  height={40}
                  title="Start talking mode"
                  role="button"
                  tabIndex={0}
                  onClick={() => void activateVoiceFromHeader()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void activateVoiceFromHeader();
                    }
                  }}
                  onDoubleClick={onSecretHeaderDoubleClick}
                />
              )}
              <h1 className="app-title-heading" onDoubleClick={onSecretHeaderDoubleClick}>
                {isCodeHelperVariant ? 'Code Helper' : agentOnlyShell ? 'Butler Agent' : 'Butler'}
              </h1>
            </div>
            <div className="app-header-actions">
              {agentOnlyShell && !isCodeHelperVariant ? (
                <>
                  <button
                    type="button"
                    className={`header-settings-btn header-agent-btn${agentView === 'chat' ? ' active' : ''}`}
                    onClick={showChatOnlyView}
                    title="Conversational Butler (same chat brain as before)"
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    className={`header-settings-btn header-agent-btn${agentView !== 'chat' ? ' active' : ''}`}
                    onClick={() => showAgentView('agent')}
                    title="Coding agent with tools"
                  >
                    Code
                  </button>
                </>
              ) : null}
              {!isCodeHelperVariant && !agentOnlyShell ? (
                <button
                  type="button"
                  className={`header-settings-btn header-agent-btn${agentView !== 'chat' ? ' active' : ''}`}
                  onClick={() => showAgentView('agent')}
                  title="Open Butler Agent inside Butler"
                >
                  Agent
                </button>
              ) : null}
              {!isCodeHelperVariant && !agentOnlyShell && agentView !== 'chat' ? (
                <button
                  type="button"
                  className={`header-settings-btn${agentView === 'split' ? ' active' : ''}`}
                  onClick={() => (agentView === 'split' ? showAgentView('agent') : showAgentView('split'))}
                  title={agentView === 'split' ? 'Return to Agent-only view' : 'Open chat and Agent side-by-side'}
                >
                  {agentView === 'split' ? 'Single view' : 'Split view'}
                </button>
              ) : null}
              {!isCodeHelperVariant ? (
                <button
                  type="button"
                  className={`header-settings-btn ${profileOpen ? 'active' : ''}`}
                  onClick={() => {
                    setProfileOpen((o) => {
                      const next = !o;
                      if (next) setSettingsOpen(false);
                      return next;
                    });
                  }}
                  aria-expanded={profileOpen}
                  aria-haspopup="dialog"
                  aria-controls="butler-profile-modal"
                >
                  {profileOpen ? 'Close profile' : 'Profile'}
                </button>
              ) : null}
              {!isCodeHelperVariant ? (
                <button
                  type="button"
                  className={`header-settings-btn ${activityLogModalOpen ? 'active' : ''}`}
                  onClick={() => {
                    setActivityLogModalOpen((o) => {
                      const next = !o;
                      if (next) {
                        setSettingsOpen(false);
                        setProfileOpen(false);
                      }
                      return next;
                    });
                  }}
                  aria-expanded={activityLogModalOpen}
                  aria-haspopup="dialog"
                  aria-controls="butler-activity-log-modal"
                  title="Draggable window — drag the title bar to move"
                >
                  Activity log
                  {(activeTab?.sendLog?.length ?? 0) > 0 ? ` (${activeTab?.sendLog?.length})` : ''}
                </button>
              ) : null}
              {!isCodeHelperVariant ? (
                <button
                  type="button"
                  className={`header-settings-btn ${settingsOpen ? 'active' : ''}`}
                  onClick={() => {
                    setSettingsOpen((o) => {
                      const next = !o;
                      if (next) setProfileOpen(false);
                      return next;
                    });
                  }}
                  aria-expanded={settingsOpen}
                  aria-haspopup="dialog"
                  aria-controls="butler-settings-modal"
                >
                  {settingsOpen ? 'Close settings' : 'Settings'}
                </button>
              ) : null}
            </div>
          </div>
        </header>
        <div
          className="layout-resize-handle layout-resize-handle--horizontal"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize Butler header"
          title="Drag to resize the Butler header area. Double-click to reset."
          onMouseDown={onHeaderResizeStart}
          onDoubleClick={(e) => {
            e.preventDefault();
            setAppHeaderHeightPx(null);
          }}
        />

        {!isCodeHelperVariant ? <ButlerMiniStatusStrip /> : null}

        {belowStairsStatus !== 'idle' ? (
          <div
            className={`below-stairs-status-strip below-stairs-status-strip--${belowStairsStatus}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {belowStairsStatus === 'pending' ? (
              <span>Side request: working… (You can close the panel; this tab still owns the request.)</span>
            ) : null}
            {belowStairsStatus === 'done' ? (
              <span>
                Side request: finished — Butler&apos;s reply was added to this tab (your side prompt is not shown as a user
                bubble). Open the utility panel → Session image &amp; video gallery for thumbnails of stills and short videos.
              </span>
            ) : null}
            {belowStairsStatus === 'error' ? (
              <span>
                Side request: something went wrong
                {belowStairsStatusDetail ? ` — ${belowStairsStatusDetail}` : ''}.
              </span>
            ) : null}
            <button
              type="button"
              className="below-stairs-status-dismiss"
              onClick={() => {
                if (belowStairsStatusClearTimerRef.current) {
                  clearTimeout(belowStairsStatusClearTimerRef.current);
                  belowStairsStatusClearTimerRef.current = null;
                }
                setBelowStairsStatus('idle');
                setBelowStairsStatusDetail(null);
              }}
              aria-label="Dismiss status message"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        <main
          ref={appMainRef}
          className={`app-main${agentView === 'split' ? ' app-main--split' : ''}${agentView === 'agent' ? ' app-main--agent-only' : ''}`}
        >
          <section
            ref={chatPanelRef}
            className={`chat-panel${agentView === 'agent' ? ' chat-panel--hidden' : ''}${agentView === 'split' ? ' chat-panel--split' : ''}`}
            style={
              (() => {
                const style: React.CSSProperties = {};
                if (chatSectionHeightPx != null) {
                  style.flex = '0 0 auto';
                  style.height = chatSectionHeightPx;
                  style.minHeight = MIN_CHAT_SECTION_PX;
                  style.maxHeight = `min(${CHAT_SECTION_MAX_CAP_PX}px, calc(100dvh - 7.5rem))`;
                }
                if (agentView === 'split' && splitChatWidthPx != null) {
                  style.width = splitChatWidthPx;
                  style.flexBasis = splitChatWidthPx;
                }
                return Object.keys(style).length ? style : undefined;
              })()
            }
          >
            <div className="chat-panel-conversation">
                <div className="chat-tabs-bar">
                  {tabs.map((t) => (
                    <div
                      key={t.id}
                      className={`chat-tab ${t.id === activeTabId ? 'active' : ''}`}
                      onClick={() => setActiveTabId(t.id)}
                    >
                      <span className="chat-tab-label">{t.label}</span>
                      {tabs.length > 1 && (
                        <button
                          type="button"
                          className="chat-tab-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeChatTab(t.id);
                          }}
                          title="Close tab"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  <button type="button" className="chat-tab-add" onClick={addChatTab} title="New tab (run commands in parallel)">
                    +
                  </button>
                </div>
                <div className="chat-window" ref={chatWindowRef}>
                  {(activeTab?.messages ?? []).map((m) => (
                    <div key={m.id} className={`chat-row chat-row-${m.role}`}>
                      <div className="avatar">
                        {m.role === 'user' ? (
                          m.belowStairs ? (
                            <span className="avatar-user-wrap" title="Sent from the side composer">
                              You
                              <span className="avatar-below-stairs-tag">side</span>
                            </span>
                          ) : (
                            'You'
                          )
                        ) : (
                          <img src="./icon.png" alt="Butler" className="avatar-butler-icon" width={32} height={32} />
                        )}
                      </div>
                      <div className="bubble">
                        <button
                          type="button"
                          className="bubble-copy"
                          title={copiedMessageId === m.id ? 'Copied!' : 'Copy to clipboard'}
                          aria-label={copiedMessageId === m.id ? 'Copied' : 'Copy message to clipboard'}
                          onClick={() => void copyMessageToClipboard(m)}
                        >
                          {copiedMessageId === m.id ? (
                            <span className="bubble-copy-label">Copied</span>
                          ) : (
                            <svg
                              className="bubble-copy-icon"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden
                            >
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                        <ChatBubbleRichText text={m.content} />
                        <ChatMediaEmbeds text={m.content} />
                        {m.images?.length && m.inlineImages ? (
                          <div className="chat-images">
                            {m.images.map((img, i) => (
                              <figure key={`${m.id}-img-${i}`} className="chat-image-figure">
                                <img
                                  src={chatInlineImageSrc(img)}
                                  alt={m.variantLabels?.[i] || `Generated image ${i + 1}`}
                                  className="chat-generated-image"
                                />
                                {m.variantLabels?.[i] ? (
                                  <figcaption className="chat-image-caption">{m.variantLabels[i]}</figcaption>
                                ) : null}
                              </figure>
                            ))}
                          </div>
                        ) : null}
                        {m.audio ? (
                          <audio
                            className="chat-generated-video"
                            controls
                            preload="metadata"
                            src={mediaAudioSrc(m.audio)}
                          >
                            Audio attachment
                          </audio>
                        ) : null}
                        {m.video ? (
                          (() => {
                            const vsrc = mediaVideoSrc(m.video!);
                            const isGif = vsrc.startsWith('data:image/gif');
                            return isGif ? (
                              <img src={vsrc} className="chat-generated-video" alt="Generated animation" />
                            ) : (
                              <video
                                className="chat-generated-video"
                                controls
                                playsInline
                                preload="metadata"
                                src={vsrc}
                              >
                                Video attachment
                              </video>
                            );
                          })()
                        ) : null}
                        {m.stlPreview ? (
                          <StlPreview url={m.stlPreview.url} filename={m.stlPreview.filename} />
                        ) : null}
                        {m.role === 'assistant' && m.source ? (
                          <div className="chat-message-source">{m.source}</div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="input-bar">
                  {settings.voiceMode && voiceConversationError ? (
                    <div className="voice-conversation-bar voice-conversation-bar--warn" role="alert">
                      <span className="voice-conversation-bar-text">{voiceConversationError}</span>
                      <button
                        type="button"
                        className="voice-conversation-bar-dismiss"
                        onClick={() => setVoiceConversationError(null)}
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : null}
                  {settings.voiceMode ? (
                    <div className="voice-convo-feedback" aria-live="polite">
                      {settings.voiceMode && voiceMicMuted ? (
                        <span className="voice-convo-feedback__line voice-convo-feedback--muted">
                          <span className="voice-convo-feedback__dot voice-convo-feedback__dot--muted" aria-hidden />
                          Mic muted — tap the mic on Butler to unmute.
                        </span>
                      ) : voiceConvoPausedUi ? (
                        <span className="voice-convo-feedback__line voice-convo-feedback--paused">
                          <span className="voice-convo-feedback__dot" aria-hidden />
                          Paused while Butler replies…
                        </span>
                      ) : voiceConvoHeardPreview ? (
                        <span className="voice-convo-feedback__line voice-convo-feedback--heard">
                          <span className="voice-convo-feedback__dot voice-convo-feedback__dot--heard" aria-hidden />
                          Heard: “{voiceConvoHeardPreview}
                          {voiceConvoHeardPreview.length >= 72 ? '…' : ''}”
                        </span>
                      ) : voiceConvoUserSpeaking ? (
                        <span className="voice-convo-feedback__line voice-convo-feedback--speaking">
                          <span className="voice-convo-feedback__dot voice-convo-feedback__dot--pulse" aria-hidden />
                          Hearing you…
                        </span>
                      ) : (
                        <span className="voice-convo-feedback__line voice-convo-feedback--idle">
                          <span className="voice-convo-feedback__dot voice-convo-feedback__dot--idle" aria-hidden />
                          Listening for you…
                        </span>
                      )}
                    </div>
                  ) : null}
                  <div
                    className={`input-row ${chatAttachment ? 'input-row--has-attachment' : ''}`}
                  >
                    {chatAttachment ? (
                      <div
                        className={`input-attachment-badge${
                          chatAttachment.mime.startsWith('image/')
                            ? stealthImageAttach
                              ? ' input-attachment-badge--stealth'
                              : ''
                            : ' input-attachment-badge--file'
                        }`}
                        title={chatAttachment.name}
                        aria-label={
                          chatAttachment.mime.startsWith('image/')
                            ? stealthImageAttach
                              ? `Image attached: ${chatAttachment.name}`
                              : undefined
                            : `File attached: ${chatAttachment.name}`
                        }
                      >
                        {chatAttachment.mime.startsWith('image/') ? (
                          stealthImageAttach ? (
                            <span className="input-attachment-stealth-mark" aria-hidden>
                              ∴
                            </span>
                          ) : (
                            <img
                              src={chatAttachment.dataUrl}
                              alt=""
                              className="input-attachment-badge-thumb"
                            />
                          )
                        ) : (
                          <span className="input-attachment-badge-file-icon" aria-hidden>
                            ⎘
                          </span>
                        )}
                        <button
                          type="button"
                          className="input-attachment-badge-clear"
                          onClick={() => setChatAttachment(null)}
                          title="Remove attachment"
                          aria-label="Remove attachment"
                        >
                          ×
                        </button>
                      </div>
                    ) : null}
                    <input
                      type="file"
                      id="file-attachment-upload"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        if (f.size > MAX_CHAT_ATTACHMENT_BYTES) {
                          const maxLabel =
                            MAX_CHAT_ATTACHMENT_BYTES >= 1024 * 1024
                              ? `${Math.round(MAX_CHAT_ATTACHMENT_BYTES / (1024 * 1024))} MB`
                              : `${Math.round(MAX_CHAT_ATTACHMENT_BYTES / 1024)} KB`;
                          window.alert(`File is too large (max ${maxLabel}).`);
                          e.target.value = '';
                          return;
                        }
                        const r = new FileReader();
                        r.onload = () => {
                          const dataUrl = String(r.result);
                          const parsed = parseDataUrl(dataUrl);
                          const mime =
                            parsed?.mime.split(';')[0].trim() || f.type || 'application/octet-stream';
                          setChatAttachment({ dataUrl, name: f.name || 'attachment', mime });
                        };
                        r.readAsDataURL(f);
                        e.target.value = '';
                      }}
                    />
                    <label
                      htmlFor="file-attachment-upload"
                      className={`upload-attachment-btn ${chatAttachment ? 'upload-attachment-btn--active' : ''}`}
                      title="Attach a file (images use img→img / video; other files go to the model as context)"
                    >
                      📎
                    </label>
                    <textarea
                      ref={chatInputRef}
                      className={`input-auto-grow ${
                        chatAttachment?.mime.startsWith('image/')
                          ? stealthImageAttach
                            ? 'chat-input--image-attached-stealth'
                            : 'chat-input--image-attached'
                          : ''
                      }`}
                      rows={1}
                      placeholder="Plain English is fine—Butler figures out intent like an IDE copilot (no special commands). Shift+Enter newline, Enter send. ↑/↓ — last 100 prompts in this browser."
                      value={input}
                      onChange={(e) => {
                        chatHistoryDepthRef.current = null;
                        chatHistoryDraftRef.current = '';
                        setInput(e.target.value);
                        requestAnimationFrame(resizeChatInput);
                      }}
                      onKeyDown={onKeyDown}
                      onClick={(e) => (e.target as HTMLTextAreaElement).focus()}
                      tabIndex={0}
                      autoComplete="off"
                    />
                  </div>
                  <div className="input-actions">
                    {settings.voiceMode && avatarSpeaking ? (
                      <button
                        type="button"
                        className="voice-stop-speak-btn"
                        onClick={() => stopAssistantSpeech()}
                        title="Stop Butler from reading this reply aloud"
                      >
                        Stop speaking
                      </button>
                    ) : null}
                    {!settings.voiceMode && (
                      <button
                        type="button"
                        className={`mic-btn ${isListening ? 'listening' : ''} ${!speechSupported ? 'mic-disabled' : ''}`}
                        onClick={toggleSpeech}
                        title={speechSupported ? (isListening ? 'Click to stop and transcribe' : 'Speech-to-text (record voice, paste into box)') : 'Microphone not supported'}
                        aria-label={speechSupported ? (isListening ? 'Stop recording' : 'Record voice') : 'Microphone not supported'}
                      >
                        {isListening ? (
                          <svg
                            className="mic-btn-icon"
                            width="20"
                            height="20"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            aria-hidden
                          >
                            <rect x="7" y="7" width="10" height="10" rx="1.5" />
                          </svg>
                        ) : (
                          <svg
                            className="mic-btn-icon"
                            width="22"
                            height="22"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                          >
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" y1="19" x2="12" y2="23" />
                            <line x1="8" y1="23" x2="16" y2="23" />
                          </svg>
                        )}
                      </button>
                    )}
                    <button type="button" onClick={() => void send()} disabled={activeTab?.isSending}>
                      {activeTab?.isSending ? 'Sending…' : 'Send'}
                    </button>
                  </div>
                </div>
              </div>

            <div
              className="chat-panel-vsplit-handle chat-panel-vsplit-handle--section"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize chat panel height"
              title="Drag to resize the whole chat area. Double-click to fill available height."
              onMouseDown={onChatSectionResizeStart}
              onDoubleClick={(ev) => {
                ev.preventDefault();
                setChatSectionHeightPx(null);
              }}
            />
          </section>
          {agentMounted && agentView === 'split' ? (
            <div
              className="layout-resize-handle layout-resize-handle--vertical"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize Butler and Agent split view"
              title="Drag to resize Butler chat and Agent. Double-click to reset."
              onMouseDown={onSplitPaneResizeStart}
              onDoubleClick={(e) => {
                e.preventDefault();
                setSplitChatWidthPx(null);
              }}
            />
          ) : null}
          {agentMounted ? (
            <section
              className={`agent-host-panel${agentView === 'chat' ? ' agent-host-panel--hidden' : ''}${agentView === 'split' ? ' agent-host-panel--split' : ''}`}
              aria-label="Butler Agent"
            >
              <AgentWindow
                embedded
                splitView={!agentOnlyShell && agentView === 'split'}
                onBack={showChatOnlyView}
                onEnterSplit={agentOnlyShell ? undefined : () => showAgentView('split')}
                onExitSplit={agentOnlyShell ? undefined : () => showAgentView('agent')}
                onPopOut={agentOnlyShell ? undefined : () => window.butlerElectron?.popOutButlerAgent?.()}
              />
            </section>
          ) : null}
        </main>
      </div>

      {!isCodeHelperVariant && activityLogModalOpen && (
        <div className="activity-log-modal-layer" role="presentation">
          <div
            id="butler-activity-log-modal"
            className="activity-log-modal-window"
            role="dialog"
            aria-modal="true"
            aria-labelledby={activityLogModalTitleId}
            style={{ left: activityLogModalPos.left, top: activityLogModalPos.top }}
          >
            <div
              className="activity-log-modal-header"
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).closest('button')) return;
                e.preventDefault();
                setActivityLogDrag({
                  startX: e.clientX,
                  startY: e.clientY,
                  origLeft: activityLogModalPosRef.current.left,
                  origTop: activityLogModalPosRef.current.top,
                });
              }}
            >
              <h2 id={activityLogModalTitleId} className="activity-log-modal-title">
                Activity log
                {(activeTab?.sendLog?.length ?? 0) > 0 ? ` (${activeTab?.sendLog?.length})` : ''}
              </h2>
              <div className="activity-log-modal-header-actions">
                <button type="button" className="activity-log-modal-reset" onClick={resetActivityLogModalPosition} title="Center window">
                  Reset position
                </button>
                <button
                  type="button"
                  className="activity-log-modal-close"
                  onClick={() => setActivityLogModalOpen(false)}
                  aria-label="Close activity log"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="activity-log-modal-body">
              <p className="settings-desc" style={{ margin: '0 0 10px', fontSize: '0.85rem' }}>
                Host and HTTP trace for the <strong>current chat tab</strong>. Drag the title bar to move this window anywhere.
              </p>
              <div className="send-activity-log-module-actions">
                <button
                  type="button"
                  className="send-activity-log-clear"
                  onClick={() => activeTab && updateTab(activeTab.id, { sendLog: [] })}
                  disabled={activeTab?.isSending || !(activeTab?.sendLog?.length ?? 0)}
                >
                  Clear
                </button>
              </div>
              <pre ref={sendLogPreRef} className="send-activity-log-body activity-log-modal-pre">
                {(activeTab?.sendLog ?? []).length > 0
                  ? (activeTab?.sendLog ?? []).join('\n')
                  : 'Nothing logged yet for this tab.'}
               </pre>
              </div>
            </div>
          </div>
        )}

        {secretMenuOpen && (
        <>
        <div
          className="settings-modal-backdrop secret-menu-backdrop"
          onClick={() => setSecretMenuOpen(false)}
          role="presentation"
          style={secretMenuMinimized ? { display: 'none' } : undefined}
        >
          <div
            id="butler-utility-panel"
            className="settings-modal secret-menu-dialog secret-menu-dialog--resizable"
            role="dialog"
            aria-modal="true"
            aria-labelledby={secretMenuTitleId}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: utilityPanelModalSize.w,
              height: utilityPanelModalSize.h,
              maxWidth: 'min(96vw, 920px)',
              maxHeight: 'min(92dvh, 900px)',
            }}
          >
            <div style={{ padding: '6px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
                  <span className="settings-desc" style={{ margin: 0, fontWeight: 600 }}>Utility Panel</span>
                  <button type="button" className="settings-secondary-btn" onClick={() => setSecretMenuMinimized(true)} style={{ padding: '2px 10px', fontSize: '0.85em' }}>▲ Minimize</button>
                </div>
                <div className="settings-modal-header">
              <h2 id={secretMenuTitleId} className="settings-modal-title">
                Utility panel
              </h2>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setSecretMenuOpen(false)}
                aria-label="Close utility panel"
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <p className="settings-desc secret-menu-flavor">
                {secretMenuFlavor === 'qwe'
                  ? 'Extended shortcut recognized. Here are extra tools without opening Settings.'
                  : 'Extra shortcuts and housekeeping tools.'}
              </p>
              <p className="settings-desc" style={{ marginTop: 10 }}>
                Press Esc to close. Drag the corner grip to resize; size is remembered.
              </p>
              <div className="secret-menu-chat-compose" data-no-chat-hotkey="true">
                <p className="settings-desc secret-menu-prompting-title">Side composer</p>
                <p className="settings-desc secret-menu-chat-hint">
                  Second message field — same <strong>active tab</strong> session as the main box. Your text here is{' '}
                  <strong>not</strong> shown as a user bubble; Butler&apos;s reply (text, images, video) is added to this tab.
                  Returned images show inline here automatically (on the main composer, end the prompt with{' '}
                  <code className="secret-menu-code-ref">--r</code> for the same). Nothing is copied into the main composer.
                  Attachments on 📎 apply only here. Shift+Enter for a new line; Enter sends and closes the panel — the status
                  bar under the header shows progress.
                </p>
                <div
                  className={`secret-menu-attach-row ${secretMenuAttachment ? 'secret-menu-attach-row--has-file' : ''}`}
                >
                  {secretMenuAttachment ? (
                    <div
                      className={`input-attachment-badge${
                        secretMenuAttachment.mime.startsWith('image/')
                          ? stealthImageAttach
                            ? ' input-attachment-badge--stealth'
                            : ''
                          : ' input-attachment-badge--file'
                      }`}
                      title={secretMenuAttachment.name}
                      aria-label={
                        secretMenuAttachment.mime.startsWith('image/')
                          ? stealthImageAttach
                            ? `Image attached: ${secretMenuAttachment.name}`
                            : undefined
                          : `File attached: ${secretMenuAttachment.name}`
                      }
                    >
                      {secretMenuAttachment.mime.startsWith('image/') ? (
                        stealthImageAttach ? (
                          <span className="input-attachment-stealth-mark" aria-hidden>
                            ∴
                          </span>
                        ) : (
                          <img
                            src={secretMenuAttachment.dataUrl}
                            alt=""
                            className="input-attachment-badge-thumb"
                          />
                        )
                      ) : (
                        <span className="input-attachment-badge-file-icon" aria-hidden>
                          ⎘
                        </span>
                      )}
                      <button
                        type="button"
                        className="input-attachment-badge-clear"
                        onClick={() => setSecretMenuAttachment(null)}
                        title="Remove attachment"
                        aria-label="Remove side composer attachment"
                      >
                        ×
                      </button>
                    </div>
                  ) : null}
                  <input
                    type="file"
                    id="secret-menu-file-upload"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (f.size > MAX_CHAT_ATTACHMENT_BYTES) {
                        const maxLabel =
                          MAX_CHAT_ATTACHMENT_BYTES >= 1024 * 1024
                            ? `${Math.round(MAX_CHAT_ATTACHMENT_BYTES / (1024 * 1024))} MB`
                            : `${Math.round(MAX_CHAT_ATTACHMENT_BYTES / 1024)} KB`;
                        window.alert(`File is too large (max ${maxLabel}).`);
                        e.target.value = '';
                        return;
                      }
                      const r = new FileReader();
                      r.onload = () => {
                        const dataUrl = String(r.result);
                        const parsed = parseDataUrl(dataUrl);
                        const mime =
                          parsed?.mime.split(';')[0].trim() || f.type || 'application/octet-stream';
                        setSecretMenuAttachment({ dataUrl, name: f.name || 'attachment', mime });
                      };
                      r.readAsDataURL(f);
                      e.target.value = '';
                    }}
                  />
                  <label
                    htmlFor="secret-menu-file-upload"
                    className={`upload-attachment-btn ${secretMenuAttachment ? 'upload-attachment-btn--active' : ''}`}
                    title="Attach a file (side composer only)"
                  >
                    📎
                  </label>
                </div>
                <textarea
                  ref={secretMenuChatInputRef}
                  id="secret-menu-chat-input"
                  className="secret-menu-chat-textarea"
                  rows={4}
                  placeholder="Type here… end with --r to show returned images in the thread."
                  title="Side composer — same session as main chat"
                  value={secretMenuChatInput}
                  onChange={(e) => setSecretMenuChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      e.stopPropagation();
                      void handleSecretMenuSend();
                    }
                  }}
                  autoComplete="off"
                />
                <div className="secret-menu-chat-actions">
                  <button
                    type="button"
                    className="settings-save"
                    disabled={!activeTab || activeTab.isSending}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void handleSecretMenuSend()}
                  >
                    {activeTab?.isSending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </div>
              <SecretMenuImageTools
                poseReference={secretMenuPoseReference}
                onUsePose={(image) => {
                  setSecretMenuPoseReference(image);
                }}
              />
              <div className="secret-menu-generated-section">
                <button
                  type="button"
                  className={`secret-menu-generated-toggle${secretMenuGeneratedGalleryOpen ? ' secret-menu-generated-toggle--open' : ''}`}
                  aria-expanded={secretMenuGeneratedGalleryOpen}
                  onClick={() => setSecretMenuGeneratedGalleryOpen((o) => !o)}
                >
                  <span className="secret-menu-generated-toggle-chevron" aria-hidden>
                    ▸
                  </span>
                  <span className="secret-menu-generated-toggle-label">Session image &amp; video gallery</span>
                  {generatedImageGalleryItems.length > 0 ? (
                    <span className="secret-menu-generated-toggle-count">{generatedImageGalleryItems.length}</span>
                  ) : null}
                </button>
                {secretMenuGeneratedGalleryOpen ? (
                  <div
                    className="secret-menu-generated-panel"
                    role="region"
                    aria-label="Session image and video gallery"
                  >
                    <p className="settings-desc secret-menu-generated-desc">
                      Thumbnails for image and video replies from this session (thread stays text-first). Videos also appear
                      here as small previews. Files also land under{' '}
                      <code className="secret-menu-code-ref">Documents/Butlor/generated</code> (or your BUTLOR_CONFIG folder).
                    </p>
                    <div className="secret-menu-generated-actions">
                      <button type="button" className="settings-secondary-btn" onClick={() => void openGeneratedDiskFolder()}>
                        Open generated folder on disk
                      </button>
                    </div>
                    {generatedImageGalleryItems.length === 0 ? (
                      <p className="settings-desc secret-menu-generated-empty">
                        No session images or videos yet. Ask for a picture or video in any tab, then open this section again.
                      </p>
                    ) : (
                      <div className="settings-generated-images-grid secret-menu-generated-grid">
                        {generatedImageGalleryItems.map((it) => (
                          <figure key={it.key} className="settings-generated-image-card">
                            {it.caption ? (
                              <figcaption className="settings-generated-image-caption">{it.caption}</figcaption>
                            ) : null}
                            {it.kind === 'video' ? (
                              <video
                                src={it.src}
                                muted
                                playsInline
                                controls
                                className="settings-generated-image-thumb"
                                aria-label={it.caption || 'Session video'}
                              />
                            ) : (
                              <img src={it.src} alt={it.caption || it.tabLabel} className="settings-generated-image-thumb" />
                            )}
                            <span className="settings-generated-image-tab">{it.tabLabel}</span>
                          </figure>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
              <div className="secret-menu-prompting" role="group" aria-label="Display options">
                <p className="settings-desc secret-menu-prompting-title">Chat layout</p>
                <label className="secret-menu-checkbox-row">
                  <input
                    type="checkbox"
                    checked={stealthImageAttach}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setStealthImageAttach(v);
                      try {
                        localStorage.setItem(LS_STEALTH_IMAGE_ATTACH, v ? '1' : '0');
                      } catch {
                        /* ignore */
                      }
                    }}
                  />
                  <span>
                    <strong>Compact image clip indicator</strong>
                    <span className="secret-menu-checkbox-hint">
                      Shows a small mark instead of a thumbnail next to the field (filename still on hover). The image still
                      sends with your message.
                    </span>
                  </span>
                </label>
              </div>
              <div className="secret-menu-prompt-chips-wrap">
                <p className="settings-desc secret-menu-prompt-chips-intro">
                  Saved <strong>image prompt</strong> snippets for local generation workflows — structure tips in this{' '}
                  <a
                    href="https://learn.rundiffusion.com/prompting-guide-for-juggernaut-x"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    general prompting article
                  </a>
                  . Click a chip to append to the side composer (merges with existing text). Developers can change the list in
                  the bundled prompts module.
                </p>
                <div className="secret-menu-prompt-chips">
                  {SECRET_MENU_NSFW_PROMPT_SNIPPETS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="secret-menu-prompt-chip"
                      onClick={() => applySecretMenuPromptSnippet(s.prompt)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="secret-menu-actions">
                <button
                  type="button"
                  className="settings-save"
                  disabled={rebuildBusy}
                  onClick={() => void triggerDesktopRebuild()}
                >
                  {rebuildBusy ? 'Starting…' : 'Rebuild desktop app'}
                </button>
                {rebuildMessage ? (
                  <p
                    className={
                      rebuildMessage.toLowerCase().includes('could not') ||
                      rebuildMessage.toLowerCase().includes('only') ||
                      rebuildMessage.toLowerCase().includes('invalid')
                        ? 'settings-learn-status-line settings-learn-status--warn'
                        : 'settings-desc'
                    }
                    style={{ marginTop: 0 }}
                  >
                    {rebuildMessage}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="settings-secondary-btn"
                  disabled={selfTestRunning}
                  onClick={() => void triggerSelfTest()}
                >
                  {selfTestRunning ? 'Running tests…' : 'Run all tests'}
                </button>
                <button
                  type="button"
                  className="settings-secondary-btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(window.location.origin).catch(() => {
                      /* ignore */
                    });
                  }}
                >
                  Copy app URL (origin)
                </button>
              </div>
            </div>
            <button
              type="button"
              className="secret-menu-resize-handle"
              aria-label="Resize utility panel"
              onPointerDown={onUtilityPanelResizePointerDown}
              onPointerMove={onUtilityPanelResizePointerMove}
              onPointerUp={onUtilityPanelResizePointerUp}
              onPointerCancel={onUtilityPanelResizePointerUp}
            />
          </div>
        </div>
      </>
      )}

      {!isCodeHelperVariant && settingsOpen && (
        <div
          className="settings-modal-backdrop"
          onClick={() => setSettingsOpen(false)}
          role="presentation"
        >
          <div
            id="butler-settings-modal"
            className="settings-modal settings-modal--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby={settingsModalTitleId}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-modal-header">
              <h2 id={settingsModalTitleId} className="settings-modal-title">
                Settings
              </h2>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <div className="settings-subtabs" role="tablist" aria-label="Settings sections">
                <button
                  type="button"
                  role="tab"
                  className={`settings-subtab ${settingsSubTab === 'general' ? 'settings-subtab--active' : ''}`}
                  aria-selected={settingsSubTab === 'general'}
                  onClick={() => setSettingsSubTab('general')}
                >
                  General
                </button>
                <button
                  type="button"
                  role="tab"
                  className={`settings-subtab ${settingsSubTab === 'data' ? 'settings-subtab--active' : ''}`}
                  aria-selected={settingsSubTab === 'data'}
                  onClick={() => setSettingsSubTab('data')}
                >
                  Data folder
                </button>
                <button
                  type="button"
                  role="tab"
                  className={`settings-subtab ${settingsSubTab === 'vram' ? 'settings-subtab--active' : ''}`}
                  aria-selected={settingsSubTab === 'vram'}
                  onClick={() => setSettingsSubTab('vram')}
                >
                  GPU / VRAM
                </button>
              </div>
              {settingsSubTab === 'vram' ? <VramSettingsPanel /> : null}
              {settingsSubTab === 'data' ? (
                <div className="settings-panel settings-panel--data-folder">
                  <p className="settings-desc">
                    Butler keeps résumés, job materials, apartment listings, Gmail tokens, 3D print outputs from chat under{' '}
                    <code>print3d/</code>, and more in one place. Default: <code>Documents/Butlor</code> on your PC. Override with the{' '}
                    <code>BUTLOR_CONFIG</code> environment variable (same value the Knowledge API uses). Chroma / embeddings live under
                    the app&apos;s user-data folder, not here. The <strong>session image &amp; video gallery</strong> and quick link to the
                    generated folder live in the <strong>utility panel</strong> (double-click the Butler logo or title in the
                    header).
                  </p>
                  {butlorDataLoading ? <p className="settings-desc">Loading…</p> : null}
                  {butlorDataError ? (
                    <p className="settings-desc settings-data-error" role="alert">
                      {butlorDataError}
                    </p>
                  ) : null}
                  {butlorDataSummary?.ok && butlorDataSummary.root ? (
                    <>
                      {butlorDataSummary.butlor_config_env ? (
                        <p className="settings-desc">
                          <strong>BUTLOR_CONFIG</strong> is set → <code>{butlorDataSummary.butlor_config_env}</code>
                        </p>
                      ) : null}
                      <div className="settings-data-actions">
                        <button
                          type="button"
                          className="settings-save"
                          onClick={() => void openButlorPath(butlorDataSummary.root!, 'open')}
                        >
                          Open Butler data folder
                        </button>
                        <button
                          type="button"
                          className="settings-secondary-btn"
                          disabled={butlorDataLoading}
                          onClick={() => {
                            setButlorDataLoading(true);
                            setButlorDataError(null);
                            fetch('/api/butlor/data_summary')
                              .then(async (r) => {
                                const d = (await r.json().catch(() => ({}))) as {
                                  ok?: boolean;
                                  error?: string;
                                  root?: string;
                                  locations?: ButlorLocationRow[];
                                };
                                const raw = d.error || '';
                                const friendly =
                                  /<!doctype|<html[\s>]/i.test(raw) || raw.length > 800
                                    ? 'Could not reach the data summary endpoint. Restart ui-server / Butler and the Knowledge API.'
                                    : raw;
                                if (!r.ok) throw new Error(friendly || r.statusText);
                                if (d.ok === false) throw new Error(friendly || 'Failed to load');
                                setButlorDataSummary(d);
                              })
                              .catch((e: unknown) =>
                                setButlorDataError(String(e instanceof Error ? e.message : e)),
                              )
                              .finally(() => setButlorDataLoading(false));
                          }}
                        >
                          Refresh counts
                        </button>
                      </div>
                      <p className="settings-data-root-path" title={butlorDataSummary.root}>
                        {butlorDataSummary.root}
                      </p>
                      <ul className="settings-data-locations">
                        {(butlorDataSummary.locations || [])
                          .filter((loc) => loc.id !== 'generated')
                          .map((loc) => (
                          <li key={loc.id} className="settings-data-location-row">
                            <div className="settings-data-location-head">
                              <strong>{loc.label}</strong>
                              <span className="settings-data-count">
                                {loc.count_label ? `${loc.count} ${loc.count_label}` : `${loc.count}`}
                              </span>
                            </div>
                            {loc.detail ? <p className="settings-data-detail">{loc.detail}</p> : null}
                            <code className="settings-data-path" title={loc.path}>
                              {loc.path}
                            </code>
                            <div className="settings-data-row-actions">
                              {loc.kind === 'folder' ? (
                                <button
                                  type="button"
                                  className="settings-secondary-btn settings-secondary-btn--small"
                                  onClick={() => void openButlorPath(loc.path, 'open')}
                                >
                                  Open in Explorer
                                </button>
                              ) : null}
                              {loc.kind === 'file' ? (
                                <>
                                  <button
                                    type="button"
                                    className="settings-secondary-btn settings-secondary-btn--small"
                                    onClick={() => void openButlorPath(loc.path, 'open')}
                                  >
                                    Open folder
                                  </button>
                                  <button
                                    type="button"
                                    className="settings-secondary-btn settings-secondary-btn--small"
                                    disabled={loc.count === 0}
                                    title={loc.count === 0 ? 'File is not created yet' : 'Highlight file in Explorer'}
                                    onClick={() => void openButlorPath(loc.path, 'reveal')}
                                  >
                                    Show file
                                  </button>
                                </>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
              ) : null}
              {settingsSubTab === 'general' ? (
              <div className="settings-panel">
                <h3>Rebuild desktop app</h3>
                <p className="settings-desc">
                  Opens a <strong>new console</strong> (Windows) that runs <code>npm run build:app</code> in your local{' '}
                  <code>ui</code> folder. When the build finishes, <strong>quit Butler</strong> and launch the new app from{' '}
                  <code>ui/dist-app-new/win-unpacked</code> or your shortcut.
                </p>
                <button
                  type="button"
                  className="settings-save"
                  disabled={rebuildBusy}
                  onClick={() => void triggerDesktopRebuild()}
                >
                  {rebuildBusy ? 'Starting…' : 'Rebuild Butler'}
                </button>
                {rebuildMessage ? (
                  <p
                    className={
                      rebuildMessage.toLowerCase().includes('could not') ||
                      rebuildMessage.toLowerCase().includes('only') ||
                      rebuildMessage.toLowerCase().includes('invalid')
                        ? 'settings-learn-status-line settings-learn-status--warn'
                        : 'settings-desc'
                    }
                    style={{ marginTop: 10 }}
                  >
                    {rebuildMessage}
                  </p>
                ) : null}

                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={!!settings.voiceMode}
                    onChange={() => {
                      const next = !settings.voiceMode;
                      if (!next) {
                        setVoiceConversationError(null);
                        setSettings((s) => ({ ...s, voiceMode: false }));
                        void saveSettings({ voiceMode: false });
                        return;
                      }
                      if (!navigator.mediaDevices?.getUserMedia) {
                        setVoiceConversationError(
                          'No microphone API here. Run the Butler desktop app (or HTTPS) and allow the mic in Settings → Microphone.',
                        );
                        return;
                      }
                      setVoiceEnableBusy(true);
                      void (async () => {
                        try {
                          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                          stream.getTracks().forEach((t) => t.stop());
                          setVoiceConversationError(null);
                          setSettings((s) => ({ ...s, voiceMode: true }));
                          await saveSettings({ voiceMode: true });
                        } catch (err) {
                          const name =
                            err && typeof err === 'object' && 'name' in err ? String((err as DOMException).name) : '';
                          if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
                            setVoiceConversationError(
                              'Microphone blocked. Use Microphone below → Allow / test, and Windows Privacy → Microphone for desktop apps.',
                            );
                          } else if (name === 'NotFoundError') {
                            setVoiceConversationError('No microphone found. Connect a mic and try again.');
                          } else {
                            setVoiceConversationError('Could not access the microphone.');
                          }
                        } finally {
                          setVoiceEnableBusy(false);
                        }
                      })();
                    }}
                    disabled={settingsSaving || voiceEnableBusy}
                  />
                  <span>
                    Voice conversation shows Butler as a <strong>floating 3D sphere</strong> (drag the orb in the browser; compact
                    always-on-top window in the desktop app) with lip sync; listens automatically—British voice when your system offers en-GB TTS.
                    Turning this on asks for the <strong>microphone</strong>. The browser uses Web Speech when it works; the{' '}
                    <strong>desktop app</strong> uses your mic plus local speech-to-text (same engine as the mic test)—more reliable than
                    Web Speech in Electron. If Butler cannot hear you, use <strong>Microphone</strong> below to test access.
                  </span>
                </label>

                <div className="settings-mic-section">
                  <h3>Microphone</h3>
                  <p className="settings-desc">
                    Conversation mode listens via Web Speech (browser) or PCM sent to speech-to-text (desktop app). Grant access here
                    once so the browser or Electron session allows Butler to open the microphone.
                  </p>
                  {micBrowserPermission != null ? (
                    <p className="settings-desc">
                      Browser reports microphone permission:{' '}
                      <strong>
                        {micBrowserPermission === 'granted'
                          ? 'granted'
                          : micBrowserPermission === 'denied'
                            ? 'denied (use the button below or system settings)'
                            : 'not decided yet — tap the button below'}
                      </strong>
                    </p>
                  ) : (
                    <p className="settings-desc">
                      This browser does not report mic permission status here; use the button to trigger the system prompt.
                    </p>
                  )}
                  <div className="settings-mic-actions">
                    <button
                      type="button"
                      className="settings-save"
                      disabled={micTestBusy}
                      onClick={() => void requestMicrophoneAccess()}
                    >
                      {micTestBusy ? 'Checking microphone…' : 'Allow / test microphone'}
                    </button>
                  </div>
                  {micTestOutcome === 'ok' ? (
                    <p className="settings-status" style={{ marginTop: 10 }}>
                      {micTestMessage}
                    </p>
                  ) : null}
                  {micTestOutcome === 'error' ? (
                    <p className="settings-learn-status-line settings-learn-status--warn" style={{ marginTop: 10 }}>
                      {micTestMessage}
                    </p>
                  ) : null}
                  <p className="settings-desc" style={{ marginTop: 10 }}>
                    <strong>Windows:</strong> Settings → Privacy &amp; security → Microphone → Microphone access on → allow desktop
                    apps. If Butler was denied before, toggle access off and on or reinstall after allowing.
                  </p>
                </div>

                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={darkMode}
                    onChange={() => setDarkMode((d) => !d)}
                    disabled={settingsSaving}
                  />
                  <span>
                    Dark mode — black base with midnight purple and blue accents (saved in this browser only).
                  </span>
                </label>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={!!settings.localOnly}
                    onChange={toggleLocalOnly}
                    disabled={settingsSaving}
                  />
                  <span>Local only (no OpenAI—100% your AI, no filters)</span>
                </label>

                <h3 style={{ marginTop: 22 }}>Self-test</h3>
                <p className="settings-desc">
                  Runs from this Butler window: checks the local API, Knowledge API, Python tests under{' '}
                  <code>knowledge/tests</code>, and UI unit tests when you run from a dev checkout (skipped in the packaged app).
                </p>
                <button
                  type="button"
                  className="settings-save"
                  disabled={selfTestRunning}
                  onClick={() => void triggerSelfTest()}
                >
                  {selfTestRunning ? 'Running tests…' : 'Run all tests'}
                </button>
                {selfTestResult ? (
                  <div className="settings-selftest" style={{ marginTop: 14 }}>
                    <p
                      className={
                        selfTestResult.ok
                          ? 'settings-status'
                          : 'settings-learn-status-line settings-learn-status--warn'
                      }
                      style={{ marginBottom: 8 }}
                    >
                      {selfTestResult.message ||
                        selfTestResult.summary ||
                        (selfTestResult.ok ? 'All checks passed' : 'Some checks failed')}
                    </p>
                    <pre className="settings-selftest-pre" tabIndex={0}>
                      {(selfTestResult.results || [])
                        .map(
                          (row) =>
                            `${row.ok ? '✓' : '✗'} ${row.name}${row.detail ? ` — ${row.detail}` : ''}${
                              row.output ? `\n${row.output}` : ''
                            }`,
                        )
                        .join('\n\n')}
                    </pre>
                  </div>
                ) : null}

                <h3 style={{ marginTop: 22 }}>Workspace &amp; tools</h3>
                <p className="settings-desc">
                  Code background, Cursor CLI hints, and resume / cover-letter helpers. These apply to chat from here—nothing else on the
                  main screen.
                </p>
                <div className="settings-tools-in-modal">
                  <ExpandableModuleSection storageKey={EXPAND_CODE_PANEL_KEY} title="Code workspace" defaultOpen={false}>
                    <ExpandableSubSection storageKey={EXPAND_CODE_BACKGROUND_KEY} title="Background context" defaultOpen>
                      <p className="settings-desc" style={{ margin: '0 0 8px', fontSize: '0.88rem' }}>
                        Persistent background for the model only—it is merged into each request and does not appear as a user message in
                        the thread. Use it for stack, conventions, paths, and constraints.
                      </p>
                      <textarea
                        ref={attachCodeContextTa}
                        className="settings-input module-toolbar-textarea-grow"
                        placeholder="e.g. TypeScript strict, React 18, ESLint airbnb, prefer functional components; project lives under D:\work\my-app; never commit secrets…"
                        value={codeWorkspaceContext}
                        onChange={(e) => {
                          setCodeWorkspaceContext(e.target.value);
                          requestAnimationFrame(resizeCodeContextTa);
                        }}
                        rows={3}
                        spellCheck={false}
                        style={{ width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}
                      />
                    </ExpandableSubSection>
                    <ExpandableSubSection storageKey={EXPAND_CODE_CLI_KEY} title="Cursor Agent CLI (terminal)" defaultOpen>
                      <p className="settings-desc" style={{ margin: '0 0 8px', fontSize: '0.85rem' }}>
                        <strong>When enabled,</strong> Butler’s model is told to delegate suitable work via{' '}
                        <code style={{ fontSize: '0.9em' }}>run_command</code> using Cursor’s CLI (e.g. headless{' '}
                        <code style={{ fontSize: '0.9em' }}>-p</code>). <strong>Your setup checklist:</strong> install the CLI from
                        Cursor’s documentation; run <code style={{ fontSize: '0.9em' }}>agent login</code> once in a terminal; under{' '}
                        <strong>Butler file access</strong> below, set <strong>Global project root</strong> to the <strong>same folder</strong>{' '}
                        you open as a workspace in Cursor. This path is <strong>not</strong> a Cursor IDE chat thread—it only runs the
                        agent in the shell with the cwd Butler uses for commands.
                      </p>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={codeCursorCliEnabled}
                          onChange={(e) => setCodeCursorCliEnabled(e.target.checked)}
                        />
                        <span style={{ fontSize: '0.9rem' }}>Enable Cursor CLI delegation hints for the model</span>
                      </label>
                      <input
                        className="settings-input"
                        type="text"
                        placeholder='Command or path (default: agent — must be on PATH, or e.g. C:\\Users\\you\\AppData\\Local\\Programs\\cursor\\agent.exe)'
                        value={codeCursorCliCommand}
                        onChange={(e) => setCodeCursorCliCommand(e.target.value)}
                        disabled={!codeCursorCliEnabled}
                        spellCheck={false}
                        style={{ width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}
                      />
                    </ExpandableSubSection>
                  </ExpandableModuleSection>
                  <ExpandableModuleSection storageKey={EXPAND_JOBS_PANEL_KEY} title="Resume tools" defaultOpen={false}>
                    <JobsPanel
                      onResult={(content, source) => {
                        if (activeTab)
                          updateTab(activeTab.id, (t) => ({
                            messages: [...t.messages, { id: `${Date.now()}-job`, role: 'assistant' as const, content, source: source || 'Jobs' }],
                          }));
                        if (settings.voiceMode) speakReply(content);
                        setJobAction(null);
                      }}
                      onCancel={() => setJobAction(null)}
                      jobAction={jobAction}
                      setJobAction={setJobAction}
                      loading={jobLoading}
                      setLoading={setJobLoading}
                      requestResumePdfExport={(html, filenameStem) => {
                        setResumePdfPending({ html, filenameStem, showJobLoading: true });
                        setResumePdfModalOpen(true);
                      }}
                      profileBaseHtml={
                        profile?.base_resume_html?.trim()
                          ? profile.base_resume_html
                          : plainLinesToHtml(profile?.base_resume || '')
                      }
                    />
                  </ExpandableModuleSection>
                  <ExpandableModuleSection storageKey={EXPAND_NETWORK_MONITOR_KEY} title="Network monitor" defaultOpen={false}>
                    <NetworkMonitorPanel />
                  </ExpandableModuleSection>
                  <ExpandableModuleSection storageKey={EXPAND_ANIMATION_GENERATOR_KEY} title="Animation generator (prompt → animated content)" defaultOpen>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                      <button
                        type="button"
                        className="settings-save"
                        onClick={() => {
                          setAnimationGenOpen(true);
                          setAnimationGenMinimized(false);
                        }}
                      >
                        Open Animation generator
                      </button>
                      <span className="settings-learn-status-line settings-learn-status--muted">
                        Opens in its own window so it can keep running while minimized.
                      </span>
                    </div>
                  </ExpandableModuleSection>
                  <ExpandableModuleSection storageKey={EXPAND_VISUALIZER_KEY} title="Visualizer (playlist → videos)" defaultOpen={false}>
                    <VisualizerPanel />
                  </ExpandableModuleSection>
                  <ExpandableModuleSection storageKey={EXPAND_SECURITY_LAB_KEY} title="Security lab" defaultOpen={false}>
                    <SecurityLabPanel />
                  </ExpandableModuleSection>
                  <ExpandableModuleSection storageKey={EXPAND_KALI_TOOLS_KEY} title="Kali tools" defaultOpen={false}>
                    <KaliToolsPanel />
                  </ExpandableModuleSection>
                  <ExpandableModuleSection storageKey={EXPAND_INFOOOZE_KEY} title="Infoooze (OSINT)" defaultOpen={false}>
                    <InfooozePanel />
                  </ExpandableModuleSection>
                  <ExpandableModuleSection storageKey={EXPAND_STATUS_SETTINGS_KEY} title="Services status" defaultOpen={false}>
                    <div className="settings-status-embed">
                      <ButlerStatusPanel onOpenSettings={() => {}} />
                    </div>
                  </ExpandableModuleSection>
                </div>

                <h3>OpenAI API Key</h3>
                <p className="settings-desc">
                  Used for structured intent and cloud reasoning when <strong>Local only</strong> is off. With Local only on, Butler
                  stays on your local stack; add a key if you want OpenAI-assisted JSON repair or hybrid flows.
                </p>
                {settings.hasKey && !settings.localOnly && <p className="settings-status">✓ {settings.openaiApiKey}</p>}
                <input
                  type="password"
                  className="settings-input"
                  placeholder="sk-..."
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  disabled={!!settings.localOnly}
                />
                <button type="button" className="settings-save" onClick={saveApiKey} disabled={settingsSaving || !!settings.localOnly}>
                  {settingsSaving ? 'Saving…' : 'Save'}
                </button>
                <h3 style={{ marginTop: 22 }}>Offline memory (Go learn)</h3>
                <p className="settings-desc">
                  Runs in the <strong>Knowledge API</strong> background: compacts your training journal into few-shot examples, then searches the web
                  (DuckDuckGo) and saves page text into <strong>Chroma</strong> for retrieval when you chat locally. Leave Butler open overnight if you
                  want a long run. Edit <code>knowledge/learn_topics.txt</code> in the Butler repo to add topics (one per line); built-in seed topics are
                  always included. Optional: set <code>BUTLER_LEARN_USE_LOCAL_LLM=1</code> to also query your local LLM per topic (slower).
                </p>
                <button
                  type="button"
                  className="settings-save settings-go-learn-btn"
                  onClick={() => void startGoLearn()}
                  disabled={goLearnBusy || !!(goLearnStatus?.running)}
                >
                  {goLearnBusy ? 'Starting…' : goLearnStatus?.running ? 'Learn run in progress…' : 'Go learn (background)'}
                </button>
                <div className="settings-learn-status" aria-live="polite">
                  {goLearnStatus?.error ? (
                    <p className="settings-learn-status-line settings-learn-status--warn">{goLearnStatus.error}</p>
                  ) : null}
                  {goLearnStatus && goLearnStatus.chroma_chunks_total != null ? (
                    <p className="settings-learn-status-line">
                      Chroma chunks (total): <strong>{goLearnStatus.chroma_chunks_total}</strong>
                      {goLearnStatus.running && goLearnStatus.chunks_added != null
                        ? ` · +${goLearnStatus.chunks_added} this run`
                        : null}
                    </p>
                  ) : null}
                  {goLearnStatus?.running ? (
                    <p className="settings-learn-status-line">
                      Stage: <code>{goLearnStatus.stage || '…'}</code>
                      {goLearnStatus.topics_total != null && goLearnStatus.topics_total > 0
                        ? ` · topic ${goLearnStatus.topics_done ?? 0} / ${goLearnStatus.topics_total}`
                        : null}
                    </p>
                  ) : null}
                  {goLearnStatus?.current_topic ? (
                    <p className="settings-learn-status-line settings-learn-status--muted">
                      Now: {goLearnStatus.current_topic.slice(0, 120)}
                      {goLearnStatus.current_topic.length > 120 ? '…' : ''}
                    </p>
                  ) : null}
                  {goLearnStatus?.last_error && !goLearnStatus.running ? (
                    <p className="settings-learn-status-line settings-learn-status--warn">Last note: {goLearnStatus.last_error}</p>
                  ) : null}
                  {goLearnStatus?.finished_at && !goLearnStatus.running && goLearnStatus.stage !== 'failed' ? (
                    <p className="settings-learn-status-line settings-learn-status--muted">
                      Last finished: {new Date(goLearnStatus.finished_at * 1000).toLocaleString()}
                    </p>
                  ) : null}
                </div>
                <h3 style={{ marginTop: 20 }}>Butler file access (developer)</h3>
                <p className="settings-desc">
                  Set a <strong>global project folder</strong> so every chat edits the same tree. <strong>Trusted roots</strong> add more folders
                  for writes, downloads, and terminal <code>cwd</code>. <strong>Documents/Butlor</strong> is always trusted for Butler outputs.
                  In <strong>Local</strong> mode, Butler can run <code>npm</code>, <code>node</code>, <code>git</code>, etc.; use{' '}
                  <code>background: true</code> on <code>run_command</code> for dev servers, then <code>open_url</code> for{' '}
                  <code>http://localhost:…</code>.
                  <br />
                  <strong>Workspace in Settings + Cursor CLI:</strong> point global project root at the <strong>same repo folder</strong> you
                  open in Cursor so CLI <code>run_command</code> runs in the right workspace (shell agent, not an IDE chat tab).
                </p>
                <label className="settings-toggle" style={{ marginTop: 12 }}>
                  <input
                    type="checkbox"
                    checked={!!settings.butlerAllowAnyPath}
                    onChange={() => {
                      const next = !settings.butlerAllowAnyPath;
                      setSettings((s) => ({ ...s, butlerAllowAnyPath: next }));
                      saveSettings({ butlerAllowAnyPath: next });
                    }}
                    disabled={settingsSaving}
                  />
                  <span>
                    <strong>Full disk access</strong> — AI can write and run commands anywhere on this PC (high risk). You can also set env{' '}
                    <code>BUTLER_ALLOW_ANY_PATH=1</code>.
                  </span>
                </label>
                {settings.butlerDevEffective?.allowAnyPath && (
                  <p className="settings-status" style={{ color: '#c96' }}>
                    Effective: full disk access is ON (settings and/or env)—review every action the model proposes.
                  </p>
                )}
                <label className="settings-desc" style={{ display: 'block', marginBottom: 4 }}>
                  Global project root (optional)
                </label>
                <input
                  type="text"
                  className="settings-input"
                  placeholder="D:\MUSIK\code helper"
                  value={devGlobalRootDraft}
                  onChange={(e) => setDevGlobalRootDraft(e.target.value)}
                  disabled={settingsSaving}
                />
                <label className="settings-desc" style={{ display: 'block', marginTop: 10, marginBottom: 4 }}>
                  Trusted roots (optional)
                </label>
                <textarea
                  className="settings-input"
                  placeholder={'D:\\OtherRepo\nD:\\MUSIK\\code helper\\knowledge'}
                  value={devTrustedRootsDraft}
                  onChange={(e) => setDevTrustedRootsDraft(e.target.value)}
                  rows={4}
                  disabled={settingsSaving}
                />
                <button
                  type="button"
                  className="settings-save"
                  onClick={() =>
                    saveSettings({
                      butlerGlobalProjectRoot: devGlobalRootDraft,
                      butlerTrustedRootsText: devTrustedRootsDraft,
                    })
                  }
                  disabled={settingsSaving}
                >
                  {settingsSaving ? 'Saving…' : 'Save file access'}
                </button>
                {settings.butlerDevEffective &&
                  (settings.butlerDevEffective.globalProjectRoot || (settings.butlerDevEffective.trustedRoots?.length ?? 0) > 0) && (
                    <p className="settings-desc" style={{ marginTop: 8, fontSize: '0.85em' }}>
                      Effective now: global{' '}
                      <code>{settings.butlerDevEffective.globalProjectRoot || '—'}</code>
                      {settings.butlerDevEffective.trustedRoots?.length ? (
                        <>
                          {' '}
                          · trusted ({settings.butlerDevEffective.trustedRoots.length}):{' '}
                          {settings.butlerDevEffective.trustedRoots.slice(0, 3).join('; ')}
                          {settings.butlerDevEffective.trustedRoots.length > 3 ? '…' : ''}
                        </>
                      ) : null}
                    </p>
                  )}
              </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {(animationGenOpen || animationGenMinimized) && (
        <>
          {!animationGenMinimized ? (
            <div
              className="settings-modal-backdrop"
              role="presentation"
              onClick={() => {
                setAnimationGenOpen(false);
                setAnimationGenMinimized(false);
              }}
            />
          ) : null}

          <div
            className="settings-modal settings-modal--wide"
            role="dialog"
            aria-modal={animationGenMinimized ? 'false' : 'true'}
            aria-label="Animation generator"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              // Must be above .settings-modal-backdrop (10100 in styles.css)
              zIndex: 10110,
              top: animationGenMinimized ? 'auto' : 40,
              left: animationGenMinimized ? 'auto' : '50%',
              transform: animationGenMinimized ? 'none' : 'translateX(-50%)',
              right: animationGenMinimized ? 18 : 'auto',
              bottom: animationGenMinimized ? 18 : 'auto',
              width: animationGenMinimized ? 340 : undefined,
              maxWidth: animationGenMinimized ? 340 : undefined,
              display: animationGenMinimized ? 'none' : 'block',
            }}
          >
            <div className="settings-modal-header">
              <h2 className="settings-modal-title">Animation generator</h2>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button type="button" className="settings-secondary-btn" onClick={() => setAnimationGenMinimized(true)}>
                  Minimize
                </button>
                <button
                  type="button"
                  className="settings-modal-close"
                  onClick={() => {
                    setAnimationGenOpen(false);
                    setAnimationGenMinimized(false);
                  }}
                  aria-label="Close animation generator"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="settings-modal-body">
              <div className="settings-panel">
                <AnimationGeneratorPanel />
              </div>
            </div>
          </div>

          {animationGenMinimized ? (
            <button
              type="button"
              className="butler-btn"
              style={{
                position: 'fixed',
                right: 18,
                bottom: 18,
                zIndex: 10060,
                padding: '10px 12px',
                borderRadius: 999,
              }}
              onClick={() => {
                setAnimationGenMinimized(false);
                setAnimationGenOpen(true);
              }}
              aria-label="Restore animation generator"
              title="Restore animation generator"
            >
              Restore Animation generator
            </button>
          ) : null}
        </>
      )}

      {!isCodeHelperVariant && profileOpen && (
        <div
          className="settings-modal-backdrop"
          onClick={() => setProfileOpen(false)}
          role="presentation"
        >
          <div
            id="butler-profile-modal"
            className="settings-modal settings-modal--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby={profileModalTitleId}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-modal-header">
              <h2 id={profileModalTitleId} className="settings-modal-title">
                Profile
              </h2>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setProfileOpen(false)}
                aria-label="Close profile"
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <div className="setup-banner setup-banner--modal">
                <h3>Quick setup (one-time)</h3>
                <p>Name and email for job applications. Build your résumé in the editor (Word-style). Save to sync plain text for older flows.</p>
                <input placeholder="Your name" value={setupName} onChange={(e) => setSetupName(e.target.value)} className="setup-input" />
                <input placeholder="Email" type="email" value={setupEmail} onChange={(e) => setSetupEmail(e.target.value)} className="setup-input" />
                <input placeholder="Phone (optional)" value={setupPhone} onChange={(e) => setSetupPhone(e.target.value)} className="setup-input" />
                <label className="jobs-resume-label" style={{ marginTop: 10 }}>
                  Résumé (rich text)
                </label>
                <div className="resume-editor-page-wrap resume-editor-page-wrap--profile">
                  <ResumeRichEditor value={setupResumeHtml} onChange={setSetupResumeHtml} placeholder="Your résumé…" />
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="butler-btn butler-btn-secondary"
                    onClick={() => {
                      setResumePdfPending({ html: setupResumeHtml, filenameStem: 'resume', showJobLoading: false });
                      setResumePdfModalOpen(true);
                    }}
                  >
                    Export Word (.docx)
                  </button>
                  <span style={{ fontSize: '0.85em', opacity: 0.85 }}>Choose a style, export a formatted .docx, then print to US Letter PDF from Word.</span>
                </div>
                <p style={{ marginTop: 12, marginBottom: 4, fontSize: '0.9em', opacity: 0.85 }}>Indeed login (optional—for auto-submit on Indeed)</p>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <input type="checkbox" checked={setupIndeedChromeProfile} onChange={(e) => setSetupIndeedChromeProfile(e.target.checked)} />
                  Use my Chrome profile (Google login) — close Chrome first
                </label>
                {(setupIndeedChromeProfile || setupFacebookUseChrome) && (
                  <input placeholder="Chrome User Data path (blank = default)" value={setupChromeProfilePath} onChange={(e) => setSetupChromeProfilePath(e.target.value)} className="setup-input" />
                )}
                {!setupIndeedChromeProfile && (
                  <>
                    <input placeholder="Indeed email" type="email" value={setupIndeedEmail} onChange={(e) => setSetupIndeedEmail(e.target.value)} className="setup-input" />
                    <input placeholder="Indeed password" type="password" value={setupIndeedPassword} onChange={(e) => setSetupIndeedPassword(e.target.value)} className="setup-input" autoComplete="current-password" />
                  </>
                )}
                <p style={{ marginTop: 12, marginBottom: 4, fontSize: '0.9em', opacity: 0.85 }}>Facebook Marketplace only (optional—for “Open with Butler browser”)</p>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <input type="checkbox" checked={setupFacebookUseChrome} onChange={(e) => setSetupFacebookUseChrome(e.target.checked)} />
                  Use my Chrome login for Facebook (close Chrome first; path field appears above when checked)
                </label>
                <p style={{ margin: '0 0 8px', fontSize: '0.85em', opacity: 0.75 }}>
                  Google account email is used to find the right Chrome profile folder (Default, Profile 1, …). Optional password below only if you want a fallback login form.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <input placeholder="Facebook / Google email (for scan)" type="email" value={setupFacebookEmail} onChange={(e) => setSetupFacebookEmail(e.target.value)} className="setup-input" style={{ flex: '1 1 200px', minWidth: 0 }} />
                  <button type="button" className="butler-btn butler-btn-secondary" onClick={() => void scanFacebookChromeProfile()}>
                    Scan this PC &amp; save Chrome profile
                  </button>
                </div>
                {setupFacebookUseChrome && (
                  <input
                    placeholder="Chrome profile folder (e.g. Default, Profile 1) — auto-filled after scan"
                    value={setupFacebookChromeDir}
                    onChange={(e) => setSetupFacebookChromeDir(e.target.value)}
                    className="setup-input"
                  />
                )}
                {setupFacebookDetectStatus ? (
                  <p style={{ margin: '4px 0 8px', fontSize: '0.85em', opacity: 0.85 }}>{setupFacebookDetectStatus}</p>
                ) : null}
                <input placeholder="Facebook password (optional fallback)" type="password" value={setupFacebookPassword} onChange={(e) => setSetupFacebookPassword(e.target.value)} className="setup-input" autoComplete="current-password" />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="butler-btn" onClick={saveProfile} disabled={setupSaving || !setupName.trim() || !setupEmail.trim()}>
                    {setupSaving ? 'Saving…' : 'Save & continue'}
                  </button>
                  <button type="button" className="butler-btn butler-btn-secondary" onClick={() => setProfileOpen(false)}>
                    Skip
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {resumePdfModalOpen && resumePdfPending ? (
        <ResumePdfStyleModal
          open
          resumeHtml={prepareResumeHtmlForExport(resumePdfPending.html)}
          onClose={() => {
            setResumePdfModalOpen(false);
            setResumePdfPending(null);
          }}
          onExport={async (styleId) => {
            if (!resumePdfPending) return;
            const p = resumePdfPending;
            if (p.showJobLoading) setJobLoading(true);
            try {
              const exportHtml = prepareResumeHtmlForExport(p.html);
              const { blob, filenameStem, savedPath } = await downloadResumeDocx({
                html: exportHtml,
                filenameStem: p.filenameStem,
                styleId,
              });
              if (resumePdfPreviewBlobUrlRef.current) {
                URL.revokeObjectURL(resumePdfPreviewBlobUrlRef.current);
              }
              const previewUrl = URL.createObjectURL(blob);
              resumePdfPreviewBlobUrlRef.current = previewUrl;
              const dlName = `${filenameStem}.docx`;
              const a = document.createElement('a');
              a.href = previewUrl;
              a.download = dlName;
              a.rel = 'noopener';
              a.click();
              setResumePdfPreview({ url: previewUrl, filename: dlName, savedPath });
              setResumeDocxLastInput({ html: p.html, filenameStem: p.filenameStem });
            } catch (e: unknown) {
              window.alert((e as Error)?.message || String(e));
              throw e;
            } finally {
              if (p.showJobLoading) setJobLoading(false);
            }
          }}
        />
      ) : null}

      {resumePdfPreview ? (
        <div className="resume-pdf-preview-toast" role="status" aria-live="polite">
          <span className="resume-pdf-preview-toast-text">
            Word document saved — also copied to your Butler data folder
            {resumePdfPreview.savedPath ? (
              <>
                : <code className="resume-pdf-saved-path">{resumePdfPreview.savedPath}</code>
              </>
            ) : (
              ' (e.g. D:\\butler\\resumes on Windows, or your BUTLOR_CONFIG folder)'
            )}
            . Open in Word, then File → Print → PDF if you want a PDF.
          </span>
          <button
            type="button"
            className="butler-btn"
            onClick={() => {
              if (!resumeDocxLastInput) return;
              // Re-open the style picker so the user can preview all 5 templates before downloading again.
              dismissResumePdfPreview();
              setResumePdfPending({ html: resumeDocxLastInput.html, filenameStem: resumeDocxLastInput.filenameStem, showJobLoading: false });
              setResumePdfModalOpen(true);
            }}
          >
            Choose style to download
          </button>
          <button type="button" className="butler-btn butler-btn-secondary" onClick={dismissResumePdfPreview}>
            Dismiss
          </button>
        </div>
      ) : null}

      {dockFlySession ? (
        <ButlerDockFlyOverlay
          session={dockFlySession}
          targetRef={voiceHeaderDockTargetRef}
          speaking={avatarSpeaking}
          voiceActive
          onComplete={completeDockFly}
        />
      ) : null}

      {settings.voiceMode && !voiceFaceMinimized && !isElectronButler() && !dockFlySession && (
        <WebButlerFloat
          ref={webButlerFloatRef}
          speaking={avatarSpeaking}
          voiceActive
          onRequestDock={(fly) => {
            if (fly) setDockFlySession(fly);
            else setVoiceFaceMinimized(true);
          }}
          userSpeaking={voiceConvoUserSpeaking}
          heardPreview={voiceConvoHeardPreview}
          voicePaused={voiceConvoPausedUi}
          micMuted={voiceMicMuted}
          onMicMutedChange={setVoiceMicMuted}
        />
      )}
    </div>
    </>
  );
};

