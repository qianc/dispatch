// GitHub: link PRs to sessions by branch, sync item status, show diffs, merge.
import { Octokit } from '@octokit/rest';
import type { GithubAccount } from '../shared/accounts.ts';
import type { BranchFile, BranchStatus, PullRequest, Repo, Session } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import type { Notifier } from './notify.ts';
import type { Store } from './store.ts';
import type { WorkerHub } from './workerHub.ts';

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface PrDetail {
  pr: PullRequest;
  body: string;
  base_ref: string;
  files: PrFile[];
  checks: { name: string; status: string; conclusion: string | null; url: string | null }[];
}

type GhPull = {
  number: number; html_url: string; title: string; state: string; merged_at?: string | null; merged?: boolean;
  mergeable?: boolean | null; mergeable_state?: string; head: { ref: string; sha: string };
};

export class GitHub {
  readonly octo: Octokit | null;
  private timer: NodeJS.Timeout | null = null;
  private store: Store;
  private bus: Bus;
  private notifier: Notifier;
  private hub: WorkerHub;

  readonly accounts: GithubAccount[];
  private clients = new Map<string, Octokit>();

  constructor(accounts: GithubAccount[], store: Store, bus: Bus, notifier: Notifier, hub: WorkerHub) {
    this.accounts = accounts;
    for (const a of accounts) this.clients.set(a.name, new Octokit({ auth: a.token, userAgent: 'dispatch' }));
    this.store = store;
    this.bus = bus;
    this.notifier = notifier;
    this.hub = hub;
    // the first account is the default (also what older code and tests use)
    this.octo = accounts.length ? this.clients.get(accounts[0].name)! : null;
  }

  /** The client for a repo: its project's GitHub account, else the first account. */
  clientFor(repo: Pick<Repo, 'github_account'> | null): Octokit | null {
    return (repo?.github_account && this.clients.get(repo.github_account)) || this.octo;
  }

  private gh(repo: Pick<Repo, 'github_account'> | null) {
    const c = this.clientFor(repo);
    if (!c) throw new Error(repo?.github_account ? `GitHub account "${repo.github_account}" is not configured` : 'No GitHub account is configured (GITHUB_ACCOUNTS or GITHUB_TOKEN)');
    return c;
  }

  /** Configured accounts with the GitHub login each token belongs to (checked once). */
  private logins = new Map<string, Promise<string | null>>();
  async accountsInfo() {
    return Promise.all(this.accounts.map(async (a) => {
      if (!this.logins.has(a.name)) {
        this.logins.set(a.name, this.clients.get(a.name)!.users.getAuthenticated().then((r) => r.data.login, () => null));
      }
      return { name: a.name, login: await this.logins.get(a.name)!, git_name: a.git_name, git_email: a.git_email };
    }));
  }

