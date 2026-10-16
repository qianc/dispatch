import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from './ctx.ts';

export function pushRoutes(app: FastifyInstance, { store, notifier }: Ctx) {
  app.post('/api/push/subscribe', async (req) => {
    const sub = z.object({ endpoint: z.url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).parse(req.body);
    store.addPushSubscription(sub.endpoint, sub.keys.p256dh, sub.keys.auth, req.headers['user-agent'] ?? null);
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', async (req) => {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body);
    store.removePushSubscription(endpoint);
    return { ok: true };
  });
  /** How many devices get notifications (an old, removed app install can still count here). */
  app.get('/api/push/devices', async () => ({ count: store.pushSubscriptions().length }));

  /** Keep only this device: for installs that were removed but whose subscription lives on. */
  app.post('/api/push/keep-only', async (req) => {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body);
    const all = store.pushSubscriptions();
    if (!all.some((s) => s.endpoint === endpoint)) return { removed: 0, error: 'This device is not subscribed; turn notifications on first.' };
    for (const s of all) if (s.endpoint !== endpoint) store.removePushSubscription(s.endpoint);
    return { removed: all.length - 1 };
  });

  app.post('/api/push/test', async () => {
    await notifier.send({ title: 'Dispatch', body: 'Test notification', url: '/', tag: 'test' });
    return { ok: true, subscriptions: store.pushSubscriptions().length };
  });
}
