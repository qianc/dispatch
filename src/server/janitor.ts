// Tidies what finished sessions leave on disk: worktrees, and their branches once merged.
// When a session finishes it is tidied at once; an hourly check (and the inbox) finds what is
// left later (a branch merged afterwards, chats unused for a week) and offers to clean it up.
import { CHAT_KINDS, FINAL_STATUSES, type Session } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import type { GitHub } from './github.ts';
import { expireOAuthClients } from './oauth.ts';
import type { Store } from './store.ts';
import type { WorkerHub } from './workerHub.ts';
import type { Leftover, TidyResult } from '../worker/workspace.ts';

const DAY = 24 * 3600_000;

export interface CleanupOffer {
  sessions: { id: number; title: string; project_key: string | null; worktrees: number; branches: number; checked_out?: { repo: string; path: string }[] }[];
  worktrees: number;
  branches: number;
  /** merged branches checked out in a worktree outside their session folder: reported, not deleted (DISP-62) */
  checked_out?: number;
  checked_at: string;
}

export class Janitor {
  private store: Store;
  private hub: WorkerHub;
  private github: GitHub;
  private bus: Bus;
  private checked: CleanupOffer | null = null;
  private checking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** for tests: how long to wait after a session closes before its folders go */
  closeDelayMs = 3000;

  constructor(store: Store, hub: WorkerHub, github: GitHub, bus: Bus) {
    this.store = store;
    this.hub = hub;
    this.github = github;
    this.bus = bus;
  }

  start() {
    this.timer = setInterval(() => void this.check().catch((e) => console.warn('cleanup check failed:', (e as Error).message)), 3600_000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const timer of this.closing) clearTimeout(timer);
    this.closing.clear();
  }

  /** The last check's offer, without sessions resumed since (DISP-35). */
  get offer(): CleanupOffer | null {
    if (!this.checked) return null;
    const sessions = this.checked.sessions.filter((o) => this.finished(o.id));
    if (!sessions.length) return null;
    const sum = (k: 'worktrees' | 'branches') => sessions.reduce((n, o) => n + o[k], 0);
    const checked_out = sessions.reduce((n, o) => n + (o.checked_out?.length ?? 0), 0);
    return { ...this.checked, sessions, worktrees: sum('worktrees'), branches: sum('branches'), checked_out };
  }
  private finished(id: number) {
    const s = this.store.session(id);
    return !!s && FINAL_STATUSES.includes(s.status);
  }

  private reposOf(s: Session) {
    return s.project_id ? this.store.repos(s.project_id) : [];
  }
  private mergedRepoIds(s: Session) {
    return this.store.prs({ session_id: s.id }).filter((p) => p.state === 'merged').map((p) => p.repo_id);
  }

  /**
   * Tidy one session. `deleteMerged`: delete its branch where merged (here and on GitHub).
   * `force`: also remove worktrees with uncommitted changes (chats, "delete worktree from disk").
   */
  async tidy(s: Session, opts: { deleteMerged: boolean; force: boolean }): Promise<TidyResult[]> {
    const repos = this.reposOf(s);
    if (!repos.length || !this.hub.isConnected(s.worker_id)) return [];
    const merged = this.mergedRepoIds(s);
    const results = await this.hub.cmd<TidyResult[]>(s.worker_id, { c: 'tidy', session_id: s.id, repos, branch: s.branch, merged_repo_ids: merged, delete_merged: opts.deleteMerged, force: opts.force }, 120_000);
    if (opts.deleteMerged && s.branch) {
      for (const repo of repos.filter((r) => !r.local_path && merged.includes(r.id))) {
        const gone = await this.github.deleteRemoteBranch(repo, s.branch, s).catch(() => false);
        if (gone) results.push({ repo: repo.github_name, worktree: 'none', branch: 'deleted on GitHub' });
      }
    }
    const said = results.flatMap((r) => [
      r.worktree !== 'none' ? `${r.repo}: worktree ${r.worktree}` : '',
      r.branch !== 'none' ? `${r.repo}: branch ${r.branch}` : '',
    ]).filter(Boolean);
    if (said.length && !CHAT_KINDS.includes(s.kind) && s.kind !== 'planner') {
      const ev = this.store.addEvent(s.id, { kind: 'system', text: `Cleaned up. ${said.join('; ')}.` });
      this.bus.emit({ t: 'session_event', event: ev });
    }
    return results;
  }

