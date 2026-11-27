// DISP-15: the repo's check command runs before a work session's turn is reported done.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CheckProgress } from '../src/shared/checkProgress.ts';
import type { StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS, type Repo } from '../src/shared/types.ts';
import { workPrompt } from '../src/worker/prompts.ts';
import { agentCheck, TurnCheck, turnCheckLevel, turnChecks, type CheckOutcome } from '../src/worker/turnCheck.ts';
import { Workspaces } from '../src/worker/workspace.ts';

const progress: CheckProgress = { stage: null, current: null, passed: 0, failed: 0, skipped: 0, units: 3, total: null, elapsed_ms: 1200 };
const repo = (id: number, name: string, check: string | null = 'npm test'): Repo =>
  ({ id, project_id: 1, github_owner: 'me', github_name: name, default_branch: 'main', check_command: check, local_path: null, worktree_from: null, setup_command: null });

function harness(opts: { retries?: number; repos?: Repo[] } = {}) {
  const sent: WorkerToServer[] = [];
  const state = new Map<number, string | null>();
  const results: CheckOutcome[] = [];
  let runs = 0;
  let hang: ((r: CheckOutcome) => void) | null = null;
  const repos = opts.repos ?? [repo(1, 'app')];
  for (const r of repos) state.set(r.id, 'v1');
  const tc = new TurnCheck({
    sessionId: 7, repos: repos.map((r) => ({ repo: r, level: r.check_command ? 'full' as const : 'quick' as const, command: r.check_command ?? r.quick_check_command! })), retries: opts.retries ?? 2, timeoutMin: 120,
    state: async (r) => state.get(r.id) ?? null,
    check: (_r, _command, onProgress, signal) => {
      runs++;
      onProgress(progress);
      const next = results.shift();
      if (next) return Promise.resolve(next);
      return new Promise((res) => {
        hang = res;
        signal.addEventListener('abort', () => res({ code: 137, out: '', timed_out: false, duration_ms: 5, progress }));
      });
    },
    send: (m) => sent.push(m),
  });
  const ok = (): CheckOutcome => ({ code: 0, out: 'all good', timed_out: false, duration_ms: 65_000, progress });
  const fail = (out = 'FAIL test/a.test.ts\nexpected 1 to be 2'): CheckOutcome => ({ code: 1, out, timed_out: false, duration_ms: 3000, progress });
  return { tc, sent, state, results, ok, fail, runs: () => runs, release: (r: CheckOutcome) => hang?.(r) };
}

const notices = (sent: WorkerToServer[]) => sent.filter((m) => m.t === 'notice');
const texts = (sent: WorkerToServer[]) => sent.flatMap((m) => (m.t === 'event' && 'text' in m.body ? [m.body.text] : []));

