import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../src/server/db.ts';
import { forUser } from '../src/server/routes/stream.ts';
import type { LiveEvent } from '../src/shared/types.ts';
import { as, startMultiUser } from './helpers.ts';

const sub = (n: string) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } });
const notice = { title: 'T', body: 'B', url: '/s/1' };

describe('push notifications per user (DISP-65)', () => {
  // alice is the install owner, bob another person
  let s: Awaited<ReturnType<typeof startMultiUser>>;
  let delivered: string[];
  beforeEach(async () => {
    s = await startMultiUser();
    delivered = [];
    s.ctx.notifier.deliver = async (endpoint) => { delivered.push(endpoint); };
    expect((await s.call('POST', '/push/subscribe', sub('alice-phone'), as('alice'))).status).toBe(200);
    expect((await s.call('POST', '/push/subscribe', sub('bob-phone'), as('bob'))).status).toBe(200);
  });
  afterEach(() => s.app.close());

  it('a session notice goes to its starter, not to the others', async () => {
    await s.ctx.notifier.send(notice, 'bob');
    expect(delivered).toEqual([sub('bob-phone').endpoint]);
    expect(s.ctx.notifier.sent.at(-1)).toMatchObject({ title: 'T', to: ['bob'] });
  });

  it('a notice with nobody named is the install owner\'s: install-wide, and work no user started', async () => {
    await s.ctx.notifier.send(notice);
    await s.ctx.notifier.send(notice, null);
    await s.ctx.notifier.send(notice, []);
    expect(delivered).toEqual([sub('alice-phone').endpoint, sub('alice-phone').endpoint, sub('alice-phone').endpoint]);
  });

  it('a notice for several people reaches each once', async () => {
    await s.ctx.notifier.send(notice, ['alice', 'bob', 'alice', null]);
    expect(delivered.sort()).toEqual([sub('alice-phone').endpoint, sub('bob-phone').endpoint]);
  });

  it('a session the owner did not start notifies its starter', async () => {
    const { data: p } = await s.call('POST', '/projects', { key: 'PU', name: 'Push' }, as('alice'));
    const made = s.ctx.store.createSession({ started_by: 'bob', worker_id: s.ctx.store.defaultWorkerId()!, project_id: p.id, kind: 'work', title: 'w', status: 'running', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
    // the worker says the turn ended with a question for the starter
    s.ctx.sessions.onWorkerMessage(made.worker_id!, { t: 'notice', session_id: made.id, title: 'a question', body: 'Which one?' });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.ctx.notifier.sent.filter((n) => n.title === 'PU: a question').map((n) => n.to)).toEqual([['bob']]);
    expect(delivered).toEqual([sub('bob-phone').endpoint]);
  });

  it('a person cannot unsubscribe, count or thin out another person\'s devices', async () => {
    const r = await s.call('POST', '/push/unsubscribe', { endpoint: sub('alice-phone').endpoint }, as('bob'));
    expect(r).toMatchObject({ status: 200, data: { removed: 0 } });
    expect(s.ctx.store.pushSubscriptions('alice').map((x) => x.endpoint)).toEqual([sub('alice-phone').endpoint]);

    await s.call('POST', '/push/subscribe', sub('bob-laptop'), as('bob'));
    expect((await s.call('GET', '/push/devices', undefined, as('bob'))).data).toEqual({ count: 2 });
    expect((await s.call('GET', '/push/devices', undefined, as('alice'))).data).toEqual({ count: 1 });
    // keep-only thins out bob's devices only
    expect((await s.call('POST', '/push/keep-only', { endpoint: sub('bob-laptop').endpoint }, as('bob'))).data).toEqual({ removed: 1 });
    expect(s.ctx.store.pushSubscriptions().map((x) => x.endpoint).sort()).toEqual([sub('alice-phone').endpoint, sub('bob-laptop').endpoint]);
    // not with a device that is someone else's
    expect((await s.call('POST', '/push/keep-only', { endpoint: sub('alice-phone').endpoint }, as('bob'))).data).toMatchObject({ removed: 0, error: expect.any(String) });
    // one's own goes
    expect((await s.call('POST', '/push/unsubscribe', { endpoint: sub('bob-laptop').endpoint }, as('bob'))).data).toMatchObject({ removed: 1 });
    expect(s.ctx.store.pushSubscriptions('bob')).toEqual([]);
  });

  it('focus on another person\'s device does not quiet it', async () => {
    await s.call('POST', '/push/presence', { endpoint: sub('alice-phone').endpoint, active: true }, as('bob'));
    expect(s.ctx.notifier.activeCount()).toBe(0);
    await s.call('POST', '/push/presence', { endpoint: sub('alice-phone').endpoint, active: true }, as('alice'));
    expect(s.ctx.notifier.activeCount()).toBe(1);
  });

  it('the test notice goes to the caller\'s devices', async () => {
    expect((await s.call('POST', '/push/test', {}, as('bob'))).data).toEqual({ ok: true, subscriptions: 1 });
    expect(delivered).toEqual([sub('bob-phone').endpoint]);
  });

  it('subscribing again on a device moves it to the person now signed in there', async () => {
    await s.call('POST', '/push/subscribe', sub('alice-phone'), as('bob'));
    expect(s.ctx.store.pushSubscriptions('alice')).toEqual([]);
    expect(s.ctx.store.pushSubscriptions('bob').map((x) => x.endpoint).sort()).toEqual([sub('alice-phone').endpoint, sub('bob-phone').endpoint]);
  });

  it('a token cannot subscribe: notifications are a person\'s', async () => {
    const token = s.ctx.access.createToken('ci', ['read', 'tracker', 'sessions', 'admin'], null, 'alice').secret;
    const r = await s.call('POST', '/push/subscribe', sub('ci'), { authorization: `Bearer ${token}` });
    expect(r.status).toBe(403);
  });

  it('an open app gets only the notices for its user', async () => {
    const res = await fetch(`${s.base}/api/stream`, { headers: as('bob') });
    const reader = res.body!.getReader();
    const seen: LiveEvent[] = [];
    const readUntil = async (pred: (e: LiveEvent) => boolean) => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream closed');
        buf += new TextDecoder().decode(value);
        const parts = buf.split('\n\n');
        buf = parts.pop()!;
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const e = JSON.parse(line.slice(6)) as LiveEvent;
          seen.push(e);
          if (pred(e)) return;
        }
      }
    };
    await readUntil((e) => e.t === 'hello');
    await s.ctx.notifier.send({ ...notice, title: 'for alice' }, 'alice');
    await s.ctx.notifier.send({ ...notice, title: 'for bob' }, 'bob');
    await readUntil((e) => e.t === 'notice' && e.notice.title === 'for bob');
    const notices = seen.filter((e) => e.t === 'notice');
    expect(notices).toEqual([{ t: 'notice', notice: { ...notice, title: 'for bob', tag: undefined } }]);
    await reader.cancel();
  });

  it('forUser: a tab sees notices for its user, without the list of recipients', () => {
    const e: LiveEvent = { t: 'notice', notice, to: ['bob'] };
    expect(forUser(e, 'bob')).toEqual({ t: 'notice', notice });
    expect(forUser(e, 'alice')).toBeNull();
    expect(forUser(e, null)).toBeNull();
    expect(forUser({ t: 'cleanup' }, null)).toEqual({ t: 'cleanup' });
  });
});

describe('migration 031: existing subscriptions are the install owner\'s', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A database as Dispatch left it before DISP-65: migrations up to 030, the owner on record, a subscription with no user. */
  function before031() {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-push-'));
    dirs.push(dir);
    const file = join(dir, 'd.db');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY)');
    const migrations = join(import.meta.dirname, '../src/server/migrations');
    for (const name of readdirSync(migrations).filter((f) => f.endsWith('.sql') && f < '031').sort()) {
      raw.exec(readFileSync(join(migrations, name), 'utf8'));
      raw.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    }
    raw.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ('https://push.example/old', 'p', 'a')").run();
    raw.close();
    return file;
  }

  it('gives them to the owner on record', () => {
    const file = before031();
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO settings (key, value) VALUES ('install_owner', 'carol')").run();
    raw.close();
    const db = new Db(file);
    expect(db.all('SELECT endpoint, user FROM push_subscriptions')).toEqual([{ endpoint: 'https://push.example/old', user: 'carol' }]);
  });

  it('leaves them for Users.claim when no owner is on record yet', () => {
    const db = new Db(before031());
    expect(db.all('SELECT user FROM push_subscriptions')).toEqual([{ user: null }]);
  });
});
