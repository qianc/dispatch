// DISP-143, DISP-148, DISP-149: what the server keeps about sessions stays true when a start fails,
// when there are many finished sessions or chats, and when a session ends during its check.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Janitor } from '../src/server/janitor.ts';
import type { CheckProgress } from '../src/shared/checkProgress.ts';
import type { SessionKind, SessionStatus } from '../src/shared/types.ts';
import { startServer, OWNER } from './helpers.ts';

const progress: CheckProgress = { stage: null, current: null, passed: 0, failed: 0, skipped: 0, units: 3, total: null, elapsed_ms: 1200 };

describe('session bookkeeping', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'NOR', name: 'No repo' });
    await s.call('POST', '/projects', { key: 'BKP', name: 'Bookkeeping' });
    s.ctx.store.addRepo(s.ctx.store.projectByKey('BKP')!.id, { github_owner: 'me', github_name: 'bkp', default_branch: 'main', check_command: 'npm test' });
  });
  afterAll(() => s.app.close());

  const session = (kind: SessionKind, status: SessionStatus, updatedAt?: string) => {
    const st = s.ctx.store;
    const made = st.createSession({ started_by: OWNER, worker_id: st.defaultWorkerId(), project_id: st.projectByKey('BKP')!.id, kind, title: `${kind} ${status}`, status, force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
    if (updatedAt) st.db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', updatedAt, made.id);
    return made;
  };

  it('a start that fails files none of the card\'s new items (DISP-143)', () => {
    const project = s.ctx.store.projectByKey('NOR')!;
    const before = s.ctx.store.items(project.id).length;
    const start = () => s.ctx.sessions.startBatch(project, { item_ids: [], new_items: [{ type: 'bug', title: 'Filed by the card', body_md: '', importance: 2, effort: null, labels: [], modules: [] }], prompt: '' }, OWNER);
    expect(start).toThrow(/Add a repo/);
    expect(start).toThrow(/Add a repo/); // a retry
    expect(s.ctx.store.items(project.id).length).toBe(before);
  });

  it('the janitor sees chats and more than 200 finished sessions (DISP-148)', async () => {
    const day = 24 * 3600_000;
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const finished = Array.from({ length: 201 }, (_, i) => session('work', 'completed', at(day + i * 1000)));
    const oldest = finished.at(-1)!;
    const closedChat = session('discuss', 'completed', at(2 * day));
    const staleChat = session('discuss', 'idle', at(8 * day));
    const freshChat = session('discuss', 'idle', at(day));
    const tidied: number[] = [];
    const hub = {
      connected: true,
      isConnected: () => true,
      cmd: async (_w: number, c: { c: string; session_id: number }) => {
        if (c.c === 'tidy') tidied.push(c.session_id);
        return c.c === 'leftovers' ? [{ repo: 'bkp', worktree: true, dirty: false, untracked: false, branch: null, merged: false, checked_out: null }] : [];
      },
    };
    const janitor = new Janitor(s.ctx.store, hub as never, {} as never, { emit: () => undefined } as never);
    await janitor.check();
    const offered = janitor.offer!.sessions.map((o) => o.id);
    expect(offered).toContain(oldest.id);
    expect(offered).toContain(closedChat.id);
    expect(tidied).toEqual([staleChat.id]);
    expect(tidied).not.toContain(freshChat.id);
    // the Activity list still leaves chats out and keeps its limit
    expect(s.ctx.store.sessions().length).toBe(200);
    expect(s.ctx.store.sessions({ statuses: ['completed'] }).some((x) => x.kind === 'discuss')).toBe(false);
  });

  it('stopping a session during its check takes the check off the page (DISP-149)', () => {
    const st = s.ctx.store;
    const repo = st.repos(st.projectByKey('BKP')!.id)[0];
    const sess = session('work', 'running');
    const checks = () => s.ctx.github.checks.of(sess.id);
    s.ctx.sessions.onWorkerMessage(sess.worker_id!, { t: 'session_check', session_id: sess.id, repo_id: repo.id, progress });
    expect(checks()).toHaveLength(1);
    s.ctx.sessions.finish(sess.id, 'stopped');
    expect(checks()).toEqual([]);
    // the worker's late reports: a progress report does not bring it back, the closing one is taken
    s.ctx.sessions.onWorkerMessage(sess.worker_id!, { t: 'session_check', session_id: sess.id, repo_id: repo.id, progress });
    expect(checks()).toEqual([]);
    s.ctx.sessions.onWorkerMessage(sess.worker_id!, { t: 'session_check', session_id: sess.id, repo_id: repo.id, done: { ok: true, duration_ms: 1000, units: 3 } });
    expect(checks()).toEqual([]);
    expect(st.checkHistory(repo.id, 'npm test')).toHaveLength(1);
  });
});
