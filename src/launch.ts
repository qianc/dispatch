// The launcher (DISP-112): `node src/launch.ts server|worker` starts the server or the worker as a
// child and stays alive, so something is there to see that a new version does not start, and to
// put the old one back.
//
// Outside an update it is a pass-through: signals go on to the child, and it ends with the
// child's exit code, so the restart rule of systemd or Docker works as before.
//
// It imports only Node's own modules. The update steps (src/update/apply.ts) are loaded fresh for
// each update: the launcher keeps running old code, the steps are those on disk. Its own part
// here changes at the next restart of the service. The three messages (`ready`, `update`,
// `result`, see src/update/ipc.ts) stay as they are for that reason.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const role = process.argv[2];
if (role !== 'server' && role !== 'worker') {
  console.error('usage: node src/launch.ts server|worker');
  process.exit(2);
}
const dir = resolve(import.meta.dirname, '..');
const env = process.env;
const seconds = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d) * 1000;
/** how long a started child has to say `ready` */
const READY_MS = seconds(env.UPDATE_READY_SECONDS, 90);
/** how long it must stay alive after that to count as healthy */
const SETTLE_MS = seconds(env.UPDATE_SETTLE_SECONDS, 10);
/** how long a child gets to stop before it is killed */
const STOP_MS = 20_000;

const log = (line: string) => console.log(`[launcher] ${line}`);

/** Why this folder cannot be updated, or null: it is the top of a git checkout. */
function notCheckout(): string | null {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    if (realpathSync(top) === realpathSync(dir)) return null;
  } catch { /* no git, or no repo */ }
  return 'The code is not a git checkout, so it cannot update itself.';
}
const why = notCheckout();

interface Result { ok: boolean; from: string | null; to: string; rolled_back: boolean; error?: string; log_tail?: string }
interface Apply {
  applyUpdate(req: object, child: { stop(clean?: boolean): Promise<void>; start(expectSha: string | null): Promise<void> }, opts: object): Promise<Result>;
  recoverJournal(dir: string, opts: object): Promise<{ result: Result; ctx: unknown; retry?: boolean } | null>;
}
const loadApply = () => import(`${pathToFileURL(join(dir, 'src', 'update', 'apply.ts')).href}?t=${Date.now()}`) as Promise<Apply>;

let child: ChildProcess | null = null;
let updating = false;
/** a signal to stop came: in an update it is kept until the update is over */
let stopSignal: NodeJS.Signals | null = null;
/** a result the child has not been told yet (it gets it after its `ready`) */
let pending: { result: Result; ctx: unknown } | null = null;
let onReady: ((sha: string | null) => void) | null = null;

function tell(c: ChildProcess, what: { result: Result; ctx: unknown }) {
  if (c.connected) c.send({ t: 'result', result: what.result, ctx: what.ctx });
}

function start(extra: Record<string, string> = {}): ChildProcess {
  const c = spawn(process.execPath, [...process.execArgv, join(dir, 'src', role, 'main.ts'), ...process.argv.slice(3)], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...env, DISPATCH_LAUNCHER: why ? `no: ${why}` : '1', ...extra },
  });
  child = c;
  c.on('message', (m: { t?: string; sha?: unknown; req?: { sha?: unknown; from?: unknown }; ctx?: unknown }) => {
    if (child !== c || !m || typeof m !== 'object') return;
    if (m.t === 'ready') {
      onReady?.(typeof m.sha === 'string' ? m.sha : null);
      if (pending && !updating) {
        tell(c, pending);
        pending = null;
      }
    } else if (m.t === 'update') {
      void update(c, m.req ?? {}, m.ctx);
    }
  });
  c.on('exit', (code, signal) => {
    if (child !== c) return;
    child = null;
    // outside an update the launcher is its child: the same end
    if (!updating) process.exit(code ?? (stopSignal ? 0 : 1));
  });
  return c;
}

