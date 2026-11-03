// Live progress of a repo's check command (the test suite run before a local merge, DISP-5):
// read from its output line by line, and the time left from earlier runs of the same command.

export interface CheckProgress {
  /** the step that runs now: an npm script's command, or the test runner */
  stage: string | null;
  /** the test file or test that finished last */
  current: string | null;
  passed: number;
  failed: number;
  skipped: number;
  /** results seen so far (test files of vitest, tests of playwright): the measure of how far it got */
  units: number;
  /** results to expect, when the runner says so (playwright: "Running 40 tests") */
  total: number | null;
  /** the total is a guess or can still grow (pytest -q's percentage, suites still collecting): show it as "~" */
  total_open?: boolean;
  elapsed_ms: number;
}

/** A check command running now for one session's branch. */
export interface CheckRun {
  session_id: number;
  /** null: the session's own check before its turn is reported done (DISP-15) */
  pr_id: number | null;
  repo: string;
  command: string;
  started_at: string;
  progress: CheckProgress;
  /** from earlier passing runs of the same command in the same repo; null: no history yet */
  expected: { duration_ms: number; units: number } | null;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(s: string) {
  return s.replace(ANSI, '');
}

/** vitest: " ✓ test/a.test.ts (12 tests | 1 skipped) 345ms", " ❯ test/b.test.ts (3 tests | 1 failed) 20ms" */
const VITEST_FILE = /^\s*([✓❯×↓])\s+(\S+\.\w+)\s+\((\d+) tests?((?:\s*\|\s*\d+ \w+)*)\)/;
/** playwright list reporter: "  ✓  12 [chromium] › e2e/a.spec.ts:10:5 › title (1.2s)" */
const PW_LIST = /^\s*([✓✘×-])\s+\d+\s+(.*›.*?)(?:\s+\(\d[\d.]*m?s\))?$/;
/** playwright line reporter: "[3/40] [chromium] › e2e/a.spec.ts:10:5 › title" */
const PW_LINE = /^\[(\d+)\/(\d+)\]\s+(.*)$/;
const PW_RUNNING = /^Running (\d+) tests? using/;
/** pytest: "collected 523 items", "collected 523 items / 2 deselected / 521 selected", xdist "8 workers [523 items]" */
const PYTEST_COLLECTED = /^collected (\d+) items?(?: \/ \d+ deselected \/ (\d+) selected)?/;
const PYTEST_XDIST = /^\d+ workers? \[(\d+) items?\]/;
/** pytest progress: "tests/test_a.py ..F.s  [ 12%]", a wrapped "......  [ 30%]", or xdist's dots */
const PYTEST_DOTS = /^(?:(\S+\.py)\s+)?([.FEsxX]+)\s*(\[\s*\d+%\])?$/;
/** pytest -v: "tests/a.py::test_x PASSED  [ 12%]"; with xdist: "[gw0] [ 12%] PASSED tests/a.py::test_x" */
const PYTEST_VERBOSE = /^(\S+::\S.*?)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b/;
const PYTEST_XDIST_VERBOSE = /^\[gw\d+\]\s+\[\s*\d+%\]\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\s+(\S+::.*)$/;
/**
 * A run_tests.sh that runs several pytest suites, for the whole run (DISP-52):
 * "[ 412 / 1,038 · 40% ] passed 409, failed 0, skipped 3", with " · 2 of 5 suites collected" while
 * the total can still grow. Not anchored: pytest -u can write it after part of another line.
 */
const RUN_COUNT = /\[\s*(\d[\d,]*)\s*\/\s*(\d[\d,]*)[^\]]*\]\s*passed (\d[\d,]*), failed (\d[\d,]*), skipped (\d[\d,]*)(\s*·\s*\d+ of \d+ suites collected)?/;
const num = (s: string) => Number(s.replace(/,/g, ''));
/** npm/pnpm/yarn run header: "> pkg@1.0.0 test" then "> vitest run" */
const NPM_HEADER = /^> (\S+@\S*\s+\S+|\S+ \S+@\S*)$/;

