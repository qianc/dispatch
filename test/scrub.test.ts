import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { scrub, scrubText } from '../src/shared/scrub.ts';
import { Secrets } from '../src/worker/secrets.ts';
import { as, startMultiUser, waitFor } from './helpers.ts';

const BOB_TOKEN = 'ghp_bobsOwnToken0001';
const SHARED = 'ghp_sharedEnvToken99';

describe('scrubbing secrets (DISP-63)', () => {
  it('replaces every secret in text, ignoring ones too short to be secrets', () => {
    expect(scrubText('token abcdefgh1234 and abcdefgh1234 again', ['abcdefgh1234'])).toBe('token [redacted] and [redacted] again');
    expect(scrubText('short x1 stays', ['x1', '', 'seven77'])).toBe('short x1 stays');
    expect(scrubText('nothing here', [])).toBe('nothing here');
  });

  it('replaces the longest secret first, so overlapping ones leave nothing behind', () => {
    // one secret inside another: the short one first would leave the long one's tail
    expect(scrubText('a ghp_abcdefgh_extra_tail b', ['ghp_abcdefgh', 'ghp_abcdefgh_extra_tail'])).toBe('a [redacted] b');
    expect(scrubText('ghp_abcdefgh alone', ['ghp_abcdefgh', 'ghp_abcdefgh_extra_tail'])).toBe('[redacted] alone');
  });

  it('scrubs strings deep in objects and arrays, and leaves the rest as it was', () => {
    const msg = { t: 'event', session_id: 3, body: { kind: 'tool_result', text: `GH_TOKEN=${BOB_TOKEN}`, list: ['ok', `x${BOB_TOKEN}y`, 7, null, true], deep: { more: [{ s: BOB_TOKEN }] } } };
    const out = scrub(msg, [BOB_TOKEN]);
    expect(out).toEqual({ t: 'event', session_id: 3, body: { kind: 'tool_result', text: 'GH_TOKEN=[redacted]', list: ['ok', 'x[redacted]y', 7, null, true], deep: { more: [{ s: '[redacted]' }] } } });
    expect(msg.body.text).toContain(BOB_TOKEN); // the original is not changed
    expect(scrub('plain', [BOB_TOKEN])).toBe('plain');
    expect(scrub(undefined, [BOB_TOKEN])).toBeUndefined();
  });

  it("the worker's Secrets collect values as they come and scrub with all of them", () => {
    const s = new Secrets();
    s.add(undefined);
    s.add('');
    s.add('short');
    expect(s.scrub({ a: 'short' })).toEqual({ a: 'short' });
    s.add('first-secret-1');
    s.add('second-secret-2');
    s.add('first-secret-1');
    expect(s.scrub({ a: ['first-secret-1 second-secret-2'] })).toEqual({ a: ['[redacted] [redacted]'] });
  });
});

/** A worker too old to scrub: sends whatever it is given, as is. */
async function oldWorker(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { 'x-worker-token': token } });
  const starts: number[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'start') starts.push(m.spec.session_id);
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', live: [], facts: { os: 'linux', hostname: 'h', slots: 2, free_slots: 2, claude_accounts: [], github_accounts: [], local_repo_dirs: [], caps: ['github_cred'] } }));
  return { ws, starts, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe('the server scrubs again what a worker sends (DISP-63)', () => {
  let s: Awaited<ReturnType<typeof startMultiUser>>;
  let close = () => undefined as void;
  afterEach(async () => {
    close();
    await s.app.close();
  });

  it("removes the starter's token and the server's env tokens from events, notices and errors before saving them", async () => {
    s = await startMultiUser({ GITHUB_TOKEN: SHARED });
    s.ctx.identities.profile = async () => ({ id: 42, login: 'bob-gh', name: 'Bob Builder', email: 'bob@example.com', scopes: 'repo' });
    await s.call('POST', '/projects', { key: 'GH', name: 'GitHub project' }, as('alice'));
    await s.call('POST', '/projects/GH/repos', { github_owner: 'me', github_name: 'gh' }, as('alice'));
    expect((await s.call('PUT', '/me/github', { token: BOB_TOKEN }, as('bob'))).status).toBe(200);
    const made = await s.call('POST', '/workers', { name: 'bobs' }, as('bob'));
    const w = await oldWorker(s.port, made.data.secret);
    close = () => w.ws.close();
    await waitFor(() => s.ctx.hub.isConnected(made.data.worker.id), "bob's worker");
    const job = (await s.call('POST', '/projects/GH/batches', { prompt: 'work' }, as('bob'))).data;
    await waitFor(() => w.starts.includes(job.id), 'start');

    w.send({ t: 'status', session_id: job.id, status: 'running', sdk_session_id: 'x' });
    w.send({ t: 'event', session_id: job.id, body: { kind: 'assistant', text: `my token is ${BOB_TOKEN}, the server's ${SHARED}` } });
    w.send({ t: 'event', session_id: job.id, body: { kind: 'tool_use', tool_use_id: 't', name: 'Bash', summary: `echo ${BOB_TOKEN}`, input: { command: `echo ${BOB_TOKEN}` } } });
    w.send({ t: 'notice', session_id: job.id, title: `Oops ${SHARED}`, body: `gh said ${BOB_TOKEN}` });
    w.send({ t: 'status', session_id: job.id, status: 'failed', error: `push failed for ${BOB_TOKEN}` });
    await waitFor(() => s.ctx.store.session(job.id)!.status === 'failed', 'failed');

    const events = await s.call('GET', `/sessions/${job.id}/events`, undefined, as('bob'));
    const session = await s.call('GET', `/sessions/${job.id}`, undefined, as('bob'));
    const all = JSON.stringify([s.ctx.store.events(job.id), events.data, session.data, s.ctx.store.session(job.id)]);
    expect(all).not.toContain(BOB_TOKEN);
    expect(all).not.toContain(SHARED);
    const texts = s.ctx.store.events(job.id).map((e) => JSON.stringify(e.body));
    expect(texts.some((t) => t.includes("my token is [redacted], the server's [redacted]"))).toBe(true);
    expect(texts.some((t) => t.includes('echo [redacted]'))).toBe(true);
    expect(texts.some((t) => t.includes('Oops [redacted]') && t.includes('gh said [redacted]'))).toBe(true);
    expect(texts.some((t) => t.includes('push failed for [redacted]'))).toBe(true);
  });
});
