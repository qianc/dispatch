// GitHub: link PRs to sessions by branch, sync item status, show diffs, merge.
import { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import type { GithubCred } from '../shared/protocol.ts';
import { pickGithub, type GithubAccount } from '../shared/accounts.ts';
import type { BranchFile, BranchStatus, CiState, MergeEvent, Project, PullRequest, Repo, Session } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import { CheckRuns } from './checkRuns.ts';
import type { CheckProgress } from '../shared/checkProgress.ts';
import { generatorItems } from '../shared/generatorItems.ts';
import { mergeMessage } from '../shared/mergeMessage.ts';
import type { ChildNoticeKind, Notice, Notifier } from './notify.ts';
import type { Store } from './store.ts';
import type { WorkerHub } from './workerHub.ts';
import type { HostedGit } from './hosted.ts';
import type { Identities } from './identities.ts';
import { isRefusal, type GithubIdentity, type IdentityRefusal } from './identity.ts';
import { refusalError } from './sessions.ts';
import { HttpError } from './routes/ctx.ts';

/** As whom a session acts on GitHub now (identity.ts; null: its project needs no GitHub). */
export type SessionIdentity = (s: Session) => GithubIdentity | IdentityRefusal | null;

/** Who asks, for actions outside a session: `user` picks the GitHub identity, `name` goes on the record (DISP-111). */
export interface Caller {
  user: string | null;
  name: string;
}

/** As whom a caller acts on a repo's GitHub (null: no rule, the env accounts). */
export type CallerIdentity = (user: string | null, repo: Repo) => GithubIdentity | IdentityRefusal | null;

/** A GitHub client and git environment, acting as someone: the session's user (`user`) or an env account. */
interface Acting {
  /** null: no env account is configured */
  octo: Octokit | null;
  gitEnv: Record<string, string>;
  /** the starter's own credential (source `user`), for worker commands */
  cred: GithubCred | null;
}

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface PrDetail {
  pr: PullRequest;
  /** what kind of repo it is in: a hosted one is reviewed and merged in Dispatch */
  repo: { kind: NonNullable<Repo['kind']>; upstream: string | null; check_command: string | null };
  /** times the owner's hands were needed for this session's merges */
  hands: MergeEvent[];
  body: string;
  base_ref: string;
  files: PrFile[];
  checks: { name: string; status: string; conclusion: string | null; url: string | null }[];
  /** the session's auto-merge setting: while it is on, Dispatch checks and merges an open PR itself */
  auto_merge: Session['options']['auto_merge'];
  /** what the page says about merging this PR here (no session: what does not run, or why it cannot merge) */
  merge_note: string | null;
  /** false: this PR cannot be merged in Dispatch at all */
  merge_here: boolean;
}

type Check = { name: string; status: string; conclusion: string | null; html_url: string | null };

/** A PR's checks as one word (the rule auto-merge uses: success, neutral and skipped pass). */
export function ciStateOf(checks: { status: string; conclusion: string | null }[]): CiState {
  if (!checks.length) return 'none';
  if (checks.some((c) => c.status !== 'completed')) return 'pending';
  return checks.every((c) => ['success', 'neutral', 'skipped'].includes(c.conclusion ?? '')) ? 'success' : 'failure';
}

/** What Dispatch says about a PR that no session owns (DISP-111). */
export const NO_SESSION = 'This pull request has no session. Start work from an item.';
const OWN_PR = 'GitHub does not accept an approval of your own pull request.';
const NO_MERGE_GENERATE = "This repo merges only in Dispatch, on a session's worker (it has a generate command). A pull request without a session cannot be merged here.";
const MOVED = 'This pull request has new commits. Look at the changes again.';
const NO_DEPLOY = "The repo's deploy command does not run for this merge: it needs a session's worker.";

/** An error the API answers with 400: the request does not fit this PR. */
const refused = (message: string) => Object.assign(new Error(message), { status: 400 });
/** 409: the branch is not at the commit the caller looked at. */
const moved = () => Object.assign(new Error(MOVED), { status: 409 });

/** How long a PR with no checks may still get some: until then the project sync asks again. */
const CHECKS_MAY_START_MS = 30 * 60_000;

type GhPull = {
  number: number; html_url: string; title: string; state: string; merged_at?: string | null; merged?: boolean;
  mergeable?: boolean | null; mergeable_state?: string; head: { ref: string; sha: string };
  user?: { login: string } | null; base?: { ref: string }; draft?: boolean; changed_files?: number; updated_at?: string;
};

/** Start of the reason auto-merge gives when the session's last turn did not end cleanly (DISP-108). */
const UNCLEAN = 'the last turn did not end cleanly';

export class GitHub {
  readonly octo: Octokit | null;
  private timer: NodeJS.Timeout | null = null;
  private prTimer: NodeJS.Timeout | null = null;
  private store: Store;
  private bus: Bus;
  private notifier: Notifier;
  private hub: WorkerHub;

  readonly accounts: GithubAccount[];
  private clients = new Map<string, Octokit>();

  /** check commands running now for local merges, with their progress (DISP-5) */
  readonly checks: CheckRuns;

  private identities: Pick<Identities, 'markRejected'>;
  private identityOf: SessionIdentity;
  private apiUrl: string;

  constructor(accounts: GithubAccount[], store: Store, bus: Bus, notifier: Notifier, hub: WorkerHub, identities: Pick<Identities, 'markRejected'>, identityOf: SessionIdentity, apiUrl = 'https://api.github.com') {
    this.accounts = accounts;
    this.identities = identities;
    this.identityOf = identityOf;
    this.apiUrl = apiUrl;
    for (const a of accounts) this.clients.set(a.name, new Octokit({ auth: a.token, userAgent: 'dispatch', baseUrl: apiUrl }));
    this.store = store;
    this.bus = bus;
    this.notifier = notifier;
    this.hub = hub;
    this.checks = new CheckRuns(store, bus);
    // the first account is the default (also what older code and tests use)
    this.octo = accounts.length ? this.clients.get(accounts[0].name)! : null;
  }

  /** The client for a repo: its project's GitHub account, else the first account. */
  /** where git reaches GitHub (set from the config; a folder in tests) */
  gitBase = 'https://github.com';

  /** the server's own repos (set by app.ts) */
  hosted: HostedGit | null = null;

  /** The GitHub repo the API talks to: the repo itself, a hosted repo's upstream, or none (local). */
  private target(repo: Repo): { owner: string; repo: string } | null {
    if (repo.kind === 'hosted') return repo.upstream_owner && repo.upstream_name ? { owner: repo.upstream_owner, repo: repo.upstream_name } : null;
    if (repo.local_path) return null;
    return { owner: repo.github_owner, repo: repo.github_name };
  }

  private repoSummary(repo: Repo): PrDetail['repo'] {
    return { kind: repo.kind ?? 'github', upstream: repo.upstream_owner ? `${repo.upstream_owner}/${repo.upstream_name}` : null, check_command: repo.check_command };
  }

  private mustTarget(repo: Repo) {
    const t = this.target(repo);
    if (!t) throw new Error(`${repo.github_name} has no GitHub repo`);
    return t;
  }

  /** A GitHub repo's git URL. Credentials never go in it (see gitEnv). */
  gitUrl(owner: string, name: string) {
    return `${this.gitBase}/${owner}/${name}.git`;
  }

  /**
   * Environment for git commands that reach GitHub as the project's account: a credential helper
   * reads the token from the environment, so it is in no URL, argument or file.
   */
  gitEnv(repo: Pick<Repo, 'github_account'>): Record<string, string> {
    const account = pickGithub(this.accounts, repo.github_account);
    return account ? this.gitEnvForToken(account.token) : {};
  }

  /**
   * gitEnv for one token (a user's own, DISP-63). The helper answers only for GitHub's address, so
   * a remote on another host (a self-update origin on Gitea) never gets the token (DISP-241).
   */
  gitEnvForToken(token: string): Record<string, string> {
    return {
      DISPATCH_GH_TOKEN: token,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: /^https?:\/\//.test(this.gitBase) ? `credential.${this.gitBase}.helper` : 'credential.helper',
      GIT_CONFIG_VALUE_0: '!f() { echo username=x-access-token; echo "password=$DISPATCH_GH_TOKEN"; }; f',
    };
  }

  clientFor(repo: Pick<Repo, 'github_account'> | null): Octokit | null {
    // a removed account gives none (the "not configured" error), not the first account's identity (DISP-248)
    return repo?.github_account ? this.clients.get(repo.github_account) ?? null : this.octo;
  }

  private mustClient(c: Octokit | null, repo: Pick<Repo, 'github_account'> | null) {
    if (!c) throw new Error(repo?.github_account ? `GitHub account "${repo.github_account}" is not configured` : 'No GitHub account is configured (GITHUB_ACCOUNTS or GITHUB_TOKEN)');
    return c;
  }

  /** Clients for people's own tokens, by the token's hash (DISP-63). A seam: tests replace it. */
  private tokenClients = new Map<string, Octokit>();
  clientForToken(token: string): Octokit {
    const key = createHash('sha256').update(token).digest('hex');
    let c = this.tokenClients.get(key);
    if (!c) {
      c = new Octokit({ auth: token, userAgent: 'dispatch', baseUrl: this.apiUrl });
      this.tokenClients.set(key, c);
    }
    return c;
  }

  /**
   * GitHub as the session's starter (DISP-63). `write` (PRs, merges, pushes, branch deletes) uses
   * only the starter's identity: refused, it throws. `read` falls back to the shared client.
   * Without a session (or an identity rule), the env accounts as before.
   */
  private as(s: Session | null | undefined, repo: Repo, mode: 'read' | 'write'): Acting {
    return this.actingAs(s ? this.identityOf(s) : null, repo, mode);
  }

  /** As whom a caller acts on a repo's GitHub (set by app.ts; none: the env accounts). */
  callerIdentity: CallerIdentity | null = null;

  /**
   * GitHub as the person who asks, for a PR without a session (DISP-111): the same rule as `as`,
   * with the caller in the starter's place. No caller (the timer): the env accounts.
   */
  private asCaller(caller: Caller | null | undefined, repo: Repo, mode: 'read' | 'write'): Acting {
    return this.actingAs(caller && this.callerIdentity ? this.callerIdentity(caller.user, repo) : null, repo, mode);
  }

  private actingAs(id: GithubIdentity | IdentityRefusal | null, repo: Repo, mode: 'read' | 'write'): Acting {
    const env = (): Acting => ({ octo: this.clientFor(repo), gitEnv: this.gitEnv(repo), cred: null });
    if (!id) return env();
    if (isRefusal(id)) {
      if (mode === 'write') throw refusalError(id);
      return env();
    }
    if (id.source !== 'user') return env();
    return {
      octo: this.rejecting(this.clientForToken(id.token), id.user, id.login),
      gitEnv: this.gitEnvForToken(id.token),
      cred: { token: id.token, login: id.login, git_name: id.git_name, git_email: id.git_email },
    };
  }

  /**
   * A user's client that notices GitHub turning their token away (401): the connection is marked
   * (they must connect again) and the error names the account.
   */
  private rejecting(octo: Octokit, user: string, login: string): Octokit {
    const fail = (e: unknown) => {
      if ((e as { status?: number })?.status !== 401) throw e;
      const why = `GitHub turned away the token of ${user}'s account @${login}. Connect again in Settings → Your GitHub.`;
      this.identities.markRejected(user, why);
      throw Object.assign(new Error(why), { status: 401 });
    };
    const wrap = <T extends object>(target: T, depth: number): T => new Proxy(target, {
      get: (t, k) => {
        const v = Reflect.get(t, k);
        return depth < 2 && v && (typeof v === 'object' || typeof v === 'function') ? wrap(v as object, depth + 1) : v;
      },
      apply: (t, self, args) => {
        try {
          const r = Reflect.apply(t as (...a: unknown[]) => unknown, self, args);
          return r instanceof Promise ? r.catch(fail) : r;
        } catch (e) {
          return fail(e);
        }
      },
    });
    return wrap(octo, 0);
  }

  /** The starter's own credential when the session acts as them (else null: env accounts); never refuses. */
  private credOf(s: Session | null | undefined): GithubCred | null {
    const id = s ? this.identityOf(s) : null;
    return id && !isRefusal(id) && id.source === 'user' ? { token: id.token, login: id.login, git_name: id.git_name, git_email: id.git_email } : null;
  }

  /** The session a PR belongs to (none: no session of Dispatch opened it, DISP-111). */
  private sessionOf(pr: Pick<PullRequest, 'session_id'>): Session | undefined {
    return pr.session_id === null ? undefined : this.store.session(pr.session_id);
  }

  /** The client for a session's repo, or the error gh() gives when there is none. */
  private client(s: Session | null | undefined, repo: Repo, mode: 'read' | 'write') {
    return this.mustClient(this.as(s, repo, mode).octo, repo);
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

  /** `prSeconds`: how often the open PRs of every project are synced (0: not on a timer). */
  startPolling(seconds: number, prSeconds = 0) {
    const tick = () => this.syncAll().catch((e) => console.warn('github sync failed:', (e as Error).message));
    this.timer = setInterval(tick, seconds * 1000);
    setTimeout(tick, 5000);
    if (!(prSeconds > 0)) return;
    const prTick = () => this.syncOpenPrs().catch((e) => console.warn('github PR sync failed:', (e as Error).message));
    this.prTimer = setInterval(prTick, prSeconds * 1000);
    setTimeout(prTick, 15_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.prTimer) clearInterval(this.prTimer);
  }

  /** The poll that runs now: a tick that meets it is skipped (DISP-230). */
  private syncingAll = false;

  /**
   * Sessions worth checking: work sessions with a branch, not ended more than 14 days ago. An idle
   * work session never ends, so one with no open PR and nothing new for 14 days is left too
   * (DISP-241: each costs GitHub calls every tick). One session that fails (a sleeping worker, a
   * deleted repo) is skipped, not the rest (DISP-230).
   */
  async syncAll() {
    if (this.syncingAll) return;
    this.syncingAll = true;
    try {
      const cutoff = Date.now() - 14 * 86400_000;
      const sessions = this.store.sessions({ kind: 'work', limit: 500 }).filter(
        (s) => s.branch && s.status !== 'queued' && (!s.ended_at || Date.parse(s.ended_at) > cutoff),
      );
      for (const s of sessions) {
        const open = this.store.prs({ session_id: s.id });
        if (open.every((p) => p.state !== 'open') && ((open.length && s.ended_at) || Date.parse(s.updated_at) < cutoff)) continue;
        try {
          await this.syncSession(s);
        } catch (e) {
          console.warn(`github sync of session #${s.id} failed:`, (e as Error).message);
        }
      }
    } finally {
      this.syncingAll = false;
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
        if (repo.kind === 'hosted') {
          // a PR the owner chose to open on the upstream, then the review in Dispatch
          const t = this.target(repo);
          const reader = t ? this.as(s, repo, 'read').octo : null;
          if (t && reader) {
            const { data } = await reader.pulls.list({ owner: t.owner, repo: t.repo, head: `${t.owner}:${s.branch}`, state: 'all', per_page: 5 });
            for (const p of data) out.push(await this.record(s, repo, p as GhPull));
            // the review moved to GitHub, but sessions push to Dispatch's repo: bring new commits over
            const open = out.find((p) => p.repo_id === repo.id && p.number > 0 && p.state === 'open');
            if (open) {
              const st = await this.hosted!.branchStatus(repo, s.branch);
              if (st.exists && st.head_sha !== open.head_sha) {
                let env: Record<string, string> | null = null;
                try {
                  env = this.as(s, repo, 'write').gitEnv; // the starter's push, or none
                } catch (e) {
                  console.warn(`not updating ${t.owner}/${t.repo} ${s.branch}:`, (e as Error).message);
                }
                const pushed = env && await this.hosted!.pushUpstream(repo, this.gitUrl(t.owner, t.repo), [`refs/heads/${s.branch}`], env);
                if (pushed && !pushed.ok) console.warn(`could not update ${t.owner}/${t.repo} ${s.branch}:`, pushed.output.slice(0, 200));
              }
            }
          }
          const pr = await this.syncHosted(s, repo);
          if (pr) out.push(pr);
          continue;
        }
        const reader = this.as(s, repo, 'read').octo;
        if (!reader) continue;
        const { data } = await reader.pulls.list({ owner: repo.github_owner, repo: repo.github_name, head: `${repo.github_owner}:${s.branch}`, state: 'all', per_page: 5 });
        for (const p of data) out.push(await this.record(s, repo, p as GhPull));
      }
    } finally {
      this.flushMergeNotice(s.id); // every repo of the session is through: one notice for all
    }
    return out;
  }

  /** A PR changed state (merged, closed, opened): queued batches may now start. */
  onPrChange: (() => void) | null = null;
  /** A deploy after a merge was sent to the worker, or could not be (app.ts wires both to the orchestration). */
  onDeployStarted: ((s: Session, repo: Repo) => void) | null = null;
  /** True: the session is a step's batch and its orchestration tells the failure (DISP-103). */
  onDeployFailed: ((s: Session, repo: Repo) => boolean | void) | null = null;

  /** Delete a merged PR's head branch on GitHub (no error if it is already gone), as the session's starter. */
  async deleteRemoteBranch(repo: Repo, branch: string, s: Session | null): Promise<boolean> {
    if (repo.kind === 'hosted') return this.hosted?.deleteBranch(repo, branch) ?? false;
    if (repo.local_path) return false;
    const octo = this.as(s, repo, 'write').octo;
    if (!octo) return false;
    try {
      await octo.git.deleteRef({ owner: repo.github_owner, repo: repo.github_name, ref: `heads/${branch}` });
      return true;
    } catch (e) {
      const code = (e as { status?: number }).status;
      if (code === 404 || code === 422) return false; // already deleted (often by GitHub itself)
      throw e;
    }
  }

  /** Auto-merge outcomes per session, sent as one notice (a session can change several repos). */
  private mergeNotices = new Map<number, { s: Session; merged: string[]; deploys: boolean; stopped: { label: string; why: string; prId: number }[]; timer: NodeJS.Timeout }>();

  private queueMergeNotice(s: Session, outcome: { merged: string; deploys: boolean } | { stopped: string; why: string; prId: number }) {
    const cur = this.mergeNotices.get(s.id) ?? { s, merged: [], deploys: false, stopped: [], timer: undefined as unknown as NodeJS.Timeout };
    clearTimeout(cur.timer);
    if ('merged' in outcome) {
      cur.merged.push(outcome.merged);
      cur.deploys ||= outcome.deploys;
    }
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
    const { s, merged, deploys, stopped } = n;
    const project_id = s.project_id ?? undefined;
    if (stopped.length) {
      const body = stopped.map((x) => `${x.label}: ${x.why}`).join('\n') + (merged.length ? `\nMerged: ${merged.join(', ')}` : '');
      this.tellStarter(s, { title: `${s.project_key}: not auto-merged`, body, url: stopped.length === 1 && !merged.length ? `/pr/${stopped[0].prId}` : `/s/${s.id}`, tag: `automerge-${s.id}`, project_id }, 'routine');
      return;
    }
    // a deploy follows: its result is the one notice for this turn (sessions.ts, DISP-40)
    if (deploys) return;
    // the one notice for this turn: what Claude said it did, now merged
    const summary = this.store.session(s.id)?.last_text;
    this.tellStarter(s, {
      title: `${s.project_key}: done and merged${merged.length > 1 ? ` (${merged.length} repos)` : ''}`,
      body: summary || merged.join(', '),
      url: `/s/${s.id}`, tag: `merged-${s.id}`, project_id,
    }, 'routine');
  }

  /** A step's batch tells its orchestration instead of the owner (app.ts wires it, DISP-122). True: it took the notice. */
  childNotice: ((s: Session, n: Notice, kind: ChildNoticeKind) => boolean) | null = null;

  /** A session's notice to whoever started it, unless its orchestration takes it. */
  private tellStarter(s: Session, n: Notice, kind: ChildNoticeKind) {
    if (s.orchestrator_id && this.childNotice?.(s, n, kind)) return;
    void this.notifier.send(n, s.started_by);
  }

  /**
   * Local repos have no PRs: a session branch pushed into the folder, with commits the default
   * branch lacks, is shown as a review entry (number = -session id) until it is merged.
   */
  private async syncLocal(s: Session, repo: Repo): Promise<PullRequest | null> {
    const known = this.store.prs({ session_id: s.id }).find((p) => p.repo_id === repo.id);
    const st = await this.hub.cmd<BranchStatus>(s.worker_id, { c: 'branch_status', repo, branch: s.branch!, last_sha: known?.head_sha }, 120_000);
    return this.recordBranch(s, repo, st, known);
  }

  /** A local or hosted review entry from its branch's state. */
  private async recordBranch(s: Session, repo: Repo, st: BranchStatus, known: PullRequest | undefined): Promise<PullRequest | null> {
    // the branch was deleted: an open review ends, merged when its last commit is in the default branch (DISP-248)
    if (!st.exists && known?.state === 'open') {
      return this.recordRow(s, repo, { ...known, state: st.merged ? 'merged' : 'closed' });
    }
    if (!st.exists || (!st.merged && st.ahead === 0)) return known ?? null;
    if (st.merged && !known) return null; // nothing was ever offered for review
    if (!st.differs && !known) return null; // same tree as the default branch (rewritten under it): nothing to review, DISP-33
    return this.recordRow(s, repo, {
      number: -s.id, url: '', title: s.title, state: st.merged ? 'merged' : 'open',
      mergeable: !st.conflicts, mergeable_state: st.conflicts ? 'dirty' : 'clean', head_ref: s.branch!, head_sha: st.head_sha, fork_sha: st.fork_sha,
    });
  }

  /**
   * A hosted repo's session branch, read on the server (no worker needed): a review entry like a
   * local repo's. It stays as it is once merged here, or once the owner moved the review to a PR on
   * the upstream.
   */
  private async syncHosted(s: Session, repo: Repo): Promise<PullRequest | null> {
    const known = this.store.prs({ session_id: s.id }).find((p) => p.repo_id === repo.id && p.number < 0);
    if (known && known.state !== 'open') return known;
    return this.recordBranch(s, repo, await this.hosted!.branchStatus(repo, s.branch!, known?.head_sha), known);
  }

  /** Merges pushed to a hosted repo's upstream that failed, told once each. */
  private upstreamToldFor = new Set<string>();

  /**
   * After a merge into a hosted repo: push its default branch to the upstream, if there is one.
   * Returns the failed push's output (null: pushed, or nothing to push to).
   */
  private async pushUpstreamAfterMerge(repo: Repo, s: Session): Promise<string | null> {
    const t = this.target(repo);
    if (!t || !this.hosted) return null;
    let res: { ok: boolean; output: string };
    try {
      res = await this.hosted.pushUpstream(repo, this.gitUrl(t.owner, t.repo), [`refs/heads/${repo.default_branch}`], this.as(s, repo, 'write').gitEnv);
    } catch (e) {
      res = { ok: false, output: (e as Error).message }; // the starter may not push to GitHub
    }
    if (res.ok) return null;
    const why = res.output.split('\n').slice(-3).join(' ').slice(0, 300);
    const key = `${repo.id}:${s.id}`;
    if (this.upstreamToldFor.has(key)) return why;
    this.upstreamToldFor.add(key);
    this.store.addEvent(s.id, { kind: 'error', text: `Merged in Dispatch, but pushing ${repo.default_branch} to ${t.owner}/${t.repo} failed: ${why}` });
    this.tellStarter(s, { title: `${s.project_key}: merged, but not pushed to GitHub`, body: `${t.owner}/${t.repo}: ${why}`, url: `/s/${s.id}`, tag: `upstream-${repo.id}`, project_id: s.project_id ?? undefined }, 'needs_owner');
    return why;
  }

  /** A PR on the upstream was merged: bring the result into the hosted repo (fast-forward only). */
  private async pullUpstream(repo: Repo, s: Session) {
    const t = this.target(repo);
    if (!t || !this.hosted) return;
    const res = await this.hosted.fetchUpstreamDefault(repo, this.gitUrl(t.owner, t.repo), this.as(s, repo, 'read').gitEnv);
    if (!res.ok) this.store.addEvent(s.id, { kind: 'error', text: `The PR was merged on GitHub, but ${repo.default_branch} here could not follow (it has commits GitHub lacks): ${res.output.slice(0, 300)}` });
  }

  /**
   * Review on GitHub instead of in Dispatch: push the session branch to the hosted repo's upstream
   * and open a PR there. The review entry in Dispatch closes; the PR takes its place.
   */
  async openUpstreamPr(prId: number) {
    const pr = this.store.pr(prId);
    if (!pr) throw new HttpError(404, 'Unknown PR');
    const repo = this.store.repo(pr.repo_id)!;
    if (repo.kind !== 'hosted' || !pr.local || pr.state !== 'open') throw new HttpError(400, 'Only an open review of a hosted repo can move to GitHub.');
    const t = this.target(repo);
    if (!t) throw new HttpError(400, `${repo.github_name} has no GitHub repo to open a PR on. Link one in the repo's settings.`);
    const s = this.sessionOf(pr)!;
    const acting = this.as(s, repo, 'write');
    const octo = this.mustClient(acting.octo, repo);
    const pushed = await this.hosted!.pushUpstream(repo, this.gitUrl(t.owner, t.repo), [`refs/heads/${pr.head_ref}`], acting.gitEnv);
    if (!pushed.ok) throw new Error(`Pushing ${pr.head_ref} to ${t.owner}/${t.repo} failed: ${pushed.output.slice(0, 300)}`);
    const keys = this.store.itemsByIds(s.item_ids).map((i) => i.key);
    const body = `From Dispatch session #${s.id}${keys.length ? ` (${keys.join(', ')})` : ''}.`;
    const { data } = await octo.pulls.create({ owner: t.owner, repo: t.repo, head: pr.head_ref, base: repo.default_branch, title: s.title, body });
    const opened = await this.record(s, repo, data as GhPull);
    this.store.upsertPr({ session_id: s.id, repo_id: repo.id, number: pr.number, url: pr.url, title: pr.title, state: 'closed', mergeable: pr.mergeable, mergeable_state: pr.mergeable_state, head_ref: pr.head_ref, head_sha: pr.head_sha });
    this.bus.emit({ t: 'pr', pr: this.store.pr(pr.id)! });
    return opened;
  }

  /** `caller`: who reads a PR that has no session (none: the env account). */
  async syncPr(prId: number, caller?: Caller | null) {
    const pr = this.store.pr(prId);
    if (!pr) throw new Error('Unknown PR');
    const repo = this.store.repo(pr.repo_id)!;
    if (repo.local_path) return (await this.syncLocal(this.sessionOf(pr)!, repo)) ?? pr;
    if (repo.kind === 'hosted' && pr.local) return (await this.syncHosted(this.sessionOf(pr)!, repo)) ?? pr;
    const t = this.mustTarget(repo);
    const { data } = await this.reader(pr, repo, caller).pulls.get({ owner: t.owner, repo: t.repo, pull_number: pr.number });
    // read again: a session may have taken the PR while GitHub answered
    const s = this.sessionOf(this.store.pr(prId)!);
    return s ? this.record(s, repo, data as GhPull) : this.recordUnlinked(repo, data as GhPull);
  }

  /** Who reads a PR on GitHub: its session's starter, or, with no session, the caller. */
  private reader(pr: Pick<PullRequest, 'session_id'>, repo: Repo, caller?: Caller | null): Octokit {
    const s = this.sessionOf(pr);
    return s ? this.client(s, repo, 'read') : this.mustClient(this.asCaller(caller, repo, 'read').octo, repo);
  }

  /**
   * Store a GitHub PR that has no session (DISP-111): the row and what the list shows, nothing
   * else. No item moves, no notice, no auto-merge. `ci`: its checks' state, when they were read.
   */
  private recordUnlinked(repo: Repo, p: GhPull, ci?: CiState | null): PullRequest {
    const before = this.store.prByNumber(repo.id, p.number);
    const state: PullRequest['state'] = p.merged_at || p.merged ? 'merged' : p.state === 'open' ? 'open' : 'closed';
    const row = this.store.upsertPr({
      session_id: null, repo_id: repo.id, number: p.number, url: p.html_url, title: p.title, state,
      // the list of open PRs does not say: keep what is known
      mergeable: p.mergeable === undefined ? before?.mergeable ?? null : p.mergeable, mergeable_state: p.mergeable_state ?? before?.mergeable_state ?? null,
      head_ref: p.head.ref, head_sha: p.head.sha,
    });
    this.store.setPrMeta(row.id, this.metaOf(p, ci));
    return this.emitIfChanged(before, row.id);
  }

  /** What a GitHub PR says for the columns of the project's list (only what it carries). */
  private metaOf(p: GhPull, ci?: CiState | null): Parameters<Store['setPrMeta']>[1] {
    return {
      author: p.user?.login ?? null, draft: !!p.draft,
      ...(p.base ? { base_ref: p.base.ref } : {}),
      ...(p.changed_files === undefined ? {} : { changed_files: p.changed_files }),
      ...(p.updated_at ? { gh_updated_at: p.updated_at } : {}),
      ...(ci === undefined ? {} : { ci_state: ci }),
    };
  }

  /** Tell the screens about a PR row, when it is not as it was. */
  private emitIfChanged(before: PullRequest | undefined, id: number): PullRequest {
    const same = (p: PullRequest | undefined) => JSON.stringify({ ...p, last_synced: null });
    const pr = this.store.pr(id)!;
    if (same(before) !== same(pr)) this.bus.emit({ t: 'pr', pr });
    return pr;
  }

  /** Per project: the PR sync that runs now, and how the last one went (kept in memory). */
  private prSyncs = new Map<number, { full: boolean; done: Promise<void> }>();
  private prSynced = new Map<number, { synced_at: string | null; error: string | null }>();

  /** When a project's open PRs were last synced, and what went wrong then (null: nothing). */
  prSyncInfo(projectId: number): { synced_at: string | null; error: string | null } {
    return this.prSynced.get(projectId) ?? { synced_at: null, error: null };
  }

  /** The timer's sync: the open PRs of every project that is not disabled, with the env accounts. */
  async syncOpenPrs() {
    for (const p of this.store.projects()) if (!p.disabled) await this.syncProjectPrs(p);
  }

  /**
   * Bring the open PRs of a project's GitHub repos into Dispatch (DISP-111), with or without a
   * session. One run per project at a time. `full`: read every PR's details again, also the
   * unchanged ones. `caller`: who reads (none: the env account).
   */
  syncProjectPrs(project: Pick<Project, 'id'>, opts: { full?: boolean; caller?: Caller | null } = {}): Promise<void> {
    const running = this.prSyncs.get(project.id);
    // a refresh that meets the timer's run still gets its full run, after it
    if (running) return opts.full && !running.full ? running.done.then(() => this.syncProjectPrs(project, opts)) : running.done;
    const done = (async () => {
      let error: string | null = null;
      let read = 0;
      for (const repo of this.store.repos(project.id)) {
        if (repo.local_path || repo.kind === 'hosted') continue;
        try {
          if (await this.syncRepoPrs(repo, opts)) read++;
        } catch (e) {
          error ??= `${repo.github_owner}/${repo.github_name}: ${(e as Error).message}`;
        }
      }
      // the timer with no account to read with has nothing to say: the list stays as its last reader left it
      if (read || error) this.prSynced.set(project.id, { synced_at: new Date().toISOString(), error });
    })().finally(() => this.prSyncs.delete(project.id));
    this.prSyncs.set(project.id, { full: !!opts.full, done });
    return done;
  }

  /** false: no account reads this repo, and nobody asked (the timer skips it; for a caller it is an error). */
  private async syncRepoPrs(repo: Repo, opts: { full?: boolean; caller?: Caller | null }): Promise<boolean> {
    const found = this.asCaller(opts.caller, repo, 'read').octo;
    if (!found && !opts.caller) return false;
    const octo = this.mustClient(found, repo);
    const o = { owner: repo.github_owner, repo: repo.github_name };
    const listed = await octo.paginate(octo.pulls.list, { ...o, state: 'open', per_page: 100 }) as GhPull[];
    const numbers = new Set(listed.map((p) => p.number));
    for (const p of listed) {
      const row = this.store.prByNumber(repo.id, p.number);
      // what the list does not give (changed files, mergeable, checks) is read only when it may have changed
      const changed = !row || row.gh_updated_at !== p.updated_at || (row.session_id === null && row.head_sha !== p.head.sha);
      const unsettled = !!row && (row.ci_state === null || row.ci_state === 'pending'
        || (row.ci_state === 'none' && Date.now() - Date.parse(p.updated_at ?? '') < CHECKS_MAY_START_MS));
      if (!opts.full && !changed && !unsettled) continue;
      const full = (await octo.pulls.get({ ...o, pull_number: p.number })).data as GhPull;
      const ci = await this.checkRunsWith(octo, repo, full.head.sha).then(ciStateOf, () => null);
      // read again: a session may have taken the PR while GitHub answered
      const now = this.store.prByNumber(repo.id, p.number);
      if (now && now.session_id !== null) {
        // a session's PR: title, state and every side effect stay with the session sync
        this.store.setPrMeta(now.id, this.metaOf(full, ci));
        this.emitIfChanged(now, now.id);
      } else this.recordUnlinked(repo, full, ci);
    }
    // open here, gone from the list: closed or merged on GitHub (a session's PR goes its session's way)
    for (const row of this.store.prs({ repo_id: repo.id, open_only: true })) {
      if (row.number > 0 && !numbers.has(row.number)) await this.syncPr(row.id, opts.caller);
    }
    return true;
  }

  /**
   * The CI results for a commit: GitHub's check runs, or, when the token may not read them (a
   * fine-grained PAT has no Checks permission), the GitHub Actions runs for the commit (Actions: read).
   * Every page of them, and the commit statuses too (Woodpecker, Jenkins: DISP-231).
   */
  private checkRuns(s: Session | null | undefined, repo: Repo, sha: string, perPage = 100): Promise<Check[]> {
    return this.checkRunsWith(this.client(s, repo, 'read'), repo, sha, perPage);
  }

  private async checkRunsWith(octo: Octokit, repo: Repo, sha: string, perPage = 100): Promise<Check[]> {
    const t = this.mustTarget(repo);
    const [runs, statuses] = await Promise.all([this.runsOf(octo, t, sha, perPage), this.statusesOf(octo, t, sha)]);
    return [...runs, ...statuses];
  }

  private async runsOf(octo: Octokit, t: { owner: string; repo: string }, sha: string, perPage: number): Promise<Check[]> {
    try {
      return await allPages(perPage, async (page) => {
        const { data } = await octo.checks.listForRef({ owner: t.owner, repo: t.repo, ref: sha, per_page: perPage, page });
        return { items: data.check_runs, total: data.total_count };
      });
    } catch (e) {
      if ((e as { status?: number }).status !== 403) throw e;
      const runs = await allPages(perPage, async (page) => {
        const { data } = await octo.actions.listWorkflowRunsForRepo({ owner: t.owner, repo: t.repo, head_sha: sha, per_page: perPage, page });
        return { items: data.workflow_runs, total: data.total_count };
      });
      return runs.map((r) => ({ name: r.name ?? 'workflow', status: r.status ?? 'queued', conclusion: r.conclusion ?? null, html_url: r.html_url }));
    }
  }

  /**
   * A commit's statuses (the latest per context), as checks: pending runs, failure and error fail.
   * A token that may not read them gives none; auto-merge still sees GitHub's `unstable` state.
   */
  private async statusesOf(octo: Octokit, t: { owner: string; repo: string }, sha: string): Promise<Check[]> {
    let statuses: { context: string; state: string; target_url?: string | null }[];
    try {
      statuses = (await octo.repos.getCombinedStatusForRef({ owner: t.owner, repo: t.repo, ref: sha, per_page: 100 })).data.statuses;
    } catch (e) {
      if ((e as { status?: number }).status !== 403) throw e;
      return [];
    }
    return statuses.map((x) => ({
      name: x.context, status: x.state === 'pending' ? 'in_progress' : 'completed',
      conclusion: x.state === 'pending' ? null : x.state, html_url: x.target_url ?? null,
    }));
  }

  /** The worker that holds a PR's branch: its session's. */
  private workerOf(pr: PullRequest) {
    return this.sessionOf(pr)?.worker_id ?? null;
  }

  /** Called when auto-merge waits because the branch is behind (app.ts sends the agent a message). */
  onBehind: ((s: Session, repo: Repo, behind: number) => void) | null = null;

  /**
   * Commits on the default branch that the PR / local branch does not have yet, and whether its
   * tree differs from the default branch's (always true for GitHub PRs: not checked there).
   */
  private async behindBy(repo: Repo, pr: PullRequest, caller?: Caller | null): Promise<{ behind: number; differs: boolean }> {
    if (repo.local_path) {
      const st = await this.hub.cmd<BranchStatus>(this.workerOf(pr), { c: 'branch_status', repo, branch: pr.head_ref }, 120_000);
      return { behind: st.behind, differs: st.differs };
    }
    if (repo.kind === 'hosted' && pr.local) {
      const st = await this.hosted!.branchStatus(repo, pr.head_ref);
      return { behind: st.behind, differs: st.differs };
    }
    const t = this.mustTarget(repo);
    const { data } = await this.reader(pr, repo, caller).repos.compareCommits({ owner: t.owner, repo: t.repo, base: repo.default_branch, head: pr.head_sha ?? pr.head_ref });
    return { behind: data.behind_by, differs: true };
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

  /** The refusal for a session whose starter was taken off AUTH_USERS (DISP-200, DISP-226); null while they may act. */
  private starterRemoved(s: Session): IdentityRefusal | null {
    const id = this.identityOf(s);
    return isRefusal(id) && id.code === 'user_removed' ? id : null;
  }

  /** When auto-merge first saw a PR head with no checks, by `prId:sha`. */
  private noChecksSince = new Map<string, number>();

  /**
   * A head with no checks yet in a repo whose PRs had checks before: they may still start, for
   * CHECKS_MAY_START_MS after auto-merge first saw it. A repo without CI merges at once.
   */
  private checksMayStart(repo: Repo, pr: PullRequest): boolean {
    const hasCi = this.store.prs({ repo_id: repo.id }).some((p) => p.id !== pr.id && p.ci_state !== null && p.ci_state !== 'none');
    if (!hasCi) return false;
    const key = `${pr.id}:${pr.head_sha}`;
    const since = this.noChecksSince.get(key) ?? Date.now();
    this.noChecksSince.set(key, since);
    return Date.now() - since < CHECKS_MAY_START_MS;
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
    // a starter taken off AUTH_USERS: nothing merges or deploys for them, in any kind of repo (DISP-226)
    const removed = this.starterRemoved(s);
    if (removed) return note(removed.message);
    // only a clean turn end merges by itself: not one that an error or an interrupted wait for the usage limit ended (DISP-108)
    if (s.unclean) return note(`${UNCLEAN}: ${s.unclean}. It waits for you`);
    if (pr.blocked?.startsWith(UNCLEAN)) {
      this.store.setPrBlocked(pr.id, null);
      this.bus.emit({ t: 'pr', pr: this.store.pr(pr.id)! });
    }
    if (pr.mergeable === null) return; // GitHub is still computing it
    if (pr.mergeable === false) return note('it has merge conflicts');
    // GitHub refused to merge this head already (DISP-209), or the merge failed here (DISP-233):
    // no more tries until the head moves (the owner's own merge is not held back)
    const refusedKey = `${pr.id}:${pr.head_sha}:refused`;
    if (this.autoMergeNoted.has(refusedKey)) return;
    const repo = this.store.repo(pr.repo_id)!;
    if (s.options.base_check) {
      // tested against an older default branch? have the agent bring the branch up to date first
      const { behind, differs } = await this.behindBy(repo, pr);
      // a branch with the default branch's tree has nothing to bring up to date (DISP-33)
      if (behind > 0 && differs) {
        const key = `${pr.id}:${pr.head_sha}:behind`;
        const commits = `${behind} commit${behind === 1 ? '' : 's'}`;
        // asked already, and its turn ended on the same head: it did not update, so the owner decides
        // (else the batch would show "checking" with nothing left to check, DISP-32)
        if (this.autoMergeNoted.has(key)) return note(`it is still ${commits} behind ${repo.default_branch} after Claude was asked to update it. It waits for you`);
        this.autoMergeNoted.add(key);
        this.store.addEvent(s.id, { kind: 'system', text: `Auto-merge into ${repoName} waits for ${ref}: the branch is ${commits} behind ${repo.default_branch}. Asked the agent to update it.` });
        this.store.addMergeEvent(s.id, 'asked_update', pr.id, `${commits} behind`);
        this.onBehind?.(s, repo, behind);
        this.tell(s.id); // the agent goes on working: no "waiting for you" yet
        return;
      }
    }
    const checks = pr.head_sha && !pr.local ? await this.checkRuns(s, repo, pr.head_sha) : [];
    if (pr.head_sha && !pr.local) {
      const ci = ciStateOf(checks);
      this.store.setPrMeta(pr.id, { ci_state: ci });
      // a head pushed just before the turn ended: its runs may not be registered yet (DISP-231)
      if (ci === 'none' && this.checksMayStart(repo, pr)) return;
    }
    if (checks.some((c) => c.status !== 'completed')) return; // wait for them
    const bad = checks.filter((c) => !['success', 'neutral', 'skipped'].includes(c.conclusion ?? ''));
    if (bad.length) return note(`checks failed (${bad.map((c) => c.name).join(', ')})`);
    // GitHub sees a status or check that is not green, which this read did not (DISP-231)
    if (pr.mergeable_state === 'unstable') return note('GitHub says its checks are not all green (unstable)');
    let res: Awaited<ReturnType<GitHub['merge']>>;
    try {
      // pinned to the head whose checks were read (DISP-210): GitHub refuses it if the branch moved on
      res = await this.merge(pr.id, how, 'squash', null, pr.local ? undefined : pr.head_sha ?? undefined);
    } catch (e) {
      // GitHub's 4xx (branch protection, a review it needs): told once, not tried again for this head.
      // A 5xx, a network error, or Dispatch's own refusal (no `response`; e.g. a starter taken off
      // AUTH_USERS, which can change without a new head) is tried again at the next sync.
      const { status, response } = e as { status?: number; response?: unknown };
      // the head moved since its checks were read (GitHub's 409, or Dispatch's own for a local merge, DISP-232): the next sync reads the new one
      if (status === 409) return;
      if (!response || !status || status < 400 || status >= 500) throw e;
      this.autoMergeNoted.add(refusedKey);
      return note(`GitHub refused the merge: ${(e as Error).message.slice(0, 200)}`);
    }
    if (!res.ok) {
      this.autoMergeNoted.add(refusedKey);
      return note(res.conflict ? 'local merge hit conflicts' : `local merge failed: ${res.output.slice(0, 200)}`);
    }
    this.store.addEvent(s.id, { kind: 'system', text: `Auto-merged into ${repoName}: ${ref} (${how === 'github' && !pr.local ? 'squash on GitHub' : 'local merge'}).` });
    this.tell(s.id);
    this.queueMergeNotice(s, { merged: label, deploys: !!repo.deploy_command });
  }

  /** Store a GitHub PR and apply side effects of state changes. */
  private async record(s: Session, repo: Repo, p: GhPull): Promise<PullRequest> {
    let full = p;
    if (p.state === 'open' && p.mergeable === undefined) {
      const t = this.mustTarget(repo);
      full = (await this.client(s, repo, 'read').pulls.get({ owner: t.owner, repo: t.repo, pull_number: p.number })).data as GhPull;
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
    // a hosted repo's PR merged on GitHub: its default branch here follows
    if (repo.kind === 'hosted' && row.number > 0 && state === 'merged' && before?.state !== 'merged') await this.pullUpstream(repo, s);
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
      if (s.options.auto_merge === 'off') this.tellStarter(s, {
        title: pr.local ? `${s.project_key}: branch ready for review` : `${s.project_key}: PR ready`,
        body: pr.local ? `${pr.head_ref} · ${pr.title}` : `#${pr.number} ${pr.title}`,
        url: `/pr/${pr.id}`, tag: `pr-${pr.id}`, project_id: s.project_id ?? undefined,
      }, 'routine');
    }
    if (pr.state !== 'open') {
      const all = this.store.prs({ session_id: s.id });
      if (all.some((p) => p.state === 'open')) return;
      // one PR merged and the others closed (in either order) is done too (DISP-241)
      if (all.some((p) => p.state === 'merged')) {
        for (const it of items) if (it.status !== 'done' && it.status !== 'canceled') this.bus.emit({ t: 'item', item: this.store.updateItem(it.id, { status: 'done' }) });
      } else {
        for (const it of items) if (it.status === 'in_review') this.bus.emit({ t: 'item', item: this.store.updateItem(it.id, { status: 'todo' }) });
      }
    }
  }

  /** `caller`: who reads a PR that has no session (none: the env account). */
  async detail(prId: number, caller?: Caller | null): Promise<PrDetail> {
    const pr = await this.syncPr(prId, caller);
    const repo = this.store.repo(pr.repo_id)!;
    // no session: no worker, so nothing that needs one (a generate command's merge, the deploy command)
    const merge = this.sessionOf(pr) ? { merge_note: null, merge_here: true }
      : repo.generate_command ? { merge_note: NO_MERGE_GENERATE, merge_here: false }
      : { merge_note: repo.deploy_command ? NO_DEPLOY : null, merge_here: true };
    const auto_merge = this.sessionOf(pr)?.options.auto_merge ?? 'off';
    const hands = pr.session_id === null ? [] : this.store.mergeEvents(pr.session_id);
    // merged: the branch is in the default branch (and may be deleted); show it from its last commit
    const merged_sha = pr.state === 'merged' && pr.head_sha ? pr.head_sha : undefined;
    if (repo.local_path) {
      const files = await this.hub.cmd<BranchFile[]>(this.workerOf(pr), { c: 'branch_diff', repo, branch: pr.head_ref, merged_sha, fork_sha: pr.fork_sha }, 120_000);
      return { pr, repo: this.repoSummary(repo), hands, body: '', base_ref: repo.default_branch, files, checks: [], auto_merge, ...merge };
    }
    if (repo.kind === 'hosted' && pr.local) {
      const files = await this.hosted!.branchDiff(repo, pr.head_ref, merged_sha, pr.fork_sha);
      return { pr, repo: this.repoSummary(repo), hands, body: '', base_ref: repo.default_branch, files, checks: [], auto_merge, ...merge };
    }
    const o = this.mustTarget(repo);
    const octo = this.reader(pr, repo, caller);
    const [{ data: p }, files, checks] = await Promise.all([
      octo.pulls.get({ ...o, pull_number: pr.number }),
      octo.paginate(octo.pulls.listFiles, { ...o, pull_number: pr.number, per_page: 100 }),
      // null: they could not be read
      pr.head_sha ? this.checkRunsWith(octo, repo, pr.head_sha, 50).catch(() => null) : Promise.resolve(null),
    ]);
    // read anyway: the project's list shows it (DISP-111)
    this.store.setPrMeta(pr.id, { changed_files: files.length, base_ref: p.base.ref, ...(checks ? { ci_state: ciStateOf(checks) } : {}) });
    return {
      pr: this.emitIfChanged(pr, pr.id),
      repo: this.repoSummary(repo),
      hands,
      body: p.body ?? '',
      base_ref: p.base.ref,
      files: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ?? null })),
      checks: (checks ?? []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion ?? null, url: c.html_url ?? null })),
      auto_merge, ...merge,
    };
  }

  /** PRs being merged now (auto or by the owner), with the repo's check: the inbox shows them as merging. */
  readonly mergingNow = new Set<number>();

  /** A merge is in flight: a restart of the server now would cut it off (DISP-112). */
  busy() {
    return this.merging.size > 0 || this.mergingNow.size > 0;
  }

  /**
   * Approve a PR on GitHub (DISP-111): kept on the PR in Dispatch first, then sent to GitHub as the
   * caller's review. A review GitHub does not take (your own PR, a token that may not review, no
   * GitHub connection) is no error: the approval stays, with what happened. `sha`: the head commit
   * the caller looked at; when the branch moved on since, nothing is approved.
   */
  async approve(prId: number, caller: Caller, sha?: string): Promise<PullRequest> {
    const pr = this.store.pr(prId);
    if (!pr) throw new Error('Unknown PR');
    if (pr.state !== 'open' || pr.number <= 0 || !pr.head_sha) throw refused('Only an open pull request on GitHub can be approved.');
    if (sha && sha !== pr.head_sha) throw moved();
    const repo = this.store.repo(pr.repo_id)!;
    const t = this.mustTarget(repo);
    this.store.setPrApproval(pr.id, { by: caller.name, sha: pr.head_sha });
    try {
      const octo = this.mustClient(this.asCaller(caller, repo, 'write').octo, repo);
      await octo.pulls.createReview({ owner: t.owner, repo: t.repo, pull_number: pr.number, event: 'APPROVE', commit_id: pr.head_sha });
      this.store.setPrReview(pr.id, 'sent', null);
    } catch (e) {
      const own = (e as { status?: number }).status === 422 && /own pull request/i.test((e as Error).message);
      this.store.setPrReview(pr.id, own ? 'own_pr' : 'failed', own ? OWN_PR : (e as Error).message);
    }
    return this.emitIfChanged(pr, pr.id);
  }

  /**
   * `caller`: who merges a PR that has no session (a session's PR merges as its starter). `sha`: the
   * head commit the caller looked at; a branch that moved on since is not merged (GitHub checks it too).
   */
  async merge(prId: number, how: 'github' | 'local', method: 'squash' | 'merge' | 'rebase', caller?: Caller | null, sha?: string) {
    const pr = this.store.pr(prId);
    if (!pr) throw new Error('Unknown PR');
    if (pr.state !== 'open') throw new Error(`PR is ${pr.state}`);
    if (sha && sha !== pr.head_sha) throw moved();
    if (!this.sessionOf(pr)) {
      // no session: no worker to merge on, so only GitHub's own merge
      const repo = this.store.repo(pr.repo_id)!;
      if (repo.generate_command) throw refused(NO_MERGE_GENERATE);
      if (how === 'local' || pr.local) throw refused(NO_SESSION);
    }
    this.mergingNow.add(prId);
    this.bus.emit({ t: 'pr', pr });
    try {
      const res = await this.mergeOpen(pr, how, method, caller, sha);
      if (res.ok) this.deploy(pr);
      return res;
    } finally {
      this.mergingNow.delete(prId);
      this.bus.emit({ t: 'pr', pr: this.store.pr(prId)! });
    }
  }

  /**
   * After a merge: run the repo's deploy command on the session's worker (DISP-37). It reports
   * back on its own (sessions.ts, `deploy_result`): the deploy may restart this server.
   */
  deploy(pr: PullRequest) {
    const repo = this.store.repo(pr.repo_id);
    const s = this.sessionOf(pr);
    if (!repo?.deploy_command || !s) return;
    const name = pr.repo_full_name.split('/').pop();
    // as the starter (their credential: the worker forgets it when the session closes)
    if (this.hub.send(s.worker_id, { t: 'deploy', session_id: s.id, repo, github: this.credOf(s) })) {
      this.store.addEvent(s.id, { kind: 'system', text: `Deploying ${name}: ${repo.deploy_command}` });
      this.onDeployStarted?.(s, repo);
      return;
    }
    const followed = this.onDeployFailed?.(s, repo) === true;
    const why = `the session's worker is not connected, so \`${repo.deploy_command}\` did not run. Deploy by hand.`;
    this.store.addEvent(s.id, { kind: 'error', text: `Deploy failed for ${name}: ${why}` });
    if (followed) return;
    this.tellStarter(s, { title: `${s.project_key}: merged, but the deploy failed`, body: `${name}: ${why}`, url: `/s/${s.id}`, tag: `deploy-${s.id}`, project_id: s.project_id ?? undefined }, 'needs_owner');
  }

  private async mergeOpen(pr: PullRequest, how: 'github' | 'local', method: 'squash' | 'merge' | 'rebase', caller?: Caller | null, sha?: string) {
    const prId = pr.id;
    const repo = this.store.repo(pr.repo_id)!;
    // a generate command runs in Dispatch's merge (DISP-56): GitHub's merge button would skip it
    if (repo.local_path || repo.generate_command) how = 'local';
    // for the sync metrics: how far behind it is now (a failed lookup is no reason not to merge)
    this.store.setPrBehindAtMerge(pr.id, await this.behindBy(repo, pr, caller).then((b) => b.behind, () => null));
    if (repo.kind === 'hosted' && pr.local) return this.mergeHosted(repo, pr, method, sha);
    if (how === 'github') {
      const t = this.mustTarget(repo);
      const s = this.sessionOf(pr);
      const octo = s ? this.client(s, repo, 'write') : this.mustClient(this.asCaller(caller, repo, 'write').octo, repo);
      await octo.pulls.merge({ owner: t.owner, repo: t.repo, pull_number: pr.number, merge_method: method, ...(sha ? { sha } : {}) });
    } else {
      const res = await this.mergeOnWorker(pr, repo, pr.local ? this.mergeMessage(pr) : `Merge #${pr.number}: ${pr.title}`, sha);
      if (!res.ok) return { ok: false as const, conflict: !!res.conflict, output: res.output ?? '' };
      // a hosted repo's PR on its upstream, merged here: GitHub closes the PR only when it gets the merge (DISP-207)
      const s = this.sessionOf(pr);
      if (repo.kind === 'hosted' && s) {
        const failed = await this.pushUpstreamAfterMerge(repo, s);
        if (failed) return { ok: false as const, conflict: false, output: `Merged here, but pushing ${repo.default_branch} to GitHub failed: ${failed}` };
      }
    }
    // GitHub needs a moment to register a pushed merge.
    for (let i = 0; i < 5; i++) {
      const synced = await this.syncPr(prId, caller);
      if (synced.state === 'merged') return { ok: true as const, pr: synced };
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { ok: true as const, pr: this.store.pr(prId)! };
  }

  /**
   * Merge a branch on the session's worker, which runs the repo's check command first. Its test
   * progress shows in the session while it runs; how long it took is kept for the next estimate.
   * The worker limits the check's run time (CHECK_TIMEOUT_MIN); here it only has to keep reporting.
   */
  private async mergeOnWorker(pr: PullRequest, repo: Repo, message: string, sha?: string) {
    type Res = { ok: boolean; conflict?: boolean; moved?: boolean; output?: string; check?: { ok: boolean; duration_ms: number; units: number }; check_reused?: boolean };
    // a GitHub repo's merge is pushed to GitHub: as the starter only. Elsewhere their name goes on the commit.
    const s = this.sessionOf(pr);
    const github = this.target(repo) && repo.kind !== 'hosted' ? this.as(s, repo, 'write').cred : this.credOf(s);
    let res: Res | undefined;
    const worker = this.workerOf(pr);
    // a hosted repo's merge comes back as a push of its default branch: only this worker's, only now (DISP-224)
    const allowPush = <T,>(fn: () => Promise<T>) => (repo.kind === 'hosted' && this.hosted && worker !== null ? this.hosted.whileMerging(repo, worker, fn) : fn());
    try {
      res = await allowPush(() => this.hub.cmd<Res>(worker, { c: 'merge_local', repo, branch: pr.head_ref, message, items: this.generatorExport(pr, repo), github, ...(sha ? { sha } : {}) }, 15 * 60_000,
        (p) => this.checks.progress(pr, repo, p as CheckProgress)));
      // the branch moved on since the caller looked at it (DISP-232)
      if (res.moved) throw moved();
      if (res.ok && res.check_reused && s) this.store.addEvent(s.id, { kind: 'system', text: `Check of ${repo.github_name} not run again for the merge: it already passed on exactly this tree (${repo.check_command}).` });
      return res;
    } finally {
      this.checks.finish(pr, repo, res?.check);
    }
  }

  /** A Dispatch merge's commit message: the batch's item keys and the title, not the branch name (DISP-57). */
  private mergeMessage(pr: PullRequest) {
    return mergeMessage(this.store.itemsByIds(this.sessionOf(pr)?.item_ids ?? []).map((i) => i.key), pr.title);
  }

  /** The items a repo's generate command gets at merge (DISP-56): the project's, with the PR's batch done. */
  private generatorExport(pr: PullRequest, repo: Repo) {
    if (!repo.generate_command) return undefined;
    const project = this.store.project(repo.project_id)!;
    return generatorItems(this.store.items(project.id), project.effort_scale, this.sessionOf(pr)?.item_ids ?? []);
  }

  /**
   * Merge a hosted repo's session branch in Dispatch: on the server, or, when the repo has a check
   * or generate command, on the session's worker (which runs the check before it pushes the merge back here).
   * Then the merged default branch goes to the upstream, if there is one.
   */
  private async mergeHosted(repo: Repo, pr: PullRequest, method: 'squash' | 'merge' | 'rebase', sha?: string) {
    const s = this.sessionOf(pr)!;
    const message = this.mergeMessage(pr);
    if (repo.check_command || repo.generate_command) {
      const res = await this.mergeOnWorker(pr, repo, message, sha);
      if (!res.ok) return { ok: false as const, conflict: !!res.conflict, output: res.output ?? '' };
    } else {
      const res = await this.hosted!.merge(repo, pr.head_ref, message, method === 'squash' ? 'squash' : 'merge', authorEnv(this.credOf(s)), sha);
      if (!res.ok && res.moved) throw moved();
      if (!res.ok) return { ok: false as const, conflict: res.conflict, output: res.output };
    }
    // a squash leaves the branch outside the history: say it is merged, do not work it out
    const merged = await this.recordRow(s, repo, {
      number: pr.number, url: pr.url, title: pr.title, state: 'merged', mergeable: pr.mergeable, mergeable_state: pr.mergeable_state, head_ref: pr.head_ref, head_sha: pr.head_sha,
    });
    await this.pushUpstreamAfterMerge(repo, s);
    return { ok: true as const, pr: merged };
  }

  /** Push the session branch (via the worker) and open a PR for it. */
  async createPr(s: Session, repoId: number) {
    const repo = this.store.repo(repoId);
    if (!repo || repo.project_id !== s.project_id || !s.branch) throw new Error('Unknown repo for this session');
    // a GitHub repo: pushed and opened as the session's starter only (local and hosted repos stay in Dispatch)
    const acting = repo.local_path || repo.kind === 'hosted' ? null : this.as(s, repo, 'write');
    await this.hub.cmd(s.worker_id, { c: 'push_branch', repo, session_id: s.id, branch: s.branch, github: acting?.cred ?? this.credOf(s) });
    if (repo.local_path || repo.kind === 'hosted') {
      const pr = repo.kind === 'hosted' ? await this.syncHosted(s, repo) : await this.syncLocal(s, repo);
      if (!pr) throw new Error('The branch has no commits beyond the default branch yet');
      return pr;
    }
    const items = this.store.itemsByIds(s.item_ids);
    const body = [`Opened from Dispatch session #${s.id}.`, '', ...items.map((i) => `- ${i.key}: ${i.title}`)].join('\n');
    const { data } = await this.mustClient(acting!.octo, repo).pulls.create({ owner: repo.github_owner, repo: repo.github_name, head: s.branch, base: repo.default_branch, title: s.title, body });
    return this.record(s, repo, data as GhPull);
  }
}

/** Page after page of a GitHub list, until a short page or the total (at most 10 pages). */
async function allPages<T>(perPage: number, read: (page: number) => Promise<{ items: T[]; total?: number }>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const { items, total } = await read(page);
    out.push(...items);
    if (items.length < perPage || out.length >= (total ?? out.length)) break;
  }
  return out;
}

/** A commit's author and committer: the user's own name and email (null: the server's, as before). */
function authorEnv(cred: GithubCred | null): Record<string, string> | undefined {
  if (!cred) return undefined;
  return { GIT_AUTHOR_NAME: cred.git_name, GIT_AUTHOR_EMAIL: cred.git_email, GIT_COMMITTER_NAME: cred.git_name, GIT_COMMITTER_EMAIL: cred.git_email };
}
