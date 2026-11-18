// The launcher (DISP-112): the real src/launch.ts, update steps and child link, around a small
// server that says what it sees. Version B of the fixture does not start.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launcherLink } from '../src/update/ipc.ts';
import { fixture } from './update-fixture.ts';

const real = (file: string) => readFileSync(join(import.meta.dirname, '..', file), 'utf8');

// the small server: notes its start, is "ready", and does what ../ask.json says
const MAIN = `
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { launcherLink } from '../update/ipc.ts';

const dir = join(import.meta.dirname, '..', '..');
const app = readFileSync(join(dir, 'app.txt'), 'utf8').trim();
const note = (line) => appendFileSync(join(dir, '..', 'runs.txt'), line + '\\n');
const launcher = launcherLink();
note('start ' + app + ' launcher=' + (launcher.available ? 'yes' : 'no: ' + launcher.why) + ' settle=' + (process.env.DISPATCH_SETTLE_MS ?? '') + ' args=' + process.argv.slice(2).join(','));
if (app === 'B') process.exit(1);
let sha = null;
try {
  sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {}
process.on('SIGTERM', () => {
  note('sigterm ' + app);
  process.exit(Number(process.env.EXIT_CODE ?? 0));
});
launcher.onResult((result, ctx) => note('result ' + JSON.stringify({ result, ctx })));
launcher.ready(sha);
const ask = join(dir, '..', 'ask.json');
setInterval(() => {
  if (!existsSync(ask)) return;
  const a = JSON.parse(readFileSync(ask, 'utf8'));
  rmSync(ask);
  if (a.exit !== undefined) process.exit(a.exit);
  launcher.request({ sha: a.sha, from: sha }, a.ctx);
}, 30);
`;

const FILES = { 'src/launch.ts': real('src/launch.ts'), 'src/update/apply.ts': real('src/update/apply.ts'), 'src/update/ipc.ts': real('src/update/ipc.ts'), 'src/server/main.ts': MAIN };

const started: ChildProcess[] = [];
afterEach(() => {
  for (const p of started.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
});

interface Launched { proc: ChildProcess; exit: Promise<number | null>; runs(): string[]; ask(what: object): void; result(): { result: { ok: boolean; rolled_back: boolean; from: string | null; to: string; error?: string }; ctx: unknown } | null }

/** Start the launcher in `dir`. Its child writes ../runs.txt and reads ../ask.json. */
function launch(dir: string, env: Record<string, string> = {}, args: string[] = []): Launched {
  const proc = spawn(process.execPath, ['src/launch.ts', 'server', ...args], {
    cwd: dir,
    env: { ...process.env, UPDATE_BRANCH: 'main', UPDATE_INSTALL_COMMAND: '', UPDATE_READY_SECONDS: '20', UPDATE_SETTLE_SECONDS: '0.3', ...env },
    stdio: 'ignore',
  });
  started.push(proc);
  const runsFile = join(dir, '..', 'runs.txt');
  const runs = () => (existsSync(runsFile) ? readFileSync(runsFile, 'utf8').split('\n').filter(Boolean) : []);
  return {
    proc,
    exit: new Promise((r) => proc.on('exit', (code) => r(code))),
    runs,
    ask: (what) => writeFileSync(join(dir, '..', 'ask.json'), JSON.stringify(what)),
    result: () => {
      const line = runs().findLast((l) => l.startsWith('result '));
      return line ? JSON.parse(line.slice('result '.length)) : null;
    },
  };
}

async function until<T>(what: () => T | null | undefined | false, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = what();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}

const starts = (l: Launched) => l.runs().filter((r) => r.startsWith('start ')).map((r) => r.split(' ').slice(1, 4).join(' '));

test('outside an update the launcher is its child: signals go on, and it ends with the child\'s code', async () => {
  const f = fixture(FILES);
  const l = launch(f.dir, { EXIT_CODE: '7' }, ['--flag']);
  await until(() => l.runs().length);
  expect(l.runs()[0]).toBe('start A launcher=yes settle= args=--flag');
  l.proc.kill('SIGTERM');
  expect(await l.exit).toBe(7);
  expect(l.runs()).toContain('sigterm A');

  // a child that ends by itself: the same code, so the service manager's restart rule holds
  const l2 = launch(f.dir);
  await until(() => l2.runs().length > 2);
  l2.ask({ exit: 3 });
  expect(await l2.exit).toBe(3);
}, 60_000);

test('an update request brings up the new version, and it gets the result', async () => {
  const f = fixture(FILES);
  const l = launch(f.dir);
  await until(() => l.runs().length);
  l.ask({ sha: f.c, ctx: { update_id: 5 } });
  const r = await until(() => l.result());
  expect(r.result).toMatchObject({ ok: true, rolled_back: false, from: f.a, to: f.c });
  expect(r.ctx).toEqual({ update_id: 5 });
  expect(f.head()).toBe(f.c);
  expect(f.read('built.txt')).toBe('C');
  // the new version starts with the time in which its server takes no worker yet
  expect(starts(l)).toEqual(['A launcher=yes settle=', 'C launcher=yes settle=2300']);
  expect(l.runs().filter((x) => x === 'sigterm A')).toHaveLength(1);
  // the launcher goes on as before
  l.proc.kill('SIGTERM');
  expect(await l.exit).toBe(0);
  expect(l.runs()).toContain('sigterm C');
}, 90_000);

test('a version that does not start is taken back, and the old one says so', async () => {
  const f = fixture(FILES);
  const l = launch(f.dir);
  await until(() => l.runs().length);
  l.ask({ sha: f.b, ctx: 'row 9' });
  const r = await until(() => l.result());
  expect(r.result).toMatchObject({ ok: false, rolled_back: true, from: f.a, to: f.b });
  expect(r.result.error).toMatch(/stopped before it was ready \(exit 1\)/);
  expect(r.ctx).toBe('row 9');
  expect(f.head()).toBe(f.a);
  expect(f.read('built.txt')).toBe('A');
  expect(starts(l)).toEqual(['A launcher=yes settle=', 'B launcher=yes settle=2300', 'A launcher=yes settle=']);
  // an update to a ref that is no commit of the branch: refused, and the child was never stopped
  l.ask({ sha: 'https://example.com/x.git', ctx: 2 });
  const r2 = await until(() => (l.result()?.ctx === 2 ? l.result() : null));
  expect(r2.result).toMatchObject({ ok: false, rolled_back: false });
  expect(starts(l)).toHaveLength(3);
  expect(l.runs().filter((x) => x === 'sigterm A')).toHaveLength(1);
}, 90_000);

test('a launcher that was killed in an update takes it back at its next start', async () => {
  const f = fixture(FILES);
  // the install step hangs (not on the way back)
  const env = { UPDATE_INSTALL_COMMAND: '[ -n "$DISPATCH_UPDATE_ROLLBACK" ] || sleep 4' };
  const l = launch(f.dir, env);
  await until(() => l.runs().length);
  l.ask({ sha: f.c, ctx: { update_id: 3 } });
  await until(() => f.head() === f.c);
  l.proc.kill('SIGKILL');
  await l.exit;

  const l2 = launch(f.dir, env);
  const r = await until(() => l2.result());
  expect(r.result).toMatchObject({ ok: false, rolled_back: true, from: f.a, to: f.c });
  expect(r.result.error).toMatch(/cut off/);
  expect(r.ctx).toEqual({ update_id: 3 });
  expect(f.head()).toBe(f.a);
  expect(starts(l2)).toEqual(['A launcher=yes settle=', 'A launcher=yes settle=']);
}, 90_000);

test('code that is no checkout runs through the launcher, and says why it cannot update', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'dsp-launch-')), 'app');
  for (const [name, text] of Object.entries({ ...FILES, 'app.txt': 'A', 'package.json': '{"type":"module"}' })) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const l = launch(dir);
  await until(() => l.runs().length);
  expect(l.runs()[0]).toBe('start A launcher=no: The code is not a git checkout, so it cannot update itself. settle= args=');
  l.proc.kill('SIGTERM');
  expect(await l.exit).toBe(0);
}, 60_000);

