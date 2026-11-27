// The check commands running now for local merges (DISP-5) and for a session's turn before it is
// reported done (DISP-15): their live progress goes to the session's page, and each finished run
// is kept so the next run of the same command can say how long it will take.
import { expectedFrom, type CheckProgress, type CheckRun } from '../shared/checkProgress.ts';
import type { PullRequest, Repo } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import type { Store } from './store.ts';

export class CheckRuns {
  private live = new Map<string, CheckRun>(); // by PR id, or session and repo for a turn's check
  private store: Store;
  private bus: Bus;

  constructor(store: Store, bus: Bus) {
    this.store = store;
    this.bus = bus;
  }

  /** The runs of one session, oldest first. */
  of(sessionId: number): CheckRun[] {
    return [...this.live.values()].filter((r) => r.session_id === sessionId);
  }

  /** A progress report from the worker. The first one starts the run. */
  progress(pr: PullRequest, repo: Repo, p: CheckProgress) {
    if (pr.session_id !== null && repo.check_command) this.update(`pr:${pr.id}`, pr.session_id, pr.id, repo, repo.check_command, p);
  }

  /** The merge returned: keep how the check went (if it ran), and take the run off the page. */
  finish(pr: PullRequest, repo: Repo, check: { ok: boolean; duration_ms: number; units: number } | undefined) {
    if (pr.session_id !== null && repo.check_command) this.end(`pr:${pr.id}`, pr.session_id, repo, repo.check_command, check);
  }

  /** A turn's check (DISP-15): progress while it runs, then how it went (none: it was stopped). Its command is the full or the quick check (DISP-260). */
  turn(sessionId: number, repo: Repo, msg: { command?: string; progress?: CheckProgress; done?: { ok: boolean; duration_ms: number; units: number } }) {
    const key = `turn:${sessionId}:${repo.id}`;
    const command = msg.command ?? repo.check_command;
    if (!command) return;
    if (msg.progress && !msg.done) this.update(key, sessionId, null, repo, command, msg.progress);
    else this.end(key, sessionId, repo, command, msg.done);
  }

  /** The session ended: its turn checks are off the page (the worker's last report may never come, DISP-149). */
  endTurns(sessionId: number) {
    const prefix = `turn:${sessionId}:`;
    let dropped = false;
    for (const key of this.live.keys()) if (key.startsWith(prefix)) dropped = this.live.delete(key) || dropped;
    if (dropped) this.emit(sessionId);
  }

  private update(key: string, sessionId: number, prId: number | null, repo: Repo, command: string, p: CheckProgress) {
    let run = this.live.get(key);
    if (!run) {
      run = {
        session_id: sessionId, pr_id: prId, repo: repo.github_name, command,
        started_at: new Date(Date.now() - p.elapsed_ms).toISOString(), progress: p,
        expected: expectedFrom(this.store.checkHistory(repo.id, command)),
      };
      this.live.set(key, run);
    } else run.progress = p;
    this.emit(sessionId);
  }

  private end(key: string, sessionId: number, repo: Repo, command: string, check: { ok: boolean; duration_ms: number; units: number } | undefined) {
    if (check) this.store.addCheckRun({ repo_id: repo.id, command, ...check });
    if (this.live.delete(key)) this.emit(sessionId);
  }

  private emit(sessionId: number) {
    this.bus.emit({ t: 'check', session_id: sessionId, checks: this.of(sessionId) });
  }
}
