import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingInputPayload } from '../src/shared/types.ts';
import { orchestratorPrompt } from '../src/worker/prompts.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

const Q = 'Which approach should I take?';
const QUESTION: PendingInputPayload = {
  kind: 'question',
  questions: [{ question: Q, header: 'Approach', multiSelect: false, options: [{ label: 'Small fix', description: 'Change only what is needed' }, { label: 'Refactor', description: 'Clean up the module too' }] }],
};
const TWO: PendingInputPayload = { kind: 'question', questions: [...QUESTION.questions, { question: 'Which name?', header: 'Name', multiSelect: false, options: [] }] };
const PLAN: PendingInputPayload = { kind: 'plan_approval', plan: '## Plan\n\n1. Add the store\n2. Test it' };

// Part 2: what the orchestrator can do for its batches: answer, hand a question to the owner, and
// write to a batch that stopped. Each within limits the server keeps.
describe('orchestrator: tools for its batches', () => {
  let t: Setup;
  let n = 0;
  let sent: { t: string; session_id?: number; answer?: unknown }[];
  beforeEach(async () => {
    t = await setup();
    // the worker is "connected": what the server sends it is kept here
    sent = [];
    t.s.ctx.hub.send = ((_id: unknown, m: { t: string }) => { sent.push(m); return true; }) as typeof t.s.ctx.hub.send;
  });
  afterEach(() => t.s.app.close());

  const told = (id: number) => t.events(id).filter((e) => e.startsWith('system: (From Dispatch'));
  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const ask = (child: number, payload: PendingInputPayload = QUESTION) => {
    const local_id = `q${++n}`;
    t.s.ctx.sessions.onWorkerMessage(t.store.session(child)!.worker_id!, { t: 'input_request', session_id: child, local_id, payload });
    return t.store.inputs(child).find((i) => i.local_id === local_id)!;
  };
  const running = async (extra: Record<string, unknown> = {}) => {
    const p = await t.approved(extra);
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'running');
    turn(p.id);
    return { ...p, child };
  };
  const answersSent = () => sent.filter((m) => m.t === 'answer');

  it('answer_session answers the batch and marks who answered', async () => {
    const p = await running();
    const input = ask(p.child);
    t.status(p.id, 'running'); // it reads the question
    const reply = String(await t.rpc(p.id, 'answer_session', { input_id: input.id, answer: 'Small fix' }));
    expect(reply).toBe(`Answered. Session #${p.child} goes on.`);
    expect(t.store.input(input.id)).toMatchObject({ answer: { kind: 'question', answers: { [Q]: 'Small fix' } }, answered_by: 'orchestrator', delegated_to: null });
    expect(answersSent()).toEqual([expect.objectContaining({ session_id: p.child, answer: { kind: 'question', answers: { [Q]: 'Small fix' } } })]);
    expect(t.store.session(p.child)!.status).toBe('running');
    expect(t.events(p.child)).toContain('system: Answered by the orchestrator "Rework auth".');
    // its turn ends: the owner is told nothing, there is nothing for them
    const before = t.pushes.length;
    t.status(p.id, 'idle');
    expect(t.pushes.slice(before)).toEqual([]);
  });

  it("it approves a batch's plan, or sends it back with feedback", async () => {
    const p = await running();
    const first = ask(p.child, PLAN);
    await t.rpc(p.id, 'answer_session', { input_id: first.id, approve: false, feedback: 'Add the tests first.' });
    expect(t.store.input(first.id)!.answer).toEqual({ kind: 'plan_approval', approve: false, feedback: 'Add the tests first.' });
    const second = ask(p.child, PLAN);
    await t.rpc(p.id, 'answer_session', { input_id: second.id, approve: true });
    expect(t.store.input(second.id)).toMatchObject({ answer: { kind: 'plan_approval', approve: true }, answered_by: 'orchestrator' });
  });

  it('answer_session refuses a question that is not its own, an answered one, and an answer that does not fit', async () => {
    const p = await running();
    const other = await running(); // another orchestration with its own batch
    const theirs = ask(other.child);
    await expect(t.rpc(p.id, 'answer_session', { input_id: theirs.id, answer: 'x' })).rejects.toThrow(`Question ${theirs.id} is not yours to answer.`);
    await expect(t.rpc(p.id, 'answer_session', { input_id: 99999, answer: 'x' })).rejects.toThrow('Question 99999 is not yours to answer.');
    const two = ask(p.child, TWO);
    await expect(t.rpc(p.id, 'answer_session', { input_id: two.id, answer: 'x' })).rejects.toThrow(`No answer for "${Q}".`);
    await expect(t.rpc(p.id, 'answer_session', { input_id: two.id, answers: { [Q]: 'Small fix' } })).rejects.toThrow('No answer for "Which name?".');
    await t.rpc(p.id, 'answer_session', { input_id: two.id, answers: { [Q]: 'Small fix', 'Which name?': 'tokens' } });
    await expect(t.rpc(p.id, 'answer_session', { input_id: two.id, answer: 'again' })).rejects.toThrow(`Question ${two.id} is already answered.`);
    const plan = ask(p.child, PLAN);
    await expect(t.rpc(p.id, 'answer_session', { input_id: plan.id, answer: 'ok' })).rejects.toThrow('A plan needs approve: true or false.');
    // one it handed to the owner is the owner's
    await t.rpc(p.id, 'hand_to_owner', { input_id: plan.id });
    await expect(t.rpc(p.id, 'answer_session', { input_id: plan.id, approve: true })).rejects.toThrow(`Question ${plan.id} is not yours to answer.`);
    expect(answersSent()).toHaveLength(1);
  });

  it("the owner's answer wins a race: the orchestrator's is refused, the batch gets one answer", async () => {
    const p = await running();
    const input = ask(p.child);
    await t.s.call('POST', `/inputs/${input.id}/answer`, { kind: 'question', answers: { [Q]: 'Refactor' } });
    await expect(t.rpc(p.id, 'answer_session', { input_id: input.id, answer: 'Small fix' })).rejects.toThrow(`Question ${input.id} is already answered.`);
    expect(answersSent()).toHaveLength(1);
    expect(t.store.input(input.id)).toMatchObject({ answer: { answers: { [Q]: 'Refactor' } }, answered_by: null });
    // and the other way round: the owner's late answer is refused
    const next = ask(p.child);
    await t.rpc(p.id, 'answer_session', { input_id: next.id, answer: 'Small fix' });
    expect((await t.s.call('POST', `/inputs/${next.id}/answer`, { kind: 'question', answers: { [Q]: 'Refactor' } })).status).toBe(409);
    expect(answersSent()).toHaveLength(2);
  });

  it('hand_to_owner gives the question to the owner with the reason', async () => {
    const p = await running();
    const input = ask(p.child);
    expect(String(await t.rpc(p.id, 'hand_to_owner', { input_id: input.id, reason: 'Only you know the budget.' }))).toMatch(/owner/);
    expect(t.store.input(input.id)!.delegated_to).toBeNull();
    expect(t.pushes).toContainEqual(expect.objectContaining({ title: 'AA: question', url: `/s/${p.child}` }));
    expect(t.events(p.child)).toContain('system: The orchestrator passed this to you: Only you know the budget.');
    await expect(t.rpc(p.id, 'hand_to_owner', { input_id: input.id })).rejects.toThrow(`Question ${input.id} is not yours to answer.`);
  });

  it('send_to_session writes to an idle batch of its own, at most 3 times', async () => {
    const p = await running();
    await expect(t.rpc(p.id, 'send_to_session', { session_id: p.child, text: 'x' })).rejects.toThrow(`Session #${p.child} works now: wait for its turn to end.`);
    t.status(p.child, 'idle');
    expect(String(await t.rpc(p.id, 'send_to_session', { session_id: p.child, text: 'Open the pull request.' }))).toMatch(/^Sent/);
    expect(t.events(p.child)).toContain('system: (From the orchestrator of "Rework auth", not the owner:) Open the pull request.');
    expect(t.store.session(p.child)!.status).toBe('running');
    expect(t.store.step(p.first.id)!.messages_sent).toBe(1);
    for (let i = 0; i < 2; i++) {
      t.status(p.child, 'idle');
      await t.rpc(p.id, 'send_to_session', { session_id: p.child, text: 'Again.' });
    }
    t.status(p.child, 'idle');
    await expect(t.rpc(p.id, 'send_to_session', { session_id: p.child, text: 'Once more.' })).rejects.toThrow("You already sent 3 messages to this step's batch: tell the owner instead.");
    await expect(t.rpc(p.id, 'send_to_session', { session_id: p.child, text: '  ' })).rejects.toThrow('Write what the batch should do.');
    const other = (await t.s.call<{ id: number }>('POST', '/projects/AA/batches', { item_ids: [], new_items: [], prompt: 'something else' })).data;
    await expect(t.rpc(p.id, 'send_to_session', { session_id: other.id, text: 'x' })).rejects.toThrow(`Session #${other.id} is not a step of this orchestration.`);
    const input = ask(p.child);
    await expect(t.rpc(p.id, 'send_to_session', { session_id: p.child, text: 'x' })).rejects.toThrow(`Session #${p.child} waits for an answer: answer its question instead.`);
    expect(input.delegated_to).toBe(p.id);
  });

  it('a stopped merge: one try for the orchestrator, then the owner', async () => {
    const p = await running({ options: { auto_merge: 'github' } });
    const needs = () => t.pushes.filter((x) => x.title === 'Rework auth: step 1 needs you');
    t.status(p.child, 'idle');
    t.pr(p.child, 'open', { blocked: 'the check failed' });
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'review', note: 'the check failed' });
    expect(told(p.id).at(-1)).toContain('the check failed. You may tell its session once how to fix it (send_to_session). If you cannot, say so to the owner.');
    expect(needs()).toEqual([]);
    await t.rpc(p.id, 'send_to_session', { session_id: p.child, text: 'The check fails on lint: fix it.' });
    t.status(p.id, 'idle');
    expect(needs()).toEqual([]);
    // the batch tried, and the merge is stopped again
    t.status(p.child, 'idle');
    expect(needs()).toEqual([expect.objectContaining({ body: 'The check failed.', url: `/s/${p.child}` })]);
    expect(told(p.id).at(-1)).toContain('the check failed. Your message did not clear it: the owner is told.');
  });

  it('a stopped merge it does not act on reaches the owner at its turn end', async () => {
    const p = await running({ options: { auto_merge: 'github' } });
    const needs = () => t.pushes.filter((x) => x.title === 'Rework auth: step 1 needs you');
    t.status(p.child, 'idle');
    t.pr(p.child, 'open', { blocked: 'the check failed' });
    expect(needs()).toEqual([]);
    t.status(p.id, 'idle'); // it read the news and wrote nothing to the batch
    expect(needs()).toHaveLength(1);
    turn(p.id);
    expect(needs()).toHaveLength(1);
  });

  it('with answer_children off, a stopped merge goes to the owner at once', async () => {
    const p = await running({ options: { auto_merge: 'github' }, answer_children: false });
    t.status(p.child, 'idle');
    t.pr(p.child, 'open', { blocked: 'the check failed' });
    expect(t.pushes.filter((x) => x.title === 'Rework auth: step 1 needs you')).toHaveLength(1);
  });

  it('a turn that ended with no pull request wakes it once, after the batch had time to open one', async () => {
    const p = await running();
    t.s.ctx.orchestrator.settleMs = 0;
    t.store.updateSession(p.child, { last_text: 'Nothing to change: the store already exists.' });
    t.status(p.child, 'idle');
    const about = () => told(p.id).filter((m) => m.includes('ended its turn with no pull request'));
    expect(about()).toHaveLength(1);
    expect(about()[0]).toContain(`- Step 1 "Token store" (AA, session #${p.child}) ended its turn with no pull request. Its last message: "Nothing to change: the store already exists."`);
    expect(about()[0]).toContain('update_step');
    t.s.ctx.bus.emit({ t: 'session', session: t.store.session(p.child)! });
    expect(about()).toHaveLength(1);
    // it can now close the step itself
    t.status(p.id, 'idle');
    expect(await t.rpc(p.id, 'update_step', { step_id: p.first.id, state: 'done', note: 'Already there.' })).toMatchObject({ state: 'done' });
  });

  it('a pull request that arrives in time: no such wake', async () => {
    const p = await running();
    let run: (() => void) | undefined;
    t.s.ctx.orchestrator.later = (_ms, fn) => { run = fn; };
    t.status(p.child, 'idle');
    t.pr(p.child, 'open');
    run?.();
    expect(told(p.id).filter((m) => m.includes('no pull request'))).toEqual([]);
  });

  it('the prompt says how it deals with its batches\' questions', async () => {
    const p = await running();
    const text = orchestratorPrompt(t.s.ctx.sessions.spec(t.store.session(p.id)!, '', null, null));
    expect(text).toMatch(/## Your batches' questions/);
    for (const tool of ['answer_session', 'hand_to_owner', 'send_to_session']) expect(text).toContain(tool);
    const off = await running({ answer_children: false });
    expect(orchestratorPrompt(t.s.ctx.sessions.spec(t.store.session(off.id)!, '', null, null))).not.toMatch(/## Your batches' questions/);
  });
});