describe('TurnCheck', () => {
  it('sends a failing check back with its output, and lets the turn end once it passes', async () => {
    const h = harness();
    h.results.push(h.fail());
    const fix = await h.tc.gate();
    expect(fix).toContain('From Dispatch, not the owner');
    expect(fix).toContain('`npm test` failed (exit code 1)');
    expect(fix).toContain('expected 1 to be 2');
    expect(fix).toContain('fix turn 1 of 2');
    expect(texts(h.sent).some((t) => t.startsWith('Check failed (exit code 1) in app'))).toBe(true);
    // live progress for the page, then how it went
    expect(h.sent.filter((m) => m.t === 'session_check')).toEqual([
      { t: 'session_check', session_id: 7, repo_id: 1, command: 'npm test', progress },
      { t: 'session_check', session_id: 7, repo_id: 1, command: 'npm test', done: { ok: false, duration_ms: 3000, units: 3 } },
    ]);
    h.state.set(1, 'v2'); // the agent fixed it
    h.results.push(h.ok());
    expect(await h.tc.gate()).toBeNull();
    expect(texts(h.sent)).toContain('Full check passed in app (npm test, 1 min 5 s).');
    expect(notices(h.sent)).toEqual([]);
  });

  it('does not check a worktree with nothing to check, or one unchanged since a passing run', async () => {
    const h = harness();
    h.state.set(1, null);
    expect(await h.tc.gate()).toBeNull();
    expect(h.runs()).toBe(0);
    h.state.set(1, 'v1');
    h.results.push(h.ok());
    expect(await h.tc.gate()).toBeNull();
    expect(await h.tc.gate()).toBeNull(); // a chat turn with no change
    expect(h.runs()).toBe(1);
  });

  it('stops at the retry limit and tells the owner', async () => {
    const h = harness({ retries: 1 });
    h.results.push(h.fail());
    expect(await h.tc.gate()).not.toBeNull();
    h.state.set(1, 'v2');
    h.results.push(h.fail());
    expect(await h.tc.gate()).toBeNull();
    expect(notices(h.sent)).toHaveLength(1);
    expect(notices(h.sent)[0]).toMatchObject({ title: 'Check still fails in app' });
    expect((notices(h.sent)[0] as { body: string }).body).toContain('Claude had 1 fix turn.');
    // the owner writes: the fix turns count again
    h.tc.ownerTurn();
    h.state.set(1, 'v3');
    h.results.push(h.fail());
    expect(await h.tc.gate()).toContain('fix turn 1 of 1');
  });

  it('tells the owner once when the agent ends its turn without fixing a failed check', async () => {
    const h = harness();
    h.results.push(h.fail());
    expect(await h.tc.gate()).not.toBeNull();
    expect(await h.tc.gate()).toBeNull(); // "this failure is not caused by the batch"
    expect(h.runs()).toBe(1);
    expect(notices(h.sent).map((n) => (n as { title: string }).title)).toEqual(['Check fails in app']);
    expect(await h.tc.gate()).toBeNull();
    expect(notices(h.sent)).toHaveLength(1);
  });

  it('checks every changed repo and names each failure', async () => {
    const h = harness({ repos: [repo(1, 'front'), repo(2, 'back', 'pytest')] });
    h.results.push(h.fail('front broke'), { ...h.fail('back broke'), code: 2 });
    const fix = await h.tc.gate();
    expect(fix).toContain('front: `npm test` failed (exit code 1)');
    expect(fix).toContain('back: `pytest` failed (exit code 2)');
    expect(fix).toContain('back broke');
  });

  it('says when the check ran out of time', async () => {
    const h = harness();
    h.results.push({ ...h.fail(), code: 137, timed_out: true });
    expect(await h.tc.gate()).toContain('stopped after 120 minutes (CHECK_TIMEOUT_MIN on the worker)');
  });

  it('stops a running check when cancelled, and checks again next time', async () => {
    const h = harness();
    const gate = h.tc.gate();
    await new Promise((r) => setTimeout(r, 10));
    h.tc.cancel();
    expect(await gate).toBeNull();
    expect(h.sent.filter((m) => m.t === 'session_check').at(-1)).toEqual({ t: 'session_check', session_id: 7, repo_id: 1, command: 'npm test' });
    expect(texts(h.sent)).toContain('Check of app stopped.');
    h.results.push(h.ok());
    expect(await h.tc.gate()).toBeNull();
    expect(h.runs()).toBe(2);
  });

  it('names the level and the tree, and does not run a check again on a tree it passed on (DISP-260)', async () => {
    const h = harness({ repos: [{ ...repo(1, 'app', null), quick_check_command: 'npm run lint' }] });
    h.results.push({ ...h.ok(), tree: 'abcdef1234' });
    expect(await h.tc.gate()).toBeNull();
    expect(texts(h.sent)).toContain('Running the quick check of app before the turn is reported done: npm run lint');
    expect(texts(h.sent)).toContain('Quick check passed in app (npm run lint, tree abcdef1, 1 min 5 s).');
    // the agent ran it itself on this tree: the worker says so, nothing runs and nothing is kept as a run
    h.state.set(1, 'v2');
    const before = h.sent.length;
    h.results.push({ ...h.ok(), duration_ms: 0, tree: '1234567890', reused: true });
    expect(await h.tc.gate()).toBeNull();
    expect(h.sent.slice(before).filter((m) => m.t === 'session_check' && m.done)).toEqual([]);
    expect(texts(h.sent)).toContain('Quick check of app not run again: it already passed on exactly this tree (npm run lint, tree 1234567).');
  });
});

