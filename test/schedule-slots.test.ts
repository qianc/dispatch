import { describe, expect, it } from 'vitest';
import { CATCH_UP_MS, due, latestSlot, nextSlot } from '../src/server/scheduler.ts';

// local time, as the scheduler uses it: 2026-10-22 is a Thursday (4)
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
const every = [0, 1, 2, 3, 4, 5, 6];
const sched = (o: Partial<{ at_time: string; days: number[]; enabled: boolean; last_slot: string | null }> = {}) => ({ at_time: '02:00', days: every, enabled: true, last_slot: null, ...o });

describe('schedule slots', () => {
  it('the latest slot is today once the time has passed, else yesterday', () => {
    expect(latestSlot(sched(), at(22, 2, 0))).toEqual(at(22, 2));
    expect(latestSlot(sched(), at(22, 9))).toEqual(at(22, 2));
    expect(latestSlot(sched(), at(22, 1, 59))).toEqual(at(21, 2));
  });

  it('only on the chosen weekdays', () => {
    // Monday (1) only: from Thursday the latest is Monday the 19th, the next Monday the 26th
    expect(latestSlot(sched({ days: [1] }), at(22, 9))).toEqual(at(19, 2));
    expect(nextSlot(sched({ days: [1] }), at(22, 9))).toEqual(at(26, 2));
    expect(nextSlot(sched(), at(22, 1))).toEqual(at(22, 2));
    expect(nextSlot(sched(), at(22, 2))).toEqual(at(23, 2));
  });

  it('is due once per slot, within the catch-up window', () => {
    expect(due(sched(), at(22, 2, 0))?.getTime()).toBe(at(22, 2).getTime());
    expect(due(sched(), new Date(at(22, 2).getTime() + CATCH_UP_MS - 60_000))).toBeTruthy();
    // missed by more than 6 hours: skipped until the next slot
    expect(due(sched(), new Date(at(22, 2).getTime() + CATCH_UP_MS))).toBeNull();
    // ran already
    expect(due(sched({ last_slot: at(22, 2).toISOString() }), at(22, 3))).toBeNull();
    // ran yesterday's
    expect(due(sched({ last_slot: at(21, 2).toISOString() }), at(22, 3))).toBeTruthy();
    expect(due(sched({ enabled: false }), at(22, 3))).toBeNull();
  });
});