/** Reads a check command's output, a line at a time, into progress. */
export class CheckParser {
  private p: Omit<CheckProgress, 'elapsed_ms'> = { stage: null, current: null, passed: 0, failed: 0, skipped: 0, units: 0, total: null };
  /** playwright totals per stage add up when several runs follow each other */
  private totalBase = 0;
  private pwLineDone = 0;
  private partial = '';
  private pyTotalGuess: number | null = null;
  /** a run count line was seen: it gives the counts for the whole run, pytest's own lines no longer add to them */
  private runCount = false;

  /** Feed raw output (any chunking); returns true when the progress changed. */
  write(chunk: string): boolean {
    const lines = (this.partial + chunk).split(/\r?\n|\r/);
    this.partial = lines.pop() ?? '';
    let changed = false;
    for (const l of lines) changed = this.line(l) || changed;
    return changed;
  }

  line(raw: string): boolean {
    const l = stripAnsi(raw).trimEnd();
    if (!l.trim()) return false;
    let m: RegExpMatchArray | null;
    if ((m = l.match(RUN_COUNT))) {
      this.runCount = true;
      this.p.units = num(m[1]);
      this.p.total = num(m[2]);
      this.p.passed = num(m[3]);
      this.p.failed = num(m[4]);
      this.p.skipped = num(m[5]);
      this.p.total_open = m[6] ? true : undefined;
      if (!this.p.stage) this.p.stage = 'pytest';
      return true;
    }
    if (this.runCount && (PYTEST_COLLECTED.test(l) || PYTEST_XDIST.test(l) || PYTEST_DOTS.test(l))) return false;
    if (this.runCount && (m = l.match(PYTEST_VERBOSE) ?? l.match(PYTEST_XDIST_VERBOSE))) {
      this.p.current = (m[1].includes('::') ? m[1] : m[2]).split('::')[0];
      return true;
    }
    if ((m = l.match(VITEST_FILE))) {
      const tests = Number(m[3]);
      const extra = Object.fromEntries([...(m[4] ?? '').matchAll(/(\d+) (\w+)/g)].map((x) => [x[2], Number(x[1])]));
      const failed = extra.failed ?? 0;
      const skipped = (extra.skipped ?? 0) + (extra.todo ?? 0);
      this.p.passed += Math.max(0, tests - failed - skipped);
      this.p.failed += failed;
      this.p.skipped += skipped;
      this.p.units++;
      this.p.current = m[2];
      return true;
    }
    if ((m = l.match(PYTEST_COLLECTED)) || (m = l.match(PYTEST_XDIST))) {
      // a new pytest run: its total comes on top of what earlier runs reported
      this.totalBase = this.p.units;
      this.p.total = this.totalBase + Number(m[2] ?? m[1]);
      if (!this.p.stage) this.p.stage = 'pytest';
      return true;
    }
    if ((m = l.match(PYTEST_VERBOSE)) || (m = l.match(PYTEST_XDIST_VERBOSE))) {
      const [what, name] = m[1].includes('::') ? [m[2], m[1]] : [m[1], m[2]];
      this.pyResult(what === 'PASSED' || what === 'XPASS' ? '.' : what === 'SKIPPED' || what === 'XFAIL' ? 's' : 'F');
      this.p.current = name.split('::')[0];
      return true;
    }
    // the "[ 12%]" marks it as pytest; a file name alone only after pytest started (-q hides "collected")
    if ((m = l.match(PYTEST_DOTS)) && (m[3] || (m[1] && this.p.stage === 'pytest'))) {
      for (const c of m[2]) this.pyResult(c);
      if (m[1]) this.p.current = m[1];
      const pct = Number(m[3]?.match(/\d+/)?.[0] ?? 0);
      // no "collected" line (pytest -q): the percentage says how many there are
      if (this.p.total === null && pct > 0 && pct < 100) this.pyTotalGuess = Math.round((this.p.units * 100) / pct);
      return true;
    }
    if ((m = l.match(PW_RUNNING))) {
      this.totalBase = this.p.units;
      this.pwLineDone = 0;
      this.p.total = this.totalBase + Number(m[1]);
      if (!this.p.stage) this.p.stage = 'playwright';
      return true;
    }
    if ((m = l.match(PW_LINE))) {
      const done = Number(m[1]);
      if (done <= this.pwLineDone) return false;
      this.p.total = this.totalBase + Number(m[2]);
      this.p.units += done - this.pwLineDone;
      this.p.passed += done - this.pwLineDone; // the line reporter names failures separately
      this.pwLineDone = done;
      this.p.current = m[3].replace(/^\[[^\]]+\]\s*›\s*/, '');
      return true;
    }
    if ((m = l.match(PW_LIST)) && this.p.total !== null) {
      if (m[1] === '✓') this.p.passed++;
      else if (m[1] === '-') this.p.skipped++;
      else this.p.failed++;
      this.p.units++;
      this.p.current = m[2].replace(/^\[[^\]]+\]\s*›\s*/, '');
      return true;
    }
    if (/^\s*\d+\) .*›/.test(l) && this.pwLineDone > 0) {
      // the line reporter's failure header ("  1) [chromium] › a.spec.ts:3:1 › title")
      this.p.failed++;
      this.p.passed = Math.max(0, this.p.passed - 1);
      return true;
    }
    if (NPM_HEADER.test(l)) return false; // the next "> command" line names the stage
    if ((m = l.match(/^> (.+)$/))) {
      this.p.stage = m[1].trim().slice(0, 120);
      return true;
    }
    if ((m = l.match(/^\s*RUN\s+v[\d.]+/))) {
      if (!this.p.stage) this.p.stage = 'vitest';
      return true;
    }
    return false;
  }

  private pyResult(c: string) {
    if (c === '.' || c === 'X') this.p.passed++;
    else if (c === 's' || c === 'x') this.p.skipped++;
    else this.p.failed++;
    this.p.units++;
  }

  progress(elapsedMs: number): CheckProgress {
    const guess = this.p.total === null && this.pyTotalGuess !== null;
    const { total_open, ...p } = this.p;
    return { ...p, total: this.p.total ?? this.pyTotalGuess, ...(total_open || guess ? { total_open: true } : {}), elapsed_ms: elapsedMs };
  }
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * What earlier passing runs say to expect (the newest few count). Runs that did far less than the
 * others are left out: a runner that answers from a cache ("already green - not re-running") or
 * ran only part of the suite says nothing about a full run.
 */
