// DISP-157: a queued "after" batch looks only at earlier sessions that can still hold it: not done
// yet, or done with a PR still open. Completed sessions without an open PR are not read at all.
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type PullRequest, type SessionStatus } from '../src/shared/types.ts';
import { OWNER, startServer } from './helpers.ts';

describe('Store.earlierWork', async () => {
  const s = await startServer();
  afterAll(() => s.app.close());
  await s.call('POST', '/projects', { key: 'EW', name: 'EW' });
  await s.call('POST', '/projects/EW/repos', { github_owner: 'me', github_name: 'ew' });
  const store = s.ctx.store;
  const project = store.projects().find((p) => p.key === 'EW')!;
  const repo = store.repos(project.id)[0];
  const session = (title: string, status: SessionStatus) => store.createSession({ started_by: OWNER, worker_id: store.defaultWorkerId(),
    project_id: project.id, kind: 'work', title, status, force_plan: false, branch: `dispatch/${title}`, initial_prompt: '', source_id: null,
    item_ids: [], options: { ...DEFAULT_RUN_OPTIONS, auto_merge: 'github' } });
  const pr = (sessionId: number, number: number, state: PullRequest['state']) =>
    store.upsertPr({ session_id: sessionId, repo_id: repo.id, number, url: '', title: 't', state, mergeable: true, mergeable_state: null, head_ref: 'b', head_sha: 'abc' });

  const done = session('done', 'completed');
  pr(done.id, 1, 'merged');
  const plain = session('plain', 'completed');
  const open = session('open', 'completed');
  pr(open.id, 2, 'open');
  pr(open.id, 3, 'merged');
  const idle = session('idle', 'idle');
  const stopped = session('stopped', 'stopped');
  pr(stopped.id, 4, 'open');
  const next = session('next', 'queued');

  it('leaves out completed sessions without an open PR, and gives the open PRs of the rest', () => {
    const rows = store.earlierWork(next);
    expect(rows.map((r) => r.id)).toEqual([open.id, idle.id]);
    expect(rows[0].open_prs.map((p) => p.number)).toEqual([2]);
    expect(rows[1].open_prs).toEqual([]);
    expect(rows.map((r) => r.id)).not.toContain(plain.id);
    expect(rows.map((r) => r.id)).not.toContain(stopped.id);
  });

  it('keeps a session whose merge check still runs', () => {
    expect(store.earlierWork(next, [done.id]).map((r) => r.id)).toEqual([done.id, open.id, idle.id]);
  });
});
