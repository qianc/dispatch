import { describe, expect, it } from 'vitest';
import { CheckParser, expectedFrom, formatLeft, timeLeft } from '../src/shared/checkProgress.ts';
import { WorkerLink } from '../src/server/workerHub.ts';

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

  it('reads pytest: collected total, progress dots, -v and xdist lines', () => {
    const p = new CheckParser();
    p.write([
      '============================= test session starts ==============================',
      'collected 10 items / 2 deselected / 8 selected',
      '',
      'tests/test_a.py ..F.  [ 50%]',
      'tests/test_b.py sx',
      '',
      '=========================== short test summary info ============================',
      'FAILED tests/test_a.py::test_three - AssertionError',
      '',
    ].join('\n'));
    expect(p.progress(0)).toMatchObject({ stage: 'pytest', total: 8, units: 6, passed: 3, failed: 1, skipped: 2, current: 'tests/test_b.py' });

    const v = new CheckParser();
    v.write('created: 4/4 workers\n4 workers [3 items]\n\n[gw0] [ 33%] PASSED tests/test_a.py::test_one \n[gw1] [ 66%] FAILED tests/test_b.py::test_two \n');
    v.write('tests/test_c.py::test_three SKIPPED (no db)  [100%]\n');
    expect(v.progress(0)).toMatchObject({ total: 3, units: 3, passed: 1, failed: 1, skipped: 1, current: 'tests/test_c.py' });

    // pytest -q: no "collected" line, the percentage gives the size
    const q = new CheckParser();
    q.write('..........                                [ 25%]\n');
    expect(q.progress(0)).toMatchObject({ units: 10, total: 40, passed: 10 });
  });

  it('reads the run count line of a multi-suite run_tests.sh (DISP-52)', () => {
    const p = new CheckParser();
    p.write('[ 12 / 40 · 30% ] passed 12, failed 0, skipped 0 · 2 of 5 suites collected\n');
    // the total can still grow: shown as "~", and earlier runs that saw more count
    expect(p.progress(0)).toMatchObject({ stage: 'pytest', units: 12, total: 40, passed: 12, failed: 0, skipped: 0, total_open: true });
    expect(timeLeft(p.progress(0), 10_000, { duration_ms: 100_000, units: 1_000 })).toBeGreaterThan(80_000);

    // the counts are for the whole run: set, not added; thousands commas
    p.write('\x1b[32m[ 412 / 1,038 · 40% ] passed 409, failed 0, skipped 3\x1b[0m\n');
    let pr = p.progress(0);
    expect(pr).toMatchObject({ units: 412, total: 1038, passed: 409, failed: 0, skipped: 3 });
    expect(pr.total_open).toBeUndefined();
    expect(timeLeft(pr, 10_000, null)).toBe(Math.round(10_000 / (412 / 1038) - 10_000));

    // pytest -u wrote part of a line first; pytest's own lines no longer add to the counts
    p.write('collected 300 items\ntests/test_a.py ..[ 1,100 / 1,038 · 100% ] passed 1,100, failed 2, skipped 3\n');
    p.write('tests/test_b.py ....  [ 90%]\n');
    pr = p.progress(0);
    expect(pr).toMatchObject({ units: 1100, total: 1038, passed: 1100, failed: 2, skipped: 3, stage: 'pytest' });

    // a stage already named stays
    const s = new CheckParser();
    s.write('> bash tools/run_tests.sh\n[ 1 / 2 · 50% ] passed 1, failed 0, skipped 0\n');
    expect(s.progress(0)).toMatchObject({ stage: 'bash tools/run_tests.sh', units: 1, total: 2 });
  });

  it('leaves cached or partial runs out of the estimate', () => {
    // "already green - not re-running" took a second and ran nothing
    expect(expectedFrom([{ duration_ms: 1_000, units: 0 }, { duration_ms: 2_400_000, units: 900 }, { duration_ms: 2_600_000, units: 910 }]))
      .toEqual({ duration_ms: 2_500_000, units: 905 });
    // a runner whose output is not read: short runs are the cached ones
    expect(expectedFrom([{ duration_ms: 2_000, units: 0 }, { duration_ms: 600_000, units: 0 }])).toEqual({ duration_ms: 600_000, units: 0 });
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

  it('a merge on the worker times out only after a silence, however long the check runs', async () => {
    const sent: { req_id: string }[] = [];
    const link = new WorkerLink(1, 'w', { readyState: 1, send: (m: string) => sent.push(JSON.parse(m)) } as never);
    const seen: unknown[] = [];
    const done = link.cmd({ c: 'merge_local' } as never, 100, (d) => seen.push(d));
    const p = link.pending.get(sent[0].req_id)!;
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 60));
      p.onProgress!(i);
    }
    p.resolve({ ok: true }); // 300 ms in: well past the 100 ms, but it kept reporting
    expect(await done).toEqual({ ok: true });
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    const silent = link.cmd({ c: 'merge_local' } as never, 50, () => undefined);
    await expect(silent).rejects.toThrow(/nothing heard/);
  });
});
