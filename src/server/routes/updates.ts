// Dispatch's own updates (DISP-112): what is new, the settings, and the owner's actions. Every
// route is the install owner's (admin in ROUTE_ACCESS).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { updateSettings } from '../../shared/types.ts';
import type { Ctx } from './ctx.ts';

export function updateRoutes(app: FastifyInstance, { updates, users }: Ctx) {
  /** who acts: the caller, or the install owner for the legacy API token */
  const user = (req: FastifyRequest) => req.principal!.user ?? users.installOwner;

  app.get('/api/update', async () => updates.info());

  app.put('/api/update/settings', async (req) => {
    updates.setSettings(updateSettings.partial().parse(req.body));
    return updates.info();
  });

  app.post('/api/update/check', async () => {
    await updates.check();
    return updates.info();
  });

  // `target`: the newest commit or the newest version tag; default: what the settings follow
  app.post('/api/update/start', async (req) => {
    const { target } = z.object({ target: z.enum(['commit', 'tag']).optional() }).parse(req.body ?? {});
    updates.startRollout(user(req), target);
    return updates.info();
  });

  app.post('/api/update/cancel', async () => {
    updates.cancel();
    return updates.info();
  });
}
