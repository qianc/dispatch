import { describe, expect, it } from 'vitest';
import { CheckParser, expectedFrom, formatLeft, timeLeft } from '../src/shared/checkProgress.ts';

describe('check progress (DISP-5)', () => {
  it('reads vitest file lines, with colours and in any chunks', () => {
    const p = new CheckParser();
    const out = [
      '',
      '> dispatch@ test',
      '> vitest run',
      '',
      '\x1b[1m\x1b[46m RUN \x1b[49m\x1b[22m \x1b[36mv5.0.4 \x1b[39m/repo',
      ' \x1b[32m✓\x1b[39m test/nav.test.ts \x1b[2m(\x1b[22m\x1b[2m3 tests\x1b[22m\x1b[2m)\x1b[22m 15ms',
      ' ❯ test/b.test.ts (4 tests | 1 failed | 1 skipped) 20ms',
      '   × breaks 3ms',
      ' ✓ test/c.test.ts (1 test) 2ms',
      '',
    ].join('\n');
    // split mid-line
    p.write(out.slice(0, 50));
    p.write(out.slice(50));
    expect(p.progress(1000)).toEqual({ stage: 'vitest run', current: 'test/c.test.ts', passed: 6, failed: 1, skipped: 1, units: 3, total: null, elapsed_ms: 1000 });
  });

  it('reads playwright list output with its announced total', () => {
    const p = new CheckParser();
    p.write([
      '> playwright test',
      'Running 3 tests using 1 worker',
      '  ✓  1 [chromium] › e2e/flow.spec.ts:10:5 › signs in (1.2s)',
      '  ✘  2 [chromium] › e2e/flow.spec.ts:20:5 › merges (3.0s)',
      '',
    ].join('\n'));
    const pr = p.progress(4000);
    expect(pr).toMatchObject({ stage: 'playwright test', passed: 1, failed: 1, units: 2, total: 3, current: 'e2e/flow.spec.ts:20:5 › merges' });
  });

  it('adds playwright totals on top of an earlier vitest stage', () => {
    const p = new CheckParser();
    p.write(' ✓ test/a.test.ts (2 tests) 5ms\nRunning 2 tests using 1 worker\n[1/2] [chromium] › e2e/a.spec.ts:1:1 › one\n');
    expect(p.progress(0)).toMatchObject({ units: 2, total: 3, passed: 3 });
  });

  it('estimates time left from earlier runs and from how far this one got', () => {
    const expected = expectedFrom([{ duration_ms: 60_000, units: 10 }, { duration_ms: 80_000, units: 10 }, { duration_ms: 70_000, units: 10 }]);
    expect(expected).toEqual({ duration_ms: 70_000, units: 10 });
    expect(timeLeft({ units: 0, total: null }, 10_000, expected)).toBe(60_000);
    // half-way after 20 s: the results say 20 s left, history says 50 s; it weighs them half and half
    expect(timeLeft({ units: 5, total: null }, 20_000, expected)).toBe(35_000);
    // longer than usual: never below zero
    expect(timeLeft({ units: 0, total: null }, 90_000, expected)).toBe(0);
    // no history: only an announced total helps
    expect(timeLeft({ units: 0, total: null }, 5_000, null)).toBeNull();
    expect(timeLeft({ units: 1, total: 4 }, 5_000, null)).toBe(15_000);
    expect(expectedFrom([])).toBeNull();
    expect(formatLeft(3_000)).toBe('under 10 s');
    expect(formatLeft(42_000)).toBe('about 40 s');
    expect(formatLeft(185_000)).toBe('about 3 min');
  });
});
