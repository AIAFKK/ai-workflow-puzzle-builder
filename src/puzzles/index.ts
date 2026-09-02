// Eight seeded puzzles + deterministic mock handlers (zero external APIs).
// Each puzzle: title / difficulty / objective / blocks / sample input /
// expected result / failure scenario / completion criteria per the spec.

import type { FailureMode, HandlerCtx, WorkflowDefinition } from '../engine/types';

export type PuzzleHandler = (input: unknown, ctx?: HandlerCtx) => unknown;

export interface Puzzle {
  id: string;
  title: string;
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced';
  objective: string;
  friendlyGoal: string;
  sampleInput: string;
  expectedResult: string;
  failureScenario: string;
  completionCriteria: string[];
  /** Failures the puzzle asks the user to arm while exploring. */
  suggestedFailures: Record<string, FailureMode[]>;
  workflow: WorkflowDefinition;
  handlers: Record<string, PuzzleHandler>;
}

const wf = (puzzleId: string, steps: WorkflowDefinition['steps'], edges: WorkflowDefinition['edges']): WorkflowDefinition => ({
  id: `${puzzleId}-wf`,
  puzzleId,
  steps,
  edges,
});

// ---------------------------------------------------------------------------
// Puzzle 1 — Fix the Meeting Summarizer (Beginner)
// ---------------------------------------------------------------------------
const p1 = (): Puzzle => ({
  id: 'meeting-summarizer',
  title: 'Fix the Meeting Summarizer',
  difficulty: 'Beginner',
  objective: 'Turn meeting notes into a summary, decisions and action items while handling missing owners or malformed output.',
  friendlyGoal: 'Repair the broken workflow',
  sampleInput: 'Meeting notes: "We decided to ship the beta on Friday. Alice will write the release notes. Bob follows up with legal."',
  expectedResult: '{ summary, decisions[], action_items[{owner,task}] }',
  failureScenario: 'missing_field — the model returns action items without owners.',
  completionCriteria: [
    'Workflow completes with structured output',
    'Action items always carry an owner (validation or repair)',
    'Reliability feedback shows the failure was handled',
  ],
  suggestedFailures: { model1: ['missing_field'] },
  workflow: wf('meeting-summarizer', [
    { id: 'input1', kind: 'input', title: 'Meeting Notes', position: { x: 0, y: 160 }, handlerKey: 'p1_input', armedFailures: [] },
    { id: 'model1', kind: 'model', title: 'Summarizer Model', position: { x: 260, y: 160 }, handlerKey: 'p1_model', armedFailures: [], recovery: { kind: 'repair' } },
    { id: 'val1', kind: 'validator', title: 'Owners Present?', position: { x: 520, y: 160 }, handlerKey: 'pass', validation: { field: 'action_items', type: 'nonEmptyItems', sub: 'owner' }, armedFailures: [] },
    { id: 'out1', kind: 'output', title: 'Structured Minutes', position: { x: 780, y: 160 }, handlerKey: 'pass', armedFailures: [] },
  ], [
    { id: 'e1', from: 'input1', to: 'model1' },
    { id: 'e2', from: 'model1', to: 'val1' },
    { id: 'e3', from: 'val1', to: 'out1' },
  ]),
  handlers: {
    p1_input: () => ({
      notes: 'Meeting notes: "We decided to ship the beta on Friday. Alice will write the release notes. Bob follows up with legal."',
    }),
    p1_model: () => ({
      summary: 'Team aligned on shipping the beta on Friday.',
      decisions: ['Ship beta on Friday'],
      action_items: [
        { owner: 'Alice', task: 'Write the release notes' },
        { owner: 'Bob', task: 'Follow up with legal' },
      ],
    }),
    'p1_model__repair': () => ({
      summary: 'Team aligned on shipping the beta on Friday.',
      decisions: ['Ship beta on Friday'],
      action_items: [
        { owner: 'Alice', task: 'Write release notes' },
        { owner: 'Bob (recovered)', task: 'Follow up with legal' },
      ],
    }),
    pass: (input) => input,
  },
});

