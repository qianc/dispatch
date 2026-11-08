import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTE_ACCESS } from '../src/server/access.ts';
import { SESSION_ROUTES } from '../src/server/sessionGuard.ts';
import type { SessionKind, SessionStatus } from '../src/shared/types.ts';
import { as, startMultiUser } from './helpers.ts';

const readOnly = (who: string) => `Started by ${who}: you can read it, not act on it.`;

// DISP-63: other people's sessions are read-only; the install owner (alice) may also stop them.
describe('acting on sessions someone else started', () => {
  let s: Awaited<ReturnType<typeof startMultiUser>>;
  let projectId: number;
  let repoId: number;
  beforeEach(async () => {
    s = await startMultiUser();
    await s.call('POST', '/projects', { key: 'SG', name: 'Guard' }, as('alice'));
    await s.call('POST', '/projects/SG/repos', { github_owner: 'me', github_name: 'sg' }, as('alice'));
    projectId = s.ctx.store.projectByKey('SG')!.id;
    repoId = s.ctx.store.repos(projectId)[0].id;
  });
  afterEach(() => s.app.close());

  const started = (by: string | null, status: SessionStatus = 'idle', kind: SessionKind = 'work') => s.ctx.store.createSession({
    project_id: projectId, kind, title: `${by}'s`, status, force_plan: false, branch: `dispatch/sg-${by}`, initial_prompt: '', source_id: null,
    item_ids: [], worker_id: s.ctx.workers.legacy().id, started_by: by,
  });
  const question = (sessionId: number) => s.ctx.store.createInput(sessionId, `q${sessionId}`, { kind: 'question', questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: '' }], multiSelect: false }] });
  const pr = (sessionId: number, number: number) => s.ctx.store.upsertPr({
    session_id: sessionId, repo_id: repoId, number, url: `https://github.com/me/sg/pull/${number}`, title: 't', state: 'open',
    mergeable: true, mergeable_state: 'clean', head_ref: `b${number}`, head_sha: null,
  });
  const refused = (r: { status: number; data: { error?: string } }, by: string) => {
    expect(r.status).toBe(403);
    expect(r.data.error).toBe(readOnly(by));
  };

  it('every route that acts on agent work says how it finds its session', () => {
    const acting = Object.entries(ROUTE_ACCESS).filter(([, need]) => need === 'sessions').map(([r]) => r);
    expect(acting.length).toBeGreaterThan(25);
    expect(acting.filter((r) => !(r in SESSION_ROUTES))).toEqual([]);
    // and each one is a real route
    expect(Object.keys(SESSION_ROUTES).filter((r) => !s.routes.includes(r))).toEqual([]);
  });

  it("bob cannot reply to, answer, merge or stop alice's session", async () => {
    const mine = started('alice');
    const input = question(mine.id);
    const p = pr(mine.id, 1);
    refused(await s.call('POST', `/sessions/${mine.id}/messages`, { text: 'hi' }, as('bob')), 'alice');
    refused(await s.call('POST', `/inputs/${input.id}/answer`, { kind: 'question', answers: { Which: 'A' } }, as('bob')), 'alice');
    refused(await s.call('POST', `/prs/${p.id}/merge`, { how: 'github', method: 'squash' }, as('bob')), 'alice');
    refused(await s.call('POST', `/prs/${p.id}/resolve-conflicts`, {}, as('bob')), 'alice');
    refused(await s.call('POST', `/sessions/${mine.id}/interrupt`, undefined, as('bob')), 'alice');
    refused(await s.call('POST', `/sessions/${mine.id}/finish`, { status: 'stopped' }, as('bob')), 'alice');
    refused(await s.call('POST', `/sessions/${mine.id}/pause`, undefined, as('bob')), 'alice');
    refused(await s.call('POST', `/sessions/${mine.id}/move`, { worker_id: 1 }, as('bob')), 'alice');
    refused(await s.call('POST', '/assistant/read', { session_id: mine.id, seq: 0 }, as('bob')), 'alice');
    expect(s.ctx.store.session(mine.id)!.status).toBe('idle');
    // reading it is fine, and says what bob may do
    const view = await s.call('GET', `/sessions/${mine.id}`, undefined, as('bob'));
    expect(view.status).toBe(200);
    expect(view.data.session.started_by).toBe('alice');
    expect(view.data.access).toEqual({ drive: false, stop: false });
    expect((await s.call('GET', `/sessions/${mine.id}`, undefined, as('alice'))).data.access).toEqual({ drive: true, stop: true });
  });

  it("alice (the install owner) can stop bob's session, but not reply to it", async () => {
    const his = started('bob');
    refused(await s.call('POST', `/sessions/${his.id}/messages`, { text: 'hi' }, as('alice')), 'bob');
    expect((await s.call('GET', `/sessions/${his.id}`, undefined, as('alice'))).data.access).toEqual({ drive: false, stop: true });
    expect((await s.call('POST', `/sessions/${his.id}/interrupt`, undefined, as('alice'))).status).toBe(200);
    expect((await s.call('POST', `/sessions/${his.id}/finish`, { status: 'stopped' }, as('alice'))).status).toBe(200);
    expect(s.ctx.store.session(his.id)!.status).toBe('stopped');
  });

  it('a session no user started (the legacy token) is the install owner\'s to drive', async () => {
    const old = started(null);
    refused(await s.call('POST', `/sessions/${old.id}/messages`, { text: 'hi' }, as('bob')), 'an API token');
    expect((await s.call('GET', `/sessions/${old.id}`, undefined, as('alice'))).data.access).toEqual({ drive: true, stop: true });
    expect((await s.call('POST', `/sessions/${old.id}/finish`, { status: 'completed' }, as('alice'))).status).toBe(200);
  });

  it('a batch from a proposal card needs the right to drive the chat that proposed it', async () => {
    const plan = started('alice', 'idle', 'planner');
    const card = s.ctx.store.addEvent(plan.id, { kind: 'proposal', proposal: { type: 'batch', title: 'Next', item_ids: [], new_items: [], prompt: 'go', force_plan: false } });
    const r = await s.call('POST', '/projects/SG/batches', { item_ids: [], new_items: [], prompt: 'go', proposal: { session_id: plan.id, event_id: card.id } }, as('bob'));
    refused(r, 'alice');
  });

  it('the PR view says whether you may merge it', async () => {
    const his = started('bob');
    const p = pr(his.id, 2);
    s.ctx.github.detail = async (id) => ({ pr: s.ctx.store.pr(id)! }) as never;
    expect((await s.call('GET', `/prs/${p.id}`, undefined, as('bob'))).data.can_merge).toBe(true);
    expect((await s.call('GET', `/prs/${p.id}`, undefined, as('alice'))).data.can_merge).toBe(false);
  });

  it('the inbox shows each person only what they can act on; cleanup is the install owner\'s', async () => {
    const mine = started('alice', 'running');
    const his = started('bob', 'running');
    const ask = [question(mine.id), question(his.id)];
    const idleMine = started('alice');
    const idleHis = started('bob');
    pr(mine.id, 3);
    pr(his.id, 4);

    const bob = (await s.call('GET', '/inbox', undefined, as('bob'))).data;
    expect(bob.inputs.map((i: { id: number }) => i.id)).toEqual([ask[1].id]);
    expect(bob.idle.map((x: { id: number }) => x.id)).toEqual([idleHis.id]);
    expect(bob.prs.map((x: { session_id: number }) => x.session_id)).toEqual([his.id]);
    expect(bob.sessions.map((x: { id: number }) => x.id)).toEqual([his.id]);
    expect(bob.cleanup).toBeNull();

    const alice = (await s.call('GET', '/inbox', undefined, as('alice'))).data;
    expect(alice.inputs.map((i: { id: number }) => i.id)).toEqual([ask[0].id]);
    expect(alice.idle.map((x: { id: number }) => x.id)).toEqual([idleMine.id]);
    expect(alice.prs.map((x: { session_id: number }) => x.session_id)).toEqual([mine.id]);

    expect((await s.call('POST', '/cleanup/check', undefined, as('bob'))).status).toBe(403);
    expect((await s.call('POST', '/cleanup', undefined, as('bob'))).status).toBe(403);
    expect((await s.call('POST', '/cleanup/check', undefined, as('alice'))).status).toBe(200);
  });
});
