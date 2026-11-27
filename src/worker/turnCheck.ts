// DISP-15: before a work session's turn is reported done, run each changed repo's check command in
// its worktree. A failure goes back to the agent as a new turn, until it passes or the retry limit.
import type { CheckProgress } from '../shared/checkProgress.ts';
import type { WorkerToServer } from '../shared/protocol.ts';
import type { CheckLevel, Repo, RunOptions } from '../shared/types.ts';

export interface CheckOutcome {
  code: number;
  out: string;
  timed_out: boolean;
  duration_ms: number;
  progress: CheckProgress;
  /** the tree of the files the check ran on (DISP-260), when known */
  tree?: string | null;
  /** not run: the same command already passed on exactly this tree */
  reused?: boolean;
}

/** A repo's check at a turn's end: which level, and its command. */
export interface TurnCheckRepo {
  repo: Repo;
  level: Exclude<CheckLevel, 'none'>;
  command: string;
}

/**
 * DISP-260: the one place that decides which check a turn's end runs in a repo. A batch's
 * `check_level` chooses it (DISP-262): full falls back to the quick check, quick to none, when the
 * repo has no such command. Unset: the full check only where nothing else runs it: GitHub CI runs it
 * on a GitHub repo's PR (a merge in Dispatch runs it too, unless CI passed on that tree). Elsewhere
 * the quick check, if the repo has one.
 */
export function turnCheckLevel(repo: Repo, options: Pick<RunOptions, 'turn_check' | 'check_level'>): CheckLevel {
  const chosen = options.turn_check ? options.check_level : 'none';
  if (chosen === 'none') return 'none';
  if (chosen === 'full' && repo.check_command) return 'full';
  if (chosen) return repo.quick_check_command ? 'quick' : 'none';
  const ci = !!repo.ci && !repo.local_path && repo.kind !== 'hosted';
  if (repo.check_command && !ci) return 'full';
  return repo.quick_check_command ? 'quick' : 'none';
}

/** The session's repos that get a check at a turn's end, with its level and command. */
export function turnChecks(repos: Repo[], options: Pick<RunOptions, 'turn_check' | 'check_level'>): TurnCheckRepo[] {
  return repos.flatMap((repo) => {
    const level = turnCheckLevel(repo, options);
    const command = level === 'full' ? repo.check_command : level === 'quick' ? repo.quick_check_command : null;
    return level !== 'none' && command ? [{ repo, level, command }] : [];
  });
}

export interface TurnCheckDeps {
  sessionId: number;
  /** the session's repos that get a check, from turnChecks */
  repos: TurnCheckRepo[];
  /** fix turns after a failed check before the owner is told instead */
  retries: number;
  /** the worktree's state (HEAD and changes), or null when it has nothing to check */
  state(repo: Repo): Promise<string | null>;
  check(repo: Repo, command: string, onProgress: (p: CheckProgress) => void, signal: AbortSignal): Promise<CheckOutcome>;
  send(msg: WorkerToServer): void;
  timeoutMin: number;
}

/**
 * The repo whose full or quick check a Bash command of the agent runs (DISP-260): the command
 * alone, or after a `cd`. shortcut: a command piped or chained with others is not counted (its exit
 * code may not be the check's), nor one several repos share; match more forms if agents miss it often.
 */
export function agentCheck(repos: Repo[], bash: string): { repo: Repo; command: string } | null {
  const cmd = bash.trim().replace(/^cd\s+\S+\s*&&\s*/, '').replace(/\s*2>&1$/, '').trim();
  const hits = repos.flatMap((repo) => [repo.check_command, repo.quick_check_command].flatMap((c) => (c && c.trim() === cmd ? [{ repo, command: c }] : [])));
  return hits.length === 1 ? hits[0] : null;
}

const MAX_OUTPUT = 4000;

/** How many fix turns a failed check gets: CHECK_RETRIES on the worker, 3 by default. */
export function checkRetries() {
  const n = Number(process.env.CHECK_RETRIES);
  return Number.isInteger(n) && n >= 0 ? n : 3;
}

