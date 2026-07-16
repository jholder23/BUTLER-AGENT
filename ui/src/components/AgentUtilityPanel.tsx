import { useCallback, useEffect, useId, useState } from 'react';
import { SecretMenuImageTools, type PoseReferenceImage } from './SecretMenuImageTools';

export type AgentUtilitySideAttachment = {
  dataUrl: string;
  name: string;
  mime: string;
};

export type AgentUtilityPanelProps = {
  open: boolean;
  onClose: () => void;
  onSideSend?: (
    message: string,
    attachment?: AgentUtilitySideAttachment | null,
  ) => Promise<void>;
  /** `window` = fill OS BrowserWindow (no modal backdrop). */
  variant?: 'overlay' | 'window';
};

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const s = dataUrl.trim();
  const marker = ';base64,';
  const i = s.indexOf(marker);
  if (!s.toLowerCase().startsWith('data:') || i < 5) return null;
  return {
    mime: s.slice(5, i).trim() || 'application/octet-stream',
    base64: s.slice(i + marker.length).replace(/\s/g, ''),
  };
}

/** Secret utility content (image studio + side composer). Overlay or detached window. */
export function AgentUtilityPanel({
  open,
  onClose,
  onSideSend,
  variant = 'overlay',
}: AgentUtilityPanelProps) {
  const titleId = useId();
  const [poseReference, setPoseReference] = useState<PoseReferenceImage | null>(null);
  const [sideInput, setSideInput] = useState('');
  const [sideAttach, setSideAttach] = useState<AgentUtilitySideAttachment | null>(null);
  const [sideBusy, setSideBusy] = useState(false);
  const fileId = useId();
  const isWindow = variant === 'window';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const sendSide = useCallback(async () => {
    const t = sideInput.trim();
    if (!t || !onSideSend || sideBusy) return;
    setSideBusy(true);
    try {
      await onSideSend(t, sideAttach);
      setSideInput('');
      setSideAttach(null);
      if (!isWindow) onClose();
    } finally {
      setSideBusy(false);
    }
  }, [isWindow, onClose, onSideSend, sideAttach, sideBusy, sideInput]);

  if (!open) return null;

  const body = (
    <div
      id="butler-utility-panel"
      className={`settings-modal secret-menu-dialog${
        isWindow ? ' secret-menu-dialog--window' : ' secret-menu-dialog--resizable'
      }`}
      role="dialog"
      aria-modal={!isWindow}
      aria-labelledby={titleId}
      onClick={isWindow ? undefined : (e) => e.stopPropagation()}
    >
      <div className="secret-menu-window-head">
        <span className="settings-desc secret-menu-window-title">Utility Panel</span>
        <button
          type="button"
          className="settings-secondary-btn"
          onClick={onClose}
          style={{ padding: '2px 10px', fontSize: '0.85em' }}
        >
          Close
        </button>
      </div>
      <div className="settings-modal-header">
        <h2 id={titleId} className="settings-modal-title">
          Utility panel
        </h2>
        {!isWindow ? (
          <button type="button" className="settings-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        ) : null}
      </div>
      <div className="settings-modal-body">
        <p className="settings-desc secret-menu-flavor">
          Extended shortcut recognized. Extra tools without opening Settings.
        </p>
        <SecretMenuImageTools onUsePose={setPoseReference} poseReference={poseReference} />
        {onSideSend ? (
          <div className="secret-menu-chat-compose" data-no-chat-hotkey="true" style={{ marginTop: 16 }}>
            <p className="settings-desc secret-menu-prompting-title">Side composer</p>
            <p className="settings-desc secret-menu-chat-hint">
              Sends on the current Agent thread
              {isWindow ? ' (parent Agent window)' : ' without showing your text as a user bubble'}.
            </p>
            <div className="secret-menu-attach-row">
              <input
                id={fileId}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl = String(reader.result || '');
                    const parsed = parseDataUrl(dataUrl);
                    if (!parsed) return;
                    setSideAttach({ dataUrl, name: f.name, mime: parsed.mime || f.type });
                  };
                  reader.readAsDataURL(f);
                }}
              />
              <label htmlFor={fileId} className="upload-attachment-btn">
                {sideAttach ? sideAttach.name : 'Attach image'}
              </label>
              {sideAttach ? (
                <button type="button" className="settings-secondary-btn" onClick={() => setSideAttach(null)}>
                  Remove
                </button>
              ) : null}
            </div>
            <textarea
              className="secret-menu-chat-textarea"
              rows={3}
              value={sideInput}
              onChange={(e) => setSideInput(e.target.value)}
              placeholder="Side message…"
            />
            <div className="secret-menu-chat-actions">
              <button
                type="button"
                className="settings-primary-btn"
                disabled={sideBusy || !sideInput.trim()}
                onClick={() => void sendSide()}
              >
                {sideBusy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );

  if (isWindow) {
    return <div className="agent-utility-window-shell">{body}</div>;
  }

  return (
    <div
      className="settings-modal-backdrop secret-menu-backdrop"
      onClick={onClose}
      role="presentation"
    >
      {body}
    </div>
  );
}

export { useAgentSecretChord } from './agentSecretChord';
