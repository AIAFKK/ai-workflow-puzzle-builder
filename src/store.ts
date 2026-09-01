import { create } from 'zustand';
import type { FailureMode, RunResult, StepStatus, TraceEntry, WorkflowDefinition } from './engine/types';
import { createRuntime, executeWorkflow } from './engine/executor';
import { PUZZLES, type Puzzle } from './puzzles';

interface HumanDecision { decision: 'approved' | 'edited' | 'rejected'; edited?: unknown }

interface AppState {
  puzzle: Puzzle;
  workflow: WorkflowDefinition;
  armed: Record<string, FailureMode[]>;
  statusByStep: Record<string, StepStatus>;
  trace: TraceEntry[];
  result: RunResult | null;
  running: boolean;
  /** Human decisions recorded while a run is paused. */
  decisions: Record<string, HumanDecision>;
  pausedStepId: string | null;
  selectedStepId: string | null;

  selectPuzzle: (id: string) => void;
  toggleFailure: (stepId: string, mode: FailureMode) => void;
  selectStep: (stepId: string | null) => void;
  decide: (stepId: string, d: HumanDecision) => void;
  run: (resume?: boolean) => Promise<void>;
  reset: () => void;
}

const cloneWorkflow = (p: Puzzle): WorkflowDefinition => JSON.parse(JSON.stringify(p.workflow));

export const useStore = create<AppState>((set, get) => ({
  puzzle: PUZZLES[0],
  workflow: cloneWorkflow(PUZZLES[0]),
  armed: JSON.parse(JSON.stringify(PUZZLES[0].suggestedFailures ?? {})),
  statusByStep: {},
  trace: [],
  result: null,
  running: false,
  decisions: {},
  pausedStepId: null,
  selectedStepId: null,

  selectPuzzle: (id) => {
    const p = PUZZLES.find((x) => x.id === id)!;
    set({
      puzzle: p,
      workflow: cloneWorkflow(p),
      armed: JSON.parse(JSON.stringify(p.suggestedFailures ?? {})),
      statusByStep: {}, trace: [], result: null, decisions: {}, pausedStepId: null, selectedStepId: null,
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
    set({ running: true, trace: resume ? s.trace : [], result: null, pausedStepId: null });
    const runtime = createRuntime();
    const result = await executeWorkflow(runtime, {
      workflow: s.workflow,
      handlers: s.puzzle.handlers,
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
    set({ result, running: false });
  },

  reset: () => {
    const s = get();
    set({
      workflow: cloneWorkflow(s.puzzle),
      armed: JSON.parse(JSON.stringify(s.puzzle.suggestedFailures ?? {})),
      statusByStep: {}, trace: [], result: null, decisions: {}, pausedStepId: null, selectedStepId: null,
    });
  },
}));
