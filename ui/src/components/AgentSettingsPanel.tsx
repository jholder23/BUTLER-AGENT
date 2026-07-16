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

function AgentServicesStatus() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);

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
      <ul className="agent-services-list">
        {(data?.services ?? []).map((s) => {
          const label = s.skipped ? '—' : s.ok === true ? 'Up' : s.ok === false ? 'Down' : '?';
          return (
            <li key={s.id} className="agent-services-list-item">
              <span className="agent-services-list-name">{s.label}</span>
              <span
                className={`agent-services-list-badge${
                  s.ok === true ? ' agent-services-list-badge--up' : s.ok === false ? ' agent-services-list-badge--down' : ''
                }`}
              >
                {label}
              </span>
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
  theme: AgentThemePrefs;
  onThemeChange: (prefs: AgentThemePrefs) => void;
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
  theme,
  onThemeChange,
}: AgentSettingsPanelProps) {
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

          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">Workspace</h3>
            <div className="agent-window-workspace-row">
              <input
                className="agent-window-cwd-input"
                type="text"
                value={cwd}
                onChange={(e) => onCwdChange(e.target.value)}
                placeholder="D:\BUTLER"
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
              <button
                type="button"
                className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                onClick={onManualCheckpoint}
                disabled={sending || checkpointBusy}
              >
                Save checkpoint
              </button>
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
        </div>
      </div>
    </div>
  );
}
