import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  createAgentBrowserTab,
  loadAgentBrowserTabs,
  normalizeBrowserUrl,
  persistAgentBrowserTabs,
  titleFromUrl,
  type AgentBrowserTab,
} from '../lib/agentBrowserTabs';
import { supportsElectronWebview } from '../lib/electronEnv';

const WEBVIEW_PARTITION = 'persist:butler-agent-browser';

type WebviewHostProps = {
  tab: AgentBrowserTab;
  active: boolean;
  onTabMeta: (tabId: string, patch: Partial<Pick<AgentBrowserTab, 'title' | 'url'>>) => void;
  onOpenUrlInNewTab: (url: string) => void;
  onLoadError: (tabId: string, message: string | null) => void;
};

function ElectronWebviewHost({
  tab,
  active,
  onTabMeta,
  onOpenUrlInNewTab,
  onLoadError,
}: WebviewHostProps) {
  const ref = useRef<HTMLWebViewElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const target = tab.url || 'about:blank';
    const navigate = () => {
      try {
        const current = typeof el.getURL === 'function' ? el.getURL() : '';
        if (current !== target) {
          if (typeof el.loadURL === 'function') el.loadURL(target);
          else el.src = target;
        }
      } catch {
        try {
          el.src = target;
        } catch {
          /* guest may be destroyed */
        }
      }
    };
    // Guest may not be ready until dom-ready; also force src for first paint.
    el.src = target;
    navigate();
    const onDomReady = () => navigate();
    el.addEventListener('dom-ready', onDomReady);
    return () => el.removeEventListener('dom-ready', onDomReady);
  }, [tab.url, active]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const syncMeta = () => {
      try {
        onTabMeta(tab.id, {
          url: el.getURL() || tab.url,
          title: el.getTitle() || titleFromUrl(el.getURL() || tab.url),
        });
      } catch {
        /* guest may be destroyed */
      }
    };

    const onNewWindow = (e: Event & { url?: string; preventDefault?: () => void }) => {
      e.preventDefault?.();
      const next = String(e.url || '').trim();
      if (next) onOpenUrlInNewTab(next);
    };

    const onFailLoad = (e: Event & { errorCode?: number; errorDescription?: string; validatedURL?: string }) => {
      const code = e.errorCode ?? 0;
      // -3 is ABORTED (navigation superseded) — ignore
      if (code === -3) return;
      const desc = String(e.errorDescription || '').trim() || `error ${code}`;
      const url = String(e.validatedURL || tab.url || '').trim();
      onLoadError(tab.id, `Failed to load${url ? ` ${url}` : ''}: ${desc} (${code})`);
    };

    const onFinish = () => {
      onLoadError(tab.id, null);
      syncMeta();
    };

    el.addEventListener('page-title-updated', syncMeta);
    el.addEventListener('did-navigate', syncMeta);
    el.addEventListener('did-navigate-in-page', syncMeta);
    el.addEventListener('did-finish-load', onFinish);
    el.addEventListener('did-fail-load', onFailLoad as EventListener);
    el.addEventListener('new-window', onNewWindow as EventListener);

    return () => {
      el.removeEventListener('page-title-updated', syncMeta);
      el.removeEventListener('did-navigate', syncMeta);
      el.removeEventListener('did-navigate-in-page', syncMeta);
      el.removeEventListener('did-finish-load', onFinish);
      el.removeEventListener('did-fail-load', onFailLoad as EventListener);
      el.removeEventListener('new-window', onNewWindow as EventListener);
    };
  }, [tab.id, tab.url, onTabMeta, onOpenUrlInNewTab, onLoadError]);

  return (
    <webview
      ref={ref}
      className="agent-browser-webview"
      data-tab-id={tab.id}
      src={tab.url || 'about:blank'}
      partition={WEBVIEW_PARTITION}
      allowpopups="true"
      style={{ display: active ? 'flex' : 'none' }}
    />
  );
}

function DevBrowserStub({ tab, active }: { tab: AgentBrowserTab; active: boolean }) {
  if (!active) return null;
  const url = tab.url;
  const isNavigable = url && url !== 'about:blank' && /^https?:\/\//i.test(url);

  return (
    <div className="agent-browser-dev-stub" role="status">
      <p className="agent-browser-dev-stub-title">Browser panel (dev fallback)</p>
      <p>
        Embedded Chromium (<code>&lt;webview&gt;</code>) only runs in the <strong>Butler Electron</strong> Agent
        window. This browser/dev preview cannot host Electron guests — you would otherwise see an empty black
        panel.
      </p>
      {isNavigable ? (
        <>
          <p>
            Current tab URL: <code>{url}</code>
          </p>
          <iframe
            className="agent-browser-dev-iframe"
            src={url}
            title={tab.title}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
          <p className="agent-browser-dev-stub-hint">
            Many sites block iframes. Use <strong>Open in system browser</strong> below, or launch Agent from
            Electron for a real webview.
          </p>
          <button
            type="button"
            className="agent-window-btn"
            onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
          >
            Open in system browser
          </button>
        </>
      ) : (
        <p className="agent-browser-dev-stub-hint">
          Enter a URL above and press Go to preview (iframe) or open externally.
        </p>
      )}
    </div>
  );
}

