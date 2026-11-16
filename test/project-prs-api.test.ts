import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type ProjectPrList, type PullRequest } from '../src/shared/types.ts';
import { ROUTE_ACCESS } from '../src/server/access.ts';
import { SESSION_ROUTES } from '../src/server/sessionGuard.ts';
import { PROJECT_WRITES } from '../src/server/projectLock.ts';
import { OWNER, as, startMultiUser, waitFor } from './helpers.ts';
import { ghError, ghPr, prServer } from './project-prs-helpers.ts';

type T = Awaited<ReturnType<typeof prServer>>;

const BOB_TOKEN = 'ghp_bobsOwnToken0001';
const OWN_PR = 'GitHub does not accept an approval of your own pull request.';
const NO_SESSION = 'This pull request has no session. Start work from an item.';
const GENERATE = "This repo merges only in Dispatch, on a session's worker (it has a generate command). A pull request without a session cannot be merged here.";
const MOVED = 'This pull request has new commits. Look at the changes again.';
const DEPLOY = "The repo's deploy command does not run for this merge: it needs a session's worker.";

/** #41 synced into Dispatch as a PR with no session: its row. */
async function unlinked(t: T, over: Record<string, unknown> = {}): Promise<PullRequest> {
  t.prs.set(41, ghPr(41, over));
  await t.s.ctx.github.syncProjectPrs(t.project);
  return t.s.ctx.store.prByNumber(t.repo.id, 41)!;
}
const list = async (t: T, headers: Record<string, string> = {}): Promise<ProjectPrList> => (await t.s.call('GET', '/projects/PP/prs', undefined, headers)).data;
const multi = () => prServer(startMultiUser, as('alice'));
const connectBob = async (t: T) => {
  t.s.ctx.identities.profile = async () => ({ id: 42, login: 'bob-gh', name: 'Bob Builder', email: 'bob@example.com', scopes: 'repo' });
  expect((await t.s.call('PUT', '/me/github', { token: BOB_TOKEN }, as('bob'))).status).toBe(200);
};

