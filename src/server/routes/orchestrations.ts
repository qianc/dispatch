// Orchestrations: start one, read it with its steps, and the owner's actions on it (approve the
// plan, pause, resume, stop; skip or retry a step). An orchestration belongs to whoever started it
// and starts work as them; everyone can read it.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { orchestrationInput } from '../../shared/types.ts';
import { assertCanDrive } from '../sessionGuard.ts';
import { HttpError, intParam, notFound, type Ctx } from './ctx.ts';

export function orchestrationRoutes(app: FastifyInstance, { store, orchestrator, users }: Ctx) {
  /** who acts: the caller, or the install owner for the legacy API token (it acts for the install) */
  const user = (req: FastifyRequest) => req.principal!.user ?? (req.principal!.legacy ? users.installOwner : null);
  /** the orchestration's id, if the caller may act on it */
  const mine = (req: FastifyRequest, id: unknown) => {
    const s = store.session(intParam(id));
    if (!s || !store.orchestration(s.id)) throw notFound('Orchestration');
    assertCanDrive(req.principal!, s, users.installOwner);
    return s.id;
  };
  const stepOf = (req: FastifyRequest) => {
    const step = store.step(intParam((req.params as { id: string }).id));
    if (!step) throw notFound('Step');
    mine(req, step.orchestration_id);
    return step;
  };

  app.get('/api/orchestrations', async () => orchestrator.list());

  app.post('/api/orchestrations', async (req) => {
    const starter = user(req);
    if (!starter) throw new HttpError(400, 'An orchestration starts work as the person who makes it: make it signed in, or with a token of your own.');
    return orchestrator.start(orchestrationInput.parse(req.body), starter);
  });

  app.get('/api/orchestrations/:id', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    if (!store.orchestration(id)) throw notFound('Orchestration');
    return orchestrator.view(id);
  });

  app.post('/api/orchestrations/:id/approve', async (req) => orchestrator.approve(mine(req, (req.params as { id: string }).id)));
  app.post('/api/orchestrations/:id/pause', async (req) => orchestrator.pause(mine(req, (req.params as { id: string }).id)));
  app.post('/api/orchestrations/:id/resume', async (req) => orchestrator.resumeOne(mine(req, (req.params as { id: string }).id)));
  app.post('/api/orchestrations/:id/stop', async (req) => {
    const { stop_children } = z.object({ stop_children: z.boolean().default(false) }).parse(req.body ?? {});
    return orchestrator.stopAll(mine(req, (req.params as { id: string }).id), stop_children);
  });

  app.post('/api/orchestration-steps/:id/skip', async (req) => orchestrator.skipStep(stepOf(req).id));
  app.post('/api/orchestration-steps/:id/retry', async (req) => orchestrator.retryStep(stepOf(req).id));
}