// ---------------------------------------------------------------------------
// Puzzle 2 — Ground the Knowledge Assistant (Beginner)
// ---------------------------------------------------------------------------
const p2 = (): Puzzle => ({
  id: 'knowledge-assistant',
  title: 'Ground the Knowledge Assistant',
  difficulty: 'Beginner',
  objective: 'Retrieve supporting information and refuse to answer when evidence is missing.',
  friendlyGoal: 'Add a safe fallback',
  sampleInput: 'Question: "What is the refund policy for the Pro plan?"',
  expectedResult: 'Answer with citations, or a polite refusal when no evidence exists.',
  failureScenario: 'empty_retrieval — the knowledge base returns zero results.',
  completionCriteria: [
    'Empty retrieval leads to refusal or human routing',
    'Valid retrieval produces a cited answer',
    'No hallucinated answer when evidence is missing',
  ],
  suggestedFailures: { ret1: ['empty_retrieval'] },
  workflow: wf('knowledge-assistant', [
    { id: 'input1', kind: 'input', title: 'User Question', position: { x: 0, y: 160 }, handlerKey: 'p2_input', armedFailures: [] },
    { id: 'ret1', kind: 'retrieval', title: 'Knowledge Lookup', position: { x: 260, y: 60 }, handlerKey: 'p2_retrieval', armedFailures: [], recovery: { kind: 'default', value: { evidence: ['refusal — no supporting documents retrieved'], refused: true } } },
    { id: 'val1', kind: 'validator', title: 'Evidence Present?', position: { x: 520, y: 60 }, handlerKey: 'pass', validation: { field: 'evidence', type: 'evidence' }, armedFailures: [] },
    { id: 'model1', kind: 'model', title: 'Grounded Answer', position: { x: 780, y: 60 }, handlerKey: 'p2_model', armedFailures: [] },
    { id: 'out1', kind: 'output', title: 'Answer', position: { x: 1040, y: 60 }, handlerKey: 'pass', armedFailures: [] },
  ], [
    { id: 'e1', from: 'input1', to: 'ret1' },
    { id: 'e2', from: 'ret1', to: 'val1' },
    { id: 'e3', from: 'val1', to: 'model1' },
    { id: 'e4', from: 'model1', to: 'out1' },
  ]),
  handlers: {
    p2_input: () => ({ question: 'What is the refund policy for the Pro plan?' }),
    p2_retrieval: () => ({ evidence: ['policy.md#refunds: Pro plans refundable within 14 days'], question: 'What is the refund policy?' }),
    p2_model: (input) => {
      const i = input as { evidence?: string[]; refused?: boolean };
      if (i.refused) {
        return { answer: 'I don\'t have enough evidence to answer — please check the knowledge base.', citations: [], refused: true };
      }
      return { answer: 'Pro plans are refundable within 14 days of purchase.', citations: i.evidence ?? [] };
    },
    pass: (input) => input,
  },
});

