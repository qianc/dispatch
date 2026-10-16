import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, startWorker, stopWorker, waitFor } from './helpers.ts';

describe('sessions with the fake runner', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let worker: ChildProcess;
  const session = async (id: number) => (await s.call('GET', `/sessions/${id}`)).data;

  beforeAll(async () => {
    s = await startServer({ MAX_CONCURRENT_SESSIONS: '1' });
    worker = startWorker(s.port);
    await s.call('POST', '/projects', { key: 'HC', name: 'Homecontrol' });
    await s.call('POST', '/projects/HC/repos', { github_owner: 'me', github_name: 'hc' });
    for (const title of ['One', 'Two', 'Three']) await s.call('POST', '/projects/HC/items', { title });
    await waitFor(() => s.ctx.hub.connected, 'worker connection');
  });
  afterAll(async () => {
    await stopWorker(worker);
    await s.app.close();
  });

  it('runs a batch: plan approval, question, idle, follow-up, notifications', async () => {
    const start = await s.call('POST', '/projects/HC/batches', { item_ids: [1, 2], force_plan: true });
    expect(start.status).toBe(200);
    const id = start.data.id;
    expect(start.data.branch).toBe(`dispatch/hc-${id}-one`);

    let d = await waitFor(async () => { const x = await session(id); return x.session.status === 'waiting_input' && x; }, 'plan approval');
    expect(d.inputs[0].payload.kind).toBe('plan_approval');
    expect(d.items.every((i: { status: string }) => i.status === 'in_progress')).toBe(true);
    expect(s.ctx.notifier.sent.at(-1)?.title).toBe('HC: approve plan?');

    // a message while waiting is refused
    expect((await s.call('POST', `/sessions/${id}/messages`, { text: 'hi' })).status).toBe(400);

    await s.call('POST', `/inputs/${d.inputs[0].id}/answer`, { kind: 'plan_approval', approve: true });
    d = await waitFor(async () => { const x = await session(id); return x.inputs.length === 2 && x.session.status === 'waiting_input' && x; }, 'question');
    const q = d.inputs[1];
    // wrong answer kind is rejected
    expect((await s.call('POST', `/inputs/${q.id}/answer`, { kind: 'plan_approval', approve: true })).status).toBe(400);
    await s.call('POST', `/inputs/${q.id}/answer`, { kind: 'question', answers: { [q.payload.questions[0].question]: 'Refactor' } });
    // answering twice is a conflict
    expect((await s.call('POST', `/inputs/${q.id}/answer`, { kind: 'question', answers: {} })).status).toBe(409);

    d = await waitFor(async () => { const x = await session(id); return x.session.status === 'idle' && x; }, 'idle');
    expect(d.events.some((e: { body: { kind: string; text?: string } }) => e.body.kind === 'assistant' && e.body.text?.includes('Refactor'))).toBe(true);
    expect(s.ctx.notifier.sent.at(-1)?.title).toBe('HC: waiting for you');

    await s.call('POST', `/sessions/${id}/messages`, { text: 'ship it' });
    d = await waitFor(async () => { const x = await session(id); return x.session.status === 'idle' && x.events.some((e: { body: { text?: string } }) => e.body.text === '(fake) You said: ship it') && x; }, 'follow-up');

    // the phone's poll asks only for newer events
    const all = (await s.call('GET', `/sessions/${id}`)).data.events;
    const newer = (await s.call('GET', `/sessions/${id}?after=${all.at(-2).seq}`)).data.events;
    expect(newer.map((e: { seq: number }) => e.seq)).toEqual([all.at(-1).seq]);

    const inbox = (await s.call('GET', '/inbox')).data;
    expect(inbox.idle.map((x: { id: number }) => x.id)).toContain(id);

    await s.call('POST', `/sessions/${id}/finish`, { status: 'stopped' });
    const items = (await s.call('GET', '/projects/HC/items')).data as { number: number; status: string }[];
    expect(items.filter((i) => i.number <= 2).every((i) => i.status === 'todo')).toBe(true);
  });

  it('queues sessions beyond MAX_CONCURRENT_SESSIONS and starts them when a slot frees', async () => {
    const a = (await s.call('POST', '/projects/HC/batches', { item_ids: [3] })).data;
    await waitFor(async () => (await session(a.id)).session.status === 'waiting_input', 'a waiting');
    const b = (await s.call('POST', '/projects/HC/batches', { prompt: 'something else' })).data;
    expect((await session(b.id)).session.status).toBe('queued');
    const qa = (await session(a.id)).inputs[0];
    await s.call('POST', `/inputs/${qa.id}/answer`, { kind: 'question', answers: { [qa.payload.questions[0].question]: 'Small fix' } });
    await waitFor(async () => (await session(b.id)).session.status !== 'queued', 'b started');
  });

  it('resumes live sessions after a worker restart and expires their open questions', async () => {
    const c = (await s.call('POST', '/projects/HC/batches', { prompt: 'restart test' })).data;
    // b from the previous test may hold the only slot; free it
    for (const x of (await s.call('GET', '/sessions?status=running,waiting_input,idle')).data) {
      if (x.id !== c.id) await s.call('POST', `/sessions/${x.id}/finish`, { status: 'completed' });
    }
    const before = await waitFor(async () => { const x = await session(c.id); return x.session.status === 'waiting_input' && x; }, 'c waiting');
    await stopWorker(worker);
    worker = startWorker(s.port);
    const after = await waitFor(async () => {
      const x = await session(c.id);
      return x.inputs.length >= 2 && x; // old one expired, fake runner asked again
    }, 'resume');
    expect(after.inputs.find((i: { id: number }) => i.id === before.inputs[0].id).expired).toBe(true);
    expect(after.session.sdk_session_id).toBe(before.session.sdk_session_id);
    expect(after.events.some((e: { body: { kind: string; text?: string } }) => e.body.kind === 'system' && e.body.text?.includes('resumed'))).toBe(true);
  });

  it('planner proposes a batch and splits a source into linked items', async () => {
    for (const x of (await s.call('GET', '/sessions?status=running,waiting_input,idle,queued')).data) {
      await s.call('POST', `/sessions/${x.id}/finish`, { status: 'completed' });
    }
    const src = (await s.call('POST', '/projects/HC/sources', { title: 'Retro', body_md: 'stuff', reporter: 'alex', version_tag: 'v1' })).data;
    const p = (await s.call('POST', '/projects/HC/planner', { source_id: src.id })).data;
    expect(p.kind).toBe('planner');
    const d = await waitFor(async () => { const x = await session(p.id); return x.session.status === 'idle' && x.events.find((e: { body: { kind: string } }) => e.body.kind === 'proposal') && x; }, 'proposal');
    // one push for the turn, sent at its end, with Claude's explanation
    const pushes = s.ctx.notifier.sent.filter((n) => n.url === `/s/${p.id}`);
    expect(pushes).toEqual([expect.objectContaining({ title: 'HC: proposal ready', body: '(fake) I split the source into 2 items. Check the card.' })]);
    const proposal = d.events.find((e: { body: { kind: string } }) => e.body.kind === 'proposal').body.proposal;
    expect(proposal).toMatchObject({ type: 'items', source_id: src.id });
    const eventId = d.events.find((e: { body: { kind: string } }) => e.body.kind === 'proposal').id;
    const created = (await s.call('POST', `/sessions/${p.id}/accept-items`, { items: proposal.items, source_id: proposal.source_id, event_id: eventId })).data;
    expect(created).toHaveLength(2);
    // the card is used up for every device
    expect((await s.call('POST', `/sessions/${p.id}/accept-items`, { items: proposal.items, event_id: eventId })).status).toBe(409);
    const after = await session(p.id);
    expect(after.events.find((e: { body: { kind: string } }) => e.body.kind === 'proposal_done').body).toMatchObject({ event_id: eventId, note: expect.stringMatching(/^Created HC-\d+, HC-\d+$/) });
    expect(created.every((i: { source_id: number }) => i.source_id === src.id)).toBe(true);
    // accepting the proposal completes the planning chat (now, or at the end of its turn)
    await waitFor(async () => (await session(p.id)).session.status === 'completed', 'planner completed');
  });

  it('lets the agent file items through the dispatch tools, linked to an agent_session source', async () => {
    const work = (await s.call('POST', '/projects/HC/batches', { prompt: 'x' })).data;
    const r = (await s.ctx.sessions.rpc(work.id, 'create_item', { type: 'bug', title: 'Found a leak', body_md: '', importance: 3, effort: null })) as { key: string; id: number };
    const item = (await s.call('GET', `/items/${r.id}`)).data;
    expect(item.source).toMatchObject({ kind: 'agent_session', session_id: work.id });
    await s.ctx.sessions.rpc(work.id, 'add_comment', { key: r.key, body: 'Seen in logs' });
    expect((await s.call('GET', `/items/${r.id}`)).data.comments[0]).toMatchObject({ author: 'claude', body_md: 'Seen in logs' });
  });

  it('lets the agent add items to its batch when the owner asks, so the merge closes them too', async () => {
    const a = (await s.call('POST', '/projects/HC/items', { title: 'Started with this' })).data;
    const b = (await s.call('POST', '/projects/HC/items', { title: 'Asked for later', status: 'backlog' })).data;
    const done = (await s.call('POST', '/projects/HC/items', { title: 'Already done', status: 'done' })).data;
    const work = (await s.call('POST', '/projects/HC/batches', { item_ids: [a.id] })).data;
    const res = (await s.ctx.sessions.rpc(work.id, 'add_to_batch', { keys: [b.key, done.key, b.key] })) as { batch: { key: string }[] };
    expect(res.batch.map((i) => i.key).sort()).toEqual([a.key, b.key, done.key].sort());
    const d = (await s.call('GET', `/sessions/${work.id}`)).data;
    expect(d.session.item_ids.sort()).toEqual([a.id, b.id, done.id].sort());
    expect(d.events.some((e: { body: { text?: string } }) => e.body.text === `Added to this batch: ${b.key}, ${done.key}`)).toBe(true);
    expect((await s.call('GET', `/items/${b.id}`)).data.status).toBe('in_progress');
    expect((await s.call('GET', `/items/${done.id}`)).data.status).toBe('done'); // closed stays closed
    await expect(s.ctx.sessions.rpc(work.id, 'add_to_batch', { keys: ['HC-999'] })).rejects.toThrow(/No item HC-999/);
  });
});

