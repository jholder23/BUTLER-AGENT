import type { MouseEvent, RefObject } from 'react';
import type { SavedAgentThread } from '../lib/agentThreads';
import { formatSavedThreadDate, threadsForWorkspace } from '../lib/agentThreads';
import { agentCwdsMatch, workspaceDisplayName, workspaceExpandKey } from '../lib/agentWorkspaces';
import type { SelfEditReview } from '../lib/agentTypes';

function formatReviewTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso.slice(0, 16);
  }
}

export type AgentSidebarProps = {
  open: boolean;
  widthPx: number | null;
  sidebarRef: RefObject<HTMLElement | null>;
  isDirty: boolean;
  threadSearch: string;
  onThreadSearchChange: (value: string) => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  workspaces: string[];
  activeCwd: string;
  expandedWorkspaces: Set<string>;
  onToggleWorkspaceExpand: (workspacePath: string) => void;
  onSelectWorkspace: (workspacePath: string) => void;
  onAddWorkspace: () => void;
  onNewThreadInWorkspace: (workspacePath: string) => void;
  savedThreads: SavedAgentThread[];
  loadedThreadId: string | null;
  editingTitleId: string | null;
  editingTitleValue: string;
  onEditingTitleValueChange: (value: string) => void;
  onOpenMcp: () => void;
  onOpenSpotify: () => void;
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
  saveNotice?: string | null;
  sending: boolean;
  mcpCount: number;
  pendingReviews?: SelfEditReview[];
  activeReviewId?: string | null;
  onSelectReview?: (review: SelfEditReview) => void;
  embedded?: boolean;
  splitView?: boolean;
  onBack?: () => void;
  onEnterSplit?: () => void;
  onExitSplit?: () => void;
  standalone?: boolean;
  onPopOut?: () => void;
  onPopIn?: () => void;
};

function threadMatchesSearch(thread: SavedAgentThread, q: string): boolean {
  if (!q) return true;
  return (
    thread.title.toLowerCase().includes(q) ||
    thread.cwd.toLowerCase().includes(q) ||
    thread.messages.some((m) => m.content.toLowerCase().includes(q))
  );
}

