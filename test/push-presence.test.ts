import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '../src/shared/types.ts';
import { startServer } from './helpers.ts';

const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } });

describe('notifications while the app is in focus (DISP-12)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let delivered: string[];
  let live: LiveEvent[];
  beforeEach(async () => {
    s = await startServer();
    delivered = [];
    s.ctx.notifier.deliver = async (endpoint) => { delivered.push(endpoint); };
    live = [];
    s.ctx.bus.on((e) => live.push(e));
    await s.call('POST', '/push/subscribe', sub(1));
    await s.call('POST', '/push/subscribe', sub(2));
  });
  afterEach(() => s.app.close());

  it('pushes to every device when none has the app in focus', async () => {
    await s.ctx.notifier.send({ title: 'T', body: 'B', url: '/s/1' });
    expect(delivered.sort()).toEqual([sub(1).endpoint, sub(2).endpoint]);
  });

  it('skips the device that has the app in focus, and shows the notice in the app instead', async () => {
    expect((await s.call('POST', '/push/presence', { endpoint: sub(1).endpoint, active: true })).status).toBe(200);
    await s.ctx.notifier.send({ title: 'T', body: 'B', url: '/s/1', tag: 'x' });
    expect(delivered).toEqual([sub(2).endpoint]);
    expect(live).toContainEqual({ t: 'notice', notice: { title: 'T', body: 'B', url: '/s/1', tag: 'x' } });
  });

  it('pushes again once the app goes to the background', async () => {
    await s.call('POST', '/push/presence', { endpoint: sub(1).endpoint, active: true });
    await s.call('POST', '/push/presence', { endpoint: sub(1).endpoint, active: false });
    await s.ctx.notifier.send({ title: 'T', body: 'B', url: '/s/1' });
    expect(delivered.sort()).toEqual([sub(1).endpoint, sub(2).endpoint]);
  });

  it('forgets focus that is not renewed (the app was closed without saying so)', async () => {
    await s.call('POST', '/push/presence', { endpoint: sub(1).endpoint, active: true });
    const now = Date.now;
    Date.now = () => now() + 60_000;
    try {
      await s.ctx.notifier.send({ title: 'T', body: 'B', url: '/s/1' });
    } finally {
      Date.now = now;
    }
    expect(delivered.sort()).toEqual([sub(1).endpoint, sub(2).endpoint]);
  });

  it('ignores presence for devices that are not subscribed', async () => {
    await s.call('POST', '/push/presence', { endpoint: 'https://push.example/unknown', active: true });
    expect(s.ctx.notifier.activeCount()).toBe(0);
  });

  it('a muted project sends neither a push nor an in-app notice', async () => {
    const { data: p } = await s.call('POST', '/projects', { key: 'MU', name: 'Muted' });
    await s.call('PATCH', `/projects/MU`, { muted: true });
    await s.ctx.notifier.send({ title: 'T', body: 'B', url: '/s/1', project_id: p.id });
    expect(delivered).toEqual([]);
    expect(live.filter((e) => e.t === 'notice')).toEqual([]);
  });
});
