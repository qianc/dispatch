// Git clones and per-session worktrees under WORKSPACES_DIR.
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { CheckParser, type CheckProgress } from '../shared/checkProgress.ts';
import type { GeneratorItem } from '../shared/generatorItems.ts';
import { privatePatternsFile, redactPrivate } from '../shared/mergeMessage.ts';
import { githubCredEnv } from '../shared/accounts.ts';
import type { GithubCred, StartSpec } from '../shared/protocol.ts';
import type { Repo } from '../shared/types.ts';
import { maxVersion, VERSION_RE } from '../shared/release.ts';
import { mergedRange } from '../shared/mergedRange.ts';

/**
 * Extra environment for commands run on behalf of a repo (its GitHub account's token and commit
 * identity, or a session's user's own: DISP-63). Set by Workspaces.withRepo, so every git call
 * inside it uses the right account.
 */
const repoEnv = new AsyncLocalStorage<Record<string, string | undefined>>();
const procEnv = () => {
  const extra = repoEnv.getStore();
  return extra ? { ...process.env, ...extra } : process.env;
};

/**
 * A merge message without the owner's private words (DISP-57): the repo's pre-push hook
 * (scripts/check-private.mjs) refuses a pushed commit message that has one, and the agent cannot
 * change the title the message repeats.
 */
function withoutPrivateWords(message: string) {
  const file = privatePatternsFile(process.env, homedir());
  return existsSync(file) ? redactPrivate(message, readFileSync(file, 'utf8')) : message;
}

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

/**
 * Run a shell command and read its output as it comes: `onProgress` gets the test progress read
 * from it (DISP-5), at most about once a second while it changes, and once at the end.
 */
export function runCheck(command: string, cwd: string, timeoutMs: number, onProgress?: (p: CheckProgress) => void, signal?: AbortSignal): Promise<RunResult & { progress: CheckProgress; duration_ms: number; timed_out: boolean }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const parser = new CheckParser();
    let out = '';
    let last = 0;
    let dirty = false;
    let timedOut = false;
    const report = (force = false) => {
      if (!onProgress) return;
      // unchanged, it still goes every 30 s: the server knows the check is alive (a silent stretch
      // of a long suite is not a hung worker)
      if (!dirty && !force && Date.now() - last < 30_000) return;
      if (!force && Date.now() - last < 1000) return;
      last = Date.now();
      dirty = false;
      onProgress(parser.progress(Date.now() - started));
    };
    const tick = setInterval(() => report(), 1000);
    const child = spawn('sh', ['-c', command], { cwd, env: procEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const onData = (b: Buffer) => {
      const s = b.toString('utf8');
      out = (out + s).slice(-200_000);
      if (parser.write(s)) dirty = true;
      report();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    // the whole process group: a test runner's own children must not outlive the timeout
    const killAll = () => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const kill = setTimeout(() => {
      timedOut = true;
      killAll();
    }, timeoutMs);
    // stopped from outside (the owner sent a message or stopped the session while it ran)
    signal?.addEventListener('abort', killAll, { once: true });
    const done = (code: number) => {
      clearInterval(tick);
      clearTimeout(kill);
      signal?.removeEventListener('abort', killAll);
      parser.write('\n');
      const progress = parser.progress(Date.now() - started);
      if (onProgress) onProgress(progress);
      resolve({ code, out: out.trim(), progress, duration_ms: progress.elapsed_ms, timed_out: timedOut });
    };
    child.on('error', (e) => { out += String(e); done(127); });
    child.on('close', (code, signal) => done(code ?? (signal ? 137 : 1)));
  });
}

/** How long a check command may run: CHECK_TIMEOUT_MIN on the worker, 2 hours by default. */
export function checkTimeoutMs() {
  return (Number(process.env.CHECK_TIMEOUT_MIN) || 120) * 60_000;
}

/** How long a deploy command may run: DEPLOY_TIMEOUT_MIN on the worker, 30 minutes by default. */
export function deployTimeoutMs() {
  return (Number(process.env.DEPLOY_TIMEOUT_MIN) || 30) * 60_000;
}