describe('the level a turn check runs (DISP-260)', () => {
  const on = { turn_check: true };
  const quick = { ...repo(1, 'app'), quick_check_command: 'npm run lint' };
  it('runs the full check only where no GitHub CI runs it, else the quick one', () => {
    expect(turnCheckLevel(repo(1, 'app'), on)).toBe('full');
    expect(turnCheckLevel(quick, on)).toBe('full'); // no CI: the full check covers the quick one
    expect(turnCheckLevel({ ...quick, ci: true }, on)).toBe('quick');
    expect(turnCheckLevel({ ...repo(1, 'app'), ci: true }, on)).toBe('none');
    expect(turnCheckLevel({ ...quick, ci: true, local_path: '/r' }, on)).toBe('full');
    expect(turnCheckLevel({ ...quick, ci: true, kind: 'hosted' }, on)).toBe('full');
    expect(turnCheckLevel({ ...repo(1, 'app', null), quick_check_command: 'lint' }, on)).toBe('quick');
    expect(turnCheckLevel(quick, { turn_check: false })).toBe('none');
    expect(turnChecks([{ ...quick, ci: true }, repo(2, 'docs', null)], on)).toEqual([{ repo: { ...quick, ci: true }, level: 'quick', command: 'npm run lint' }]);
  });

  it("knows the agent's own run of a check command", () => {
    const repos = [quick, repo(2, 'api', 'pytest -q')];
    expect(agentCheck(repos, 'npm test')).toEqual({ repo: quick, command: 'npm test' });
    expect(agentCheck(repos, 'cd api && pytest -q 2>&1')).toEqual({ repo: repos[1], command: 'pytest -q' });
    expect(agentCheck(repos, 'npm run lint')).toEqual({ repo: quick, command: 'npm run lint' });
    expect(agentCheck(repos, 'npm test | tail -5')).toBeNull(); // the exit code is tail's
    expect(agentCheck(repos, 'npm test -- a.test.ts')).toBeNull();
    expect(agentCheck([repo(1, 'a'), repo(2, 'b')], 'npm test')).toBeNull(); // which repo is not known
  });
});

describe('the work prompt', () => {
  const spec = (turn_check: boolean): StartSpec => ({
    session_id: 1, kind: 'work', project_key: 'HC', project_name: 'HC', importance_scale: [], effort_scale: [],
    title: 't', branch: 'b', repos: [repo(1, 'app'), repo(2, 'docs', null)], items: [], source: null, prompt: '', force_plan: false,
    options: { ...DEFAULT_RUN_OPTIONS, turn_check }, claude_account: null, github_account: null, resume: null, resume_note: null,
  });
  it('tells the agent the check runs when its turn ends', () => {
    expect(workPrompt(spec(true))).toContain("Dispatch runs the repo's check command (app: `npm test`)");
    expect(workPrompt(spec(false))).not.toContain("runs the repo's check command");
  });
  it('tells the agent not to run the check or CI suite itself (DISP-261)', () => {
    expect(workPrompt(spec(true))).toContain('Do not run that command yourself; Dispatch runs it after your turn. Run only the tests for what you changed.');
    // no turn check, but the merge check runs it when auto-merge is on
    const merge = workPrompt({ ...spec(false), options: { ...spec(false).options, auto_merge: 'local' } });
    expect(workPrompt({ ...spec(false), options: { ...spec(false).options, auto_merge: 'github' } })).not.toContain('Do not run');
    expect(merge).toContain("Dispatch runs the repo's check command (app: `npm test`) before it merges. Do not run that command yourself.");
    expect(workPrompt(spec(false))).not.toContain('Do not run');
    const ci = workPrompt({ ...spec(false), repos: [repo(1, 'app'), { ...repo(2, 'docs', null), ci: true }] });
    expect(ci).toContain('GitHub CI runs the test suite on the PR in docs. Do not run the full suite yourself');
  });
  it('names the level that runs after the turn (DISP-260)', () => {
    const withCi = workPrompt({ ...spec(true), repos: [{ ...repo(1, 'app'), ci: true, quick_check_command: 'npm run lint' }] });
    expect(withCi).toContain("Dispatch runs the repo's quick check command (app: `npm run lint`) in your checkout");
    expect(withCi).not.toContain("runs the repo's check command");
    expect(withCi).toContain('GitHub CI runs the test suite on the PR in app. Do not run the full suite yourself');
  });
});

