export type AgentBrowserTab = {
  id: string;
  url: string;
  title: string;
};

const STORAGE_KEY = 'butler_agent_browser_tabs_v1';
const ACTIVE_KEY = 'butler_agent_browser_active_v1';

export function normalizeBrowserUrl(input: string): string {
  const t = input.trim();
  if (!t) return 'about:blank';
  if (/^(about|https?|file):/i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  return `https://${t}`;
}

export function titleFromUrl(url: string): string {
  if (!url || url === 'about:blank') return 'New tab';
  try {
    const u = new URL(url);
    return u.hostname || url.slice(0, 40);
  } catch {
    return url.slice(0, 40) || 'Tab';
  }
}

function newTab(url = 'about:blank'): AgentBrowserTab {
  return {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    url,
    title: titleFromUrl(url),
  };
}

export function defaultAgentBrowserTabs(): AgentBrowserTab[] {
  return [newTab()];
}

export function loadAgentBrowserTabs(): { tabs: AgentBrowserTab[]; activeId: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const activeRaw = localStorage.getItem(ACTIVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const tabs = parsed
          .filter((t): t is AgentBrowserTab => !!t && typeof t === 'object' && typeof t.id === 'string')
          .map((t) => ({
            id: t.id,
            url: typeof t.url === 'string' ? t.url : 'about:blank',
            title: typeof t.title === 'string' ? t.title : titleFromUrl(t.url),
          }));
        if (tabs.length > 0) {
          const activeId =
            typeof activeRaw === 'string' && tabs.some((t) => t.id === activeRaw) ? activeRaw : tabs[0].id;
          return { tabs, activeId };
        }
      }
    }
  } catch {
    /* ignore */
  }
  const tabs = defaultAgentBrowserTabs();
  return { tabs, activeId: tabs[0].id };
}

export function persistAgentBrowserTabs(tabs: AgentBrowserTab[], activeId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs.slice(0, 24)));
    localStorage.setItem(ACTIVE_KEY, activeId);
  } catch {
    /* ignore */
  }
}

export { newTab as createAgentBrowserTab };
