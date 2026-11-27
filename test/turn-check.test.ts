// DISP-15: the repo's check command runs before a work session's turn is reported done.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CHECK_WAITS, type CheckProgress } from '../src/shared/checkProgress.ts';
import type { StartSpec, WorkerToServer } from '../src/shared/protocol.ts';
import { DEFAULT_RUN_OPTIONS, repoPatch, type Repo } from '../src/shared/types.ts';
import { CheckQueue } from '../src/worker/checkQueue.ts';
import { workPrompt } from '../src/worker/prompts.ts';
import { agentCheck, mappedTests, quickWithTests, TurnCheck, turnCheckLevel, turnChecks, type CheckOutcome } from '../src/worker/turnCheck.ts';
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

  it("follows the batch's check_level, falling back where the repo lacks the command (DISP-262)", () => {
    const ci = { ...quick, ci: true };
    expect(turnCheckLevel(ci, { ...on, check_level: 'full' })).toBe('full');
    expect(turnCheckLevel(quick, { ...on, check_level: 'quick' })).toBe('quick');
    expect(turnCheckLevel(quick, { ...on, check_level: 'none' })).toBe('none');
    expect(turnCheckLevel({ ...repo(1, 'app', null), quick_check_command: 'lint' }, { ...on, check_level: 'full' })).toBe('quick');
    expect(turnCheckLevel(repo(1, 'app'), { ...on, check_level: 'quick' })).toBe('none');
    expect(turnCheckLevel(ci, { turn_check: false, check_level: 'full' })).toBe('none');
  });

  it('a running session takes a changed level at its next turn, also on an unchanged tree (DISP-262)', async () => {
    const r = { ...quick, ci: true };
    const h = harness({ repos: [r] });
    h.tc.use(turnChecks([r], { ...on, check_level: 'quick' }));
    h.results.push(h.ok());
    expect(await h.tc.gate()).toBeNull();
    expect(texts(h.sent)).toContain('Running the quick check of app before the turn is reported done: npm run lint');
    h.tc.use(turnChecks([r], { ...on, check_level: 'full' }));
    h.results.push(h.ok());
    expect(await h.tc.gate()).toBeNull();
    expect(texts(h.sent)).toContain('Running the full check of app before the turn is reported done: npm test');
    expect(h.runs()).toBe(2);
    h.tc.use(turnChecks([r], { ...on, check_level: 'none' }));
    h.state.set(1, 'v2');
    expect(await h.tc.gate()).toBeNull();
    expect(h.runs()).toBe(2);
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

describe('quick check with the tests for the changed paths (DISP-268)', () => {
  const rules = ['src/(.+)\\.ts => test/$1.test.ts', '(test/.+\\.test\\.ts) => $1', 'broken( => x', 'docs/.* => ../outside.test.ts'];
  const have = new Set(['test/a.test.ts', 'test/b.test.ts']);

  it('maps changed paths to the test files that exist, each once', () => {
    expect(mappedTests(rules, ['src/a.ts', 'test/a.test.ts', 'src/new.ts', 'test/b.test.ts', 'docs/x.md', 'README.md'], (f) => have.has(f)))
      .toEqual(['test/a.test.ts', 'test/b.test.ts']);
    // a rule matches the whole path only
    expect(mappedTests(rules, ['lib/src/a.ts'], () => true)).toEqual([]);
  });

  it('runs the test command with them after the quick check; the quick check alone when none are found', () => {
    const r = { ...repo(1, 'app', null), quick_check_command: 'npm run lint', quick_test_command: 'npx vitest run' };
    expect(quickWithTests(r, 'npm run lint', ['test/a.test.ts', "test/it's.test.ts"])).toBe(`npm run lint && npx vitest run test/a.test.ts 'test/it'\\''s.test.ts'`);
    expect(quickWithTests(r, 'npm run lint', [])).toBe('npm run lint');
    expect(quickWithTests({ ...r, quick_test_command: null }, 'npm run lint', ['test/a.test.ts'])).toBe('npm run lint');
  });

  it('a repo takes only rules of the form `<regex> => <test file>`', () => {
    expect(repoPatch.safeParse({ quick_test_map: ['src/(.+)\\.ts => test/$1.test.ts'] }).success).toBe(true);
    for (const bad of ['src/a.ts', 'src/( => x', ' => x']) expect(repoPatch.safeParse({ quick_test_map: [bad] }).success).toBe(false);
  });

  it('a turn check runs the command that fits the change', async () => {
    const r = { ...repo(1, 'app', null), quick_check_command: 'npm run lint' };
    const ran: string[] = [];
    const tc = new TurnCheck({
      sessionId: 7, repos: [{ repo: r, level: 'quick', command: 'npm run lint' }], retries: 1, timeoutMin: 1,
      state: async () => 'v1',
      check: async (_r, command) => { ran.push(command); return { code: 0, out: '', timed_out: false, duration_ms: 1, progress }; },
      send: () => undefined,
      command: async (c) => `${c.command} && npx vitest run test/a.test.ts`,
    });
    expect(await tc.gate()).toBeNull();
    expect(ran).toEqual(['npm run lint && npx vitest run test/a.test.ts']);
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

  it('lists the changed paths, committed or not, and runs the tests they map to (DISP-268)', async () => {
    const cwd = await ws.prepare(spec);
    expect(await ws.changedPaths(r, 1)).toEqual([]);
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'test'));
    writeFileSync(join(cwd, 'src', 'b.ts'), 'b\n');
    writeFileSync(join(cwd, 'test', 'b.test.ts'), 'b passes\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'b');
    writeFileSync(join(cwd, 'a.txt'), 'two\n');
    writeFileSync(join(cwd, 'new.txt'), 'x\n');
    expect((await ws.changedPaths(r, 1)).sort()).toEqual(['a.txt', 'new.txt', 'src/b.ts', 'test/b.test.ts']);
    const q = { ...r, quick_check_command: 'true', quick_test_command: 'grep -q passes', quick_test_map: ['src/(.+)\\.ts => test/$1.test.ts'] };
    const tests = mappedTests(q.quick_test_map, await ws.changedPaths(q, 1), (f) => existsSync(join(cwd, f)));
    const command = quickWithTests(q, 'true', tests);
    expect(command).toBe('true && grep -q passes test/b.test.ts');
    expect((await ws.sessionCheck(q, 1, undefined, undefined, null, command)).code).toBe(0);
    writeFileSync(join(cwd, 'test', 'b.test.ts'), 'fails\n');
    expect((await ws.sessionCheck(q, 1, undefined, undefined, null, command)).code).not.toBe(0);
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

  it('runs one check at a time on the worker: the other waits and says so, and a stop ends its wait (DISP-264)', async () => {
    await ws.prepare(spec);
    await ws.prepare({ ...spec, session_id: 2, branch: 'feat2' });
    await ws.prepare({ ...spec, session_id: 3, branch: 'feat3' });
    const log = join(mkdtempSync(join(tmpdir(), 'dsp-log-')), 'log');
    const timed = { ...r, check_command: `echo start $PWD >> ${log}; sleep 0.5; echo end >> ${log}` };
    const stages: Record<number, (string | null)[]> = { 1: [], 2: [], 3: [] };
    const seen = (id: number) => (p: CheckProgress) => stages[id].push(p.stage);
    const ctrl = new AbortController();
    const runs = [1, 2].map((id) => ws.sessionCheck(timed, id, seen(id)));
    // session 3 comes once a check runs, so it always finds the queue taken (its tree can be ready before theirs)
    while (!existsSync(log)) await new Promise((res) => setTimeout(res, 10));
    runs.push(ws.sessionCheck(timed, 3, seen(3), ctrl.signal));
    const stopped = Date.now();
    ctrl.abort();
    expect((await runs[2]).code).not.toBe(0);
    expect(Date.now() - stopped).toBeLessThan(400); // it did not wait for the running check
    expect((await runs[0]).code).toBe(0);
    expect((await runs[1]).code).toBe(0);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['start', 'end', 'start', 'end']);
    expect(lines.filter((l) => l.startsWith('start'))).toHaveLength(2); // the stopped check never ran
    // which of sessions 1 and 2 reaches the queue first is not fixed (DISP-269): one waits, the other never
    const [waited, first] = stages[1][0] === CHECK_WAITS ? [stages[1], stages[2]] : [stages[2], stages[1]];
    expect(waited[0]).toBe(CHECK_WAITS);
    expect(first).not.toContain(CHECK_WAITS);
    expect(stages[3]).toEqual([CHECK_WAITS]);
  });
});

describe('CheckQueue (DISP-264)', () => {
  it('runs as many at once as the setting allows, in turn', async () => {
    const q = new CheckQueue(() => 2);
    let now = 0;
    let most = 0;
    const waited: number[] = [];
    const order: number[] = [];
    const job = (i: number) => q.run(async () => {
      most = Math.max(most, ++now);
      await new Promise((r) => setTimeout(r, 20));
      now--;
      order.push(i);
    }, () => waited.push(i));
    await Promise.all([1, 2, 3, 4, 5].map(job));
    expect(most).toBe(2);
    expect(waited).toEqual([3, 4, 5]);
    expect(order.slice(2)).toEqual([3, 4, 5]);
    // all places are free again
    await job(6);
    expect(waited).toEqual([3, 4, 5]);
  });

  it('lets a failed check free its place', async () => {
    const q = new CheckQueue(() => 1);
    await expect(q.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const waited: number[] = [];
    await q.run(async () => {}, () => waited.push(1));
    expect(waited).toEqual([]);
  });
});

describe('CheckRuns for a turn check', () => {
  it('starts the clock of a waiting check when it runs (DISP-264)', async () => {
    const { CheckRuns } = await import('../src/server/checkRuns.ts');
    const runs = new CheckRuns({ checkHistory: () => [], addCheckRun: () => {} } as never, { emit: () => {} } as never);
    const r = repo(4, 'app');
    runs.turn(9, r, { progress: { ...progress, stage: CHECK_WAITS, elapsed_ms: 0 } });
    const waitStart = runs.of(9)[0].started_at;
    await new Promise((res) => setTimeout(res, 20));
    runs.turn(9, r, { progress: { ...progress, elapsed_ms: 0 } });
    expect(runs.of(9)[0].started_at > waitStart).toBe(true);
  });

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
