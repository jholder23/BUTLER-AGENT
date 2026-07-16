/** Agent LLM providers — mirrors knowledge/agent_llm.py ranked free tiers. */

export type AgentProviderId =
  | 'auto_free'
  | 'local'
  | 'gemini'
  | 'groq'
  | 'openrouter'
  | 'mistral'
  | 'cohere';

export type AgentProviderMeta = {
  id: AgentProviderId;
  label: string;
  model: string;
  envKey: string;
  hint: string;
};

export const AGENT_FREE_PROVIDER_IDS: AgentProviderId[] = [
  'gemini',
  'groq',
  'openrouter',
  'mistral',
  'cohere',
];

export const AGENT_PROVIDERS: AgentProviderMeta[] = [
  {
    id: 'auto_free',
    label: 'Auto free-tier cascade',
    model: 'gemini → groq → openrouter → mistral → cohere → local',
    envKey: '',
    hint: 'Walk free tiers best→worst using available API keys; final fallback is local Ollama.',
  },
  {
    id: 'local',
    label: 'Local (Ollama)',
    model: 'LOCAL_AGENT_MODEL',
    envKey: '',
    hint: 'Uses LOCAL_AGENT_MODEL via Ollama. No API key.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini 2.0 Flash',
    model: 'gemini-2.0-flash',
    envKey: 'GEMINI_API_KEY',
    hint: 'Free tier ~1,500 req/day — aistudio.google.com/apikey',
  },
  {
    id: 'groq',
    label: 'Groq Llama 3.3 70B',
    model: 'llama-3.3-70b-versatile',
    envKey: 'GROQ_API_KEY',
    hint: 'Free ~30 RPM — console.groq.com/keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter Llama 3.3 70B (free)',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    envKey: 'OPENROUTER_API_KEY',
    hint: 'Free models — openrouter.ai/keys',
  },
  {
    id: 'mistral',
    label: 'Mistral Small',
    model: 'mistral-small-latest',
    envKey: 'MISTRAL_API_KEY',
    hint: 'Experiment tier — console.mistral.ai/api-keys',
  },
  {
    id: 'cohere',
    label: 'Cohere Command R',
    model: 'command-r-08-2024',
    envKey: 'COHERE_API_KEY',
    hint: 'Free trial — dashboard.cohere.com/api-keys',
  },
];

export const AGENT_PROVIDER_STORAGE_KEY = 'butler_agent_provider';
export const AGENT_API_KEYS_STORAGE_KEY = 'butler_agent_api_keys';
export const AGENT_CASCADE_STORAGE_KEY = 'butler_agent_auto_free_cascade';

export function isAgentProviderId(v: string): v is AgentProviderId {
  return AGENT_PROVIDERS.some((p) => p.id === v);
}

export function loadAgentProvider(): AgentProviderId {
  try {
    const v = localStorage.getItem(AGENT_PROVIDER_STORAGE_KEY)?.trim().toLowerCase();
    if (v === 'cascade' || v === 'auto') return 'auto_free';
    if (v && isAgentProviderId(v)) return v;
  } catch {
    /* ignore */
  }
  return 'local';
}

export function persistAgentProvider(id: AgentProviderId): void {
  try {
    localStorage.setItem(AGENT_PROVIDER_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

/** Cascade toggle: when on, provider is forced to auto_free; when off, restore last pinned provider. */
export function loadCascadeEnabled(): boolean {
  try {
    const raw = localStorage.getItem(AGENT_CASCADE_STORAGE_KEY);
    if (raw == null || raw === '') {
      return loadAgentProvider() === 'auto_free';
    }
    return raw === '1' || raw === 'true';
  } catch {
    return false;
  }
}

export function persistCascadeEnabled(on: boolean): void {
  try {
    localStorage.setItem(AGENT_CASCADE_STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function loadAgentApiKeys(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AGENT_API_KEYS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function persistAgentApiKeys(keys: Record<string, string>): void {
  try {
    localStorage.setItem(AGENT_API_KEYS_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    /* ignore */
  }
}

export function providerNeedsApiKey(id: AgentProviderId): boolean {
  return id !== 'local' && id !== 'auto_free';
}

export function resolveSendProvider(
  cascadeEnabled: boolean,
  pinned: AgentProviderId,
): AgentProviderId {
  return cascadeEnabled ? 'auto_free' : pinned === 'auto_free' ? 'local' : pinned;
}
