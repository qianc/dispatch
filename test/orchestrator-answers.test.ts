import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/server/orchestrator.ts';
import type { PendingInputPayload } from '../src/shared/types.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

const QUESTION: PendingInputPayload = {
  kind: 'question',
  questions: [{ question: 'Which approach should I take?', header: 'Approach', multiSelect: false, options: [{ label: 'Small fix', description: 'Change only what is needed' }, { label: 'Refactor', description: 'Clean up the module too' }] }],
};
const PLAN: PendingInputPayload = { kind: 'plan_approval', plan: '## Plan\n\n1. Add the store\n2. Test it' };

// Part 2: a question of a step's batch goes to the orchestrator first. It must never be lost: the
// orchestrator answers it, or it reaches the owner.
describe('orchestrator: its batches ask', () => {
  let t: Setup;
  let n = 0;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  const told = (id: number) => t.events(id).filter((e) => e.startsWith('system: (From Dispatch'));
  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  /** the batch asks (as its worker reports it); the stored question */
  const ask = (child: number, payload: PendingInputPayload = QUESTION) => {
    const local_id = `q${++n}`;
    t.s.ctx.sessions.onWorkerMessage(t.store.session(child)!.worker_id!, { t: 'input_request', session_id: child, local_id, payload });
    return t.store.inputs(child).find((i) => i.local_id === local_id)!;
  };
  const inboxInputs = async () => (await t.s.call<{ inputs: { id: number }[] }>('GET', '/inbox')).data.inputs.map((i) => i.id);
  const questionPushes = () => t.pushes.filter((x) => x.title === 'AA: question');
  /** an approved plan whose first step runs; the orchestrator is idle */
  const running = async (extra: Record<string, unknown> = {}) => {
    const p = await t.approved(extra);
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'running');
    turn(p.id);
    return { ...p, child };
  };
  /** answers reach the worker in these tests */
  const workerUp = () => { t.s.ctx.hub.send = () => true; };

  describe('delegation', () => {
    it("a batch's question goes to the orchestrator, not to the owner", async () => {
      const p = await running();
      const input = ask(p.child);
      expect(t.store.input(input.id)).toMatchObject({ delegated_to: p.id, answered_by: null });
      expect(questionPushes()).toEqual([]);
      expect(await inboxInputs()).toEqual([]);
      expect(t.store.session(p.child)).toMatchObject({ status: 'waiting_input', waiting_reason: 'Asked the orchestrator: Which approach should I take?' });
      const msg = told(p.id).at(-1)!;
      expect(msg).toContain(`- Step 1 "Token store" (AA, session #${p.child}) asks you (input_id ${input.id}):`);
      expect(msg).toContain('Q: Which approach should I take? Options: Small fix (Change only what is needed) | Refactor (Clean up the module too)');
      expect(msg).toContain('answer_session');
      expect(msg).toContain('hand_to_owner');
    });

    it("a batch's plan goes to the orchestrator with the plan text", async () => {
      const p = await running();
      const input = ask(p.child, PLAN);
      expect(t.store.input(input.id)!.delegated_to).toBe(p.id);
      expect(told(p.id).at(-1)).toContain(`wants its plan approved (input_id ${input.id}):\n## Plan\n\n1. Add the store`);
      expect(t.pushes.filter((x) => /approve plan/.test(x.title))).toEqual([]);
    });

    it('not delegated when answer_children is off, the orchestration is paused, or the session is not a step\'s batch', async () => {
      const off = await running({ answer_children: false });
      expect(ask(off.child).delegated_to).toBeNull();
      expect(questionPushes()).toHaveLength(1);
      expect(await inboxInputs()).toHaveLength(1);
      const other = (await t.s.call<{ id: number }>('POST', '/projects/AA/batches', { item_ids: [], new_items: [], prompt: 'something else' })).data;
      expect(ask(other.id).delegated_to).toBeNull();
      expect(questionPushes()).toHaveLength(2);
    });

    it('a paused orchestration does not take questions', async () => {
      const p = await running();
      await t.s.call('POST', `/orchestrations/${p.id}/pause`);
      expect(ask(p.child).delegated_to).toBeNull();
      expect(questionPushes()).toHaveLength(1);
    });

    it("the orchestrator's turn ends without an answer: the owner gets it", async () => {
      const p = await running();
      const input = ask(p.child);
      expect(questionPushes()).toEqual([]);
      turn(p.id); // it read the question and did nothing about it
      expect(t.store.input(input.id)!.delegated_to).toBeNull();
      expect(questionPushes()).toEqual([expect.objectContaining({ body: 'Which approach should I take?', url: `/s/${p.child}` })]);
      expect(await inboxInputs()).toEqual([input.id]);
      expect(t.events(p.child)).toContain('system: The orchestrator did not answer this: it is yours.');
      expect(t.store.session(p.child)!.waiting_reason).toBe('Which approach should I take?');
    });

    it('no answer in time: the owner gets it once', async () => {
      const p = await running();
      t.status(p.id, 'running'); // busy for long: the question waits in its queue
      const input = ask(p.child);
      expect(t.store.pendingOrchEvents(p.id)).toHaveLength(1);
      t.s.ctx.orchestrator.delegateTimeoutMs = 0;
      t.s.ctx.orchestrator.checkDelegated();
      t.s.ctx.orchestrator.checkDelegated();
      expect(t.store.input(input.id)!.delegated_to).toBeNull();
      expect(questionPushes()).toHaveLength(1);
      expect(t.events(p.child)).toContain('system: No answer from the orchestrator in time: this is yours.');
    });

    it('a fresh question is left with the orchestrator by the time check', async () => {
      const p = await running();
      t.status(p.id, 'running');
      const input = ask(p.child);
      t.s.ctx.orchestrator.checkDelegated();
      expect(t.store.input(input.id)!.delegated_to).toBe(p.id);
    });

    it('pause, stop and a failed orchestrator session hand open questions over', async () => {
      for (const how of ['pause', 'stop', 'fail'] as const) {
        const p = await running();
        t.status(p.id, 'running');
        const input = ask(p.child);
        const before = t.pushes.length;
        if (how === 'fail') t.status(p.id, 'failed');
        else await t.s.call('POST', `/orchestrations/${p.id}/${how}`);
        expect(t.store.input(input.id)!.delegated_to, how).toBeNull();
        expect(t.pushes.slice(before).map((x) => x.title), how).toContain('AA: question');
      }
    });

    it('a restart hands over an overdue question and keeps a fresh one', async () => {
      const p = await running();
      t.status(p.id, 'running');
      const old = ask(p.child);
      const fresh = ask(p.child);
      t.store.db.run("UPDATE pending_inputs SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", old.id);
      const again = new Orchestrator({ store: t.store, bus: t.s.ctx.bus, sessions: t.s.ctx.sessions, notifier: t.s.ctx.notifier });
      again.resume();
      again.stop();
      expect(t.store.input(old.id)!.delegated_to).toBeNull();
      expect(t.store.input(fresh.id)!.delegated_to).toBe(p.id);
      expect(questionPushes()).toHaveLength(1);
    });

    it('the owner answers a delegated question himself: the delegation ends', async () => {
      const p = await running();
      workerUp();
      const input = ask(p.child);
      const res = await t.s.call('POST', `/inputs/${input.id}/answer`, { kind: 'question', answers: { 'Which approach should I take?': 'Refactor' } });
      expect(res.status).toBe(200);
      expect(t.store.input(input.id)).toMatchObject({ delegated_to: null, answered_by: null });
      expect(t.store.input(input.id)!.answer).toEqual({ kind: 'question', answers: { 'Which approach should I take?': 'Refactor' } });
    });
  });
});
