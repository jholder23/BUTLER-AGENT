import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchButlerJson } from '../lib/fetchButlerJson';

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

export function EpisodeGeneratorPanel() {
  const [prompt, setPrompt] = useState('');
  const [minutes, setMinutes] = useState(6);
  const [shots, setShots] = useState(18);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [jobs, setJobs] = useState<EpisodeJob[]>([]);

  const pollRef = useRef<number | null>(null);

  const loadJobs = async () => {
    const j = await fetchButlerJson<{ ok: boolean; jobs: EpisodeJob[] }>('/api/episode/jobs');
    setJobs(Array.isArray(j.jobs) ? j.jobs : []);
  };

  useEffect(() => {
    setErr(null);
    void loadJobs().catch((e: unknown) => setErr(String((e as Error)?.message || e)));
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

  const queue = async () => {
    setErr(null);
    setBusy(true);
    try {
      const p = prompt.trim();
      if (p.length < 3) throw new Error('Write a prompt first.');
      await fetchButlerJson('/api/episode/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: p,
          options: { minutes, shots },
        }),
      });
      setPrompt('');
      await loadJobs();
    } catch (e: unknown) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
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

  const latest = useMemo(() => (jobs.length ? jobs[jobs.length - 1] : null), [jobs]);

  return (
    <div>
      <p className="settings-desc" style={{ marginTop: 0 }}>
        Generate an <strong>original</strong> animated episode (multi-shot animatic) from a prompt. Butler plans a script + shot list, renders each shot with your local video stack, then stitches into a final MP4.
      </p>

      {err ? <p className="settings-learn-status-line settings-learn-status--warn">{err}</p> : null}

      <textarea
        className="settings-input"
        placeholder={
          'Example: Two reckless inventors open a portal to a bureaucracy dimension; keep it funny, fast-paced, stylized 2D animation.'
        }
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        spellCheck={false}
        disabled={busy}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 10 }}>
        <label className="settings-desc" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Minutes
          <input
            className="settings-input"
            type="number"
            min={1}
            max={30}
            value={minutes}
            onChange={(e) => setMinutes(Math.max(1, Math.min(30, Number(e.target.value) || 6)))}
            disabled={busy}
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
            onChange={(e) => setShots(Math.max(3, Math.min(60, Number(e.target.value) || 18)))}
            disabled={busy}
            style={{ width: 120 }}
          />
        </label>
        <button type="button" className="settings-save" onClick={() => void queue()} disabled={busy || prompt.trim().length < 3}>
          {busy ? 'Queuing…' : 'Generate episode'}
        </button>
        <button type="button" className="settings-secondary-btn" onClick={() => void loadJobs()} disabled={busy}>
          Refresh
        </button>
      </div>

      {latest ? (
        <div className="settings-learn-status" style={{ marginTop: 12 }}>
          <p className="settings-learn-status-line">
            Latest job: <code>{latest.id}</code> · <strong>{latest.status}</strong>
            {latest.stage ? (
              <>
                {' '}
                · stage <code>{latest.stage}</code>
              </>
            ) : null}
            {typeof latest.progress === 'number' ? ` · ${Math.max(0, Math.min(100, Math.round(latest.progress)))}%` : null}
          </p>
          {latest.error ? <p className="settings-learn-status-line settings-learn-status--warn">{latest.error}</p> : null}
          {latest.output_path ? (
            <p className="settings-learn-status-line settings-learn-status--muted">
              Output: <code>{latest.output_path}</code>{' '}
              <button type="button" className="settings-secondary-btn settings-secondary-btn--small" onClick={() => void openPath(latest.output_path!, 'reveal')}>
                Show file
              </button>{' '}
              <button type="button" className="settings-secondary-btn settings-secondary-btn--small" onClick={() => void openPath(latest.output_path!, 'open')}>
                Open folder
              </button>
            </p>
          ) : null}
          {latest.spec_path ? (
            <p className="settings-learn-status-line settings-learn-status--muted">
              Spec: <code>{latest.spec_path}</code>
            </p>
          ) : null}
          {Array.isArray(latest.log) && latest.log.length ? (
            <pre className="settings-selftest-pre" style={{ maxHeight: 220, marginTop: 8, fontSize: '0.75rem' }} tabIndex={0}>
              {latest.log.slice(-18).join('\n')}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