  startPolling(seconds: number) {
    const tick = () => this.syncAll().catch((e) => console.warn('github sync failed:', (e as Error).message));
    this.timer = setInterval(tick, seconds * 1000);
    setTimeout(tick, 5000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Sessions worth checking: work sessions with a branch, not ended more than 14 days ago. */
  async syncAll() {
    const cutoff = Date.now() - 14 * 86400_000;
    const sessions = this.store.sessions({ kind: 'work', limit: 500 }).filter(
      (s) => s.branch && s.status !== 'queued' && (!s.ended_at || Date.parse(s.ended_at) > cutoff),
    );
    for (const s of sessions) {
      const open = this.store.prs({ session_id: s.id });
      if (open.length && open.every((p) => p.state !== 'open') && s.ended_at) continue;
      await this.syncSession(s);
    }
  }

  async syncSession(s: Session) {
    if (!s.branch || !s.project_id) return [];
    const out: PullRequest[] = [];
    try {
      for (const repo of this.store.repos(s.project_id)) {
        if (repo.local_path) {
          const pr = await this.syncLocal(s, repo);
          if (pr) out.push(pr);
          continue;
        }
        if (!this.clientFor(repo)) continue;
        const { data } = await this.gh(repo).pulls.list({ owner: repo.github_owner, repo: repo.github_name, head: `${repo.github_owner}:${s.branch}`, state: 'all', per_page: 5 });
        for (const p of data) out.push(await this.record(s, repo, p as GhPull));
      }
    } finally {
      this.flushMergeNotice(s.id); // every repo of the session is through: one notice for all
    }
    return out;
  }

  /** A PR changed state (merged, closed, opened): queued batches may now start. */
  onPrChange: (() => void) | null = null;

  /** Delete a merged PR's head branch on GitHub (no error if it is already gone). */
  async deleteRemoteBranch(repo: Repo, branch: string): Promise<boolean> {
    if (repo.local_path || !this.clientFor(repo)) return false;
    try {
      await this.gh(repo).git.deleteRef({ owner: repo.github_owner, repo: repo.github_name, ref: `heads/${branch}` });
      return true;
    } catch (e) {
      const code = (e as { status?: number }).status;
      if (code === 404 || code === 422) return false; // already deleted (often by GitHub itself)
      throw e;
    }
  }

  /** Auto-merge outcomes per session, sent as one notice (a session can change several repos). */
  private mergeNotices = new Map<number, { s: Session; merged: string[]; stopped: { label: string; why: string; prId: number }[]; timer: NodeJS.Timeout }>();

  private queueMergeNotice(s: Session, outcome: { merged: string } | { stopped: string; why: string; prId: number }) {
    const cur = this.mergeNotices.get(s.id) ?? { s, merged: [], stopped: [], timer: undefined as unknown as NodeJS.Timeout };
    clearTimeout(cur.timer);
    if ('merged' in outcome) cur.merged.push(outcome.merged);
    else cur.stopped.push({ label: outcome.stopped, why: outcome.why, prId: outcome.prId });
    // outside a whole-session sync (a single PR synced), send once things are quiet
    cur.timer = setTimeout(() => this.flushMergeNotice(s.id), 1500);
    this.mergeNotices.set(s.id, cur);
  }

  private flushMergeNotice(sessionId: number) {
    const n = this.mergeNotices.get(sessionId);
    if (!n) return;
    clearTimeout(n.timer);
    this.mergeNotices.delete(sessionId);
    const { s, merged, stopped } = n;
    const project_id = s.project_id ?? undefined;
    if (stopped.length) {
      const body = stopped.map((x) => `${x.label}: ${x.why}`).join('\n') + (merged.length ? `\nMerged: ${merged.join(', ')}` : '');
      void this.notifier.send({ title: `${s.project_key}: not auto-merged`, body, url: stopped.length === 1 && !merged.length ? `/pr/${stopped[0].prId}` : `/s/${s.id}`, tag: `automerge-${s.id}`, project_id });
      return;
    }
    // the one notice for this turn: what Claude said it did, now merged
    const summary = this.store.session(s.id)?.last_text;
    void this.notifier.send({
      title: `${s.project_key}: done and merged${merged.length > 1 ? ` (${merged.length} repos)` : ''}`,
      body: summary || merged.join(', '),
      url: `/s/${s.id}`, tag: `merged-${s.id}`, project_id,
    });
  }

  /**
   * Local repos have no PRs: a session branch pushed into the folder, with commits the default
   * branch lacks, is shown as a review entry (number = -session id) until it is merged.
   */
  private async syncLocal(s: Session, repo: Repo): Promise<PullRequest | null> {
    const st = await this.hub.cmd<BranchStatus>(s.worker_id, { c: 'branch_status', repo, branch: s.branch! }, 120_000);
    const known = this.store.prs({ session_id: s.id }).find((p) => p.repo_id === repo.id);
    if (!st.exists || (!st.merged && st.ahead === 0)) return known ?? null;
    if (st.merged && !known) return null; // nothing was ever offered for review
    return this.recordRow(s, repo, {
      number: -s.id, url: '', title: s.title, state: st.merged ? 'merged' : 'open',
      mergeable: !st.conflicts, mergeable_state: st.conflicts ? 'dirty' : 'clean', head_ref: s.branch!, head_sha: st.head_sha,
    });
  }

  async syncPr(prId: number) {
    const pr = this.store.pr(prId);
    if (!pr) throw new Error('Unknown PR');
    const repo = this.store.repo(pr.repo_id)!;
    if (repo.local_path) return (await this.syncLocal(this.store.session(pr.session_id)!, repo)) ?? pr;
    const { data } = await this.gh(repo).pulls.get({ owner: repo.github_owner, repo: repo.github_name, pull_number: pr.number });
    return this.record(this.store.session(pr.session_id)!, repo, data as GhPull);
  }

  /** The worker that holds a PR's branch: its session's. */
  private workerOf(pr: PullRequest) {
    return this.store.session(pr.session_id)?.worker_id ?? null;
  }

  /** Called when auto-merge waits because the branch is behind (app.ts sends the agent a message). */
  onBehind: ((s: Session, repo: Repo, behind: number) => void) | null = null;

  /** Commits on the default branch that the PR / local branch does not have yet. */
  private async behindBy(repo: Repo, pr: PullRequest): Promise<number> {
    if (repo.local_path) {
      const st = await this.hub.cmd<BranchStatus>(this.workerOf(pr), { c: 'branch_status', repo, branch: pr.head_ref }, 120_000);
      return st.behind;
    }
    const { data } = await this.gh(repo).repos.compareCommits({ owner: repo.github_owner, repo: repo.github_name, base: repo.default_branch, head: pr.head_sha ?? pr.head_ref });
    return data.behind_by;
  }

  /** PRs already reported as not auto-mergeable, per head sha, so the owner is told once. */
  private autoMergeNoted = new Set<string>();
  /** PRs being auto-merged now: merging re-syncs the PR, which must not start a second merge. */
  private merging = new Set<number>();

  /**
   * Auto-merge (session option): merge an open PR once the agent is done (idle or completed, no
   * open question), GitHub says it is mergeable, and every check has passed. Otherwise wait, or
   * tell the owner once why it will not merge.
   */
  /** Per session: how many auto-merge outcomes were told to the owner (a notice or a message to the agent). */
  private told = new Map<number, number>();
  toldCount(sessionId: number) {
    return this.told.get(sessionId) ?? 0;
  }
  private tell(sessionId: number) {
    this.told.set(sessionId, this.toldCount(sessionId) + 1);
  }

  /**
   * Auto-merge (session option), one at a time per PR: two syncs of the same branch (turn end and
   * the poller) must not both merge it. The lock covers the whole check, and the PR's state is read
   * again inside it.
   */
  async maybeAutoMerge(s: Session, pr: PullRequest) {
    if (this.merging.has(pr.id)) return;
    this.merging.add(pr.id);
    try {
      await this.autoMerge(s, this.store.pr(pr.id) ?? pr);
    } finally {
      this.merging.delete(pr.id);
    }
  }

  private async autoMerge(s: Session, pr: PullRequest) {
    const how = s.options.auto_merge;
    if (how === 'off' || pr.state !== 'open') return;
    if (!['idle', 'completed'].includes(s.status) || this.store.openInputs().some((i) => i.session_id === s.id)) return;
    // name the repo: one session can merge a branch of the same name in several repos
    const repoName = pr.repo_full_name.split('/').pop();
    const ref = pr.local ? `branch ${pr.head_ref}` : `PR #${pr.number}`;
    const label = `${repoName} ${ref}`; // for notices, e.g. "web-app branch dispatch/…", "front PR #3"
    const note = (why: string) => {
      const key = `${pr.id}:${pr.head_sha}:${why}`;
      if (this.autoMergeNoted.has(key)) return;
      this.autoMergeNoted.add(key);
      this.store.setPrBlocked(pr.id, why);
      this.bus.emit({ t: 'pr', pr: this.store.pr(pr.id)! });
      this.store.addEvent(s.id, { kind: 'system', text: `Auto-merge into ${repoName} skipped for ${ref}: ${why}` });
      this.tell(s.id);
      this.queueMergeNotice(s, { stopped: label, why, prId: pr.id });
    };
    if (pr.mergeable === null) return; // GitHub is still computing it
    if (pr.mergeable === false) return note('it has merge conflicts');
    const repo = this.store.repo(pr.repo_id)!;
    if (s.options.base_check) {
      // tested against an older default branch? have the agent bring the branch up to date first
      const behind = await this.behindBy(repo, pr);
      if (behind > 0) {
        const key = `${pr.id}:${pr.head_sha}:behind`;
        if (!this.autoMergeNoted.has(key)) {
          this.autoMergeNoted.add(key);
          this.store.addEvent(s.id, { kind: 'system', text: `Auto-merge into ${repoName} waits for ${ref}: the branch is ${behind} commit${behind === 1 ? '' : 's'} behind ${repo.default_branch}. Asked the agent to update it.` });
          this.onBehind?.(s, repo, behind);
          this.tell(s.id); // the agent goes on working: no "waiting for you" yet
        }
        return;
      }
    }
    const checks = pr.head_sha && !repo.local_path
      ? (await this.gh(repo).checks.listForRef({ owner: repo.github_owner, repo: repo.github_name, ref: pr.head_sha, per_page: 100 })).data.check_runs
      : [];
    if (checks.some((c) => c.status !== 'completed')) return; // wait for them
    const bad = checks.filter((c) => !['success', 'neutral', 'skipped'].includes(c.conclusion ?? ''));
    if (bad.length) return note(`checks failed (${bad.map((c) => c.name).join(', ')})`);
    const res = await this.merge(pr.id, how, 'squash');
    if (!res.ok) return note(res.conflict ? 'local merge hit conflicts' : `local merge failed: ${res.output.slice(0, 200)}`);
    this.store.addEvent(s.id, { kind: 'system', text: `Auto-merged into ${repoName}: ${ref} (${how === 'github' && !pr.local ? 'squash on GitHub' : 'local merge'}).` });
    this.tell(s.id);
    this.queueMergeNotice(s, { merged: label });
  }

  /** Store a GitHub PR and apply side effects of state changes. */
  private async record(s: Session, repo: Repo, p: GhPull): Promise<PullRequest> {
    let full = p;
    if (p.state === 'open' && p.mergeable === undefined) {
      full = (await this.gh(repo).pulls.get({ owner: repo.github_owner, repo: repo.github_name, pull_number: p.number })).data as GhPull;
    }
    const state: PullRequest['state'] = full.merged_at || full.merged ? 'merged' : full.state === 'open' ? 'open' : 'closed';
    return this.recordRow(s, repo, {
      number: full.number, url: full.html_url, title: full.title, state,
      mergeable: full.mergeable ?? null, mergeable_state: full.mergeable_state ?? null, head_ref: full.head.ref, head_sha: full.head.sha,
    });
  }

  /** Store a PR / local review and apply side effects of state changes (items, notices, auto-merge). */
  private async recordRow(s: Session, repo: Repo, row: Omit<Parameters<Store['upsertPr']>[0], 'session_id' | 'repo_id'>): Promise<PullRequest> {
    const before = this.store.prs({ session_id: s.id }).find((x) => x.repo_id === repo.id && x.number === row.number);
    const state = row.state;
    const pr = this.store.upsertPr({ ...row, session_id: s.id, repo_id: repo.id });
    this.bus.emit({ t: 'pr', pr });
    if (before?.state !== state) queueMicrotask(() => this.onPrChange?.());
    if (before?.state !== state) this.onStateChange(s, pr, before?.state ?? null);
    if (state === 'open' && s.options.auto_merge !== 'off') {
      await this.maybeAutoMerge(this.store.session(s.id)!, pr).catch((e) => console.warn('auto-merge failed:', (e as Error).message));
      return this.store.pr(pr.id)!;
    }
    return pr;
  }

  private onStateChange(s: Session, pr: PullRequest, was: PullRequest['state'] | null) {
    const items = this.store.itemsByIds(s.item_ids);
    if (pr.state === 'open' && was === null) {
      for (const it of items) if (it.status === 'in_progress' || it.status === 'todo') this.bus.emit({ t: 'item', item: this.store.updateItem(it.id, { status: 'in_review' }) });
      // with auto-merge on, the merge result is the notice (merged, or why not)
      if (s.options.auto_merge === 'off') void this.notifier.send({
        title: pr.local ? `${s.project_key}: branch ready for review` : `${s.project_key}: PR ready`,
        body: pr.local ? `${pr.head_ref} · ${pr.title}` : `#${pr.number} ${pr.title}`,
        url: `/pr/${pr.id}`, tag: `pr-${pr.id}`, project_id: s.project_id ?? undefined,
      });
    }
    if (pr.state === 'closed') {
      const all = this.store.prs({ session_id: s.id });
      if (!all.some((p) => p.state !== 'closed')) {
        for (const it of items) if (it.status === 'in_review') this.bus.emit({ t: 'item', item: this.store.updateItem(it.id, { status: 'todo' }) });
      }
    }
    if (pr.state === 'merged') {
      const all = this.store.prs({ session_id: s.id });
      if (all.every((p) => p.state !== 'open')) {
        for (const it of items) if (it.status !== 'done' && it.status !== 'canceled') this.bus.emit({ t: 'item', item: this.store.updateItem(it.id, { status: 'done' }) });
      }
    }
  }

  async detail(prId: number): Promise<PrDetail> {
    const pr = await this.syncPr(prId);
    const repo = this.store.repo(pr.repo_id)!;
    if (repo.local_path) {
      const files = await this.hub.cmd<BranchFile[]>(this.workerOf(pr), { c: 'branch_diff', repo, branch: pr.head_ref }, 120_000);
      return { pr, body: '', base_ref: repo.default_branch, files, checks: [] };
    }
    const o = { owner: repo.github_owner, repo: repo.github_name };
    const [{ data: p }, files, checks] = await Promise.all([
      this.gh(repo).pulls.get({ ...o, pull_number: pr.number }),
      this.gh(repo).paginate(this.gh(repo).pulls.listFiles, { ...o, pull_number: pr.number, per_page: 100 }),
      pr.head_sha
        ? this.gh(repo).checks.listForRef({ ...o, ref: pr.head_sha, per_page: 50 }).then((r) => r.data.check_runs).catch(() => [])
        : Promise.resolve([]),
    ]);
    return {
      pr,
      body: p.body ?? '',
      base_ref: p.base.ref,
      files: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ?? null })),
      checks: checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion ?? null, url: c.html_url ?? null })),
    };
  }

  async merge(prId: number, how: 'github' | 'local', method: 'squash' | 'merge' | 'rebase') {
    const pr = this.store.pr(prId);
    if (!pr) throw new Error('Unknown PR');
    if (pr.state !== 'open') throw new Error(`PR is ${pr.state}`);
    const repo = this.store.repo(pr.repo_id)!;
    if (repo.local_path) how = 'local';
    if (how === 'github') {
      await this.gh(repo).pulls.merge({ owner: repo.github_owner, repo: repo.github_name, pull_number: pr.number, merge_method: method });
    } else {
      const res = await this.hub.cmd<{ ok: boolean; conflict?: boolean; output?: string }>(this.workerOf(pr), {
        c: 'merge_local', repo, branch: pr.head_ref, message: pr.local ? `Merge ${pr.head_ref}: ${pr.title}` : `Merge #${pr.number}: ${pr.title}`,
      });
      if (!res.ok) return { ok: false as const, conflict: !!res.conflict, output: res.output ?? '' };
    }
    // GitHub needs a moment to register a pushed merge.
    for (let i = 0; i < 5; i++) {
      const synced = await this.syncPr(prId);
      if (synced.state === 'merged') return { ok: true as const, pr: synced };
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { ok: true as const, pr: this.store.pr(prId)! };
  }

  /** Push the session branch (via the worker) and open a PR for it. */
  async createPr(s: Session, repoId: number) {
    const repo = this.store.repo(repoId);
    if (!repo || repo.project_id !== s.project_id || !s.branch) throw new Error('Unknown repo for this session');
    await this.hub.cmd(s.worker_id, { c: 'push_branch', repo, session_id: s.id, branch: s.branch });
    if (repo.local_path) {
      const pr = await this.syncLocal(s, repo);
      if (!pr) throw new Error('The branch has no commits beyond the default branch yet');
      return pr;
    }
    const items = this.store.itemsByIds(s.item_ids);
    const body = [`Opened from Dispatch session #${s.id}.`, '', ...items.map((i) => `- ${i.key}: ${i.title}`)].join('\n');
    const { data } = await this.gh(repo).pulls.create({ owner: repo.github_owner, repo: repo.github_name, head: s.branch, base: repo.default_branch, title: s.title, body });
    return this.record(s, repo, data as GhPull);
  }
}
