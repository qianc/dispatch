// The check commands running now for local merges (DISP-5): their live progress goes to the
// session's page, and each finished run is kept so the next run of the same command can say how
// long it will take.
import { expectedFrom, type CheckProgress, type CheckRun } from '../shared/checkProgress.ts';
import type { PullRequest, Repo } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import type { Store } from './store.ts';

export class CheckRuns {
  private live = new Map<number, CheckRun>(); // by PR id
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
    if (!repo.check_command) return;
    let run = this.live.get(pr.id);
    if (!run) {
      run = {
        session_id: pr.session_id, pr_id: pr.id, repo: repo.github_name, command: repo.check_command,
        started_at: new Date(Date.now() - p.elapsed_ms).toISOString(), progress: p,
        expected: expectedFrom(this.store.checkHistory(repo.id, repo.check_command)),
      };
      this.live.set(pr.id, run);
    } else run.progress = p;
    this.emit(pr.session_id);
  }

  /** The merge returned: keep how the check went (if it ran), and take the run off the page. */
  finish(pr: PullRequest, repo: Repo, check: { ok: boolean; duration_ms: number; units: number } | undefined) {
    if (check && repo.check_command) this.store.addCheckRun({ repo_id: repo.id, command: repo.check_command, ...check });
    if (this.live.delete(pr.id)) this.emit(pr.session_id);
  }

  private emit(sessionId: number) {
    this.bus.emit({ t: 'check', session_id: sessionId, checks: this.of(sessionId) });
  }
}
