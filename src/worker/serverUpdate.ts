// A server that runs as an image has no checkout to move (DISP-112). A worker updates it, with a
// command from the worker's own config (`server_update_command` of that server's entry). The server
// names only the commit; what runs is the owner's command, on the owner's machine.
//
// The command gets the commit in DISPATCH_UPDATE_SHA, the commit from before in
// DISPATCH_UPDATE_PREV and the release branch in DISPATCH_UPDATE_BRANCH. The update holds when the
// command ends well and the server then says it runs that commit. When not, the same command runs
// again with the commit from before in DISPATCH_UPDATE_SHA, and DISPATCH_UPDATE_ROLLBACK=1.
import { SHA_RE, sameVersion } from '../update/version.ts';
import { runCheck } from './workspace.ts';

export interface CommandRun { code: number | null; out: string; timed_out: boolean }
export type RunCommand = (command: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<CommandRun>;

/** Run a shell command in its own process group; at the time limit the whole group is killed. */
export const runShell: RunCommand = async (command, env, timeoutMs) => {
  const r = await runCheck(command, process.cwd(), timeoutMs, undefined, undefined, env);
  return { code: r.code, out: r.out, timed_out: r.timed_out };
};

export interface ServerUpdateOptions {
  /** the release branch, as the command gets it */
  branch: string;
  /** how long one run of the command may take */
  timeoutMs: number;
  /** how long the server may take, after the command, to say it runs the commit */
  healthMs: number;
  pollMs?: number;
  /**
   * Is the commit one of the release branch? Throws with the reason when not. Only a worker that
   * runs from a checkout of Dispatch can look; without it the command gets the commit as it came.
   * `abbrev`: the commit to go back to, which may be the start of a commit id.
   */
  verify?: (sha: string, abbrev?: boolean) => Promise<void>;
  run?: RunCommand;
  env?: NodeJS.ProcessEnv;
}

export interface ServerUpdateRequest {
  command: string;
  sha: string;
  /** the commit the server runs now: what to go back to */
  prev: string | null;
  /** the commit the server says it runs, on the link as it is now (null: not connected) */
  serverVersion: () => string | null;
}

export interface ServerUpdateResult { ok: boolean; rolled_back: boolean; error?: string; log_tail?: string }

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : 'unknown');
const mins = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} minute${Math.round(ms / 60_000) > 1 ? 's' : ''}`;

export async function runServerUpdate(req: ServerUpdateRequest, o: ServerUpdateOptions): Promise<ServerUpdateResult> {
  const run = o.run ?? runShell;
  const fail = (error: string, more: Partial<ServerUpdateResult> = {}): ServerUpdateResult => ({ ok: false, rolled_back: false, error, ...more });
  // only a full commit id is ever given to the command
  if (typeof req.sha !== 'string' || !SHA_RE.test(req.sha)) return fail('An update needs a full commit id (40 hex characters).');
  const prev = typeof req.prev === 'string' && /^[0-9a-f]{7,40}$/.test(req.prev) ? req.prev : null;
  if (sameVersion(req.sha, req.serverVersion())) return { ok: true, rolled_back: false };
  try {
    await o.verify?.(req.sha);
  } catch (e) {
    return fail((e as Error).message);
  }
  const log: string[] = [];
  const once = async (sha: string, rollback: boolean): Promise<string | null> => {
    const r = await run(req.command, {
      ...(o.env ?? process.env), DISPATCH_UPDATE_SHA: sha, DISPATCH_UPDATE_PREV: rollback ? req.sha : prev ?? '', DISPATCH_UPDATE_BRANCH: o.branch,
      ...(rollback ? { DISPATCH_UPDATE_ROLLBACK: '1' } : {}),
    }, o.timeoutMs);
    log.push(`$ ${rollback ? 'DISPATCH_UPDATE_ROLLBACK=1 ' : ''}DISPATCH_UPDATE_SHA=${sha} ${req.command}\n${r.out.trim()}`);
    if (r.timed_out) return `did not end within ${mins(o.timeoutMs)}`;
    if (r.code !== 0) return `failed (exit ${r.code ?? 'unknown'})`;
    return null;
  };
  /** Wait until the server says it runs `sha`. */
  const runs = async (sha: string): Promise<boolean> => {
    const end = Date.now() + o.healthMs;
    for (;;) {
      if (sameVersion(req.serverVersion(), sha)) return true;
      if (Date.now() >= end) return false;
      await new Promise((r) => setTimeout(r, o.pollMs ?? 2000));
    }
  };
  const tail = () => log.join('\n\n').slice(-4000);

  const bad = await once(req.sha, false);
  let why: string;
  if (bad) why = `The update command ${bad}.`;
  else if (await runs(req.sha)) return { ok: true, rolled_back: false, log_tail: tail() };
  else {
    const now = req.serverVersion();
    why = `The update command ended well, but the server did not come back on ${short(req.sha)} within ${mins(o.healthMs)} (${now ? `it runs ${short(now)}` : 'it is not connected'}).`;
  }
  if (!prev) return fail(`${why} The server did not say which commit it ran before, so nothing was put back.`, { log_tail: tail() });
  // the way back is also only to a commit of the release branch
  try {
    await o.verify?.(prev, true);
  } catch (e) {
    return fail(`${why} Nothing was put back: ${(e as Error).message}`, { log_tail: tail() });
  }
  const badBack = await once(prev, true);
  if (badBack) return fail(`${why} The command for the way back to ${short(prev)} ${badBack}.`, { log_tail: tail() });
  if (!(await runs(prev))) return fail(`${why} The command ran again for ${short(prev)}, but the server did not come back on it.`, { log_tail: tail() });
  return fail(`${why} The server runs ${short(prev)} again.`, { rolled_back: true, log_tail: tail() });
}
