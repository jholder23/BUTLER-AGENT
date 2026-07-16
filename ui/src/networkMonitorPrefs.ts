/** Persisted UI prefs for background network monitoring (see useNetworkMonitorWatch). */

export const NM_WATCH_KEY = 'butler-network-monitor-watch';
export const NM_NOTIFY_KEY = 'butler-network-monitor-notify';
export const NM_IFACE_KEY = 'butler-network-monitor-iface';
export const NM_BPF_KEY = 'butler-network-monitor-bpf';

const CHANGED = 'butler-network-monitor-prefs-changed';

export function getNetworkMonitorWatchEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    const v = localStorage.getItem(NM_WATCH_KEY);
    if (v === null) return true;
    return v !== '0';
  } catch {
    return true;
  }
}

export function setNetworkMonitorWatchEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(NM_WATCH_KEY, enabled ? '1' : '0');
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    /* */
  }
}

export function getNetworkMonitorNotifyEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    const v = localStorage.getItem(NM_NOTIFY_KEY);
    if (v === null) return true;
    return v !== '0';
  } catch {
    return true;
  }
}

export function setNetworkMonitorNotifyEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(NM_NOTIFY_KEY, enabled ? '1' : '0');
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    /* */
  }
}

export function getNetworkMonitorIfaceHint(): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    return String(localStorage.getItem(NM_IFACE_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function setNetworkMonitorIfaceHint(iface: string): void {
  try {
    const s = String(iface || '').trim();
    if (s) localStorage.setItem(NM_IFACE_KEY, s);
    else localStorage.removeItem(NM_IFACE_KEY);
  } catch {
    /* */
  }
}

export function getNetworkMonitorBpfHint(): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    return String(localStorage.getItem(NM_BPF_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function setNetworkMonitorBpfHint(bpf: string): void {
  try {
    const s = String(bpf || '').trim();
    if (s) localStorage.setItem(NM_BPF_KEY, s);
    else localStorage.removeItem(NM_BPF_KEY);
  } catch {
    /* */
  }
}

export function subscribeNetworkMonitorPrefs(cb: () => void): () => void {
  window.addEventListener(CHANGED, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(CHANGED, cb);
    window.removeEventListener('storage', cb);
  };
}
