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
    this.update(`pr:${pr.id}`, pr.session_id, pr.id, repo, p);
  }

  /** The merge returned: keep how the check went (if it ran), and take the run off the page. */
  finish(pr: PullRequest, repo: Repo, check: { ok: boolean; duration_ms: number; units: number } | undefined) {
    this.end(`pr:${pr.id}`, pr.session_id, repo, check);
  }

  /** A turn's check (DISP-15): progress while it runs, then how it went (none: it was stopped). */
  turn(sessionId: number, repo: Repo, msg: { progress?: CheckProgress; done?: { ok: boolean; duration_ms: number; units: number } }) {
    const key = `turn:${sessionId}:${repo.id}`;
    if (msg.progress && !msg.done) this.update(key, sessionId, null, repo, msg.progress);
    else this.end(key, sessionId, repo, msg.done);
  }

  private update(key: string, sessionId: number, prId: number | null, repo: Repo, p: CheckProgress) {
    if (!repo.check_command) return;
    let run = this.live.get(key);
    if (!run) {
      run = {
        session_id: sessionId, pr_id: prId, repo: repo.github_name, command: repo.check_command,
        started_at: new Date(Date.now() - p.elapsed_ms).toISOString(), progress: p,
        expected: expectedFrom(this.store.checkHistory(repo.id, repo.check_command)),
      };
      this.live.set(key, run);
    } else run.progress = p;
    this.emit(sessionId);
  }

  private end(key: string, sessionId: number, repo: Repo, check: { ok: boolean; duration_ms: number; units: number } | undefined) {
    if (check && repo.check_command) this.store.addCheckRun({ repo_id: repo.id, command: repo.check_command, ...check });
    if (this.live.delete(key)) this.emit(sessionId);
  }

  private emit(sessionId: number) {
    this.bus.emit({ t: 'check', session_id: sessionId, checks: this.of(sessionId) });
  }
}