// ---------------------------------------------------------------------------
// Puzzle 3 — Repair the Ticket Router (Intermediate)
// ---------------------------------------------------------------------------
const p3 = (): Puzzle => ({
  id: 'ticket-router',
  title: 'Repair the Ticket Router',
  difficulty: 'Intermediate',
  objective: 'Classify and route a customer ticket while handling missing categories or invalid confidence values.',
  friendlyGoal: 'Stop invalid data',
  sampleInput: 'Ticket: "My card was charged twice and the app crashes on refund."',
  expectedResult: '{ category: billing|bug|howto, confidence ≥ 0.7, route }',
  failureScenario: 'low_confidence — the model classifies with confidence 0.42.',
  completionCriteria: [
    'Low-confidence classifications are retried, defaulted, or routed to a human',
    'Valid tickets route automatically',
    'Every routing decision is visible in the trace',
  ],
  suggestedFailures: { model1: ['low_confidence'] },
  workflow: wf('ticket-router', [
    { id: 'input1', kind: 'input', title: 'Customer Ticket', position: { x: 0, y: 160 }, handlerKey: 'p3_input', armedFailures: [] },
    { id: 'model1', kind: 'model', title: 'Classifier', position: { x: 260, y: 160 }, handlerKey: 'p3_model', armedFailures: [], recovery: { kind: 'fallback', fallbackKey: 'p3_fallback', label: 'Keyword classifier' } },
    { id: 'val1', kind: 'validator', title: 'Confidence ≥ 0.7', position: { x: 520, y: 160 }, handlerKey: 'pass', validation: { type: 'threshold', threshold: 0.7 }, armedFailures: [] },
    { id: 'cond1', kind: 'condition', title: 'Route by Category', position: { x: 780, y: 160 }, handlerKey: 'p3_route', armedFailures: [] },
    { id: 'out1', kind: 'output', title: 'Routed Ticket', position: { x: 1040, y: 160 }, handlerKey: 'pass', armedFailures: [] },
  ], [
    { id: 'e1', from: 'input1', to: 'model1' },
    { id: 'e2', from: 'model1', to: 'val1' },
    { id: 'e3', from: 'val1', to: 'cond1' },
    { id: 'e4', from: 'cond1', to: 'out1' },
  ]),
  handlers: {
    p3_input: () => ({ text: 'My card was charged twice and the app crashes on refund.' }),
    p3_model: () => ({ category: 'billing', confidence: 0.42 }), // low on purpose
    p3_fallback: (input) => {
      const text = String((input as { text?: string }).text ?? '');
      const category = /charg|refund|invoice/.test(text) ? 'billing' : 'howto';
      return { category, confidence: 0.9, via: 'keyword-fallback' };
    },
    p3_route: (input) => ({
      route: `queue:${(input as { category?: string }).category ?? 'triage'}`,
      input,
    }),
    pass: (input) => input,
  },
});

// ---------------------------------------------------------------------------
// Puzzle 4 — Survive the Research Timeout (Intermediate)
// ---------------------------------------------------------------------------
const p4 = (): Puzzle => ({
  id: 'research-timeout',
  title: 'Survive the Research Timeout',
  difficulty: 'Intermediate',
  objective: 'Combine information from multiple sources while handling a source or tool timeout.',
  friendlyGoal: 'Survive the timeout',
  sampleInput: 'Topic: "adoption of vector databases 2026"',
  expectedResult: 'Synthesis that uses whichever sources survived, noting skipped sources.',
  failureScenario: 'tool_timeout — Source B never responds.',
  completionCriteria: [
    'A timing-out source does not kill the workflow',
    'Synthesis flags the missing source',
    'Retry or fallback is visible in the trace',
  ],
  suggestedFailures: { toolB: ['tool_timeout'] },
  workflow: wf('research-timeout', [
    { id: 'input1', kind: 'input', title: 'Research Topic', position: { x: 0, y: 160 }, handlerKey: 'p4_input', armedFailures: [] },
    { id: 'toolA', kind: 'tool', title: 'Source A (Fast)', position: { x: 250, y: 60 }, handlerKey: 'p4_sourceA', armedFailures: [] },
    { id: 'toolB', kind: 'tool', title: 'Source B (Slow)', position: { x: 250, y: 260 }, handlerKey: 'p4_sourceB', armedFailures: [], recovery: { kind: 'default', value: { source: 'B', note: 'skipped: timed out' } } },
    { id: 'model1', kind: 'model', title: 'Synthesizer', position: { x: 520, y: 160 }, handlerKey: 'p4_model', armedFailures: [] },
    { id: 'out1', kind: 'output', title: 'Research Brief', position: { x: 780, y: 160 }, handlerKey: 'pass', armedFailures: [] },
  ], [
    { id: 'e1', from: 'input1', to: 'toolA' },
    { id: 'e2', from: 'input1', to: 'toolB' },
    { id: 'e3', from: 'toolA', to: 'model1' },
    { id: 'e4', from: 'toolB', to: 'model1' },
    { id: 'e5', from: 'model1', to: 'out1' },
  ]),
  handlers: {
    p4_input: () => ({ topic: 'adoption of vector databases 2026' }),
    p4_sourceA: () => ({ source: 'A', facts: ['Adoption doubled YoY in 2026', 'pgvector leads self-hosted segment'] }),
    p4_sourceB: () => ({ source: 'B', facts: ['Managed vector DBs grew 3x'] }),
    p4_model: (input) => {
      const j = (input as { joined?: Array<{ step: string; output: { source?: string; facts?: string[]; note?: string } | null }> }).joined;
      if (!j) return input; // single-predecessor fallback
      const facts: string[] = [];
      const skipped: string[] = [];
      for (const p of j) {
        const o = p.output ?? {};
        if (Array.isArray(o.facts)) facts.push(...o.facts);
        if (o.note && String(o.note).startsWith('skipped')) skipped.push(o.source ?? p.step);
      }
      return {
        brief: facts.join(' '),
        sourcesUsed: j.length - skipped.length,
        skippedSources: skipped,
      };
    },
    pass: (input) => input,
  },
});