export function duration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export class TurnCheck {
  private d: TurnCheckDeps;
  /** per repo: the worktree state the check last ran on, and how it went (an unchanged worktree is not checked again) */
  private checked = new Map<number, { state: string; command: string; ok: boolean; told?: boolean }>();
  private fixes = 0;
  private ctrl: AbortController | null = null;

  constructor(deps: TurnCheckDeps) {
    this.d = deps;
  }

  /** The repos and levels from the session's newest options (DISP-262): a change applies from the next turn. */
  use(repos: TurnCheckRepo[]) {
    this.d = { ...this.d, repos };
  }

  /** The owner wrote: a new request, so the fix turns count from zero again. A running check stops. */
  ownerTurn() {
    this.fixes = 0;
    this.cancel();
  }

  /** a check runs now */
  get running() {
    return this.ctrl !== null;
  }

  /** Stop a running check (the owner stopped the session); the turn is then reported as it is. */
  cancel() {
    this.ctrl?.abort();
  }

  private event(kind: 'system' | 'error', text: string) {
    this.d.send({ t: 'event', session_id: this.d.sessionId, body: { kind, text } });
  }

  /**
   * Run at the end of a turn. Returns the message for a fix turn, or null when the turn may be
   * reported done: the checks passed, there was nothing to check, it was stopped, or the retry
   * limit is reached (then the owner is told).
   */
  async gate(): Promise<string | null> {
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const failed: { repo: Repo; command: string; why: string; out: string }[] = [];
    /** failed before and unchanged since: Claude ended its turn without a fix */
    const unfixed: Repo[] = [];
    try {
      for (const { repo, level, command: cmd } of this.d.repos) {
        if (ctrl.signal.aborted) return null;
        const before = await this.d.state(repo).catch(() => null);
        if (before === null) continue;
        const last = this.checked.get(repo.id);
        if (last?.state === before && last.command === cmd) {
          if (!last.ok && !last.told) unfixed.push(repo);
          continue;
        }
        const name = `${level} check`;
        this.event('system', `Running the ${name} of ${repo.github_name} before the turn is reported done: ${cmd}`);
        const send = (extra: { progress?: CheckProgress; done?: { ok: boolean; duration_ms: number; units: number } }) =>
          this.d.send({ t: 'session_check', session_id: this.d.sessionId, repo_id: repo.id, command: cmd, ...extra });
        const r = await this.d.check(repo, cmd, (progress) => send({ progress }), ctrl.signal);
        const tree = r.tree ? `, tree ${r.tree.slice(0, 7)}` : '';
        if (r.reused) {
          this.checked.set(repo.id, { state: before, command: cmd, ok: true });
          this.event('system', `${cap(name)} of ${repo.github_name} not run again: it already passed on exactly this tree (${cmd}${tree}).`);
          continue;
        }
        if (ctrl.signal.aborted) {
          send({});
          this.event('system', `Check of ${repo.github_name} stopped.`);
          return null;
        }
        const ok = r.code === 0;
        send({ done: { ok, duration_ms: r.duration_ms, units: r.progress.units } });
        // the state after the run: files the check itself writes are no change of the agent's
        this.checked.set(repo.id, { state: (await this.d.state(repo).catch(() => null)) ?? before, command: cmd, ok });
        if (ok) this.event('system', `${cap(name)} passed in ${repo.github_name} (${cmd}${tree}, ${duration(r.duration_ms)}).`);
        else failed.push({ repo, command: cmd, why: r.timed_out ? `stopped after ${this.d.timeoutMin} minutes (CHECK_TIMEOUT_MIN on the worker)` : `failed (exit code ${r.code})`, out: r.out.slice(-MAX_OUTPUT) });
      }
    } finally {
      if (this.ctrl === ctrl) this.ctrl = null;
    }
    if (unfixed.length && !failed.length) {
      for (const r of unfixed) this.checked.get(r.id)!.told = true;
      this.d.send({
        t: 'notice', session_id: this.d.sessionId,
        title: `Check fails in ${unfixed.map((r) => r.github_name).join(', ')}`,
        body: 'Claude ended its turn without changes after the failed check (its last message says why). It waits for you.',
      });
      return null;
    }
    if (!failed.length) {
      this.fixes = 0;
      return null;
    }
    const names = failed.map((f) => f.repo.github_name).join(', ');
    if (this.fixes >= this.d.retries) {
      for (const f of failed) this.checked.get(f.repo.id)!.told = true;
      const tries = `${this.fixes} fix turn${this.fixes === 1 ? '' : 's'}`;
      this.d.send({
        t: 'notice', session_id: this.d.sessionId,
        title: `Check still fails in ${names}`,
        body: `${failed.map((f) => `${f.repo.github_name}: \`${f.command}\` ${f.why}`).join('\n')}\nClaude had ${tries}${this.d.retries ? '' : ' (CHECK_RETRIES is 0)'}. It waits for you.`,
      });
      return null;
    }
    this.fixes++;
    const attempt = `fix turn ${this.fixes} of ${this.d.retries}`;
    for (const f of failed) this.event('error', `Check ${f.why} in ${f.repo.github_name} (${f.command}). Sent back to Claude (${attempt}).\n${f.out.slice(-1500)}`);
    return [
      `(From Dispatch, not the owner:) the repo's check command failed after your turn, so the work is not reported done yet (${attempt}).`,
      ...failed.map((f) => `\n${f.repo.github_name}: \`${f.command}\` ${f.why}. The end of its output:\n\n\`\`\`\n${f.out}\n\`\`\``),
      '',
      'Fix the cause, commit, and end your turn: Dispatch runs the check again. If the failure is not caused by this batch, or you stopped to wait for the owner, say so in one or two sentences and end your turn without changes.',
    ].join('\n');
  }
}
