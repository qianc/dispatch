// DISP-234: an idle speaks for the message Claude answered, not the last one the worker received.
// A real server, the worker's link and its runner; only Claude and the hosted fetch are stand-ins,
// each held at the moment the race needs.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer, waitFor, OWNER } from './helpers.ts';

/** A turn of the stand-in Claude ends when the test lets it: `gate(n)` releases turn n (from 0). */
const gates: { promise: Promise<void>; open: () => void }[] = [];
const gate = (n: number) => {
  while (gates.length <= n) {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    gates.push({ promise, open });
  }
  return gates[n];
};
/** every message Claude took, over all its processes */
const got: string[] = [];
let turn = 0;

vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  // like Claude Code: it reads the input all along and queues what comes during a turn
  query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
    const mine: string[] = [];
    const waker: { wake?: () => void } = {};
    void (async () => {
      for await (const m of prompt) {
        const text = typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content);
        mine.push(text);
        got.push(text);
        waker.wake?.();
      }
    })();
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude-test' };
      for (let done = 0; ; done++) {
        while (mine.length <= done) await new Promise<void>((r) => (waker.wake = r));
        const n = turn++;
        yield { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-test', content: [{ type: 'text', text: `turn ${n}` }] } };
        await gate(n).promise;
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, duration_ms: 1, queued_turn_count: mine.length - done - 1 };
      }
    }
    return Object.assign(run(), { interrupt: async () => undefined, close: () => undefined, setPermissionMode: async () => undefined });
  },
}));

const { ServerLink, Slots } = await import('../src/worker/serverLink.ts');

