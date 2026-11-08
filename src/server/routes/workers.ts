import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { WorkerError } from '../workers.ts';
import { HttpError, intParam, type Ctx } from './ctx.ts';

// Workers belong to the person who added them (DISP-63): only they change one or start work on it.
// The install owner sees every worker and may remove any.
export function workerRoutes(app: FastifyInstance, { cfg, workers, hub, sessions, users }: Ctx) {
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof WorkerError) throw new HttpError(400, e.message);
      throw e;
    }
  };
  /** the person asking; a token without a user (the legacy one) acts for the install owner */
  const me = (req: FastifyRequest) => req.principal!.user ?? cfg.installOwner;
  const withState = (req: FastifyRequest) => workers.list(users.manages(me(req))).map((w) => ({ ...w, connected: hub.isConnected(w.id) }));
  /** a live worker of the caller's (or, with `ownerToo`, any one for the install owner) */
  const owned = (req: FastifyRequest, ownerToo = false) => {
    const w = workers.get(intParam((req.params as { id: string }).id));
    if (!w || w.revoked_at) throw new HttpError(404, 'Unknown worker');
    if (w.owner !== me(req) && !(ownerToo && users.isOwner(me(req)))) throw new HttpError(403, `Worker ${w.name} is ${w.owner ?? 'nobody'}'s: only they can change it.`);
    return w;
  };

  app.get('/api/workers', async (req) => ({ workers: withState(req), default_worker_id: users.defaultWorker(me(req)) }));
  app.post('/api/workers', async (req) => {
    const b = z.object({ name: z.string(), description: z.string().default('') }).parse(req.body);
    return wrap(() => workers.create(b.name, b.description, me(req)));
  });
  app.patch('/api/workers/:id', async (req) => {
    const b = z.object({ name: z.string().optional(), description: z.string().optional() }).parse(req.body);
    return { worker: wrap(() => workers.update(owned(req).id, b)) };
  });
  app.delete('/api/workers/:id', async (req) => {
    const { id } = owned(req, true);
    wrap(() => workers.revoke(id));
    hub.drop(id, 'worker revoked');
    return { ok: true };
  });
  // is this Claude account signed in on the worker now? (DISP-60)
  app.post('/api/workers/:id/claude-accounts/:name/check', async (req) => {
    const w = owned(req);
    return sessions.checkAccount(w.id, (req.params as { name: string }).name);
  });
  /** Your own default worker; the install owner's is also the install's (projects, files). */
  app.put('/api/settings/default-worker', async (req) => {
    const { worker_id } = z.object({ worker_id: z.number().int() }).parse(req.body);
    const w = workers.get(worker_id);
    if (!w || w.revoked_at) throw new HttpError(400, 'Unknown worker');
    if (w.owner !== me(req)) throw new HttpError(403, `Worker ${w.name} is not yours.`);
    if (users.isOwner(me(req))) wrap(() => workers.setDefault(worker_id));
    users.setDefaultWorker(me(req), worker_id);
    return { default_worker_id: users.defaultWorker(me(req)) };
  });
}
