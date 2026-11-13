import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { OWNER, startServer } from './helpers.ts';

type Server = Awaited<ReturnType<typeof startServer>>;

/** Projects AA, BB (in scope in most tests) and CC, each with one GitHub repo. */
async function projects(s: Server) {
  for (const key of ['AA', 'BB', 'CC']) {
    await s.call('POST', '/projects', { key, name: `Project ${key}` });
    await s.call('POST', `/projects/${key}/repos`, { github_owner: 'me', github_name: key.toLowerCase() });
  }
}

describe('orchestration store', () => {
  let s: Server;
  let id: number;
  beforeEach(async () => {
    s = await startServer();
    await projects(s);
    const store = s.ctx.store;
    id = store.createSession({
      project_id: null, kind: 'orchestrator', title: 'Rework', status: 'queued', force_plan: false, branch: null,
      initial_prompt: 'go', source_id: null, item_ids: [], worker_id: store.defaultWorkerId(), started_by: OWNER,
    }).id;
    const a = store.projectByKey('AA')!;
    const b = store.projectByKey('BB')!;
    store.createOrchestration({ session_id: id, goal: 'Rework auth', project_ids: [a.id, b.id], max_children: 2, options: DEFAULT_RUN_OPTIONS });
    store.replaceSteps(id, [
      { title: 'First', project_id: a.id, prompt_md: 'do a', item_ids: [], after: [] },
      { title: 'Second', project_id: b.id, prompt_md: 'do b', item_ids: [], after: [1] },
    ]);
  });
  afterEach(() => s.app.close());

  it('keeps an orchestration with its steps', () => {
    const o = s.ctx.store.orchestration(id)!;
    expect(o).toMatchObject({ session_id: id, title: 'Rework', goal: 'Rework auth', phase: 'plan', plan_approved: false, max_children: 2, project_keys: ['AA', 'BB'], paused_from: null });
    expect(o.steps.map((x) => [x.position, x.title, x.project_key, x.state])).toEqual([[1, 'First', 'AA', 'pending'], [2, 'Second', 'BB', 'pending']]);
    expect(o.steps[1].depends_on).toEqual([o.steps[0].id]);
    expect(o.steps[0]).toMatchObject({ child_session_id: null, note: null, seen: null, deploys: {} });
    expect(s.ctx.store.orchestrations().map((x) => x.session_id)).toEqual([id]);
    expect(s.ctx.store.session(id)!.orchestrator_id).toBeNull();
  });

  it('replaceSteps keeps a step with a child and drops a pending one left out', () => {
    const store = s.ctx.store;
    const [first, second] = store.orchestration(id)!.steps;
    const child = store.createSession({
      project_id: first.project_id, kind: 'work', title: 'c', status: 'queued', force_plan: false, branch: null,
      initial_prompt: '', source_id: null, item_ids: [], worker_id: store.defaultWorkerId(), started_by: OWNER,
    });
    store.updateStep(first.id, { state: 'running', child_session_id: child.id });
    store.setOrchestrator(child.id, id);
    store.replaceSteps(id, [
      { title: 'Third', project_id: first.project_id, prompt_md: '', item_ids: [], after: [2] },
      { id: first.id, title: 'First again', project_id: first.project_id, prompt_md: 'do a', item_ids: [], after: [] },
    ]);
    const steps = store.orchestration(id)!.steps;
    expect(steps.map((x) => [x.position, x.title])).toEqual([[1, 'Third'], [2, 'First again']]);
    expect(steps[1]).toMatchObject({ id: first.id, state: 'running', child_session_id: child.id });
    expect(steps[0].depends_on).toEqual([first.id]);
    expect(store.step(second.id)).toBeUndefined();
    expect(store.stepOfChild(child.id)?.id).toBe(first.id);
    expect(store.session(child.id)!.orchestrator_id).toBe(id);
  });

  it('queues events and marks them delivered once', () => {
    const store = s.ctx.store;
    store.addOrchEvent(id, 'one');
    store.addOrchEvent(id, 'two');
    const pending = store.pendingOrchEvents(id);
    expect(pending.map((e) => e.text)).toEqual(['one', 'two']);
    store.markOrchEventsDelivered(pending.map((e) => e.id));
    expect(store.pendingOrchEvents(id)).toEqual([]);
  });
});