describe('Workspaces turn state', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  let ws: Workspaces;
  let r: Repo;
  let spec: StartSpec;

  beforeEach(() => {
    const remoteRoot = mkdtempSync(join(tmpdir(), 'dsp-remote-'));
    const bare = join(remoteRoot, 'me', 'hc.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    const seed = mkdtempSync(join(tmpdir(), 'dsp-seed-'));
    git(seed, 'init', '-b', 'main');
    writeFileSync(join(seed, 'a.txt'), 'one\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'init');
    git(seed, 'push', bare, 'main');
    ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')), `file://${remoteRoot}`);
    r = { ...repo(1, 'hc', 'test "$(cat a.txt)" = one'), github_owner: 'me' };
    spec = {
      session_id: 1, kind: 'work', project_key: 'HC', project_name: 'HC', importance_scale: [], effort_scale: [],
      title: 't', branch: 'feat', repos: [r], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null,
    };
  });

  it('is null until the worktree differs from the default branch, then follows commits and edits', async () => {
    expect(await ws.turnState(r, 1)).toBeNull(); // no worktree yet
    const cwd = await ws.prepare(spec);
    expect(await ws.turnState(r, 1)).toBeNull();
    writeFileSync(join(cwd, 'a.txt'), 'two\n');
    const dirty = await ws.turnState(r, 1);
    expect(dirty).not.toBeNull();
    git(cwd, 'commit', '-am', 'change a');
    const committed = await ws.turnState(r, 1);
    expect(committed).not.toBeNull();
    expect(committed).not.toBe(dirty);
    expect(await ws.turnState(r, 1)).toBe(committed);
  });

  it('runs the check command in the session worktree', async () => {
    const cwd = await ws.prepare(spec);
    expect((await ws.sessionCheck(r, 1)).code).toBe(0);
    writeFileSync(join(cwd, 'a.txt'), 'two\n');
    expect((await ws.sessionCheck(r, 1)).code).not.toBe(0);
  });

  it('does not run a check again on files it, or the agent, already passed on (DISP-260)', async () => {
    const cwd = await ws.prepare(spec);
    const counted = { ...r, check_command: 'echo ran >> ../runs; test "$(cat a.txt)" = two' };
    writeFileSync(join(cwd, 'a.txt'), 'two\n');
    const first = await ws.sessionCheck(counted, 1);
    expect(first).toMatchObject({ code: 0 });
    expect(first.reused).toBeUndefined();
    // committed as it was checked: the same files, so the same tree
    git(cwd, 'commit', '-am', 'two');
    expect(await ws.sessionCheck(counted, 1)).toMatchObject({ code: 0, reused: true, tree: first.tree });
    // the agent ran the quick check itself on new files: remembered, then not run again
    writeFileSync(join(cwd, 'new.txt'), 'x\n');
    const tree = (await ws.sessionTree(r, 1))!;
    ws.rememberPass(r, 'npm run lint', tree);
    expect(await ws.sessionCheck(r, 1, undefined, undefined, null, 'npm run lint')).toMatchObject({ reused: true, tree });
    // the index git keeps is not touched
    expect(git(cwd, 'status', '--porcelain')).toBe('?? new.txt');
  });

  it('stops a check when aborted', async () => {
    await ws.prepare(spec);
    const ctrl = new AbortController();
    const started = Date.now();
    const run = ws.sessionCheck({ ...r, check_command: 'sleep 30' }, 1, undefined, ctrl.signal);
    setTimeout(() => ctrl.abort(), 100);
    expect((await run).code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('CheckRuns for a turn check', () => {
  it('shows the run on the session page while it runs, then keeps how it went', async () => {
    const { CheckRuns } = await import('../src/server/checkRuns.ts');
    const added: unknown[] = [];
    const emitted: unknown[] = [];
    const store = { checkHistory: () => [{ duration_ms: 60_000, units: 3 }], addCheckRun: (r: unknown) => added.push(r) };
    const runs = new CheckRuns(store as never, { emit: (e: unknown) => emitted.push(e) } as never);
    const r = repo(4, 'app');
    runs.turn(9, r, { progress });
    expect(runs.of(9)).toMatchObject([{ session_id: 9, pr_id: null, repo: 'app', command: 'npm test', expected: { duration_ms: 60_000, units: 3 } }]);
    runs.turn(9, r, { done: { ok: true, duration_ms: 1000, units: 3 } });
    expect(runs.of(9)).toEqual([]);
    expect(added).toEqual([{ repo_id: 4, command: 'npm test', ok: true, duration_ms: 1000, units: 3 }]);
    expect(emitted).toHaveLength(2);
    // stopped: off the page, nothing kept
    runs.turn(9, r, { progress });
    runs.turn(9, r, {});
    expect(runs.of(9)).toEqual([]);
    expect(added).toHaveLength(1);
  });
});