  /** A session just finished: tidy it once its runner has stopped. */
  onFinished(s: Session, status: 'completed' | 'stopped', removeAll: boolean) {
    const chat = s.kind !== 'work';
    const opts = removeAll ? { deleteMerged: true, force: true }
      : chat ? { deleteMerged: false, force: true }
      : { deleteMerged: status === 'completed', force: false };
    // kept, so a server that stops meanwhile does not tidy on a closed database
    const timer = setTimeout(() => {
      this.closing.delete(timer);
      void Promise.resolve().then(() => this.tidy(this.store.session(s.id) ?? s, opts)).catch((e) => console.warn('tidy failed:', (e as Error).message));
    }, this.closeDelayMs);
    this.closing.add(timer);
  }

  /** tidy-ups that wait for a finished session's runner to stop */
  private closing = new Set<NodeJS.Timeout>();

  /** Rows that outlived their use: OAuth clients nobody connected (DISP-70), expired password sessions. Needs no worker. */
  private expireRecords() {
    try {
      const { never_connected, disconnected } = expireOAuthClients(this.store.db);
      if (never_connected || disconnected) console.log(`removed ${never_connected} OAuth client(s) that never connected and ${disconnected} disconnected for 30 days`);
      this.store.db.run('DELETE FROM web_sessions WHERE expires_at <= ?', new Date().toISOString());
    } catch (e) {
      console.warn('expiring records failed:', (e as Error).message);
    }
  }

  /** What finished sessions left behind: refresh the offer, and tidy chats unused for a week. */
  check(): Promise<void> {
    this.checking ??= this.checkNow().finally(() => (this.checking = null));
    return this.checking;
  }

  private async checkNow() {
    this.expireRecords();
    if (!this.hub.connected) return;
    const since = Date.now() - 90 * DAY;
    const finished = this.store.sessions({ statuses: ['completed', 'stopped', 'failed'] }).filter((s) => Date.parse(s.updated_at) > since);
    const offer: CleanupOffer = { sessions: [], worktrees: 0, branches: 0, checked_out: 0, checked_at: new Date().toISOString() };
    for (const s of finished) {
      const repos = this.reposOf(s);
      if (!repos.length) continue;
      if (!this.hub.isConnected(s.worker_id)) continue;
      const left = await this.hub.cmd<Leftover[]>(s.worker_id, { c: 'leftovers', session_id: s.id, repos, branch: s.branch, merged_repo_ids: this.mergedRepoIds(s) }, 60_000);
      const removable = (l: Leftover) => l.worktree && (s.kind !== 'work' || !(l.dirty || (l.untracked && !(l.branch && l.merged))));
      const worktrees = left.filter(removable).length;
      const branches = left.filter((l) => l.branch && l.merged && !l.checked_out).length;
      const checked_out = left.filter((l) => l.branch && l.merged && l.checked_out).map((l) => ({ repo: l.repo, path: l.checked_out! }));
      if (worktrees || branches || checked_out.length) {
        offer.sessions.push({ id: s.id, title: s.title, project_key: s.project_key, worktrees, branches, ...(checked_out.length ? { checked_out } : {}) });
        offer.worktrees += worktrees;
        offer.branches += branches;
        offer.checked_out! += checked_out.length;
      }
    }
    // chats keep a read-only checkout while open; after a week unused it goes (a new message brings it back)
    const stale = this.store.sessions({ statuses: ['idle'] }).filter((s) => s.kind !== 'work' && Date.parse(s.updated_at) < Date.now() - 7 * DAY);
    for (const s of stale) await this.tidy(s, { deleteMerged: false, force: true }).catch(() => undefined);
    this.checked = offer.sessions.length ? offer : null;
  }

  /** The inbox's "Clean up": tidy every session in the offer (merged branches go, unmerged work stays). */
  async cleanAll() {
    await this.check();
    const results: { session_id: number; results: TidyResult[] }[] = [];
    for (const o of this.offer?.sessions ?? []) {
      const s = this.store.session(o.id);
      if (s && FINAL_STATUSES.includes(s.status)) results.push({ session_id: s.id, results: await this.tidy(s, { deleteMerged: true, force: s.kind !== 'work' }) });
    }
    this.checked = null;
    await this.check();
    return results;
  }
}
