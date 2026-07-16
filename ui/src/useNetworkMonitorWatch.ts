import { useEffect, useRef } from 'react';
import { fetchButlerJsonWithResponse } from './lib/fetchButlerJson';
import { butlerFetch } from './lib/butlerApiBase';
import {
  getNetworkMonitorBpfHint,
  getNetworkMonitorIfaceHint,
  getNetworkMonitorNotifyEnabled,
  getNetworkMonitorWatchEnabled,
  subscribeNetworkMonitorPrefs,
} from './networkMonitorPrefs';

type SnapAlert = { id?: number; t?: string; severity?: string; detail?: string; kind?: string };

type Snapshot = {
  running?: boolean;
  startedAt?: string | null;
  alerts?: SnapAlert[];
};

const POLL_MS = 3500;

/**
 * While Butler is open: optional continuous tshark capture + desktop notifications for new medium/high alerts.
 * Prefs live in localStorage (see networkMonitorPrefs).
 */
export function useNetworkMonitorWatch(): void {
  const seenIdsRef = useRef<Set<number>>(new Set());
  const seededRef = useRef(false);
  const watchOffRef = useRef(false);
  const lastIfaceBpfRef = useRef<{ iface: string; bpf: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      const watch = getNetworkMonitorWatchEnabled();
      const notify = getNetworkMonitorNotifyEnabled();

      if (!watch) {
        if (!watchOffRef.current) {
          watchOffRef.current = true;
          seededRef.current = false;
          seenIdsRef.current = new Set();
          lastIfaceBpfRef.current = null;
          try {
            await butlerFetch('/api/network-monitor/stop', { method: 'POST' });
          } catch {
            /* */
          }
        }
        return;
      }
      watchOffRef.current = false;

      try {
        const { data: probe } = await fetchButlerJsonWithResponse<{ ok?: boolean }>('/api/network-monitor/probe', {
          signal: AbortSignal.timeout(8000),
        });
        if (!probe?.ok) return;

        const iface = getNetworkMonitorIfaceHint() || '1';
        const bpf = getNetworkMonitorBpfHint();

        const prev = lastIfaceBpfRef.current;
        if (prev && (prev.iface !== iface || prev.bpf !== bpf)) {
          lastIfaceBpfRef.current = { iface, bpf };
          seededRef.current = false;
          seenIdsRef.current = new Set();
          try {
            await butlerFetch('/api/network-monitor/stop', { method: 'POST' });
          } catch {
            /* */
          }
        } else if (!prev) {
          lastIfaceBpfRef.current = { iface, bpf };
        }

        const { data: snap } = await fetchButlerJsonWithResponse<Snapshot>('/api/network-monitor/snapshot', {
          signal: AbortSignal.timeout(8000),
        });
        if (cancelled) return;

        if (!snap?.running) {
          await fetchButlerJsonWithResponse('/api/network-monitor/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ iface, bpf }),
            signal: AbortSignal.timeout(12000),
          });
        }

        const { data: snap2 } = await fetchButlerJsonWithResponse<Snapshot>('/api/network-monitor/snapshot', {
          signal: AbortSignal.timeout(8000),
        });
        if (cancelled) return;

        const alerts = snap2?.alerts || [];
        if (!seededRef.current) {
          for (const a of alerts) {
            if (typeof a.id === 'number') seenIdsRef.current.add(a.id);
          }
          seededRef.current = true;
          return;
        }

        for (const a of alerts) {
          if (typeof a.id !== 'number' || seenIdsRef.current.has(a.id)) continue;
          seenIdsRef.current.add(a.id);
          const sev = String(a.severity || '').toLowerCase();
          if (sev !== 'high' && sev !== 'medium') continue;
          if (!notify || typeof Notification === 'undefined') continue;
          let perm = Notification.permission;
          if (perm === 'default') {
            perm = await Notification.requestPermission();
          }
          if (perm !== 'granted') continue;
          const title = sev === 'high' ? 'Butler: network alert (high)' : 'Butler: network alert (medium)';
          const body = (a.detail || a.kind || 'Suspicious activity').slice(0, 220);
          try {
            new Notification(title, { body, tag: `butler-nm-${a.id}` });
          } catch {
            /* */
          }
        }
      } catch {
        /* API down or capture blocked — retry next poll */
      }
    };

    void tick();
    timer = window.setInterval(() => void tick(), POLL_MS);
    const unsub = subscribeNetworkMonitorPrefs(() => {
      seededRef.current = false;
      seenIdsRef.current = new Set();
      lastIfaceBpfRef.current = null;
      void tick();
    });

    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
      unsub();
    };
  }, []);
}
