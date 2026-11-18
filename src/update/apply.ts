// One update of a git checkout of Dispatch, and its way back (DISP-112).
//
// This file imports nothing of Dispatch, only Node's own modules: the launcher (src/launch.ts)
// loads it fresh for each update, so the steps are those of the version it updates from.
//
// Only a full commit id is ever installed, and only one that is on the release branch of this
// checkout's own `origin`. No address and no ref name from outside is fetched or run.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ApplyRequest {
  /** the commit to install: 40 hex characters */
  sha: string;
  /** the release branch of this machine (its own UPDATE_BRANCH) */
  branch: string;
  role: 'server' | 'worker';
  /** the checkout */
  dir: string;
  /** the commit the process runs now (it may differ from HEAD: a checkout shared with another process) */
  from?: string | null;
  /** UPDATE_INSTALL_COMMAND of this machine: runs in place of `npm ci` and `npm run build` */
  installCommand?: string;
}

export interface ApplyResult {
  ok: boolean;
  from: string | null;
  to: string;
  /** the old version runs again after a failed try */
  rolled_back: boolean;
  error?: string;
  /** the end of what the steps printed */
  log_tail?: string;
}

/** The process that is updated, as the launcher has it. */
export interface ChildControl {
  /** stop it and wait until it is gone (nothing to do when it does not run) */
  stop(): Promise<void>;
  /** start it and wait until it is healthy on `expectSha` (null: any commit); rejects when it is not */
  start(expectSha: string | null): Promise<void>;
}

export interface ApplyOptions {
  /** time limits of the steps, in ms */
  gitMs?: number;
  installMs?: number;
  buildMs?: number;
  /** how long to wait for another update in the same checkout */
  lockWaitMs?: number;
  /** for recoverJournal, which has no request: UPDATE_INSTALL_COMMAND of this machine */
  installCommand?: string;
  /** kept in the journal and given back by recoverJournal: whatever the asker needs to log the result */
  ctx?: unknown;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** Why an update did not start. `ahead`: this process already runs the commit, or the checkout is past it. */
export class Refusal extends Error {
  readonly kind: 'ahead' | 'refused';

