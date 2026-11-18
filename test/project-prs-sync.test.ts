import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { ciStateOf } from '../src/server/github.ts';
import { OWNER, as, startMultiUser, waitFor } from './helpers.ts';
import { ghError, ghPr, prServer } from './project-prs-helpers.ts';

type T = Awaited<ReturnType<typeof prServer>>;

const ok = [{ name: 'test', status: 'completed', conclusion: 'success' }];
const running = [{ name: 'test', status: 'in_progress', conclusion: null }];

/** The open rows of me/app, by PR number. */
const open = (t: T) => new Map(t.s.ctx.store.prs({ repo_id: t.repo.id, open_only: true }).map((p) => [p.number, p]));
const sync = (t: T, opts?: { full?: boolean }) => t.s.ctx.github.syncProjectPrs(t.project, opts);

/** A work session on a branch, with one item. */
async function session(t: T, branch = 'dispatch/pp-1-x') {
  const item = (await t.s.call('POST', '/projects/PP/items', { title: 'x' })).data;
  t.s.ctx.store.updateItem(item.id, { status: 'in_progress' }); // as a started session leaves it
  const s = t.s.ctx.store.createSession({ started_by: OWNER, worker_id: t.s.ctx.store.defaultWorkerId(),
    project_id: t.project.id, kind: 'work', title: 'work', status: 'idle', force_plan: false, branch,
    initial_prompt: '', source_id: null, item_ids: [item.id], options: { ...DEFAULT_RUN_OPTIONS },
  });
  return { item, session: s };
}
const ready = (t: T) => t.s.ctx.notifier.sent.filter((n) => n.title.includes('PR ready'));

