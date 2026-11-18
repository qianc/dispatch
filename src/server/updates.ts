// Dispatch's own updates (DISP-112): which version of its repo is the newest, what the install
// owner chose to do about it, and the rollout: the server first, then each worker, one at a time,
// each only in wait mode. Only a commit of the release branch is ever a target.
import { Octokit } from '@octokit/rest';
import { pick } from '../shared/accounts.ts';
import type { SelfUpdateAnswer } from '../shared/protocol.ts';
import { VERSION_RE, compareVersions } from '../shared/release.ts';
import { updateSettings, type UpdateInfo, type UpdateRow, type UpdateRunState, type UpdateSettings, type UpdateState, type UpdateWorker, type WorkerFacts } from '../shared/types.ts';
import { Refusal, verifyTarget, type ApplyResult } from '../update/apply.ts';
import type { LauncherLink } from '../update/ipc.ts';
import { APP_DIR, gitOut, sameVersion, type VersionInfo } from '../update/version.ts';
import type { Bus } from './bus.ts';
import type { Config } from './config.ts';
import type { Db, Row } from './db.ts';
import type { GitHub } from './github.ts';
import type { Notifier } from './notify.ts';
import { dropCopy } from './preUpdate.ts';
import type { Sessions } from './sessions.ts';
import type { Store } from './store.ts';
import type { UpdateResult, WorkerHub } from './workerHub.ts';
import type { Workers } from './workers.ts';

/** How the release branch and the tags are read; GitHub in real use. */
export interface ReleaseSource {
  latest(): Promise<{ branch_sha: string; branch_date: string; tags: { name: string; sha: string }[] }>;
  /** `head` against `base`, as GitHub compares: ahead (base is an ancestor of head), behind, identical or diverged */
  compare(base: string, head: string): Promise<{ status: 'ahead' | 'behind' | 'identical' | 'diverged'; ahead_by: number; commits: { sha: string; message: string }[] }>;
}

/** The first lines kept of the commits the server is behind. */
const MAX_COMMITS = 20;
/** How many of the highest version tags are looked at to find one that is on the branch. */
const TAGS_TRIED = 5;

/** Why queued sessions wait while the server is about to stop for its update. */
export const UPDATE_HOLD = 'Waiting for Dispatch to update';

/** The worker was not asked: it had no link. */
const NOT_SENT = /not connected/;
/** The worker did not answer: its link went down, or the answer did not come in time. */
const NO_ANSWER = /disconnected|timed out/;

interface Blocked { server: string | null; workers: Record<string, string> }

const toRow = (r: Row): UpdateRow => ({
  id: Number(r.id), target: r.target as UpdateRow['target'], worker_id: r.worker_id == null ? null : Number(r.worker_id), worker_name: (r.worker_name as string | null) ?? null,
  triggered_by: String(r.triggered_by), from_sha: (r.from_sha as string | null) ?? null, to_sha: String(r.to_sha), to_tag: (r.to_tag as string | null) ?? null,
  state: r.state as UpdateRunState, detail: (r.detail as string | null) ?? null, created_at: String(r.created_at), ended_at: (r.ended_at as string | null) ?? null,
});

const NO_STATE: UpdateState = { checked_at: null, for_sha: null, commit: null, tag: null, behind_by: null, on_branch: false, commits: [], error: null };
const DEFAULT_SETTINGS: UpdateSettings = { auto: false, follow: 'commits' };

