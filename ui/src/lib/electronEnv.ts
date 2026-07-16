/** True when running inside Butler / Code Helper Electron (preload exposes `butlerElectron`). */
export function isElectronButler(): boolean {
  return typeof window !== 'undefined' && !!window.butlerElectron;
}

/** Chromium webview tag is only available in Electron renderer with webviewTag enabled. */
export function supportsElectronWebview(): boolean {
  if (typeof window === 'undefined') return false;
  if (!isElectronButler()) return false;
  // Prefer userAgent — reliable even before customElements registers "webview".
  if (typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent || '')) return true;
  try {
    if (typeof customElements !== 'undefined' && customElements.get('webview')) return true;
  } catch {
    /* ignore */
  }
  return true;
}
