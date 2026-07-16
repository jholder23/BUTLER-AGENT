import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChatBubbleRichText } from './ChatBubbleRichText';

export type ButlerChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  source?: string;
};

const WELCOME: ButlerChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content:
    "I'm Butler. Ask me anything — jobs, gigs, code help, or just talk. This is the same conversational brain as before; Agent **Code** mode is for tool-driven coding.",
  source: 'Butler',
};

function newSessionId(): string {
  return `butler-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

export type ButlerChatPanelProps = {
  /** Optional: receive session id so secret side-composer can share the thread. */
  onSessionReady?: (sessionId: string) => void;
  /** Imperative send from utility panel (no user bubble). */
  sideSendRef?: React.MutableRefObject<
    | ((
        message: string,
        attachment?: { dataUrl: string; name: string; mime: string } | null,
      ) => Promise<void>)
    | null
  >;
};

export function ButlerChatPanel({ onSessionReady, sideSendRef }: ButlerChatPanelProps) {
  const [sessionId] = useState(newSessionId);
  const [messages, setMessages] = useState<ButlerChatMessage[]>([WELCOME]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [attachment, setAttachment] = useState<{ dataUrl: string; name: string; mime: string } | null>(
    null,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputId = useId();

  useEffect(() => {
    onSessionReady?.(sessionId);
  }, [sessionId, onSessionReady]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  const postChat = useCallback(
    async (
      trimmed: string,
      opts?: {
        omitUserBubble?: boolean;
        attach?: { dataUrl: string; name: string; mime: string } | null;
      },
    ) => {
      if (!trimmed || sending) return;
      const attachPayload = opts?.attach !== undefined ? opts.attach : attachment;
      if (!opts?.omitUserBubble) {
        setMessages((prev) => [
          ...prev,
          { id: String(Date.now()), role: 'user', content: trimmed },
        ]);
        setInput('');
        setAttachment(null);
      }
      setSending(true);
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
        const history = messages
          .filter((m) => m.id !== 'welcome' && (m.role === 'user' || m.role === 'assistant'))
          .filter((m) => m.content.trim())
          .slice(-24)
          .map((m) => ({ role: m.role, content: m.content }));
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            message: trimmed,
            history,
            localOnly: true,
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
        };
        if (!res.ok) throw new Error(data.message || data.error || `Chat failed (${res.status})`);
        const reply =
          data.reply ||
          'I made some changes – please check your project files.';
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-assistant`,
            role: 'assistant',
            content: reply,
            source: data.source || 'Butler',
            images: Array.isArray(data.images) ? data.images : undefined,
          },
        ]);
      } catch (e) {
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-err`,
            role: 'assistant',
            content: String((e as Error)?.message || e),
            source: 'Error',
          },
        ]);
      } finally {
        setSending(false);
      }
    },
    [attachment, messages, sending, sessionId],
  );

  useEffect(() => {
    if (!sideSendRef) return;
    sideSendRef.current = async (message, attach) => {
      await postChat(message.trim(), { omitUserBubble: true, attach: attach ?? null });
    };
    return () => {
      sideSendRef.current = null;
    };
  }, [postChat, sideSendRef]);

  return (
    <div className="butler-chat-panel">
      <div className="butler-chat-panel-scroll" ref={listRef}>
        {messages.map((m) => (
          <div
            key={m.id}
            className={`butler-chat-bubble butler-chat-bubble--${m.role}`}
          >
            {m.source ? <div className="butler-chat-bubble-source">{m.source}</div> : null}
            <ChatBubbleRichText text={m.content} />
            {m.images?.length ? (
              <div className="butler-chat-images">
                {m.images.map((src, i) => (
                  <img key={i} src={src.startsWith('data:') ? src : `data:image/png;base64,${src}`} alt="" />
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {sending ? (
          <div className="butler-chat-bubble butler-chat-bubble--assistant butler-chat-bubble--pending">
            Thinking…
          </div>
        ) : null}
      </div>
      <form
        className="butler-chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void postChat(input.trim());
        }}
      >
        {attachment ? (
          <div className="butler-chat-attach-chip">
            <span>{attachment.name}</span>
            <button type="button" onClick={() => setAttachment(null)} aria-label="Remove attachment">
              ×
            </button>
          </div>
        ) : null}
        <div className="butler-chat-composer-row">
          <input
            id={fileInputId}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const r = new FileReader();
              r.onload = () => {
                const dataUrl = String(r.result);
                const parsed = parseDataUrl(dataUrl);
                setAttachment({
                  dataUrl,
                  name: f.name || 'attachment',
                  mime: parsed?.mime.split(';')[0].trim() || f.type || 'application/octet-stream',
                });
              };
              r.readAsDataURL(f);
              e.target.value = '';
            }}
          />
          <label htmlFor={fileInputId} className="butler-chat-attach-btn" title="Attach">
            📎
          </label>
          <textarea
            className="butler-chat-input"
            rows={2}
            value={input}
            disabled={sending}
            placeholder="Message Butler…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void postChat(input.trim());
              }
            }}
          />
          <button type="submit" className="butler-chat-send" disabled={sending || !input.trim()}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