describe('the open PRs of a project over the API (DISP-111)', () => {
  it('the list marks each PR as linked or not', async () => {
    const t = await prServer();
    const item = (await t.s.call('POST', '/projects/PP/items', { title: 'x' })).data;
    const s = t.s.ctx.store.createSession({ started_by: OWNER, worker_id: t.s.ctx.store.defaultWorkerId(),
      project_id: t.project.id, kind: 'work', title: 'Do x', status: 'idle', force_plan: false, branch: 'dispatch/pp-1-x',
      initial_prompt: '', source_id: null, item_ids: [item.id], options: { ...DEFAULT_RUN_OPTIONS },
    });
    t.prs.set(5, ghPr(5, { head: { ref: 'dispatch/pp-1-x', sha: 'sha5' }, user: { login: 'octo' } }));
    t.prs.set(41, ghPr(41));
    await t.s.ctx.github.syncSession(s);
    const r = await t.s.call('POST', '/projects/PP/prs/sync');
    expect(r.status).toBe(200);
    const data: ProjectPrList = r.data;
    expect(data).toMatchObject({ github_repos: 1, error: null });
    expect(data.synced_at).toBeTruthy();
    // newest first
    expect(data.prs.map((p) => p.number)).toEqual([41, 5]);
    expect(data.prs[0]).toMatchObject({ linked: null, author: 'dependabot[bot]', changed_files: 2 });
    expect(data.prs[1].linked).toEqual({ session_id: s.id, title: 'Do x', item_keys: [item.key] });
    expect(item.key).toBe('PP-1');
    await t.s.app.close();
  });

  it('opening the list starts a sync when the last one is old', async () => {
    const t = await prServer();
    t.prs.set(41, ghPr(41));
    const first = await list(t);
    expect(first).toMatchObject({ prs: [], synced_at: null, github_repos: 1 });
    await waitFor(async () => (await list(t)).prs.length === 1, 'the background sync');
    // the last sync is fresh: opening the list again asks GitHub nothing
    const lists = t.args('pulls.list').length;
    await list(t);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.args('pulls.list')).toHaveLength(lists);
    await t.s.app.close();
  });

  it('a project with no GitHub repo says so and asks GitHub nothing', async () => {
    const t = await prServer();
    await t.s.call('POST', '/projects', { key: 'NG', name: 'No GitHub' });
    const r = await t.s.call('POST', '/projects/NG/prs/sync');
    expect(r.data).toMatchObject({ prs: [], github_repos: 0, error: null });
    expect(t.gh.calls).toEqual([]);
    expect((await t.s.call('GET', '/projects/NOPE/prs')).status).toBe(404);
    await t.s.app.close();
  });

  it('approve: stored and sent to GitHub as a review', async () => {
    const t = await prServer();
    const pr = await unlinked(t);
    expect((await t.s.call('GET', `/prs/${pr.id}`)).data.can_approve).toBe(true);
    const r = await t.s.call('POST', `/prs/${pr.id}/approve`);
    expect(r.status).toBe(200);
    expect(r.data.approval).toMatchObject({ by: 'local', sha: 'sha41', review: 'sent', note: null });
    expect(r.data.approval.at).toBeTruthy();
    expect(t.args('pulls.createReview')).toEqual([{ owner: 'me', repo: 'app', pull_number: 41, event: 'APPROVE', commit_id: 'sha41' }]);
    expect((await list(t)).prs[0].approval).toMatchObject({ by: 'local', review: 'sent' });
    expect((await t.s.call('GET', `/prs/${pr.id}`)).data.can_approve).toBe(false);
    await t.s.app.close();
  });

  it('approve your own PR: stored, and said clearly', async () => {
    const t = await prServer();
    const pr = await unlinked(t);
    t.fail.review = ghError(422, 'Unprocessable Entity: "Can not approve your own pull request"');
    const r = await t.s.call('POST', `/prs/${pr.id}/approve`);
    expect(r.status).toBe(200);
    expect(r.data.approval).toMatchObject({ by: 'local', sha: 'sha41', review: 'own_pr', note: OWN_PR });
    expect((await t.s.call('GET', `/prs/${pr.id}`)).data.can_approve).toBe(false);
    await t.s.app.close();
  });

  it('approve with a token that may not review: stored, not sent', async () => {
    const t = await prServer();
    const pr = await unlinked(t);
    t.fail.review = ghError(403, 'Resource not accessible by personal access token');
    const r = await t.s.call('POST', `/prs/${pr.id}/approve`);
    expect(r.status).toBe(200);
    expect(r.data.approval).toMatchObject({ by: 'local', review: 'failed' });
    expect(r.data.approval.note).toContain('Resource not accessible by personal access token');
    // another 422 is not the own-PR case
    t.fail.review = ghError(422, 'Unprocessable Entity: "commit_id is not part of the pull request"');
    expect((await t.s.call('POST', `/prs/${pr.id}/approve`)).data.approval).toMatchObject({ review: 'failed' });
    await t.s.app.close();
  });

  it('approved, then the branch moves on', async () => {
    const t = await prServer();
    const pr = await unlinked(t);
    await t.s.call('POST', `/prs/${pr.id}/approve`);
    t.prs.set(41, ghPr(41, { head: { ref: 'dep-41', sha: 'sha41b' }, updated_at: '2026-11-03T00:00:00Z' }));
    await t.s.ctx.github.syncProjectPrs(t.project);
    expect(t.s.ctx.store.pr(pr.id)).toMatchObject({ head_sha: 'sha41b', approval: { sha: 'sha41', review: 'sent' } });
    // the approval is of an older commit: Approve is offered again
    expect((await t.s.call('GET', `/prs/${pr.id}`)).data.can_approve).toBe(true);
    const again = await t.s.call('POST', `/prs/${pr.id}/approve`);
    expect(again.data.approval).toMatchObject({ sha: 'sha41b', review: 'sent' });
    expect(t.args('pulls.createReview').map((a) => a.commit_id)).toEqual(['sha41', 'sha41b']);
    await t.s.app.close();
  });

  it('an approval is of the commit the person looked at', async () => {
    const t = await prServer();
    const pr = await unlinked(t);
    const seen = (await t.s.call('GET', `/prs/${pr.id}`)).data.pr.head_sha;
    expect(seen).toBe('sha41');
    // the branch moves on, and the timer stores it, while the page still shows the old diff
    t.prs.set(41, ghPr(41, { head: { ref: 'dep-41', sha: 'sha41b' }, updated_at: '2026-11-03T00:00:00Z' }));
    await t.s.ctx.github.syncOpenPrs();
    const r = await t.s.call('POST', `/prs/${pr.id}/approve`, { sha: seen });
    expect(r.status).toBe(409);
    expect(r.data.error).toBe(MOVED);
    expect(t.args('pulls.createReview')).toEqual([]);
    expect(t.s.ctx.store.pr(pr.id)!.approval).toBeNull();
    const again = await t.s.call('POST', `/prs/${pr.id}/approve`, { sha: 'sha41b' });
    expect(again.data.approval).toMatchObject({ sha: 'sha41b', review: 'sent' });
    await t.s.app.close();
  });

  it('a second person is offered Approve, and a failed review can be sent again', async () => {
    const t = await multi();
    await connectBob(t);
    const pr = await unlinked(t);
    const can = async (user: string) => (await t.s.call('GET', `/prs/${pr.id}`, undefined, as(user))).data.can_approve;
    expect((await t.s.call('POST', `/prs/${pr.id}/approve`, undefined, as('alice'))).data.approval).toMatchObject({ by: 'alice', review: 'sent' });
    expect(await can('alice')).toBe(false);
    expect(await can('bob')).toBe(true);
    t.fail.review = ghError(403, 'Resource not accessible by personal access token');
    expect((await t.s.call('POST', `/prs/${pr.id}/approve`, undefined, as('bob'))).data.approval).toMatchObject({ by: 'bob', review: 'failed' });
    expect(await can('bob')).toBe(true);
    t.fail.review = null;
    expect((await t.s.call('POST', `/prs/${pr.id}/approve`, undefined, as('bob'))).data.approval).toMatchObject({ by: 'bob', review: 'sent', note: null });
    expect(await can('bob')).toBe(false);
    expect(t.args('pulls.createReview')).toHaveLength(3);
    await t.s.app.close();
  });

  it('a closed PR and a local review cannot be approved', async () => {
    const t = await prServer();
    const pr = await unlinked(t);
    Object.assign(t.prs.get(41)!, { state: 'closed' });
    await t.s.ctx.github.syncProjectPrs(t.project);
    const closed = await t.s.call('POST', `/prs/${pr.id}/approve`);
    expect(closed.status).toBe(400);
    const s = t.s.ctx.store.createSession({ started_by: OWNER, worker_id: t.s.ctx.store.defaultWorkerId(),
      project_id: t.project.id, kind: 'work', title: 'w', status: 'idle', force_plan: false, branch: 'dispatch/pp-1-x',
      initial_prompt: '', source_id: null, item_ids: [], options: { ...DEFAULT_RUN_OPTIONS },
    });
    const local = t.s.ctx.store.upsertPr({ session_id: s.id, repo_id: t.repo.id, number: -s.id, url: '', title: 'w', state: 'open', mergeable: true, mergeable_state: 'clean', head_ref: 'dispatch/pp-1-x', head_sha: 'abc' });
    expect((await t.s.call('POST', `/prs/${local.id}/approve`)).status).toBe(400);
    expect((await t.s.call('POST', '/prs/9999/approve')).status).toBe(404);
    expect(t.args('pulls.createReview')).toEqual([]);
    expect(t.s.ctx.store.pr(pr.id)!.approval).toBeNull();
    await t.s.app.close();
  });

  it('each person approves as themselves', async () => {
    const t = await multi();
    const pr = await unlinked(t);
    // bob has no GitHub connection yet: stored in Dispatch, and the reason is said
    const refused = await t.s.call('POST', `/prs/${pr.id}/approve`, undefined, as('bob'));
    expect(refused.status).toBe(200);
    expect(refused.data.approval).toMatchObject({ by: 'bob', review: 'failed' });
    expect(refused.data.approval.note).toContain('bob has not connected GitHub');
    expect(t.args('pulls.createReview')).toEqual([]);
    await connectBob(t);
    const sent = await t.s.call('POST', `/prs/${pr.id}/approve`, undefined, as('bob'));
    expect(sent.data.approval).toMatchObject({ by: 'bob', review: 'sent' });
    expect(t.gh.by(BOB_TOKEN)).toContain('pulls.createReview');
    expect(t.gh.by('shared')).not.toContain('pulls.createReview');
    // bob's own connection also reads the PR he opens and the list he refreshes
    t.gh.calls.length = 0;
    await t.s.call('GET', `/prs/${pr.id}`, undefined, as('bob'));
    await t.s.call('POST', '/projects/PP/prs/sync', undefined, as('bob'));
    expect(t.gh.calls.length).toBeGreaterThan(0);
    expect(t.gh.calls.filter((c) => c.token !== BOB_TOKEN)).toEqual([]);
    await t.s.app.close();
  });

  it('an unlinked PR merges on GitHub, as the caller', async () => {
    const t = await multi();
    await connectBob(t);
    const pr = await unlinked(t);
    const page = (await t.s.call('GET', `/prs/${pr.id}`, undefined, as('bob'))).data;
    expect(page).toMatchObject({ can_merge: true, merge_here: true, merge_note: null });
    const r = await t.s.call('POST', `/prs/${pr.id}/merge`, { how: 'github', method: 'squash' }, as('bob'));
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true, pr: { state: 'merged', session_id: null } });
    expect(t.args('pulls.merge')).toEqual([{ owner: 'me', repo: 'app', pull_number: 41, merge_method: 'squash' }]);
    expect(t.gh.calls.filter((c) => c.method === 'pulls.merge').map((c) => c.token)).toEqual([BOB_TOKEN]);
    expect(t.s.ctx.store.sessions({})).toEqual([]);
    expect((await list(t, as('bob'))).prs).toEqual([]);
    await t.s.app.close();
  });

  it('a merge is of the commit the person looked at', async () => {
    const t = await prServer();
    const pr = await unlinked(t);
    // GitHub refuses a merge when the head is not the one named: the commit goes with the merge
    t.prs.set(41, ghPr(41, { head: { ref: 'dep-41', sha: 'sha41b' }, updated_at: '2026-11-03T00:00:00Z' }));
    await t.s.ctx.github.syncOpenPrs();
    const old = await t.s.call('POST', `/prs/${pr.id}/merge`, { how: 'github', method: 'squash', sha: 'sha41' });
    expect(old.status).toBe(409);
    expect(old.data.error).toBe(MOVED);
    expect(t.args('pulls.merge')).toEqual([]);
    expect(t.s.ctx.store.pr(pr.id)!.state).toBe('open');
    const r = await t.s.call('POST', `/prs/${pr.id}/merge`, { how: 'github', method: 'squash', sha: 'sha41b' });
    expect(r.data).toMatchObject({ ok: true, pr: { state: 'merged' } });
    expect(t.args('pulls.merge')).toEqual([{ owner: 'me', repo: 'app', pull_number: 41, merge_method: 'squash', sha: 'sha41b' }]);
    await t.s.app.close();
  });

  it('someone with no GitHub connection cannot merge an unlinked PR', async () => {
    const t = await multi();
    const pr = await unlinked(t);
    const r = await t.s.call('POST', `/prs/${pr.id}/merge`, { how: 'github', method: 'squash' }, as('bob'));
    expect(r.status).toBe(403);
    expect(t.args('pulls.merge')).toEqual([]);
    expect(t.s.ctx.store.pr(pr.id)!.state).toBe('open');
    await t.s.app.close();
  });

  it('an unlinked PR of a repo with a generate command is not merged here', async () => {
    const t = await prServer();
    await t.s.call('PATCH', `/repos/${t.repo.id}`, { generate_command: 'node gen.mjs', generated_paths: ['backlog.md'] });
    const pr = await unlinked(t);
    const page = (await t.s.call('GET', `/prs/${pr.id}`)).data;
    expect(page).toMatchObject({ merge_here: false, can_merge: false, merge_note: GENERATE, can_approve: true });
    const r = await t.s.call('POST', `/prs/${pr.id}/merge`, { how: 'github', method: 'squash' });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe(GENERATE);
    expect(t.args('pulls.merge')).toEqual([]);
    await t.s.app.close();
  });

  it('a deploy command is named, not run', async () => {
    const t = await prServer();
    await t.s.call('PATCH', `/repos/${t.repo.id}`, { deploy_command: 'make deploy' });
    const pr = await unlinked(t);
    expect((await t.s.call('GET', `/prs/${pr.id}`)).data).toMatchObject({ merge_here: true, can_merge: true, merge_note: DEPLOY });
    expect((await t.s.call('POST', `/prs/${pr.id}/merge`, { how: 'github', method: 'merge' })).data).toMatchObject({ ok: true });
    expect(t.s.ctx.notifier.sent).toEqual([]);
    await t.s.app.close();
  });

  it('no agent work on an unlinked PR', async () => {
    const t = await prServer();
    const pr = await unlinked(t, { mergeable: false, mergeable_state: 'dirty' });
    const resolve = await t.s.call('POST', `/prs/${pr.id}/resolve-conflicts`);
    expect(resolve.status).toBe(400);
    expect(resolve.data.error).toBe(NO_SESSION);
    const local = await t.s.call('POST', `/prs/${pr.id}/merge`, { how: 'local', method: 'squash' });
    expect(local.status).toBe(400);
    expect(local.data.error).toBe(NO_SESSION);
    expect(t.s.ctx.store.sessions({})).toEqual([]);
    expect(t.args('pulls.merge')).toEqual([]);
    expect(t.s.ctx.store.pr(pr.id)!.state).toBe('open');
    await t.s.app.close();
  });

  it('the Inbox has no unlinked PR', async () => {
    const t = await prServer();
    await unlinked(t);
    expect((await t.s.call('GET', '/inbox')).data.prs).toEqual([]);
    expect((await list(t)).prs).toHaveLength(1);
    await t.s.app.close();
  });

  it('a disabled project refuses refresh and approve, and its list is not synced', async () => {
    const t = await prServer();
    const pr = await unlinked(t);
    await t.s.call('POST', '/projects/PP/disable');
    t.gh.calls.length = 0;
    expect((await t.s.call('POST', '/projects/PP/prs/sync')).status).toBe(423);
    expect((await t.s.call('POST', `/prs/${pr.id}/approve`)).status).toBe(423);
    expect((await t.s.call('POST', `/prs/${pr.id}/merge`, { how: 'github', method: 'squash' })).status).toBe(423);
    t.s.ctx.github.prSyncInfo(t.project.id).synced_at = '2020-01-01T00:00:00Z';
    expect((await list(t)).prs).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.gh.calls).toEqual([]);
    expect((await t.s.call('GET', `/prs/${pr.id}`)).data).toMatchObject({ can_approve: false });
    await t.s.app.close();
  });

  it('someone who may only read is not offered Approve or Merge', async () => {
    const t = await prServer();
    const pr = await unlinked(t);
    const auth = { authorization: `Bearer ${t.s.ctx.access.createToken('reader', ['read'], null, OWNER).secret}` };
    const page = await t.s.call('GET', `/prs/${pr.id}`, undefined, auth);
    expect(page.status).toBe(200);
    expect(page.data).toMatchObject({ can_approve: false, can_merge: false });
    expect((await t.s.call('POST', `/prs/${pr.id}/approve`, undefined, auth)).status).toBe(403);
    expect((await t.s.call('GET', '/projects/PP/prs', undefined, auth)).status).toBe(200);
    await t.s.app.close();
  });

  it('the new routes are in the three route tables', () => {
    expect(ROUTE_ACCESS['GET /api/projects/:key/prs']).toBe('read');
    for (const r of ['POST /api/projects/:key/prs/sync', 'POST /api/prs/:id/approve']) {
      expect(ROUTE_ACCESS[r]).toBe('sessions');
      expect(SESSION_ROUTES[r]).toBeNull();
      expect(PROJECT_WRITES[r]).toBeTypeOf('function');
    }
  });
});
