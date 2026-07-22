import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AGENT_PROVIDERS,
  providerNeedsApiKey,
  type AgentProviderId,
} from '../lib/agentProviders';
import {
  AGENT_ACCENTS,
  AGENT_THEME_MODES,
  type AgentAccent,
  type AgentThemeMode,
  type AgentThemePrefs,
} from '../lib/agentTheme';
import type { AgentCheckpoint } from '../lib/agentTypes';
import {
  hintForEnvKey,
  type AgentEnvVarRow,
} from '../lib/agentEnvVars';
import { ButlerMiniStatusStrip } from './ButlerMiniStatusStrip';
import { fetchButlerJsonWithResponse } from '../lib/fetchButlerJson';
import { VramSettingsPanel } from './VramSettingsPanel';
import { SpotifySeoPanel } from './SpotifySeoPanel';
import {
  getScreenLookModeEnabled,
  setScreenLookModeEnabled,
} from '../lib/screenAssistPrefs';
import {
  ensureSelfEditCodebaseIndex,
  fetchCascadeStatus,
  fetchSelfEditCodebaseIndexStatus,
  type CascadeStatusPayload,
} from '../lib/agentApi';

import { cancelNeuralSpeech, DEFAULT_NEURAL_VOICE, speakNeural } from '../lib/neuralTts';
import {
  DEFAULT_PULSE_COLORS,
  fetchNeuralVoiceOptions,
  filterMaleNeuralVoices,
  formatNeuralVoiceLabel,
  loadChatFormality,
  loadDefaultVoiceId,
  loadPulseColors,
  saveChatFormality,
  saveDefaultVoiceId,
  savePulseColors,
  type NeuralVoiceOption,
  type PulseColors,
} from '../lib/chatModePrefs';

export type AgentSettingsProductMode = 'chat' | 'code' | 'self-edit';

type StatusRow = {
  id: string;
  label: string;
  ok?: boolean | null;
  url?: string;
  detail?: string;
  skipped?: boolean;
};
type StatusPayload = {
  services?: StatusRow[];
  error?: string;
  status_note?: string;
};

export function AgentBrowserControls() {
  const launchBrowser = useCallback(() => {
    if (typeof window !== 'undefined' && window.butlerElectron?.openAgentBrowser) {
      void window.butlerElectron.openAgentBrowser();
    }
  }, []);

  return (
    <div className="agent-window-cwd-row">
      <button
        type="button"
        className="agent-window-btn agent-window-btn--ghost"
        onClick={launchBrowser}
      >
        Launch Browser
      </button>
    </div>
  );
}