export const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : 'unknown');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "owner/name" of a GitHub address, or null. */
export function repoSlug(url: string | null | undefined): string | null {
  const m = (url ?? '').trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The release branch and the tags of `repo` on GitHub. */
export function githubSource(octokit: Octokit, repo: string, branch: string): ReleaseSource {
  const [owner, name] = repo.split('/');
  return {
    async latest() {
      const b = (await octokit.repos.getBranch({ owner, repo: name, branch })).data;
      const tags: { name: string; sha: string }[] = [];
      for (let page = 1; page <= 3; page++) {
        const got = (await octokit.repos.listTags({ owner, repo: name, per_page: 100, page })).data;
        tags.push(...got.map((t) => ({ name: t.name, sha: t.commit.sha })));
        if (got.length < 100) break;
      }
      return { branch_sha: b.commit.sha, branch_date: b.commit.commit.committer?.date ?? b.commit.commit.author?.date ?? '', tags };
    },
    async compare(base, head) {
      try {
        const c = (await octokit.repos.compareCommitsWithBasehead({ owner, repo: name, basehead: `${base}...${head}`, per_page: 100 })).data;
        return { status: c.status, ahead_by: c.ahead_by, commits: c.commits.map((x) => ({ sha: x.sha, message: x.commit.message })) };
      } catch (e) {
        // a commit GitHub does not have (a local one): not on the branch
        if ((e as { status?: number }).status === 404) return { status: 'diverged', ahead_by: 0, commits: [] };
        throw e;
      }
    },
  };
}

/** A request about updates that cannot be done; the route answers with `status`. */
export class UpdateError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export interface UpdatesDeps {
  cfg: Config;
  db: Db;
  bus: Bus;
  notifier: Notifier;
  /** the commit this server runs; shared with the app, so a test can set it */
  version: VersionInfo;
  store: Store;
  hub: WorkerHub;
  sessions: Sessions;
  github: GitHub;
  workers: Workers;
  /** the database's file: its copy from before the server's own update lies next to it */
  dbFile: string;
}

export class Updates {
  /** null: Dispatch does not know its own repo */
  source: ReleaseSource | null = null;
  repo: string | null;
  readonly version: VersionInfo;
  private cfg: Config;
  private db: Db;
  private bus: Bus;
  private notifier: Notifier;
  private d: UpdatesDeps;
  private pollTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private timers = new Set<NodeJS.Timeout>();
  private checking: Promise<UpdateState> | null = null;
  /** the launcher that started this server (src/launch.ts); main.ts sets it */
  launcher: LauncherLink | null = null;
  /** the check that a commit is one of the release branch; a test replaces it */
  verify: typeof verifyTarget = verifyTarget;
  /** what the start found about the database (a copy put back after an update that did not hold) */
  restoreNote: string | null = null;
  /** how often the rollout looks whether its next step can start */
  tickMs = 30_000;
  /** a worker that is not back by then did not update */
  workerTimeoutMs = 15 * 60_000;
  /** an update of the server with no result by then failed */
  serverTimeoutMs = 60 * 60_000;
  /** after the server's start: how long the result of its own update may take to come */
  graceMs = 2 * 60_000;
  /** how long a worker may take to say whether it updates now (it fetches first) */
  askMs = 5 * 60_000;
  private ticking = false;
  private waitingNow: string[] = [];
  /** workers that said their checkout is past the server's commit, and for which commit */
  private aheadOf = new Map<number, string>();
  private lookedForOwn = false;
  private readonly startedAt = Date.now();

  constructor(d: UpdatesDeps) {
    this.d = d;
    this.cfg = d.cfg;
    this.db = d.db;
    this.bus = d.bus;
    this.notifier = d.notifier;
    this.version = d.version;
    this.repo = d.cfg.updateRepo;
    if (this.repo) this.source = this.sourceFor(this.repo);
  }

  private sourceFor(repo: string): ReleaseSource {
    const account = pick(this.cfg.githubAccounts, this.cfg.updateGithubAccount);
    return githubSource(new Octokit({ auth: account?.token, userAgent: 'dispatch', baseUrl: this.cfg.githubApiUrl }), repo, this.cfg.updateBranch);
  }

  /** Look now, and then every UPDATE_POLL_MINUTES. Without UPDATE_REPO, the repo is the checkout's origin. */
  start() {
    if (!this.repo) {
      this.repo = repoSlug(gitOut(APP_DIR, ['remote', 'get-url', 'origin']));
      if (this.repo) this.source = this.sourceFor(this.repo);
    }
    const look = () => void this.check().catch((e) => console.warn('looking for a new version failed:', (e as Error).message));
    if (this.cfg.updatePollMinutes > 0 && this.source) {
      this.pollTimer = setInterval(look, this.cfg.updatePollMinutes * 60_000);
      this.pollTimer.unref();
      look();
    }
    this.tickTimer = setInterval(() => void this.tick(), this.tickMs);
    this.tickTimer.unref();
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.pollTimer = this.tickTimer = null;
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref();
    this.timers.add(t);
  }

  /** Something changed that the rollout waits for: look soon, not at the next tick. */
  private soon() {
    if (this.tickTimer) this.later(500, () => void this.tick());
  }

  state(): UpdateState {
    const raw = this.db.setting('update_state');
    return raw ? { ...NO_STATE, ...(JSON.parse(raw) as Partial<UpdateState>) } : { ...NO_STATE };
  }

  settings(): UpdateSettings {
    const raw = this.db.setting('update_settings');
    const got = raw ? updateSettings.partial().safeParse(JSON.parse(raw)) : null;
    return { ...DEFAULT_SETTINGS, ...(got?.success ? got.data : {}) };
  }

  setSettings(patch: Partial<UpdateSettings>): UpdateSettings {
    const next = { ...this.settings(), ...patch };
    this.db.setSetting('update_settings', JSON.stringify(next));
    this.changed();
    this.soon();
    return next;
  }

  private changed() {
    this.bus.emit({ t: 'update' });
  }

  /** Ask the source now. An error keeps what was known, with the error. Two calls at once share one look. */
  check(): Promise<UpdateState> {
    return (this.checking ??= this.look().finally(() => (this.checking = null)));
  }

  private async look(): Promise<UpdateState> {
    const before = this.state();
    let state: UpdateState;
    let behindTarget = 0;
    if (!this.source) {
      state = { ...before, error: 'Dispatch does not know its own repo. Set UPDATE_REPO (owner/name on GitHub) on the server.' };
    } else {
      try {
        const sha = this.version.sha;
        const latest = await this.source.latest();
        const toBranch = sha ? await this.source.compare(sha, latest.branch_sha) : null;
        const onBranch = !!toBranch && (toBranch.status === 'ahead' || toBranch.status === 'identical');
        // the highest version tag that is on the branch
        const named = latest.tags.filter((t) => VERSION_RE.test(t.name)).sort((a, b) => compareVersions(b.name, a.name)).slice(0, TAGS_TRIED);
        let tag: UpdateState['tag'] = null;
        for (const t of named) {
          const on = t.sha === latest.branch_sha ? 'identical' : (await this.source.compare(t.sha, latest.branch_sha)).status;
          if (on !== 'ahead' && on !== 'identical') continue;
          const toTag = onBranch ? await this.source.compare(sha!, t.sha) : null;
          tag = { name: t.name, sha: t.sha, ahead: toTag?.status === 'ahead' };
          if (toTag?.status === 'ahead') behindTarget = toTag.ahead_by;
          break;
        }
        state = {
          checked_at: new Date().toISOString(),
          for_sha: sha,
          commit: { sha: latest.branch_sha, date: latest.branch_date },
          tag,
          behind_by: onBranch ? toBranch!.ahead_by : null,
          on_branch: onBranch,
          commits: onBranch ? toBranch!.commits.slice(-MAX_COMMITS).reverse().map((c) => ({ sha: c.sha, subject: c.message.split('\n')[0].slice(0, 200) })) : [],
          error: null,
        };
        if (this.settings().follow === 'commits') behindTarget = state.behind_by ?? 0;
      } catch (e) {
        state = { ...before, error: `Could not read ${this.repo ?? 'the repo'} on GitHub: ${(e as Error).message}` };
      }
    }
    this.db.setSetting('update_state', JSON.stringify(state));
    this.changed();
    if (!state.error) this.tellNew(behindTarget);
    return state;
  }

  /** One notice for each new target. */
  private tellNew(behind: number) {
    const t = this.target();
    if (!t || this.db.setting('update_notified') === t.sha) return;
    this.db.setSetting('update_notified', t.sha);
    const what = `${t.tag ?? short(t.sha)} is ${plural(behind, 'commit')} newer than the version that runs (${short(this.version.sha)}).`;
    const then = this.settings().auto ? 'Dispatch installs it when nothing works.' : 'Open Settings to install it.';
    void this.notifier.send({ title: 'Dispatch: a new version', body: `${what} ${then}`, url: '/settings#updates', tag: 'update' });
  }

  /**
   * What the server would update to now: the newest commit of the release branch, or the newest
   * version tag's commit. Null when the last look was for another commit of the server, or the
   * server is not behind it on the branch.
   */
  target(follow: UpdateSettings['follow'] = this.settings().follow): { sha: string; tag: string | null } | null {
    const st = this.state();
    const sha = this.version.sha;
    if (!sha || !st.on_branch || st.for_sha !== sha) return null;
    if (follow === 'tags') return st.tag?.ahead ? { sha: st.tag.sha, tag: st.tag.name } : null;
    if (!st.commit || !st.behind_by || sameVersion(st.commit.sha, sha)) return null;
    return { sha: st.commit.sha, tag: st.tag?.sha === st.commit.sha ? st.tag.name : null };
  }

  /** An update the owner started by hand that is not finished. */
  rollout(): UpdateInfo['rollout'] {
    const raw = this.db.setting('update_rollout');
    return raw ? (JSON.parse(raw) as UpdateInfo['rollout']) : null;
  }

  /**
   * "Update now": to the newest commit, the newest version tag, or (no `kind`) what the settings
   * follow. Also with no newer version, when workers run another commit than the server. What
   * failed before is tried again.
   */
  startRollout(by: string, kind?: 'commit' | 'tag') {
    const t = this.target(kind === 'commit' ? 'commits' : kind === 'tag' ? 'tags' : undefined);
    const workers = !!this.version.sha && this.workerList().some((w) => w.connected && w.updatable && (w.status === 'behind' || w.status === 'failed'));
    if (!t && !workers) throw new UpdateError('There is no newer version to update to. Press "Check now" first.');
    this.setBlocked({ server: null, workers: {} });
    this.db.setSetting('update_rollout', JSON.stringify({ ...(t ?? { sha: this.version.sha!, tag: this.version.tag }), by }));
    this.changed();
    this.soon();
  }

  /** Stop an update started by hand before its next step. A step that runs is not cut off. */
  cancel() {
    this.db.setSetting('update_rollout', '');
    this.waitingNow = [];
    this.changed();
    this.soon();
  }

  // ---------- the log ----------

  private addRow(u: Pick<UpdateRow, 'target' | 'worker_id' | 'worker_name' | 'triggered_by' | 'from_sha' | 'to_sha' | 'to_tag'>): UpdateRow {
    const { lastId } = this.db.run('INSERT INTO updates (target, worker_id, worker_name, triggered_by, from_sha, to_sha, to_tag) VALUES (?, ?, ?, ?, ?, ?, ?)',
      u.target, u.worker_id, u.worker_name, u.triggered_by, u.from_sha, u.to_sha, u.to_tag);
    return this.row(lastId)!;
  }

  row(id: number): UpdateRow | undefined {
    const r = this.db.get('SELECT * FROM updates WHERE id = ?', id);
    return r && toRow(r);
  }

  /** The newest updates first. */
  rows(limit = 30): UpdateRow[] {
    return this.db.all('SELECT * FROM updates ORDER BY id DESC LIMIT ?', limit).map(toRow);
  }

  private running(): UpdateRow[] {
    return this.db.all("SELECT * FROM updates WHERE state = 'running' ORDER BY id").map(toRow);
  }

  /** The update of this server that runs now, if one does. */
  ownUpdate(): UpdateRow | undefined {
    return this.running().find((r) => r.target === 'server');
  }

  /** End a running row. False: it had ended already. */
  private close(id: number, state: UpdateRunState, detail: string | null): boolean {
    return this.db.run("UPDATE updates SET state = ?, detail = ?, ended_at = ? WHERE id = ? AND state = 'running'", state, detail?.slice(-6000) ?? null, new Date().toISOString(), id).changes > 0;
  }

  /** The row was only a question, and the answer was "not now". */
  private dropRow(id: number) {
    this.db.run("DELETE FROM updates WHERE id = ? AND state = 'running'", id);
  }

  /** What failed and is not tried again until "Update now": the server's commit, and each worker's. */
  private blocked(): Blocked {
    const raw = this.db.setting('update_blocked');
    const got = raw ? (JSON.parse(raw) as Partial<Blocked>) : {};
    return { server: got.server ?? null, workers: got.workers ?? {} };
  }

  private setBlocked(b: Blocked) {
    this.db.setSetting('update_blocked', JSON.stringify(b));
  }

  private setWaiting(list: string[]) {
    if (JSON.stringify(list) === JSON.stringify(this.waitingNow)) return;
    this.waitingNow = list;
    this.changed();
  }

  private tell(title: string, body: string) {
    void this.notifier.send({ title, body, url: '/settings#updates', tag: 'update' });
  }

  private workerName(id: number | null | undefined) {
    return this.d.workers.get(id ?? -1)?.name ?? String(id);
  }

  // ---------- how, and when ----------

  /**
   * How this server is updated: by its launcher (a checkout), by the update command of a connected
   * worker (an image), or not at all, and then why.
   */
  mode(): { mode: UpdateInfo['mode']; why: string | null; worker?: number } {
    if (this.launcher?.available) return { mode: 'self', why: null };
    const self = this.launcher?.why ?? 'It was not started through the launcher (node src/launch.ts server).';
    if (!this.version.sha) return { mode: 'none', why: `${self} It also does not know which commit it runs (DISPATCH_VERSION is not set), so no worker can update it.` };
    const worker = this.d.hub.connectedIds().sort((a, b) => a - b).find((id) => this.d.hub.facts(id)?.version?.server_update);
    if (worker !== undefined) return { mode: 'worker', why: null, worker };
    return { mode: 'none', why: `${self} And no connected worker has a command that updates this server (server_update_command in its config).` };
  }

  /**
   * Wait mode of the server: why a restart now would cut something off (empty: nothing). First
   * everything that can start is started, so no session is left that is about to.
   */
  serverGate(): string[] {
    this.d.sessions.dispatch();
    const out: string[] = [];
    // a session that only waits for its usage limit goes on by itself after a restart
    const working = this.d.store.sessions({ statuses: ['running'], limit: 1000 }).filter((s) => !s.limit_wait);
    if (working.length) out.push(working.length === 1 ? `session #${working[0].id} is working` : `${working.length} sessions are working`);
    if (this.d.github.busy()) out.push('a merge runs');
    if (this.d.sessions.settlingCount()) out.push('a finished turn is checked and merged');
    if (this.d.hub.pendingCommands()) out.push('a worker runs a command for the server');
    return out;
  }

  /** Wait mode of one worker, as far as the server knows; the worker itself has the last word. */
  workerGate(workerId: number): string[] {
    const out: string[] = [];
    for (const s of this.d.store.sessions({ statuses: ['running', 'waiting_input'], limit: 1000 })) {
      if (s.worker_id !== workerId || (s.status === 'running' && s.limit_wait)) continue;
      out.push(`session #${s.id} ${s.status === 'running' ? 'is working' : 'waits for an answer'}`);
    }
    if (this.d.hub.pendingOn(workerId)) out.push('it runs a command for the server');
    return out;
  }

  // ---------- the rollout ----------

  /** One look whether the next step of the rollout can start. Never two at once. */
  async tick() {
    if (this.ticking) return;
    // a server that just started after its update: the launcher still watches whether it holds
    if (Date.now() - this.startedAt < this.cfg.settleMs) return;
    this.ticking = true;
    try {
      this.setWaiting(await this.step());
    } catch (e) {
      console.warn('the update step failed:', (e as Error).message);
    } finally {
      this.ticking = false;
    }
  }

  /** Starts at most one update. Returns why the rollout waits. */
  private async step(): Promise<string[]> {
    this.expire();
    // one at a time: the server, or one worker
    if (this.running().length) return [];
    const manual = this.rollout();
    if (!this.settings().auto && !manual) return [];
    const by = manual?.by ?? 'auto';
    const waiting: string[] = [];
    // the server first
    const t = manual ? (sameVersion(manual.sha, this.version.sha) ? null : { sha: manual.sha, tag: manual.tag }) : this.target();
    if (t) {
      const what = t.tag ?? short(t.sha);
      if (this.blocked().server === t.sha) waiting.push(`The update of the server to ${what} failed. "Update now" tries it again.`);
      else {
        const m = this.mode();
        if (m.mode === 'none') waiting.push(`The server cannot be updated. ${m.why}`);
        else {
          const busy = this.serverGate();
          if (busy.length) return [`The server updates to ${what} when nothing works: ${busy.join(', ')}.`];
          return this.updateServer(t, by, m);
        }
      }
    }
    return [...waiting, ...(await this.updateWorker(by, manual))];
  }

  /** Updates that got no result in time. */
  private expire() {
    for (const r of this.running()) {
      const limit = r.target === 'worker' ? this.workerTimeoutMs : this.serverTimeoutMs;
      if (Date.now() - Date.parse(r.created_at) <= limit) continue;
      const mins = Math.round(limit / 60_000);
      if (r.target === 'worker') this.workerEnded(r, 'failed', `Worker ${r.worker_name} was not back on ${short(r.to_sha)} within ${mins} minutes.`);
      else this.serverEnded(r, 'failed', `No result of the update came within ${mins} minutes.`);
    }
  }

  private gitEnv(): NodeJS.ProcessEnv {
    const account = pick(this.cfg.githubAccounts, this.cfg.updateGithubAccount);
    return { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(account ? this.d.github.gitEnvForToken(account.token) : {}) };
  }

  private async updateServer(t: { sha: string; tag: string | null }, by: string, m: ReturnType<Updates['mode']>): Promise<string[]> {
    const from = this.version.sha;
    const { sessions, hub } = this.d;
    // from here nothing starts: the server is about to stop
    sessions.hold = UPDATE_HOLD;
    const row = this.addRow({ target: 'server', worker_id: m.worker ?? null, worker_name: m.worker === undefined ? null : this.workerName(m.worker), triggered_by: by, from_sha: from, to_sha: t.sha, to_tag: t.tag });
    const notNow = () => {
      this.dropRow(row.id);
      sessions.hold = null;
      sessions.dispatch();
    };
    if (m.mode === 'worker') {
      // the worker runs its own command; the server names only the commit
      if (hub.send(m.worker, { t: 'server_update', update_id: row.id, sha: t.sha, prev: from })) this.changed();
      else notNow();
      return [];
    }
    try {
      // this process fetches (it has the GitHub account); the launcher checks the commit again, without the network
      await this.verify({ sha: t.sha, branch: this.cfg.updateBranch, role: 'server', dir: APP_DIR, from }, { fetch: true, env: this.gitEnv() });
    } catch (e) {
      if (e instanceof Refusal && e.kind === 'ahead') {
        // the checkout is on this commit, or past it: nothing to do
        notNow();
        if (this.rollout()) this.db.setSetting('update_rollout', '');
        return [];
      }
      this.serverEnded(row, 'failed', (e as Error).message);
      return [];
    }
    // what came in during the fetch (an answer to a question, a merge)
    const busy = this.serverGate();
    if (busy.length) {
      notNow();
      return [`The server updates to ${t.tag ?? short(t.sha)} when nothing works: ${busy.join(', ')}.`];
    }
    this.changed();
    // the launcher stops this server now; it answers here only when it refused
    this.launcher!.request({ sha: t.sha, from }, { update_id: row.id });
    return [];
  }

  /** The first worker that runs another commit than the server and is in wait mode. */
  private async updateWorker(by: string, manual: UpdateInfo['rollout']): Promise<string[]> {
    const sha = this.version.sha;
    const { hub, sessions } = this.d;
    // an update started by hand is done when the server runs its commit and no worker is left to wait for
    const endManual = () => {
      if (!manual || !sameVersion(manual.sha, sha)) return;
      this.db.setSetting('update_rollout', '');
      this.changed();
    };
    if (!sha) return [];
    const behind = hub.connectedIds().sort((a, b) => a - b).filter((id) => {
      const v = hub.facts(id)?.version;
      return !!v?.updatable && !!v.sha && !sameVersion(v.sha, sha) && this.aheadOf.get(id) !== sha;
    });
    if (!behind.length) {
      endManual();
      return [];
    }
    // only a commit of the release branch: a worker takes no other
    let st = this.state();
    if (st.for_sha !== sha && this.source && !this.lookedForOwn) {
      this.lookedForOwn = true;
      st = await this.check();
    }
    if (st.for_sha !== sha || !st.on_branch) {
      endManual();
      return [`Workers are not updated: the server's commit (${short(sha)}) is not known as one of ${this.cfg.updateBranch}.`];
    }
    const waiting: string[] = [];
    const blocked = this.blocked();
    let left = 0;
    for (const id of behind) {
      if (blocked.workers[id] === sha) continue;
      const name = this.workerName(id);
      const wait = (reasons: string[]) => {
        left++;
        waiting.push(`Worker ${name} updates when nothing works on it: ${reasons.join(', ')}.`);
      };
      const busy = this.workerGate(id);
      if (busy.length) {
        wait(busy);
        continue;
      }
      const row = this.addRow({ target: 'worker', worker_id: id, worker_name: name, triggered_by: by, from_sha: hub.facts(id)?.version?.sha ?? null, to_sha: sha, to_tag: this.version.tag });
      let answer: SelfUpdateAnswer;
      try {
        answer = await hub.cmd<SelfUpdateAnswer>(id, { c: 'self_update', sha, update_id: row.id }, this.askMs);
      } catch (e) {
        const why = (e as Error).message;
        if (NOT_SENT.test(why)) {
          // it went away before it was asked
          this.dropRow(row.id);
          left++;
          continue;
        }
        // no answer: it may be on its way. Its hello, its result or the time limit says how it ended.
        if (NO_ANSWER.test(why)) this.changed();
        else this.workerEnded(row, 'failed', why);
        return waiting;
      }
      if (answer.state === 'started') {
        // it stops in a moment: what would start on it now waits until it is back
        sessions.holdWorker(id, true);
        this.changed();
        return waiting;
      }
      if (answer.state === 'refused') {
        this.workerEnded(row, 'failed', answer.reason);
        continue;
      }
      this.dropRow(row.id);
      if (answer.state === 'busy') wait(answer.reasons);
      else this.aheadOf.set(id, sha);
    }
    if (!left) endManual();
    return waiting;
  }

  /** What the log keeps of a result. `note`: with what the start found about the database. */
  private detail(r: { error?: string; log_tail?: string }, note = false): string | null {
    return [r.error, note ? this.restoreNote : null, r.log_tail ? `Last output:\n${r.log_tail}` : null].filter(Boolean).join('\n\n') || null;
  }

  private serverEnded(row: UpdateRow, state: Exclude<UpdateRunState, 'running'>, detail: string | null) {
    if (!this.close(row.id, state, detail)) return;
    // the copy of the database from before the update has done its work
    dropCopy(this.d.dbFile);
    this.d.sessions.hold = null;
    const to = row.to_tag ?? short(row.to_sha);
    if (state === 'ok') this.tell('Dispatch: updated', `The server runs ${to} now.`);
    else {
      this.setBlocked({ ...this.blocked(), server: row.to_sha });
      // an update started by hand ends here
      if (this.rollout()) this.db.setSetting('update_rollout', '');
      const first = (detail ?? '').split('\n')[0].slice(0, 300);
      this.tell('Dispatch: the update failed', `The server ${state === 'rolled_back' ? 'is back on' : 'stays on'} ${short(row.from_sha)}. ${to} is not tried again until you press "Update now". ${first}`.trim());
    }
    this.d.sessions.dispatch();
    this.changed();
    this.soon();
  }

  private workerEnded(row: UpdateRow, state: Exclude<UpdateRunState, 'running'>, detail: string | null) {
    if (!this.close(row.id, state, detail)) return;
    const id = row.worker_id!;
    this.d.sessions.holdWorker(id, false);
    if (state !== 'ok') {
      const b = this.blocked();
      this.setBlocked({ ...b, workers: { ...b.workers, [id]: row.to_sha } });
      const first = (detail ?? '').split('\n')[0].slice(0, 300);
      this.tell(`Dispatch: worker ${row.worker_name} did not update`, `It stays on ${short(row.from_sha)}. ${first}`.trim());
    }
    this.d.sessions.dispatch();
    this.changed();
    this.soon();
  }

  /** The launcher says how the server's own update ended: in the new version, or in the old one after a way back. */
  onLauncherResult(result: ApplyResult, ctx: unknown) {
    const id = (ctx as { update_id?: unknown } | null)?.update_id;
    const row = typeof id === 'number' ? this.row(id) : undefined;
    if (!row || row.target !== 'server' || !sameVersion(result.to, row.to_sha)) return;
    this.serverEnded(row, result.ok ? 'ok' : result.rolled_back ? 'rolled_back' : 'failed', this.detail(result, !result.ok));
  }

  /** A worker says how its own update ended, or the server's that it ran. Only the worker that was asked counts. */
  onUpdateResult(workerId: number, msg: UpdateResult) {
    const row = this.row(msg.update_id);
    if (!row || row.target !== msg.target || row.worker_id !== workerId) return;
    const state = msg.ok ? 'ok' : msg.rolled_back ? 'rolled_back' : 'failed';
    if (row.target === 'server') this.serverEnded(row, state, this.detail(msg, !msg.ok));
    else this.workerEnded(row, state, this.detail(msg));
  }

  /** A worker is (back) on its link: one that runs the commit it was asked to take has updated. */
  onWorkerHello(workerId: number, facts: WorkerFacts | null) {
    this.aheadOf.delete(workerId);
    this.d.sessions.holdWorker(workerId, false);
    const row = this.running().find((r) => r.target === 'worker' && r.worker_id === workerId);
    if (row && sameVersion(facts?.version?.sha, row.to_sha)) this.workerEnded(row, 'ok', null);
    else {
      this.changed();
      this.soon();
    }
  }

  /**
   * At the server's start: its own update was running when it stopped. The result comes from the
   * launcher, or from the worker that ran the update command. When none comes, the commit that
   * runs tells how it ended.
   */
  reconcile() {
    const row = this.ownUpdate();
    if (!row) return;
    const here = sameVersion(this.version.sha, row.to_sha);
    // a worker's command may still run its way back: the time limit of the update ends that wait
    if (!here && row.worker_id !== null) return;
    this.later(this.graceMs + this.cfg.settleMs, () => {
      const r = this.row(row.id);
      if (r?.state !== 'running') return;
      if (here) this.serverEnded(r, 'ok', null);
      else this.serverEnded(r, 'failed', [`The server runs ${short(this.version.sha)}, not ${short(r.to_sha)}, and no result of the update came.`, this.restoreNote].filter(Boolean).join('\n\n'));
    });
  }

  private workerList(): UpdateWorker[] {
    const sha = this.version.sha;
    const { hub, workers } = this.d;
    const updating = new Set(this.running().filter((r) => r.target === 'worker').map((r) => r.worker_id));
    const blocked = this.blocked().workers;
    return workers.list().map((w) => {
      const v = (hub.facts(w.id) ?? w.facts)?.version;
      const status: UpdateWorker['status'] = updating.has(w.id) ? 'updating'
        : !v?.sha || !sha ? 'unknown'
        : sameVersion(v.sha, sha) ? 'current'
        : blocked[w.id] === sha ? 'failed'
        : this.aheadOf.get(w.id) === sha ? 'newer'
        : 'behind';
      return {
        id: w.id, name: w.name, connected: hub.isConnected(w.id), sha: v?.sha ?? null, updatable: !!v?.updatable,
        why: !v ? 'It runs a version of Dispatch from before updates.' : v.updatable ? null : v.why ?? 'It cannot update itself.',
        status,
      };
    });
  }

  /** All the Updates section shows. */
  info(): UpdateInfo {
    const m = this.mode();
    return {
      repo: this.repo,
      branch: this.cfg.updateBranch,
      version: { sha: this.version.sha, tag: this.version.tag },
      mode: m.mode,
      mode_why: m.why,
      state: this.state(),
      settings: this.settings(),
      target: this.target(),
      rollout: this.rollout(),
      waiting: this.waitingNow,
      workers: this.workerList(),
      log: this.rows(),
    };
  }
}
