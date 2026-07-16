import React, { useCallback, useEffect, useState } from 'react';
import { fetchButlerJsonWithResponse } from '../lib/fetchButlerJson';

type StatusRow = {
  id: string;
  label: string;
  ok?: boolean | null;
  url?: string;
  detail?: string;
  skipped?: boolean;
};
type StatusPayload = {
  services?: StatusRow[];
  error?: string;
  generated_at?: string;
};

const WATCH_IDS = ['knowledge_api', 'local_llm'] as const;

/**
 * Thin bar under the header: Knowledge API + Local LLM up/down dots and quick Restart.
 */
export function ButlerMiniStatusStrip() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: j } = await fetchButlerJsonWithResponse<StatusPayload>('/api/status');
      setData(j);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 45_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  const doRestart = useCallback(
    async (id: string) => {
      setRestarting(id);
      try {
        await fetch('/api/status/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service: id }),
        });
        window.setTimeout(() => void load(), 1200);
      } finally {
        setRestarting(null);
      }
    },
    [load],
  );

  const svc = Object.fromEntries(
    ((data?.services ?? []) as StatusRow[]).map((s) => [s.id, s]),
  ) as Record<string, StatusRow | undefined>;

  return (
    <div className="status-mini-strip" role="status" aria-busy={loading}>
      {data?.error ? (
        <span className="status-mini-msg status-mini-msg--warn" title={data.error}>
          Knowledge unreachable
        </span>
      ) : null}
      {WATCH_IDS.map((id) => {
        const s = svc[id];
        if (!s?.id) {
          return (
            <span key={id} className="status-mini-item">
              <span className="status-mini-dot status-mini-dot--unknown" aria-hidden />
              <span className="status-mini-label">{id.replace(/_/g, ' ')}</span>
            </span>
          );
        }
        const skipped = !!s.skipped;
        const ok = s.ok === true;
        const bad = s.ok === false;
        const pill =
          skipped ? 'muted' : ok ? 'ok' : bad ? 'bad' : 'unknown';
        return (
          <span key={id} className="status-mini-item" title={(s.detail || s.url || '').slice(0, 220)}>
            <span className={`status-mini-dot status-mini-dot--${pill}`} aria-hidden />
            <span className="status-mini-label">{s.label}</span>
            <button
              type="button"
              className="status-mini-restart"
              disabled={loading || restarting !== null || skipped}
              onClick={() => void doRestart(id)}
              title={`Restart ${s.label}`}
            >
              {restarting === id ? '…' : '⟲'}
            </button>
          </span>
        );
      })}
      <button type="button" className="status-mini-refresh" onClick={() => void load()} disabled={loading}>
        Refresh
      </button>
    </div>
  );
}