  constructor(kind: 'ahead' | 'refused', message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface Verified {
  /** HEAD now */
  head: string;
  /** HEAD is on the release branch (not detached) */
  attached: boolean;
  /** the checkout must move: HEAD is not the commit yet */
  moves: boolean;
}

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[\w./-]+$/;
const TAIL = 4000;

interface Ran { code: number | null; out: string; timedOut: boolean }

/** Run one step in its own process group; at the time limit the whole group is killed. */
function run(cmd: string, args: string[], o: { cwd: string; ms: number; env?: NodeJS.ProcessEnv; shell?: boolean }): Promise<Ran> {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, shell: o.shell ?? false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (d: Buffer) => {
      out = (out + String(d)).slice(-4 * TAIL);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, o.ms);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, out: `${out}${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
}

// git never asks a person, and never reads a pager
const gitEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({ ...env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' });

async function git(dir: string, args: string[], ms = 30_000, env?: NodeJS.ProcessEnv): Promise<Ran> {
  return run('git', args, { cwd: dir, ms, env: gitEnv(env) });
}

async function gitText(dir: string, args: string[]): Promise<string | null> {
  const r = await git(dir, args);
  return r.code === 0 ? r.out.trim() : null;
}

/** Is `dir` the top folder of a git checkout? */
export async function isCheckout(dir: string): Promise<boolean> {
  const top = await gitText(dir, ['rev-parse', '--show-toplevel']);
  try {
    return !!top && realpathSync(top) === realpathSync(dir);
  } catch {
    return false;
  }
}

/**
 * May this checkout go to `req.sha`? Throws a Refusal when not; changes nothing but (with
 * `fetch`) what the checkout knows of its origin.
 *
 * The rules: a full commit id; a clean checkout that is on the release branch or detached; the
 * commit is on the release branch of `origin`; HEAD is the commit or an ancestor of it (no step
 * back). The process that asks fetches (it has the GitHub account); the launcher checks again
 * without the network.
 */
export async function verifyTarget(req: ApplyRequest, opts: { fetch?: boolean; env?: NodeJS.ProcessEnv; gitMs?: number } = {}): Promise<Verified> {
  const refuse = (why: string) => new Refusal('refused', why);
  if (typeof req.sha !== 'string' || !SHA.test(req.sha)) throw refuse('An update needs a full commit id (40 hex characters).');
  if (typeof req.branch !== 'string' || !BRANCH.test(req.branch) || req.branch.startsWith('-') || req.branch.includes('..')) throw refuse('The release branch is not a branch name.');
  if (req.from && req.from === req.sha) throw new Refusal('ahead', 'This version already runs.');
  if (!(await isCheckout(req.dir))) throw refuse(`${req.dir} is not a git checkout.`);
  const changed = await gitText(req.dir, ['status', '--porcelain', '--untracked-files=no']);
  if (changed === null) throw refuse('git status failed in the checkout.');
  if (changed) throw refuse(`The checkout has changed files (${changed.split('\n').slice(0, 3).map((l) => l.trim().replace(/^\S+\s+/, '')).join(', ')}). Commit or undo them first.`);
  const on = await gitText(req.dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (on && on !== req.branch) throw refuse(`The checkout is on branch ${on}, not on the release branch ${req.branch}.`);
  const remote = `refs/remotes/origin/${req.branch}`;
  if (opts.fetch) {
    const f = await git(req.dir, ['fetch', '--quiet', 'origin', `+refs/heads/${req.branch}:${remote}`], opts.gitMs ?? 120_000, opts.env);
    if (f.code !== 0) throw refuse(`git fetch origin ${req.branch} failed: ${f.timedOut ? 'no answer in time' : f.out.trim().split('\n').pop() || 'unknown error'}`);
    // the version tags, for the version shown; an update never needs them
    await git(req.dir, ['fetch', '--quiet', '--tags', 'origin'], opts.gitMs ?? 120_000, opts.env);
  }
  const head = await gitText(req.dir, ['rev-parse', 'HEAD']);
  if (!head || !SHA.test(head)) throw refuse('The checkout has no commit.');
  if ((await git(req.dir, ['cat-file', '-e', `${req.sha}^{commit}`])).code !== 0) throw refuse(`Commit ${req.sha.slice(0, 7)} is not in origin/${req.branch}.`);
  if ((await git(req.dir, ['merge-base', '--is-ancestor', req.sha, remote])).code !== 0) throw refuse(`Commit ${req.sha.slice(0, 7)} is not on the release branch ${req.branch} of origin.`);
  if (head !== req.sha && (await git(req.dir, ['merge-base', '--is-ancestor', head, req.sha])).code !== 0) {
    if ((await git(req.dir, ['merge-base', '--is-ancestor', req.sha, head])).code === 0) throw new Refusal('ahead', `The checkout is already past ${req.sha.slice(0, 7)}.`);
    throw refuse(`The checkout (${head.slice(0, 7)}) has commits that ${req.sha.slice(0, 7)} does not have.`);
  }
  return { head, attached: !!on, moves: head !== req.sha };
}

// ---------- the journal and the lock ----------

/** What a launcher that died in the middle of an update needs to put the old version back. */
interface Journal {
  v: 1;
  /** HEAD before */
  prev: string;
  attached: boolean;
  branch: string;
  /** the commit the process ran */
  from: string | null;
  to: string;
  role: 'server' | 'worker';
  /** this update moves the checkout (false: another process moved it already) */
  moved: boolean;
  /** package-lock.json differs between the two versions */
  lockChanged: boolean;
  ctx?: unknown;
}

async function gitDir(dir: string): Promise<string> {
  const d = await gitText(dir, ['rev-parse', '--absolute-git-dir']);
  if (!d) throw new Error(`${dir} is not a git checkout.`);
  return d;
}

const journalFile = (gd: string) => join(gd, 'dispatch-update.json');
const lockDir = (gd: string) => join(gd, 'dispatch-update.lock');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Take the checkout's update lock: one launcher works in a checkout at a time. A dead holder's lock is taken over. */
async function lock(gd: string, waitMs: number): Promise<boolean> {
  const dir = lockDir(gd);
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), String(process.pid));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let holder = NaN;
    try {
      holder = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    } catch {
      // just made, its pid not written yet: old enough means its maker died in between
      try {
        if (Date.now() - statSync(dir).mtimeMs > 10_000) holder = 0;
      } catch { /* gone again */ }
    }
    if (holder === process.pid || holder === 0 || (Number.isInteger(holder) && holder > 0 && !alive(holder))) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function unlock(gd: string) {
  rmSync(lockDir(gd), { recursive: true, force: true });
}

function writeJournal(gd: string, j: Journal) {
  const tmp = `${journalFile(gd)}.tmp`;
  writeFileSync(tmp, JSON.stringify(j));
  renameSync(tmp, journalFile(gd));
}

function readJournal(gd: string): Journal | null {
  try {
    const j = JSON.parse(readFileSync(journalFile(gd), 'utf8')) as Journal;
    return j && j.v === 1 && SHA.test(j.prev) && SHA.test(j.to) && (j.from === null || typeof j.from === 'string') ? j : null;
  } catch {
    return null;
  }
}

// ---------- the steps ----------

class StepError extends Error {}

interface Steps {
  dir: string;
  opts: ApplyOptions;
  installCommand?: string;
  /** what the steps printed */
  log: string[];
}

function note(s: Steps, line: string) {
  s.log.push(line);
  s.opts.log?.(line);
}

async function step(s: Steps, what: string, cmd: string, args: string[], ms: number, o: { shell?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  note(s, `$ ${what}`);
  const r = await run(cmd, args, { cwd: s.dir, ms, shell: o.shell, env: o.env ?? s.opts.env });
  if (r.out.trim()) s.log.push(r.out.trim());
  if (r.timedOut) throw new StepError(`${what} did not finish in ${Math.round(ms / 1000)} s.`);
  if (r.code !== 0) throw new StepError(`${what} failed${r.code === null ? '' : ` (exit ${r.code})`}: ${r.out.trim().split('\n').slice(-3).join(' | ').slice(-400) || 'no output'}`);
}

/** Put the checkout on `sha`: forward on the release branch, or back on a rollback. */
async function moveTo(s: Steps, sha: string, attached: boolean, back: boolean) {
  const ms = s.opts.gitMs ?? 120_000;
  if (!attached) return step(s, `git checkout --detach ${sha.slice(0, 7)}`, 'git', ['checkout', '--quiet', '--detach', sha], ms, { env: gitEnv(s.opts.env) });
  if (back) return step(s, `git reset --hard ${sha.slice(0, 7)}`, 'git', ['reset', '--quiet', '--hard', sha], ms, { env: gitEnv(s.opts.env) });
  return step(s, `git merge --ff-only ${sha.slice(0, 7)}`, 'git', ['merge', '--quiet', '--ff-only', sha], ms, { env: gitEnv(s.opts.env) });
}

/** The packages and the build of the version the checkout is on now. */
async function install(s: Steps, j: Pick<Journal, 'role' | 'lockChanged' | 'from' | 'to'>, rollback: boolean) {
  if (s.installCommand) {
    const env = { ...(s.opts.env ?? process.env), DISPATCH_UPDATE_ROLE: j.role, DISPATCH_UPDATE_SHA: rollback ? j.from ?? '' : j.to, DISPATCH_UPDATE_ROLLBACK: rollback ? '1' : '' };
    return step(s, 'UPDATE_INSTALL_COMMAND', s.installCommand, [], Math.max(s.opts.installMs ?? 600_000, s.opts.buildMs ?? 600_000), { shell: true, env });
  }
  if (j.lockChanged) {
    // a worker that was installed without the dev packages stays without them; a server needs them to build
    const lean = j.role === 'worker' && !existsSync(join(s.dir, 'node_modules', 'vite'));
    await step(s, lean ? 'npm ci --omit=dev' : 'npm ci', 'npm', ['ci', '--no-audit', '--no-fund', ...(lean ? ['--omit=dev'] : [])], s.opts.installMs ?? 600_000);
  }
  if (j.role === 'server') await step(s, 'npm run build', 'npm', ['run', 'build'], s.opts.buildMs ?? 600_000);
}

const tail = (s: Steps) => s.log.join('\n').slice(-TAIL);

/**
 * The old version back, with the child stopped. A server always goes back to the commit it ran. A
 * worker only moves a checkout back that it moved itself: in a shared checkout the server already
 * runs the new code on a changed database.
 */
async function putBack(s: Steps, j: Journal): Promise<string | null> {
  const old = j.role === 'server' ? j.from ?? j.prev : j.moved ? j.prev : null;
  const head = await gitText(s.dir, ['rev-parse', 'HEAD']);
  if (!old) return head;
  if (head !== old) await moveTo(s, old, j.attached, true);
  await install(s, j, true);
  return old;
}

/**
 * Update the checkout to `req.sha` and restart the child on it. On any failure after the child
 * stopped, the old version is put back and started. Never throws: the result says what happened.
 */
export async function applyUpdate(req: ApplyRequest, child: ChildControl, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const s: Steps = { dir: req.dir, opts, log: [], installCommand: req.installCommand };
  const from = req.from ?? null;
  const refused = (error: string): ApplyResult => ({ ok: false, from, to: req.sha, rolled_back: false, error, log_tail: tail(s) || undefined });
  let gd: string;
  try {
    gd = await gitDir(req.dir);
  } catch (e) {
    return refused((e as Error).message);
  }
  if (!(await lock(gd, opts.lockWaitMs ?? 60_000))) return refused('Another update is running in this checkout.');
  let journal: Journal | null = null;
  try {
    // 1. check again, without the network, with the child still running
    let v: Verified;
    try {
      v = await verifyTarget(req, { fetch: false });
    } catch (e) {
      return refused((e as Error).message);
    }
    const base = from && (await git(req.dir, ['cat-file', '-e', `${from}^{commit}`])).code === 0 ? from : v.head;
    const lockChanged = (await git(req.dir, ['diff', '--quiet', base, req.sha, '--', 'package-lock.json'])).code !== 0;
    // 2. the journal: a launcher that dies after this line finds its way back
    journal = { v: 1, prev: v.head, attached: v.attached, branch: req.branch, from, to: req.sha, role: req.role, moved: v.moves, lockChanged, ctx: opts.ctx };
    writeJournal(gd, journal);
    note(s, `update ${(from ?? v.head).slice(0, 7)} -> ${req.sha.slice(0, 7)} (${req.role})`);
    // nothing in the checkout was changed yet: a failure before that needs no way back but a start
    let touched = false;
    try {
      // 3. stop, 4. change, 5. start and check
      await child.stop();
      touched = true;
      if (v.moves) await moveTo(s, req.sha, v.attached, false);
      await install(s, journal, false);
      await child.start(req.sha);
      rmSync(journalFile(gd), { force: true });
      note(s, `runs ${req.sha.slice(0, 7)}`);
      return { ok: true, from: from ?? v.head, to: req.sha, rolled_back: false, log_tail: tail(s) };
    } catch (e) {
      const error = (e as Error).message;
      note(s, `failed: ${error}`);
      // 6. roll back
      try {
        await child.stop();
        const old = touched ? await putBack(s, journal) : v.head;
        await child.start(journal.role === 'server' || journal.moved ? old : null);
        rmSync(journalFile(gd), { force: true });
        note(s, `back on ${(old ?? 'the old version').slice(0, 7)}`);
        return { ok: false, from: from ?? v.head, to: req.sha, rolled_back: true, error, log_tail: tail(s) };
      } catch (e2) {
        // the journal stays: the next start of the launcher tries the way back again
        note(s, `rollback failed: ${(e2 as Error).message}`);
        return { ok: false, from: from ?? v.head, to: req.sha, rolled_back: false, error: `${error} Then the old version did not come back: ${(e2 as Error).message}`, log_tail: tail(s) };
      }
    }
  } finally {
    unlock(gd);
  }
}

/**
 * At the launcher's start, before the child: an update that was cut off (the launcher was killed,
 * the machine went down) is taken back. Gives the result to report, with the `ctx` of the update.
 */
export async function recoverJournal(dir: string, opts: ApplyOptions = {}): Promise<{ result: ApplyResult; ctx: unknown } | null> {
  if (!(await isCheckout(dir))) return null;
  const gd = await gitDir(dir);
  if (!existsSync(journalFile(gd))) return null;
  // another launcher's update that still runs is not ours to undo
  if (!(await lock(gd, opts.lockWaitMs ?? 60_000))) return null;
  try {
    const j = readJournal(gd);
    if (!j) {
      rmSync(journalFile(gd), { force: true });
      return null;
    }
    const s: Steps = { dir, opts, log: [], installCommand: opts.installCommand };
    note(s, `an update ${(j.from ?? j.prev).slice(0, 7)} -> ${j.to.slice(0, 7)} was cut off: putting the old version back`);
    let error = 'The update was cut off before it was checked. The old version was put back.';
    try {
      const head = await gitText(dir, ['rev-parse', 'HEAD']);
      // only a checkout that is where the update left it (before or after its move) is touched
      if (head === j.to || head === j.prev) await putBack(s, j);
      else note(s, `the checkout is on ${String(head).slice(0, 7)} now: left as it is`);
    } catch (e) {
      error = `The update was cut off, and the old version could not be put back: ${(e as Error).message}`;
      note(s, error);
    }
    rmSync(journalFile(gd), { force: true });
    return { result: { ok: false, from: j.from ?? j.prev, to: j.to, rolled_back: true, error, log_tail: tail(s) }, ctx: j.ctx };
  } finally {
    unlock(gd);
  }
}
