// DISP-15: before a work session's turn is reported done, run each changed repo's check command in
// its worktree. A failure goes back to the agent as a new turn, until it passes or the retry limit.
import type { CheckProgress } from '../shared/checkProgress.ts';
import type { WorkerToServer } from '../shared/protocol.ts';
import type { Repo } from '../shared/types.ts';

export interface CheckOutcome {
  code: number;
  out: string;
  timed_out: boolean;
  duration_ms: number;
  progress: CheckProgress;
}

export interface TurnCheckDeps {
  sessionId: number;
  /** the session's repos that have a check command */
  repos: Repo[];
  /** fix turns after a failed check before the owner is told instead */
  retries: number;
  /** the worktree's state (HEAD and changes), or null when it has nothing to check */
  state(repo: Repo): Promise<string | null>;
  check(repo: Repo, onProgress: (p: CheckProgress) => void, signal: AbortSignal): Promise<CheckOutcome>;
  send(msg: WorkerToServer): void;
  timeoutMin: number;
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

export class TurnCheck {
  private d: TurnCheckDeps;
  /** per repo: the worktree state the check last ran on, and how it went (an unchanged worktree is not checked again) */
  private checked = new Map<number, { state: string; ok: boolean; told?: boolean }>();
  private fixes = 0;
  private ctrl: AbortController | null = null;

  constructor(deps: TurnCheckDeps) {
    this.d = deps;
  }

  /** The owner wrote: a new request, so the fix turns count from zero again. A running check stops. */
  ownerTurn() {
    this.fixes = 0;
    this.cancel();
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
    const failed: { repo: Repo; why: string; out: string }[] = [];
    /** failed before and unchanged since: Claude ended its turn without a fix */
    const unfixed: Repo[] = [];
    try {
      for (const repo of this.d.repos) {
        if (ctrl.signal.aborted) return null;
        const before = await this.d.state(repo).catch(() => null);
        if (before === null) continue;
        const last = this.checked.get(repo.id);
        if (last?.state === before) {
          if (!last.ok && !last.told) unfixed.push(repo);
          continue;
        }
        const cmd = repo.check_command!;
        this.event('system', `Running the check of ${repo.github_name} before the turn is reported done: ${cmd}`);
        const send = (extra: { progress?: CheckProgress; done?: { ok: boolean; duration_ms: number; units: number } }) =>
          this.d.send({ t: 'session_check', session_id: this.d.sessionId, repo_id: repo.id, ...extra });
        const r = await this.d.check(repo, (progress) => send({ progress }), ctrl.signal);
        if (ctrl.signal.aborted) {
          send({});
          this.event('system', `Check of ${repo.github_name} stopped.`);
          return null;
        }
        const ok = r.code === 0;
        send({ done: { ok, duration_ms: r.duration_ms, units: r.progress.units } });
        // the state after the run: files the check itself writes are no change of the agent's
        this.checked.set(repo.id, { state: (await this.d.state(repo).catch(() => null)) ?? before, ok });
        if (ok) this.event('system', `Check passed in ${repo.github_name} (${cmd}, ${duration(r.duration_ms)}).`);
        else failed.push({ repo, why: r.timed_out ? `stopped after ${this.d.timeoutMin} minutes (CHECK_TIMEOUT_MIN on the worker)` : `failed (exit code ${r.code})`, out: r.out.slice(-MAX_OUTPUT) });
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
        body: `${failed.map((f) => `${f.repo.github_name}: \`${f.repo.check_command}\` ${f.why}`).join('\n')}\nClaude had ${tries}${this.d.retries ? '' : ' (CHECK_RETRIES is 0)'}. It waits for you.`,
      });
      return null;
    }
    this.fixes++;
    const attempt = `fix turn ${this.fixes} of ${this.d.retries}`;
    for (const f of failed) this.event('error', `Check ${f.why} in ${f.repo.github_name} (${f.repo.check_command}). Sent back to Claude (${attempt}).\n${f.out.slice(-1500)}`);
    return [
      `(From Dispatch, not the owner:) the repo's check command failed after your turn, so the work is not reported done yet (${attempt}).`,
      ...failed.map((f) => `\n${f.repo.github_name}: \`${f.repo.check_command}\` ${f.why}. The end of its output:\n\n\`\`\`\n${f.out}\n\`\`\``),
      '',
      'Fix the cause, commit, and end your turn: Dispatch runs the check again. If the failure is not caused by this batch, or you stopped to wait for the owner, say so in one or two sentences and end your turn without changes.',
    ].join('\n');
  }
}
