// DISP-239 and DISP-248: sessions that stayed "running" for good, and replies of the owner that were lost.
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerToWorker } from '../src/shared/protocol.ts';
import type { SessionKind, SessionStatus } from '../src/shared/types.ts';
import { startServer, waitFor, OWNER } from './helpers.ts';

describe('sessions that stay running, and lost replies', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let sent: ServerToWorker[];
  let workerId: number;
  const get = (id: number) => s.ctx.store.session(id)!;
  const texts = (id: number) => s.ctx.store.events(id).map((e) => ('text' in e.body ? e.body.text : ''));
  const make = (kind: SessionKind, status: SessionStatus, extra: Record<string, unknown> = {}) => {
    const project_id = kind === 'assistant' ? null : s.ctx.store.projectByKey('ST')!.id;
    const made = s.ctx.store.createSession({ started_by: OWNER, project_id, kind, title: 't', status, force_plan: false, branch: kind === 'work' ? 'dispatch/st-1-t' : null, initial_prompt: 'Do the work.', source_id: null, item_ids: [], worker_id: workerId });
    return Object.keys(extra).length ? s.ctx.store.updateSession(made.id, extra) : made;
  };
  const status = (id: number, st: SessionStatus, extra: Record<string, unknown> = {}) =>
    s.ctx.sessions.onWorkerMessage(workerId, { t: 'status', session_id: id, status: st, ...extra } as never);

  beforeEach(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'ST', name: 'Stuck' });
    await s.call('POST', '/projects/ST/repos', { github_owner: 'me', github_name: 'st' });
    workerId = s.ctx.workers.legacy().id;
    sent = [];
    s.ctx.hub.send = (_w, m) => (sent.push(m), true);
  });
  afterEach(() => s.app.close());

  it('#24: a chat whose worker restarted mid-turn is idle with a note, and its question is closed', () => {
    const chat = make('assistant', 'waiting_input');
    s.ctx.store.createInput(chat.id, 'q1', { kind: 'question', questions: [] });
    s.ctx.sessions.onWorkerHello(workerId, []);
    expect(get(chat.id).status).toBe('idle');
    expect(texts(chat.id).at(-1)).toMatch(/worker restarted during this turn[\s\S]*Send your message again/);
    expect(s.ctx.store.inputs(chat.id)[0].expired).toBe(true);
    expect(sent.some((m) => m.t === 'start')).toBe(false); // not resumed
  });

  it('#25: Move takes the reply that waited for the old worker along', async () => {
    const other = s.ctx.workers.create('b', '', OWNER).worker.id;
    const job = make('work', 'queued', { sdk_session_id: 'sdk-1', pending_prompt: 'Use the blue logo.' });
    const res = await s.call('POST', `/sessions/${job.id}/move`, { worker_id: other });
    expect(res.status).toBe(200);
    expect(res.data.initial_prompt).toMatch(/Do the work\.\n\nThe owner's reply, which the session had not received yet:\n\nUse the blue logo\.$/);
  });

  it('#26: an answer lost on the link is sent again when the hello says the runner still waits on it', () => {
    const job = make('work', 'running');
    const q = s.ctx.store.createInput(job.id, 'loc-1', { kind: 'question', questions: [] });
    s.ctx.store.createInput(job.id, 'loc-2', { kind: 'question', questions: [] }); // not answered yet: nothing to send
    s.ctx.store.answerInput(q.id, { kind: 'question', answers: { Which: 'A' } });
    s.ctx.sessions.onWorkerHello(workerId, [job.id], [], {}, ['loc-1', 'loc-2']);
    expect(sent.filter((m) => m.t === 'answer')).toEqual([{ t: 'answer', session_id: job.id, local_id: 'loc-1', answer: { kind: 'question', answers: { Which: 'A' } } }]);
    // the answer arrived: the next hello does not name it, and nothing goes again
    sent.length = 0;
    s.ctx.sessions.onWorkerHello(workerId, [job.id], [], {}, ['loc-2']);
    expect(sent.filter((m) => m.t === 'answer')).toEqual([]);
  });

  it('#63: during an update hold, a turn the runner starts by itself keeps the waiting reply queued', () => {
    const job = make('work', 'queued', { sdk_session_id: 'sdk-1', pending_prompt: 'my reply' });
    s.ctx.sessions.holdWorker(workerId, true);
    status(job.id, 'running');
    status(job.id, 'idle');
    expect(get(job.id)).toMatchObject({ status: 'queued', pending_prompt: 'my reply' });
  });

  it('#66: a second reply to a started session that waits goes with the first', async () => {
    const job = make('work', 'queued', { sdk_session_id: 'sdk-1', pending_prompt: 'first' });
    expect((await s.call('POST', `/sessions/${job.id}/messages`, { text: 'second' })).status).toBe(200);
    expect(get(job.id).pending_prompt).toBe('first\n\nsecond');
    // one that has not started is still refused
    const fresh = make('work', 'queued');
    expect((await s.call('POST', `/sessions/${fresh.id}/messages`, { text: 'x' })).data.error).toMatch(/not started yet/);
  });

  it('#68: Retry sign-in refuses a failed session that was retried', async () => {
    const job = make('work', 'failed', { closed_reason: 'retried', closed_at: new Date().toISOString() });
    const res = await s.call('POST', `/sessions/${job.id}/retry-login`);
    expect(res.status).toBe(409);
    expect(res.data.error).toMatch(/was retried/);
  });

  it('#69: a failed turn clears "complete when idle"', () => {
    const chat = make('planner', 'running');
    const closing = (s.ctx.sessions as unknown as { closeWhenIdle: Set<number> }).closeWhenIdle;
    closing.add(chat.id);
    status(chat.id, 'failed', { error: 'boom' });
    expect(closing.has(chat.id)).toBe(false);
  });

  it('#70: the hello neither resumes nor delivers to sessions an update holds or the owner paused', () => {
    const lost = make('work', 'running', { sdk_session_id: 'sdk-1' });
    const waiting = make('work', 'queued', { sdk_session_id: 'sdk-2', pending_prompt: 'reply' });
    const paused = make('work', 'queued', { sdk_session_id: 'sdk-3', pending_prompt: 'reply', paused: true });
    s.ctx.sessions.holdWorker(workerId, true);
    s.ctx.sessions.onWorkerHello(workerId, [waiting.id]);
    expect(get(lost.id).status).toBe('queued');
    expect(get(waiting.id)).toMatchObject({ status: 'queued', pending_prompt: 'reply' });
    expect(sent.filter((m) => m.t === 'start' || m.t === 'send')).toEqual([]);
    s.ctx.sessions.holdWorker(workerId, false);
    s.ctx.sessions.onWorkerHello(workerId, [paused.id]);
    expect(get(paused.id)).toMatchObject({ status: 'queued', pending_prompt: 'reply' });
    expect(sent.filter((m) => (m.t === 'start' && m.spec.session_id === paused.id) || (m.t === 'send' && m.session_id === paused.id))).toEqual([]);
  });

  it('#71: the Inbox shows every idle session, not the newest 200', async () => {
    s.ctx.store.db.run('BEGIN');
    for (let i = 0; i < 205; i++) make('work', 'idle');
    s.ctx.store.db.run('COMMIT');
    expect((await s.call('GET', '/inbox')).data.idle).toHaveLength(205);
  });

  it('#72: a failed discussion is not the open one: the page and a new ask agree', async () => {
    const job = make('work', 'failed');
    const old = s.ctx.store.createSession({ started_by: OWNER, project_id: job.project_id, kind: 'discuss', title: 'Why', status: 'failed', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [], worker_id: workerId, about_session: job.id });
    expect((await s.call('GET', `/sessions/${job.id}`)).data.failure.discussion).toBeNull();
    const fresh = s.ctx.sessions.discussFailure(job.id, OWNER);
    expect(fresh.id).not.toBe(old.id);
    expect((await s.call('GET', `/sessions/${job.id}`)).data.failure.discussion).toBe(fresh.id);
  });
});

