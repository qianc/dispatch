import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startServer, startWorker, stopWorker, waitFor } from './helpers.ts';

let s: Awaited<ReturnType<typeof startServer>>;
let worker: ChildProcess;

beforeAll(async () => {
  s = await startServer();
  worker = startWorker(s.port);
  await waitFor(() => s.ctx.hub.connected, 'worker');
  await s.call('POST', '/projects', { key: 'CNS', name: 'CNS' });
  await s.call('POST', '/projects/CNS/repos', { github_owner: 'me', github_name: 'r' });
});
afterAll(async () => {
  await stopWorker(worker);
  await s.app.close();
});

// the server once could not write chat events (a damaged database) and said nothing: the session ran
// on, auto-merged and deployed, and its chat was empty
it('stops the turn, turns auto-merge off and tells the owner once when the chat cannot be saved', async () => {
  const sess = (await s.call('POST', '/projects/CNS/batches', { prompt: 'x', options: { auto_merge: 'local' } })).data;
  await waitFor(async () => ['waiting_input', 'idle'].includes((await s.call('GET', `/sessions/${sess.id}`)).data.session.status), 'session started');
  const sent: { t: string }[] = [];
  const send = s.ctx.hub.send.bind(s.ctx.hub);
  s.ctx.hub.send = (w, m) => { sent.push(m); return send(w, m); };
  const addEvent = s.ctx.store.addEvent.bind(s.ctx.store);
  s.ctx.store.addEvent = () => { throw new Error('database disk image is malformed'); };
  try {
    const event = { t: 'event' as const, session_id: sess.id, body: { kind: 'assistant' as const, text: 'hi' } };
    expect(() => s.ctx.sessions.onWorkerMessage(sess.worker_id, event)).toThrow(/malformed/);
    expect(() => s.ctx.sessions.onWorkerMessage(sess.worker_id, event)).toThrow(/malformed/);
    expect(sent.filter((m) => m.t === 'interrupt')).toHaveLength(1);
    const after = (await s.call('GET', `/sessions/${sess.id}`)).data.session;
    expect(after.options.auto_merge).toBe('off');
    expect(after.waiting_reason).toMatch(/chat could not be saved/i);
    const notices = s.ctx.notifier.sent.filter((n) => /chat not saved/.test(n.title));
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toMatch(/malformed/);
  } finally {
    s.ctx.store.addEvent = addEvent;
    s.ctx.hub.send = send;
  }
});
