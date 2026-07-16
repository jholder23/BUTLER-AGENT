import { useCallback, useEffect, useState } from 'react';
import { fetchButlerJsonWithResponse } from '../lib/fetchButlerJson';

type VramGpu = {
  index?: number | string;
  name?: string;
  memory_used_mb?: number | null;
  memory_total_mb?: number | null;
  memory_free_mb?: number | null;
  utilization_pct?: number | null;
};

type VramProcess = {
  pid?: number | string;
  name?: string;
  memory_mb?: number | null;
  kind?: string;
};

type VramSnapshot = {
  ok?: boolean;
  error?: string;
  tips?: string[];
  comfy_url?: string;
  ollama_url?: string;
  nvidia?: {
    ok?: boolean;
    error?: string;
    gpus?: VramGpu[];
    processes?: VramProcess[];
  };
  comfy?: {
    ok?: boolean;
    error?: string;
    url?: string;
    devices?: Array<{
      name?: string;
      vram_total?: number;
      vram_free?: number;
      torch_vram_total?: number;
      torch_vram_free?: number;
    }>;
  };
  ollama?: {
    ok?: boolean;
    error?: string;
    url?: string;
    models?: Array<{ name?: string; size?: number; size_vram?: number }>;
  };
};

function fmtMb(v: number | null | undefined): string {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`;
  return `${Math.round(n)} MB`;
}

function fmtBytes(v: number | null | undefined): string {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return fmtMb(Number(v) / (1000 * 1000));
}

export function VramSettingsPanel() {
  const [data, setData] = useState<VramSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = useCallback((key: string, checked: boolean) => {
    setSelected((s) => {
      const ns = new Set(s);
      if (checked) ns.add(key); else ns.delete(key);
      return ns;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { res, data: j } = await fetchButlerJsonWithResponse<VramSnapshot>('/api/vram');
      setData(j);
      if (!res.ok || j.ok === false) setErr(j.error || `VRAM probe failed (${res.status})`);
    } catch (e) {
      setErr(String((e as Error).message || e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(t);
  }, [load]);

  const free = useCallback(
    async (targets: string[]) => {
      setBusy(targets.join('+'));
      setNote(null);
      try {
        const { res, data: j } = await fetchButlerJsonWithResponse<{
          ok?: boolean;
          message?: string;
          snapshot?: VramSnapshot;
        }>('/api/vram/free', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targets }),
        });
        if (j.snapshot) setData(j.snapshot);
        else await load();
        setNote(j.message || (j.ok || res.ok ? 'Freed.' : 'Free request failed.'));
      } catch (e) {
        setNote(String((e as Error).message || e));
      } finally {
        setBusy(null);
        setSelected(new Set());
      }
    },
    [load],
  );

  const gpu = data?.nvidia?.gpus?.[0];
  const used = gpu?.memory_used_mb ?? null;
  const total = gpu?.memory_total_mb ?? null;
  const pct = used != null && total && total > 0 ? Math.min(100, Math.round((used / total) * 100)) : null;

  return (
    <div className="settings-panel settings-panel--vram">
      <p className="settings-desc">
        Live GPU memory for desktop image runs. FaceID + ReActor loads SDXL and an ONNX face-swap model — on a 12GB card
        that spikes hard if Ollama or a previous Comfy graph still holds VRAM. Refresh every 8s, or free on demand.
      </p>

      {note && <p className="settings-note">{note}</p>}
      {err && <p className="settings-error">{err}</p>}

      <div className="vram-summary">
        <div className="vram-gpu">
          <span>GPU:</span> <strong>{gpu?.name || '—'}</strong>
        </div>
        <div className="vram-used">
          <span>Used:</span> <strong>{fmtMb(used)}</strong>
        </div>
        <div className="vram-total">
          <span>Total:</span> <strong>{fmtMb(total)}</strong>
        </div>
        <div className="vram-util">
          <span>Utilization:</span> <strong>{pct != null ? `${pct}%` : '—'}</strong>
        </div>
      </div>

      <div className="vram-actions">
        <button type="button" className="settings-secondary-btn" onClick={() => void load()} disabled={loading || !!busy}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          type="button"
          className="settings-save"
          onClick={() => {
            const targets = Array.from(selected);
            if (targets.length) void free(targets);
          }}
          disabled={selected.size === 0 || !!busy}
        >
          {busy ? 'Freeing…' : 'Free Selected'}
        </button>
      </div>

      <div className="vram-check-actions">
        <div className="vram-check-group">
          {data?.comfy?.ok !== false && (
            <label className="vram-check-item">
              <input
                type="checkbox"
                checked={selected.has('comfy')}
                onChange={(e) => toggle('comfy', e.target.checked)}
                disabled={!!busy}
              />
              <span>Comfy</span>
            </label>
          )}
          {data?.ollama?.ok !== false && (
            <label className="vram-check-item">
              <input
                type="checkbox"
                checked={selected.has('ollama')}
                onChange={(e) => toggle('ollama', e.target.checked)}
                disabled={!!busy}
              />
              <span>Ollama</span>
            </label>
          )}
          {data?.nvidia?.processes?.length ? data.nvidia.processes.map((p) => (
            <label className="vram-check-item" key={`pid-${p.pid}`}>
              <input
                type="checkbox"
                checked={selected.has(`nvidia:${p.pid}`)}
                onChange={(e) => toggle(`nvidia:${p.pid}`, e.target.checked)}
                disabled={!!busy}
              />
              <span>{p.name || `Process ${p.pid}`} ({fmtMb(p.memory_mb)})</span>
            </label>
          )) : null}
        </div>
        <div className="vram-check-group">
          <button
            type="button"
            className="settings-secondary-btn"
            onClick={() => setSelected(new Set())}
            disabled={selected.size === 0 || !!busy}
          >
            Clear Selection
          </button>
        </div>
      </div>
    </div>
  );
}