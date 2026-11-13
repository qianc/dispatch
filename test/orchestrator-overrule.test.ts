import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingInput, PendingInputPayload } from '../src/shared/types.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

const Q = 'Which approach should I take?';
const QUESTION: PendingInputPayload = { kind: 'question', questions: [{ question: Q, header: 'Approach', multiSelect: false, options: [{ label: 'Small fix', description: 'Only what is needed' }, { label: 'Refactor', description: 'Clean up too' }] }] };
const PLAN: PendingInputPayload = { kind: 'plan_approval', plan: '## Plan\n\n1. Add the store' };

// The owner reads what the orchestrator answered for a batch, and can put his own answer in its place.
describe('orchestrator: overrule', () => {
  let t: Setup;
  let n = 0;
  let sent: { t: string; text?: string; session_id?: number }[];
  beforeEach(async () => {
    t = await setup();
    sent = [];
    t.s.ctx.hub.send = ((_id: unknown, m: { t: string }) => { sent.push(m); return true; }) as typeof t.s.ctx.hub.send;
  });
  afterEach(() => t.s.app.close());

  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const ask = (child: number, payload: PendingInputPayload = QUESTION) => {
    const local_id = `q${++n}`;
    t.s.ctx.sessions.onWorkerMessage(t.store.session(child)!.worker_id!, { t: 'input_request', session_id: child, local_id, payload });
    return t.store.inputs(child).find((i) => i.local_id === local_id)!;
  };
  /** a running step whose batch asked, and the orchestrator answered */
  const answered = async (payload: PendingInputPayload = QUESTION) => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'running');
    const input = ask(child, payload);
    await t.rpc(p.id, 'answer_session', payload.kind === 'question' ? { input_id: input.id, answer: 'Small fix' } : { input_id: input.id, approve: true });
    turn(p.id);
    return { ...p, child, input };
  };
  const overrule = (id: number, text: string) => t.s.call<PendingInput & { error?: string }>('POST', `/inputs/${id}/overrule`, { text });
  const told = (id: number) => t.events(id).filter((e) => e.startsWith('system: (From Dispatch'));

  it("the owner's own answer goes to the batch as his message, and the orchestrator is told", async () => {
    const p = await answered();
    const res = await overrule(p.input.id, 'Refactor: the module is a mess.');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ id: p.input.id, answered_by: 'overruled' });
    const text = `I overrule the orchestrator's answer to "${Q}": Refactor: the module is a mess.`;
    expect(t.events(p.child)).toContain(`user: ${text}`);
    expect(sent.filter((m) => m.t === 'send' && m.session_id === p.child).map((m) => m.text)).toEqual([text]);
    turn(p.id);
    expect(told(p.id).at(-1)).toContain(`- The owner overruled your answer to step 1 (input_id ${p.input.id}). Follow what they said: "Refactor: the module is a mess."`);
  });

  it("an approved plan is overruled in the owner's words too", async () => {
    const p = await answered(PLAN);
    await overrule(p.input.id, 'Do not touch the old store.');
    expect(t.events(p.child)).toContain("user: I overrule the orchestrator's answer to your plan: Do not touch the old store.");
  });

  it('refuses what cannot be overruled, and changes nothing then', async () => {
    const p = await answered();
    expect((await overrule(p.input.id, '  ')).status).toBe(400);
    // the batch waits for another answer: the owner answers that first
    const next = ask(p.child);
    const busy = await overrule(p.input.id, 'Refactor.');
    expect(busy.status).toBe(400);
    expect(busy.data.error).toBe('Answer the open question first.');
    expect(t.store.input(p.input.id)!.answered_by).toBe('orchestrator');
    // a question the owner answered himself has nothing to overrule
    await t.s.call('POST', `/inputs/${next.id}/answer`, { kind: 'question', answers: { [Q]: 'Refactor' } });
    const mine = await overrule(next.id, 'x');
    expect(mine.status).toBe(409);
    expect(mine.data.error).toBe('Only an answer of the orchestrator can be overruled.');
    // once is enough
    t.status(p.child, 'running');
    expect((await overrule(p.input.id, 'Refactor.')).status).toBe(200);
    expect((await overrule(p.input.id, 'Again.')).data.error).toBe('You already overruled this answer.');
    expect((await overrule(99999, 'x')).status).toBe(404);
  });

  it('a closed batch is not reopened by an overrule', async () => {
    const p = await answered();
    t.s.ctx.sessions.finish(p.child, 'completed');
    const res = await overrule(p.input.id, 'Refactor.');
    expect(res.status).toBe(409);
    expect(res.data.error).toBe('This session is closed: write to it to reopen it.');
    expect(t.store.session(p.child)!.status).toBe('completed');
    expect(t.store.input(p.input.id)!.answered_by).toBe('orchestrator');
  });
});

describe('orchestrator: who answered, in the batch\'s chat', () => {
  let InputCard: typeof import('../web/src/components/transcript.tsx').InputCard;
  let Form: typeof import('../web/src/components/orchestration.tsx').NewOrchestrationForm;
  beforeEach(async () => {
    vi.resetModules();
    stubBrowser();
    ({ InputCard } = await import('../web/src/components/transcript.tsx'));
    ({ NewOrchestrationForm: Form } = await import('../web/src/components/orchestration.tsx'));
  });
  afterEach(() => vi.unstubAllGlobals());

  const input = (over: Partial<PendingInput>): PendingInput => ({
    id: 7, session_id: 12, payload: QUESTION, answer: null, answered_at: null, expired: false, created_at: '2026-01-01T00:00:00Z', delegated_to: null, answered_by: null, ...over,
  });
  const card = (i: PendingInput, readOnly = false) => textOf(renderPage(createElement(InputCard, { input: i, readOnly })));
  const ANSWER = { kind: 'question' as const, answers: { [Q]: 'Small fix' } };

  it('a question the orchestrator has says so, and the owner can still answer it', () => {
    const text = card(input({ delegated_to: 5 }));
    expect(text).toContain('The orchestrator answers this, or passes it to you. You can answer it yourself.');
    expect(text).toContain('Send answer');
  });

  it("the orchestrator's answer is named, with Overrule for who may act", () => {
    const done = input({ answer: ANSWER, answered_at: '2026-01-01T00:01:00Z', answered_by: 'orchestrator' });
    expect(card(done)).toContain('Answered by the orchestrator');
    expect(card(done)).toContain('Overrule');
    expect(card(done, true)).not.toContain('Overrule');
    expect(card(input({ answer: ANSWER, answered_at: '2026-01-01T00:01:00Z', answered_by: 'overruled' }))).toContain('Answered by the orchestrator, overruled by you');
    expect(card(input({ answer: ANSWER, answered_at: '2026-01-01T00:01:00Z' }))).not.toMatch(/orchestrator|Overrule/);
  });

  it('the start sheet lets the owner keep all questions for himself', () => {
    const qc = new QueryClient();
    qc.setQueryData(['projects'], []);
    const text = textOf(renderPage(createElement(Form, { onDone: () => {} }), { qc }));
    expect(text).toContain("It answers its batches' questions");
    expect(text).toContain('What it cannot settle comes to you.');
  });
});
