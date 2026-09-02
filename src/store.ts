import { create } from 'zustand';
import type {
  BlockKind, FailureMode, RecoveryChain, RunResult, StepStatus, TraceEntry, WorkflowDefinition,
} from './engine/types';
import { createRuntime, executeWorkflow, topoSort, type Runtime } from './engine/executor';
import { PUZZLES, GENERIC_HANDLERS, type Puzzle } from './puzzles';

interface HumanDecision { decision: 'approved' | 'edited' | 'rejected'; edited?: unknown }

interface AppState {
  puzzle: Puzzle;
  workflow: WorkflowDefinition;
  armed: Record<string, FailureMode[]>;
  statusByStep: Record<string, StepStatus>;
  trace: TraceEntry[];
  result: RunResult | null;
  running: boolean;
  /** Build mode: add/remove/connect blocks and configure recovery. */
  editMode: boolean;
  /** Human decisions recorded while a run is paused. */
  decisions: Record<string, HumanDecision>;
  pausedStepId: string | null;
  selectedStepId: string | null;

  selectPuzzle: (id: string) => void;
  toggleFailure: (stepId: string, mode: FailureMode) => void;
  selectStep: (stepId: string | null) => void;
  decide: (stepId: string, d: HumanDecision) => void;
  run: (resume?: boolean) => Promise<void>;
  /** Resume a stopped_safe run from its last successful step (puzzle 8). */
  resumeFromStop: () => Promise<void>;
  reset: () => void;
  setEditMode: (on: boolean) => void;
  addStep: (kind: BlockKind) => void;
  removeStep: (stepId: string) => void;
  connect: (from: string, to: string) => boolean;
  disconnect: (edgeId: string) => void;
  moveNode: (stepId: string, position: { x: number; y: number }) => void;
  setRecovery: (stepId: string, recovery: RecoveryChain | undefined) => void;
}

const cloneWorkflow = (p: Puzzle): WorkflowDefinition => JSON.parse(JSON.stringify(p.workflow));

const freshRunState = () => ({
  statusByStep: {}, trace: [] as TraceEntry[], result: null as RunResult | null,
  decisions: {}, pausedStepId: null as string | null, selectedStepId: null as string | null,
});

