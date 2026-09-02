import { useMemo, useState } from 'react';
import {
  ReactFlow, Background, Controls,
  type Edge, type Node, type NodeProps, Handle, Position, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from './store';
import { PUZZLES } from './puzzles';
import type { BlockKind, FailureMode, RecoveryAction, RecoveryChain, StepStatus } from './engine/types';

const KIND_ICON: Record<string, string> = {
  input: '📥', model: '🤖', tool: '🔧', retrieval: '🔎', condition: '🔀',
  validator: '✅', retry: '🔁', fallback: '🛟', human: '🧑‍⚖️', output: '📤',
};

const STATUS_STYLE: Record<StepStatus, string> = {
  pending: 'border-slate-300',
  running: 'border-amber-400 animate-pulse',
  completed: 'border-emerald-500',
  failed: 'border-rose-500',
  paused: 'border-sky-500',
  retrying: 'border-violet-400 animate-pulse',
  recovered: 'border-teal-500',
  stopped: 'border-slate-500',
};

const ALL_FAILURES: FailureMode[] = [
  'model_timeout', 'tool_timeout', 'invalid_json', 'missing_field', 'schema_validation',
  'empty_retrieval', 'low_confidence', 'tool_failure', 'human_rejection',
];

const RECOVERY_KINDS = ['retry', 'fallback', 'repair', 'default', 'route_human', 'safe_stop'] as const;

function PuzzleNode({ data, selected }: NodeProps) {
  const d = data as { title: string; kind: string; status: StepStatus; failures: string[] };
  const status = d.status ?? 'pending';
  return (
    <div
      className={`px-3 py-2 rounded-xl border-2 bg-white shadow-md w-44 transition-colors
        ${STATUS_STYLE[status]} ${selected ? 'ring-2 ring-indigo-400' : ''}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
        <span>{KIND_ICON[d.kind] ?? '▫️'}</span>
        <span className="truncate">{d.title}</span>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] uppercase tracking-wide">
        <span className="text-slate-400">{d.kind}</span>
        <span className={
          status === 'completed' || status === 'recovered' ? 'text-emerald-600'
          : status === 'failed' ? 'text-rose-600'
          : status === 'paused' ? 'text-sky-600'
          : status === 'running' || status === 'retrying' ? 'text-amber-600'
          : 'text-slate-400'
        }>{status}</span>
      </div>
      {d.failures.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {d.failures.map((f) => (
            <span key={f} className="text-[9px] bg-rose-100 text-rose-700 rounded px-1">⚡{f}</span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { puzzle: PuzzleNode };

export default function App() {
  const s = useStore();
  const [editDraft, setEditDraft] = useState<{ stepId: string; text: string; error?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 2500);
  };

  const nodes: Node[] = useMemo(
    () => s.workflow.steps.map((step) => ({
      id: step.id,
      type: 'puzzle',
      position: step.position,
      data: {
        title: step.title, kind: step.kind,
        status: s.statusByStep[step.id] ?? 'pending',
        failures: s.armed[step.id] ?? [],
      },
    })),
    [s.workflow, s.statusByStep, s.armed],
  );
  const edges: Edge[] = useMemo(
    () => s.workflow.edges.map((e) => ({
      id: e.id, source: e.from, target: e.to,
      animated: s.statusByStep[e.from] === 'running',
      style: { strokeWidth: 2 },
      label: s.editMode ? '✕' : undefined,
    })),
    [s.workflow, s.statusByStep, s.editMode],
  );
  const selected = s.workflow.steps.find((x) => x.id === s.selectedStepId);
  const selectedTrace = s.trace.filter((t) => t.stepId === s.selectedStepId);
  const outcomeBadge = s.result && (
    s.result.outcome === 'completed' ? '✅ Completed'
    : s.result.outcome === 'stopped_safe' ? '🛑 Stopped safely'
    : s.result.outcome === 'paused_human' ? '⏸ Waiting for a human'
    : '❌ Failed'
  );

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target) return;
    if (!s.connect(c.source, c.target)) flash('Connection rejected — it would duplicate or create a cycle.');
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-3 px-4 py-2 bg-white border-b">
        <div className="font-bold tracking-tight">🧩 AI Workflow Puzzle Builder</div>
        <div className="text-xs text-slate-500 hidden md:inline">a puzzle &amp; learning lab for resilient AI workflows</div>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="border rounded px-2 py-1 text-sm"
            value={s.puzzle.id}
            onChange={(e) => s.selectPuzzle(e.target.value)}
          >
            {PUZZLES.map((p) => (
              <option key={p.id} value={p.id}>{p.difficulty[0]} · {p.title}</option>
            ))}
          </select>
          <button onClick={() => s.setEditMode(!s.editMode)}
            className={`px-3 py-1 rounded text-sm font-medium border
              ${s.editMode ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white'}`}>
            ✏️ Build
          </button>
          <button onClick={() => void s.run()} disabled={s.running}
            className="bg-indigo-600 text-white px-3 py-1 rounded text-sm font-medium disabled:opacity-40">
            {s.running ? 'Running…' : '▶ Run workflow'}
          </button>
          <button onClick={s.reset}
            className="border px-3 py-1 rounded text-sm">Reset</button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <aside className="w-72 shrink-0 border-r bg-white overflow-y-auto p-3 space-y-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Puzzle</div>
            <div className="font-semibold">{s.puzzle.title}</div>
            <div className="mt-1 inline-block text-[11px] rounded-full px-2 py-0.5
              bg-slate-100 text-slate-600">{s.puzzle.difficulty}</div>
          </div>
          <div className="text-sm text-slate-600">{s.puzzle.objective}</div>
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-2 text-xs">
            <b>Friendly goal:</b> {s.puzzle.friendlyGoal}
          </div>
          <div className="text-xs space-y-1">
            <div><b>Sample input:</b> {s.puzzle.sampleInput}</div>
            <div><b>Expected:</b> {s.puzzle.expectedResult}</div>
            <div className="text-rose-600"><b>Failure scenario:</b> {s.puzzle.failureScenario}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-400 mt-2">Completion criteria</div>
            <ul className="text-xs list-disc pl-4 space-y-0.5 mt-1">
              {s.puzzle.completionCriteria.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </div>
          {s.result && (
            <div className="rounded-lg border p-2 text-sm">
              <div className="font-semibold">{outcomeBadge}</div>
              <div className="mt-1 text-xs space-y-0.5">
                <div>Reliability score: <b>{s.result.reliability.score}/100</b></div>
                <div>Retries: {s.result.reliability.totalRetries}</div>
                {s.result.reliability.fallbackActivated.map((f) => <div key={f}>🛟 {f}</div>)}
                {s.result.reliability.humanInterventions.map((h) => <div key={h}>🧑 {h}</div>)}
              </div>
              {s.result.outcome === 'stopped_safe' && (
                <button onClick={() => void s.resumeFromStop()} disabled={s.running}
                  className="mt-2 w-full bg-sky-600 text-white px-2 py-1 rounded text-xs font-medium disabled:opacity-40">
                  ▶ Resume from last successful step
                </button>
              )}
              <div className="mt-2 text-xs">
                {s.result.reliability.notes.map((n, i) => <div key={i}>{n}</div>)}
              </div>
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-slate-500">Final output</summary>
                <pre className="mt-1 whitespace-pre-wrap break-all bg-slate-50 rounded p-2 overflow-x-auto">{safeJson(s.result.finalOutput)}</pre>
              </details>
            </div>
          )}
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          {s.editMode && (
            <div className="flex flex-wrap gap-1 px-3 py-2 bg-white border-b items-center">
              <span className="text-[11px] uppercase tracking-wide text-slate-400 mr-1">Add block</span>
              {(Object.keys(KIND_ICON) as BlockKind[]).map((k) => (
                <button key={k} onClick={() => s.addStep(k)}
                  className="text-[11px] border rounded px-1.5 py-0.5 bg-white hover:bg-indigo-50">
                  {KIND_ICON[k]} {k}
                </button>
              ))}
              <span className="text-[11px] text-slate-400 ml-auto">
                drag between handles to connect · click a ✕ connection to remove
              </span>
            </div>
          )}
          {notice && <div className="px-3 py-1 bg-amber-100 text-amber-800 text-xs border-b border-amber-200">{notice}</div>}
          <div className="flex-1 min-h-0">
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={nodeTypes}
              onNodeClick={(_, n) => s.selectStep(n.id)}
              onNodeDragStop={(_, node) => s.moveNode(node.id, node.position)}
              onConnect={onConnect}
              onEdgeClick={(_, e) => { if (s.editMode) s.disconnect(e.id); }}
              nodesConnectable={s.editMode}
              fitView
            >
              <Background />
              <Controls />
            </ReactFlow>
          </div>
        </div>

        <aside className="w-80 shrink-0 border-l bg-white overflow-y-auto">
          <div className="p-3 border-b">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Step inspector</div>
            {selected ? (
              <div className="mt-1 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">{KIND_ICON[selected.kind]} {selected.title}</div>
                  {s.editMode && (
                    <button onClick={() => s.removeStep(selected.id)}
                      className="text-[11px] text-rose-600 border border-rose-300 rounded px-1.5 py-0.5 hover:bg-rose-50">
                      🗑 Remove
                    </button>
                  )}
                </div>
                <div className="text-xs text-slate-500">{selected.kind}</div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-slate-400 mt-2">Inject failure</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {ALL_FAILURES.map((f) => {
                      const applies = f === 'human_rejection'
                        ? selected.kind === 'human'
                        : ['model_timeout', 'invalid_json', 'missing_field', 'low_confidence'].includes(f)
                          ? selected.kind === 'model' || selected.kind === 'tool'
                          : ['tool_timeout', 'tool_failure'].includes(f)
                            ? selected.kind === 'tool' || selected.kind === 'retrieval'
                            : f === 'schema_validation'
                              ? selected.kind === 'validator' || selected.kind === 'model'
                              : selected.kind === 'retrieval';
                      const on = (s.armed[selected.id] ?? []).includes(f);
                      return (
                        <button key={f} onClick={() => s.toggleFailure(selected.id, f)}
                          title={applies ? '' : `only fires on matching block kinds — ${selected.kind} is not affected`}
                          className={`text-[10px] rounded px-1.5 py-0.5 border
                            ${on ? 'bg-rose-600 text-white border-rose-600' : applies ? 'bg-white text-slate-600' : 'bg-slate-50 text-slate-300'}`}>
                          {f}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <RecoveryConfigurator
                  value={selected.recovery}
                  onChange={(r) => s.setRecovery(selected.id, r)}
                />
                {selected.validation && (
                  <div className="text-xs bg-indigo-50 border border-indigo-200 rounded p-2">
                    <b>Validates:</b> {selected.validation.type}
                    {selected.validation.field ? ` on "${selected.validation.field}"` : ''}
                    {selected.validation.type === 'nonEmptyItems' ? ` — every item needs a ${selected.validation.sub ?? 'owner'}` : ''}
                  </div>
                )}
                {s.pausedStepId === selected.id && (
                  <div className="rounded border border-sky-300 bg-sky-50 p-2 text-xs space-y-1">
                    <div className="font-semibold">🧑 Human decision required</div>
                    <div className="flex gap-1">
                      <button onClick={() => s.decide(selected.id, { decision: 'approved' })}
                        className="bg-emerald-600 text-white px-2 py-0.5 rounded">Approve</button>
                      <button
                        onClick={() => setEditDraft({
                          stepId: selected.id,
                          text: safeJson(selectedTrace.filter((t) => t.status === 'paused').at(-1)?.output) ?? '{}',
                        })}
                        className="bg-amber-500 text-white px-2 py-0.5 rounded">Edit &amp; approve</button>
                      <button onClick={() => s.decide(selected.id, { decision: 'rejected' })}
                        className="bg-rose-600 text-white px-2 py-0.5 rounded">Reject</button>
                    </div>
                    {editDraft?.stepId === selected.id && (
                      <div className="space-y-1">
                        <textarea
                          className="w-full h-28 font-mono text-[10px] border rounded p-1"
                          value={editDraft.text}
                          onChange={(e) => setEditDraft({ ...editDraft, text: e.target.value })}
                        />
                        {editDraft.error && <div className="text-rose-600">{editDraft.error}</div>}
                        <div className="flex gap-1">
                          <button
                            onClick={() => {
                              try {
                                const parsed = JSON.parse(editDraft.text);
                                s.decide(selected.id, { decision: 'edited', edited: parsed });
                                setEditDraft(null);
                              } catch {
                                setEditDraft({ ...editDraft, error: 'Invalid JSON — fix and try again.' });
                              }
                            }}
                            className="bg-emerald-600 text-white px-2 py-0.5 rounded">Save &amp; approve</button>
                          <button onClick={() => setEditDraft(null)}
                            className="border px-2 py-0.5 rounded">Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {selectedTrace.map((t, i) => (
                  <div key={i} className="text-[11px] bg-slate-50 border rounded p-2 overflow-x-auto">
                    <div className="font-semibold">{t.status} · attempt {t.attempt}{t.resumed ? ' · resumed' : ''}</div>
                    {t.error && <div className="text-rose-600">{t.error}</div>}
                    {t.recovery && <div className="text-teal-600">{t.recovery}</div>}
                    {t.input !== undefined && t.input !== t.output && (
                      <details>
                        <summary className="cursor-pointer text-slate-400">input</summary>
                        <pre className="mt-1 whitespace-pre-wrap break-all">{safeJson(t.input)}</pre>
                      </details>
                    )}
                    {t.output !== undefined && (
                      <details open>
                        <summary className="cursor-pointer text-slate-400">output</summary>
                        <pre className="mt-1 whitespace-pre-wrap break-all">{safeJson(t.output)}</pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-400 mt-1">Click a block on the canvas…</div>
            )}
          </div>
          <div className="p-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Execution trace</div>
            <ol className="mt-1 space-y-1">
              {s.trace.length === 0 && <li className="text-xs text-slate-400">Run the workflow to populate the trace.</li>}
              {s.trace.map((t, i) => {
                const step = s.workflow.steps.find((x) => x.id === t.stepId);
                return (
                  <li key={i} className="text-[11px] flex items-center gap-1">
                    <span className="font-mono text-slate-400">{String(i + 1).padStart(2, '0')}</span>
                    <button className="underline decoration-dotted" onClick={() => s.selectStep(t.stepId)}>
                      {KIND_ICON[step?.kind ?? '']}{step?.title}
                    </button>
                    <span className={
                      t.status === 'completed' || t.status === 'recovered' ? 'text-emerald-600'
                      : t.status === 'failed' ? 'text-rose-600' : 'text-sky-600'
                    }>{t.status}</span>
                    {t.resumed && <span className="text-violet-500" title="resumed segment">↻</span>}
                  </li>
                );
              })}
            </ol>
          </div>
        </aside>
      </div>

      <footer className="px-4 py-1 bg-white border-t text-[11px] text-slate-400 flex justify-between">
        <span>Mock mode · all puzzles run offline with deterministic responses</span>
        <span>React · TypeScript · React Flow · custom validators</span>
      </footer>
    </div>
  );
}

/** Configure (or clear) the recovery strategy of the selected block. */
function RecoveryConfigurator({ value, onChange }: {
  value: RecoveryChain | undefined;
  onChange: (r: RecoveryChain | undefined) => void;
}) {
  const chain = Array.isArray(value) ? value : value ? [value] : [];
  const first = chain[0];
  const second = chain[1];
  const setAt = (idx: number, action: RecoveryAction | undefined) => {
    const next = [...chain];
    if (action) next[idx] = action;
    else next.splice(idx, 1);
    onChange(next.length ? next : undefined);
  };
  const paramInput = (action: RecoveryAction, set: (a: RecoveryAction) => void) => {
    switch (action.kind) {
      case 'retry':
        return (
          <label className="block">max attempts
            <input type="number" min={1} max={5} value={action.maxAttempts}
              onChange={(e) => set({ ...action, maxAttempts: Number(e.target.value) || 1 })}
              className="w-14 border rounded px-1 text-[11px]" />
          </label>
        );
      case 'fallback':
        return (
          <label className="block">label
            <input value={action.label}
              onChange={(e) => set({ ...action, label: e.target.value })}
              className="border rounded px-1 text-[11px] w-28" />
          </label>
        );
      case 'route_human':
        return (
          <label className="block">prompt
            <input value={action.prompt}
              onChange={(e) => set({ ...action, prompt: e.target.value })}
              className="border rounded px-1 text-[11px] w-36" />
          </label>
        );
      case 'safe_stop':
        return (
          <label className="block">reason
            <input value={action.reason}
              onChange={(e) => set({ ...action, reason: e.target.value })}
              className="border rounded px-1 text-[11px] w-36" />
          </label>
        );
      case 'default':
        return (
          <label className="block">value (JSON)
            <input defaultValue={JSON.stringify(action.value)}
              onBlur={(e) => {
                try { set({ ...action, value: JSON.parse(e.target.value) }); } catch { /* keep old */ }
              }}
              className="border rounded px-1 text-[11px] w-36" />
          </label>
        );
      default:
        return null;
    }
  };
  const selectFor = (idx: number, current?: RecoveryAction) => (
    <select
      className="border rounded px-1 py-0.5 text-[11px]"
      value={current?.kind ?? ''}
      onChange={(e) => {
        const kind = e.target.value as RecoveryAction['kind'] | '';
        if (!kind) { setAt(idx, undefined); return; }
        const preset: RecoveryAction =
          kind === 'retry' ? { kind, maxAttempts: 2 } :
          kind === 'fallback' ? { kind, fallbackKey: 'generic_fallback', label: 'Fallback handler' } :
          kind === 'repair' ? { kind } :
          kind === 'default' ? { kind, value: { note: 'safe default' } } :
          kind === 'route_human' ? { kind, prompt: 'A human should review this step' } :
          { kind: 'safe_stop', reason: 'Stopped for safety' };
        const next = [...chain];
        next[idx] = preset;
        onChange(next);
      }}>
      <option value="">{idx === 0 ? 'none (fail hard)' : '— chain ends —'}</option>
      {RECOVERY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
    </select>
  );
  return (
    <div className="text-xs bg-teal-50 border border-teal-200 rounded p-2 space-y-1">
      <div className="font-semibold">Recovery strategy</div>
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-slate-400">on failure:</span>
        {selectFor(0, first)}
        {first && paramInput(first, (a) => setAt(0, a))}
      </div>
      {first?.kind === 'retry' && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-slate-400">then:</span>
          {selectFor(1, second)}
          {second && paramInput(second, (a) => setAt(1, a))}
        </div>
      )}
      <div className="text-[10px] text-slate-400">Chained strategies run in order — e.g. retry twice, then fail over.</div>
    </div>
  );
}

function safeJson(v: unknown) {
  try { return JSON.stringify(v, null, 1); } catch { return String(v); }
}
