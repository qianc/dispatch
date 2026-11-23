import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, type Setup } from './orchestrator-helpers.ts';

// DISP-166: a deploy whose result never comes, and offers while the orchestration is paused or its
// orchestrator has no turn end, do not wait for ever.
describe('orchestrator: timeouts of deploys and offers (DISP-166)', () => {
  let t: Setup;
  let later = 0;
  beforeEach(async () => {
    t = await setup();
    later = 0;
    t.s.ctx.orchestrator.now = () => new Date(Date.now() + later);
  });
  afterEach(() => { t.s.ctx.orchestrator.stop(); return t.s.app.close(); });

  const told = (id: number) => t.events(id).filter((e) => e.startsWith('system: (From Dispatch'));
  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const titles = () => t.pushes.map((p) => p.title);
  const minutes = (n: number) => { later += n * 60_000; };
  const repoOf = (sessionId: number) => t.store.repos(t.store.session(sessionId)!.project_id!)[0];
  const running = async (extra: Record<string, unknown> = {}) => {
    const p = await t.approved(extra);
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    t.status(child, 'running');
    turn(p.id);
    t.pushes.length = 0;
    return { ...p, child };
  };
  /** step 1 is merged and its deploy runs; the pushes so far are dropped */
  const deploying = async (extra: Record<string, unknown> = {}) => {
    const p = await running(extra);
    turn(p.child);
    t.s.ctx.orchestrator.onDeploy(t.store.session(p.child)!, repoOf(p.child), 'running');
    t.pr(p.child, 'merged');
    turn(p.id);
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'running', note: 'deploying' });
    t.pushes.length = 0;
    return p;
  };

  describe('a deploy with no result', () => {
    it('fails after 30 min; the orchestrator may fix it once, else the owner is told once', async () => {
      const p = await deploying();
      minutes(29);
      t.s.ctx.orchestrator.tick();
      expect(t.store.step(p.first.id)).toMatchObject({ state: 'running', note: 'deploying' });
      minutes(1);
      t.s.ctx.orchestrator.tick();
      expect(t.store.step(p.first.id)).toMatchObject({ state: 'failed', note: 'no deploy result in 30 min', offer: 'deploy' });
      const events = told(p.id).filter((e) => e.includes('failed: no deploy result in 30 min'));
      expect(events).toHaveLength(1);
      expect(events[0]).toContain('You may fix the deploy once');
      expect(titles()).toEqual([]);
      t.s.ctx.orchestrator.tick();
      turn(p.id);
      t.s.ctx.orchestrator.tick();
      expect(t.pushes).toEqual([{ title: 'Rework auth: step 1 needs you', body: 'Its deploy failed, and the orchestrator did not fix it.', url: `/s/${p.child}` }]);
      expect(told(p.id).filter((e) => e.includes('failed: no deploy result in 30 min'))).toHaveLength(1);
    });

    it('paused: the owner is told once, at once', async () => {
      const p = await deploying();
      t.s.ctx.orchestrator.pause(p.id);
      minutes(30);
      t.s.ctx.orchestrator.tick();
      t.s.ctx.orchestrator.tick();
      expect(t.store.step(p.first.id)).toMatchObject({ state: 'failed', note: 'no deploy result in 30 min' });
      expect(titles()).toEqual(['Rework auth: step 1 failed']);
    });

    it('a late real result still counts', async () => {
      const p = await deploying();
      minutes(30);
      t.s.ctx.orchestrator.tick();
      expect(t.store.step(p.first.id)).toMatchObject({ state: 'failed' });
      t.s.ctx.orchestrator.onDeploy(t.store.session(p.child)!, repoOf(p.child), 'ok');
      expect(t.store.step(p.first.id)).toMatchObject({ state: 'done', deploys_started: {} });
    });

    it('a real failed result keeps its own note', async () => {
      const p = await deploying();
      t.s.ctx.orchestrator.onDeploy(t.store.session(p.child)!, repoOf(p.child), 'failed');
      expect(t.store.step(p.first.id)).toMatchObject({ state: 'failed', note: 'deploy failed', deploys_started: {} });
    });

    it('a deploy that ran before its start was stored ages from the first tick', async () => {
      const p = await deploying();
      t.store.updateStep(p.first.id, { deploys_started: {} });
      t.s.ctx.orchestrator.tick();
      expect(Object.keys(t.store.step(p.first.id)!.deploys_started)).toHaveLength(1);
      minutes(29);
      t.s.ctx.orchestrator.tick();
      expect(t.store.step(p.first.id)).toMatchObject({ state: 'running' });
      minutes(1);
      t.s.ctx.orchestrator.tick();
      expect(t.store.step(p.first.id)).toMatchObject({ state: 'failed', note: 'no deploy result in 30 min' });
    });
  });

  it('a live orchestration with 100 newer ones still has its deploy timed out (DISP-182)', async () => {
    const p = await deploying();
    const aa = t.store.projectByKey('AA')!;
    for (let i = 0; i < 100; i++) {
      const own = t.store.createSession({ started_by: null, project_id: aa.id, kind: 'orchestrator', title: `Old ${i}`, status: 'completed', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [], worker_id: t.store.session(p.id)!.worker_id! });
      t.store.createOrchestration({ session_id: own.id, goal: 'g', project_ids: [aa.id], max_children: 1, options: t.store.orchestration(p.id)!.options });
      t.store.updateOrchestration(own.id, { phase: 'done' });
    }
    expect(t.store.orchestrations().map((o) => o.session_id)).not.toContain(p.id);
    minutes(30);
    t.s.ctx.orchestrator.tick();
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'failed', note: 'no deploy result in 30 min' });
  });

  describe('offers', () => {
    /** step 1's merge is stopped: the orchestrator was offered to fix it */
    const stoppedMerge = async () => {
      const p = await running({ options: { auto_merge: 'github' } });
      t.status(p.child, 'idle');
      t.pr(p.child, 'open', { blocked: 'the check failed' });
      expect(t.store.step(p.first.id)).toMatchObject({ state: 'review', offer: 'fix_merge' });
      return p;
    };
    /** step 1's turn ended with no pull request: the orchestrator was offered to deal with it */
    const noPr = async () => {
      const p = await running();
      t.s.ctx.orchestrator.settleMs = 0;
      turn(p.child);
      expect(t.store.step(p.first.id)).toMatchObject({ offer: 'no_pr' });
      t.pushes.length = 0; // the batch's own "waiting for you"
      return p;
    };

    it('paused with a stopped merge offered: the owner is told', async () => {
      const p = await stoppedMerge();
      t.s.ctx.orchestrator.pause(p.id);
      expect(t.pushes).toEqual([{ title: 'Rework auth: step 1 needs you', body: 'The check failed.', url: `/s/${p.child}` }]);
      expect(t.store.step(p.first.id)).toMatchObject({ offer: null, offered_at: null });
    });

    it('paused with a turn with no pull request offered: the owner is told', async () => {
      const p = await noPr();
      t.s.ctx.orchestrator.pause(p.id);
      expect(titles()).toEqual(['Rework auth: step 1 waits for you']);
      expect(t.store.step(p.first.id)).toMatchObject({ offer: null });
    });

    it('paused after the orchestrator wrote to the batch: the owner is not told', async () => {
      const p = await noPr();
      t.store.updateStep(p.first.id, { messages_sent: 1 });
      t.s.ctx.orchestrator.pause(p.id);
      expect(titles()).toEqual([]);
    });

    it('a turn with no pull request while paused: the orchestrator is woken on resume (DISP-235)', async () => {
      const p = await running();
      t.s.ctx.orchestrator.settleMs = 0;
      t.s.ctx.orchestrator.pause(p.id);
      turn(p.child);
      expect(t.store.step(p.first.id)).toMatchObject({ state: 'running', note: 'turn ended, no PR yet', offer: null });
      const noPrTold = () => told(p.id).filter((m) => m.includes('ended its turn with no pull request'));
      expect(noPrTold()).toHaveLength(0);
      t.s.ctx.orchestrator.resumeOne(p.id);
      expect(noPrTold()).toHaveLength(1);
      expect(t.store.step(p.first.id)).toMatchObject({ offer: 'no_pr' });
    });

    it('a stopped merge with no orchestrator turn end in time goes to the owner from tick', async () => {
      const p = await stoppedMerge();
      t.status(p.id, 'running'); // it works, and its turn does not end
      minutes(9);
      t.s.ctx.orchestrator.tick();
      expect(titles()).toEqual([]);
      minutes(1);
      t.s.ctx.orchestrator.tick();
      t.s.ctx.orchestrator.tick();
      expect(titles()).toEqual(['Rework auth: step 1 needs you']);
      expect(t.store.step(p.first.id)).toMatchObject({ offer: null });
      t.status(p.id, 'idle'); // its turn ends later: not told again
      expect(titles().filter((x) => x === 'Rework auth: step 1 needs you')).toHaveLength(1);
    });

    it('a turn with no pull request with no orchestrator turn end in time goes to the owner from tick', async () => {
      const p = await noPr();
      minutes(10);
      t.s.ctx.orchestrator.tick();
      expect(titles()).toEqual(['Rework auth: step 1 waits for you']);
    });

    it('a failed deploy with no orchestrator turn end in time goes to the owner from tick', async () => {
      const p = await deploying();
      t.status(p.id, 'running');
      t.s.ctx.orchestrator.onDeploy(t.store.session(p.child)!, repoOf(p.child), 'failed');
      expect(t.store.step(p.first.id)).toMatchObject({ offer: 'deploy' });
      minutes(10);
      t.s.ctx.orchestrator.tick();
      expect(t.pushes).toEqual([{ title: 'Rework auth: step 1 needs you', body: 'Its deploy failed, and the orchestrator did not fix it in time.', url: `/s/${p.child}` }]);
    });
  });
});
