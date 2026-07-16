import { useMemo, useState } from 'react';
import type { AgentToolStep } from '../lib/agentTypes';

export type AgentFileChange = {
  id: string;
  path: string;
  tool: string;
  diff: string;
  before?: string;
  after?: string;
};

/** Collect write/edit diffs from agent tool steps (result.diff or args). */
export function collectAgentFileChanges(steps?: AgentToolStep[] | null): AgentFileChange[] {
  if (!steps?.length) return [];
  const out: AgentFileChange[] = [];
  steps.forEach((step, i) => {
    if (step.type !== 'tool') return;
    const tool = String(step.tool || '').toLowerCase();
    if (tool !== 'edit_file' && tool !== 'write_file') return;
    const result = step.result || {};
    if (result.ok === false) return;
    const pathLabel =
      (typeof result.path === 'string' && result.path) ||
      (typeof step.args?.path === 'string' && step.args.path) ||
      'file';
    let diff = typeof result.diff === 'string' ? result.diff : '';
    if (!diff.trim() && tool === 'edit_file') {
      const oldS = typeof step.args?.old_string === 'string' ? step.args.old_string : '';
      const newS = typeof step.args?.new_string === 'string' ? step.args.new_string : '';
      if (oldS || newS) {
        diff = [
          `--- a/${pathLabel}`,
          `+++ b/${pathLabel}`,
          '@@ edit @@',
          ...oldS.split('\n').map((l) => `- ${l}`),
          ...newS.split('\n').map((l) => `+ ${l}`),
        ].join('\n');
      }
    }
    if (!diff.trim() && tool === 'write_file') {
      const content = typeof step.args?.content === 'string' ? step.args.content : '';
      const after = typeof result.after === 'string' ? result.after : content;
      if (after) {
        diff = [
          `--- a/${pathLabel}`,
          `+++ b/${pathLabel}`,
          '@@ write @@',
          ...after.split('\n').slice(0, 200).map((l) => `+ ${l}`),
        ].join('\n');
      }
    }
    if (!diff.trim()) return;
    out.push({
      id: `${pathLabel}-${i}-${tool}`,
      path: pathLabel,
      tool,
      diff,
      before: typeof result.before === 'string' ? result.before : undefined,
      after: typeof result.after === 'string' ? result.after : undefined,
    });
  });
  return out;
}

function DiffLines({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.replace(/\r\n/g, '\n').split('\n'), [diff]);
  return (
    <pre className="agent-diff-pre" tabIndex={0}>
      {lines.map((line, i) => {
        let cls = 'agent-diff-line';
        if (line.startsWith('+') && !line.startsWith('+++')) cls += ' agent-diff-line--add';
        else if (line.startsWith('-') && !line.startsWith('---')) cls += ' agent-diff-line--del';
        else if (line.startsWith('@@')) cls += ' agent-diff-line--hunk';
        else if (line.startsWith('---') || line.startsWith('+++')) cls += ' agent-diff-line--meta';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

export function AgentFileDiffStrip({
  changes,
  onOpen,
}: {
  changes: AgentFileChange[];
  onOpen: (change: AgentFileChange) => void;
}) {
  if (!changes.length) return null;
  return (
    <div className="agent-diff-strip" role="region" aria-label="File changes">
      <span className="agent-diff-strip-label">Changed</span>
      {changes.map((c) => (
        <button
          key={c.id}
          type="button"
          className="agent-diff-chip"
          onClick={() => onOpen(c)}
          title={c.path}
        >
          {c.path.split(/[/\\]/).pop() || c.path}
        </button>
      ))}
    </div>
  );
}

export function AgentFileDiffModal({
  change,
  onClose,
  onBrowse,
}: {
  change: AgentFileChange | null;
  onClose: () => void;
  onBrowse?: (changes: AgentFileChange[], index: number) => void;
  all?: AgentFileChange[];
  index?: number;
}) {
  if (!change) return null;
  return (
    <div className="agent-diff-overlay" role="presentation" onClick={onClose}>
      <div
        className="agent-diff-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Diff ${change.path}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="agent-diff-modal-head">
          <div className="agent-diff-modal-title">
            <strong>{change.path}</strong>
            <span className="agent-diff-modal-tool">{change.tool}</span>
          </div>
          <button type="button" className="agent-window-btn agent-window-btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <DiffLines diff={change.diff} />
      </div>
    </div>
  );
}

export function useAgentDiffBrowser(steps?: AgentToolStep[] | null) {
  const changes = useMemo(() => collectAgentFileChanges(steps), [steps]);
  const [active, setActive] = useState<AgentFileChange | null>(null);
  return { changes, active, setActive, open: (c: AgentFileChange) => setActive(c), close: () => setActive(null) };
}