function SelfEditCodebaseIndexControls({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<{
    fresh?: boolean;
    present?: boolean;
    file_count?: number;
    chunk_count?: number;
    indexed_at_iso?: string;
    last_mode?: string;
    map_path?: string;
    error?: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const st = await fetchSelfEditCodebaseIndexStatus();
      setStatus(st);
    } catch (err) {
      setStatus({ error: String((err as Error)?.message || err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNote(null);
    try {
      const out = await ensureSelfEditCodebaseIndex({
        force: true,
        async: false,
        cwd: cwd.trim() || undefined,
      });
      if (out.error) {
        setNote(out.error);
      } else {
        setNote(
          out.refreshed
            ? `Index rebuilt · ${out.file_count ?? '?'} files · ${out.chunk_count ?? '?'} chunks`
            : 'Index already up to date.',
        );
      }
      await load();
    } catch (err) {
      setNote(String((err as Error)?.message || err));
    } finally {
      setRefreshing(false);
    }
  }, [cwd, load]);

  const summary = status?.present
    ? `${status.fresh ? 'Fresh' : 'Stale'} · ${status.file_count ?? 0} files · ${status.chunk_count ?? 0} chunks` +
      (status.indexed_at_iso ? ` · ${status.indexed_at_iso}` : '') +
      (status.last_mode ? ` · last=${status.last_mode}` : '')
    : status?.error
      ? status.error
      : 'Not indexed yet';

  return (
    <div className="agent-settings-codebase-index-controls">
      <p className="agent-settings-note" style={{ marginTop: 0 }}>
        {loading ? 'Loading codebase map…' : summary}
      </p>
      <button
        type="button"
        className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
        onClick={() => void refresh()}
        disabled={refreshing || loading}
      >
        {refreshing ? 'Rebuilding…' : 'Rebuild codebase map'}
      </button>
      {note ? <p className="agent-settings-note">{note}</p> : null}
      {status?.map_path ? (
        <p className="agent-settings-note" title={status.map_path}>
          Map: <code>{status.map_path}</code>
        </p>
      ) : null}
    </div>
  );
}

const VOICE_PREVIEW_PHRASE = "Hi, I'm Butler.";

function ChatModeSettingsSection({ open }: { open: boolean }) {
  const [voiceId, setVoiceId] = useState(() => loadDefaultVoiceId());
  const [voices, setVoices] = useState<NeuralVoiceOption[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [pulse, setPulse] = useState<PulseColors>(() => loadPulseColors());
  const [formality, setFormality] = useState(() => loadChatFormality());

  useEffect(() => {
    if (!open) {
      cancelNeuralSpeech();
      return;
    }
    setVoiceId(loadDefaultVoiceId());
    setPulse(loadPulseColors());
    setFormality(loadChatFormality());
    let cancelled = false;
    setVoicesLoading(true);
    setVoicesError(null);
    void fetchNeuralVoiceOptions()
      .then((list) => {
        if (cancelled) return;
        setVoices(list);
        if (!list.length) setVoicesError('No Edge neural voices listed (is edge-tts installed?).');
      })
      .catch((err) => {
        if (cancelled) return;
        setVoicesError(String((err as Error)?.message || err));
      })
      .finally(() => {
        if (!cancelled) setVoicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    return () => {
      cancelNeuralSpeech();
    };
  }, []);

  const previewVoice = useCallback((id: string) => {
    cancelNeuralSpeech();
    void speakNeural(VOICE_PREVIEW_PHRASE, {
      voiceId: id || DEFAULT_NEURAL_VOICE,
    });
  }, []);

  const maleVoices = useMemo(() => {
    const filtered = filterMaleNeuralVoices(voices);
    const current = voiceId || DEFAULT_NEURAL_VOICE;
    if (current && !filtered.some((v) => v.shortName === current)) {
      return [
        {
          name: current,
          shortName: current,
          locale: '',
          gender: 'Male',
        },
        ...filtered,
      ];
    }
    return filtered;
  }, [voices, voiceId]);

  useEffect(() => {
    if (!maleVoices.length || voicesLoading) return;
    const current = voiceId || DEFAULT_NEURAL_VOICE;
    if (maleVoices.some((v) => v.shortName === current)) return;
    const fallback =
      maleVoices.find((v) => v.shortName === DEFAULT_NEURAL_VOICE)?.shortName ||
      maleVoices[0]!.shortName;
    setVoiceId(fallback);
    saveDefaultVoiceId(fallback);
  }, [maleVoices, voiceId, voicesLoading]);

  const currentVoiceIndex = useMemo(() => {
    const idx = maleVoices.findIndex((v) => v.shortName === (voiceId || DEFAULT_NEURAL_VOICE));
    return idx >= 0 ? idx : 0;
  }, [maleVoices, voiceId]);

  const currentVoice = maleVoices[currentVoiceIndex];

  const cycleVoice = (delta: -1 | 1) => {
    if (maleVoices.length <= 1) return;
    const nextIdx = (currentVoiceIndex + delta + maleVoices.length) % maleVoices.length;
    const next = maleVoices[nextIdx]!.shortName;
    setVoiceId(next);
    saveDefaultVoiceId(next);
    previewVoice(next);
  };

  const formalityLabel =
    formality < 0.33 ? 'Casual' : formality < 0.66 ? 'Balanced' : 'Professional';

  return (
    <section className="agent-settings-section">
      <h3 className="agent-settings-section-title">Chat mode</h3>
      <p className="agent-settings-note">
        Voice, pulse colors, and tone for Butler Chat / voice conversation. Saved on this machine.
      </p>

      <div className="agent-chat-voice-row">
        <div className="agent-window-api-key-field agent-chat-voice-field">
          <span className="agent-window-api-key-label">Default voice</span>
          <div className="agent-chat-voice-picker" role="group" aria-label="Default voice">
            <button
              type="button"
              className="agent-chat-voice-arrow agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
              onClick={() => cycleVoice(-1)}
              disabled={voicesLoading || maleVoices.length <= 1}
              aria-label="Previous voice"
            >
              ←
            </button>
            <span className="agent-chat-voice-name" id="chat-default-voice">
              {voicesLoading
                ? 'Loading voices…'
                : currentVoice
                  ? formatNeuralVoiceLabel(currentVoice)
                  : 'No male voices'}
            </span>
            <button
              type="button"
              className="agent-chat-voice-arrow agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
              onClick={() => cycleVoice(1)}
              disabled={voicesLoading || maleVoices.length <= 1}
              aria-label="Next voice"
            >
              →
            </button>
          </div>
        </div>
      </div>
      {voicesError ? <p className="agent-settings-note">{voicesError}</p> : null}

      <div className="agent-chat-pulse-colors" role="group" aria-label="Pulse colors">
        <label className="agent-chat-pulse-color">
          <span>Ready</span>
          <input
            type="color"
            value={pulse.ready}
            onChange={(e) => {
              const next = { ...pulse, ready: e.target.value };
              setPulse(next);
              savePulseColors(next);
            }}
          />
        </label>
        <label className="agent-chat-pulse-color">
          <span>Butler speaking</span>
          <input
            type="color"
            value={pulse.butlerSpeaking}
            onChange={(e) => {
              const next = { ...pulse, butlerSpeaking: e.target.value };
              setPulse(next);
              savePulseColors(next);
            }}
          />
        </label>
        <label className="agent-chat-pulse-color">
          <span>User speaking</span>
          <input
            type="color"
            value={pulse.userSpeaking}
            onChange={(e) => {
              const next = { ...pulse, userSpeaking: e.target.value };
              setPulse(next);
              savePulseColors(next);
            }}
          />
        </label>
        <label className="agent-chat-pulse-color">
          <span>Butler thinking</span>
          <input
            type="color"
            value={pulse.thinking}
            onChange={(e) => {
              const next = { ...pulse, thinking: e.target.value };
              setPulse(next);
              savePulseColors(next);
            }}
          />
        </label>
        <button
          type="button"
          className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
          onClick={() => {
            const next = { ...DEFAULT_PULSE_COLORS };
            setPulse(next);
            savePulseColors(next);
          }}
        >
          Reset colors
        </button>
      </div>

      <label className="agent-chat-formality" htmlFor="chat-formality">
        <span className="agent-window-api-key-label">
          Tone — Casual ↔ Professional <em>({formalityLabel})</em>
        </span>
        <input
          id="chat-formality"
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(formality * 100)}
          onChange={(e) => {
            const next = Number(e.target.value) / 100;
            setFormality(next);
            saveChatFormality(next);
          }}
        />
        <span className="agent-chat-formality-ends" aria-hidden>
          <span>Casual</span>
          <span>Professional</span>
        </span>
      </label>
    </section>
  );
}

function cascadeStateLabel(state: string | undefined): string {
  switch (state) {
    case 'active':
      return 'Active';
    case 'ready':
      return 'Ready';
    case 'no_key':
      return 'No key';
    case 'skipped':
      return 'Skipped';
    case 'error':
      return 'Error';
    default:
      return state || '?';
  }
}

function CascadeStatusPanel({
  enabled,
  apiKeys,
}: {
  enabled: boolean;
  apiKeys: Record<string, string>;
}) {
  const [status, setStatus] = useState<CascadeStatusPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [probing, setProbing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setNote(null);
    try {
      const st = await fetchCascadeStatus({ provider: 'auto_free', apiKeys });
      setStatus(st);
      if (st.error) setNote(st.error);
    } catch (err) {
      setStatus({ ok: false, error: String((err as Error)?.message || err) });
    } finally {
      setLoading(false);
    }
  }, [apiKeys]);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  const probe = useCallback(async () => {
    setProbing(true);
    setNote(null);
    try {
      const st = await fetchCascadeStatus({ provider: 'auto_free', apiKeys, probe: true });
      setStatus(st);
      if (st.error) setNote(st.error);
      else if (st.active_provider) {
        setNote(`Live check → ${st.active_provider}${st.active_model ? ` (${st.active_model})` : ''}`);
      } else {
        setNote('Live check finished.');
      }
    } catch (err) {
      setNote(String((err as Error)?.message || err));
    } finally {
      setProbing(false);
    }
  }, [apiKeys]);

  if (!enabled) return null;

  const tiers = Array.isArray(status?.tiers) ? status.tiers : [];
  const activeLine =
    status?.source_label ||
    (status?.active_provider
      ? `${status.active_provider}${status.active_model ? ` · ${status.active_model}` : ''}`
      : null);
  const fallbacks = Array.isArray(status?.fallbacks_used) ? status.fallbacks_used : [];

  return (
    <div className="agent-cascade-status">
      <div className="agent-window-checkpoints-head">
        <p className="agent-settings-note" style={{ margin: 0 }}>
          Cascade tiers {loading && !status ? '· loading…' : ''}
          {activeLine ? (
            <>
              {' '}
              · last active: <code>{activeLine}</code>
            </>
          ) : null}
        </p>
        <div className="agent-cascade-status-actions">
          <button
            type="button"
            className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
            onClick={() => void load()}
            disabled={loading || probing}
          >
            Refresh
          </button>
          <button
            type="button"
            className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
            onClick={() => void probe()}
            disabled={loading || probing}
            title="Sends a tiny OK probe to each keyed provider (uses quota)"
          >
            {probing ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>
      {tiers.length ? (
        <ul className="agent-cascade-tier-list">
          {tiers.map((t) => {
            const state = t.state || 'unknown';
            const title = [t.reason, t.detail].filter(Boolean).join(' — ');
            return (
              <li key={t.id} className={`agent-cascade-tier agent-cascade-tier--${state}`}>
                <span className="agent-cascade-tier-rank">{t.rank ?? '·'}</span>
                <span className="agent-cascade-tier-label">
                  {t.label || t.id}
                  {t.model ? <code className="agent-cascade-tier-model">{t.model}</code> : null}
                </span>
                <span className={`agent-cascade-tier-badge agent-cascade-tier-badge--${state}`}>
                  {cascadeStateLabel(state)}
                </span>
                <span className="agent-cascade-tier-detail" title={title}>
                  {t.reason || t.detail || (t.has_key === false ? 'missing API key' : '')}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="agent-settings-note">No cascade status yet — send a message or tap Check now.</p>
      )}
      {fallbacks.length ? (
        <p className="agent-settings-note">
          Last skips: <code>{fallbacks.join(' → ')}</code>
        </p>
      ) : null}
      {note ? <p className="agent-settings-note">{note}</p> : null}
    </div>
  );
}

function AgentServicesStatus() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const TOGGLEABLE = new Set(['knowledge_api', 'local_llm', 'comfyui']);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: j } = await fetchButlerJsonWithResponse<StatusPayload>('/api/status');
      setData(j);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restartAll = useCallback(async () => {
    setRestarting(true);
    try {
      await fetch('/api/status/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'all' }),
      });
      window.setTimeout(() => void load(), 1500);
      window.setTimeout(() => void load(), 8000);
    } finally {
      setRestarting(false);
    }
  }, [load]);

  const toggleService = useCallback(
    async (s: StatusRow) => {
      if (!TOGGLEABLE.has(s.id) || s.skipped) return;
      const action = s.ok === true ? 'stop' : 'start';
      setTogglingId(s.id);
      try {
        await fetch('/api/status/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service: s.id, action }),
        });
        window.setTimeout(() => void load(), 1200);
        window.setTimeout(() => void load(), 5000);
      } finally {
        setTogglingId(null);
      }
    },
    [load],
  );

  return (
    <div className="agent-services-status">
      <ButlerMiniStatusStrip />
      <div className="agent-services-status-actions">
        <button type="button" className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          type="button"
          className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
          onClick={() => void restartAll()}
          disabled={loading || restarting}
        >
          {restarting ? 'Restarting…' : 'Restart all'}
        </button>
      </div>
      {data?.error ? <p className="agent-settings-note">{data.error}</p> : null}
      {data?.status_note ? <p className="agent-settings-note">{data.status_note}</p> : null}
      <p className="agent-settings-note">
        Click a service name or status badge to start it when down, or stop it when up.
      </p>
      <ul className="agent-services-list">
        {(data?.services ?? []).map((s) => {
          const label = s.skipped ? '—' : s.ok === true ? 'Up' : s.ok === false ? 'Down' : '?';
          const canToggle = TOGGLEABLE.has(s.id) && !s.skipped;
          const busy = togglingId === s.id;
          const actionTitle =
            !canToggle
              ? undefined
              : s.ok === true
                ? `Stop ${s.label}`
                : `Start ${s.label}`;
          return (
            <li key={s.id} className="agent-services-list-item">
              {canToggle ? (
                <button
                  type="button"
                  className="agent-services-list-name agent-services-list-toggle"
                  onClick={() => void toggleService(s)}
                  disabled={busy || loading || restarting}
                  title={actionTitle}
                >
                  {s.label}
                </button>
              ) : (
                <span className="agent-services-list-name">{s.label}</span>
              )}
              {canToggle ? (
                <button
                  type="button"
                  className={`agent-services-list-badge${
                    s.ok === true ? ' agent-services-list-badge--up' : s.ok === false ? ' agent-services-list-badge--down' : ''
                  }`}
                  onClick={() => void toggleService(s)}
                  disabled={busy || loading || restarting}
                  title={actionTitle}
                >
                  {busy ? '…' : label}
                </button>
              ) : (
                <span
                  className={`agent-services-list-badge${
                    s.ok === true ? ' agent-services-list-badge--up' : s.ok === false ? ' agent-services-list-badge--down' : ''
                  }`}
                >
                  {label}
                </span>
              )}
              <span className="agent-services-list-detail" title={s.url || s.detail || ''}>
                {s.detail || s.url || ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type ButlerLiteStatus = {
  ok?: boolean;
  ready?: boolean;
  api_ok?: boolean;
  proxy_ok?: boolean;
  starting?: boolean;
  process_running?: boolean;
  watchdog_running?: boolean;
  provider?: string | null;
  tunnel_url?: string | null;
  page_url?: string;
  message?: string;
  reused?: boolean;
  opened_browser?: boolean;
};

function ButlerLiteLaunch() {
  const [status, setStatus] = useState<ButlerLiteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/butler/lite-status');
      const data = (await res.json().catch(() => ({}))) as ButlerLiteStatus;
      setStatus(data);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const launch = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNote('Starting Tailscale Funnel + lite watchdog…');
    try {
      const res = await fetch('/api/butler/lite-launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openBrowser: true }),
      });
      const data = (await res.json().catch(() => ({}))) as ButlerLiteStatus;
      setStatus(data);
      setNote(
        data.message ||
          (data.ok
            ? data.ready
              ? 'Butler Lite Tailscale Funnel ready.'
              : 'Funnel starting…'
            : 'Butler Lite launch failed.'),
      );
    } catch (err) {
      setNote(`Launch failed: ${String((err as Error)?.message || err)}`);
    } finally {
      setBusy(false);
      window.setTimeout(() => void load(), 1200);
    }
  }, [busy, load]);

  const openPage = useCallback(async () => {
    const url = status?.page_url || 'https://butler-lite-a9b35.web.app';
    try {
      if (window.butlerElectron?.openExternalUrl) {
        await window.butlerElectron.openExternalUrl(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, [status?.page_url]);

  const stateLabel = busy
    ? 'Starting…'
    : status?.ready
      ? 'Ready'
      : status?.starting
        ? 'Starting…'
        : status?.api_ok === false
          ? 'API down'
          : 'Idle';

  return (
    <div className="agent-services-status">
      <p className="agent-settings-note" style={{ marginTop: 0 }}>
        Phone chat + Talk at{' '}
        <code>https://butler-lite-a9b35.web.app</code> — starts Tailscale Funnel + lite-proxy +
        watchdog (<code>npm run lite:watchdog</code>) if needed so chat, STT, and TTS share one HTTPS
        API, then opens the page. Repeat clicks reuse a healthy Funnel.
      </p>
      <div className="agent-services-status-actions">
        <button
          type="button"
          className="agent-window-btn agent-window-btn--sm"
          onClick={() => void launch()}
          disabled={busy}
          title="Ensure API, start Tailscale Funnel + lite:watchdog if needed, open Butler Lite"
        >
          {busy ? 'Starting…' : 'Launch Butler Lite'}
        </button>
        <button
          type="button"
          className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
          onClick={() => void openPage()}
          disabled={busy}
        >
          Open page
        </button>
        <button
          type="button"
          className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
          onClick={() => void load()}
          disabled={busy}
        >
          Refresh
        </button>
        <span
          className={`agent-services-list-badge${
            status?.ready ? ' agent-services-list-badge--up' : ' agent-services-list-badge--down'
          }`}
        >
          {stateLabel}
        </span>
      </div>
      {note ? <p className="agent-settings-note">{note}</p> : null}
      {status?.tunnel_url ? (
        <p className="agent-settings-note" title={status.tunnel_url}>
          Funnel: <code>{status.tunnel_url}</code>
          {status.provider ? <> ({status.provider})</> : null}
          {status.watchdog_running ? ' · watchdog on' : null}
        </p>
      ) : status?.proxy_ok ? (
        <p className="agent-settings-note">Proxy up on :4012 — waiting for Tailscale Funnel URL…</p>
      ) : null}
    </div>
  );
}

export type AgentSettingsPanelProps = {
  open: boolean;
  onClose: () => void;
  cwd: string;
  onCwdChange: (cwd: string) => void;
  onBrowseWorkspace: () => void;
  onOpenExplorer: () => void;
  scanSummary: string | null;
  cascadeEnabled: boolean;
  onCascadeChange: (on: boolean) => void;
  agentProvider: AgentProviderId;
  onProviderChange: (id: AgentProviderId) => void;
  apiKeys: Record<string, string>;
  onApiKeyChange: (providerId: string, value: string) => void;
  envVarRows: AgentEnvVarRow[];
  onEnvVarRowsChange: (rows: AgentEnvVarRow[]) => void;
  checkpoints: AgentCheckpoint[];
  checkpointBusy: boolean;
  sending: boolean;
  onManualCheckpoint: () => void;
  onRevertCheckpoint: (id: string) => void;
  onRevertLastCheckpoint?: () => void;
  onRebuildDesktop?: () => void;
  rebuildBusy?: boolean;
  onRefreshApp?: () => void;
  refreshBusy?: boolean;
  onPushToStable?: () => void;
  pushStableBusy?: boolean;
  theme: AgentThemePrefs;
  onThemeChange: (prefs: AgentThemePrefs) => void;
  productMode?: AgentSettingsProductMode;
  onProductModeChange?: (mode: AgentSettingsProductMode) => void;
  /** Pre-check "Override tests" on Reviews when tests are missing. */
  acceptWithoutTests?: boolean;
  onAcceptWithoutTestsChange?: (on: boolean) => void;
  screenLookMode?: boolean;
  onScreenLookModeChange?: (on: boolean) => void;
};

export function AgentSettingsPanel({
  open,
  onClose,
  cwd,
  onCwdChange,
  onBrowseWorkspace,
  onOpenExplorer,
  scanSummary,
  cascadeEnabled,
  onCascadeChange,
  agentProvider,
  onProviderChange,
  apiKeys,
  onApiKeyChange,
  envVarRows,
  onEnvVarRowsChange,
  checkpoints,
  checkpointBusy,
  sending,
  onManualCheckpoint,
  onRevertCheckpoint,
  onRevertLastCheckpoint,
  onRebuildDesktop,
  rebuildBusy = false,
  onRefreshApp,
  refreshBusy = false,
  onPushToStable,
  pushStableBusy = false,
  theme,
  onThemeChange,
  productMode = 'code',
  onProductModeChange,
  acceptWithoutTests = false,
  onAcceptWithoutTestsChange,
  screenLookMode = false,
  onScreenLookModeChange,
}: AgentSettingsPanelProps) {
  const selfEditOn = productMode === 'self-edit';
  const [showEnvValues, setShowEnvValues] = useState(false);

  const updateEnvRow = useCallback(
    (id: string, patch: Partial<Pick<AgentEnvVarRow, 'key' | 'value'>>) => {
      onEnvVarRowsChange(envVarRows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [envVarRows, onEnvVarRowsChange],
  );

  const removeEnvRow = useCallback(
    (id: string) => {
      onEnvVarRowsChange(envVarRows.filter((r) => r.id !== id));
    },
    [envVarRows, onEnvVarRowsChange],
  );

  const addEnvRow = useCallback(() => {
    onEnvVarRowsChange([
      ...envVarRows,
      {
        id: `env-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        key: '',
        value: '',
      },
    ]);
  }, [envVarRows, onEnvVarRowsChange]);

  const envHints = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of envVarRows) {
      const hint = hintForEnvKey(row.key);
      if (hint) map.set(row.id, hint);
    }
    return map;
  }, [envVarRows]);

  if (!open) return null;

  return (
    <div className="agent-settings-overlay" role="presentation" onClick={onClose}>
      <div
        className="agent-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="agent-settings-head">
          <h2 id="agent-settings-title" className="agent-settings-title">
            Settings
          </h2>
          <button type="button" className="agent-window-btn agent-window-btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="agent-settings-body">
          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">Services status</h3>
            <p className="agent-settings-note">
              Knowledge, local LLM, ComfyUI, and related probes. Use Restart when chat or images fail to connect.
            </p>
            <AgentServicesStatus />
          </section>

          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">Butler Lite</h3>
            <ButlerLiteLaunch />
          </section>

          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">Appearance</h3>
            <p className="agent-settings-note">Theme and accent persist in localStorage for this machine.</p>
            <div className="agent-theme-picker" role="group" aria-label="Theme mode">
              {AGENT_THEME_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`agent-theme-swatch agent-theme-swatch--${m.id}${
                    theme.mode === m.id ? ' agent-theme-swatch--active' : ''
                  }`}
                  onClick={() => onThemeChange({ ...theme, mode: m.id as AgentThemeMode })}
                  title={m.hint}
                >
                  <span className="agent-theme-swatch-preview" aria-hidden />
                  <span>{m.label}</span>
                </button>
              ))}
            </div>
            <div className="agent-accent-picker" role="group" aria-label="Accent color">
              {AGENT_ACCENTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`agent-accent-chip agent-accent-chip--${a.id}${
                    theme.accent === a.id ? ' agent-accent-chip--active' : ''
                  }`}
                  onClick={() => onThemeChange({ ...theme, accent: a.id as AgentAccent })}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </section>

          <ChatModeSettingsSection open={open} />

          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">Workspace</h3>
            <p className="agent-window-scan-hint">
              Day-to-day project switching lives in the left sidebar workspace tree. Use this path
              field for advanced edits, Explorer, or when the sidebar is collapsed.
            </p>
            <div className="agent-window-workspace-row">
              <input
                className="agent-window-cwd-input"
                type="text"
                value={cwd}
                onChange={(e) => onCwdChange(e.target.value)}
                placeholder="D:\butlor\projects"
                spellCheck={false}
                aria-label="Workspace path"
              />
              <button type="button" className="agent-window-btn" onClick={onBrowseWorkspace} disabled={sending}>
                Browse…
              </button>
              <button
                type="button"
                className="agent-window-btn agent-window-btn--ghost"
                onClick={onOpenExplorer}
                disabled={!cwd.trim()}
              >
                Explorer
              </button>
            </div>
            <p className="agent-window-scan-hint">
              Point at your app folder for normal work. Use the{' '}
              <strong>Self-edit</strong> mode tab (or Product Mode below) when you want Butler to
              change his own checkout — that sets the workspace to the Butler repo, enables writes,
              and turns on Accept/Reject + tests gate. Checkpoint first.
            </p>
            <label className="agent-settings-toggle">
              <input
                type="checkbox"
                checked={selfEditOn}
                onChange={(e) => {
                  onProductModeChange?.(e.target.checked ? 'self-edit' : 'code');
                }}
                disabled={sending || !onProductModeChange}
              />
              <span>
                <strong>Self-edit mode</strong>
                <span className="agent-settings-toggle-hint">
                  Workspace → Butler repo, <code>BUTLER_ALLOW_SELF_EDIT=1</code>, careful
                  self-modification prompt, MR Accept/Reject after writes. Leaving restores your
                  previous project folder.
                </span>
              </span>
            </label>
            {selfEditOn ? (
              <div className="agent-settings-codebase-index">
                <p className="agent-settings-note agent-settings-note--warn">
                  Self-edit is ON. Checkpoint before big changes. Accept normally needs tests; you
                  can override per review or enable the toggle below. Butler keeps a durable
                  codebase map so he does not rescan the whole tree each ask.
                </p>
                <label className="agent-settings-toggle">
                  <input
                    type="checkbox"
                    checked={acceptWithoutTests}
                    onChange={(e) => onAcceptWithoutTestsChange?.(e.target.checked)}
                    disabled={sending || !onAcceptWithoutTestsChange}
                  />
                  <span>
                    <strong>Allow accepting self-edit without tests</strong>
                    <span className="agent-settings-toggle-hint">
                      Pre-checks <em>Override tests</em> on the Reviews banner. Accept still asks
                      for confirmation when skipping the tests gate.
                    </span>
                  </span>
                </label>
                <SelfEditCodebaseIndexControls cwd={cwd} />
              </div>
            ) : null}
            {scanSummary ? <p className="agent-window-scan-hint">{scanSummary}</p> : null}
          </section>

          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">Model</h3>
            <label className="agent-settings-toggle">
              <input
                type="checkbox"
                checked={cascadeEnabled}
                onChange={(e) => onCascadeChange(e.target.checked)}
                disabled={sending}
              />
              <span>
                <strong>Auto free-tier cascade</strong>
                <span className="agent-settings-toggle-hint">
                  Burn through Gemini → Groq → OpenRouter → Mistral → Cohere using available keys;
                  final fallback is local Ollama (<code>LOCAL_AGENT_MODEL</code>).
                </span>
              </span>
            </label>

            <div className="agent-window-model-row">
              <label className="agent-window-cwd-label" htmlFor="agent-settings-model">
                Provider
              </label>
              <select
                id="agent-settings-model"
                className="agent-window-model-select"
                value={cascadeEnabled ? 'auto_free' : agentProvider === 'auto_free' ? 'local' : agentProvider}
                onChange={(e) => {
                  const next = e.target.value as AgentProviderId;
                  if (next === 'auto_free') onCascadeChange(true);
                  else {
                    onCascadeChange(false);
                    onProviderChange(next);
                  }
                }}
                disabled={sending || cascadeEnabled}
                title={
                  cascadeEnabled
                    ? 'Cascade is on — disable the toggle to pin a single provider'
                    : 'Pin a single provider (regular Butler chat is unchanged)'
                }
              >
                {AGENT_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="agent-settings-note">
              Keys can also live in <code>.env</code> (<code>GEMINI_API_KEY</code>, <code>GROQ_API_KEY</code>,
              etc.). Browser keys stay local to this machine.
            </p>
            <CascadeStatusPanel enabled={cascadeEnabled} apiKeys={apiKeys} />
          </section>

          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">API keys</h3>
            <div className="agent-window-api-keys">
              {AGENT_PROVIDERS.filter((p) => providerNeedsApiKey(p.id)).map((p) => (
                <label key={p.id} className="agent-window-api-key-field">
                  <span className="agent-window-api-key-label">
                    {p.label}
                    {p.envKey ? (
                      <>
                        {' '}
                        <code className="agent-window-api-key-env">{p.envKey}</code>
                      </>
                    ) : null}
                  </span>
                  <input
                    type="password"
                    className="agent-window-api-key-input"
                    value={apiKeys[p.id] || ''}
                    onChange={(e) => onApiKeyChange(p.id, e.target.value)}
                    placeholder={p.hint}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              ))}
            </div>
          </section>

          <section className="agent-settings-section">
            <div className="agent-window-checkpoints-head">
              <h3 className="agent-settings-section-title">Environment variables</h3>
              <button
                type="button"
                className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                onClick={() => setShowEnvValues((v) => !v)}
              >
                {showEnvValues ? 'Hide values' : 'Show values'}
              </button>
            </div>
            <p className="agent-settings-note">
              Plaintext on this machine only (browser localStorage + Butlor{' '}
              <code>agent-env.json</code>). No encryption. Used by MCP (e.g.{' '}
              <code>CONTEXT7_API_KEY</code>) and the local agent runtime — no need to edit{' '}
              <code>.env</code>. Reconnect MCP after changing keys.
            </p>
            <div className="agent-env-vars" role="list">
              {envVarRows.map((row) => (
                <div key={row.id} className="agent-env-var-row" role="listitem">
                  <input
                    className="agent-env-var-key"
                    type="text"
                    value={row.key}
                    onChange={(e) => updateEnvRow(row.id, { key: e.target.value })}
                    placeholder="KEY_NAME"
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="Environment variable name"
                  />
                  <input
                    className="agent-env-var-value"
                    type={showEnvValues ? 'text' : 'password'}
                    value={row.value}
                    onChange={(e) => updateEnvRow(row.id, { value: e.target.value })}
                    placeholder={envHints.get(row.id) || 'value'}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label={`Value for ${row.key || 'environment variable'}`}
                  />
                  <button
                    type="button"
                    className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                    onClick={() => removeEnvRow(row.id)}
                    title="Remove"
                    aria-label={`Remove ${row.key || 'row'}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="agent-window-btn agent-window-btn--ghost" onClick={addEnvRow}>
              Add variable
            </button>
          </section>

          <section className="agent-settings-section">
            <div className="agent-window-checkpoints-head">
              <h3 className="agent-settings-section-title">Checkpoints</h3>
              <div className="agent-settings-checkpoint-actions">
                <button
                  type="button"
                  className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                  onClick={onManualCheckpoint}
                  disabled={sending || checkpointBusy}
                >
                  Save checkpoint
                </button>
                {onRevertLastCheckpoint ? (
                  <button
                    type="button"
                    className="agent-window-btn agent-window-btn--sm"
                    onClick={onRevertLastCheckpoint}
                    disabled={sending || checkpointBusy || checkpoints.length === 0}
                    title="Restore the newest checkpoint"
                  >
                    Revert last
                  </button>
                ) : null}
              </div>
            </div>
            {checkpoints.length === 0 ? (
              <p className="agent-window-checkpoints-empty">
                Auto-checkpoints run before edits; manual saves appear here.
              </p>
            ) : (
              <ul className="agent-window-checkpoints-list">
                {checkpoints.slice(0, 10).map((cp) => (
                  <li key={cp.id}>
                    <span className="agent-window-cp-label" title={cp.reason}>
                      {cp.id}
                      {cp.file_count ? ` (${cp.file_count} files)` : ''}
                    </span>
                    <button
                      type="button"
                      className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                      onClick={() => onRevertCheckpoint(cp.id)}
                      disabled={sending || checkpointBusy}
                    >
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">App reload</h3>
            <p className="agent-settings-note">
              <strong>Refresh app</strong> reloads this window (UI + cached assets) — use after small
              source changes when you do not need a new asar. <strong>Rebuild desktop</strong> runs
              vite + patches <code>dist-desktop</code>; quit the packaged exe before the asar rewrite
              finishes. <strong>Push to stable</strong> copies the current <code>dist-desktop</code>{' '}
              tree to the <code>dist-desktop-stable</code> spare (and updates Butler (Stable).lnk) —
              it does not rebuild. Full installer rebuilds still use <code>npm run desktop</code>.
            </p>
            <div className="agent-settings-checkpoint-actions">
              <button
                type="button"
                className="agent-window-btn agent-window-btn--sm"
                onClick={() => onRefreshApp?.()}
                disabled={!onRefreshApp || refreshBusy || rebuildBusy || pushStableBusy}
                title="Reload the Agent window without rebuilding asar"
              >
                {refreshBusy ? 'Refreshing…' : 'Refresh app'}
              </button>
              <button
                type="button"
                className="agent-window-btn agent-window-btn--sm"
                onClick={() => onRebuildDesktop?.()}
                disabled={!onRebuildDesktop || rebuildBusy || pushStableBusy}
                title="vite build + patch dist-desktop app.asar (quit packaged app first)"
              >
                {rebuildBusy ? 'Rebuild…' : 'Rebuild desktop'}
              </button>
              <button
                type="button"
                className="agent-window-btn agent-window-btn--sm"
                onClick={() => onPushToStable?.()}
                disabled={!onPushToStable || pushStableBusy || rebuildBusy}
                title="Copy current dist-desktop → dist-desktop-stable spare (not a rebuild)"
              >
                {pushStableBusy ? 'Pushing…' : 'Push to stable'}
              </button>
            </div>
          </section>

          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">Product Mode</h3>
            <div className="agent-settings-row">
              <label className="agent-settings-label">
                <input
                  type="radio"
                  name="productMode"
                  checked={productMode === 'chat'}
                  onChange={() => onProductModeChange?.('chat')}
                />
                Chat
              </label>
              <label className="agent-settings-label">
                <input
                  type="radio"
                  name="productMode"
                  checked={productMode === 'code'}
                  onChange={() => onProductModeChange?.('code')}
                />
                Code (voice-friendly coding)
              </label>
              <label className="agent-settings-label">
                <input
                  type="radio"
                  name="productMode"
                  checked={productMode === 'self-edit'}
                  onChange={() => onProductModeChange?.('self-edit')}
                />
                Self-edit (Butler repo)
              </label>
            </div>
          </section>
          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">Screen assist</h3>
            <p className="agent-settings-note">
              Use Share in the composer so Butler can see your screen on every chat or voice turn.
              Capture stays invisible and low-res; vision only runs when you send a message.
            </p>
            <label className="agent-settings-toggle">
              <input
                type="checkbox"
                checked={
                  typeof screenLookMode === 'boolean'
                    ? screenLookMode
                    : getScreenLookModeEnabled()
                }
                onChange={(e) => {
                  const on = e.target.checked;
                  setScreenLookModeEnabled(on);
                  onScreenLookModeChange?.(on);
                }}
                disabled={sending}
              />
              <span>
                <strong>Idle glance (optional)</strong>
                <span className="agent-settings-toggle-hint">
                  Default off. When on, at most one quiet vision glance every ~6s while sharing and
                  idle — not needed for normal Ableton / screen help.
                </span>
              </span>
            </label>
          </section>
          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">GPU / VRAM</h3>
            <p className="agent-settings-note">
              System-wide VRAM consumers — click rows to select, then Free Selected (protected OS processes blocked).
            </p>
            <VramSettingsPanel />
          </section>
          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">Spotify SEO</h3>
            <SpotifySeoPanel />
          </section>
        </div>
      </div>
    </div>
  );
}