describe('an idle ends the turn Claude answered (DISP-234)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let link: InstanceType<typeof ServerLink>;
  let slots: InstanceType<typeof Slots>;
  /** sessions the server took as done (sync, auto-merge) */
  let workIdles: number[];
  /** the hosted fetch before a message: held while `fetching` is set */
  let fetching: { promise: Promise<void>; open: () => void } | null;
  const get = async (id: number) => (await s.call('GET', `/sessions/${id}`)).data.session;
  const texts = async (id: number) => ((await s.call('GET', `/sessions/${id}`)).data.events as { body: { kind: string; text?: string } }[]).map((e) => e.body.text ?? '');

  beforeEach(async () => {
    gates.length = 0;
    got.length = 0;
    turn = 0;
    fetching = null;
    s = await startServer();
    await s.call('POST', '/projects', { key: 'TA', name: 'Answered' });
    await s.call('POST', '/projects/TA/repos', { github_owner: 'me', github_name: 'ta' });
    const made = s.ctx.workers.create('b', '', OWNER);
    s.ctx.workers.setDefault(made.worker.id);
    workIdles = [];
    s.ctx.sessions.onWorkIdle = async (x) => (workIdles.push(x.id), false);
    slots = new Slots(2);
    const dir = mkdtempSync(join(tmpdir(), 'dsp-answered-'));
    const entry = { name: 'home', url: `ws://127.0.0.1:${s.port}/worker`, token: made.secret, local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [], repo_env_dir: '/nonexistent' };
    link = new ServerLink(entry, {
      fake: false, workspacesDir: dir, slots, claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com',
      opts: { pluginDirs: [], settingSources: [], idleCloseMs: 60_000, assistantModel: 'haiku', discussModel: 'haiku', assistantReadDirs: [] },
    });
    link.workspaces.prepare = async () => dir;
    (link as unknown as { fetchHosted: () => Promise<void> }).fetchHosted = async () => fetching?.promise;
    link.connect(50);
    await waitFor(() => s.ctx.hub.isConnected(made.worker.id), 'worker connected');
  });
  afterEach(async () => {
    for (const g of gates) g.open();
    link.closeAll();
    await s.app.close();
  });

  /** A work session with auto-merge whose first turn runs (held at its end). */
  const started = async () => {
    const job = (await s.call('POST', '/projects/TA/batches', { prompt: 'first', options: { auto_merge: 'local', model: 'sonnet' } })).data as { id: number };
    expect((await get(job.id)).options.auto_merge).toBe('local');
    await waitFor(async () => (await texts(job.id)).includes('turn 0'), 'first turn runs');
    return job.id;
  };
  const send = async (id: number, text: string) => expect((await s.call('POST', `/sessions/${id}/messages`, { text })).status).toBe(200);
  /** long enough for a wrong idle to reach the server and be handled */
  const settle = () => new Promise((r) => setTimeout(r, 300));

  it('a message sent during a turn: the end of that turn is no idle (finding 12)', async () => {
    const id = await started();
    await send(id, 'also fix X');
    await waitFor(() => got.some((t) => t.includes('also fix X')), 'Claude has the message');
    gate(0).open(); // the first turn ends; Claude has the message queued
    await waitFor(async () => (await texts(id)).includes('turn 1'), 'the message\'s turn runs');
    await settle();
    expect(await get(id)).toMatchObject({ status: 'running', waiting_reason: null });
    expect(workIdles).toEqual([]);
    gate(1).open();
    await waitFor(async () => (await get(id)).status === 'idle', 'idle');
    expect(workIdles).toEqual([id]);
  });

  it('a message whose image is still being fetched when the turn ends: no idle (finding 12)', async () => {
    const id = await started();
    // the link hands the text over, but Claude does not have it yet
    const runner = (link as unknown as { runners: Map<number, { input: { unread: number; push: (t: string) => void } }> }).runners.get(id)!;
    let hold!: () => void;
    const held = new Promise<void>((r) => (hold = r));
    const push = runner.input.push.bind(runner.input);
    runner.input.push = (t) => {
      runner.input.unread++;
      void held.then(() => {
        runner.input.unread--;
        push(t);
      });
    };
    await send(id, 'with a picture');
    await waitFor(() => runner.input.unread === 1, 'the message is on its way to Claude');
    gate(0).open();
    await settle();
    expect(await get(id)).toMatchObject({ status: 'running', waiting_reason: null });
    hold();
    await waitFor(async () => (await texts(id)).includes('turn 1'), 'the message\'s turn runs');
    expect(workIdles).toEqual([]);
    gate(1).open();
    await waitFor(async () => (await get(id)).status === 'idle', 'idle');
    expect(workIdles).toEqual([id]);
  });

  it('a turn that ends during the hosted fetch of a new message: its idle names the old turn (finding 13)', async () => {
    const id = await started();
    let open!: () => void;
    fetching = { promise: new Promise<void>((r) => (open = r)), open: () => open() };
    await send(id, 'also fix X');
    await new Promise((r) => setTimeout(r, 100)); // the send is at the worker, its fetch runs
    gate(0).open(); // the first turn ends during the fetch
    await settle();
    expect(await get(id)).toMatchObject({ status: 'running', waiting_reason: null });
    expect(workIdles).toEqual([]);
    fetching.open();
    await waitFor(async () => (await texts(id)).includes('turn 1'), 'the message\'s turn runs');
    await settle();
    expect((await get(id)).status).toBe('running');
    expect(workIdles).toEqual([]);
    gate(1).open();
    await waitFor(async () => (await get(id)).status === 'idle', 'idle');
    expect(workIdles).toEqual([id]);
  });

  it('a runner that closes during the hosted fetch: the message starts it again, and no slot is left taken (finding 28)', async () => {
    const id = await started();
    gate(0).open();
    await waitFor(async () => (await get(id)).status === 'idle', 'first turn done');
    let open!: () => void;
    fetching = { promise: new Promise<void>((r) => (open = r)), open: () => open() };
    await send(id, 'also fix X');
    await new Promise((r) => setTimeout(r, 100));
    // its idle time runs out during the fetch
    (link as unknown as { runners: Map<number, { close(): void }> }).runners.get(id)!.close();
    expect(slots.free).toBe(2);
    fetching.open();
    await waitFor(async () => (await texts(id)).includes('turn 1'), 'the message is answered');
    expect(got.filter((t) => t.includes('also fix X'))).toHaveLength(1);
    expect((await get(id)).status).toBe('running');
    gate(1).open();
    await waitFor(async () => (await get(id)).status === 'idle', 'idle');
    expect(slots.free).toBe(2);
  });
});
