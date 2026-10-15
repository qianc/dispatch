import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Session } from '../src/shared/types.ts';
import { workPrompt } from '../src/worker/prompts.ts';
import type { StartSpec } from '../src/shared/protocol.ts';
import { startServer, startWorker, stopWorker, waitFor } from './helpers.ts';

const spec = (o: Partial<typeof DEFAULT_RUN_OPTIONS>): StartSpec => ({
  session_id: 1, kind: 'work', project_key: 'P', project_name: 'P', importance_scale: [], effort_scale: [], title: 't', branch: 'b',
  repos: [], items: [], source: null, prompt: '', force_plan: false, options: { ...DEFAULT_RUN_OPTIONS, ...o }, claude_account: null, github_account: null, resume: null, resume_note: null,
});

describe('run options in the agent prompt', () => {
  it('pre-answers how to run the plan, and mentions auto-merge', () => {
    expect(workPrompt(spec({}))).toMatch(/choose how to run the plan yourself/);
    expect(workPrompt(spec({ subagents: 'prefer' }))).toMatch(/subagent-driven-development/);
    expect(workPrompt(spec({ subagents: 'none' }))).toMatch(/do not use subagents/);
    expect(workPrompt(spec({}))).not.toMatch(/auto-merge/);
    expect(workPrompt(spec({ auto_merge: 'github' }))).toMatch(/auto-merge/);
  });
});

describe('start modes', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let worker: ChildProcess;
  const status = async (id: number) => (await s.call('GET', `/sessions/${id}`)).data.session.status as string;

  beforeAll(async () => {
    s = await startServer({ MAX_CONCURRENT_SESSIONS: '3' });
    worker = startWorker(s.port);
    await waitFor(() => s.ctx.hub.connected, 'worker');
    for (const key of ['A', 'B']) {
      await s.call('POST', '/projects', { key: `P${key}`, name: key });
      await s.call('POST', `/projects/P${key}/repos`, { github_owner: 'me', github_name: key });
    }
  });
  afterAll(async () => {
    await stopWorker(worker);
    await s.app.close();
  });

  it('stores options, passes them to the worker, and "now" runs alongside other work', async () => {
    const sent: unknown[] = [];
    const orig = s.ctx.hub.send.bind(s.ctx.hub);
    s.ctx.hub.send = (m) => { sent.push(m); return orig(m); };
    const a = (await s.call('POST', '/projects/PA/batches', { prompt: 'one', options: { model: 'opus', effort: 'high', subagents: 'none' } })).data as Session;
    expect(a.options).toMatchObject({ model: 'opus', effort: 'high', subagents: 'none', start: 'now', auto_merge: 'off' });
    expect(sent).toContainEqual(expect.objectContaining({ t: 'start', spec: expect.objectContaining({ options: expect.objectContaining({ model: 'opus', effort: 'high' }) }) }));
    await waitFor(async () => (await status(a.id)) === 'waiting_input', 'a waiting');
    const b = (await s.call('POST', '/projects/PB/batches', { prompt: 'two', options: { start: 'now' } })).data as Session;
    expect(b.status).toBe('running'); // A is still working; B starts next to it
    s.ctx.hub.send = orig;
  });

  it('"after" waits for earlier work in the same project only', async () => {
    const c = (await s.call('POST', '/projects/PA/batches', { prompt: 'three', options: { start: 'after' } })).data as Session;
    expect(c.status).toBe('queued'); // A (same project) is waiting for an answer
    const a = (await s.call('GET', '/sessions?project=PA')).data.find((x: Session) => x.initial_prompt === 'one');
    const input = (await s.call('GET', `/sessions/${a.id}`)).data.inputs[0];
    await s.call('POST', `/inputs/${input.id}/answer`, { kind: 'question', answers: { [input.payload.questions[0].question]: 'Small fix' } });
    await waitFor(async () => (await status(a.id)) === 'idle', 'a idle');
    // B (other project) is still busy: "after" only waits for its own project
    await waitFor(async () => (await status(c.id)) !== 'queued', 'c started');
  });
});

