// Scheduled planner runs (DISP-13): a project's schedules, and "Run now".
import type { FastifyInstance } from 'fastify';
import { scheduleInput, schedulePatch, type Schedule } from '../../shared/types.ts';
import { nextSlot, passedSlot } from '../scheduler.ts';
import { intParam, notFound, type Ctx } from './ctx.ts';

export function scheduleRoutes(app: FastifyInstance, { store, bus, scheduler }: Ctx) {
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
  const changed = (s: Schedule) => bus.emit({ t: 'project', key: store.project(s.project_id)!.key });

  app.get('/api/projects/:key/schedules', async (req) => {
    const p = store.projectByKey(String((req.params as { key: string }).key));
    if (!p) throw notFound('Project');
    return store.schedules(p.id).map(view);
  });

  app.post('/api/projects/:key/schedules', async (req) => {
    const p = store.projectByKey(String((req.params as { key: string }).key));
    if (!p) throw notFound('Project');
    const input = scheduleInput.parse(req.body);
    // a new schedule waits for its next slot, even when today's has passed within the catch-up time
    const made = store.createSchedule(p.id, { ...input, last_slot: passedSlot(input) });
    changed(made);
    return view(made);
  });

  app.patch('/api/schedules/:id', async (req) => {
    const s = schedule((req.params as { id: string }).id);
    const patch = schedulePatch.parse(req.body);
    const next = { ...s, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Schedule;
    // a new time or days, or switching it back on: a slot that already passed does not run
    const retimed = (patch.at_time && patch.at_time !== s.at_time) || (patch.days && patch.days.join() !== s.days.join()) || (patch.enabled && !s.enabled);
    const updated = store.updateSchedule(s.id, { ...patch, ...(retimed ? { last_slot: passedSlot(next) } : {}) });
    changed(updated);
    return view(updated);
  });

  app.delete('/api/schedules/:id', async (req) => {
    const s = schedule((req.params as { id: string }).id);
    store.deleteSchedule(s.id);
    changed(s);
    return { ok: true };
  });

  app.post('/api/schedules/:id/run', async (req) => scheduler.run(schedule((req.params as { id: string }).id).id));
}