describe('the open PRs of a project (DISP-111)', () => {
  it('opened: PRs with no session appear with author, branches, CI state and changed files', async () => {
    const t = await prServer();
    t.prs.set(41, ghPr(41));
    t.prs.set(42, ghPr(42, { draft: true }));
    t.checks.set('sha41', ok);
    await sync(t);
    expect(open(t).get(41)).toMatchObject({
      session_id: null, title: 'PR 41', url: 'https://github.com/me/app/pull/41', author: 'dependabot[bot]', base_ref: 'main',
      head_ref: 'dep-41', head_sha: 'sha41', changed_files: 2, ci_state: 'success', draft: false, mergeable: true, local: false,
    });
    expect(open(t).get(42)).toMatchObject({ session_id: null, draft: true, ci_state: 'none' });
    expect(t.s.ctx.github.prSyncInfo(t.project.id)).toMatchObject({ error: null });
    expect(t.s.ctx.github.prSyncInfo(t.project.id).synced_at).toBeTruthy();
    // nothing an unlinked PR starts: no notice, no session
    expect(t.s.ctx.notifier.sent).toEqual([]);
    expect(t.s.ctx.store.sessions({})).toEqual([]);
    await t.s.app.close();
  });

  it('updated: the same row gets the new title and head; an unchanged PR costs no pulls.get', async () => {
    const t = await prServer();
    t.prs.set(41, ghPr(41));
    t.prs.set(42, ghPr(42));
    t.checks.set('sha41', ok);
    t.checks.set('sha42', ok);
    t.checks.set('sha41b', ok);
    await sync(t);
    const id = open(t).get(41)!.id;
    t.prs.set(41, ghPr(41, { title: 'New title', head: { ref: 'dep-41', sha: 'sha41b' }, updated_at: '2026-11-02T00:00:00Z', changed_files: 5 }));
    t.gh.calls.length = 0;
    await sync(t);
    expect(open(t).get(41)).toMatchObject({ id, title: 'New title', head_sha: 'sha41b', changed_files: 5, gh_updated_at: '2026-11-02T00:00:00Z' });
    expect(t.args('pulls.get').map((a) => a.pull_number)).toEqual([41]);
    expect(t.args('pulls.list')).toHaveLength(1);
    await t.s.app.close();
  });

  it('a pending CI state is asked again, a settled one is not', async () => {
    const t = await prServer();
    t.prs.set(41, ghPr(41));
    t.prs.set(42, ghPr(42));
    t.checks.set('sha41', running);
    t.checks.set('sha42', ok);
    await sync(t);
    expect(open(t).get(41)!.ci_state).toBe('pending');
    t.gh.calls.length = 0;
    t.checks.set('sha41', ok);
    await sync(t);
    expect(t.args('checks.listForRef').map((a) => a.ref)).toEqual(['sha41']);
    expect(open(t).get(41)!.ci_state).toBe('success');
    t.gh.calls.length = 0;
    await sync(t, { full: true });
    expect(t.args('checks.listForRef').map((a) => a.ref).sort()).toEqual(['sha41', 'sha42']);
    await t.s.app.close();
  });

  it('no checks yet on a fresh PR is asked again; on an old PR it is not', async () => {
    const t = await prServer();
    t.prs.set(41, ghPr(41, { updated_at: new Date(Date.now() - 60_000).toISOString() }));
    t.prs.set(42, ghPr(42, { updated_at: new Date(Date.now() - 86400_000).toISOString() }));
    await sync(t);
    expect(open(t).get(41)!.ci_state).toBe('none');
    t.gh.calls.length = 0;
    t.checks.set('sha41', ok);
    t.checks.set('sha42', ok);
    await sync(t);
    expect(t.args('checks.listForRef').map((a) => a.ref)).toEqual(['sha41']);
    expect(open(t).get(41)!.ci_state).toBe('success');
    expect(open(t).get(42)!.ci_state).toBe('none');
    await t.s.app.close();
  });

  it('closed and merged PRs leave the open list and keep their state', async () => {
    const t = await prServer();
    t.prs.set(41, ghPr(41));
    t.prs.set(42, ghPr(42));
    await sync(t);
    const ids = [open(t).get(41)!.id, open(t).get(42)!.id];
    Object.assign(t.prs.get(41)!, { state: 'closed', merged_at: '2026-11-02T00:00:00Z' });
    Object.assign(t.prs.get(42)!, { state: 'closed' });
    await sync(t);
    expect(open(t).size).toBe(0);
    expect(ids.map((id) => t.s.ctx.store.pr(id)!.state)).toEqual(['merged', 'closed']);
    await t.s.app.close();
  });

  it("a session's PR stays one row and keeps its session", async () => {
    const t = await prServer();
    const { item, session: s } = await session(t);
    t.prs.set(5, ghPr(5, { head: { ref: 'dispatch/pp-1-x', sha: 'sha5' }, user: { login: 'octo' } }));
    await t.s.ctx.github.syncSession(s);
    expect(ready(t)).toHaveLength(1);
    await sync(t);
    const rows = t.s.ctx.store.prs({ repo_id: t.repo.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: 5, session_id: s.id, author: 'octo', base_ref: 'main', changed_files: 2, ci_state: 'none' });
    expect(t.s.ctx.store.item(item.id)!.status).toBe('in_review');
    expect(ready(t)).toHaveLength(1);
    await t.s.app.close();
  });

  it("a linked PR that merged on GitHub goes through its session: the items are done", async () => {
    const t = await prServer();
    const { item, session: s } = await session(t);
    t.prs.set(5, ghPr(5, { head: { ref: 'dispatch/pp-1-x', sha: 'sha5' } }));
    await t.s.ctx.github.syncSession(s);
    Object.assign(t.prs.get(5)!, { state: 'closed', merged_at: '2026-11-02T00:00:00Z' });
    await sync(t);
    expect(t.s.ctx.store.prs({ repo_id: t.repo.id })[0]).toMatchObject({ state: 'merged', session_id: s.id });
    expect(t.s.ctx.store.item(item.id)!.status).toBe('done');
    await t.s.app.close();
  });

  it('a PR the project sync stored first is adopted by its session', async () => {
    const t = await prServer();
    const { item, session: s } = await session(t);
    t.prs.set(5, ghPr(5, { head: { ref: 'dispatch/pp-1-x', sha: 'sha5' } }));
    await sync(t);
    const first = open(t).get(5)!;
    expect(first.session_id).toBeNull();
    expect(t.s.ctx.store.item(item.id)!.status).toBe('in_progress');
    await t.s.ctx.github.syncSession(s);
    expect(t.s.ctx.store.prs({ repo_id: t.repo.id })).toHaveLength(1);
    expect(open(t).get(5)).toMatchObject({ id: first.id, session_id: s.id });
    expect(t.s.ctx.store.item(item.id)!.status).toBe('in_review');
    await t.s.app.close();
  });

  it('a session that takes a PR while the project sync reads it keeps what it stored', async () => {
    const t = await prServer();
    const { item, session: s } = await session(t);
    t.prs.set(5, ghPr(5, { head: { ref: 'dispatch/pp-1-x', sha: 'sha5' } }));
    let go!: () => void;
    t.hold.checks = new Promise<void>((r) => { go = r; });
    // the project sync has read #5 as open and waits for its checks
    const running = sync(t);
    await waitFor(() => t.args('checks.listForRef').length === 1, 'the read of the checks');
    // meanwhile it merges, and its session sync stores that
    t.prs.set(5, ghPr(5, { head: { ref: 'dispatch/pp-1-x', sha: 'sha5' }, state: 'closed', merged_at: '2026-11-02T00:00:00Z' }));
    await t.s.ctx.github.syncSession(s);
    expect(t.s.ctx.store.prByNumber(t.repo.id, 5)).toMatchObject({ state: 'merged', session_id: s.id });
    go();
    await running;
    expect(t.s.ctx.store.prs({ repo_id: t.repo.id })).toHaveLength(1);
    expect(t.s.ctx.store.prByNumber(t.repo.id, 5)).toMatchObject({ state: 'merged', session_id: s.id });
    expect(t.s.ctx.store.item(item.id)!.status).toBe('done');
    await t.s.app.close();
  });

  it('local and hosted repos are not asked', async () => {
    const t = await prServer();
    const base = { default_branch: 'main', check_command: null, deploy_command: null, generate_command: null, github_account: null };
    t.s.ctx.store.addRepo(t.project.id, { ...base, github_owner: 'local', github_name: 'tpl', local_path: '/nonexistent/tpl' } as never);
    t.s.ctx.store.addRepo(t.project.id, { ...base, github_owner: 'hosted', github_name: 'site', kind: 'hosted', upstream_owner: 'me', upstream_name: 'site' } as never);
    t.repos.set('site', new Map([[3, ghPr(3)]]));
    t.prs.set(41, ghPr(41));
    await sync(t);
    expect(t.args('pulls.list').map((a) => `${a.owner}/${a.repo} ${a.state}`)).toEqual(['me/app open']);
    expect(t.s.ctx.store.prs({}).map((p) => p.number)).toEqual([41]);
    await t.s.app.close();
  });

  it('a failing GitHub keeps the list and reports the error', async () => {
    const t = await prServer();
    const lib = (await t.s.call('POST', '/projects/PP/repos', { github_owner: 'me', github_name: 'lib' })).data;
    t.prs.set(41, ghPr(41));
    t.prs.set(42, ghPr(42));
    await sync(t);
    t.fail.list = ghError(403, 'API rate limit exceeded');
    t.repos.set('lib', new Map([[1, ghPr(1)]]));
    await sync(t);
    expect([...open(t).keys()].sort()).toEqual([41, 42]);
    expect(t.s.ctx.github.prSyncInfo(t.project.id).error).toBe('me/app: API rate limit exceeded');
    expect(t.s.ctx.store.prs({ repo_id: lib.id, open_only: true }).map((p) => p.number)).toEqual([1]);
    t.fail.list = null;
    await sync(t);
    expect(t.s.ctx.github.prSyncInfo(t.project.id).error).toBeNull();
    await t.s.app.close();
  });

  it('a repo that no account can read: said on the list when someone asks', async () => {
    const t = await prServer();
    Object.defineProperty(t.s.ctx.github, 'octo', { value: null, configurable: true, writable: true });
    const r = await t.s.call('POST', '/projects/PP/prs/sync');
    expect(r.status).toBe(200);
    expect(r.data.error).toBe('me/app: No GitHub account is configured (GITHUB_ACCOUNTS or GITHUB_TOKEN)');
    expect(r.data.synced_at).toBeTruthy();
    expect(t.args('pulls.list')).toEqual([]);
    await t.s.app.close();
  });

  it('the timer with no account to read with leaves the list as its last reader left it', async () => {
    const t = await prServer(startMultiUser, as('alice'));
    Object.defineProperty(t.s.ctx.github, 'octo', { value: null, configurable: true, writable: true });
    await t.s.ctx.github.syncOpenPrs();
    expect(t.s.ctx.github.prSyncInfo(t.project.id)).toEqual({ synced_at: null, error: null });
    // bob reads with his own GitHub connection
    t.s.ctx.identities.profile = async () => ({ id: 42, login: 'bob-gh', name: 'Bob Builder', email: 'bob@example.com', scopes: 'repo' });
    expect((await t.s.call('PUT', '/me/github', { token: 'ghp_bobsOwnToken0001' }, as('bob'))).status).toBe(200);
    t.prs.set(41, ghPr(41));
    const r = await t.s.call('POST', '/projects/PP/prs/sync', undefined, as('bob'));
    expect(r.data).toMatchObject({ error: null, prs: [{ number: 41 }] });
    await t.s.ctx.github.syncOpenPrs();
    expect(t.s.ctx.github.prSyncInfo(t.project.id)).toEqual({ synced_at: r.data.synced_at, error: null });
    await t.s.app.close();
  });

  it('two syncs at once run once', async () => {
    const t = await prServer();
    t.prs.set(41, ghPr(41));
    await Promise.all([sync(t), sync(t)]);
    expect(t.args('pulls.list')).toHaveLength(1);
    expect(t.s.ctx.store.prs({ repo_id: t.repo.id })).toHaveLength(1);
    await sync(t);
    expect(t.args('pulls.list')).toHaveLength(2);
    await t.s.app.close();
  });

  it("a fork's PR and a deleted author", async () => {
    const t = await prServer();
    const { session: s } = await session(t);
    t.prs.set(43, ghPr(43, { user: null, head: { ref: 'dispatch/pp-1-x', sha: 'f', repo: { full_name: 'other/app' } } }));
    await sync(t);
    await t.s.ctx.github.syncSession(s);
    await sync(t);
    expect(open(t).get(43)).toMatchObject({ author: null, session_id: null, head_ref: 'dispatch/pp-1-x' });
    await t.s.app.close();
  });

  it('more than a page of open PRs', async () => {
    const t = await prServer();
    for (let n = 1; n <= 120; n++) t.prs.set(n, ghPr(n));
    await sync(t);
    await sync(t);
    expect(open(t).size).toBe(120);
    expect(t.args('pulls.get').filter((a) => a.pull_number === 120)).toHaveLength(1);
    await t.s.app.close();
  });

  it('a disabled project is skipped by the timer sync', async () => {
    const t = await prServer();
    t.prs.set(41, ghPr(41));
    await t.s.call('POST', '/projects/PP/disable');
    await t.s.ctx.github.syncOpenPrs();
    expect(t.args('pulls.list')).toEqual([]);
    await t.s.call('POST', '/projects/PP/enable');
    await t.s.ctx.github.syncOpenPrs();
    expect(open(t).size).toBe(1);
    await t.s.app.close();
  });

  it('the PR page of an unlinked PR', async () => {
    const t = await prServer();
    t.prs.set(41, ghPr(41, { body: 'Bumps vite.' }));
    t.checks.set('sha41', ok);
    await sync(t);
    const r = await t.s.call('GET', `/prs/${open(t).get(41)!.id}`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ auto_merge: 'off', hands: [], base_ref: 'main', body: 'Bumps vite.', merge_note: null, merge_here: true });
    expect(r.data.files).toHaveLength(1);
    expect(r.data.checks).toEqual([expect.objectContaining({ name: 'test', conclusion: 'success' })]);
    await t.s.app.close();
  });

  it('opening a PR refreshes its state, changed files and CI state', async () => {
    const t = await prServer();
    t.prs.set(41, ghPr(41));
    t.checks.set('sha41', running);
    await sync(t);
    const id = open(t).get(41)!.id;
    t.checks.set('sha41', [{ name: 'test', status: 'completed', conclusion: 'failure' }]);
    await t.s.call('GET', `/prs/${id}`);
    expect(t.s.ctx.store.pr(id)).toMatchObject({ ci_state: 'failure', changed_files: 1 });
    Object.assign(t.prs.get(41)!, { state: 'closed' });
    expect((await t.s.call('GET', `/prs/${id}`)).data.pr.state).toBe('closed');
    await t.s.app.close();
  });

  it('ciStateOf', () => {
    expect(ciStateOf([])).toBe('none');
    expect(ciStateOf([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }])).toBe('pending');
    expect(ciStateOf([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }])).toBe('failure');
    expect(ciStateOf([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }, { status: 'completed', conclusion: 'neutral' }])).toBe('success');
  });
});
