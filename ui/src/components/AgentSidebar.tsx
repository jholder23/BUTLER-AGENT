import type { MouseEvent, RefObject } from 'react';
import type { SavedAgentThread } from '../lib/agentThreads';
import { formatSavedThreadDate } from '../lib/agentThreads';

export type AgentSidebarProps = {
  open: boolean;
  widthPx: number | null;
  sidebarRef: RefObject<HTMLElement | null>;
  isDirty: boolean;
  threadSearch: string;
  onThreadSearchChange: (value: string) => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  savedThreads: SavedAgentThread[];
  loadedThreadId: string | null;
  editingTitleId: string | null;
  editingTitleValue: string;
  onEditingTitleValueChange: (value: string) => void;
  onNewThread: () => void;
  onOpenMcp: () => void;
  onOpenSettings: () => void;
  onCloseSidebar: () => void;
  /** Secret utility unlock: Q+W+E + double-click far-left brand mark. */
  onSecretLogoDoubleClick?: (e: MouseEvent) => void;
  onLoadThread: (thread: SavedAgentThread) => void;
  onStartRename: (thread: SavedAgentThread, e: MouseEvent) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDeleteThread: (id: string, e: MouseEvent) => void;
  onSaveThread: () => void;
  canSave: boolean;
  sending: boolean;
  mcpCount: number;
  embedded?: boolean;
  splitView?: boolean;
  onBack?: () => void;
  onEnterSplit?: () => void;
  onExitSplit?: () => void;
  standalone?: boolean;
  onPopOut?: () => void;
  onPopIn?: () => void;
};

export function AgentSidebar({
  open,
  widthPx,
  sidebarRef,
  isDirty,
  threadSearch,
  onThreadSearchChange,
  searchOpen,
  onToggleSearch,
  savedThreads,
  loadedThreadId,
  editingTitleId,
  editingTitleValue,
  onEditingTitleValueChange,
  onNewThread,
  onOpenMcp,
  onOpenSettings,
  onCloseSidebar,
  onSecretLogoDoubleClick,
  onLoadThread,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDeleteThread,
  onSaveThread,
  canSave,
  sending,
  mcpCount,
  embedded,
  splitView,
  onBack,
  onEnterSplit,
  onExitSplit,
  standalone,
  onPopOut,
  onPopIn,
}: AgentSidebarProps) {
  if (!open) return null;

  const q = threadSearch.trim().toLowerCase();
  const filtered = q
    ? savedThreads.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.cwd.toLowerCase().includes(q) ||
          t.messages.some((m) => m.content.toLowerCase().includes(q)),
      )
    : savedThreads;

  return (
    <aside
      ref={sidebarRef}
      className="agent-sidebar"
      aria-label="Agent sidebar"
      style={widthPx != null ? { width: widthPx, flexBasis: widthPx } : undefined}
    >
      <div className="agent-sidebar-brand">
        <button
          type="button"
          className="agent-sidebar-mark"
          onDoubleClick={onSecretLogoDoubleClick}
          title="Butler Agent"
          aria-label="Butler Agent"
        >
          B
        </button>
        <div className="agent-sidebar-brand-text">
          <span className="agent-sidebar-product">Butler</span>
          <span className="agent-sidebar-product-sub">Agent</span>
        </div>
        {isDirty ? <span className="agent-window-unsaved-dot" title="Unsaved changes" /> : null}
        <button
          type="button"
          className="agent-icon-btn"
          onClick={onCloseSidebar}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          «
        </button>
      </div>

      <div className="agent-sidebar-actions" role="toolbar" aria-label="Agent actions">
        <button type="button" className="agent-sidebar-action" onClick={onNewThread} title="New thread">
          <span className="agent-sidebar-action-icon" aria-hidden>
            +
          </span>
          <span>New</span>
        </button>
        <button
          type="button"
          className={`agent-sidebar-action${searchOpen ? ' agent-sidebar-action--active' : ''}`}
          onClick={onToggleSearch}
          title="Search threads"
          aria-pressed={searchOpen}
        >
          <span className="agent-sidebar-action-icon" aria-hidden>
            ⌕
          </span>
          <span>Search</span>
        </button>
        <button type="button" className="agent-sidebar-action" onClick={onOpenMcp} title="MCP servers">
          <span className="agent-sidebar-action-icon" aria-hidden>
            ⬡
          </span>
          <span>MCP{mcpCount > 0 ? ` (${mcpCount})` : ''}</span>
        </button>
        <button type="button" className="agent-sidebar-action" onClick={onOpenSettings} title="Settings">
          <span className="agent-sidebar-action-icon" aria-hidden>
            ⚙
          </span>
          <span>Settings</span>
        </button>
      </div>

      {searchOpen ? (
        <div className="agent-sidebar-search">
          <input
            className="agent-sidebar-search-input"
            type="search"
            value={threadSearch}
            onChange={(e) => onThreadSearchChange(e.target.value)}
            placeholder="Search threads & messages…"
            aria-label="Search threads and messages"
            autoFocus
          />
        </div>
      ) : null}

      <div className="agent-sidebar-section-head">
        <h2 className="agent-sidebar-section-title">Threads</h2>
        <button
          type="button"
          className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
          onClick={onSaveThread}
          disabled={sending || !canSave}
          title="Save current thread"
        >
          Save
        </button>
      </div>

      {filtered.length === 0 ? (
        <p className="agent-sidebar-empty">
          {savedThreads.length === 0
            ? 'No saved threads yet. Save a conversation to pin it here.'
            : 'No threads match that search.'}
        </p>
      ) : (
        <ul className="agent-sidebar-list">
          {filtered.map((thread) => {
            const active = thread.id === loadedThreadId;
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  className={`agent-sidebar-item${active ? ' agent-sidebar-item--active' : ''}`}
                  onClick={() => onLoadThread(thread)}
                  title={formatSavedThreadDate(thread.savedAt)}
                >
                  {editingTitleId === thread.id ? (
                    <input
                      className="agent-window-sidebar-rename"
                      value={editingTitleValue}
                      onChange={(e) => onEditingTitleValueChange(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          onCommitRename();
                        } else if (e.key === 'Escape') {
                          onCancelRename();
                        }
                      }}
                      onBlur={onCommitRename}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="agent-sidebar-item-title">{thread.title}</span>
                      <span className="agent-sidebar-item-date">{formatSavedThreadDate(thread.savedAt)}</span>
                    </>
                  )}
                </button>
                <div className="agent-sidebar-item-actions">
                  <button
                    type="button"
                    className="agent-icon-btn"
                    onClick={(e) => onStartRename(thread, e)}
                    title="Rename"
                    aria-label={`Rename ${thread.title}`}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="agent-icon-btn agent-icon-btn--danger"
                    onClick={(e) => onDeleteThread(thread.id, e)}
                    title="Delete"
                    aria-label={`Delete ${thread.title}`}
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="agent-sidebar-footer">
        {embedded ? (
          <>
            <button type="button" className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm" onClick={onBack}>
              Back
            </button>
            {splitView ? (
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
            )}
          </>
        ) : null}
        {standalone && onPopIn ? (
          <button type="button" className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm" onClick={onPopIn}>
            Return
          </button>
        ) : onPopOut ? (
          <button type="button" className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm" onClick={onPopOut}>
            Pop out
          </button>
        ) : null}
      </div>
    </aside>
  );
}