// ---------------------------------------------------------------------------
// Puzzle 5 — Approve Before Sending (Intermediate)
// ---------------------------------------------------------------------------
const p5 = (): Puzzle => ({
  id: 'approve-before-sending',
  title: 'Approve Before Sending',
  difficulty: 'Intermediate',
  objective: 'Draft an external message but require a human to approve, edit, or reject it before continuing.',
  friendlyGoal: 'Ask a human before continuing',
  sampleInput: 'Customer asks for a status update on their refund.',
  expectedResult: 'Message is sent only after explicit human approval (possibly edited).',
  failureScenario: 'human_rejection — the reviewer rejects the draft.',
  completionCriteria: [
    'Workflow pauses before any external send',
    'Approve / edit / reject all leave a recorded decision',
    'Rejection stops the workflow safely',
  ],
  suggestedFailures: {},
  workflow: wf('approve-before-sending', [
    { id: 'input1', kind: 'input', title: 'Customer Request', position: { x: 0, y: 160 }, handlerKey: 'p5_input', armedFailures: [] },
    { id: 'model1', kind: 'model', title: 'Draft Message', position: { x: 260, y: 160 }, handlerKey: 'p5_model', armedFailures: [] },
    { id: 'human1', kind: 'human', title: 'Human Approval', position: { x: 520, y: 160 }, handlerKey: 'pass', armedFailures: [], recovery: { kind: 'safe_stop', reason: 'Draft rejected by reviewer' } },
    { id: 'tool1', kind: 'tool', title: 'Send Email (Mock)', position: { x: 780, y: 160 }, handlerKey: 'p5_send', armedFailures: [] },
    { id: 'out1', kind: 'output', title: 'Delivery Receipt', position: { x: 1040, y: 160 }, handlerKey: 'pass', armedFailures: [] },
  ], [
    { id: 'e1', from: 'input1', to: 'model1' },
    { id: 'e2', from: 'model1', to: 'human1' },
    { id: 'e3', from: 'human1', to: 'tool1' },
    { id: 'e4', from: 'tool1', to: 'out1' },
  ]),
  handlers: {
    p5_input: () => ({ ask: 'Where is my refund?' }),
    p5_model: () => ({
      to: 'customer@example.com',
      subject: 'Refund status',
      body: 'Hi! Your refund was issued today and should appear within 3 business days.',
    }),
    p5_send: (input) => ({ sent: true, messageId: 'mock-123', ...(input as object) }),
    pass: (input) => input,
  },
});

