import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { startServer } from './helpers.ts';

/** A session with one open GitHub PR (fake GitHub): `behind` commits behind main, mergeable or not. */
async function setup(behind: number, mergeable = true) {
  const s = await startServer();
  await s.call('POST', '/projects', { key: 'MM', name: 'MM' });
  await s.call('POST', '/projects/MM/repos', { github_owner: 'me', github_name: 'r' });
  const item = (await s.call('POST', '/projects/MM/items', { title: 'x' })).data;
  const session = s.ctx.store.createSession({
    project_id: item.project_id, kind: 'work', title: 't', status: 'idle', force_plan: false, branch: 'dispatch/mm-1-x',
    initial_prompt: '', source_id: null, item_ids: [item.id], options: { ...DEFAULT_RUN_OPTIONS, auto_merge: 'github' },
  });
  let merged = false;
  const pr = () => ({ number: 7, html_url: 'u', title: 'PR', state: merged ? 'closed' : 'open', merged_at: merged ? 'now' : null, mergeable, mergeable_state: 'clean', head: { ref: 'dispatch/mm-1-x', sha: 'abc' }, base: { ref: 'main' }, body: '' });
  Object.defineProperty(s.ctx.github, 'octo', { value: {
    pulls: { list: async () => ({ data: [pr()] }), get: async () => ({ data: pr() }), merge: async () => { merged = true; return { data: {} }; }, listFiles: async () => ({ data: [] }) },
    checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
    repos: { compareCommits: async () => ({ data: { behind_by: behind } }) },
    paginate: async () => [],
  } });
  s.ctx.github.onBehind = () => undefined;
  await s.ctx.github.syncSession(session);
  const prRow = s.ctx.store.prs({ session_id: session.id })[0];
  return { s, session, prRow };
}

describe('merge metrics', () => {
  it('records how far behind a branch was when merged', async () => {
    const { s, prRow } = await setup(0);
    expect(s.ctx.store.pr(prRow.id)!.state).toBe('merged'); // auto-merged at 0 behind
    expect(s.ctx.store.pr(prRow.id)!.behind_at_merge).toBe(0);
    await s.app.close();
  });

  it('records the agent being asked to update its branch, once', async () => {
    const { s, session } = await setup(3);
    await s.ctx.github.syncSession(session);
    expect(s.ctx.store.mergeEvents(session.id).map((e) => [e.kind, e.detail])).toEqual([['asked_update', '3 commits behind']]);
    await s.app.close();
  });

  it('records a manual merge after auto-merge stopped, with the behind count', async () => {
    const { s, session, prRow } = await setup(2, false); // conflicts: auto-merge stops
    expect(s.ctx.store.pr(prRow.id)!.blocked).toBeTruthy();
    const r = await s.call('POST', `/prs/${prRow.id}/merge`, { how: 'github', method: 'squash' });
    expect(r.status).toBe(200);
    expect(s.ctx.store.mergeEvents(session.id).map((e) => e.kind)).toEqual(['manual_merge']);
    expect(s.ctx.store.pr(prRow.id)!.behind_at_merge).toBe(2);
    await s.app.close();
  });

  it('records a resolve-conflicts session, and the PR view shows the events', async () => {
    const { s, session, prRow } = await setup(0, false);
    await s.call('POST', `/prs/${prRow.id}/resolve-conflicts`);
    expect(s.ctx.store.mergeEvents(session.id).map((e) => e.kind)).toEqual(['resolve_conflicts']);
    const detail = (await s.call('GET', `/prs/${prRow.id}`)).data;
    expect(detail.hands).toEqual([expect.objectContaining({ kind: 'resolve_conflicts' })]);
    expect(detail.pr).toHaveProperty('behind_at_merge');
    await s.app.close();
  });
});
