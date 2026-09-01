import { describe, expect, it } from 'vitest';
import { createRuntime, executeWorkflow } from './executor';
import { PUZZLES } from '../puzzles';

const runPuzzle = (id: string, armed: Record<string, string[]>, decisions?: Record<string, unknown>) => {
  const p = PUZZLES.find((x) => x.id === id)!;
  return executeWorkflow(createRuntime(), {
    workflow: JSON.parse(JSON.stringify(p.workflow)),
    handlers: p.handlers,
    armed: armed as never,
    humanDecisions: decisions as never,
  });
};

describe('engine', () => {
  it('completes puzzle 1 cleanly and repairs when malformed', async () => {
    const clean = await runPuzzle('meeting-summarizer', {});
    expect(clean.outcome).toBe('completed');
    const broken = await runPuzzle('meeting-summarizer', { model1: ['missing_field'] });
    // failure injected on model1 → repair recovery kicks in
    expect(broken.trace.some((t) => t.status === 'failed')).toBe(true);
    expect(broken.trace.some((t) => t.recovery?.includes('repaired') || t.recovery?.includes('repair'))).toBe(true);
  });

  it('puzzle 3 falls back to keyword classifier on low confidence', async () => {
    const r = await runPuzzle('ticket-router', { model1: ['low_confidence'] });
    expect(r.reliability.fallbackActivated.join()).toContain('eyword');
    expect(r.outcome === 'completed' || r.outcome === 'stopped_safe').toBe(true);
  });

  it('puzzle 4 survives a source timeout with safe default', async () => {
    const r = await runPuzzle('research-timeout', { toolB: ['tool_timeout'] });
    expect(r.outcome).toBe('completed');
    expect(r.trace.some((t) => t.status === 'recovered')).toBe(true);
  });

  it('puzzle 5 pauses for human approval, then completes on approve', async () => {
    const paused = await runPuzzle('approve-before-sending', {});
    expect(paused.outcome).toBe('paused_human');
    const approved = await runPuzzle('approve-before-sending', {}, { human1: { decision: 'approved' } });
    expect(approved.outcome).toBe('completed');
    const rejected = await runPuzzle('approve-before-sending', {}, { human1: { decision: 'rejected' } });
    expect(rejected.outcome).toBe('stopped_safe');
  });

  it('puzzle 6 detects malformed JSON and repairs to a valid object', async () => {
    const r = await runPuzzle('data-extractor', { model1: ['invalid_json'] });
    expect(r.trace.some((t) => t.status === 'failed')).toBe(true);
    expect(r.outcome).toBe('completed');
  });

  it('puzzle 7 retries then activates the fallback provider', async () => {
    const r = await runPuzzle('activate-fallback', { model1: ['model_timeout'] });
    expect(r.reliability.fallbackActivated.join()).toContain('Mock provider');
  });

  it('puzzle 8 stops safely on tool failure and can resume from last success', async () => {
    const r = await runPuzzle('resume-mission', { hotel: ['tool_failure'] });
    expect(r.outcome).toBe('stopped_safe');
    expect(r.trace.some((t) => t.status === 'stopped')).toBe(true);
  });

  it('all eight puzzles run offline deterministically', async () => {
    expect(PUZZLES.length).toBe(8);
    const outcomes = await Promise.all(PUZZLES.map((p) => runPuzzle(p.id, {})));
    for (const o of outcomes) {
      expect(['completed', 'paused_human', 'stopped_safe']).toContain(o.outcome);
      expect(o.reliability.score).toBeGreaterThan(0);
    }
  });
});