// ---------------------------------------------------------------------------
// Puzzle 6 — Validate the Data Extractor (Advanced)
// ---------------------------------------------------------------------------
const p6 = (): Puzzle => ({
  id: 'data-extractor',
  title: 'Validate the Data Extractor',
  difficulty: 'Advanced',
  objective: 'Extract structured information from unstructured text and recover when the AI returns invalid data.',
  friendlyGoal: 'Stop invalid data',
  sampleInput: 'Email: "Invoice #4021 from Acme, due 2026-10-05, total $1,250.50, contact bob@acme.io"',
  expectedResult: '{ invoice: 4021, vendor: "Acme", due: "2026-10-05", total: 1250.5, email }',
  failureScenario: 'invalid_json — the model wraps the object in markdown fences.',
  completionCriteria: [
    'Malformed output is detected by validation',
    'Repair strategy recovers a valid object',
    'Final output passes every field check',
  ],
  suggestedFailures: { model1: ['invalid_json'] },
  workflow: wf('data-extractor', [
    { id: 'input1', kind: 'input', title: 'Raw Email', position: { x: 0, y: 160 }, handlerKey: 'p6_input', armedFailures: [] },
    { id: 'model1', kind: 'model', title: 'Extractor Model', position: { x: 260, y: 160 }, handlerKey: 'p6_model', armedFailures: [], recovery: { kind: 'repair' } },
    { id: 'val1', kind: 'validator', title: 'Invoice Schema', position: { x: 520, y: 160 }, handlerKey: 'pass', validation: { field: 'invoice', type: 'required' }, armedFailures: [] },
    { id: 'out1', kind: 'output', title: 'Structured Invoice', position: { x: 780, y: 160 }, handlerKey: 'pass', armedFailures: [] },
  ], [
    { id: 'e1', from: 'input1', to: 'model1' },
    { id: 'e2', from: 'model1', to: 'val1' },
    { id: 'e3', from: 'val1', to: 'out1' },
  ]),
  handlers: {
    p6_input: () => ({ text: 'Invoice #4021 from Acme, due 2026-10-05, total $1,250.50, contact bob@acme.io' }),
    p6_model: () => '```json\n{"invoice":4021,"vendor":"Acme","due":"2026-10-05","total":1250.5,"email":"bob@acme.io"}\n```',
    'p6_model__repair': () => ({ invoice: 4021, vendor: 'Acme', due: '2026-10-05', total: 1250.5, email: 'bob@acme.io' }),
    pass: (input) => input,
  },
});

// ---------------------------------------------------------------------------
// Puzzle 7 — Activate the Fallback (Advanced)
// ---------------------------------------------------------------------------
const p7 = (): Puzzle => ({
  id: 'activate-fallback',
  title: 'Activate the Fallback',
  difficulty: 'Advanced',
  objective: 'Retry a failed AI model call and switch to a fallback model or mock provider after repeated failures.',
  friendlyGoal: 'Add a safe fallback',
  sampleInput: 'Generate a one-line release note for "v2.4.0: faster sync".',
  expectedResult: 'A usable note from the fallback provider with retries logged.',
  failureScenario: 'model_timeout — the primary provider never responds.',
  completionCriteria: [
    'Retries are attempted before failing over',
    'Fallback output is clearly labelled',
    'Reliability report lists the activated fallback',
  ],
  suggestedFailures: { model1: ['model_timeout'] },
  workflow: wf('activate-fallback', [
    { id: 'input1', kind: 'input', title: 'Feature Notes', position: { x: 0, y: 160 }, handlerKey: 'p7_input', armedFailures: [] },
    { id: 'model1', kind: 'model', title: 'Primary Model (retry ×2 → fallback)', position: { x: 260, y: 160 }, handlerKey: 'p7_model', armedFailures: [], recovery: [{ kind: 'retry', maxAttempts: 2 }, { kind: 'fallback', fallbackKey: 'p7_fallback', label: 'Mock provider B' }] },
    { id: 'out1', kind: 'output', title: 'Release Note', position: { x: 560, y: 160 }, handlerKey: 'pass', armedFailures: [] },
  ], [
    { id: 'e1', from: 'input1', to: 'model1' },
    { id: 'e2', from: 'model1', to: 'out1' },
  ]),
  handlers: {
    p7_input: () => ({ feature: 'v2.4.0: faster sync' }),
    p7_model: () => { throw new Error('primary provider down'); },
    p7_fallback: (input) => ({ note: `Release ${String((input as { feature?: string }).feature ?? '')} — now with faster sync.`, via: 'mock-provider-B' }),
    pass: (input) => input,
  },
});

