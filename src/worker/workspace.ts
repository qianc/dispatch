// Git clones and per-session worktrees under WORKSPACES_DIR.
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { StartSpec } from '../shared/protocol.ts';
import type { Repo } from '../shared/types.ts';
import { maxVersion, VERSION_RE } from '../shared/release.ts';

/**
 * Extra environment for commands run on behalf of a repo (its GitHub account's token and commit
 * identity). Set by Workspaces.withRepo, so every git call inside it uses the right account.
 */
const repoEnv = new AsyncLocalStorage<Record<string, string | undefined>>();
const procEnv = () => {
  const extra = repoEnv.getStore();
  return extra ? { ...process.env, ...extra } : process.env;
};

/** ws(s)://host/worker → http(s)://host/git: where a server serves its hosted repos. */
export function hostedGitBase(workerUrl: string) {
  const u = new URL(workerUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = u.pathname.replace(/\/worker\/?$/, '') + '/git';
  return u.toString().replace(/\/$/, '');
}

export interface RunResult {
  code: number;
  out: string;
}

export function run(cmd: string, args: string[], cwd?: string, timeoutMs = 10 * 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env: procEnv() }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

const MAX_FILE = 10 * 1024 * 1024;

/** Run git and get raw stdout bytes (for files that may be binary). */
function gitBytes(args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: MAX_FILE + 1024, env: procEnv() }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed: ${String(stderr).trim()}`));
      else resolve(stdout);
    });
  });
}

async function git(args: string[], cwd?: string) {
  const r = await run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.out}`);
  return r.out;
}

export interface Leftover { repo_id: number; repo: string; worktree: boolean; dirty: boolean; untracked: boolean; branch: string | null; merged: boolean }
export interface TidyResult { repo: string; worktree: 'none' | 'removed' | 'kept (uncommitted changes)'; branch: string }

export class Workspaces {
  readonly root: string;
  private remoteBase: string;
  /** git can't run fetch / worktree add / merge in parallel on one repo, so serialize per repo. */
  private locks = new Map<string, Promise<unknown>>();

