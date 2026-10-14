// GitHub: link PRs to sessions by branch, sync item status, show diffs, merge.
import { Octokit } from '@octokit/rest';
import type { PullRequest, Repo, Session } from '../shared/types.ts';
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

  constructor(token: string | null, store: Store, bus: Bus, notifier: Notifier, hub: WorkerHub) {
    this.store = store;
    this.bus = bus;
    this.notifier = notifier;
    this.hub = hub;
    this.octo = token ? new Octokit({ auth: token, userAgent: 'dispatch' }) : null;
  }

  private gh() {
    if (!this.octo) throw new Error('GITHUB_TOKEN is not set');
    return this.octo;
  }

  startPolling(seconds: number) {
    if (!this.octo) return;
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
    if (!s.branch) return [];
    const out: PullRequest[] = [];
    if (!s.project_id) return [];
    for (const repo of this.store.repos(s.project_id)) {
      const { data } = await this.gh().pulls.list({ owner: repo.github_owner, repo: repo.github_name, head: `${repo.github_owner}:${s.branch}`, state: 'all', per_page: 5 });
      for (const p of data) out.push(await this.record(s, repo, p as GhPull));
    }
    return out;
  }

  async syncPr(prId: number) {
    const pr = this.store.pr(prId);
    if (!pr) throw new Error('Unknown PR');
    const repo = this.store.repo(pr.repo_id)!;
    const { data } = await this.gh().pulls.get({ owner: repo.github_owner, repo: repo.github_name, pull_number: pr.number });
    return this.record(this.store.session(pr.session_id)!, repo, data as GhPull);
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
  async maybeAutoMerge(s: Session, pr: PullRequest) {
    const how = s.options.auto_merge;
    if (how === 'off' || pr.state !== 'open') return;
    if (!['idle', 'completed'].includes(s.status) || this.store.openInputs().some((i) => i.session_id === s.id)) return;
    const note = (why: string) => {
      const key = `${pr.id}:${pr.head_sha}:${why}`;
      if (this.autoMergeNoted.has(key)) return;
      this.autoMergeNoted.add(key);
      this.store.addEvent(s.id, { kind: 'system', text: `Auto-merge of #${pr.number} skipped: ${why}` });
      void this.notifier.send({ title: `${s.project_key}: not auto-merged`, body: `#${pr.number}: ${why}`, url: `/pr/${pr.id}`, tag: `automerge-${pr.id}`, project_id: s.project_id ?? undefined });
    };
    if (pr.mergeable === null) return; // GitHub is still computing it
    if (pr.mergeable === false) return note('it has merge conflicts');
    const repo = this.store.repo(pr.repo_id)!;
    const checks = pr.head_sha
      ? (await this.gh().checks.listForRef({ owner: repo.github_owner, repo: repo.github_name, ref: pr.head_sha, per_page: 100 })).data.check_runs
      : [];
    if (checks.some((c) => c.status !== 'completed')) return; // wait for them
    const bad = checks.filter((c) => !['success', 'neutral', 'skipped'].includes(c.conclusion ?? ''));
    if (bad.length) return note(`checks failed (${bad.map((c) => c.name).join(', ')})`);
    if (this.merging.has(pr.id)) return;
    this.merging.add(pr.id);
    let res: Awaited<ReturnType<GitHub['merge']>>;
    try {
      res = await this.merge(pr.id, how, 'squash');
    } finally {
      this.merging.delete(pr.id);
    }
    if (!res.ok) return note(res.conflict ? 'local merge hit conflicts' : `local merge failed: ${res.output.slice(0, 200)}`);
    this.store.addEvent(s.id, { kind: 'system', text: `Auto-merged #${pr.number} (${how === 'github' ? 'squash on GitHub' : 'local merge'}).` });
    void this.notifier.send({ title: `${s.project_key}: auto-merged`, body: `#${pr.number} ${pr.title}`, url: `/pr/${pr.id}`, tag: `pr-${pr.id}`, project_id: s.project_id ?? undefined });
  }

  /** Store a PR and apply side effects of state changes. */
  private async record(s: Session, repo: Repo, p: GhPull): Promise<PullRequest> {
    const before = this.store.prs({ session_id: s.id }).find((x) => x.repo_id === repo.id && x.number === p.number);
    let full = p;
    if (p.state === 'open' && p.mergeable === undefined) {
      full = (await this.gh().pulls.get({ owner: repo.github_owner, repo: repo.github_name, pull_number: p.number })).data as GhPull;
    }
    const state: PullRequest['state'] = full.merged_at || full.merged ? 'merged' : full.state === 'open' ? 'open' : 'closed';
    const pr = this.store.upsertPr({
      session_id: s.id, repo_id: repo.id, number: full.number, url: full.html_url, title: full.title, state,
      mergeable: full.mergeable ?? null, mergeable_state: full.mergeable_state ?? null, head_ref: full.head.ref, head_sha: full.head.sha,
    });
    this.bus.emit({ t: 'pr', pr });
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
      void this.notifier.send({ title: `${s.project_key}: PR ready`, body: `#${pr.number} ${pr.title}`, url: `/pr/${pr.id}`, tag: `pr-${pr.id}`, project_id: s.project_id ?? undefined });
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
    const o = { owner: repo.github_owner, repo: repo.github_name };
    const [{ data: p }, files, checks] = await Promise.all([
      this.gh().pulls.get({ ...o, pull_number: pr.number }),
      this.gh().paginate(this.gh().pulls.listFiles, { ...o, pull_number: pr.number, per_page: 100 }),
      pr.head_sha
        ? this.gh().checks.listForRef({ ...o, ref: pr.head_sha, per_page: 50 }).then((r) => r.data.check_runs).catch(() => [])
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
    if (how === 'github') {
      await this.gh().pulls.merge({ owner: repo.github_owner, repo: repo.github_name, pull_number: pr.number, merge_method: method });
    } else {
      const res = await this.hub.cmd<{ ok: boolean; conflict?: boolean; output?: string }>({
        c: 'merge_local', repo, branch: pr.head_ref, message: `Merge #${pr.number}: ${pr.title}`,
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
    await this.hub.cmd({ c: 'push_branch', repo, session_id: s.id, branch: s.branch });
    const items = this.store.itemsByIds(s.item_ids);
    const body = [`Opened from Dispatch session #${s.id}.`, '', ...items.map((i) => `- ${i.key}: ${i.title}`)].join('\n');
    const { data } = await this.gh().pulls.create({ owner: repo.github_owner, repo: repo.github_name, head: s.branch, base: repo.default_branch, title: s.title, body });
    return this.record(s, repo, data as GhPull);
  }
}
