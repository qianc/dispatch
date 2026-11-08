// Scheduled planner runs (DISP-13): a project's schedules, and "Run now". A schedule belongs to
// whoever made it and runs as them (DISP-63); everyone can read it, the install owner may switch
// it off or remove it.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { scheduleInput, schedulePatch, type Schedule } from '../../shared/types.ts';
import { nextSlot, passedSlot } from '../scheduler.ts';
import { HttpError, intParam, notFound, type Ctx } from './ctx.ts';

export function scheduleRoutes(app: FastifyInstance, { store, bus, scheduler, users }: Ctx) {
  const schedule = (id: unknown) => {
    const s = store.schedule(intParam(id));
    if (!s) throw notFound('Schedule');
    return s;
  };
  /** With its next run, and its last run's session (status and result line). */
  const view = (s: Schedule) => {
    const last = s.last_session_id ? store.session(s.last_session_id) : undefined;
    return {
      ...s,
      next_run: s.enabled ? nextSlot(s, new Date())?.toISOString() ?? null : null,
      last_session: last ? { id: last.id, status: last.status, title: last.title, last_text: last.last_text, created_at: last.created_at } : null,
    };
  };
  /** who acts: the caller, or the install owner for the legacy API token (it acts for the install) */
  const user = (req: FastifyRequest) => req.principal!.user ?? (req.principal!.legacy ? users.installOwner : null);
  const notYours = (s: Schedule) => new HttpError(403, `This schedule is ${s.owner ?? 'nobody'}'s: only they can change or run it.`);
  const changed = (s: Schedule) => bus.emit({ t: 'project', key: store.project(s.project_id)!.key });

  app.get('/api/projects/:key/schedules', async (req) => {
    const p = store.projectByKey(String((req.params as { key: string }).key));
    if (!p) throw notFound('Project');
    return store.schedules(p.id).map(view);
  });

  app.post('/api/projects/:key/schedules', async (req) => {
    const p = store.projectByKey(String((req.params as { key: string }).key));
    if (!p) throw notFound('Project');
    const owner = user(req);
    if (!owner) throw new HttpError(400, 'A schedule runs as the person who makes it: make it signed in, or with a token of your own.');
    const input = scheduleInput.parse(req.body);
    // a new schedule waits for its next slot, even when today's has passed within the catch-up time
    const made = store.createSchedule(p.id, { ...input, last_slot: passedSlot(input), owner });
    changed(made);
    return view(made);
  });

  app.patch('/api/schedules/:id', async (req) => {
    const s = schedule((req.params as { id: string }).id);
    const patch = schedulePatch.parse(req.body);
    // the install owner may switch someone else's schedule off, nothing more
    const offOnly = Object.entries(patch).every(([k, v]) => v === undefined || (k === 'enabled' && v === false));
    if (s.owner !== user(req) && !(users.isOwner(user(req)) && offOnly)) throw notYours(s);
    const next = { ...s, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Schedule;
    // a new time or days, or switching it back on: a slot that already passed does not run
    const retimed = (patch.at_time && patch.at_time !== s.at_time) || (patch.days && patch.days.join() !== s.days.join()) || (patch.enabled && !s.enabled);
    const updated = store.updateSchedule(s.id, { ...patch, ...(retimed ? { last_slot: passedSlot(next) } : {}) });
    changed(updated);
    return view(updated);
  });

  app.delete('/api/schedules/:id', async (req) => {
    const s = schedule((req.params as { id: string }).id);
    if (s.owner !== user(req) && !users.isOwner(user(req))) throw notYours(s);
    store.deleteSchedule(s.id);
    changed(s);
    return { ok: true };
  });

  app.post('/api/schedules/:id/run', async (req) => {
    const s = schedule((req.params as { id: string }).id);
    if (s.owner !== user(req)) throw notYours(s);
    return scheduler.run(s.id);
  });
}
