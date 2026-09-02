// Core domain types for the AI Workflow Puzzle Builder engine.

export type BlockKind =
  | 'input'
  | 'model'
  | 'tool'
  | 'retrieval'
  | 'condition'
  | 'validator'
  | 'retry'
  | 'fallback'
  | 'human'
  | 'output';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'retrying' // transient state surfaced while a retry is in flight
  | 'recovered'
  | 'stopped';

/** Deterministic failure injections a user can toggle per step. */
export type FailureMode =
  | 'model_timeout'
  | 'tool_timeout'
  | 'invalid_json'
  | 'missing_field'
  | 'schema_validation'
  | 'empty_retrieval'
  | 'low_confidence'
  | 'tool_failure'
  | 'human_rejection';

/** Recovery strategies users may attach to steps. */
export type RecoveryAction =
  | { kind: 'retry'; maxAttempts: number; delayMs?: number }
  | { kind: 'fallback'; fallbackKey: string; label: string }
  | { kind: 'repair' } // ask the mock model to repair malformed output
  | { kind: 'default'; value: unknown }
  | { kind: 'route_human'; prompt: string }
  | { kind: 'safe_stop'; reason: string };

/**
 * A step may carry a single recovery action or a chain tried in order —
 * e.g. retry twice, then fail over to a fallback provider.
 */
export type RecoveryChain = RecoveryAction | RecoveryAction[];

export interface HandlerCtx {
  /** How many times this step's handler has executed across runs (1-based). */
  executionCount: number;
}

export interface StepConfig {
  id: string;
  kind: BlockKind;
  title: string;
  description?: string;
  /** Position on the React Flow canvas. */
  position: { x: number; y: number };
  /** Model/tool/validator payload key resolved by the puzzle runtime. */
  handlerKey?: string;
  /** Declarative validation descriptor when kind === 'validator'. */
  validation?: ValidationSpec;
  recovery?: RecoveryChain;
  /** Failure injections currently armed for this step. */
  armedFailures: FailureMode[];
  /** Branch labels for condition steps: edgeId -> label. */
  branches?: Array<{ edgeId: string; label: string; when: 'valid' | 'invalid' }>;
}

export interface ValidationSpec {
  /** Field name the validator inspects on the flowing payload. */
  field?: string;
  type: 'required' | 'string' | 'number' | 'enum' | 'format' | 'threshold' | 'evidence' | 'nonEmptyItems';
  /** enum options, numeric threshold or format name depending on `type`. */
  options?: string[];
  threshold?: number;
  format?: 'json' | 'iso-date' | 'email';
  /** for nonEmptyItems: the sub-field every array item must carry non-blank. */
  sub?: string;
}

export interface WorkflowDefinition {
  id: string;
  puzzleId: string;
  steps: StepConfig[];
  edges: Array<{ id: string; from: string; to: string }>;
}

export interface TraceEntry {
  stepId: string;
  status: StepStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  recovery?: string;
  humanDecision?: 'approved' | 'edited' | 'rejected';
  attempt: number;
  at: number; // wall-clock ms
  /** True when this entry belongs to a resumed segment (puzzle 8). */
  resumed?: boolean;
}

export interface RunResult {
  workflowId: string;
  outcome: 'completed' | 'failed' | 'stopped_safe' | 'paused_human';
  finalOutput?: unknown;
  trace: TraceEntry[];
  reliability: ReliabilityReport;
}

export interface ReliabilityReport {
  completed: boolean;
  finalOutputValid: boolean;
  injectedFailuresHandled: string[];
  totalRetries: number;
  fallbackActivated: string[];
  humanInterventions: string[];
  unhandledErrors: string[];
  stoppedSafely: boolean;
  score: number; // 0..100 heuristic reliability score
  notes: string[];
}
