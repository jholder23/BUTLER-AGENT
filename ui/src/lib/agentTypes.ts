export type AgentTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export type AgentTodo = {
  id: string;
  content: string;
  status: AgentTodoStatus;
};

export type AgentToolStep = {
  type: 'tool' | 'final' | 'continue';
  iteration?: number | string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  elapsed_sec?: number;
  summary?: string;
  activity?: string;
  in_progress?: boolean;
};

export type AgentChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  source?: string;
  steps?: AgentToolStep[];
  todos?: AgentTodo[];
  error?: boolean;
  needsContinue?: boolean;
};

export type AgentTurnResponse = {
  reply?: string;
  source?: string;
  mode?: string;
  agent_steps?: AgentToolStep[];
  todos?: AgentTodo[];
  error?: string;
  message?: string;
  run_id?: string;
  project_root?: string;
  model_used?: string;
  agent_provider?: string;
  fallback_chain?: string[];
  needs_continue?: boolean;
};

export type AgentRunStatus = {
  ok?: boolean;
  run_id?: string;
  status?: string;
  message?: string;
  iteration?: number;
  max_iterations?: number;
  steps?: AgentToolStep[];
  todos?: AgentTodo[];
  reply?: string;
  checkpoint_id?: string | null;
  session_id?: string;
  project_root?: string;
  updated_at?: string;
  model_source?: string;
  model_used?: string;
  agent_provider?: string;
};

export type AgentCheckpoint = {
  id: string;
  created_at?: string;
  reason?: string;
  file_count?: number;
  project_root?: string;
};

export type AgentScanResult = {
  ok: boolean;
  project_root?: string;
  key_files?: Array<{ name: string; path: string; snippet?: string }>;
  top_dirs?: string[];
  error?: string;
};

export type AgentTerminalResult = {
  ok: boolean;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  code: number | null;
  message?: string;
  duration_ms?: number;
  shell?: string;
  shell_path?: string;
  session?: boolean;
};
