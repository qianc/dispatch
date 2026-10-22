// Scheduled planner runs (DISP-13): each schedule runs a planner on its project at set times (the
// server's local time). A minute timer starts each slot once; a slot missed while the server was
// down runs when it is back, if that is less than CATCH_UP_MS later.
import type { Schedule, Session } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import type { Sessions } from './sessions.ts';
import type { Store } from './store.ts';

/** A missed slot still runs up to this long after its time; later, it waits for the next slot. */
export const CATCH_UP_MS = 6 * 3600_000;

type Timing = Pick<Schedule, 'at_time' | 'days'>;

/** The slot on the day of `day` (local time). */
function slotOn(s: Timing, day: Date): Date {
  const [h, m] = s.at_time.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

/** The most recent slot at or before `now`, or null (no weekday chosen). */
export function latestSlot(s: Timing, now: Date): Date | null {
  for (let back = 0; back <= 7; back++) {
    const slot = slotOn(s, new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
    if (slot <= now && s.days.includes(slot.getDay())) return slot;
  }
  return null;
}

/** The first slot after `now`. */
export function nextSlot(s: Timing, now: Date): Date | null {
  for (let ahead = 0; ahead <= 7; ahead++) {
    const slot = slotOn(s, new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead));
    if (slot > now && s.days.includes(slot.getDay())) return slot;
  }
  return null;
}

/** The slot to run now, or null: enabled, not run yet, and not missed by more than CATCH_UP_MS. */
export function due(s: Timing & Pick<Schedule, 'enabled' | 'last_slot'>, now: Date): Date | null {
  if (!s.enabled) return null;
  const slot = latestSlot(s, now);
  if (!slot || now.getTime() - slot.getTime() >= CATCH_UP_MS) return null;
  if (s.last_slot && Date.parse(s.last_slot) >= slot.getTime()) return null;
  return slot;
}

/** A new or changed schedule starts with its next slot, not one that already passed. */
export function passedSlot(s: Timing, now = new Date()): string | null {
  return latestSlot(s, now)?.toISOString() ?? null;
}

export class Scheduler {
  private store: Store;
  private sessions: Sessions;
  private bus: Bus;
  private timer: NodeJS.Timeout | null = null;

  constructor(store: Store, sessions: Sessions, bus: Bus) {
    this.store = store;
    this.sessions = sessions;
    this.bus = bus;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run every schedule whose slot is due. */
  tick(now = new Date()) {
    for (const s of this.store.schedules()) {
      const slot = due(s, now);
      if (!slot) continue;
      // marked first: a slot never runs twice, even if starting it throws
      this.store.updateSchedule(s.id, { last_slot: slot.toISOString() });
      try {
        this.run(s.id);
      } catch (e) {
        console.warn(`schedule ${s.id} (${s.name}) could not start:`, (e as Error).message);
      }
    }
  }

  /** Start a run now (a due slot, or "Run now"). A failure is kept on the schedule and thrown. */
  run(scheduleId: number): Session {
    const s = this.store.schedule(scheduleId);
    if (!s) throw new Error('Unknown schedule');
    const project = this.store.project(s.project_id)!;
    try {
      const session = this.sessions.startScheduled(project, s);
      this.store.updateSchedule(s.id, { last_session_id: session.id, last_error: null });
      return session;
    } catch (e) {
      this.store.updateSchedule(s.id, { last_error: (e as Error).message });
      throw e;
    } finally {
      this.bus.emit({ t: 'project', key: project.key });
    }
  }
}
