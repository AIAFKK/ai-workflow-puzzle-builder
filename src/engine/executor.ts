// Deterministic step-by-step DAG executor with failure injection and recovery.
// Pure TypeScript: no React, no network — every model/tool call resolves
// through the puzzle runtime so seeded puzzles run fully offline.

import type {
  FailureMode,
  RecoveryAction,
  ReliabilityReport,
  RunResult,
  StepConfig,
  TraceEntry,
  WorkflowDefinition,
} from './types';

export type StepOutcome =
  | { status: 'completed'; output: unknown }
  | { status: 'failed'; error: string }
  | { status: 'paused'; reason: string }
  | { status: 'stopped'; reason: string };

export interface HandlerContext {
  /** Payload flowing into the step. */
  input: unknown;
  /** Deterministic mock implementations keyed by handlerKey. */
  handlers: Record<string, (input: unknown) => unknown>;
  /** Failures armed by the user for this run, per step. */
  armed: Record<string, FailureMode[]>;
  /** Human decision injected from the UI while paused. */
  humanDecision?: { decision: 'approved' | 'edited' | 'rejected'; edited?: unknown };
  /** Signal used by the UI to know why a step paused. */
  stepId: string;
}

export interface Runtime {
  /** Execute one step: apply injections, run handler, apply validation. */
  runStep(step: StepConfig, ctx: HandlerContext): Promise<StepOutcome>;
  /** Apply a validator descriptor to a candidate output. */
  validate(step: StepConfig, output: unknown): { ok: boolean; error?: string };
}

const FAILURE_MESSAGES: Record<FailureMode, string> = {
  model_timeout: 'AI model timed out after 3000ms',
  tool_timeout: 'Tool or API timed out after 5000ms',
  invalid_json: 'Model returned malformed JSON',
  missing_field: 'Required field is missing from the output',
  schema_validation: 'Output failed schema validation',
  empty_retrieval: 'Retrieval returned zero results',
  low_confidence: 'Model confidence below threshold (0.55)',
  tool_failure: 'Tool failed with INTERNAL_ERROR',
  human_rejection: 'Human reviewer rejected the step',
};

export function createRuntime(): Runtime {
  const runtime: Runtime = {
    async runStep(step, ctx) {
      const armed = ctx.armed[step.id] ?? [];
      const injected = armed.find((f) => appliesTo(f, step));
      if (injected) {
        return { status: 'failed', error: FAILURE_MESSAGES[injected] };
      }
      const handler = step.handlerKey ? ctx.handlers[step.handlerKey] : undefined;
      if (!handler) {
        return { status: 'completed', output: ctx.input };
      }
      let output: unknown;
      try {
        output = handler(ctx.input);
      } catch (err) {
        return { status: 'failed', error: String(err) };
      }
      if (step.kind === 'validator' || step.kind === 'human' || step.kind === 'condition') {
        const verdict = runtime.validate(step, output);
        if (!verdict.ok) {
          return { status: 'failed', error: verdict.error ?? 'validation failed' };
        }
      }
      if (step.kind === 'human') {
        if (ctx.humanDecision?.decision === 'rejected') {
          return { status: 'failed', error: FAILURE_MESSAGES.human_rejection };
        }
        return { status: 'paused', reason: 'Awaiting human decision' };
      }
      return { status: 'completed', output };
    },
    validate(step, output) {
      const v = step.validation;
      if (!v) return { ok: true };
      const value = v.field ? (output as Record<string, unknown>)?.[v.field] : output;
      switch (v.type) {
        case 'required':
          return value === undefined || value === null || value === ''
            ? { ok: false, error: `Missing required field: ${v.field ?? 'value'}` }
            : { ok: true };
        case 'string':
          return typeof value === 'string' ? { ok: true } : { ok: false, error: `${v.field ?? 'value'} must be a string` };
        case 'number':
          return typeof value === 'number' ? { ok: true } : { ok: false, error: `${v.field ?? 'value'} must be a number` };
        case 'enum':
          return v.options?.includes(String(value))
            ? { ok: true }
            : { ok: false, error: `${v.field ?? 'value'} must be one of: ${v.options?.join(', ')}` };
        case 'threshold': {
          const num = (output as Record<string, unknown>)?.confidence;
          return typeof num === 'number' && num >= (v.threshold ?? 0)
            ? { ok: true }
            : { ok: false, error: `confidence ${(num as number)?.toFixed?.(2)} is below threshold ${v.threshold}` };
        }
        case 'evidence':
          return Array.isArray(value) && value.length > 0
            ? { ok: true }
            : { ok: false, error: 'No supporting evidence retrieved' };
        case 'format':
          return v.format ? checkFormat(v.format, value) : { ok: true };
      }
    },
  };
  return runtime;
}

