// Cost and time (DISP-16): what the sessions cost and how long their agents worked, per project
// and per item. Read-only sums over what is already recorded for each session.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, type Ctx } from './ctx.ts';

const period = z.object({ days: z.coerce.number().int().min(1).max(3650).optional() });

export function costRoutes(app: FastifyInstance, { store }: Ctx) {
  /** only sessions started in the last `days` days; none given: all of them */
  const since = (query: unknown) => {
    const { days } = period.parse(query);
    return days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
  };

  app.get('/api/costs', async (req) => store.allCosts(since(req.query)));

  app.get('/api/projects/:key/costs', async (req) => {
    const p = store.projectByKey((req.params as { key: string }).key);
    if (!p) throw notFound('Project');
    return store.projectCosts(p.id, since(req.query));
  });
}
