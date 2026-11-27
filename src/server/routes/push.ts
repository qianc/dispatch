import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, type Ctx } from './ctx.ts';
import { pushEndpointProblem } from '../pushEndpoint.ts';

/** Push subscriptions are a person's own (DISP-65): the routes here act on the caller's devices and notices only. */
export function pushRoutes(app: FastifyInstance, { store, notifier, users }: Ctx) {
  const me = (req: FastifyRequest) => req.principal!.user!;

  app.post('/api/push/subscribe', async (req) => {
    const sub = z.object({ endpoint: z.url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).parse(req.body);
    // the server POSTs to it: never into its own machine or LAN (DISP-225)
    const problem = await pushEndpointProblem(sub.endpoint);
    if (problem) throw new HttpError(400, problem);
    store.addPushSubscription(sub.endpoint, sub.keys.p256dh, sub.keys.auth, me(req));
    return { ok: true };
  });
  /** Another person's device stays subscribed (removed: 0). */
  app.post('/api/push/unsubscribe', async (req) => {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body);
    const removed = store.removePushSubscription(endpoint, me(req));
    if (removed) notifier.setActive(endpoint, false, me(req));
    return { ok: true, removed: removed ? 1 : 0 };
  });
  /** This device's app gained or lost focus (renewed every 20 s while it has it): no system notifications while focused. `path`: the page it shows (DISP-266). */
  app.post('/api/push/presence', async (req) => {
    const { endpoint, active, path } = z.object({ endpoint: z.string(), active: z.boolean(), path: z.string().max(500).optional() }).parse(req.body);
    notifier.setActive(endpoint, active, me(req), path);
    return { ok: true };
  });
  /** How many of this person's devices get notifications (an old, removed app install can still count here). */
  app.get('/api/push/devices', async (req) => ({ count: store.pushSubscriptions(me(req)).length }));

  /** Keep only this device of the caller's: for installs that were removed but whose subscription lives on. */
  app.post('/api/push/keep-only', async (req) => {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body);
    const mine = store.pushSubscriptions(me(req));
    if (!mine.some((s) => s.endpoint === endpoint)) return { removed: 0, error: 'This device is not subscribed; turn notifications on first.' };
    for (const s of mine) if (s.endpoint !== endpoint) store.removePushSubscription(s.endpoint);
    return { removed: mine.length - 1 };
  });

  /**
   * The caller's notice log (DISP-267), newest first: sent and held back, with source and outcome.
   * `orchestration_id`: its batches' too. A token reads its user's (an old token, with none: the install owner's).
   */
  app.get('/api/notices', async (req) => {
    const q = z.object({ session_id: z.coerce.number().int().optional(), orchestration_id: z.coerce.number().int().optional() }).parse(req.query);
    return notifier.notices({ user: req.principal!.user ?? users.installOwner, ...q });
  });

  app.post('/api/push/test', async (req) => {
    await notifier.send({ title: 'Dispatch', body: 'Test notification', url: '/', tag: 'test', source: 'push.test' }, me(req));
    return { ok: true, subscriptions: store.pushSubscriptions(me(req)).length };
  });
}
