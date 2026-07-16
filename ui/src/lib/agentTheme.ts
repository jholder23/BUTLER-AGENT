export type AgentThemeMode = 'obsidian' | 'ink' | 'day';
export type AgentAccent = 'gilt' | 'copper' | 'jade' | 'steel';

export type AgentThemePrefs = {
  mode: AgentThemeMode;
  accent: AgentAccent;
};

export const AGENT_THEME_KEY = 'butler-agent-theme-v1';

export const AGENT_THEME_MODES: Array<{ id: AgentThemeMode; label: string; hint: string }> = [
  { id: 'obsidian', label: 'Obsidian', hint: 'Warm near-black, Butler gold identity' },
  { id: 'ink', label: 'Ink', hint: 'Cool blue-black, sharper IDE contrast' },
  { id: 'day', label: 'Day', hint: 'Cool stone light surface' },
];

export const AGENT_ACCENTS: Array<{ id: AgentAccent; label: string }> = [
  { id: 'gilt', label: 'Gilt' },
  { id: 'copper', label: 'Copper' },
  { id: 'jade', label: 'Jade' },
  { id: 'steel', label: 'Steel' },
];

const DEFAULT_THEME: AgentThemePrefs = { mode: 'obsidian', accent: 'gilt' };

function isMode(v: unknown): v is AgentThemeMode {
  return v === 'obsidian' || v === 'ink' || v === 'day';
}

function isAccent(v: unknown): v is AgentAccent {
  return v === 'gilt' || v === 'copper' || v === 'jade' || v === 'steel';
}

export function loadAgentTheme(): AgentThemePrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME;
  try {
    const raw = localStorage.getItem(AGENT_THEME_KEY);
    if (!raw) return DEFAULT_THEME;
    const parsed = JSON.parse(raw) as Partial<AgentThemePrefs>;
    return {
      mode: isMode(parsed.mode) ? parsed.mode : DEFAULT_THEME.mode,
      accent: isAccent(parsed.accent) ? parsed.accent : DEFAULT_THEME.accent,
    };
  } catch {
    return DEFAULT_THEME;
  }
}

export function persistAgentTheme(prefs: AgentThemePrefs): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(AGENT_THEME_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
