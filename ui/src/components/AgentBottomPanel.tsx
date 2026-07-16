import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { AgentBrowserPanel } from './AgentBrowserPanel';
import type { AgentTerminalResult } from '../lib/agentTypes';

export type AgentFooterTab = 'terminal' | 'output' | 'browser';

export type TerminalEntry = {
  id: string;
  command: string;
  cwd: string;
  result?: AgentTerminalResult;
  running?: boolean;
};

export type AgentBottomPanelProps = {
  open: boolean;
  heightPx: number;
  tab: AgentFooterTab;
  browserMaximized?: boolean;
  onTabChange: (tab: AgentFooterTab) => void;
  onToggleOpen: () => void;
  onToggleBrowserMaximized: () => void;
  onResizeStart: (e: ReactMouseEvent) => void;
  onResetHeight: () => void;
  cwd: string;
  terminalShellLabel?: string;
  terminalStatusText: string;
  terminalCommand: string;
  onTerminalCommandChange: (value: string) => void;
  onRunTerminal: () => void;
  onClearTerminal: () => void;
  onResetTerminal?: () => void;
  terminalBusy: boolean;
  terminalEntries: TerminalEntry[];
  liveLog: string[];
};

export function AgentBottomPanel({
  open,
  heightPx,
  tab,
  browserMaximized = false,
  onTabChange,
  onToggleOpen,
  onToggleBrowserMaximized,
  onResizeStart,
  onResetHeight,
  cwd,
  terminalShellLabel = 'PowerShell',
  terminalStatusText,
  terminalCommand,
  onTerminalCommandChange,
  onRunTerminal,
  onClearTerminal,
  onResetTerminal,
  terminalBusy,
  terminalEntries,
  liveLog,
}: AgentBottomPanelProps) {
  const terminalLogRef = useRef<HTMLDivElement>(null);
  const stickTerminalRef = useRef(true);

  const openTab = (next: AgentFooterTab) => {
    onTabChange(next);
  };

  // Chronological session history (oldest → newest)
  const chronologicalEntries = [...terminalEntries].reverse();

  useEffect(() => {
    const el = terminalLogRef.current;
    if (!el || !stickTerminalRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [terminalEntries, terminalBusy]);

  return (
    <div
      className={`agent-bottom${open ? ' agent-bottom--open' : ''}${
        open && tab === 'browser' ? ' agent-bottom--browser' : ''
      }${open && tab === 'terminal' ? ' agent-bottom--terminal' : ''}${
        browserMaximized ? ' agent-bottom--browser-maximized' : ''
      }${browserMaximized ? ' agent-bottom--open' : ''}`}
      style={open && !browserMaximized ? { height: heightPx } : undefined}
    >
      {open && !browserMaximized ? (
        <div
          className="agent-window-resize-handle agent-window-resize-handle--horizontal"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize bottom panel"
          title="Drag to resize. Double-click to reset."
          onMouseDown={onResizeStart}
          onDoubleClick={onResetHeight}
        />
      ) : null}

      <div className="agent-bottom-bar" hidden={browserMaximized}>
        <div className="agent-bottom-tabs" role="tablist" aria-label="Bottom panel">
          {(
            [
              ['terminal', 'Terminal'],
              ['output', 'Output'],
              ['browser', 'Browser'],
            ] as Array<[AgentFooterTab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id && open}
              className={`agent-bottom-tab${tab === id && open ? ' agent-bottom-tab--active' : ''}`}
              onClick={() => {
                if (tab === id && open) onToggleOpen();
                else openTab(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="agent-icon-btn"
          onClick={onToggleOpen}
          aria-expanded={open}
          title={open ? 'Collapse panel' : 'Expand panel'}
          aria-label={open ? 'Collapse bottom panel' : 'Expand bottom panel'}
        >
          {open ? '▾' : '▴'}
        </button>
      </div>

      {open ? (
        <div className="agent-bottom-panel">
          {tab === 'browser' ? (
            <div className="agent-window-footer-section agent-window-footer-section--browser">
              <AgentBrowserPanel
                maximized={browserMaximized}
                onToggleMaximized={onToggleBrowserMaximized}
              />
            </div>
          ) : null}

          {tab === 'output' ? (
            <div className="agent-window-footer-section agent-bottom-output">
              {liveLog.length === 0 ? (
                <p className="agent-window-terminal-empty">Agent activity will stream here while a run is in progress.</p>
              ) : (
                <div className="agent-bottom-output-log" role="log" aria-live="polite">
                  {liveLog.map((entry, i) => (
                    <div key={`${i}-${entry.slice(0, 12)}`} className="agent-bottom-output-line">
                      {entry}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {tab === 'terminal' ? (
            <div className="agent-window-footer-section agent-window-footer-section--terminal">
              <div className="agent-window-terminal-toolbar">
                <span className="agent-window-terminal-shell" title={terminalShellLabel}>
                  {terminalShellLabel}
                </span>
                <span className="agent-window-terminal-path" title={cwd}>
                  {cwd}
                </span>
                <span className="agent-window-terminal-status">{terminalStatusText}</span>
                <div className="agent-window-terminal-toolbar-actions">
                  {onResetTerminal ? (
                    <button
                      type="button"
                      className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                      onClick={onResetTerminal}
                      disabled={terminalBusy}
                      title="Restart PowerShell session"
                    >
                      Restart
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
                    onClick={onClearTerminal}
                    disabled={terminalBusy || terminalEntries.length === 0}
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div
                ref={terminalLogRef}
                className="agent-window-terminal-session"
                role="log"
                aria-live="polite"
                onScroll={() => {
                  const el = terminalLogRef.current;
                  if (!el) return;
                  const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
                  stickTerminalRef.current = dist < 64;
                }}
              >
                {chronologicalEntries.length === 0 ? (
                  <p className="agent-window-terminal-empty">
                    Persistent {terminalShellLabel} session — <code>cd</code> sticks, env is kept across
                    commands. Type below and press Enter.
                  </p>
                ) : (
                  chronologicalEntries.map((entry) => {
                    const result = entry.result;
                    return (
                      <div
                        key={entry.id}
                        className={`agent-window-terminal-entry${
                          result?.ok === false ? ' agent-window-terminal-entry--error' : ''
                        }`}
                      >
                        <div className="agent-window-terminal-entry-head">
                          <code>
                            PS {entry.cwd}&gt; {entry.command}
                          </code>
                          <span>
                            {entry.running
                              ? 'running'
                              : result?.code != null
                                ? `exit ${result.code}`
                                : result?.ok
                                  ? 'ok'
                                  : 'error'}
                          </span>
                        </div>
                        {result?.stdout ? <pre className="agent-window-terminal-pre">{result.stdout}</pre> : null}
                        {result?.stderr ? (
                          <pre className="agent-window-terminal-pre agent-window-terminal-pre--stderr">
                            {result.stderr}
                          </pre>
                        ) : null}
                        {result?.message && !result.stdout && !result.stderr ? (
                          <pre className="agent-window-terminal-pre agent-window-terminal-pre--stderr">
                            {result.message}
                          </pre>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>

              <div className="agent-window-terminal-prompt-bar">
                <span className="agent-window-terminal-prompt" aria-hidden>
                  PS&gt;
                </span>
                <input
                  className="agent-window-terminal-input"
                  type="text"
                  value={terminalCommand}
                  onChange={(e) => onTerminalCommandChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      stickTerminalRef.current = true;
                      onRunTerminal();
                    }
                  }}
                  placeholder="PowerShell — session keeps cwd and env…"
                  spellCheck={false}
                  disabled={terminalBusy}
                  aria-label="PowerShell command"
                />
                <button
                  type="button"
                  className="agent-window-btn"
                  onClick={() => {
                    stickTerminalRef.current = true;
                    onRunTerminal();
                  }}
                  disabled={terminalBusy || !terminalCommand.trim()}
                >
                  {terminalBusy ? 'Running…' : 'Run'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