function movedOn(repo: Repo) {
  return `${repo.default_branch} moved on while the check ran (another merge landed), so nothing was pushed: the check did not test what would land. Merge again to check against the new ${repo.default_branch}.`;
}

function handEdited(repo: Repo, branch: string, files: string[]) {
  return `${branch} edits ${files.join(', ')}, which only the generate command writes (Dispatch makes it at merge, from the items), so nothing was merged. Undo the edit on the branch (\`git checkout $(git merge-base ${repo.default_branch} HEAD) -- ${files.join(' ')}\` and commit), change the items in Dispatch instead, and merge again.`;
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

/** A local merge's outcome; `check`: how the repo's check command went, when it ran */
export interface MergeResult { ok: boolean; conflict?: boolean; output?: string; check?: { ok: boolean; duration_ms: number; units: number } }

export interface Leftover {
  repo_id: number; repo: string; worktree: boolean; dirty: boolean; untracked: boolean; branch: string | null; merged: boolean;
  /** the branch is checked out in a worktree outside the session folder (DISP-62): it can't be deleted, so it is reported */
  checked_out?: string | null;
}
export interface TidyResult { repo: string; worktree: 'none' | 'removed' | 'kept (uncommitted changes)'; branch: string }

export class Workspaces {
  readonly root: string;
  private remoteBase: string;
  /** git can't run fetch / worktree add / merge in parallel on one repo, so serialize per repo. */
  private locks = new Map<string, Promise<unknown>>();

  /** `cred`: the session's user's own GitHub account (DISP-63), instead of the repo's env account */
  private withRepo<T>(repo: Repo, fn: () => Promise<T>, cred?: GithubCred | null): Promise<T> {
    const key = `${repo.github_owner}/${repo.github_name}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => repoEnv.run({ ...this.accountEnv(repo, cred), ...this.hostedEnv(repo) }, fn));
    this.locks.set(key, next);
    return next;
  }

  /** git environment for a repo (its project's GitHub account); empty = the worker's own */
  private gitEnv: (repo: Repo) => Record<string, string | undefined>;

  /** A repo's GitHub account for git: the session user's own when there is one (DISP-63), else the repo's env account. */
  private accountEnv(repo: Repo, cred?: GithubCred | null) {
    return cred ? githubCredEnv(cred) : this.gitEnv(repo);
  }

  /** the server this worker serves: where its hosted repos are, and the worker's token for them */
  private hosted: { base: string; token: string } | null;

  /** this machine's env files per repo (DISP-44): <envDir>/<owner>/<name>/, copied into new worktrees */
  readonly envDir: string | null;

  constructor(root: string, remoteBase = 'https://github.com', gitEnv: (repo: Repo) => Record<string, string | undefined> = () => ({}), hosted: { base: string; token: string } | null = null, envDir: string | null = null) {
    // absolute: git commands run in other folders (a local repo) and must find these paths too
    this.root = resolve(root);
    this.remoteBase = remoteBase;
    this.gitEnv = gitEnv;
    this.hosted = hosted;
    this.envDir = envDir ? resolve(envDir) : null;
  }

  /** A repo's env overlay folder on this machine (local repos: local/<name>, hosted: hosted/<name>), or null when it has none. */
  overlayDir(repo: Repo): string | null {
    if (!this.envDir) return null;
    const dir = join(this.envDir, repo.github_owner, repo.github_name);
    return existsSync(dir) ? dir : null;
  }

  /** The repos that have an env overlay here, as <owner>/<name> (worker facts). */
  async overlays(): Promise<string[]> {
    if (!this.envDir || !existsSync(this.envDir)) return [];
    const out: string[] = [];
    for (const owner of await readdir(this.envDir, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      for (const name of await readdir(join(this.envDir, owner.name), { withFileTypes: true })) {
        if (name.isDirectory()) out.push(`${owner.name}/${name.name}`);
      }
    }
    return out.sort();
  }

  /** Environment for a repo's setup, check and deploy commands: its account, hosted-git access, its env overlay. */
  private commandEnv(repo: Repo, cred?: GithubCred | null): Record<string, string | undefined> {
    const overlay = this.overlayDir(repo);
    return { ...this.accountEnv(repo, cred), ...this.hostedEnv(repo), ...(overlay ? { DISPATCH_REPO_ENV_DIR: overlay } : {}) };
  }

  /**
   * Copy the repo's env overlay into a new worktree, at the same relative paths. A file git would
   * track there is not copied (secrets must never be committed): it is in `refused`.
   */
  async applyOverlay(repo: Repo, wt: string): Promise<{ copied: string[]; refused: string[] }> {
    const dir = this.overlayDir(repo);
    const copied: string[] = [];
    const refused: string[] = [];
    if (!dir) return { copied, refused };
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const from = join(entry.parentPath, entry.name);
      const rel = relative(dir, from);
      if ((await run('git', ['check-ignore', '-q', '--', rel], wt)).code !== 0) {
        refused.push(rel);
        continue;
      }
      await mkdir(dirname(join(wt, rel)), { recursive: true });
      await copyFile(from, join(wt, rel));
      copied.push(rel);
    }
    return { copied: copied.sort(), refused: refused.sort() };
  }

  /**
   * Make a new worktree ready to work, check or deploy in (DISP-44): the env overlay, then the
   * repo's setup command. Not ok when a file was refused or the setup failed.
   */
  async prepareTree(repo: Repo, wt: string, cred?: GithubCred | null): Promise<{ ok: boolean; output: string; copied: string[] }> {
    const { copied, refused } = await this.applyOverlay(repo, wt);
    const notes: string[] = [];
    if (refused.length) notes.push(`Env files not copied, because git would track them in ${repo.github_name} (add them to .gitignore): ${refused.join(', ')}`);
    if (!repo.setup_command) return { ok: !refused.length, output: notes.join('\n'), copied };
    const r = await this.setup(repo, wt, cred);
    if (!r.ok) notes.push(`Setup command \`${repo.setup_command}\` failed:\n${r.output}`);
    return { ok: r.ok && !refused.length, output: notes.join('\n\n'), copied };
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
      }, spec.github);
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
    }, spec.github);
    return wt;
  }

  /**
   * The newest version tag on a repo's default branch and its VERSION file (null when there is
   * none), each with its date, after fetching the tags: a copy that nobody fetched has old ones.
   */
  releaseVersion(repo: Repo): Promise<{ tag: string | null; tag_date: string | null; file: string | null; file_date: string | null; file_tagged: boolean; fetch_error: string | null }> {
    return this.withRepo(repo, async () => {
      const dir = repo.local_path ?? (await this.ensureCache(repo));
      const base = repo.local_path ? `refs/heads/${repo.default_branch}` : `origin/${repo.default_branch}`;
      // a local repo can have no remote: then its own tags are all there is
      const hasRemote = (await run('git', ['remote', 'get-url', 'origin'], dir)).code === 0;
      const fetched = hasRemote ? await run('git', ['fetch', '--tags', 'origin'], dir, 30_000) : null;
      const tags = await run('git', ['tag', '--merged', base, '--list', 'v[0-9]*', '[0-9]*'], dir);
      const file = await run('git', ['show', `${base}:VERSION`], dir);
      const v = file.out.trim();
      const tag = tags.code === 0 ? maxVersion(tags.out.split('\n')) : null;
      const version = file.code === 0 && VERSION_RE.test(v) ? v : null;
      const output = async (args: string[]) => {
        const r = await run('git', args, dir);
        return r.code === 0 && r.out ? r.out : null;
      };
      const bare = version?.replace(/^v/, '');
      return {
        tag,
        tag_date: tag && (await output(['for-each-ref', '--format=%(creatordate:iso-strict)', `refs/tags/${tag}`])),
        file: version,
        file_date: version && (await output(['log', '-1', '--format=%cI', base, '--', 'VERSION'])),
        file_tagged: !!bare && !!(await output(['tag', '--list', `v${bare}`, bare])),
        fetch_error: fetched?.code ? fetched.out.slice(-300) : null,
      };
    });
  }

  /** Run a repo's setup command in a new worktree. */
  async setup(repo: Repo, wt: string, cred?: GithubCred | null): Promise<{ ok: boolean; output: string }> {
    const r = await repoEnv.run(this.commandEnv(repo, cred), () => run('sh', ['-c', repo.setup_command!], wt, 20 * 60_000));
    return { ok: r.code === 0, output: r.out.slice(-3000) };
  }

  /**
   * A session worktree as the turn check sees it (DISP-15): its HEAD and uncommitted changes, or
   * null when it has nothing beyond the default branch (no worktree, no change: nothing to check).
   */
  async turnState(repo: Repo, sessionId: number): Promise<string | null> {
    const wt = this.repoDir(sessionId, repo);
    if (!existsSync(wt)) return null;
    const head = await run('git', ['rev-parse', 'HEAD'], wt);
    if (head.code !== 0) return null;
    const base = Workspaces.isAttached(wt, repo) ? `refs/heads/${repo.default_branch}` : `origin/${repo.default_branch}`;
    const status = await run('git', ['status', '--porcelain'], wt);
    // the working tree against the default branch: a branch that only merged it in has no change
    const differs = (await run('git', ['diff', '--quiet', base, '--'], wt)).code !== 0;
    if (!differs && !status.out) return null;
    return `${head.out}\n${status.out}`;
  }

  /** Run a repo's check command in a session's worktree, as its account (DISP-15). */
  sessionCheck(repo: Repo, sessionId: number, onProgress?: (p: CheckProgress) => void, signal?: AbortSignal, cred?: GithubCred | null) {
    const wt = this.repoDir(sessionId, repo);
    return repoEnv.run(this.commandEnv(repo, cred), () => runCheck(repo.check_command!, wt, checkTimeoutMs(), onProgress, signal));
  }

  async pushBranch(repo: Repo, sessionId: number, branch: string, cred?: GithubCred | null) {
    const wt = this.repoDir(sessionId, repo);
    if (!existsSync(wt)) throw new Error(`No worktree for ${repo.github_name} in session ${sessionId}`);
    if (Workspaces.isAttached(wt, repo)) return; // the branch already lives in the owner's repo
    await this.withRepo(repo, () => git(['push', '-u', 'origin', branch], wt), cred);
  }

  /**
   * Merge `branch` into the default branch locally, run the check command, push. The repo is
   * locked only for the merge and the push: a check can run for an hour, and the repo's diffs,
   * branch status and pushes must not wait for it. If the default branch moved on meanwhile,
   * nothing is pushed: the check did not test what would land.
   */
  async mergeLocal(repo: Repo, branch: string, message: string, onProgress?: (p: CheckProgress) => void, items: GeneratorItem[] = [], cred?: GithubCred | null): Promise<MergeResult> {
    const tmp = join(this.root, 'merge', randomUUID());
    const prep = await this.withRepo(repo, async () => {
      const { dir, base, head } = await this.refs(repo, branch);
      await mkdir(join(this.root, 'merge'), { recursive: true });
      const baseSha = await git(['rev-parse', base], dir);
      // only the generate command writes its files (DISP-56): a branch that edits them is refused
      const paths = repo.generated_paths ?? [];
      const edited = paths.length ? (await git(['diff', '--name-only', '--no-renames', `${baseSha}...${head}`, '--', ...paths], dir)).split('\n').filter(Boolean) : [];
      if (edited.length) return { dir, base, baseSha, failed: { ok: false, output: handEdited(repo, branch, edited) } as MergeResult };
      await git(['worktree', 'add', '--detach', tmp, baseSha], dir);
      const m = await run('git', ['merge', '--no-ff', '-m', withoutPrivateWords(message), head], tmp);
      if (m.code !== 0) {
        await run('git', ['merge', '--abort'], tmp);
        return { dir, base, baseSha, failed: { ok: false, conflict: true, output: m.out } as MergeResult };
      }
      return { dir, base, baseSha, failed: null };
    }, cred);
    const { dir, base, baseSha } = prep;
    let check: MergeResult['check'];
    try {
      if (prep.failed) return prep.failed;
      if (repo.check_command || repo.generate_command) {
        // the check runs in a worktree set up like a session's: env files and setup first (DISP-44)
        const ready = await this.prepareTree(repo, tmp, cred);
        if (!ready.ok) return { ok: false, output: `Could not set up the merge checkout, so the check did not run.\n${ready.output}` };
      }
      if (repo.generate_command) {
        const g = await this.generate(repo, tmp, items, cred);
        if (!g.ok) return { ok: false, output: g.output };
      }
      if (repo.check_command) {
        // the repo's account and hosted-git access, as the locked commands have them
        const c = await repoEnv.run(this.commandEnv(repo, cred), () => runCheck(repo.check_command!, tmp, checkTimeoutMs(), onProgress));
        check = { ok: c.code === 0, duration_ms: c.duration_ms, units: c.progress.units };
        if (c.code !== 0) {
          const why = c.timed_out ? `Check stopped after ${Math.round(checkTimeoutMs() / 60_000)} minutes (CHECK_TIMEOUT_MIN on the worker)` : 'Check failed';
          return { ok: false, output: `${why} (${repo.check_command}):\n${c.out.slice(-4000)}`, check };
        }
      }
      return await this.withRepo(repo, async () => {
        if (repo.local_path && (await git(['rev-parse', base], dir)) !== baseSha) return { ok: false, output: movedOn(repo), check };
        // local repo: push into the repo itself, so a checked-out default branch is updated the
        // git way (receive.denyCurrentBranch=updateInstead refuses when its working tree is dirty)
        const push = await run('git', ['push', repo.local_path ?? 'origin', `HEAD:${repo.default_branch}`], tmp);
        if (push.code !== 0) {
          if (/non-fast-forward|fetch first|\(stale info\)/i.test(push.out)) return { ok: false, output: `${movedOn(repo)}\n\n${push.out}`, check };
          const why = repo.local_path && /denyCurrentBranch|checked out|working tree|would be overwritten|unstaged/i.test(push.out)
            ? `Could not update ${repo.default_branch} in ${repo.local_path}: it is checked out there with uncommitted changes, or the repo refuses pushes to it. Commit or stash your changes (or run \`git config receive.denyCurrentBranch updateInstead\` in that repo) and merge again.\n\n`
            : '';
          return { ok: false, output: why + push.out, check };
        }
        return check ? { ok: true, check } : { ok: true };
      }, cred);
    } finally {
      await this.withRepo(repo, () => run('git', ['worktree', 'remove', '--force', tmp], dir));
    }
  }

  /**
   * Run a repo's generate command in a merge checkout (DISP-56), with the items in a JSON file at
   * DISPATCH_ITEMS, and put what it changed in `generated_paths` (all tracked files when there are
   * none) into the merge commit: the merge stays one commit, with no extra one on the default branch.
   */
  private async generate(repo: Repo, tmp: string, items: GeneratorItem[], cred?: GithubCred | null): Promise<{ ok: boolean; output: string }> {
    const file = `${tmp}.items.json`;
    await writeFile(file, JSON.stringify(items, null, 2));
    try {
      return await repoEnv.run({ ...this.commandEnv(repo, cred), DISPATCH_ITEMS: file }, async () => {
        const r = await run('sh', ['-c', repo.generate_command!], tmp, checkTimeoutMs());
        if (r.code !== 0) return { ok: false, output: `Generate command failed (${repo.generate_command}), so nothing was merged:\n${r.out.slice(-4000)}` };
        const paths = repo.generated_paths ?? [];
        await git(paths.length ? ['add', '-A', '--', ...paths] : ['add', '-u'], tmp);
        if ((await run('git', ['diff', '--cached', '--quiet'], tmp)).code !== 0) await git(['commit', '--amend', '--no-edit', '--no-verify'], tmp);
        return { ok: true, output: r.out };
      });
    } finally {
      await rm(file, { force: true });
    }
  }

  /**
   * Run a repo's deploy command on its merged default branch (DISP-37). A local repo deploys from
   * the repo itself (the owner's deploy tooling lives there); others from a fresh checkout of the
   * default branch, removed afterwards. The repo is locked only while that checkout is made.
   */
  async deploy(repo: Repo, cred?: GithubCred | null): Promise<{ ok: boolean; sha: string | null; output: string; duration_ms: number }> {
    const tmp = repo.local_path ? null : join(this.root, 'deploy', randomUUID());
    const { dir, sha } = await this.withRepo(repo, async () => {
      const { dir, base } = await this.refs(repo, repo.default_branch);
      const sha = await git(['rev-parse', base], dir);
      if (tmp) {
        await mkdir(join(this.root, 'deploy'), { recursive: true });
        await git(['worktree', 'add', '--detach', tmp, sha], dir);
      }
      return { dir, sha };
    }, cred);
    try {
      // a fresh checkout is set up like a session's first (DISP-44); a local repo is already set up
      if (tmp) {
        const ready = await this.prepareTree(repo, tmp, cred);
        if (!ready.ok) return { ok: false, sha, output: `Could not set up the deploy checkout, so the deploy did not run.\n${ready.output}`.slice(-4000), duration_ms: 0 };
      }
      const env = { ...this.commandEnv(repo, cred), DISPATCH_DEPLOY_SHA: sha, DISPATCH_DEPLOY_BRANCH: repo.default_branch };
      const r = await repoEnv.run(env, () => runCheck(repo.deploy_command!, tmp ?? dir, deployTimeoutMs()));
      const output = r.timed_out ? `Stopped after ${Math.round(deployTimeoutMs() / 60_000)} minutes (DEPLOY_TIMEOUT_MIN on the worker).\n${r.out}` : r.out;
      return { ok: r.code === 0, sha, output: output.slice(-4000), duration_ms: r.duration_ms };
    } finally {
      if (tmp) await this.withRepo(repo, () => run('git', ['worktree', 'remove', '--force', tmp], dir));
    }
  }

  /** A session branch compared with the default branch. */
  branchStatus(repo: Repo, branch: string): Promise<import('../shared/types.ts').BranchStatus> {
    return this.withRepo(repo, async () => {
      const { dir, base, head } = await this.refs(repo, branch);
      const sha = await run('git', ['rev-parse', '--verify', '--quiet', head], dir);
      if (sha.code !== 0) return { exists: false, ahead: 0, behind: 0, merged: false, conflicts: false, differs: false, head_sha: null };
      const counts = (await git(['rev-list', '--left-right', '--count', `${base}...${head}`], dir)).split(/\s+/).map(Number);
      const merged = (await run('git', ['merge-base', '--is-ancestor', head, base], dir)).code === 0;
      const conflicts = !merged && (await run('git', ['merge-tree', '--write-tree', base, head], dir)).code === 1;
      // same tree as the default branch: nothing to review, even if the commits differ (DISP-33)
      const differs = (await git(['rev-parse', `${base}^{tree}`], dir)) !== (await git(['rev-parse', `${head}^{tree}`], dir));
      return { exists: true, behind: counts[0], ahead: counts[1], merged, conflicts, differs, head_sha: sha.out.trim() };
    });
  }

  /**
   * Files changed on the branch since it left the default branch, with patches (like a PR's files).
   * `mergedSha`: the branch is merged; show it from that last commit (the branch may be gone).
   */
  branchDiff(repo: Repo, branch: string, mergedSha?: string): Promise<import('../shared/types.ts').BranchFile[]> {
    return this.withRepo(repo, async () => {
      const { dir, base, head } = await this.refs(repo, branch);
      const range = mergedSha ? await mergedRange((a) => git(a, dir), base, mergedSha) : `${base}...${head}`;
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
      const checked_out = branchExists ? await this.checkedOutElsewhere(home, branch!, wt) : null;
      out.push({ repo_id: repo.id, repo: repo.github_name, worktree, dirty, untracked, branch: branchExists ? branch : null, merged, checked_out });
    }
    return out;
  }

  /** A worktree other than `own` that has `branch` checked out, from `git worktree list` of `home`. */
  private async checkedOutElsewhere(home: string, branch: string, own: string): Promise<string | null> {
    const list = await run('git', ['worktree', 'list', '--porcelain'], home);
    if (list.code !== 0) return null;
    for (const block of list.out.split('\n\n')) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (path && block.split('\n').includes(`branch refs/heads/${branch}`) && resolve(path) !== resolve(own)) return path;
    }
    return null;
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
        // checked out in a worktree outside the session folder (DISP-62): git would refuse, and that worktree is not ours
        if (l.branch && l.checked_out) r.branch = `kept (checked out in ${l.checked_out})`;
        else if (l.branch && l.merged && opts.deleteMerged && r.worktree !== 'kept (uncommitted changes)') {
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
