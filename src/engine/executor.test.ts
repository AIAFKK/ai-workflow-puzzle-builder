import { describe, expect, it } from 'vitest';
import { createRuntime, executeWorkflow, topoSort } from './executor';
import { PUZZLES, GENERIC_HANDLERS, type PuzzleHandler } from '../puzzles';

const runPuzzle = (
  id: string,
  armed: Record<string, string[]>,
  decisions?: Record<string, unknown>,
) => {
  const p = PUZZLES.find((x) => x.id === id)!;
  return executeWorkflow(createRuntime(), {
    workflow: JSON.parse(JSON.stringify(p.workflow)),
    handlers: p.handlers,
    armed: armed as never,
    humanDecisions: decisions as never,
  });
};

const handlersWith = (extra: Record<string, PuzzleHandler>) =>
  ({ ...GENERIC_HANDLERS, ...extra });

describe('engine', () => {
  it('completes puzzle 1 cleanly at score 100 and repairs when malformed', async () => {
    const clean = await runPuzzle('meeting-summarizer', {});
    expect(clean.outcome).toBe('completed');
    expect(clean.reliability.score).toBe(100); // pristine run is a perfect score
    expect(JSON.stringify(clean.finalOutput)).toContain('Bob');
    const broken = await runPuzzle('meeting-summarizer', { model1: ['missing_field'] });
    // failure injected on model1 → repair recovery kicks in
    expect(broken.trace.some((t) => t.status === 'failed')).toBe(true);
    expect(broken.trace.some((t) => t.recovery?.includes('repaired') || t.recovery?.includes('repair'))).toBe(true);
    expect(broken.outcome).toBe('completed');
  });

  it('puzzle 2 refuses to answer when retrieval is empty (safe default)', async () => {
    const r = await runPuzzle('knowledge-assistant', { ret1: ['empty_retrieval'] });
    expect(r.outcome).toBe('completed');
    expect(JSON.stringify(r.finalOutput)).toContain("don't have enough evidence");
    expect(r.reliability.injectedFailuresHandled.join()).toContain('safe default');
  });

  it('puzzle 3 falls back to keyword classifier on low confidence', async () => {
    const r = await runPuzzle('ticket-router', { model1: ['low_confidence'] });
    expect(r.reliability.fallbackActivated.join()).toContain('eyword');
    expect(r.outcome).toBe('completed');
  });

  it('puzzle 4 joins BOTH sources and flags a timed-out one', async () => {
    const clean = await runPuzzle('research-timeout', {});
    const brief = JSON.stringify(clean.finalOutput);
    expect(brief).toContain('Adoption doubled'); // source A fact present
    expect(brief).toContain('Managed vector DBs'); // source B fact present
    expect(clean.outcome).toBe('completed');

    const degraded = await runPuzzle('research-timeout', { toolB: ['tool_timeout'] });
    expect(degraded.outcome).toBe('completed');
    expect(JSON.stringify(degraded.finalOutput)).toContain('skippedSources');
    expect(degraded.trace.some((t) => t.status === 'recovered')).toBe(true);
  });

  it('puzzle 5 pauses for human approval, then completes on approve', async () => {
    const paused = await runPuzzle('approve-before-sending', {});
    expect(paused.outcome).toBe('paused_human');
    const approved = await runPuzzle('approve-before-sending', {}, { human1: { decision: 'approved' } });
    expect(approved.outcome).toBe('completed');
    const edited = await runPuzzle('approve-before-sending', {}, {
      human1: { decision: 'edited', edited: { to: 'x@y.z', subject: 's', body: 'edited by reviewer' } },
    });
    expect(edited.outcome).toBe('completed');
    expect(JSON.stringify(edited.finalOutput)).toContain('edited by reviewer');
    const rejected = await runPuzzle('approve-before-sending', {}, { human1: { decision: 'rejected' } });
    expect(rejected.outcome).toBe('stopped_safe');
  });

  it('puzzle 6 detects malformed JSON and repairs to a valid object', async () => {
    const r = await runPuzzle('data-extractor', { model1: ['invalid_json'] });
    expect(r.trace.some((t) => t.status === 'failed')).toBe(true);
    expect(r.outcome).toBe('completed');
    expect((r.finalOutput as { invoice: number }).invoice).toBe(4021);
  });

  it('puzzle 7 retries twice (visible) before activating the fallback provider', async () => {
    const r = await runPuzzle('activate-fallback', { model1: ['model_timeout'] });
    expect(r.reliability.totalRetries).toBe(2); // retries are real and counted
    expect(r.trace.filter((t) => t.status === 'retrying').length).toBe(2); // surfaced in the trace
    expect(r.reliability.fallbackActivated.join()).toContain('Mock provider');
    expect(r.outcome).toBe('completed');
    expect(JSON.stringify(r.finalOutput)).toContain('mock-provider-B');
  });

  it('puzzle 8 interrupts, stops safely, and truly resumes from the last success', async () => {
    const p = PUZZLES.find((x) => x.id === 'resume-mission')!;
    const runtime = createRuntime(); // shared runtime = shared provider state
    const first = await executeWorkflow(runtime, {
      workflow: JSON.parse(JSON.stringify(p.workflow)),
      handlers: p.handlers,
      armed: {},
    });
    expect(first.outcome).toBe('stopped_safe');
    expect(first.trace.some((t) => t.status === 'stopped')).toBe(true);

    // The store's Resume action: re-run from the failed step, seeded with the
    // last good output (flight) — the provider is back on its 2nd execution.
    const lastGood = first.trace.filter((t) => t.status === 'completed').pop()!;
    const failedAt = [...first.trace].reverse().find((t) => t.status === 'failed')!;
    expect(lastGood.stepId).toBe('flight');
    const resumed = await executeWorkflow(runtime, {
      workflow: JSON.parse(JSON.stringify(p.workflow)),
      handlers: p.handlers,
      armed: {},
      resumeFromStepId: failedAt.stepId,
      resumePayload: lastGood.output,
    });
    expect(resumed.outcome).toBe('completed');
    expect(JSON.stringify(resumed.finalOutput)).toContain('Ryokan');
    expect(resumed.trace.every((t) => t.resumed)).toBe(true); // segment marked
    // resumed segment skips the input/flight steps that already succeeded
    expect(resumed.trace.some((t) => t.stepId === 'input1')).toBe(false);
  });

  it('all eight puzzles run offline deterministically', async () => {
    expect(PUZZLES.length).toBe(8);
    const outcomes = await Promise.all(PUZZLES.map((p) => runPuzzle(p.id, {})));
    for (const o of outcomes) {
      expect(['completed', 'paused_human', 'stopped_safe']).toContain(o.outcome);
      expect(o.reliability.score).toBeGreaterThan(0);
    }
  });

  it('built workflows: added blocks run through the same pipeline (edit journey)', async () => {
    const p = PUZZLES.find((x) => x.id === 'meeting-summarizer')!;
    const wf: typeof p.workflow = JSON.parse(JSON.stringify(p.workflow));
    // Simulate Build mode: user inserts a validator between model1 and val1.
    wf.steps.push({
      id: 'user_val', kind: 'validator', title: 'Summary Present? (added)',
      position: { x: 400, y: 300 }, handlerKey: 'generic_validator',
      validation: { field: 'summary', type: 'required' }, armedFailures: [],
    });
    wf.edges = wf.edges.filter((e) => e.to !== 'val1');
    wf.edges.push({ id: 'ue1', from: 'model1', to: 'user_val' }, { id: 'ue2', from: 'user_val', to: 'val1' });
    expect(topoSort(wf).indexOf('user_val')).toBeGreaterThan(topoSort(wf).indexOf('model1'));

    const r = await executeWorkflow(createRuntime(), {
      workflow: wf,
      handlers: handlersWith(p.handlers),
      armed: {},
    });
    expect(r.outcome).toBe('completed');
    expect(r.trace.some((t) => t.stepId === 'user_val' && t.status === 'completed')).toBe(true);
  });
});
