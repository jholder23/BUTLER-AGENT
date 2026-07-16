import { useCallback, useEffect, useState } from 'react';
import {
  connectAgentMcpServers,
  deleteAgentMcpServer,
  ensureDefaultMcpServers,
  fetchAgentMcpStatus,
  listAgentMcpServers,
  saveAgentMcpServer,
  setAgentMcpServerEnabled,
  type AgentMcpServerConfig,
  type AgentMcpTransport,
} from '../lib/agentMcp';

export type AgentMcpPanelProps = {
  open: boolean;
  onClose: () => void;
  onServersChanged?: (servers: AgentMcpServerConfig[]) => void;
};

const EMPTY_FORM = {
  name: '',
  transport: 'stdio' as AgentMcpTransport,
  commandOrUrl: '',
  args: '',
  enabled: true,
};

function statusLabel(status: AgentMcpServerConfig['status']): string {
  switch (status) {
    case 'coming_online':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'error':
      return 'Error';
    case 'needs_key':
      return 'Needs API key';
    default:
      return 'Idle';
  }
}

export function AgentMcpPanel({ open, onClose, onServersChanged }: AgentMcpPanelProps) {
  const [servers, setServers] = useState<AgentMcpServerConfig[]>(() => listAgentMcpServers());
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toolCount, setToolCount] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const seeded = await ensureDefaultMcpServers();
      if (cancelled) return;
      setServers(seeded.length ? seeded : listAgentMcpServers());
      setBanner(null);
      const st = await fetchAgentMcpStatus();
      if (cancelled) return;
      setServers(st.servers);
      setToolCount(st.tools.length);
      onServersChanged?.(st.servers);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, onServersChanged]);

  const refresh = useCallback(
    (next: AgentMcpServerConfig[]) => {
      setServers(next);
      onServersChanged?.(next);
    },
    [onServersChanged],
  );

  const handleSave = useCallback(() => {
    if (!form.name.trim() || !form.commandOrUrl.trim()) {
      setBanner('Name and command/URL are required.');
      return;
    }
    saveAgentMcpServer({
      id: editingId || undefined,
      name: form.name,
      transport: form.transport,
      commandOrUrl: form.commandOrUrl,
      args: form.args,
      enabled: form.enabled,
    });
    refresh(listAgentMcpServers());
    setForm(EMPTY_FORM);
    setEditingId(null);
    setBanner('Server saved. Click Connect enabled to start the MCP runtime.');
  }, [editingId, form, refresh]);

  const handleEdit = useCallback((server: AgentMcpServerConfig) => {
    setEditingId(server.id);
    setForm({
      name: server.name,
      transport: server.transport,
      commandOrUrl: server.commandOrUrl,
      args: server.args,
      enabled: server.enabled,
    });
    setBanner(null);
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      if (!window.confirm('Remove this MCP server from the list?')) return;
      deleteAgentMcpServer(id);
      refresh(listAgentMcpServers());
      if (editingId === id) {
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
    },
    [editingId, refresh],
  );

  const handleToggle = useCallback(
    (id: string, enabled: boolean) => {
      setAgentMcpServerEnabled(id, enabled);
      refresh(listAgentMcpServers());
    },
    [refresh],
  );

  const handleConnect = useCallback(async () => {
    setBusy(true);
    setBanner(null);
    try {
      const result = await connectAgentMcpServers();
      refresh(result.servers);
      setToolCount(result.tools?.length || 0);
      const extra =
        result.tools && result.tools.length
          ? ` ${result.tools.length} tool(s) available to the agent via mcp_list / mcp_call.`
          : '';
      setBanner((result.message || '') + extra);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (!open) return null;

  return (
    <div className="agent-settings-overlay" role="presentation" onClick={onClose}>
      <div
        className="agent-settings-panel agent-mcp-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-mcp-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="agent-settings-head">
          <div>
            <h2 id="agent-mcp-title" className="agent-settings-title">
              MCP servers
            </h2>
            <p className="agent-mcp-lede">
              Knowledge/docs MCP servers for Butler Agent (Context7 docs, Memory graph). Connect starts the
              ui-server runtime; the agent calls tools with mcp_list / mcp_call.
              {toolCount > 0 ? ` ${toolCount} live tool(s).` : ''}
            </p>
          </div>
          <button type="button" className="agent-window-btn agent-window-btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="agent-settings-body">
          {banner ? <p className="agent-mcp-banner">{banner}</p> : null}

          <section className="agent-settings-section">
            <div className="agent-window-checkpoints-head">
              <h3 className="agent-settings-section-title">Saved servers</h3>
              <button
                type="button"
                className="agent-window-btn agent-window-btn--sm"
                onClick={() => void handleConnect()}
                disabled={busy || servers.filter((s) => s.enabled).length === 0}
              >
                {busy ? 'Connecting…' : 'Connect enabled'}
              </button>
            </div>
            {servers.length === 0 ? (
              <p className="agent-window-checkpoints-empty">No MCP servers yet. Add one below.</p>
            ) : (
              <ul className="agent-mcp-list">
                {servers.map((s) => (
                  <li key={s.id} className="agent-mcp-row">
                    <label className="agent-mcp-enable">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        onChange={(e) => handleToggle(s.id, e.target.checked)}
                      />
                      <span className="agent-mcp-row-main">
                        <strong>{s.name}</strong>
                        <span className="agent-mcp-meta">
                          {s.transport} · {s.commandOrUrl}
                          {s.args ? ` ${s.args}` : ''}
                        </span>
                        {s.description ? <span className="agent-mcp-meta">{s.description}</span> : null}
                        {s.lastError ? (
                          <span className="agent-mcp-meta agent-mcp-status--error">{s.lastError}</span>
                        ) : null}
                        <span className={`agent-mcp-status agent-mcp-status--${s.status}`}>
                          {statusLabel(s.status)}
                        </span>
                      </span>
                    </label>
                    <div className="agent-mcp-row-actions">
                      <button
                        type="button"
                        className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                        onClick={() => handleEdit(s)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm agent-window-btn--danger"
                        onClick={() => handleDelete(s.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="agent-settings-section">
            <h3 className="agent-settings-section-title">{editingId ? 'Edit server' : 'Add server'}</h3>
            <div className="agent-mcp-form">
              <label className="agent-window-api-key-field">
                <span className="agent-window-api-key-label">Name</span>
                <input
                  className="agent-window-api-key-input"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="context7"
                  spellCheck={false}
                />
              </label>
              <label className="agent-window-api-key-field">
                <span className="agent-window-api-key-label">Transport</span>
                <select
                  className="agent-window-model-select"
                  value={form.transport}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, transport: e.target.value as AgentMcpTransport }))
                  }
                >
                  <option value="stdio">stdio</option>
                  <option value="sse">SSE</option>
                  <option value="http">HTTP</option>
                </select>
              </label>
              <label className="agent-window-api-key-field">
                <span className="agent-window-api-key-label">
                  {form.transport === 'stdio' ? 'Command' : 'URL'}
                </span>
                <input
                  className="agent-window-api-key-input"
                  value={form.commandOrUrl}
                  onChange={(e) => setForm((f) => ({ ...f, commandOrUrl: e.target.value }))}
                  placeholder={form.transport === 'stdio' ? 'npx' : 'https://…'}
                  spellCheck={false}
                />
              </label>
              {form.transport === 'stdio' ? (
                <label className="agent-window-api-key-field">
                  <span className="agent-window-api-key-label">Args</span>
                  <input
                    className="agent-window-api-key-input"
                    value={form.args}
                    onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                    placeholder="-y @modelcontextprotocol/server-memory"
                    spellCheck={false}
                  />
                </label>
              ) : null}
              <label className="agent-settings-toggle">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                />
                <span>Enabled</span>
              </label>
              <div className="agent-mcp-form-actions">
                {editingId ? (
                  <button
                    type="button"
                    className="agent-window-btn agent-window-btn--ghost"
                    onClick={() => {
                      setEditingId(null);
                      setForm(EMPTY_FORM);
                    }}
                  >
                    Cancel edit
                  </button>
                ) : null}
                <button type="button" className="agent-window-btn" onClick={handleSave}>
                  {editingId ? 'Update server' : 'Add server'}
                </button>
              </div>
            </div>
            <p className="agent-settings-note">
              Keys live in Agent Settings → <strong>Environment variables</strong> (e.g.{' '}
              <code>CONTEXT7_API_KEY</code>) or repo <code>.env</code>. Reconnect after changing keys. Skip
              Slack/Notion-style social MCPs — prefer docs/memory. Context7: free tier with a dashboard API
              key; usage beyond plan limits is billed.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
