import { describe, expect, it } from 'vitest';
import { messageTime } from '../web/src/time.ts';

// local times, so the test holds in any time zone
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();
const now = new Date(2026, 9, 22, 18, 30);

describe('chat message times (DISP-22)', () => {
  it('today: hours and minutes', () => {
    expect(messageTime(at(2026, 10, 22, 9, 5), now)).toBe('09:05');
    expect(messageTime(at(2026, 10, 22, 0, 0), now)).toBe('00:00');
  });

  it('earlier this year: day, month and time', () => {
    expect(messageTime(at(2026, 10, 21, 23, 59), now)).toBe('21 Oct 23:59');
    expect(messageTime(at(2026, 1, 3, 14, 7), now)).toBe('3 Jan 14:07');
  });

  it('another year: with the year', () => {
    expect(messageTime(at(2025, 12, 31, 8, 0), now)).toBe('31 Dec 2025 08:00');
  });
});