export const useStore = create<AppState>((set, get) => {
  // One runtime per puzzle selection: execution counters persist across runs
  // so puzzle 8's provider can "come back" after a resume.
  let runtime: Runtime = createRuntime();

  return {
    puzzle: PUZZLES[0],
    workflow: cloneWorkflow(PUZZLES[0]),
    armed: JSON.parse(JSON.stringify(PUZZLES[0].suggestedFailures ?? {})),
    editMode: false,
    running: false,
    ...freshRunState(),

    selectPuzzle: (id) => {
      const p = PUZZLES.find((x) => x.id === id)!;
      runtime = createRuntime();
      set({
        puzzle: p,
        workflow: cloneWorkflow(p),
        armed: JSON.parse(JSON.stringify(p.suggestedFailures ?? {})),
        editMode: false,
        running: false,
        ...freshRunState(),
      });
    },

    toggleFailure: (stepId, mode) => {
      const armed = { ...get().armed };
      const list = armed[stepId] ?? [];
      armed[stepId] = list.includes(mode) ? list.filter((m) => m !== mode) : [...list, mode];
      set({ armed });
    },

    selectStep: (stepId) => set({ selectedStepId: stepId }),

    decide: (stepId, d) => {
      set({ decisions: { ...get().decisions, [stepId]: d } });
      // Re-run automatically after the decision so the user sees the outcome.
      void get().run(true);
    },

    run: async (resume = false) => {
      const s = get();
      if (s.running) return;
      set({
        running: true,
        trace: resume ? s.trace : [],
        statusByStep: resume ? s.statusByStep : {},
        result: null,
        pausedStepId: null,
      });
      const result = await executeWorkflow(runtime, {
        workflow: s.workflow,
        handlers: { ...GENERIC_HANDLERS, ...s.puzzle.handlers },
        armed: s.armed,
        humanDecisions: s.decisions,
        onTrace: (entry) => set({ trace: [...get().trace, entry] }),
        onStepStatus: (stepId, status) => set({
          statusByStep: { ...get().statusByStep, [stepId]: status },
          pausedStepId: status === 'paused' ? stepId : get().pausedStepId,
          // Auto-select the paused step so the decision UI is immediately visible.
          selectedStepId: status === 'paused' ? stepId : get().selectedStepId,
        }),
        stepDelayMs: 260,
      });
      set({
        result,
        running: false,
        // keep the decision panel up while paused; clear it otherwise
        pausedStepId: result.outcome === 'paused_human' ? get().pausedStepId : null,
      });
    },

    resumeFromStop: async () => {
      const s = get();
      if (s.running || !s.trace.length) return;
      // Last completed step before the stop/failed entry — resume there.
      const order = topoSort(s.workflow);
      const rank = new Map(order.map((id, i) => [id, i]));
      const lastGood = [...s.trace]
        .filter((t) => (t.status === 'completed' || t.status === 'recovered'))
        .sort((a, b) => (rank.get(a.stepId) ?? 0) - (rank.get(b.stepId) ?? 0))
        .pop();
      const failedAt = [...s.trace].reverse().find((t) => t.status === 'failed' || t.status === 'stopped');
      if (!lastGood || !failedAt) return;
      // Resume AT the failed step (it re-executes — this is the retry semantics
      // of puzzle 8), seeded with the last good output.
      set({
        running: true,
        statusByStep: { ...get().statusByStep, [failedAt.stepId]: 'pending' },
        result: null,
      });
      // Seed the join map with every output produced before the interruption.
      const resumeOutputs: Record<string, unknown> = {};
      for (const t of s.trace) {
        if ((t.status === 'completed' || t.status === 'recovered') && t.output !== undefined) {
          resumeOutputs[t.stepId] = t.output;
        }
      }
      const result = await executeWorkflow(runtime, {
        workflow: s.workflow,
        handlers: { ...GENERIC_HANDLERS, ...s.puzzle.handlers },
        armed: s.armed,
        humanDecisions: s.decisions,
        resumeFromStepId: failedAt.stepId,
        resumePayload: lastGood.output,
        resumeOutputs,
        onTrace: (entry) => set({ trace: [...get().trace, entry] }),
        onStepStatus: (stepId, status) => set({
          statusByStep: { ...get().statusByStep, [stepId]: status },
        }),
        stepDelayMs: 260,
      });
      set({ result, running: false });
    },

    reset: () => {
      const s = get();
      runtime = createRuntime();
      set({
        workflow: cloneWorkflow(s.puzzle),
        armed: JSON.parse(JSON.stringify(s.puzzle.suggestedFailures ?? {})),
        ...freshRunState(),
      });
    },

    setEditMode: (on) => set({ editMode: on }),

    addStep: (kind) => {
      const s = get();
      const id = `${kind}_${Date.now().toString(36).slice(-4)}`;
      const maxX = s.workflow.steps.reduce((m, st) => Math.max(m, st.position.x), 0);
      const step = {
        id,
        kind,
        title: `${kind[0].toUpperCase()}${kind.slice(1)} (added)`,
        position: { x: maxX + 130, y: 60 + s.workflow.steps.length * 40 },
        handlerKey: `generic_${kind}`,
        armedFailures: [] as FailureMode[],
      };
      set({
        workflow: { ...s.workflow, steps: [...s.workflow.steps, step] },
        selectedStepId: id,
      });
    },

    removeStep: (stepId) => {
      const s = get();
      set({
        workflow: {
          ...s.workflow,
          steps: s.workflow.steps.filter((st) => st.id !== stepId),
          edges: s.workflow.edges.filter((e) => e.from !== stepId && e.to !== stepId),
        },
        armed: Object.fromEntries(Object.entries(s.armed).filter(([k]) => k !== stepId)),
        selectedStepId: null,
      });
    },

    connect: (from, to) => {
      const s = get();
      if (from === to) return false;
      if (s.workflow.edges.some((e) => e.from === from && e.to === to)) return false;
      // Reject connections that would create a cycle.
      const adj = new Map<string, string[]>();
      for (const e of s.workflow.edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
      const reaches = (start: string, target: string): boolean => {
        if (start === target) return true;
        return (adj.get(start) ?? []).some((n) => reaches(n, target));
      };
      if (reaches(to, from)) return false;
      set({
        workflow: {
          ...s.workflow,
          edges: [...s.workflow.edges, { id: `e_${Date.now().toString(36).slice(-5)}`, from, to }],
        },
      });
      return true;
    },

    disconnect: (edgeId) => {
      const s = get();
      set({ workflow: { ...s.workflow, edges: s.workflow.edges.filter((e) => e.id !== edgeId) } });
    },

    moveNode: (stepId, position) => {
      const s = get();
      set({
        workflow: {
          ...s.workflow,
          steps: s.workflow.steps.map((st) => (st.id === stepId ? { ...st, position } : st)),
        },
      });
    },

    setRecovery: (stepId, recovery) => {
      const s = get();
      set({
        workflow: {
          ...s.workflow,
          steps: s.workflow.steps.map((st) => (st.id === stepId ? { ...st, recovery } : st)),
        },
      });
    },
  };
});