function appliesTo(f: FailureMode, step: StepConfig): boolean {
  switch (f) {
    case 'model_timeout':
    case 'invalid_json':
    case 'missing_field':
    case 'low_confidence':
      return step.kind === 'model' || step.kind === 'tool';
    case 'tool_timeout':
    case 'tool_failure':
      return step.kind === 'tool' || step.kind === 'retrieval';
    case 'schema_validation':
      return step.kind === 'validator' || step.kind === 'model';
    case 'empty_retrieval':
      return step.kind === 'retrieval';
    case 'human_rejection':
      return step.kind === 'human';
  }
}

function checkFormat(format: 'json' | 'iso-date' | 'email', value: unknown) {
  const s = String(value ?? '');
  if (format === 'json') {
    try {
      JSON.parse(s);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Output is not valid JSON' };
    }
  }
  if (format === 'email') {
    return /.+@.+\..+/.test(s) ? { ok: true } : { ok: false, error: 'Output is not a valid email' };
  }
  return !isNaN(Date.parse(s)) ? { ok: true } : { ok: false, error: 'Output is not an ISO date' };
}

export interface ExecuteOptions {
  workflow: WorkflowDefinition;
  handlers: Record<string, (input: unknown) => unknown>;
  armed: Record<string, FailureMode[]>;
  /** Resumed human decisions keyed by stepId. */
  humanDecisions?: Record<string, { decision: 'approved' | 'edited' | 'rejected'; edited?: unknown }>;
  /** Step id to resume execution from (last successful step). */
  resumeFromStepId?: string;
  onTrace?: (entry: TraceEntry) => void;
  onStepStatus?: (stepId: string, status: TraceEntry['status']) => void;
  /** Artificial delay per step so the UI can animate (ms). */
  stepDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function executeWorkflow(
  runtime: Runtime,
  opts: ExecuteOptions,
): Promise<RunResult> {
  const { workflow, handlers, armed } = opts;
  const trace: TraceEntry[] = [];
  const attempts = new Map<string, number>();
  const retriesUsed = new Map<string, number>();
  const fallbacksUsed: string[] = [];
  const humanSteps: string[] = [];
  const handled: string[] = [];
  const unhandled: string[] = [];

  // Topological walk over the linear chain (puzzles are sequential DAGs).
  const order = topoSort(workflow);
  let payload: unknown;
  let initialPayload: unknown; // first input step output, used by fallback handlers
  let started = opts.resumeFromStepId ? order.indexOf(opts.resumeFromStepId) : 0;
  if (started < 0) started = 0;

  let outcome: RunResult['outcome'] = 'completed';
  let finalOutput: unknown;

  outer: for (let i = started; i < order.length; i++) {
    const stepId = order[i];
    const step = workflow.steps.find((s) => s.id === stepId)!;
    if (step.kind === 'input') {
      payload = handlers[step.handlerKey ?? 'input']?.(undefined) ?? null;
      if (initialPayload === undefined) initialPayload = payload;
      opts.onStepStatus?.(stepId, 'completed');
      push(trace, opts, {
        stepId, status: 'completed', output: payload, attempt: 1, at: Date.now(),
      });
      continue;
    }

    let attempt = (attempts.get(stepId) ?? 0) + 1;
    attempts.set(stepId, attempt);
    opts.onStepStatus?.(stepId, 'running');

    let result = await runtime.runStep(step, {
      input: payload,
      handlers,
      armed,
      humanDecision: opts.humanDecisions?.[stepId],
      stepId,
    });

    // Human pause: record and wait for decision (single decision pass).
    if (result.status === 'paused') {
      push(trace, opts, {
        stepId, status: 'paused', input: payload, output: payload,
        attempt, at: Date.now(), error: result.reason,
      });
      opts.onStepStatus?.(stepId, 'paused');
      const decision = opts.humanDecisions?.[stepId];
      if (!decision) {
        outcome = 'paused_human';
        finalOutput = payload;
        break outer;
      }
      humanSteps.push(stepId);
      if (decision.decision === 'edited' && decision.edited !== undefined) {
        payload = decision.edited;
      }
      if (decision.decision === 'rejected') {
        push(trace, opts, {
          stepId, status: 'failed', input: payload, error: FAILURE_MESSAGES.human_rejection,
          humanDecision: 'rejected', attempt, at: Date.now(),
        });
        const recovered = tryRecover(step, {
          retriesUsed, fallbacksUsed, handled, unhandled, trace, opts, attempt, payload,
        });
        if (recovered === 'stop') {
          outcome = 'stopped_safe';
          finalOutput = payload;
          break outer;
        }
        payload = recovered;
        continue;
      }
      push(trace, opts, {
        stepId, status: 'completed', input: payload, output: payload,
        humanDecision: decision.decision === 'edited' ? 'edited' : 'approved',
        attempt, at: Date.now(),
      });
      opts.onStepStatus?.(stepId, 'completed');
      continue;
    }

    if (result.status === 'failed') {
      push(trace, opts, {
        stepId, status: 'failed', input: payload, error: result.error, attempt, at: Date.now(),
      });
      opts.onStepStatus?.(stepId, 'failed');
      const effStep = step.recovery ? step : upstreamRecovery(workflow, stepId) ?? step;
      const recovered = tryRecover(effStep, {
        retriesUsed, fallbacksUsed, handled, unhandled, trace, opts, attempt, payload,
      });
      if (recovered === 'stop') {
        outcome = 'stopped_safe';
        finalOutput = payload;
        break outer;
      }
      if (recovered === 'giveup') {
        outcome = 'failed';
        finalOutput = undefined;
        break outer;
      }
      payload = recovered;
      continue;
    }

    if (result.status === 'stopped') {
      outcome = 'stopped_safe';
      finalOutput = payload;
      push(trace, opts, { stepId, status: 'stopped', recovery: result.reason, attempt, at: Date.now() });
      break outer;
    }
    payload = result.output;
    push(trace, opts, {
      stepId, status: 'completed', input: payload,
      output: payload, attempt, at: Date.now(),
    });
    opts.onStepStatus?.(stepId, 'completed');
    if (opts.stepDelayMs) await sleep(opts.stepDelayMs);
  }

  if (outcome !== 'failed' && outcome !== 'stopped_safe' && outcome !== 'paused_human') {
    outcome = 'completed';
    finalOutput = payload;
  }

  const reliability = buildReport({
    outcome, trace, workflow, retriesUsed, fallbacksUsed, humanSteps, handled, unhandled,
  });
  return { workflowId: workflow.id, outcome, finalOutput, trace, reliability };

  function tryRecover(
    step: StepConfig,
    ctx2: {
      retriesUsed: Map<string, number>; fallbacksUsed: string[]; handled: string[];
      unhandled: string[]; trace: TraceEntry[]; opts: ExecuteOptions; attempt: number; payload: unknown;
    },
  ): unknown | 'stop' | 'giveup' {
    const recovery: RecoveryAction | undefined = step.recovery;
    if (!recovery) {
      ctx2.unhandled.push(`${step.title}: no recovery configured`);
      return 'giveup';
    }
    switch (recovery.kind) {
      case 'retry': {
        const used = ctx2.retriesUsed.get(step.id) ?? 0;
        if (used < recovery.maxAttempts) {
          ctx2.retriesUsed.set(step.id, used + 1);
          opts.onStepStatus?.(step.id, 'retrying');
          push(ctx2.trace, opts, {
            stepId: step.id, status: 'retrying', recovery: `retry ${used + 1}/${recovery.maxAttempts}`,
            attempt: ctx2.attempt + used + 1, at: Date.now(),
          });
          // Deterministic puzzles: a retry only succeeds when the armed
          // failure has been disarmed by the user OR the handler is clean.
          const stillArmed = (armed[step.id] ?? []).some((f) => appliesTo(f, step));
          if (!stillArmed) {
            const retry = await_run(step, ctx2.payload);
            if (retry.status === 'completed') {
              ctx2.handled.push(`${step.title}: recovered after retry`);
              opts.onStepStatus?.(step.id, 'recovered');
              push(ctx2.trace, opts, {
                stepId: step.id, status: 'recovered', output: retry.output,
                recovery: `retry ${used + 1}/${recovery.maxAttempts} succeeded`,
                attempt: ctx2.attempt + used + 1, at: Date.now(),
              });
              return retry.output;
            }
          }
          ctx2.unhandled.push(`${step.title}: retries exhausted`);
          return 'giveup';
        }
        ctx2.unhandled.push(`${step.title}: retries exhausted`);
        return 'giveup';
      }
      case 'fallback': {
        const fb = handlers[recovery.fallbackKey];
        if (fb) {
          const out = fb(initialPayload ?? ctx2.payload);
          ctx2.fallbacksUsed.push(`${step.title} → ${recovery.label}`);
          ctx2.handled.push(`${step.title}: fell back to ${recovery.label}`);
          opts.onStepStatus?.(step.id, 'recovered');
          push(ctx2.trace, opts, {
            stepId: step.id, status: 'recovered', output: out,
            recovery: `fallback → ${recovery.label}`, attempt: ctx2.attempt, at: Date.now(),
          });
          return out;
        }
        ctx2.unhandled.push(`${step.title}: fallback handler missing`);
        return 'giveup';
      }
      case 'repair': {
        const repairKey = `${step.handlerKey ?? ''}__repair`;
        const repair = handlers[repairKey];
        if (repair) {
          const out = repair(ctx2.payload);
          ctx2.handled.push(`${step.title}: output repaired`);
          opts.onStepStatus?.(step.id, 'recovered');
          push(ctx2.trace, opts, {
            stepId: step.id, status: 'recovered', output: out, recovery: 'repaired malformed output',
            attempt: ctx2.attempt, at: Date.now(),
          });
          return out;
        }
        ctx2.unhandled.push(`${step.title}: no repair handler`);
        return 'giveup';
      }
      case 'default': {
        ctx2.handled.push(`${step.title}: used safe default`);
        opts.onStepStatus?.(step.id, 'recovered');
        push(ctx2.trace, opts, {
          stepId: step.id, status: 'recovered', output: recovery.value,
          recovery: 'safe default applied', attempt: ctx2.attempt, at: Date.now(),
        });
        return recovery.value;
      }
      case 'route_human': {
        const decision = opts.humanDecisions?.[step.id];
        humanSteps.push(step.id);
        if (!decision) {
          push(ctx2.trace, opts, {
            stepId: step.id, status: 'paused', input: ctx2.payload,
            error: recovery.prompt, attempt: ctx2.attempt, at: Date.now(),
          });
          // Treat as safe stop for this pass; UI re-runs with the decision.
          return 'stop';
        }
        if (decision.decision === 'rejected') {
          return 'stop';
        }
        return decision.decision === 'edited' && decision.edited !== undefined
          ? decision.edited
          : ctx2.payload;
      }
      case 'safe_stop': {
        ctx2.handled.push(`${step.title}: stopped safely (${recovery.reason})`);
        push(ctx2.trace, opts, {
          stepId: step.id, status: 'stopped', recovery: recovery.reason,
          attempt: ctx2.attempt, at: Date.now(),
        });
        opts.onStepStatus?.(step.id, 'stopped');
        return 'stop';
      }
    }
  }

  function await_run(step: StepConfig, input: unknown): StepOutcome {
    // Synchronous deterministic handler pass with injections cleared.
    const handler = step.handlerKey ? handlers[step.handlerKey] : undefined;
    if (!handler) return { status: 'completed', output: input };
    try {
      return { status: 'completed', output: handler(input) };
    } catch (e) {
      return { status: 'failed', error: String(e) };
    }
  }
}

function push(trace: TraceEntry[], opts: ExecuteOptions, entry: TraceEntry) {
  trace.push(entry);
  opts.onTrace?.(entry);
}

export function topoSort(workflow: WorkflowDefinition): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of workflow.steps) {
    indeg.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const e of workflow.edges) {
    adj.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = workflow.steps.filter((s) => (indeg.get(s.id) ?? 0) === 0).map((s) => s.id);
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 1) - 1);
      if ((indeg.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  return out.length === workflow.steps.length ? out : workflow.steps.map((s) => s.id);
}

function upstreamRecovery(workflow: WorkflowDefinition, stepId: string): StepConfig | null {
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  let frontier = workflow.edges.filter((e) => e.to === stepId).map((e) => e.from);
  while (frontier.length) {
    const id = frontier.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const step = byId.get(id);
    if (step?.recovery) return step;
    frontier.push(...workflow.edges.filter((e) => e.to === id).map((e) => e.from));
  }
  return null;
}

export function buildReport(ctx: {
  outcome: RunResult['outcome'];
  trace: TraceEntry[];
  workflow: WorkflowDefinition;
  retriesUsed: Map<string, number>;
  fallbacksUsed: string[];
  humanSteps: string[];
  handled: string[];
  unhandled: string[];
}): ReliabilityReport {
  const { outcome, retriesUsed, fallbacksUsed, humanSteps, handled, unhandled } = ctx;
  const totalRetries = [...retriesUsed.values()].reduce((a, b) => a + b, 0);
  const completed = outcome === 'completed';
  const stoppedSafely = outcome === 'stopped_safe';
  const notes: string[] = [];
  if (handled.length) notes.push(...handled.map((h) => `✓ ${h}`));
  if (unhandled.length) notes.push(...unhandled.map((u) => `✗ ${u}`));

  let score = 0;
  if (completed) score += 55;
  else if (stoppedSafely) score += 40;
  else if (ctx.outcome === 'paused_human') score += 25; // waiting for a human is by design
  if (handled.length) score += Math.min(25, handled.length * 8);
  if (fallbacksUsed.length) score += 5;
  if (humanSteps.length) score += 5;
  if (unhandled.length) score -= Math.min(30, unhandled.length * 10);
  score = Math.max(0, Math.min(100, score));

  return {
    completed,
    finalOutputValid: completed,
    injectedFailuresHandled: handled,
    totalRetries,
    fallbackActivated: fallbacksUsed,
    humanInterventions: humanSteps,
    unhandledErrors: unhandled,
    stoppedSafely,
    score,
    notes,
  };
}
