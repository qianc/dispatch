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
    s = await startServer();
    worker = startWorker(s.port, { MAX_CONCURRENT_SESSIONS: '3' });
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
    s.ctx.hub.send = (w, m) => { sent.push(m); return orig(w, m); };
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
    expect(s.ctx.notifier.sent.filter((n) => n.title === 'AM: done and merged')).toEqual([expect.objectContaining({ body: 'r PR #7', url: `/s/${session.id}` })]);
    await s.app.close();
  });

  it('merges once when two syncs of the same branch run at the same time', async () => {
    const { s, session, merges } = await setup([{ name: 'test', status: 'completed', conclusion: 'success', html_url: null }]);
    await Promise.all([s.ctx.github.syncSession(session), s.ctx.github.syncSession(session)]);
    await s.ctx.github.syncSession(session); // and once more after it is merged
    expect(merges).toHaveLength(1);
    expect(s.ctx.notifier.sent.filter((n) => n.title === 'AM: done and merged')).toHaveLength(1);
    expect((await s.call('GET', `/sessions/${session.id}`)).data.events.filter((e: { body: { text?: string } }) => e.body.text?.startsWith('Auto-merged'))).toHaveLength(1);
    await s.app.close();
  });

  it('a session that changed two repos gets one notice for both merges', async () => {
    const s = await startServer();
    await s.call('POST', '/projects', { key: 'TWO', name: 'Two' });
    for (const name of ['front', 'back']) await s.call('POST', '/projects/TWO/repos', { github_owner: 'me', github_name: name });
    const item = (await s.call('POST', '/projects/TWO/items', { title: 'x' })).data;
    const session = s.ctx.store.createSession({
      project_id: item.project_id, kind: 'work', title: 't', status: 'idle', force_plan: false, branch: 'dispatch/two-1-x',
      initial_prompt: '', source_id: null, item_ids: [item.id], options: { ...DEFAULT_RUN_OPTIONS, auto_merge: 'github' },
    });
    s.ctx.store.updateSession(session.id, { last_text: 'All fixed in both repos.' });
    const merged = new Set<string>();
    const pr = (repo: string) => ({ number: repo === 'front' ? 3 : 4, html_url: 'u', title: 'PR', state: merged.has(repo) ? 'closed' : 'open', merged_at: merged.has(repo) ? 'now' : null, mergeable: true, mergeable_state: 'clean', head: { ref: 'dispatch/two-1-x', sha: `sha-${repo}` }, base: { ref: 'main' }, body: '' });
    Object.defineProperty(s.ctx.github, 'octo', { value: {
      pulls: {
        list: async ({ repo }: { repo: string }) => ({ data: [pr(repo)] }),
        get: async ({ repo }: { repo: string }) => ({ data: pr(repo) }),
        merge: async ({ repo }: { repo: string }) => { merged.add(repo); return { data: {} }; },
      },
      checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
      repos: { compareCommits: async () => ({ data: { behind_by: 0 } }) },
    } });
    await s.ctx.github.syncSession(s.ctx.store.session(session.id)!);
    expect([...merged].sort()).toEqual(['back', 'front']);
    expect(s.ctx.notifier.sent.map((n) => `${n.title} | ${n.body}`)).toEqual(['TWO: done and merged (2 repos) | All fixed in both repos.']);
    const texts = (await s.call('GET', `/sessions/${session.id}`)).data.events.map((e: { body: { text?: string } }) => e.body.text).filter(Boolean);
    expect(texts).toEqual(expect.arrayContaining(['Auto-merged into front: PR #3 (squash on GitHub).', 'Auto-merged into back: PR #4 (squash on GitHub).']));
    await s.app.close();
  });

  it('sends one notice when a turn ends: the merge result if there is one, else "waiting for you"', async () => {
    const turnEnds = async (checks: Check[], withPr = true) => {
      const { s, session } = await setup(checks);
      if (!withPr) Object.defineProperty(s.ctx.github, 'octo', { value: { pulls: { list: async () => ({ data: [] }) } } });
      s.ctx.store.updateSession(session.id, { status: 'running', last_text: 'Fixed the legend.' });
      s.ctx.sessions.onWorkerMessage(s.ctx.workers.legacy().id, { t: 'status', session_id: session.id, status: 'idle' });
      await new Promise((r) => setTimeout(r, 300));
      const titles = s.ctx.notifier.sent.map((n) => `${n.title} | ${n.body}`);
      await s.app.close();
      return titles;
    };
    expect(await turnEnds([{ name: 't', status: 'completed', conclusion: 'success', html_url: null }])).toEqual(['AM: done and merged | Fixed the legend.']);
    expect(await turnEnds([{ name: 'lint', status: 'completed', conclusion: 'failure', html_url: null }])).toEqual(['AM: not auto-merged | r PR #7: checks failed (lint)']);
    expect(await turnEnds([], false)).toEqual(['AM: waiting for you | Fixed the legend.']);
  });

  it('shows "checking", not "ready to review", while auto-merge waits for the checks (DISP-1)', async () => {
    const checks: Check[] = [{ name: 'test', status: 'in_progress', conclusion: null, html_url: null }];
    const { s, session } = await setup(checks);
    const card = async () => (await s.call('GET', '/inbox')).data.idle.find((x: { id: number }) => x.id === session.id).attention;
    await s.ctx.github.syncSession(session);
    expect(await card()).toMatchObject({ kind: 'checking', text: 'Checking PR #7, then auto-merge.' });
    // the long suite fails: now the owner has to act
    checks[0] = { name: 'test', status: 'completed', conclusion: 'failure', html_url: null };
    await s.ctx.github.syncSession(session);
    expect(await card()).toMatchObject({ kind: 'merge_blocked', text: expect.stringContaining('checks failed (test)') });
    // without auto-merge the same open PR waits for the owner's review
    s.ctx.store.updateSession(session.id, { options: { ...session.options, auto_merge: 'off' } });
    s.ctx.store.setPrBlocked(s.ctx.store.prs({ session_id: session.id })[0].id, null);
    expect(await card()).toMatchObject({ kind: 'review', text: 'PR #7 is ready to review and merge.' });
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

  it('a branch still behind after the agent was asked waits for the owner, not "checking" (DISP-32)', async () => {
    const { s, session, merges } = await setup([], true, 3);
    s.ctx.github.onBehind = () => s.ctx.store.updateSession(session.id, { status: 'running' }); // the agent gets the ask
    const card = async () => (await s.call('GET', '/inbox')).data.idle.find((x: { id: number }) => x.id === session.id)?.attention;
    await s.ctx.github.syncSession(session);
    // the agent's turn ends, but the branch is still behind (it updated nothing, or another repo)
    s.ctx.store.updateSession(session.id, { status: 'idle' });
    await s.ctx.github.syncSession(s.ctx.store.session(session.id)!);
    expect(merges).toHaveLength(0);
    expect(await card()).toMatchObject({ kind: 'merge_blocked', text: expect.stringContaining('still 3 commits behind main') });
    expect(s.ctx.notifier.sent.filter((n) => n.title === 'AM: not auto-merged')).toHaveLength(1);
    await s.app.close();
  });

  it('the ask to update names the repo (DISP-32)', async () => {
    const { s, session } = await setup([], true, 3);
    s.ctx.store.updateSession(session.id, { sdk_session_id: 'sdk' });
    await s.ctx.github.syncSession(session);
    const asks = (await s.call('GET', `/sessions/${session.id}`)).data.events.filter((e: { body: { kind: string } }) => e.body.kind === 'user');
    expect(asks[0]?.body.text).toContain('your branch in r must include the latest main');
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

describe('a queued "after" batch waits for the earlier batch to merge', () => {
  type Ctx = Awaited<ReturnType<typeof startServer>>;
  let s: Ctx;
  let worker: ChildProcess;
  const merged = new Set<number>();
  const numbers = new Map<string, number>();
  let checksDone = false;
  let stuck = false;

  beforeAll(async () => {
    s = await startServer();
    worker = startWorker(s.port, { FAKE_DELAY_MS: '20' });
    await waitFor(() => s.ctx.hub.connected, 'worker');
    // a stand-in GitHub: one numbered PR per branch; checks run until checksDone
    const pr = (branch: string) => {
      if (!numbers.has(branch)) numbers.set(branch, numbers.size + 1);
      const n = numbers.get(branch)!;
      return { number: n, html_url: 'u', title: branch, state: merged.has(n) ? 'closed' : 'open', merged_at: merged.has(n) ? 'now' : null, mergeable: !stuck, mergeable_state: stuck ? 'dirty' : 'clean', head: { ref: branch, sha: `sha-${n}` }, base: { ref: 'main' }, body: '' };
    };
    Object.defineProperty(s.ctx.github, 'octo', { value: {
      pulls: {
        list: async ({ head }: { head: string }) => ({ data: [pr(head.split(':')[1])] }),
        get: async ({ pull_number }: { pull_number: number }) => ({ data: pr([...numbers].find(([, n]) => n === pull_number)![0]) }),
        merge: async ({ pull_number }: { pull_number: number }) => { merged.add(pull_number); return { data: {} }; },
      },
      checks: { listForRef: async () => ({ data: { check_runs: [{ name: 'ci', status: checksDone ? 'completed' : 'in_progress', conclusion: checksDone ? 'success' : null, html_url: null }] } }) },
      repos: { compareCommits: async () => ({ data: { behind_by: 0 } }) },
    } });
  });
  afterAll(async () => {
    await stopWorker(worker);
    await s.app.close();
  });

  const session = async (id: number) => (await s.call('GET', `/sessions/${id}`)).data as { session: Session; inputs: { id: number; payload: { questions: { question: string }[] } }[] };
  /** Batch A (auto-merge) finishes its turn while B (start after) is queued behind it. */
  const twoBatches = async (key: string) => {
    expect((await s.call('POST', '/projects', { key, name: key })).status).toBe(200);
    expect((await s.call('POST', `/projects/${key}/repos`, { github_owner: 'me', github_name: key.toLowerCase() })).status).toBe(200);
    const ra = await s.call('POST', `/projects/${key}/batches`, { prompt: 'first', options: { auto_merge: 'github' } });
    expect(ra.status, JSON.stringify(ra.data)).toBe(200);
    const rb = await s.call('POST', `/projects/${key}/batches`, { prompt: 'second', options: { start: 'after' } });
    expect(rb.status, JSON.stringify(rb.data)).toBe(200);
    const a = ra.data as Session, b = rb.data as Session;
    expect(b.status).toBe('queued');
    const input = await waitFor(async () => (await session(a.id)).inputs[0], 'a asks its question');
    await s.call('POST', `/inputs/${input.id}/answer`, { kind: 'question', answers: { [input.payload.questions[0].question]: 'Small fix' } });
    await waitFor(async () => (await session(a.id)).session.status === 'idle', 'a idle');
    const waiting = await waitFor(async () => { const x = (await session(b.id)).session; return x.waiting_reason?.includes('to merge') ? x : null; }, 'b waits for the merge');
    return { a, b, waiting };
  };

  it('starts once the earlier batch is merged', async () => {
    checksDone = false;
    stuck = false;
    const { a, b, waiting } = await twoBatches('QA');
    expect(waiting).toMatchObject({ status: 'queued', waiting_reason: `Waiting for #${a.id} first to merge` });
    checksDone = true;
    await s.ctx.github.syncSession((await session(a.id)).session); // checks pass: auto-merge, then the queue moves on
    await waitFor(async () => (await session(b.id)).session.status !== 'queued', 'b started');
    expect((await session(b.id)).session.waiting_reason).toBeNull();
  }, 30_000);

  it('holds the queue while the earlier merge is stuck; Start anyway overrides it', async () => {
    checksDone = true;
    stuck = true;
    const { a, b, waiting } = await twoBatches('QB');
    expect(waiting.waiting_reason).toBe(`Waiting for #${a.id} first to merge: it has merge conflicts`);
    await new Promise((r) => setTimeout(r, 300));
    expect((await session(b.id)).session.status).toBe('queued');
    expect((await s.call('POST', `/sessions/${b.id}/start-now`)).status).toBe(200);
    await waitFor(async () => (await session(b.id)).session.status !== 'queued', 'b started anyway');
  }, 30_000);
});