export function AgentSidebar({
  open,
  widthPx,
  sidebarRef,
  isDirty,
  threadSearch,
  onThreadSearchChange,
  searchOpen,
  onToggleSearch,
  workspaces,
  activeCwd,
  expandedWorkspaces,
  onToggleWorkspaceExpand,
  onSelectWorkspace,
  onAddWorkspace,
  onNewThreadInWorkspace,
  savedThreads,
  loadedThreadId,
  editingTitleId,
  editingTitleValue,
  onEditingTitleValueChange,
  onOpenMcp,
  onOpenSpotify,
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
  saveNotice = null,
  sending: _sending,
  mcpCount,
  pendingReviews = [],
  activeReviewId = null,
  onSelectReview,
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
  const searching = q.length > 0;

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
        <button
          type="button"
          className="agent-sidebar-action"
          onClick={onAddWorkspace}
          title="Add workspace folder"
        >
          <span className="agent-sidebar-action-icon" aria-hidden>
            +
          </span>
          <span>Workspace</span>
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
        <button type="button" className="agent-sidebar-action" onClick={onOpenSpotify} title="Spotify SEO playlists">
          <span className="agent-sidebar-action-icon" aria-hidden>
            ♫
          </span>
          <span>Spotify</span>
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
        <h2 className="agent-sidebar-section-title">
          Reviews{pendingReviews.length > 0 ? ` (${pendingReviews.length})` : ''}
        </h2>
      </div>
      {pendingReviews.length === 0 ? (
        <p className="agent-sidebar-empty agent-sidebar-reviews-empty">
          No pending self-edit reviews. Accept/Reject here after reopen.
        </p>
      ) : (
        <ul className="agent-sidebar-reviews" aria-label="Pending self-edit reviews">
          {pendingReviews.map((review) => {
            const id = review.review_id || review.session_id || review.checkpoint_id || review.run_id || '';
            const active = Boolean(id && activeReviewId && id === activeReviewId);
            const fileCount = review.file_count ?? review.files?.length ?? 0;
            const when = formatReviewTime(review.updated_at || review.created_at);
            return (
              <li key={id || `${review.session_id}-${review.updated_at}`}>
                <button
                  type="button"
                  className={`agent-sidebar-review-item${active ? ' agent-sidebar-review-item--active' : ''}`}
                  onClick={() => onSelectReview?.(review)}
                  title={review.files?.join('\n') || review.title || 'Self-edit review'}
                >
                  <span className="agent-sidebar-review-title">
                    {review.title || 'Self-edit review'}
                  </span>
                  <span className="agent-sidebar-review-meta">
                    {fileCount} file{fileCount === 1 ? '' : 's'}
                    {when ? ` · ${when}` : ''}
                    {review.tests_required && !review.tests_ok ? ' · tests needed' : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="agent-sidebar-section-head">
        <h2 className="agent-sidebar-section-title">Workspaces</h2>
        <div className="agent-sidebar-section-actions">
          <button
            type="button"
            className="agent-icon-btn agent-sidebar-add-workspace"
            onClick={onAddWorkspace}
            title="Add workspace"
            aria-label="Add workspace"
          >
            +
          </button>
          <button
            type="button"
            className="agent-window-btn agent-window-btn--ghost agent-window-btn--sm"
            onClick={onSaveThread}
            disabled={!canSave}
            title="Save current Chat or Code thread under this workspace"
          >
            Save
          </button>
        </div>
      </div>
      {saveNotice ? (
        <p className="agent-sidebar-save-notice" role="status">
          {saveNotice}
        </p>
      ) : null}

      {workspaces.length === 0 ? (
        <p className="agent-sidebar-empty">
          No workspaces yet. Click + to add a project folder.
        </p>
      ) : (
        <ul className="agent-sidebar-tree" role="tree" aria-label="Workspaces">
          {workspaces.map((ws) => {
            const expandKey = workspaceExpandKey(ws);
            const expanded = searching || expandedWorkspaces.has(expandKey);
            const active = agentCwdsMatch(ws, activeCwd);
            const wsThreads = threadsForWorkspace(savedThreads, ws).filter((t) =>
              threadMatchesSearch(t, q),
            );
            const hideWorkspace =
              searching && wsThreads.length === 0 && !workspaceDisplayName(ws).toLowerCase().includes(q);
            if (hideWorkspace) return null;

            return (
              <li key={expandKey || ws} className="agent-sidebar-ws" role="treeitem" aria-expanded={expanded}>
                <div
                  className={`agent-sidebar-ws-row${active ? ' agent-sidebar-ws-row--active' : ''}`}
                >
                  <button
                    type="button"
                    className="agent-sidebar-ws-chevron"
                    onClick={() => onToggleWorkspaceExpand(ws)}
                    title={expanded ? 'Collapse' : 'Expand'}
                    aria-label={expanded ? `Collapse ${workspaceDisplayName(ws)}` : `Expand ${workspaceDisplayName(ws)}`}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                  <button
                    type="button"
                    className="agent-sidebar-ws-label"
                    onClick={() => onSelectWorkspace(ws)}
                    title={ws}
                  >
                    <span className="agent-sidebar-ws-name">{workspaceDisplayName(ws)}</span>
                    <span className="agent-sidebar-ws-path">{ws}</span>
                  </button>
                  <button
                    type="button"
                    className="agent-icon-btn agent-sidebar-ws-new"
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewThreadInWorkspace(ws);
                    }}
                    title="New chat in this workspace"
                    aria-label={`New chat in ${workspaceDisplayName(ws)}`}
                  >
                    +
                  </button>
                </div>
                {expanded ? (
                  wsThreads.length === 0 ? (
                    <p className="agent-sidebar-ws-empty">
                      {searching ? 'No matching threads.' : 'No saved threads yet.'}
                    </p>
                  ) : (
                    <ul className="agent-sidebar-thread-list" role="group">
                      {wsThreads.map((thread) => {
                        const isActive = thread.id === loadedThreadId;
                        return (
                          <li key={thread.id} className="agent-sidebar-thread">
                            <button
                              type="button"
                              className={`agent-sidebar-item${isActive ? ' agent-sidebar-item--active' : ''}`}
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
                                  <span className="agent-sidebar-item-meta">
                                    <span
                                      className={`agent-sidebar-item-mode agent-sidebar-item-mode--${
                                        thread.productMode === 'chat'
                                          ? 'chat'
                                          : thread.productMode === 'self-edit'
                                            ? 'self-edit'
                                            : 'code'
                                      }`}
                                    >
                                      {thread.productMode === 'chat'
                                        ? 'Chat'
                                        : thread.productMode === 'self-edit'
                                          ? 'Self-edit'
                                          : 'Code'}
                                    </span>
                                    <span className="agent-sidebar-item-date">
                                      {formatSavedThreadDate(thread.savedAt)}
                                    </span>
                                  </span>
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
                  )
                ) : null}
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