/** The child as the update steps use it. */
function control(target: string) {
  return {
    /** `clean`: it must end by itself, with exit code 0 (a server that closed its database and kept its copy). */
    async stop(clean = false) {
      const c = child;
      if (!c) return;
      const gone = new Promise<string | null>((r) => c.once('exit', (code, signal) => r(code === 0 ? null : signal ?? `exit ${code}`)));
      c.kill('SIGTERM');
      const kill = setTimeout(() => c.kill('SIGKILL'), STOP_MS);
      const bad = await gone;
      clearTimeout(kill);
      if (clean && bad) throw new Error(`The ${role} did not stop cleanly (${bad}), so nothing was changed.`);
    },
    /** Healthy: `ready` with the expected commit in time, and still alive a while after. */
    start(expectSha: string | null) {
      // the new version's server takes no worker until it is known to hold
      const c = start(expectSha === target ? { DISPATCH_SETTLE_MS: String(SETTLE_MS + 2000) } : {});
      return new Promise<void>((done, fail) => {
        let settle: NodeJS.Timeout | null = null;
        const end = (e?: Error) => {
          clearTimeout(limit);
          if (settle) clearTimeout(settle);
          onReady = null;
          c.off('exit', onExit);
          if (e) fail(e);
          else done();
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          // the service is stopping, and the signal went to the child too (Ctrl-C, or systemd
          // without KillMode=mixed): this end says nothing about the version
          if (stopSignal) return end(Object.assign(new Error(`The service was stopped (${stopSignal}) before the ${role} was checked.`), { stopped: true }));
          end(new Error(`The ${role} stopped ${settle ? 'soon after its start' : 'before it was ready'} (${signal ?? `exit ${code}`}).`));
        };
        const limit = setTimeout(() => end(new Error(`The ${role} was not ready after ${Math.round(READY_MS / 1000)} s.`)), READY_MS);
        c.once('exit', onExit);
        onReady = (sha) => {
          onReady = null;
          clearTimeout(limit);
          if (expectSha && sha !== expectSha) return end(new Error(`The ${role} runs ${sha ? sha.slice(0, 7) : 'an unknown commit'}, not ${expectSha.slice(0, 7)}.`));
          settle = setTimeout(() => end(), SETTLE_MS);
        };
      });
    },
  };
}

/**
 * The child asks for an update. Only the commit comes from it; the branch, the folder and the
 * install command are this machine's own.
 */
async function update(asker: ChildProcess, req: { sha?: unknown; from?: unknown }, ctx: unknown) {
  const sha = String(req.sha ?? ''), from = typeof req.from === 'string' ? req.from : null;
  const refused = (error: string): Result => ({ ok: false, from, to: sha, rolled_back: false, error });
  if (updating) return tell(asker, { result: refused('An update is already running.'), ctx });
  if (why) return tell(asker, { result: refused(why), ctx });
  updating = true;
  let result: Result;
  try {
    const apply = await loadApply();
    result = await apply.applyUpdate(
      { sha, from, branch: env.UPDATE_BRANCH?.trim() || 'main', role, dir, installCommand: env.UPDATE_INSTALL_COMMAND || undefined },
      control(sha),
      { ctx, log: (l: string) => log(l) },
    );
  } catch (e) {
    result = refused(`The update steps failed: ${(e as Error).message}`);
  }
  updating = false;
  if (!child) {
    console.error(`[launcher] no version of the ${role} runs after the update: ${result.error ?? 'unknown error'}`);
    process.exit(stopSignal ? 0 : 1);
  }
  if (stopSignal) return void child.kill(stopSignal);
  tell(child, { result, ctx });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopSignal = sig;
    // in an update the steps go on to their end, then the child is stopped (or the service
    // manager kills us first, and the journal takes the update back at the next start)
    if (updating) return;
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

// an update that was cut off is taken back before anything starts
if (!why) {
  try {
    const back = await (await loadApply()).recoverJournal(dir, { installCommand: env.UPDATE_INSTALL_COMMAND || undefined, log: (l: string) => log(l) });
    // the way back failed: the service manager starts the launcher again, and it tries once more
    if (back?.retry) {
      console.error(`[launcher] ${back.result.error}`);
      process.exit(1);
    }
    pending = back;
  } catch (e) {
    console.error(`[launcher] could not look for a cut-off update: ${(e as Error).message}`);
  }
}
start();
