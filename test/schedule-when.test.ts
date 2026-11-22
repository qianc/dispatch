import { describe, expect, it } from 'vitest';
import { when } from '../web/src/components/schedules.tsx';

// DISP-160: "today" and "tomorrow" compare calendar dates in the server's zone, so a 23 or 25 hour
// DST change day does not turn tomorrow's run into a weekday date.
describe('when()', () => {
  const zone = 'Europe/Stockholm';
  it('says tomorrow on the day the clocks go forward (23 h day)', () => {
    const now = new Date('2026-03-29T10:00:00Z'); // Sun 29 March, 12:00 CEST
    expect(when('2026-03-30T00:00:00Z', zone, now)).toBe('tomorrow 02:00');
    expect(when('2026-03-29T20:00:00Z', zone, now)).toBe('today 22:00');
    expect(when('2026-03-31T00:00:00Z', zone, now)).toBe('Tue 31/3 02:00');
  });
  it('says tomorrow on the day the clocks go back (25 h day)', () => {
    const now = new Date('2026-10-25T10:00:00Z'); // Sun 25 October, 11:00 CET
    expect(when('2026-10-26T01:00:00Z', zone, now)).toBe('tomorrow 02:00');
    expect(when('2026-10-25T22:59:00Z', zone, now)).toBe('today 23:59');
    expect(when('2026-10-25T23:00:00Z', zone, now)).toBe('tomorrow 00:00');
    expect(when('2026-10-25T21:00:00Z', zone, now)).toBe('today 22:00');
  });
  it('shows the time in the zone it is given', () => {
    const now = new Date('2026-11-22T12:00:00Z');
    expect(when('2026-11-23T02:00:00Z', 'UTC', now)).toBe('tomorrow 02:00');
    expect(when('2026-11-23T02:00:00Z', zone, now)).toBe('tomorrow 03:00');
    expect(when('2026-11-22T23:30:00Z', zone, now)).toBe('tomorrow 00:30');
    expect(when('2026-11-22T23:30:00Z', 'UTC', now)).toBe('today 23:30');
  });
});
