import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchButlerJson } from '../lib/fetchButlerJson';

type Txt2VideoResult = {
  ok?: boolean;
  message?: string;
  video?: string;
  path?: string;
};

type EpisodeJob = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  created_at?: string;
  updated_at?: string;
  started_at?: string;
  finished_at?: string;
  prompt?: string;
  title?: string;
  stage?: string;
  progress?: number;
  output_path?: string;
  spec_path?: string;
  error?: string;
  log?: string[];
};

function base64ToBlobUrl(base64: string, mime: string): string | null {
  try {
    const raw = base64.trim();
    if (!raw || raw.length < 40) return null;
    if (raw.startsWith('data:')) return null;
    const binStr = atob(raw);
    const len = binStr.length;
    const u8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) u8[i] = binStr.charCodeAt(i);
    const blob = new Blob([u8], { type: mime });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function clampInt(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Number.parseInt(String(n ?? ''), 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

function uint8ToBase64(u8: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    const sub = u8.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(binary);
}

async function startPcmRecording(stream: MediaStream): Promise<{
  stop: () => Promise<{ pcm: ArrayBuffer; sampleRate: number }>;
}> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    await ctx.resume();
  } catch {
    /* still try recording */
  }
  const sampleRate = ctx.sampleRate;
  const src = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Int16Array[] = [];
  const gain = ctx.createGain();
  gain.gain.value = 0;

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    chunks.push(out);
  };

  src.connect(processor);
  processor.connect(gain);
  gain.connect(ctx.destination);

  return {
    stop: () =>
      new Promise((resolve) => {
        processor.disconnect();
        src.disconnect();
        void ctx.close();

        const totalLen = chunks.reduce((a, c) => a + c.length, 0);
        const merged = new Int16Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }

        resolve({ pcm: merged.buffer, sampleRate });
      }),
  };
}

