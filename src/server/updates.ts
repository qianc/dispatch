// Dispatch's own updates (DISP-112): which version of its repo is the newest, and what the install
// owner chose to do about it. Only a commit of the release branch is ever a target.
import { Octokit } from '@octokit/rest';
import { pick } from '../shared/accounts.ts';
import { VERSION_RE, compareVersions } from '../shared/release.ts';
import { updateSettings, type UpdateInfo, type UpdateSettings, type UpdateState } from '../shared/types.ts';
import { APP_DIR, gitOut, sameVersion, type VersionInfo } from '../update/version.ts';
import type { Bus } from './bus.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Notifier } from './notify.ts';

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
  private pollTimer: NodeJS.Timeout | null = null;
  private checking: Promise<UpdateState> | null = null;

  constructor(d: UpdatesDeps) {
    this.cfg = d.cfg;
    this.db = d.db;
    this.bus = d.bus;
    this.notifier = d.notifier;
    this.version = d.version;
    this.repo = d.cfg.updateRepo;
    if (this.repo) this.source = this.github(this.repo);
  }

  private github(repo: string): ReleaseSource {
    const account = pick(this.cfg.githubAccounts, this.cfg.updateGithubAccount);
    return githubSource(new Octokit({ auth: account?.token, userAgent: 'dispatch', baseUrl: this.cfg.githubApiUrl }), repo, this.cfg.updateBranch);
  }

  /** Look now, and then every UPDATE_POLL_MINUTES. Without UPDATE_REPO, the repo is the checkout's origin. */
  start() {
    if (!this.repo) {
      this.repo = repoSlug(gitOut(APP_DIR, ['remote', 'get-url', 'origin']));
      if (this.repo) this.source = this.github(this.repo);
    }
    const look = () => void this.check().catch((e) => console.warn('looking for a new version failed:', (e as Error).message));
    if (this.cfg.updatePollMinutes > 0 && this.source) {
      this.pollTimer = setInterval(look, this.cfg.updatePollMinutes * 60_000);
      this.pollTimer.unref();
      look();
    }
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
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

  /** "Update now": to the newest commit, the newest version tag, or (no `kind`) what the settings follow. */
  startRollout(by: string, kind?: 'commit' | 'tag') {
    const t = this.target(kind === 'commit' ? 'commits' : kind === 'tag' ? 'tags' : undefined);
    if (!t) throw new UpdateError('There is no newer version to update to. Press "Check now" first.');
    this.db.setSetting('update_rollout', JSON.stringify({ ...t, by }));
    this.changed();
  }

  cancel() {
    this.db.setSetting('update_rollout', '');
    this.changed();
  }

  /** All the Updates section shows. */
  info(): UpdateInfo {
    return {
      repo: this.repo,
      branch: this.cfg.updateBranch,
      version: { sha: this.version.sha, tag: this.version.tag },
      mode: 'none',
      mode_why: null,
      state: this.state(),
      settings: this.settings(),
      target: this.target(),
      rollout: this.rollout(),
      waiting: [],
      workers: [],
      log: [],
    };
  }
}