function getActiveWebview(tabId: string): HTMLWebViewElement | null {
  return document.querySelector<HTMLWebViewElement>(
    `webview.agent-browser-webview[data-tab-id="${tabId}"]`,
  );
}

export function AgentBrowserPanel({
  maximized = false,
  onToggleMaximized,
}: {
  maximized?: boolean;
  onToggleMaximized?: () => void;
} = {}) {
  const electronWebview = supportsElectronWebview();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const initial = loadAgentBrowserTabs();
  const [tabs, setTabs] = useState<AgentBrowserTab[]>(initial.tabs);
  const [activeTabId, setActiveTabId] = useState(initial.activeId);
  const [addressInput, setAddressInput] = useState(() => {
    const active = initial.tabs.find((t) => t.id === initial.activeId);
    return active?.url && active.url !== 'about:blank' ? active.url : '';
  });
  const [navState, setNavState] = useState({ canBack: false, canForward: false });
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [devToolsHint, setDevToolsHint] = useState<string | null>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const activeLoadError = loadErrors[activeTabId] || '';

  useEffect(() => {
    persistAgentBrowserTabs(tabs, activeTabId);
  }, [tabs, activeTabId]);

  useEffect(() => {
    if (!activeTab) return;
    setAddressInput(activeTab.url && activeTab.url !== 'about:blank' ? activeTab.url : '');
  }, [activeTab?.id, activeTab?.url]);

  const refreshNavState = useCallback(() => {
    if (!electronWebview) return;
    const el = getActiveWebview(activeTabId);
    if (!el) {
      setNavState({ canBack: false, canForward: false });
      return;
    }
    try {
      setNavState({ canBack: el.canGoBack(), canForward: el.canGoForward() });
    } catch {
      setNavState({ canBack: false, canForward: false });
    }
  }, [activeTabId, electronWebview]);

  useEffect(() => {
    refreshNavState();
  }, [activeTabId, refreshNavState]);

  const patchTab = useCallback((tabId: string, patch: Partial<AgentBrowserTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...patch } : t)));
  }, []);

  const onLoadError = useCallback((tabId: string, message: string | null) => {
    setLoadErrors((prev) => {
      if (!message) {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      }
      return { ...prev, [tabId]: message };
    });
  }, []);

  const addTab = useCallback((url?: string) => {
    const tab = createAgentBrowserTab(url ? normalizeBrowserUrl(url) : 'about:blank');
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    if (url) setAddressInput(normalizeBrowserUrl(url));
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      setLoadErrors((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      setTabs((prev) => {
        if (prev.length <= 1) {
          const blank = createAgentBrowserTab();
          setActiveTabId(blank.id);
          setAddressInput('');
          return [blank];
        }
        const idx = prev.findIndex((t) => t.id === tabId);
        const next = prev.filter((t) => t.id !== tabId);
        if (tabId === activeTabId) {
          const neighbor = next[Math.min(idx, next.length - 1)];
          setActiveTabId(neighbor.id);
        }
        return next;
      });
    },
    [activeTabId],
  );

  const navigateActive = useCallback(
    (raw: string) => {
      const url = normalizeBrowserUrl(raw);
      onLoadError(activeTabId, null);
      patchTab(activeTabId, { url, title: titleFromUrl(url) });
      setAddressInput(url === 'about:blank' ? '' : url);
      // Force loadURL even if React sees the same url string after normalize
      if (electronWebview) {
        requestAnimationFrame(() => {
          const el = getActiveWebview(activeTabId);
          if (!el) return;
          try {
            if (typeof el.loadURL === 'function') el.loadURL(url);
            else el.src = url;
          } catch {
            try {
              el.src = url;
            } catch {
              /* ignore */
            }
          }
        });
      }
    },
    [activeTabId, patchTab, onLoadError, electronWebview],
  );

  const onAddressSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    navigateActive(addressInput);
  };

  const onAddressKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateActive(addressInput);
    }
  };

  const runWebviewCmd = (cmd: 'back' | 'forward' | 'reload') => {
    const el = getActiveWebview(activeTabId);
    if (!el) return;
    try {
      if (cmd === 'back') el.goBack();
      else if (cmd === 'forward') el.goForward();
      else el.reload();
      requestAnimationFrame(refreshNavState);
    } catch {
      /* ignore */
    }
  };

  const openActiveGuestDevTools = useCallback(() => {
    if (!electronWebview) {
      setDevToolsHint('Guest DevTools need the Electron Agent browser (not Vite stub).');
      return;
    }
    const el = getActiveWebview(activeTabId);
    if (!el || typeof el.openDevTools !== 'function') {
      setDevToolsHint('DevTools unavailable for this tab yet — wait for the page to load.');
      return;
    }
    try {
      el.openDevTools();
      setDevToolsHint(null);
    } catch (err) {
      setDevToolsHint(`Could not open DevTools: ${String((err as Error)?.message || err)}`);
    }
  }, [activeTabId, electronWebview]);

  useEffect(() => {
    if (!devToolsHint) return;
    const t = window.setTimeout(() => setDevToolsHint(null), 4000);
    return () => window.clearTimeout(t);
  }, [devToolsHint]);

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      if (e.key !== 'I' && e.key !== 'i') return;
      const panel = panelRef.current;
      if (!panel) return;
      const active = document.activeElement;
      if (!active || !panel.contains(active)) return;
      e.preventDefault();
      e.stopPropagation();
      openActiveGuestDevTools();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [openActiveGuestDevTools]);

  return (
    <div className="agent-browser-panel" ref={panelRef}>
      <div className="agent-browser-toolbar" role="toolbar" aria-label="Browser navigation">
        <button
          type="button"
          className="agent-browser-nav-btn"
          onClick={() => runWebviewCmd('back')}
          disabled={!electronWebview || !navState.canBack}
          title="Back"
          aria-label="Back"
        >
          ←
        </button>
        <button
          type="button"
          className="agent-browser-nav-btn"
          onClick={() => runWebviewCmd('forward')}
          disabled={!electronWebview || !navState.canForward}
          title="Forward"
          aria-label="Forward"
        >
          →
        </button>
        <button
          type="button"
          className="agent-browser-nav-btn"
          onClick={() => runWebviewCmd('reload')}
          disabled={!electronWebview}
          title="Reload"
          aria-label="Reload"
        >
          ↻
        </button>
        <form className="agent-browser-address-form" onSubmit={onAddressSubmit}>
          <input
            className="agent-browser-address-input"
            type="text"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            onKeyDown={onAddressKeyDown}
            placeholder="Search or enter URL"
            spellCheck={false}
            aria-label="Address bar"
          />
          <button type="submit" className="agent-window-btn agent-window-btn--sm">
            Go
          </button>
        </form>
        <button
          type="button"
          className="agent-browser-nav-btn agent-browser-devtools-btn"
          onClick={openActiveGuestDevTools}
          title={
            electronWebview
              ? 'Open DevTools for this tab (Ctrl+Shift+I)'
              : 'Guest DevTools only work in the Electron Agent browser'
          }
          aria-label="Open guest DevTools"
        >
          DevTools
        </button>
        <button
          type="button"
          className={`agent-browser-nav-btn agent-browser-layout-btn${
            maximized ? ' agent-browser-layout-btn--active' : ''
          }`}
          onClick={onToggleMaximized}
          title={maximized ? 'Restore normal Agent layout' : 'Make browser fill the Agent window'}
          aria-label={maximized ? 'Restore normal Agent layout' : 'Make browser fill the Agent window'}
          aria-pressed={maximized}
        >
          {maximized ? 'Restore' : 'Maximize'}
        </button>
      </div>

      <div className="agent-browser-tab-bar" role="tablist" aria-label="Browser tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeTabId}
            className={`agent-browser-tab${t.id === activeTabId ? ' agent-browser-tab--active' : ''}`}
            onClick={() => setActiveTabId(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActiveTabId(t.id);
              }
            }}
            tabIndex={0}
          >
            <span className="agent-browser-tab-label" title={t.url}>
              {t.title || 'New tab'}
            </span>
            {tabs.length > 1 ? (
              <button
                type="button"
                className="agent-browser-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                title="Close tab"
                aria-label={`Close ${t.title}`}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        <button type="button" className="agent-browser-tab-add" onClick={() => addTab()} title="New tab" aria-label="New tab">
          +
        </button>
      </div>

      {activeLoadError ? (
        <div className="agent-browser-load-error" role="alert">
          {activeLoadError}
        </div>
      ) : null}

      {devToolsHint ? (
        <div className="agent-browser-devtools-hint" role="status">
          {devToolsHint}
        </div>
      ) : null}

      <div className="agent-browser-viewport">
        {electronWebview
          ? tabs.map((t) => (
              <ElectronWebviewHost
                key={t.id}
                tab={t}
                active={t.id === activeTabId}
                onTabMeta={patchTab}
                onOpenUrlInNewTab={(url) => addTab(url)}
                onLoadError={onLoadError}
              />
            ))
          : tabs.map((t) => <DevBrowserStub key={t.id} tab={t} active={t.id === activeTabId} />)}
      </div>
    </div>
  );
}