export function AnimationGeneratorPanel() {
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'auto' | 'clip' | 'story'>('auto');
  const [aspect, setAspect] = useState<'16:9' | '21:9' | '32:9' | '2.39:1' | '9:16' | '1:1'>('16:9');
  const [minutes, setMinutes] = useState(6);
  const [shots, setShots] = useState(18);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const sttRecRef = useRef<{ stop: () => Promise<{ pcm: ArrayBuffer; sampleRate: number }>; stream?: MediaStream } | null>(null);
  const [statusLine, setStatusLine] = useState<string>('');
  const [activityLog, setActivityLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement | null>(null);

  const [clipResult, setClipResult] = useState<Txt2VideoResult | null>(null);
  const [clipVideoUrl, setClipVideoUrl] = useState<string | null>(null);
  const clipUrlRef = useRef<string | null>(null);
  const clipPlayerRef = useRef<HTMLVideoElement | null>(null);

  const [jobs, setJobs] = useState<EpisodeJob[]>([]);
  const pollRef = useRef<number | null>(null);
  const storyPlayerRef = useRef<HTMLVideoElement | null>(null);
  const lastStoryStatusRef = useRef<string>('');
  const [storyApiOk, setStoryApiOk] = useState<boolean | null>(null);

  const pushLog = (line: string) => {
    const ts = new Date().toLocaleTimeString();
    const msg = `[${ts}] ${String(line || '').trim()}`;
    setActivityLog((prev) => {
      const next = [...prev, msg];
      return next.length > 200 ? next.slice(-200) : next;
    });
  };

  const loadJobs = async () => {
    try {
      const j = await fetchButlerJson<{ ok: boolean; jobs: EpisodeJob[] }>('/api/episode/jobs');
      setStoryApiOk(true);
      setJobs(Array.isArray(j.jobs) ? j.jobs : []);
    } catch (e: unknown) {
      const msg = String((e as Error)?.message || e);
      // Older ui-server builds won't have /api/episode/* — treat as "story disabled" rather than spamming errors.
      if (/episode\/jobs/i.test(msg) || /404/i.test(msg)) {
        setStoryApiOk(false);
        setJobs([]);
        pushLog('Story mode API not found (missing /api/episode/jobs). Clip mode only.');
        return;
      }
      throw e;
    }
  };

  useEffect(() => {
    void loadJobs().catch(() => {
      /* ignore */
    });
    if (pollRef.current != null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      void loadJobs().catch(() => {
        /* ignore */
      });
    }, 2500);
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const latestJob = useMemo(() => (jobs.length ? jobs[jobs.length - 1] : null), [jobs]);

  const cleanupClipUrl = () => {
    if (clipUrlRef.current) {
      try {
        URL.revokeObjectURL(clipUrlRef.current);
      } catch {
        /* ignore */
      }
      clipUrlRef.current = null;
    }
  };

  const playerSrcForPath = (p: string) => `/api/media/video?path=${encodeURIComponent(p)}`;

  useEffect(() => {
    const cur = latestJob?.status || '';
    const prev = lastStoryStatusRef.current;
    lastStoryStatusRef.current = cur;
    if (cur === 'done' && prev !== 'done') {
      pushLog('Story finished. Jumping to player.');
      window.setTimeout(() => {
        storyPlayerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        try {
          storyPlayerRef.current?.focus();
        } catch {
          /* ignore */
        }
      }, 250);
    }
  }, [latestJob?.status]);

  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [activityLog]);

  const toggleSpeechToText = async () => {
    setErr(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setErr('Microphone access is not supported here.');
      return;
    }
    if (isListening) {
      const rec = sttRecRef.current;
      sttRecRef.current = null;
      setIsListening(false);
      if (typeof rec?.stop === 'function') {
        try {
          const { pcm, sampleRate } = await rec.stop();
          rec.stream?.getTracks().forEach((t) => t.stop());
          const pcmU8 = new Uint8Array(pcm);
          if (pcmU8.length < 500) {
            setErr('Recording too short. Speak for at least a second.');
            return;
          }
          const pcmB64 = uint8ToBase64(pcmU8);
          const res = await fetch('/api/speech-to-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pcm: pcmB64, sampleRate: Math.round(sampleRate) }),
          });
          const data = await res.json().catch(() => ({}));
          const text = String(data?.text || '').trim();
          if (text) {
            pushLog('Speech-to-text ok.');
            setPrompt((prev) => (prev ? `${prev} ${text}` : text).trim());
          } else {
            const errMsg =
              data?.error ||
              (res.ok
                ? 'Could not understand audio. Speak clearly and try again.'
                : 'Speech recognition failed.');
            setErr(String(errMsg));
          }
        } catch (e: unknown) {
          setErr('Speech recognition failed: ' + String((e as Error)?.message || e));
        }
      }
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const { stop } = await startPcmRecording(stream);
      sttRecRef.current = { stop, stream };
      setIsListening(true);
      pushLog('Recording… click Stop mic to transcribe.');
    } catch (e: unknown) {
      setErr('Could not access microphone: ' + String((e as Error)?.message || e));
    }
  };

  const openPath = async (p: string, action: 'open' | 'reveal') => {
    setErr(null);
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

  const generate = async () => {
    setErr(null);
    setBusy(true);
    setStatusLine('Starting…');
    pushLog('Generate clicked.');
    cleanupClipUrl();
    setClipVideoUrl(null);
    setClipResult(null);
    try {
      const p = prompt.trim();
      if (p.length < 3) throw new Error('Write a prompt first.');

      const m = mode === 'auto' ? (minutes <= 2 ? 'clip' : 'story') : mode;
      const effectiveMode = storyApiOk === false && m === 'story' ? 'clip' : m;

      if (effectiveMode === 'clip') {
        setStatusLine('Generating clip…');
        pushLog(`Clip mode. Aspect ${aspect}. Calling /api/animate/txt2video…`);
        const out = await fetchButlerJson<Txt2VideoResult>('/api/animate/txt2video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: p, aspect }),
        });
        setClipResult(out);
        const rawVid = String(out?.video || '').trim();
        const savedPath = String(out?.path || '').trim();
        // Prefer streaming from disk when available (handles huge videos).
        if (savedPath) {
          pushLog(`Clip saved: ${savedPath}`);
          setClipVideoUrl(playerSrcForPath(savedPath));
        } else if (rawVid && rawVid.length < 3_000_000) {
          pushLog('Clip returned as base64 (previewable).');
          const url = base64ToBlobUrl(rawVid, 'video/mp4');
          if (url) {
            clipUrlRef.current = url;
            setClipVideoUrl(url);
          }
        } else {
          pushLog('Clip completed, but no saved path returned and video too large to preview inline.');
        }
        setStatusLine('Clip done.');
        pushLog('Clip done. Jumping to player.');
        window.setTimeout(() => {
          clipPlayerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          try {
            clipPlayerRef.current?.focus();
          } catch {
            /* ignore */
          }
        }, 200);
        return;
      }

      if (storyApiOk === false) {
        throw new Error('Story mode is not available on this Butler server build (missing /api/episode/*).');
      }
      const min = clampInt(minutes, 1, 30, 6);
      const sh = clampInt(shots, 3, 60, Math.max(10, Math.min(30, min * 3)));
      setStatusLine('Queued story job…');
      pushLog(`Story mode. minutes=${min}, shots=${sh}, aspect=${aspect}. Calling /api/episode/queue…`);
      await fetchButlerJson('/api/episode/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: p,
          options: { minutes: min, shots: sh, aspect },
        }),
      });
      await loadJobs();
      setStatusLine('Story job running…');
      pushLog('Story queued. Polling /api/episode/jobs…');
    } catch (e: unknown) {
      setErr(String((e as Error)?.message || e));
      setStatusLine('');
      pushLog(`Error: ${String((e as Error)?.message || e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="settings-desc" style={{ marginTop: 0 }}>
        One prompt → animated content. Use <strong>Clip</strong> for quick visuals, or <strong>Story</strong> for longer multi-shot animations.
        If you prompt for a specific copyrighted show, Butler will generate an <strong>original</strong> episode-style animation instead.
      </p>

      {err ? <p className="settings-learn-status-line settings-learn-status--warn">{err}</p> : null}

      <textarea
        className="settings-input"
        placeholder={'Example: trippy visuals video with a frog, kaleidoscope colors, smooth motion, surreal vibe'}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        spellCheck={false}
        disabled={busy}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 10 }}>
        <button
          type="button"
          className={isListening ? 'settings-save' : 'settings-secondary-btn'}
          onClick={() => void toggleSpeechToText()}
          disabled={busy}
          title={isListening ? 'Stop recording and transcribe' : 'Record speech-to-text'}
        >
          {isListening ? 'Stop mic' : 'Mic'}
        </button>
        <label className="settings-desc" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Mode
          <select
            className="settings-input"
            value={mode}
            onChange={(e) => setMode(e.target.value === 'clip' ? 'clip' : e.target.value === 'story' ? 'story' : 'auto')}
            disabled={busy}
            style={{ width: 160 }}
          >
            <option value="auto">auto</option>
            <option value="clip">clip (fast)</option>
            <option value="story" disabled={storyApiOk === false}>story (long)</option>
          </select>
        </label>

        <label className="settings-desc" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Aspect
          <select
            className="settings-input"
            value={aspect}
            onChange={(e) => {
              const v = e.target.value;
              setAspect(
                v === '21:9'
                  ? '21:9'
                  : v === '32:9'
                    ? '32:9'
                  : v === '2.39:1'
                    ? '2.39:1'
                    : v === '9:16'
                      ? '9:16'
                      : v === '1:1'
                        ? '1:1'
                        : '16:9',
              );
            }}
            disabled={busy}
            style={{ width: 160 }}
          >
            <option value="16:9">16:9</option>
            <option value="21:9">21:9 (ultra-wide)</option>
            <option value="32:9">32:9 (super ultra-wide, Odyssey G9)</option>
            <option value="2.39:1">2.39:1 (cinema)</option>
            <option value="9:16">9:16 (vertical)</option>
            <option value="1:1">1:1 (square)</option>
          </select>
        </label>

        <label className="settings-desc" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Minutes
          <input
            className="settings-input"
            type="number"
            min={1}
            max={30}
            value={minutes}
            onChange={(e) => setMinutes(clampInt(e.target.value, 1, 30, 6))}
            disabled={busy || mode === 'clip' || storyApiOk === false}
            style={{ width: 120 }}
          />
        </label>

        <label className="settings-desc" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Shots
          <input
            className="settings-input"
            type="number"
            min={3}
            max={60}
            value={shots}
            onChange={(e) => setShots(clampInt(e.target.value, 3, 60, 18))}
            disabled={busy || mode === 'clip' || storyApiOk === false}
            style={{ width: 120 }}
          />
        </label>

        <button type="button" className="settings-save" onClick={() => void generate()} disabled={busy || prompt.trim().length < 3}>
          {busy ? 'Generating…' : 'Generate'}
        </button>

        <button type="button" className="settings-secondary-btn" onClick={() => void loadJobs()} disabled={busy}>
          Refresh
        </button>
      </div>

      {busy || statusLine ? (
        <div className="settings-learn-status" style={{ marginTop: 10 }} aria-live="polite">
          <p className="settings-learn-status-line">
            <strong>Status:</strong> {statusLine || '…'}
          </p>
        </div>
      ) : null}

      <div className="settings-learn-status" style={{ marginTop: 10 }}>
        <p className="settings-learn-status-line settings-learn-status--muted" style={{ marginBottom: 6 }}>
          Activity log
        </p>
        <pre
          ref={logRef}
          className="settings-selftest-pre"
          style={{ maxHeight: 180, marginTop: 0, fontSize: '0.75rem' }}
          tabIndex={0}
        >
          {(activityLog.length ? activityLog : ['(nothing yet)']).join('\n')}
        </pre>
      </div>

      {clipResult?.message ? (
        <p className="settings-learn-status-line" style={{ marginTop: 10 }}>
          {clipResult.message}
        </p>
      ) : null}
      {clipResult?.path ? (
        <p className="settings-learn-status-line settings-learn-status--muted">
          Clip saved: <code>{clipResult.path}</code>{' '}
          <button type="button" className="settings-secondary-btn settings-secondary-btn--small" onClick={() => void openPath(clipResult.path!, 'reveal')}>
            Show file
          </button>{' '}
          <button type="button" className="settings-secondary-btn settings-secondary-btn--small" onClick={() => void openPath(clipResult.path!, 'open')}>
            Open folder
          </button>
        </p>
      ) : null}
      {clipVideoUrl ? (
        <div style={{ marginTop: 10 }}>
          <video
            ref={clipPlayerRef}
            src={clipVideoUrl}
            controls
            style={{ width: '100%', maxWidth: 920, borderRadius: 10 }}
          />
        </div>
      ) : null}

      {latestJob ? (
        <div className="settings-learn-status" style={{ marginTop: 12 }}>
          <p className="settings-learn-status-line">
            Story job: <code>{latestJob.id}</code> · <strong>{latestJob.status}</strong>
            {latestJob.stage ? (
              <>
                {' '}
                · stage <code>{latestJob.stage}</code>
              </>
            ) : null}
            {typeof latestJob.progress === 'number'
              ? ` · ${Math.max(0, Math.min(100, Math.round(latestJob.progress)))}%`
              : null}
          </p>
          {latestJob.error ? <p className="settings-learn-status-line settings-learn-status--warn">{latestJob.error}</p> : null}
          {latestJob.output_path ? (
            <p className="settings-learn-status-line settings-learn-status--muted">
              Episode saved: <code>{latestJob.output_path}</code>{' '}
              <button type="button" className="settings-secondary-btn settings-secondary-btn--small" onClick={() => void openPath(latestJob.output_path!, 'reveal')}>
                Show file
              </button>{' '}
              <button type="button" className="settings-secondary-btn settings-secondary-btn--small" onClick={() => void openPath(latestJob.output_path!, 'open')}>
                Open folder
              </button>
            </p>
          ) : null}
          {latestJob.output_path ? (
            <div style={{ marginTop: 10 }}>
              <video
                src={playerSrcForPath(latestJob.output_path)}
                ref={storyPlayerRef}
                controls
                style={{ width: '100%', maxWidth: 920, borderRadius: 10 }}
              />
            </div>
          ) : null}
          {Array.isArray(latestJob.log) && latestJob.log.length ? (
            <pre className="settings-selftest-pre" style={{ maxHeight: 220, marginTop: 8, fontSize: '0.75rem' }} tabIndex={0}>
              {latestJob.log.slice(-18).join('\n')}
            </pre>
          ) : null}
        </div>
      ) : null}
      {storyApiOk === false ? (
        <p className="settings-learn-status-line settings-learn-status--muted" style={{ marginTop: 10 }}>
          Story mode is unavailable on the currently running Butler API (missing <code>/api/episode/*</code>). Clip mode still works.
        </p>
      ) : null}
    </div>
  );
}