test('the child\'s link: available only under a launcher that can update', () => {
  const proc = (env: Record<string, string>, send = true) => {
    const sent: unknown[] = [], on: Record<string, (m?: unknown) => void> = {}, killed: unknown[] = [];
    return { sent, on, killed, p: { env, pid: 42, on: ((ev: string, fn: (m?: unknown) => void) => void (on[ev] = fn)) as never, kill: (pid: number, sig: string) => killed.push([pid, sig]), ...(send ? { send: (m: unknown) => sent.push(m) } : {}) } };
  };
  // started by hand
  const plain = proc({}, false);
  const a = launcherLink(plain.p);
  expect(a).toMatchObject({ available: false, why: 'It was not started through the launcher (node src/launch.ts server|worker).' });
  a.ready('x');
  a.request({ sha: 'x', from: null });
  expect(plain.sent).toEqual([]);
  // a child of something else with a channel (a test runner): the same
  expect(launcherLink(proc({}).p).available).toBe(false);
  // under the launcher, no checkout
  expect(launcherLink(proc({ DISPATCH_LAUNCHER: 'no: No git here.' }).p)).toMatchObject({ available: false, why: 'No git here.' });

  const ok = proc({ DISPATCH_LAUNCHER: '1' });
  const link = launcherLink(ok.p);
  expect(link).toMatchObject({ available: true, why: null });
  link.ready('abc');
  link.request({ sha: 'def', from: 'abc' }, { update_id: 1 });
  expect(ok.sent).toEqual([{ t: 'ready', sha: 'abc' }, { t: 'update', req: { sha: 'def', from: 'abc' }, ctx: { update_id: 1 } }]);
  const got: unknown[] = [];
  link.onResult((result, ctx) => got.push([result.ok, ctx]));
  ok.on.message({ t: 'other' });
  ok.on.message({ t: 'result', result: { ok: true, from: 'abc', to: 'def', rolled_back: false }, ctx: 4 });
  expect(got).toEqual([[true, 4]]);
  // the launcher is gone: the child stops as on a signal
  ok.on.disconnect();
  expect(ok.killed).toEqual([[42, 'SIGTERM']]);
});
