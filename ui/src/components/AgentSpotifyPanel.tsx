import { SpotifySeoPanel } from './SpotifySeoPanel';

export type AgentSpotifyPanelProps = {
  open: boolean;
  onClose: () => void;
};

/** Sidebar-opened Spotify SEO + OAuth panel (same body as Settings → Spotify SEO). */
export function AgentSpotifyPanel({ open, onClose }: AgentSpotifyPanelProps) {
  if (!open) return null;

  return (
    <div className="agent-settings-overlay" role="presentation" onClick={onClose}>
      <div
        className="agent-settings-panel agent-spotify-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-spotify-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="agent-settings-head">
          <div>
            <h2 id="agent-spotify-title" className="agent-settings-title">
              Spotify SEO
            </h2>
            <p className="agent-mcp-lede">
              Connect your Spotify account, plan SEO playlists around a focus song using your artist profile, and
              enable weekly auto-maintain.
            </p>
          </div>
          <button type="button" className="agent-window-btn agent-window-btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="agent-settings-body">
          <SpotifySeoPanel />
        </div>
      </div>
    </div>
  );
}
