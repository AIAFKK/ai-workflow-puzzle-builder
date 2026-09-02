// Deterministic step-by-step DAG executor with failure injection and recovery.
// Pure TypeScript: no React, no network — every model/tool call resolves
// through the puzzle runtime so seeded puzzles run fully offline.

import type {
  FailureMode,
  HandlerCtx,
  RecoveryAction,
  RecoveryChain,
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

export type MockHandler = (input: unknown, ctx?: HandlerCtx) => unknown;

export interface HandlerContext {
  /** Payload flowing into the step. */
  input: unknown;
  /** Deterministic mock implementations keyed by handlerKey. */
  handlers: Record<string, MockHandler>;
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
  /** Synchronous core of runStep — handlers are deterministic and sync. */
  runStepSync(step: StepConfig, ctx: HandlerContext): StepOutcome;
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
  // Persists across runs on purpose: puzzle 8 simulates an interruption whose
  // provider succeeds on its second execution (after the user hits Resume).
  const execCount = new Map<string, number>();
  const runtime: Runtime = {
    runStep: (step, ctx) => Promise.resolve(runtime.runStepSync(step, ctx)),
    runStepSync(step, ctx) {
      execCount.set(step.id, (execCount.get(step.id) ?? 0) + 1);
      const handlerCtx: HandlerCtx = { executionCount: execCount.get(step.id)! };
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
        output = handler(ctx.input, handlerCtx);
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
        case 'nonEmptyItems': {
          const sub = v.sub ?? 'owner';
          const arr = (output as Record<string, unknown>)?.[v.field ?? ''];
          if (!Array.isArray(arr) || arr.length === 0) {
            return { ok: false, error: `Missing required field: ${v.field ?? 'value'}` };
          }
          const bad = (arr as Array<Record<string, unknown>>).findIndex(
            (item) => item == null || String(item[sub] ?? '').trim() === '',
          );
          return bad >= 0
            ? { ok: false, error: `${v.field}[${bad}].${sub} is empty — every item needs a ${sub}` }
            : { ok: true };
        }
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

const asChain = (r: RecoveryChain | undefined): RecoveryAction[] =>
  Array.isArray(r) ? r : r ? [r] : [];

export interface ExecuteOptions {
  workflow: WorkflowDefinition;
  handlers: Record<string, MockHandler>;
  armed: Record<string, FailureMode[]>;
  /** Resumed human decisions keyed by stepId. */
  humanDecisions?: Record<string, { decision: 'approved' | 'edited' | 'rejected'; edited?: unknown }>;
  /** Step id to resume execution from (last successful step). */
  resumeFromStepId?: string;
  /** Payload captured from the resumed step's last successful output. */
  resumePayload?: unknown;
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
  // Last output produced by each step — powers join (multi-predecessor) steps.
  const outputOf = new Map<string, unknown>();
  const resuming = !!opts.resumeFromStepId;

  const order = topoSort(workflow);
  let payload: unknown = opts.resumePayload ?? undefined;
  let initialPayload: unknown; // first input step output, used by fallback handlers
  let started = opts.resumeFromStepId ? order.indexOf(opts.resumeFromStepId) : 0;
  if (started < 0) started = 0;

  let outcome: RunResult['outcome'] = 'completed';
  let finalOutput: unknown;

  /** Input for a step: the single predecessor's output, or a joined bundle. */
  const inputFor = (stepId: string, fallback: unknown): unknown => {
    const preds = workflow.edges.filter((e) => e.to === stepId).map((e) => e.from);
    if (preds.length <= 1) return fallback;
    return {
      joined: preds.map((p) => ({ step: p, output: outputOf.get(p) ?? null })),
    };
  };

  outer: for (let i = started; i < order.length; i++) {
    const stepId = order[i];
    const step = workflow.steps.find((s) => s.id === stepId)!;
    if (step.kind === 'input') {
      payload = handlers[step.handlerKey ?? 'input']?.(undefined) ?? null;
      if (initialPayload === undefined) initialPayload = payload;
      outputOf.set(stepId, payload);
      opts.onStepStatus?.(stepId, 'completed');
      push(trace, opts, {
        stepId, status: 'completed', output: payload, attempt: 1, at: Date.now(), resumed: resuming,
      });
      continue;
    }

    const stepInput = inputFor(stepId, payload);
    let attempt = (attempts.get(stepId) ?? 0) + 1;
    attempts.set(stepId, attempt);
    opts.onStepStatus?.(stepId, 'running');

    let result = await runtime.runStep(step, {
      input: stepInput,
      handlers,
      armed,
      humanDecision: opts.humanDecisions?.[stepId],
      stepId,
    });

    // Human pause: record and wait for decision (single decision pass).
    if (result.status === 'paused') {
      push(trace, opts, {
        stepId, status: 'paused', input: stepInput, output: stepInput,
        attempt, at: Date.now(), error: result.reason, resumed: resuming,
      });
      opts.onStepStatus?.(stepId, 'paused');
      const decision = opts.humanDecisions?.[stepId];
      if (!decision) {
        outcome = 'paused_human';
        finalOutput = stepInput;
        break outer;
      }
      humanSteps.push(stepId);
      if (decision.decision === 'edited' && decision.edited !== undefined) {
        payload = decision.edited;
      }
      if (decision.decision === 'rejected') {
        push(trace, opts, {
          stepId, status: 'failed', input: stepInput, error: FAILURE_MESSAGES.human_rejection,
          humanDecision: 'rejected', attempt, at: Date.now(), resumed: resuming,
        });
        const recovered = tryRecover(step, stepInput, attempt);
        if (recovered === 'stop') {
          outcome = 'stopped_safe';
          finalOutput = stepInput;
          break outer;
        }
        payload = recovered;
        outputOf.set(stepId, payload);
        continue;
      }
      push(trace, opts, {
        stepId, status: 'completed', input: stepInput, output: payload,
        humanDecision: decision.decision === 'edited' ? 'edited' : 'approved',
        attempt, at: Date.now(), resumed: resuming,
      });
      opts.onStepStatus?.(stepId, 'completed');
      outputOf.set(stepId, payload);
      continue;
    }

    if (result.status === 'failed') {
      push(trace, opts, {
        stepId, status: 'failed', input: stepInput, error: result.error, attempt, at: Date.now(), resumed: resuming,
      });
      opts.onStepStatus?.(stepId, 'failed');
      const effStep = asChain(step.recovery).length ? step : upstreamRecovery(workflow, stepId) ?? step;
      const recovered = tryRecover(effStep, stepInput, attempt);
      if (recovered === 'stop') {
        outcome = 'stopped_safe';
        finalOutput = stepInput;
        break outer;
      }
      if (recovered === 'giveup') {
        outcome = 'failed';
        finalOutput = undefined;
        break outer;
      }
      payload = recovered;
      outputOf.set(stepId, payload);
      continue;
    }

    if (result.status === 'stopped') {
      outcome = 'stopped_safe';
      finalOutput = stepInput;
      push(trace, opts, { stepId, status: 'stopped', recovery: result.reason, attempt, at: Date.now(), resumed: resuming });
      break outer;
    }
    payload = result.output;
    outputOf.set(stepId, payload);
    push(trace, opts, {
      stepId, status: 'completed', input: stepInput,
      output: payload, attempt, at: Date.now(), resumed: resuming,
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

  /** Try the step's recovery chain in order; real retries re-execute the handler. */
  function tryRecover(
    step: StepConfig,
    failPayload: unknown,
    failAttempt: number,
  ): unknown | 'stop' | 'giveup' {
    const chain = asChain(step.recovery);
    if (!chain.length) {
      unhandled.push(`${step.title}: no recovery configured`);
      return 'giveup';
    }
    for (const recovery of chain) {
      switch (recovery.kind) {
        case 'retry': {
          const max = recovery.maxAttempts;
          // Spend the whole retry budget before moving to the next strategy.
          while ((retriesUsed.get(step.id) ?? 0) < max) {
            const used = retriesUsed.get(step.id) ?? 0;
            retriesUsed.set(step.id, used + 1);
            opts.onStepStatus?.(step.id, 'retrying');
            push(trace, opts, {
              stepId: step.id, status: 'retrying', recovery: `retry ${used + 1}/${max}`,
              attempt: failAttempt + used + 1, at: Date.now(), resumed: resuming,
            });
            const retry = await_run(step, failPayload);
            if (retry.status === 'completed') {
              handled.push(`${step.title}: recovered after retry ${used + 1}`);
              opts.onStepStatus?.(step.id, 'recovered');
              push(trace, opts, {
                stepId: step.id, status: 'recovered', output: retry.output,
                recovery: `retry ${used + 1}/${max} succeeded`,
                attempt: failAttempt + used + 1, at: Date.now(), resumed: resuming,
              });
              return retry.output;
            }
            push(trace, opts, {
              stepId: step.id, status: 'failed',
              error: retry.status === 'failed' ? retry.error : 'retry failed',
              attempt: failAttempt + used + 1, at: Date.now(), resumed: resuming,
            });
          }
          continue; // budget exhausted → try the next strategy in the chain
        }
        case 'fallback': {
          const fb = handlers[recovery.fallbackKey];
          if (fb) {
            const out = fb(initialPayload ?? failPayload);
            fallbacksUsed.push(`${step.title} → ${recovery.label}`);
            handled.push(`${step.title}: fell back to ${recovery.label}`);
            opts.onStepStatus?.(step.id, 'recovered');
            push(trace, opts, {
              stepId: step.id, status: 'recovered', output: out,
              recovery: `fallback → ${recovery.label}`, attempt: failAttempt, at: Date.now(), resumed: resuming,
            });
            return out;
          }
          continue;
        }
        case 'repair': {
          const repairKey = `${step.handlerKey ?? ''}__repair`;
          const repair = handlers[repairKey];
          if (repair) {
            const out = repair(failPayload);
            handled.push(`${step.title}: output repaired`);
            opts.onStepStatus?.(step.id, 'recovered');
            push(trace, opts, {
              stepId: step.id, status: 'recovered', output: out, recovery: 'repaired malformed output',
              attempt: failAttempt, at: Date.now(), resumed: resuming,
            });
            return out;
          }
          continue;
        }
        case 'default': {
          handled.push(`${step.title}: used safe default`);
          opts.onStepStatus?.(step.id, 'recovered');
          push(trace, opts, {
            stepId: step.id, status: 'recovered', output: recovery.value,
            recovery: 'safe default applied', attempt: failAttempt, at: Date.now(), resumed: resuming,
          });
          return recovery.value;
        }
        case 'route_human': {
          const decision = opts.humanDecisions?.[step.id];
          humanSteps.push(step.id);
          if (!decision) {
            push(trace, opts, {
              stepId: step.id, status: 'paused', input: failPayload,
              error: recovery.prompt, attempt: failAttempt, at: Date.now(), resumed: resuming,
            });
            // Treat as safe stop for this pass; UI re-runs with the decision.
            return 'stop';
          }
          if (decision.decision === 'rejected') {
            return 'stop';
          }
          return decision.decision === 'edited' && decision.edited !== undefined
            ? decision.edited
            : failPayload;
        }
        case 'safe_stop': {
          handled.push(`${step.title}: stopped safely (${recovery.reason})`);
          push(trace, opts, {
            stepId: step.id, status: 'stopped', recovery: recovery.reason,
            attempt: failAttempt, at: Date.now(), resumed: resuming,
          });
          opts.onStepStatus?.(step.id, 'stopped');
          return 'stop';
        }
      }
    }
    unhandled.push(`${step.title}: recovery chain exhausted`);
    return 'giveup';
  }

  function await_run(step: StepConfig, input: unknown): StepOutcome {
    // Re-execution goes through the same runtime so armed failures,
    // attempt counting and validation still apply during retries.
    return runtime.runStepSync(step, {
      input,
      handlers,
      armed,
      humanDecision: opts.humanDecisions?.[step.id],
      stepId: step.id,
    });
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

/** Nearest upstream step carrying a recovery config (validator inheritance). */
function upstreamRecovery(workflow: WorkflowDefinition, stepId: string): StepConfig | undefined {
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  const seen = new Set<string>([stepId]);
  let frontier = workflow.edges.filter((e) => e.to === stepId).map((e) => e.from);
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const step = byId.get(id);
      if (step && asChain(step.recovery).length) return step;
      for (const e of workflow.edges) if (e.from === id && !seen.has(e.to)) next.push(e.to);
    }
    frontier = next;
  }
  return undefined;
}

function buildReport(ctx: {
  outcome: RunResult['outcome'];
  trace: TraceEntry[];
  workflow: WorkflowDefinition;
  retriesUsed: Map<string, number>;
  fallbacksUsed: string[];
  humanSteps: string[];
  handled: string[];
  unhandled: string[];
}): ReliabilityReport {
  const completed = ctx.outcome === 'completed';
  const stoppedSafely = ctx.outcome === 'stopped_safe';
  const totalRetries = [...ctx.retriesUsed.values()].reduce((a, b) => a + b, 0);
  const anyFailure = ctx.trace.some((t) => t.status === 'failed');

  const notes: string[] = [];
  notes.push(
    completed ? 'Workflow completed' :
    stoppedSafely ? 'Workflow stopped safely' :
    ctx.outcome === 'paused_human' ? 'Workflow paused for a human decision' :
    'Workflow failed',
  );
  if (completed && !anyFailure) notes.push('No failures injected — clean run');
  if (ctx.handled.length) notes.push(...ctx.handled.map((h) => `✓ ${h}`));
  if (ctx.unhandled.length) notes.push(...ctx.unhandled.map((u) => `✗ ${u}`));

  // Scoring: a clean completion is a perfect 100. Recovering from injected
  // failures keeps you close (resilience nearly matches cleanliness);
  // unhandled failures cost; a safe stop preserves most of the value.
  let score = 0;
  if (completed) {
    score += 80;
    if (!anyFailure) score += 20; // pristine run
    else score += Math.min(16, ctx.handled.length * 8);
  } else if (stoppedSafely) {
    score += 50 + Math.min(16, ctx.handled.length * 8);
  } else if (ctx.outcome === 'paused_human') {
    score += 30 + Math.min(10, ctx.handled.length * 5);
  }
  if (ctx.fallbacksUsed.length) score += 2;
  if (ctx.humanSteps.length) score += 2;
  if (ctx.unhandled.length) score -= Math.min(30, ctx.unhandled.length * 10);
  score = Math.max(0, Math.min(100, score));

  return {
    completed,
    finalOutputValid: completed,
    injectedFailuresHandled: ctx.handled,
    totalRetries,
    fallbackActivated: ctx.fallbacksUsed,
    humanInterventions: ctx.humanSteps,
    unhandledErrors: ctx.unhandled,
    stoppedSafely,
    score,
    notes,
  };
}