describe('auto-merge', () => {
  type Check = { name: string; status: string; conclusion: string | null; html_url: null };
  const setup = async (checks: Check[], mergeable: boolean | null = true, behind = 0) => {
    const s = await startServer();
    await s.call('POST', '/projects', { key: 'AM', name: 'AM' });
    await s.call('POST', '/projects/AM/repos', { github_owner: 'me', github_name: 'r' });
    const item = (await s.call('POST', '/projects/AM/items', { title: 'x' })).data;
    const session = s.ctx.store.createSession({
      project_id: item.project_id, kind: 'work', title: 't', status: 'idle', force_plan: false, branch: 'dispatch/am-1-x',
      initial_prompt: '', source_id: null, item_ids: [item.id], options: { ...DEFAULT_RUN_OPTIONS, auto_merge: 'github' },
    });
    let merged = false;
    const merges: unknown[] = [];
    const pr = () => ({ number: 7, html_url: 'u', title: 'PR', state: merged ? 'closed' : 'open', merged_at: merged ? 'now' : null, mergeable, mergeable_state: 'clean', head: { ref: 'dispatch/am-1-x', sha: 'abc' }, base: { ref: 'main' }, body: '' });
    const fake = {
      pulls: {
        list: async () => ({ data: [pr()] }),
        get: async () => ({ data: pr() }),
        merge: async (args: unknown) => { merges.push(args); merged = true; return { data: {} }; },
      },
      checks: { listForRef: async () => ({ data: { check_runs: checks } }) },
      repos: { compareCommits: async () => ({ data: { behind_by: behind } }) },
    };
    Object.defineProperty(s.ctx.github, 'octo', { value: fake });
    return { s, session, item, merges };
  };

  it('merges when the agent is done and every check passed, and closes the items', async () => {
    const { s, session, item, merges } = await setup([{ name: 'test', status: 'completed', conclusion: 'success', html_url: null }]);
    await s.ctx.github.syncSession(session);
    expect(merges).toEqual([expect.objectContaining({ pull_number: 7, merge_method: 'squash' })]);
    expect((await s.call('GET', `/items/${item.id}`)).data.status).toBe('done');
    expect(s.ctx.notifier.sent.some((n) => n.title === 'AM: auto-merged')).toBe(true);
    await s.app.close();
  });

  it('does not merge on failed checks or conflicts, and says why once', async () => {
    const failed = await setup([{ name: 'lint', status: 'completed', conclusion: 'failure', html_url: null }]);
    await failed.s.ctx.github.syncSession(failed.session);
    await failed.s.ctx.github.syncSession(failed.session);
    expect(failed.merges).toHaveLength(0);
    expect(failed.s.ctx.notifier.sent.filter((n) => n.body.includes('checks failed (lint)'))).toHaveLength(1);
    const failedCard = (await failed.s.call('GET', '/inbox')).data.idle.find((x: { id: number }) => x.id === failed.session.id);
    expect(failedCard.attention).toMatchObject({ kind: 'merge_blocked', text: expect.stringContaining('checks failed (lint)') });
    await failed.s.app.close();

    const pending = await setup([{ name: 'test', status: 'in_progress', conclusion: null, html_url: null }]);
    await pending.s.ctx.github.syncSession(pending.session);
    expect(pending.merges).toHaveLength(0);
    expect(pending.s.ctx.notifier.sent.some((n) => n.title.includes('not auto-merged'))).toBe(false); // just waits
    await pending.s.app.close();

    const conflict = await setup([], false);
    await conflict.s.ctx.github.syncSession(conflict.session);
    expect(conflict.merges).toHaveLength(0);
    expect(conflict.s.ctx.notifier.sent.some((n) => n.body.includes('merge conflicts'))).toBe(true);
    // the inbox card says so plainly
    const card = (await conflict.s.call('GET', '/inbox')).data.idle.find((x: { id: number }) => x.id === conflict.session.id);
    expect(card.attention).toMatchObject({ kind: 'merge_blocked' });
    expect(card.attention.text).toMatch(/Auto-merge stopped: PR #\d+ — it has merge conflicts/);
    await conflict.s.app.close();
  });

  it('waits for a branch behind the default branch and asks the agent once to update it', async () => {
    const { s, session, merges } = await setup([], true, 3);
    const asked: string[] = [];
    s.ctx.github.onBehind = (sess, _repo, n) => asked.push(`${sess.id}:${n}`);
    await s.ctx.github.syncSession(session);
    await s.ctx.github.syncSession(session);
    expect(merges).toHaveLength(0);
    expect(asked).toEqual([`${session.id}:3`]);
    const events = (await s.call('GET', `/sessions/${session.id}`)).data.events;
    expect(events.some((e: { body: { text?: string } }) => e.body.text?.includes('3 commits behind main'))).toBe(true);
    await s.app.close();
  });

  it('sessions from before the base check keep the old behaviour', async () => {
    const { s, session, merges } = await setup([], true, 3);
    s.ctx.store.db.run("UPDATE sessions SET options = json_set(options, '$.base_check', json('false')) WHERE id = ?", session.id);
    await s.ctx.github.syncSession(s.ctx.store.session(session.id)!);
    expect(merges).toHaveLength(1);
    await s.app.close();
  });

  it('waits while the agent is still working', async () => {
    const { s, session, merges } = await setup([]);
    s.ctx.store.updateSession(session.id, { status: 'running' });
    await s.ctx.github.syncSession(s.ctx.store.session(session.id)!);
    expect(merges).toHaveLength(0);
    await s.app.close();
  });
});