describe('worker reconnect edge cases', () => {
  it('stops runners for sessions that were finished while the worker was disconnected', async () => {
    const s = await startServer();
    let worker = startWorker(s.port, { FAKE_DELAY_MS: '20' });
    await s.call('POST', '/projects', { key: 'HC', name: 'HC' });
    await s.call('POST', '/projects/HC/repos', { github_owner: 'me', github_name: 'hc' });
    await waitFor(() => s.ctx.hub.connected, 'worker');
    const a = (await s.call('POST', '/projects/HC/batches', { prompt: 'x' })).data;
    // a fresh worker under a parallel test run can take a while to reach its first question
    await waitFor(async () => (await s.call('GET', `/sessions/${a.id}`)).data.session.status === 'waiting_input', 'waiting', 20_000);
    // simulate the close message being lost: mark it finished directly, then have the worker say hello again
    const sent: unknown[] = [];
    const orig = s.ctx.hub.send.bind(s.ctx.hub);
    s.ctx.hub.send = (m) => { sent.push(m); return orig(m); };
    s.ctx.store.updateSession(a.id, { status: 'completed', ended_at: new Date().toISOString() });
    s.ctx.sessions.onWorkerHello([a.id]);
    expect(sent).toContainEqual(expect.objectContaining({ t: 'close', session_id: a.id }));
    // late messages from that runner do not reopen it
    s.ctx.sessions.onWorkerMessage({ t: 'input_request', session_id: a.id, local_id: 'x', payload: { kind: 'plan_approval', plan: '' } });
    expect((await s.call('GET', `/sessions/${a.id}`)).data.session.status).toBe('completed');
    await stopWorker(worker);
    await s.app.close();
  }, 30_000);
});
