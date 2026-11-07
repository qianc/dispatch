import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WorkerError } from '../workers.ts';
import { HttpError, intParam, type Ctx } from './ctx.ts';

export function workerRoutes(app: FastifyInstance, { workers, hub, sessions }: Ctx) {
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof WorkerError) throw new HttpError(400, e.message);
      throw e;
    }
  };
  const withState = () => workers.list().map((w) => ({ ...w, connected: hub.isConnected(w.id) }));

  app.get('/api/workers', async () => ({ workers: withState(), default_worker_id: workers.defaultId() }));
  app.post('/api/workers', async (req) => {
    const b = z.object({ name: z.string(), description: z.string().default('') }).parse(req.body);
    return wrap(() => workers.create(b.name, b.description));
  });
  app.patch('/api/workers/:id', async (req) => {
    const b = z.object({ name: z.string().optional(), description: z.string().optional() }).parse(req.body);
    return { worker: wrap(() => workers.update(intParam((req.params as { id: string }).id), b)) };
  });
  app.delete('/api/workers/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    wrap(() => workers.revoke(id));
    hub.drop(id, 'worker revoked');
    return { ok: true };
  });
  // is this Claude account signed in on the worker now? (DISP-60)
  app.post('/api/workers/:id/claude-accounts/:name/check', async (req) => {
    const p = req.params as { id: string; name: string };
    const id = intParam(p.id);
    if (!workers.get(id)) throw new HttpError(404, 'Unknown worker');
    return sessions.checkAccount(id, p.name);
  });
  app.put('/api/settings/default-worker', async (req) => {
    const { worker_id } = z.object({ worker_id: z.number().int() }).parse(req.body);
    wrap(() => workers.setDefault(worker_id));
    return { default_worker_id: workers.defaultId() };
  });
}
