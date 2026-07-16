import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchButlerJson } from '../lib/fetchButlerJson';

type VisualizerProbe = {
  ok: boolean;
  ffmpeg?: { ok: boolean; detail?: string };
  output_dir?: string;
  state_dir?: string;
};

type VisualizerJob = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  created_at?: string;
  updated_at?: string;
  started_at?: string;
  finished_at?: string;
  input_path?: string;
  title?: string;
  artist?: string;
  template?: string;
  output_path?: string;
  error?: string;
};

function parsePlaylistText(text: string): Array<{ path: string; title?: string; artist?: string }> {
  const out: Array<{ path: string; title?: string; artist?: string }> = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Allow: "path | artist - title" (optional)
    const parts = line.split('|').map((s) => s.trim()).filter(Boolean);
    const p = parts[0];
    if (!p) continue;
    let artist = '';
    let title = '';
    const meta = parts.slice(1).join(' | ');
    if (meta) {
      const m = meta.split(' - ').map((s) => s.trim()).filter(Boolean);
      if (m.length >= 2) {
        artist = m[0];
        title = m.slice(1).join(' - ');
      } else {
        title = meta;
      }
    }
    out.push({ path: p, ...(title ? { title } : {}), ...(artist ? { artist } : {}) });
  }
  return out;
}

export function VisualizerPanel() {
  const [probe, setProbe] = useState<VisualizerProbe | null>(null);
  const [jobs, setJobs] = useState<VisualizerJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [template, setTemplate] = useState<'waves' | 'spectrum'>('spectrum');
  const [lookahead, setLookahead] = useState(50);
  const [defaultFirstN, setDefaultFirstN] = useState(3);
  const [playlistText, setPlaylistText] = useState('');

  const pollRef = useRef<number | null>(null);

  const parsedTracks = useMemo(() => parsePlaylistText(playlistText), [playlistText]);

  const loadOnce = async () => {
    const p = await fetchButlerJson<VisualizerProbe>('/api/visualizer/probe');
    setProbe(p);
    const j = await fetchButlerJson<{ ok: boolean; jobs: VisualizerJob[] }>('/api/visualizer/jobs');
    setJobs(Array.isArray(j.jobs) ? j.jobs : []);
  };

  const refreshJobs = async () => {
    const j = await fetchButlerJson<{ ok: boolean; jobs: VisualizerJob[] }>('/api/visualizer/jobs');
    setJobs(Array.isArray(j.jobs) ? j.jobs : []);
  };

  useEffect(() => {
    setErr(null);
    void loadOnce().catch((e: unknown) => setErr(String((e as Error)?.message || e)));
    if (pollRef.current != null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      void refreshJobs().catch(() => {
        /* ignore polling errors */
      });
    }, 2000);
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
      const tracks = parsedTracks;
      if (tracks.length === 0) throw new Error('Paste at least one audio file path (one per line).');
      await fetchButlerJson('/api/visualizer/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template,
          lookahead,
          default_first_n: defaultFirstN,
          tracks,
        }),
      });
      await refreshJobs();
    } finally {
      setBusy(false);
    }
  };

  const done = jobs.filter((j) => j.status === 'done').length;
  const running = jobs.filter((j) => j.status === 'running').length;
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const failed = jobs.filter((j) => j.status === 'error').length;

  return (
    <div>
      <p className="settings-desc" style={{ marginTop: 0 }}>
        Paste a playlist (one audio file path per line). Butler will pre-render music-synced videos and keep them ready before playback.
      </p>

      {probe?.ffmpeg?.ok === false ? (
        <p className="settings-learn-status-line settings-learn-status--warn">
          Visualizer engine not ready: {probe.ffmpeg.detail || 'ffmpeg missing'}
        </p>
      ) : null}
      {err ? <p className="settings-learn-status-line settings-learn-status--warn">{err}</p> : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '10px 0' }}>
        <label className="settings-desc" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Template
          <select
            className="settings-input"
            value={template}
            onChange={(e) => setTemplate(e.target.value === 'waves' ? 'waves' : 'spectrum')}
            disabled={busy}
            style={{ width: 160 }}
          >
            <option value="waves">waves</option>
            <option value="spectrum">spectrum</option>
          </select>
        </label>

        <label className="settings-desc" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Lookahead
          <input
            className="settings-input"
            type="number"
            min={1}
            max={500}
            value={lookahead}
            onChange={(e) => setLookahead(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
            disabled={busy}
            style={{ width: 120 }}
          />
        </label>

        <label className="settings-desc" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Default first N
          <input
            className="settings-input"
            type="number"
            min={0}
            max={30}
            value={defaultFirstN}
            onChange={(e) => setDefaultFirstN(Math.max(0, Math.min(30, Number(e.target.value) || 0)))}
            disabled={busy}
            style={{ width: 140 }}
          />
        </label>
      </div>

      <textarea
        className="settings-input"
        placeholder={'D:\\Music\\Track1.mp3\nD:\\Music\\Track2.flac'}
        value={playlistText}
        onChange={(e) => setPlaylistText(e.target.value)}
        rows={7}
        spellCheck={false}
        disabled={busy}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 10 }}>
        <button type="button" className="settings-save" onClick={() => void queue()} disabled={busy}>
          {busy ? 'Queuing…' : `Generate (${parsedTracks.length || 0} track${parsedTracks.length === 1 ? '' : 's'})`}
        </button>
        <button type="button" className="settings-secondary-btn" onClick={() => void refreshJobs()} disabled={busy}>
          Refresh jobs
        </button>
        {probe?.output_dir ? (
          <span className="settings-learn-status-line settings-learn-status--muted">
            Output: <code>{probe.output_dir}</code>
          </span>
        ) : null}
      </div>

      <div className="settings-learn-status" style={{ marginTop: 12 }}>
        <p className="settings-learn-status-line">
          Done: <strong>{done}</strong> · Running: <strong>{running}</strong> · Queued: <strong>{queued}</strong> · Failed:{' '}
          <strong>{failed}</strong>
        </p>
      </div>

      {jobs.length > 0 ? (
        <div style={{ marginTop: 10, overflowX: 'auto' }}>
          <table className="settings-status-table" style={{ fontSize: '0.78rem', width: '100%' }}>
            <thead>
              <tr>
                <th className="status-td-label">Status</th>
                <th className="status-td-label">Track</th>
                <th className="status-td-label">Output</th>
              </tr>
            </thead>
            <tbody>
              {jobs
                .slice()
                .reverse()
                .slice(0, 80)
                .map((j) => (
                  <tr key={j.id}>
                    <td>
                      <code>{j.status}</code>
                    </td>
                    <td className="status-td-detail" title={j.input_path || ''}>
                      {(j.artist && j.title ? `${j.artist} — ${j.title}` : j.title || j.input_path || '—').slice(0, 120)}
                      {(j.artist && j.title ? `${j.artist} — ${j.title}` : j.title || j.input_path || '').length > 120 ? '…' : ''}
                      {j.error ? (
                        <div className="settings-learn-status-line settings-learn-status--warn" style={{ marginTop: 4 }}>
                          {j.error.slice(0, 220)}
                          {j.error.length > 220 ? '…' : ''}
                        </div>
                      ) : null}
                    </td>
                    <td className="status-td-detail" title={j.output_path || ''}>
                      {j.output_path ? <code>{j.output_path}</code> : <span className="settings-learn-status--muted">—</span>}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

