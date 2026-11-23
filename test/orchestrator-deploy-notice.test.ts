import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { OWNER } from './helpers.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

// DISP-103: the deploy after a step's merge is told by the orchestration, not by the batch's own
// notice. The owner gets a push only when the result needs them.
describe('orchestrator: deploy notices of a step (DISP-103)', () => {
  let t: Setup;
  beforeEach(async () => { t = await setup(); });
  afterEach(() => t.s.app.close());

  const told = (id: number) => t.events(id).filter((e) => e.startsWith('system: (From Dispatch'));
  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const titles = () => t.pushes.map((p) => p.title);
  /** the worker's report of a deploy for a session's first repo */
  const deployResult = (sessionId: number, ok: boolean) => {
    const session = t.store.session(sessionId)!;
    const repo = t.store.repos(session.project_id!)[0];
    t.s.ctx.sessions.onWorkerMessage(session.worker_id!, { t: 'deploy_result', session_id: sessionId, repo_id: repo.id, ok, sha: 'abc1234', output: ok ? 'done' : 'boom', duration_ms: 1000 });
  };
  /** step 1 runs, its pull request is merged and its deploy runs; the pushes so far are dropped */
  const deploying = async (extra: Record<string, unknown> = {}) => {
    const p = await t.approved(extra);
    turn(p.id);
    const child = await t.startStep(p.id, p.first.id);
    turn(child);
    const repo = t.store.repos(t.store.session(child)!.project_id!)[0];
    t.s.ctx.orchestrator.onDeploy(t.store.session(child)!, repo, 'running');
    t.pr(child, 'merged');
    turn(p.id);
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'running', note: 'deploying' });
    t.pushes.length = 0;
    return { ...p, child };
  };

  it('a failed deploy gives no push while the orchestrator has it; the event stays in the batch. Starting an unrelated step does not deal with it (DISP-243)', async () => {
    const p = await deploying();
    deployResult(p.child, false);
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'failed', note: 'deploy failed' });
    expect(t.events(p.child).some((e) => e.startsWith('error: Deploy failed for'))).toBe(true);
    expect(told(p.id).at(-1)).toContain('failed: deploy failed');
    expect(told(p.id).at(-1)).toContain('You may fix the deploy once');
    expect(titles()).toEqual([]);
    // its turn: it only starts the independent step 3, so the owner is told of step 1's deploy
    t.status(p.id, 'running');
    await t.startStep(p.id, p.third.id);
    t.status(p.id, 'idle');
    expect(t.pushes).toEqual([{ title: 'Rework auth: step 1 needs you', body: 'Its deploy failed, and the orchestrator did not fix it.', url: `/s/${p.child}` }]);
  });

  it('a failed deploy the orchestrator does nothing for gives exactly one push', async () => {
    const p = await deploying();
    deployResult(p.child, false);
    expect(titles()).toEqual([]);
    turn(p.id);
    expect(t.pushes).toEqual([{ title: 'Rework auth: step 1 needs you', body: 'Its deploy failed, and the orchestrator did not fix it.', url: `/s/${p.child}` }]);
  });

  it('the push waits while the orchestrator has not got the event yet', async () => {
    const p = await deploying();
    t.status(p.id, 'running');
    deployResult(p.child, false);
    t.status(p.id, 'idle'); // the turn that could not know it
    expect(titles()).toEqual([]);
    turn(p.id);
    expect(titles()).toEqual(['Rework auth: step 1 needs you']);
  });

  it('an orchestrator that does not answer its batches: one push, at once', async () => {
    const p = await deploying({ answer_children: false });
    deployResult(p.child, false);
    expect(titles()).toEqual(['Rework auth: step 1 failed']);
    expect(told(p.id).at(-1)).not.toContain('You may fix the deploy once');
  });

  it('a paused orchestration: one push, at once', async () => {
    const p = await deploying();
    t.s.ctx.orchestrator.pause(p.id);
    deployResult(p.child, false);
    expect(titles()).toEqual(['Rework auth: step 1 failed']);
  });

  it('paused while it has the failure: the owner is told once', async () => {
    const p = await deploying();
    t.status(p.id, 'running');
    deployResult(p.child, false);
    t.s.ctx.orchestrator.pause(p.id);
    expect(titles()).toEqual(['Rework auth: step 1 needs you']);
    t.status(p.id, 'idle');
    expect(t.pushes).toHaveLength(1);
  });

  it('a second failed deploy after its fix: the owner is told', async () => {
    const p = await deploying();
    deployResult(p.child, false);
    t.status(p.id, 'running');
    const fix = await t.startStep(p.id, p.third.id);
    t.status(p.id, 'idle');
    turn(fix);
    t.pushes.length = 0; // the batch's own "waiting for you": it has no pull request yet
    const repo = t.store.repos(t.store.session(fix)!.project_id!)[0];
    t.s.ctx.orchestrator.onDeploy(t.store.session(fix)!, repo, 'running');
    t.pr(fix, 'merged');
    expect(titles()).toEqual([]);
    deployResult(fix, false);
    expect(titles()).toEqual(['Rework auth: step 3 failed']);
  });

  it('a good deploy of a step is silent', async () => {
    const p = await deploying();
    deployResult(p.child, true);
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'done' });
    expect(t.events(p.child).some((e) => e.startsWith('system: Deployed'))).toBe(true);
    expect(titles()).toEqual([]);
  });

  it('the batch of a stopped orchestration gets its own notice again', async () => {
    const p = await deploying();
    t.s.ctx.orchestrator.stopAll(p.id, false);
    t.pushes.length = 0;
    deployResult(p.child, false);
    expect(titles()).toEqual(['AA: merged, but the deploy failed']);
  });

  it('a session with no orchestrator gets its notices as before', async () => {
    const project = t.store.session((await deploying()).child)!.project_id!;
    const plain = t.store.createSession({ started_by: OWNER, worker_id: t.store.defaultWorkerId(), project_id: project, kind: 'work', title: 'Plain', status: 'idle',
      force_plan: false, branch: 'dispatch/aa-9-x', initial_prompt: '', source_id: null, item_ids: [], options: DEFAULT_RUN_OPTIONS });
    deployResult(plain.id, false);
    deployResult(plain.id, true);
    expect(titles()).toEqual(['AA: merged, but the deploy failed', 'AA: done, merged and deployed']);
  });

  it('no worker for the deploy: a step tells it through the orchestration, a plain session by its own notice', async () => {
    const p = await deploying();
    const repo = t.store.repos(t.store.session(p.child)!.project_id!)[0];
    await t.s.call('PATCH', `/repos/${repo.id}`, { deploy_command: 'make deploy' });
    const github = t.s.ctx.github as unknown as { deploy(pr: unknown): void };
    t.s.ctx.hub.send = () => false;
    github.deploy(t.store.prs({ session_id: p.child })[0]);
    expect(t.store.step(p.first.id)).toMatchObject({ state: 'failed', note: 'deploy failed' });
    expect(t.events(p.child).some((e) => e.startsWith('error: Deploy failed for'))).toBe(true);
    expect(titles()).toEqual([]);
    const plain = t.store.createSession({ started_by: OWNER, worker_id: t.store.defaultWorkerId(), project_id: repo.project_id, kind: 'work', title: 'Plain', status: 'idle',
      force_plan: false, branch: 'dispatch/aa-9-x', initial_prompt: '', source_id: null, item_ids: [], options: DEFAULT_RUN_OPTIONS });
    github.deploy({ ...t.store.prs({ session_id: p.child })[0], session_id: plain.id });
    expect(titles()).toEqual(['AA: merged, but the deploy failed']);
  });
});