// ---------------------------------------------------------------------------
// Puzzle 8 — Resume the Interrupted Mission (Advanced)
// ---------------------------------------------------------------------------
const p8 = (): Puzzle => ({
  id: 'resume-mission',
  title: 'Resume the Interrupted Mission',
  difficulty: 'Advanced',
  objective: 'Continue a workflow from its last successful step after a simulated interruption.',
  friendlyGoal: 'Recover from the last successful step',
  sampleInput: 'Trip plan generation interrupted after the flight step succeeded.',
  expectedResult: 'Execution resumes at the last successful step instead of restarting.',
  failureScenario: 'tool_failure — the hotel lookup crashes mid-run.',
  completionCriteria: [
    'The failed step and the last successful step are identified',
    'Resume continues from the last successful step',
    'Final trace shows both the interrupted and resumed segments',
  ],
  suggestedFailures: {},
  workflow: wf('resume-mission', [
    { id: 'input1', kind: 'input', title: 'Trip Request', position: { x: 0, y: 160 }, handlerKey: 'p8_input', armedFailures: [] },
    { id: 'flight', kind: 'tool', title: 'Flight Lookup', position: { x: 240, y: 160 }, handlerKey: 'p8_flight', armedFailures: [] },
    { id: 'hotel', kind: 'tool', title: 'Hotel Lookup', position: { x: 480, y: 160 }, handlerKey: 'p8_hotel', armedFailures: [], recovery: { kind: 'safe_stop', reason: 'Hotel provider crashed — press Resume to continue from Flight Lookup' } },
    { id: 'model1', kind: 'model', title: 'Itinerary Writer', position: { x: 720, y: 160 }, handlerKey: 'p8_model', armedFailures: [] },
    { id: 'out1', kind: 'output', title: 'Trip Plan', position: { x: 960, y: 160 }, handlerKey: 'pass', armedFailures: [] },
  ], [
    { id: 'e1', from: 'input1', to: 'flight' },
    { id: 'e2', from: 'flight', to: 'hotel' },
    { id: 'e3', from: 'hotel', to: 'model1' },
    { id: 'e4', from: 'model1', to: 'out1' },
  ]),
  handlers: {
    p8_input: () => ({ destination: 'Kyoto', dates: '2026-11-03 → 2026-11-08' }),
    p8_flight: () => ({ flight: 'NH-220 HND→KIX 11-03 09:30' }),
    p8_hotel: (_input, ctx) => {
      // Simulated interruption: the provider crashes on its first execution
      // and comes back on the second — i.e. after the user presses Resume.
      if (!ctx || ctx.executionCount < 2) throw new Error('INTERNAL_ERROR');
      return { hotel: 'Ryokan Yuzuya · 4 nights · confirmed after recovery' };
    },
    p8_model: (input) => ({ itinerary: input }),
    pass: (input) => input,
  },
});

// Generic deterministic mocks for blocks the user adds in Build mode.
// Bound by handlerKey `generic_<kind>`; they flow through the exact same
// execution / validation / failure / recovery pipeline as puzzle mocks.
export const GENERIC_HANDLERS: Record<string, PuzzleHandler> = {
  generic_input: () => ({ sample: 'Sample input payload' }),
  generic_model: (input) => ({ summary: 'Model processed the payload.', input }),
  generic_tool: (input) => ({ tool: 'mock-tool', result: 'ok', input }),
  generic_retrieval: () => ({ evidence: ['doc-1: a sample evidence passage'] }),
  generic_condition: (input) => input,
  generic_validator: (input) => input,
  generic_retry: (input) => input,
  generic_fallback: (input) => ({ note: 'fallback handler output', input }),
  generic_human: (input) => input,
  generic_output: (input) => input,
};

export const PUZZLES: Puzzle[] = [p1(), p2(), p3(), p4(), p5(), p6(), p7(), p8()];

export const getPuzzle = (id: string) => PUZZLES.find((p) => p.id === id);
