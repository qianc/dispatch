// DISP-267: every notice is kept 30 days, with where it came from and what happened to it: pushed
// (to which devices, with the push service's answer), in the open app only, or held back and why.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NoticeLogEntry, Session } from '../src/shared/types.ts';
import { startServer } from './helpers.ts';
import { setup, type Setup } from './orchestrator-helpers.ts';

const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } });
const N = { title: 'T', body: 'B', url: '/s/1', source: 'test.here' };

describe('notice log', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  const log = async (q = '') => (await s.call('GET', `/notices${q}`)).data as NoticeLogEntry[];
  beforeEach(async () => {
    s = await startServer();
    s.ctx.notifier.deliver = async (endpoint) => {
      if (endpoint.endsWith('/gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      return { statusCode: 201 };
    };
  });
  afterEach(() => s.app.close());

  it('a push: its source, and per device what the push service answered or why it got none', async () => {
    await s.call('POST', '/push/subscribe', sub(1));
    await s.call('POST', '/push/subscribe', sub(2));
    await s.call('POST', '/push/subscribe', { ...sub(3), endpoint: 'https://push.example/gone' });
    await s.call('POST', '/push/presence', { endpoint: sub(2).endpoint, active: true });
    await s.ctx.notifier.send({ ...N, tag: 'x' });
    const [n] = await log();
    expect(n).toMatchObject({ title: 'T', body: 'B', url: '/s/1', tag: 'x', source: 'test.here', outcome: 'pushed', reason: null });
    expect(n.devices.map((d) => d.result).sort()).toEqual(['201', 'failed 410: Gone (device removed)', 'in focus: no push']);
    expect(n.devices.every((d) => d.service === 'push.example')).toBe(true);
  });

  it('shown in the open app only: no device, or every device has the app in focus', async () => {
    await s.ctx.notifier.send(N);
    expect((await log())[0]).toMatchObject({ outcome: 'app_only', reason: 'no device gets notifications' });
    await s.call('POST', '/push/subscribe', sub(1));
    await s.call('POST', '/push/presence', { endpoint: sub(1).endpoint, active: true });
    await s.ctx.notifier.send(N);
    expect((await log())[0]).toMatchObject({ outcome: 'app_only', reason: 'the app is in focus on every device' });
  });

  it('a muted project holds it back', async () => {
    const { data: p } = await s.call('POST', '/projects', { key: 'MU', name: 'Muted' });
    await s.call('PATCH', '/projects/MU', { muted: true });
    await s.ctx.notifier.send({ ...N, project_id: p.id });
    expect((await log())[0]).toMatchObject({ outcome: 'held', reason: 'project muted', project_id: p.id });
  });

  it('a newer notice with the same tag replaces the older one', async () => {
    await s.ctx.notifier.send({ ...N, tag: 'idle-1' });
    await s.ctx.notifier.send({ ...N, tag: 'other' });
    await s.ctx.notifier.send({ ...N, tag: 'idle-1', body: 'newer' });
    const [newer, other, older] = await log();
    expect(older.replaced_by).toBe(newer.id);
    expect(other.replaced_by).toBeNull();
    expect(newer.replaced_by).toBeNull();
  });

  it('keeps 30 days, and each person sees their own', async () => {
    await s.ctx.notifier.send(N);
    s.ctx.store['db'].run("UPDATE notice_log SET created_at = '2000-01-01T00:00:00.000Z'");
    await s.ctx.notifier.send({ ...N, title: 'new' });
    await s.ctx.notifier.send({ ...N, title: 'for bob' }, 'bob');
    expect((await log()).map((n) => n.title)).toEqual(['new']);
    expect(s.ctx.notifier.notices({}).map((n) => n.title)).toEqual(['for bob', 'new']);
  });
});

describe('notice log of an orchestration', () => {
  let t: Setup;
  beforeEach(async () => {
    t = await setup();
    // the real notifier, with no devices: what it logs is the point here
    delete (t.s.ctx.notifier as { send?: unknown }).send;
  });
  afterEach(() => t.s.app.close());

  const turn = (id: number) => { t.status(id, 'running'); t.status(id, 'idle'); };
  const running = async () => {
    const p = await t.approved();
    turn(p.id);
    const one = await t.startStep(p.id, p.first.id);
    const three = await t.startStep(p.id, p.third.id);
    turn(p.id);
    return { ...p, one, three };
  };

  it("lists its own and its batches' notices: taken into the quiet log, batched, or sent", async () => {
    const p = await running();
    t.s.ctx.github['tellStarter'](t.store.session(p.one)!, 'github.mergeNotice', { title: 'AA: done and merged', body: 'Built it.', url: `/s/${p.one}` }, 'routine');
    t.s.ctx.orchestrator.batchMs = 60_000;
    t.status(p.one, 'failed');
    t.status(p.three, 'failed');
    t.s.ctx.orchestrator.flushOwner(p.id);
    const all = (await t.s.call('GET', `/notices?orchestration_id=${p.id}`)).data as NoticeLogEntry[];
    const row = (title: string) => all.find((n) => n.title === title)!;
    expect(row('AA: done and merged')).toMatchObject({ session_id: p.one, orchestration_id: p.id, source: 'github.mergeNotice', outcome: 'held' });
    expect(row('AA: done and merged').reason).toMatch(/^taken by the orchestrator: in its quiet log/);
    for (const title of ['Rework auth: step 1 failed', 'Rework auth: step 3 failed']) {
      expect(row(title)).toMatchObject({ source: 'orchestrator.stepFailed', outcome: 'held', reason: 'batched into "Rework auth: 2 things need you"' });
    }
    expect(row('Rework auth: 2 things need you')).toMatchObject({ session_id: p.id, source: 'orchestrator.batched', outcome: 'app_only' });
    // the batch's own list has only its notice
    const one = (await t.s.call('GET', `/notices?session_id=${p.one}`)).data as NoticeLogEntry[];
    expect(one.map((n) => [n.title, n.source, n.outcome])).toEqual([['AA: session failed', 'sessions.failed', 'held'], ['AA: done and merged', 'github.mergeNotice', 'held']]);
    // the assistant reads the same log
    const viaAssistant = await t.s.ctx.sessions.assistantRpc!({ started_by: null } as Session, 'list_notices', { session_id: p.id }) as { notices: { title: string; source: string; outcome: string }[] };
    expect(viaAssistant.notices).toHaveLength(all.length);
    expect(viaAssistant.notices).toContainEqual(expect.objectContaining({ title: 'AA: done and merged', source: 'github.mergeNotice', outcome: 'held' }));
  });

  it('a notice replaced in the outbox before it went out is held back', async () => {
    const p = await running();
    t.s.ctx.orchestrator.batchMs = 60_000;
    const news = { url: `/s/${p.id}`, tag: 'orch-review-1', session_id: p.id, source: 'orchestrator.needsOwner' };
    t.s.ctx.orchestrator['tellOwner'](p.id, { ...news, title: 'older', body: '' });
    t.s.ctx.orchestrator['tellOwner'](p.id, { ...news, title: 'newer', body: '' });
    t.s.ctx.orchestrator.flushOwner(p.id);
    const all = (await t.s.call('GET', `/notices?orchestration_id=${p.id}`)).data as NoticeLogEntry[];
    expect(all.find((n) => n.title === 'older')).toMatchObject({ outcome: 'held', reason: 'replaced by a newer notice with the same tag before it went out' });
    expect(all.find((n) => n.title === 'newer')).toMatchObject({ outcome: 'app_only' });
  });
});
