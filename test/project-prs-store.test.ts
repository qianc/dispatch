import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { Db } from '../src/server/db.ts';
import { dbBeforeMigration, startServer, OWNER } from './helpers.ts';

/** A project with a GitHub repo, and a way to make sessions in it. */
async function setup() {
  const s = await startServer();
  const project = (await s.call('POST', '/projects', { key: 'PP', name: 'PP' })).data;
  const repo = (await s.call('POST', '/projects/PP/repos', { github_owner: 'me', github_name: 'app' })).data;
  const session = (branch: string) => s.ctx.store.createSession({ started_by: OWNER, worker_id: s.ctx.store.defaultWorkerId(),
    project_id: project.id, kind: 'work', title: 't', status: 'idle', force_plan: false, branch,
    initial_prompt: '', source_id: null, item_ids: [], options: { ...DEFAULT_RUN_OPTIONS },
  });
  const row = (session_id: number | null, over: Record<string, unknown> = {}) => ({
    session_id, repo_id: repo.id as number, number: 4, url: 'u', title: 'PR 4', state: 'open' as const,
    mergeable: null, mergeable_state: null, head_ref: 'dep-4', head_sha: 'abc', ...over,
  });
  return { s, store: s.ctx.store, repo, session, row };
}

describe('pull requests without a session (DISP-111)', () => {
  it('a PR can be stored without a session, and a later upsert with a session links the same row', async () => {
    const { s, store, repo, session, row } = await setup();
    const first = store.upsertPr(row(null));
    expect(first.session_id).toBeNull();
    expect(first.started_by).toBeNull();
    const a = session('dispatch/pp-1-x');
    const linked = store.upsertPr(row(a.id));
    expect(linked.id).toBe(first.id);
    expect(linked.session_id).toBe(a.id);
    expect(store.prs({ repo_id: repo.id })).toHaveLength(1);
    expect(store.prByNumber(repo.id, 4)!.id).toBe(first.id);
    expect(store.prByNumber(repo.id, 5)).toBeUndefined();
    await s.app.close();
  });

  it('an upsert without a session never unlinks a row', async () => {
    const { s, store, session, row } = await setup();
    const a = session('dispatch/pp-1-x');
    store.upsertPr(row(a.id));
    expect(store.upsertPr(row(null)).session_id).toBe(a.id);
    await s.app.close();
  });

  it('a row that has a session keeps it', async () => {
    const { s, store, session, row } = await setup();
    const a = session('dispatch/pp-1-x');
    const b = session('dispatch/pp-1-x');
    store.upsertPr(row(a.id));
    const again = store.upsertPr(row(b.id, { title: 'new title' }));
    expect(again.session_id).toBe(a.id);
    expect(again.title).toBe('new title');
    await s.app.close();
  });

  it('meta, approval and review are kept on the row', async () => {
    const { s, store, row } = await setup();
    const { id } = store.upsertPr(row(null));
    expect(store.pr(id)).toMatchObject({ author: null, base_ref: null, draft: false, changed_files: null, ci_state: null, gh_updated_at: null, approval: null });
    store.setPrMeta(id, { author: 'octo', base_ref: 'main', draft: true, changed_files: 3, ci_state: 'pending', gh_updated_at: 't1' });
    store.setPrMeta(id, { ci_state: 'success' });
    expect(store.pr(id)).toMatchObject({ author: 'octo', base_ref: 'main', draft: true, changed_files: 3, ci_state: 'success', gh_updated_at: 't1' });
    store.setPrApproval(id, { by: 'alice', sha: 'abc' });
    store.setPrReview(id, 'own_pr', 'n');
    const approval = store.pr(id)!.approval!;
    expect(approval).toMatchObject({ by: 'alice', sha: 'abc', review: 'own_pr', note: 'n' });
    expect(approval.at).toBeTruthy();
    store.setPrApproval(id, { by: 'bob', sha: 'def' });
    expect(store.pr(id)!.approval).toMatchObject({ by: 'bob', sha: 'def', review: null, note: null });
    // an upsert (a sync) keeps all of it
    expect(store.upsertPr(row(null, { title: 'again' }))).toMatchObject({ author: 'octo', approval: { by: 'bob' } });
    await s.app.close();
  });

  it('migration 040 keeps existing pull requests and their merge events', () => {
    const { file, raw: old } = dbBeforeMigration('040');
    old.exec(`
      INSERT INTO projects (id, key, name, importance_scale, effort_scale) VALUES (1, 'PP', 'PP', '[]', '[]');
      INSERT INTO repos (id, project_id, github_owner, github_name) VALUES (1, 1, 'me', 'app');
      INSERT INTO sessions (id, project_id, kind, title, status, worker_id) VALUES (1, 1, 'work', 't', 'idle', (SELECT id FROM workers LIMIT 1));
      INSERT INTO pull_requests (id, session_id, repo_id, number, url, title, state, head_ref, head_sha, blocked, blocked_sha, behind_at_merge)
        VALUES (9, 1, 1, 7, 'u', 'PR 7', 'open', 'b', 'abc', 'conflicts', 'abc', 2);
      INSERT INTO merge_events (session_id, pr_id, kind) VALUES (1, 9, 'manual_merge');
    `);
    old.close();

    const db = new Db(file);
    expect(db.get('SELECT * FROM pull_requests WHERE id = 9')).toMatchObject({
      session_id: 1, repo_id: 1, number: 7, title: 'PR 7', head_sha: 'abc', blocked: 'conflicts', blocked_sha: 'abc', behind_at_merge: 2, draft: 0, author: null,
    });
    expect(db.get('SELECT pr_id FROM merge_events')).toMatchObject({ pr_id: 9 });
    db.run("INSERT INTO pull_requests (session_id, repo_id, number, url, state, head_ref) VALUES (NULL, 1, 8, 'u', 'open', 'c')");
    // the rebuilt table still answers to the merge events' foreign key
    db.run('DELETE FROM pull_requests WHERE id = 9');
    expect(db.get('SELECT pr_id FROM merge_events')).toMatchObject({ pr_id: null });
    db.raw.close();
  });
});
