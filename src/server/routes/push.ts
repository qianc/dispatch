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
  app.post('/api/push/test', async () => {
    await notifier.send({ title: 'Dispatch', body: 'Test notification', url: '/', tag: 'test' });
    return { ok: true, subscriptions: store.pushSubscriptions().length };
  });
}