describe('#67: Move reads the session again after the push', () => {
  it('an item added during the push goes to the new session', async () => {
    const s = await startServer();
    try {
      await s.call('POST', '/projects', { key: 'MV', name: 'Move' });
      await s.call('POST', '/projects/MV/repos', { github_owner: 'me', github_name: 'mv' });
      const made = s.ctx.workers.create('b', '', OWNER);
      s.ctx.workers.setDefault(made.worker.id);
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/worker`, { headers: { 'x-worker-token': made.secret } });
      const got: { t: string; req_id?: string }[] = [];
      let added: () => void = () => undefined;
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as { t: string; req_id?: string };
        got.push(m);
        // the agent adds an item while its branch is pushed
        if (m.t === 'cmd') setTimeout(() => (added(), ws.send(JSON.stringify({ t: 'cmd_result', req_id: m.req_id, ok: true, data: { ok: true } }))), 100);
      });
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ t: 'hello', live: [] }));
      const a = (await s.call('POST', '/projects/MV/items', { title: 'First' })).data;
      const b = (await s.call('POST', '/projects/MV/items', { title: 'Added later', status: 'backlog' })).data;
      const job = (await s.call('POST', '/projects/MV/batches', { item_ids: [a.id] })).data;
      await waitFor(() => got.some((m) => m.t === 'start'), 'started');
      ws.send(JSON.stringify({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'sdk-m' }));
      await waitFor(() => s.ctx.store.session(job.id)!.sdk_session_id === 'sdk-m', 'running');
      added = () => void s.ctx.sessions.rpc(job.id, 'add_to_batch', { keys: [b.key] });
      const res = await s.call('POST', `/sessions/${job.id}/move`, { worker_id: s.ctx.workers.legacy().id });
      expect(res.status).toBe(200);
      expect(res.data.item_ids.sort()).toEqual([a.id, b.id].sort());
      ws.close();
    } finally {
      await s.app.close();
    }
  });
});
