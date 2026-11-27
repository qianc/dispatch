import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingInputPayload } from '../src/shared/types.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

const QUESTION: PendingInputPayload = { kind: 'question', questions: [{ question: 'Which approach?', header: 'Approach', multiSelect: false, options: [] }] };
const PLAN: PendingInputPayload = { kind: 'plan_approval', plan: '## Plan\n\n1. Add the store' };
const FROM = '(From the orchestrator of "Rework auth", not the owner:)';

// DISP-263: a message of the orchestrator to a batch that works goes into its turn. DISP-105: when
// that cannot be done, it waits in the database and goes to the batch when its turn ends. A batch
// that closed or asks a question first does not get it.
describe('orchestrator: messages to a batch that works', () => {
  let t: Setup;
  let n = 0;
  let sent: { t: string; session_id?: number; text?: string }[];
  /** the worker cannot take a message during a turn now (its link is down): only then is a message queued */
  let midTurnFails: boolean;
  beforeEach(async () => {
    t = await setup();
    sent = [];
    midTurnFails = true;
    t.s.ctx.hub.send = ((_id: unknown, m: { t: string; session_id?: number }) => {
      if (midTurnFails && m.t === 'send' && t.store.session(m.session_id!)?.status === 'running') return false;
      sent.push(m);
      return true;
    }) as typeof t.s.ctx.hub.send;
    t.s.ctx.orchestrator.settleMs = 0;
  });
  afterEach(() => t.s.app.close());

  const told = (id: number) => t.events(id).filter((e) => e.startsWith('system: (From Dispatch'));
  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const ask = (child: number, payload: PendingInputPayload = QUESTION) => {
    const local_id = `q${++n}`;
    t.s.ctx.sessions.onWorkerMessage(t.store.session(child)!.worker_id!, { t: 'input_request', session_id: child, local_id, payload });
    return t.store.inputs(child).find((i) => i.local_id === local_id)!;
  };
  /** an approved plan whose first step's batch works; the orchestrator's turn ended */
  const running = async () => {
    const p = await t.approved();
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'running');
    turn(p.id);
    return { ...p, child };
  };
  const send = async (p: { id: number; child: number }, text: string) => String(await t.rpc(p.id, 'send_to_session', { session_id: p.child, text }));
  const toChild = (child: number) => sent.filter((m) => m.t === 'send' && m.session_id === child).map((m) => m.text);

  it('a message to a working batch reaches it during its turn, and nothing waits for the turn end', async () => {
    midTurnFails = false;
    const p = await running();
    sent = [];
    expect(await send(p, 'Only run the targeted tests.')).toBe(`Sent to session #${p.child} while it works (message 1 of 3 for this step): it reads this after its current tool step. End your turn: Dispatch wakes you when it changes.`);
    expect(toChild(p.child)).toEqual([`${FROM} Only run the targeted tests.`]);
    expect(t.events(p.child)).toContain(`system: ${FROM} Only run the targeted tests.`);
    expect(t.store.session(p.child)!.status).toBe('running');
    expect(t.store.step(p.first.id)!.messages_sent).toBe(1);
    expect(t.store.queuedOrchMessages()).toEqual([]);
    // its turn end sends nothing again
    t.status(p.child, 'idle');
    expect(toChild(p.child)).toHaveLength(1);
  });

  it('a message the batch cannot take during its turn is queued, and the batch gets it when its turn ends', async () => {
    const p = await running();
    sent = [];
    expect(await send(p, 'Rebase on main and fix the test.')).toBe(`Queued for session #${p.child} (message 1 of 3 for this step): it works, and its worker cannot take a message during the turn now, so it gets this when its turn ends. End your turn: Dispatch wakes you when it changes.`);
    expect(toChild(p.child)).toEqual([]);
    expect(t.store.step(p.first.id)!.messages_sent).toBe(1);
    expect(t.events(p.child).some((e) => e.includes('Rebase on main'))).toBe(false);
    const [pushes, wakes] = [t.pushes.length, told(p.id).length];
    t.status(p.child, 'idle');
    expect(toChild(p.child)).toEqual([`${FROM} Rebase on main and fix the test.`]);
    expect(t.events(p.child)).toContain(`system: ${FROM} Rebase on main and fix the test.`);
    expect(t.store.session(p.child)!.status).toBe('running');
    // that turn end is not news: the batch goes on, nobody is told
    expect(t.pushes.slice(pushes)).toEqual([]);
    expect(told(p.id).slice(wakes)).toEqual([]);
    expect(t.store.queuedOrchMessages()).toEqual([]);
    // the turn after it ends as any other, and nothing is sent twice
    t.status(p.child, 'idle');
    expect(toChild(p.child)).toHaveLength(1);
    expect(t.store.session(p.child)!.status).toBe('idle');
    expect(told(p.id).at(-1)).toContain('ended its turn with no pull request');
  });

  it('two queued messages arrive in order, in one turn', async () => {
    const p = await running();
    sent = [];
    await send(p, 'First: rebase on main.');
    expect(await send(p, 'Second: run the tests.')).toMatch(/^Queued for session #\d+ \(message 2 of 3/);
    t.status(p.child, 'idle');
    expect(toChild(p.child)).toEqual([`${FROM} First: rebase on main.\n\n${FROM} Second: run the tests.`]);
    expect(t.store.session(p.child)!.status).toBe('running');
  });

  it('a queued message counts against the 3 messages of the step when it is queued', async () => {
    const p = await running();
    for (const text of ['One.', 'Two.', 'Three.']) await send(p, text);
    expect(t.store.step(p.first.id)!.messages_sent).toBe(3);
    await expect(send(p, 'Four.')).rejects.toThrow("You already sent 3 messages to this step's batch: tell the owner instead.");
    t.status(p.child, 'idle');
    t.status(p.child, 'idle');
    // and a direct one after them is refused as well
    await expect(send(p, 'Four.')).rejects.toThrow("You already sent 3 messages to this step's batch: tell the owner instead.");
    expect(t.store.queuedOrchMessages()).toEqual([]);
  });

  it('nothing is queued for a batch that waits for an answer or a plan approval, or is closed', async () => {
    const p = await running();
    ask(p.child);
    await expect(send(p, 'x')).rejects.toThrow(`Session #${p.child} waits for an answer: answer its question instead.`);
    const other = await running();
    ask(other.child, PLAN);
    await expect(send(other, 'x')).rejects.toThrow(`Session #${other.child} waits for an answer: answer its question instead.`);
    const closed = await running();
    t.status(closed.child, 'idle');
    t.pr(closed.child, 'open');
    t.s.ctx.sessions.finish(closed.child, 'completed');
    expect(t.store.step(closed.first.id)!.state).toBe('review');
    await expect(send(closed, 'x')).rejects.toThrow(`Session #${closed.child} is closed.`);
    expect(t.store.queuedOrchMessages()).toEqual([]);
    for (const x of [p, other, closed]) expect(t.store.step(x.first.id)!.messages_sent).toBe(0);
  });

  it('a batch that fails before its turn ends does not get the message: the orchestrator is told', async () => {
    const p = await running();
    sent = [];
    await send(p, 'Rebase on main.');
    t.status(p.child, 'failed');
    expect(toChild(p.child)).toEqual([]);
    expect(t.store.queuedOrchMessages()).toEqual([]);
    expect(told(p.id).at(-1)).toContain(`- Your message to step 1 (session #${p.child}) was not delivered: the session failed. It said: "Rebase on main."`);
    // the failure itself is its next news
    t.status(p.id, 'idle');
    expect(told(p.id).at(-1)).toContain('failed:');
  });

  it('a batch the owner stops does not get it either', async () => {
    const p = await running();
    sent = [];
    await send(p, 'Rebase on main.');
    t.s.ctx.sessions.finish(p.child, 'stopped');
    expect(toChild(p.child)).toEqual([]);
    expect(told(p.id).join('\n')).toContain(`Your message to step 1 (session #${p.child}) was not delivered: the session is closed. It said: "Rebase on main."`);
  });

  it('a batch that asks a question first does not get it, now or after the answer', async () => {
    const p = await running();
    sent = [];
    await send(p, 'One.');
    await send(p, 'Two.');
    const input = ask(p.child);
    // it reads the question now; what was dropped is in its next wake-up
    await t.rpc(p.id, 'answer_session', { input_id: input.id, answer: 'The small one.' });
    t.status(p.id, 'idle');
    expect(told(p.id).at(-1)).toContain(`- Your messages to step 1 (session #${p.child}) were not delivered: the session waits for an answer. They said: "One.", "Two."`);
    t.status(p.child, 'running');
    t.status(p.child, 'idle');
    expect(toChild(p.child)).toEqual([]);
    // the dropped messages stay counted
    expect(t.store.step(p.first.id)!.messages_sent).toBe(2);
  });

  it('after a server restart, a message whose batch ended its turn meanwhile is delivered', async () => {
    const p = await running();
    sent = [];
    await send(p, 'Rebase on main.');
    // the turn end the server did not see: the status changed with no event
    t.store.updateSession(p.child, { status: 'idle' });
    t.s.ctx.orchestrator.resume();
    expect(toChild(p.child)).toEqual([`${FROM} Rebase on main.`]);
    expect(t.store.session(p.child)!.status).toBe('running');
  });

  it('a closed orchestration drops what still waits, and tells nobody', async () => {
    const p = await running();
    sent = [];
    await send(p, 'Rebase on main.');
    t.s.ctx.orchestrator.stopAll(p.id, false);
    const wakes = told(p.id).length;
    t.status(p.child, 'idle');
    expect(toChild(p.child)).toEqual([]);
    expect(t.store.queuedOrchMessages()).toEqual([]);
    expect(told(p.id)).toHaveLength(wakes);
  });
});
