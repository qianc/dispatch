import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, waitFor } from './helpers.ts';

describe('a worker that has connected but not said hello yet', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'HEL', name: 'Hello' });
    await s.call('POST', '/projects/HEL/repos', { github_owner: 'me', github_name: 'hel' });
  });
  afterAll(() => s.app.close());

  it('gets no sessions until its hello, then each one exactly once', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/worker`, { headers: { 'x-worker-token': 'test-token' } });
    const got: { t: string; spec?: { session_id: number } }[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    expect(s.ctx.hub.connected).toBe(false); // open, but no hello yet

    const a = (await s.call('POST', '/projects/HEL/batches', { prompt: 'x' })).data;
    await new Promise((r) => setTimeout(r, 200));
    expect((await s.call('GET', `/sessions/${a.id}`)).data.session.status).toBe('queued');
    expect(got.filter((m) => m.t === 'start')).toHaveLength(0);

    // the hello lists what the worker ran before (nothing); the queued session then starts once
    ws.send(JSON.stringify({ t: 'hello', live: [] }));
    await waitFor(() => got.some((m) => m.t === 'start'), 'start');
    await new Promise((r) => setTimeout(r, 300));
    expect(got.filter((m) => m.t === 'start' && m.spec?.session_id === a.id)).toHaveLength(1);
    expect((await s.call('GET', `/sessions/${a.id}`)).data.session.status).toBe('running');
    ws.close();
  });
});