  private withRepo<T>(repo: Repo, fn: () => Promise<T>): Promise<T> {
    const key = `${repo.github_owner}/${repo.github_name}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => repoEnv.run({ ...this.gitEnv(repo), ...this.hostedEnv(repo) }, fn));
    this.locks.set(key, next);
    return next;
  }

  /** git environment for a repo (its project's GitHub account); empty = the worker's own */
  private gitEnv: (repo: Repo) => Record<string, string | undefined>;

  /** the server this worker serves: where its hosted repos are, and the worker's token for them */
  private hosted: { base: string; token: string } | null;

  constructor(root: string, remoteBase = 'https://github.com', gitEnv: (repo: Repo) => Record<string, string | undefined> = () => ({}), hosted: { base: string; token: string } | null = null) {
    this.root = root;
    this.remoteBase = remoteBase;
    this.gitEnv = gitEnv;
    this.hosted = hosted;
  }

  /**
   * git's access to the server's hosted repos: the worker token as a header, through the
   * environment, so it is in no URL and in no repo config.
   */
  hostedEnv(repo?: Repo): Record<string, string> {
    if (!this.hosted || (repo && repo.kind !== 'hosted')) return {};
    const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
    return {
      GIT_CONFIG_COUNT: String(n + 1),
      [`GIT_CONFIG_KEY_${n}`]: `http.${this.hosted.base}/.extraHeader`,
      [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Bearer ${this.hosted.token}`,
    };
  }

  /** Where to clone/fetch from: the local folder for local repos, the server for hosted ones, GitHub otherwise. */
  remoteUrl(repo: Repo) {
    if (repo.kind === 'hosted') {
      if (!this.hosted) throw new Error(`${repo.github_name} is hosted by the Dispatch server, but this worker has no server address for it`);
      return `${this.hosted.base}/r${repo.id}.git`;
    }
    return repo.local_path ?? `${this.remoteBase}/${repo.github_owner}/${repo.github_name}.git`;
  }

  cacheDir(repo: Repo) {
    if (repo.kind === 'hosted') return join(this.root, 'cache', 'hosted', `${repo.github_name}-${repo.id}`);
    if (repo.local_path) return join(this.root, 'cache', 'local', `${repo.github_name}-${repo.id}`);
    return join(this.root, 'cache', repo.github_owner, repo.github_name);
  }

  sessionDir(sessionId: number) {
    return join(this.root, 'sessions', String(sessionId));
  }

  repoDir(sessionId: number, repo: Repo) {
    return join(this.sessionDir(sessionId), repo.github_name);
  }

  private fetchedAt = new Map<string, number>();

  /** Local repo whose session worktrees are made in the owner's repo itself (the default). */
  static attachedMode(repo: Repo) {
    return !!repo.local_path && repo.worktree_from !== 'clone';
  }

  /** Is this worktree a worktree of the owner's repo (not of Dispatch's clone)? */
  static isAttached(wt: string, repo: Repo) {
    if (!repo.local_path) return false;
    try {
      const gitdir = readFileSync(join(wt, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() ?? '';
      return resolve(gitdir).startsWith(resolve(repo.local_path, '.git') + sep);
    } catch {
      return false;
    }
  }

  /**
   * Where a repo's branches are read from, without changing anything: a local repo's own refs
   * (its current default branch, and session branches made or pushed there), or the clone's
   * remote-tracking refs after a fetch.
   */
  private async refs(repo: Repo, branch: string) {
    if (repo.local_path) return { dir: repo.local_path, base: `refs/heads/${repo.default_branch}`, head: `refs/heads/${branch}` };
    return { dir: await this.ensureCache(repo), base: `origin/${repo.default_branch}`, head: `origin/${branch}` };
  }

  /** A file as it is on the repo's default branch (local: the owner's current branch; GitHub: fetched at most every 5 minutes). */
  readRepoFile(repo: Repo, path: string): Promise<Buffer> {
    if (repo.local_path) return this.withRepo(repo, () => gitBytes(['show', `refs/heads/${repo.default_branch}:${path}`], repo.local_path!));
    return this.withRepo(repo, async () => {
      const key = `${repo.github_owner}/${repo.github_name}`;
      const dir = this.cacheDir(repo);
      if (!existsSync(join(dir, '.git')) || Date.now() - (this.fetchedAt.get(key) ?? 0) > 5 * 60_000) {
        await this.ensureCache(repo);
        this.fetchedAt.set(key, Date.now());
      }
      return gitBytes(['show', `origin/${repo.default_branch}:${path}`], dir);
    });
  }

  /**
   * Clone on first use, fetch afterwards, and keep the clone's own default branch equal to the
   * remote's: repo tooling often compares with the local `main` (which tests a change affects),
   * and a clone's `main` otherwise stays where it was cloned.
   */
  async ensureCache(repo: Repo) {
    const dir = this.cacheDir(repo);
    if (!existsSync(join(dir, '.git'))) {
      await mkdir(join(dir, '..'), { recursive: true });
      await git(['clone', ...(repo.local_path ? [] : ['--filter=blob:none']), this.remoteUrl(repo), dir]);
    } else {
      await git(['fetch', 'origin', '--prune'], dir);
    }
    await run('git', ['checkout', '--quiet', '--detach'], dir); // nothing of ours is checked out in the clone itself
    await run('git', ['branch', '--force', '--quiet', repo.default_branch, `origin/${repo.default_branch}`], dir);
    return dir;
  }

  /** Fetch a repo's clone now (hosted repos before each turn). */
  refresh(repo: Repo) {
    return this.withRepo(repo, () => this.ensureCache(repo));
  }

  /**
   * Make sure every repo of the session has its worktree; returns the cwd for Claude.
   * New worktrees are added to `created` (their setup command runs before the agent starts).
   */
  async prepare(spec: StartSpec, created: { repo: Repo; wt: string }[] = []): Promise<string> {
    await mkdir(this.sessionDir(spec.session_id), { recursive: true });
    for (const repo of spec.repos) {
      await this.withRepo(repo, async () => {
        const wt = this.repoDir(spec.session_id, repo);
        const attached = existsSync(wt) ? Workspaces.isAttached(wt, repo) : Workspaces.attachedMode(repo);
        // attached: worktrees of the owner's repo, from its current local default branch
        const owner = attached ? repo.local_path! : await this.ensureCache(repo);
        const base = attached ? `refs/heads/${repo.default_branch}` : `origin/${repo.default_branch}`;
        if (existsSync(wt)) {
          if (!spec.branch) await git(['checkout', '--detach', base], wt);
          return;
        }
        await run('git', ['worktree', 'prune'], owner);
        const has = async (ref: string) => (await run('git', ['rev-parse', '--verify', '--quiet', ref], owner)).code === 0;
        if (!spec.branch) {
          await git(['worktree', 'add', '--detach', wt, base], owner);
        } else if (await has(`refs/heads/${spec.branch}`)) {
          // reopened session: keep local (maybe unpushed) commits
          await git(['worktree', 'add', wt, spec.branch], owner);
        } else if (!attached && (await has(`refs/remotes/origin/${spec.branch}`))) {
          await git(['worktree', 'add', '-b', spec.branch, wt, `origin/${spec.branch}`], owner);
        } else {
          await git(['worktree', 'add', '-b', spec.branch, wt, base], owner);
        }
        created.push({ repo, wt });
      });
    }
    return spec.repos.length === 1 ? this.repoDir(spec.session_id, spec.repos[0]) : this.sessionDir(spec.session_id);
  }

  /**
   * Where a release runs; returns the cwd. A local repo: the owner's own checkout (its remotes and
   * the machine's credentials are there), which must be on the default branch with no uncommitted
   * changes. A GitHub repo: a worktree of the clone on the default branch, tracking origin; an
   * existing one is kept as it is (a reopened release keeps its commits).
   */
  async prepareRelease(spec: StartSpec): Promise<string> {
    const repo = spec.repos[0];
    if (!repo || spec.repos.length !== 1) throw new Error('A release needs exactly one repo');
    if (repo.kind === 'hosted') throw new Error('Releases of hosted repos are not supported');
    if (repo.local_path) {
      const dir = repo.local_path;
      const branch = (await run('git', ['branch', '--show-current'], dir)).out.trim();
      const dirty = (await run('git', ['status', '--porcelain', '--untracked-files=no'], dir)).out.trim();
      if (branch !== repo.default_branch || dirty) throw new Error(`A release needs ${dir} on ${repo.default_branch} with no uncommitted changes (it is on ${branch || 'a detached HEAD'}${dirty ? ', with changes' : ''})`);
      return dir;
    }
    await mkdir(this.sessionDir(spec.session_id), { recursive: true });
    const wt = this.repoDir(spec.session_id, repo);
    await this.withRepo(repo, async () => {
      const owner = await this.ensureCache(repo);
      if (existsSync(wt)) return;
      await run('git', ['worktree', 'prune'], owner);
      await git(['worktree', 'add', '-B', repo.default_branch, wt, `origin/${repo.default_branch}`], owner);
      await git(['branch', '--set-upstream-to', `origin/${repo.default_branch}`, repo.default_branch], wt);
    });
    return wt;
  }

  /** The newest version tag on a repo's default branch, and its VERSION file (null when there is none). */
  releaseVersion(repo: Repo): Promise<{ tag: string | null; file: string | null }> {
    return this.withRepo(repo, async () => {
      const dir = repo.local_path ?? (await this.ensureCache(repo));
      const base = repo.local_path ? `refs/heads/${repo.default_branch}` : `origin/${repo.default_branch}`;
      const tags = await run('git', ['tag', '--merged', base, '--list', 'v[0-9]*', '[0-9]*'], dir);
      const file = await run('git', ['show', `${base}:VERSION`], dir);
      const v = file.out.trim();
      return { tag: tags.code === 0 ? maxVersion(tags.out.split('\n')) : null, file: file.code === 0 && VERSION_RE.test(v) ? v : null };
    });
  }

  /** Run a repo's setup command in a new worktree. */
  async setup(repo: Repo, wt: string): Promise<{ ok: boolean; output: string }> {
    const r = await repoEnv.run(this.gitEnv(repo), () => run('sh', ['-c', repo.setup_command!], wt, 20 * 60_000));
    return { ok: r.code === 0, output: r.out.slice(-3000) };
  }

  async pushBranch(repo: Repo, sessionId: number, branch: string) {
    const wt = this.repoDir(sessionId, repo);
    if (!existsSync(wt)) throw new Error(`No worktree for ${repo.github_name} in session ${sessionId}`);
    if (Workspaces.isAttached(wt, repo)) return; // the branch already lives in the owner's repo
    await this.withRepo(repo, () => git(['push', '-u', 'origin', branch], wt));
  }

  /** Merge `branch` into the default branch locally, run the check command, push. */
  mergeLocal(repo: Repo, branch: string, message: string): Promise<{ ok: boolean; conflict?: boolean; output?: string }> {
    return this.withRepo(repo, () => this.mergeLocalUnlocked(repo, branch, message));
  }

  private async mergeLocalUnlocked(repo: Repo, branch: string, message: string): Promise<{ ok: boolean; conflict?: boolean; output?: string }> {
    const { dir, base, head } = await this.refs(repo, branch);
    const tmp = join(this.root, 'merge', randomUUID());
    await mkdir(join(this.root, 'merge'), { recursive: true });
    await git(['worktree', 'add', '--detach', tmp, base], dir);
    try {
      const m = await run('git', ['merge', '--no-ff', '-m', message, head], tmp);
      if (m.code !== 0) {
        await run('git', ['merge', '--abort'], tmp);
        return { ok: false, conflict: true, output: m.out };
      }
      if (repo.check_command) {
        const c = await run('sh', ['-c', repo.check_command], tmp, 30 * 60_000);
        if (c.code !== 0) return { ok: false, output: `Check failed (${repo.check_command}):\n${c.out.slice(-4000)}` };
      }
      // local repo: push into the repo itself, so a checked-out default branch is updated the
      // git way (receive.denyCurrentBranch=updateInstead refuses when its working tree is dirty)
      const push = await run('git', ['push', repo.local_path ?? 'origin', `HEAD:${repo.default_branch}`], tmp);
      if (push.code !== 0) {
        const why = repo.local_path && /denyCurrentBranch|checked out|working tree|would be overwritten|unstaged/i.test(push.out)
          ? `Could not update ${repo.default_branch} in ${repo.local_path}: it is checked out there with uncommitted changes, or the repo refuses pushes to it. Commit or stash your changes (or run \`git config receive.denyCurrentBranch updateInstead\` in that repo) and merge again.\n\n`
          : '';
        return { ok: false, output: why + push.out };
      }
      return { ok: true };
    } finally {
      await run('git', ['worktree', 'remove', '--force', tmp], dir);
    }
  }

  /** A session branch compared with the default branch. */
  branchStatus(repo: Repo, branch: string): Promise<import('../shared/types.ts').BranchStatus> {
    return this.withRepo(repo, async () => {
      const { dir, base, head } = await this.refs(repo, branch);
      const sha = await run('git', ['rev-parse', '--verify', '--quiet', head], dir);
      if (sha.code !== 0) return { exists: false, ahead: 0, behind: 0, merged: false, conflicts: false, head_sha: null };
      const counts = (await git(['rev-list', '--left-right', '--count', `${base}...${head}`], dir)).split(/\s+/).map(Number);
      const merged = (await run('git', ['merge-base', '--is-ancestor', head, base], dir)).code === 0;
      const conflicts = !merged && (await run('git', ['merge-tree', '--write-tree', base, head], dir)).code === 1;
      return { exists: true, behind: counts[0], ahead: counts[1], merged, conflicts, head_sha: sha.out.trim() };
    });
  }

  /** Files changed on the branch since it left the default branch, with patches (like a PR's files). */
  branchDiff(repo: Repo, branch: string): Promise<import('../shared/types.ts').BranchFile[]> {
    return this.withRepo(repo, async () => {
      const { dir, base, head } = await this.refs(repo, branch);
      const range = `${base}...${head}`;
      const stat = await git(['diff', '--numstat', '--no-renames', range], dir);
      const names = await git(['diff', '--name-status', '--no-renames', range], dir);
      const status = new Map(names.split('\n').filter(Boolean).map((l) => {
        const [s, f] = l.split('\t');
        return [f, ({ A: 'added', D: 'removed', M: 'modified' } as Record<string, string>)[s[0]] ?? 'changed'];
      }));
      const files = [];
      for (const line of stat.split('\n').filter(Boolean)) {
        const [add, del, filename] = line.split('\t');
        const patch = add === '-' ? null : (await git(['diff', '--no-renames', range, '--', filename], dir)).split('\n').slice(4).join('\n') || null;
        files.push({ filename, status: status.get(filename) ?? 'modified', additions: Number(add) || 0, deletions: Number(del) || 0, patch: patch && patch.length > 200_000 ? null : patch });
      }
      return files;
    });
  }

  /**
   * Where a session's branch lives on this machine: the owner's repo (local repos) or Dispatch's
   * clone. A GitHub branch on the server side is the server's to delete.
   */
  private branchHome(repo: Repo) {
    return repo.local_path ?? this.cacheDir(repo);
  }

  /**
   * What a finished session left on disk, per repo: its worktree, its branch, and whether that
   * branch is merged. Merged = in the default branch's history, or `mergedHint` (a PR merged on
   * GitHub, which squash-merges leave out of the history).
   */
  async leftovers(sessionId: number, repos: Repo[], branch: string | null, mergedHint: number[] = []): Promise<Leftover[]> {
    const out: Leftover[] = [];
    for (const repo of repos) {
      const wt = this.repoDir(sessionId, repo);
      const worktree = existsSync(wt);
      // changes to tracked files; and new files git does not ignore (a setup's venv is usually ignored)
      const dirty = worktree ? (await run('git', ['status', '--porcelain', '--untracked-files=no'], wt)).out.length > 0 : false;
      const untracked = worktree ? (await run('git', ['status', '--porcelain'], wt)).out.split('\n').some((l) => l.startsWith('??')) : false;
      const home = this.branchHome(repo);
      let branchExists = false;
      let merged = false;
      if (branch && existsSync(home)) {
        branchExists = (await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], home)).code === 0;
        if (branchExists) {
          const base = repo.local_path ? `refs/heads/${repo.default_branch}` : `origin/${repo.default_branch}`;
          merged = mergedHint.includes(repo.id) || (await run('git', ['merge-base', '--is-ancestor', `refs/heads/${branch}`, base], home)).code === 0;
        }
      }
      out.push({ repo_id: repo.id, repo: repo.github_name, worktree, dirty, untracked, branch: branchExists ? branch : null, merged });
    }
    return out;
  }

  /**
   * Remove what a finished session left: its worktrees (a worktree with uncommitted changes only
   * when `force`), and its branch where it is merged (`deleteMerged`). Unmerged branches stay.
   */
  async tidy(sessionId: number, repos: Repo[], branch: string | null, opts: { deleteMerged: boolean; force: boolean; mergedHint?: number[] }): Promise<TidyResult[]> {
    const found = await this.leftovers(sessionId, repos, branch, opts.mergedHint);
    const out: TidyResult[] = [];
    for (const l of found) {
      const repo = repos.find((r) => r.id === l.repo_id)!;
      const r: TidyResult = { repo: l.repo, worktree: 'none', branch: l.branch ? 'kept' : 'none' };
      await this.withRepo(repo, async () => {
        const wt = this.repoDir(sessionId, repo);
        if (l.worktree) {
          // uncommitted changes always stay; new untracked files stay unless the work is merged
          const unsaved = l.dirty || (l.untracked && !(l.branch && l.merged) && branch !== null);
          if (unsaved && !opts.force) r.worktree = 'kept (uncommitted changes)';
          else {
            const owner = Workspaces.isAttached(wt, repo) ? repo.local_path! : this.cacheDir(repo);
            const res = await run('git', ['worktree', 'remove', '--force', wt], owner);
            if (res.code !== 0) await rm(wt, { recursive: true, force: true });
            await run('git', ['worktree', 'prune'], owner);
            r.worktree = 'removed';
          }
        }
        if (l.branch && l.merged && opts.deleteMerged && r.worktree !== 'kept (uncommitted changes)') {
          // -D: a squash-merged branch is merged (its PR says so) but not in the history
          const res = await run('git', ['branch', '-D', l.branch], this.branchHome(repo));
          r.branch = res.code === 0 ? 'deleted' : `kept (${res.out.split('\n')[0]})`;
        } else if (l.branch && !l.merged) r.branch = 'kept (not merged)';
      });
      out.push(r);
    }
    // the session folder goes once nothing is left in it
    const dir = this.sessionDir(sessionId);
    if (existsSync(dir) && out.every((r) => r.worktree !== 'kept (uncommitted changes)')) await rm(dir, { recursive: true, force: true });
    return out;
  }

  async cleanup(sessionId: number, repos: Repo[]) {
    for (const repo of repos) {
      const wt = this.repoDir(sessionId, repo);
      if (!existsSync(wt)) continue;
      const owner = Workspaces.isAttached(wt, repo) ? repo.local_path! : this.cacheDir(repo);
      await this.withRepo(repo, () => run('git', ['worktree', 'remove', '--force', wt], owner));
    }
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }
}