export function expectedFrom(history: { duration_ms: number; units: number }[]): CheckRun['expected'] {
  const maxUnits = Math.max(0, ...history.map((h) => h.units));
  const maxTime = Math.max(0, ...history.map((h) => h.duration_ms));
  const full = history.filter((h) => (maxUnits > 0 ? h.units >= maxUnits / 2 : h.duration_ms >= maxTime / 4));
  const recent = full.slice(0, 5);
  if (!recent.length) return null;
  return { duration_ms: Math.round(median(recent.map((h) => h.duration_ms))), units: Math.round(median(recent.map((h) => h.units))) };
}

/**
 * Milliseconds left, or null when nothing says. Earlier runs give the usual duration; the results
 * seen so far against the usual (or announced) number of results say how far this run is. The
 * further it is, the more the second counts.
 */
export function timeLeft(p: Pick<CheckProgress, 'units' | 'total' | 'total_open'>, elapsedMs: number, expected: CheckRun['expected']): number | null {
  const usual = expected && expected.units > 0 ? expected.units : null;
  // a total that can still grow is at least what it says, and earlier runs may know it is more
  const of = p.total !== null && p.total_open && usual !== null ? Math.max(p.total, usual) : p.total ?? usual;
  const f = of && p.units > 0 ? Math.min(p.units / of, 0.99) : 0;
  const byUnits = f > 0 ? elapsedMs / f - elapsedMs : null;
  const byTime = expected ? expected.duration_ms - elapsedMs : null;
  let left: number | null;
  if (byUnits !== null && byTime !== null) left = (1 - f) * byTime + f * byUnits;
  else left = byUnits ?? byTime;
  return left === null ? null : Math.max(0, Math.round(left));
}

/** "about 3 min", "about 40 s", "under 10 s" */
export function formatLeft(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 10) return 'under 10 s';
  if (s < 90) return `about ${Math.round(s / 5) * 5} s`;
  return `about ${Math.round(s / 60)} min`;
}
