import React, { useMemo, useRef, useState } from 'react';
import { fetchButlerJson } from '../lib/fetchButlerJson';

type Txt2VideoResult = {
  ok?: boolean;
  message?: string;
  video?: string;
  path?: string;
};

function base64ToBlobUrl(base64: string, mime: string): { url: string; bytes: number } | null {
  try {
    const raw = base64.trim();
    if (!raw || raw.length < 40) return null;
    if (raw.startsWith('data:')) return null;
    const binStr = atob(raw);
    const len = binStr.length;
    const u8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) u8[i] = binStr.charCodeAt(i);
    const blob = new Blob([u8], { type: mime });
    const url = URL.createObjectURL(blob);
    return { url, bytes: blob.size };
  } catch {
    return null;
  }
}

export function AnimatePromptPanel() {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Txt2VideoResult | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  const lastUrlRef = useRef<string | null>(null);

  const canRun = useMemo(() => prompt.trim().length >= 3 && !busy, [prompt, busy]);

  const cleanupUrl = () => {
    if (lastUrlRef.current) {
      try {
        URL.revokeObjectURL(lastUrlRef.current);
      } catch {
        /* ignore */
      }
      lastUrlRef.current = null;
    }
  };

  const generate = async () => {
    setErr(null);
    setBusy(true);
    cleanupUrl();
    setVideoUrl(null);
    setResult(null);
    try {
      const out = await fetchButlerJson<Txt2VideoResult>('/api/animate/txt2video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      setResult(out);

      const rawVid = String(out?.video || '').trim();
      if (rawVid) {
        // Avoid trying to hold huge base64 videos in the DOM; show only when reasonable.
        if (rawVid.length < 3_000_000) {
          const blob = base64ToBlobUrl(rawVid, 'video/mp4');
          if (blob?.url) {
            lastUrlRef.current = blob.url;
            setVideoUrl(blob.url);
          }
        }
      }
    } catch (e: unknown) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const openPath = async (p: string, action: 'open' | 'reveal' = 'reveal') => {
    try {
      await fetchButlerJson('/api/open_path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p, action }),
      });
    } catch (e: unknown) {
      setErr(String((e as Error)?.message || e));
    }
  };

  return (
    <div>
      <p className="settings-desc" style={{ marginTop: 0 }}>
        Generate a free local animated video from a prompt (characters, scene, motion). This uses your local video stack (ComfyUI / SD helpers) and saves outputs under your Butler data folder.
      </p>
      {err ? <p className="settings-learn-status-line settings-learn-status--warn">{err}</p> : null}

      <textarea
        className="settings-input"
        placeholder={'Example: a stylized cartoon knight running through a neon forest, dynamic camera, smooth motion, vibrant colors'}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={5}
        spellCheck={false}
        disabled={busy}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 10 }}>
        <button type="button" className="settings-save" onClick={() => void generate()} disabled={!canRun}>
          {busy ? 'Generating…' : 'Generate video'}
        </button>
        {result?.path ? (
          <>
            <button type="button" className="settings-secondary-btn" onClick={() => void openPath(result.path!, 'reveal')} disabled={busy}>
              Show file
            </button>
            <button type="button" className="settings-secondary-btn" onClick={() => void openPath(result.path!, 'open')} disabled={busy}>
              Open folder
            </button>
          </>
        ) : null}
      </div>

      {result?.message ? (
        <p className="settings-learn-status-line" style={{ marginTop: 10 }}>
          {result.message}
        </p>
      ) : null}

      {result?.path ? (
        <p className="settings-learn-status-line settings-learn-status--muted">
          Saved: <code>{result.path}</code>
        </p>
      ) : null}

      {videoUrl ? (
        <div style={{ marginTop: 10 }}>
          <video src={videoUrl} controls style={{ width: '100%', maxWidth: 760, borderRadius: 10 }} />
        </div>
      ) : null}
    </div>
  );
}

