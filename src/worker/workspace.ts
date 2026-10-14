// Git clones and per-session worktrees under WORKSPACES_DIR.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { StartSpec } from '../shared/protocol.ts';
import type { Repo } from '../shared/types.ts';

export interface RunResult {
  code: number;
  out: string;
}

export function run(cmd: string, args: string[], cwd?: string, timeoutMs = 10 * 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

const MAX_FILE = 10 * 1024 * 1024;

/** Run git and get raw stdout bytes (for files that may be binary). */
function gitBytes(args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: MAX_FILE + 1024, env: process.env }, (err, stdout, stderr) => {
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

export class Workspaces {
  readonly root: string;
  private remoteBase: string;
  /** git can't run fetch / worktree add / merge in parallel on one repo, so serialize per repo. */
  private locks = new Map<string, Promise<unknown>>();

  private withRepo<T>(repo: Repo, fn: () => Promise<T>): Promise<T> {
    const key = `${repo.github_owner}/${repo.github_name}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(key, next);
    return next;
  }

  constructor(root: string, remoteBase = 'https://github.com') {
    this.root = root;
    this.remoteBase = remoteBase;
  }

  /** Where to clone/fetch from: the local folder for local repos, GitHub otherwise. */
  remoteUrl(repo: Repo) {
    return repo.local_path ?? `${this.remoteBase}/${repo.github_owner}/${repo.github_name}.git`;
  }

  cacheDir(repo: Repo) {
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

  /** A file as it is on the repo's default branch (fetched at most every 5 minutes). */
  readRepoFile(repo: Repo, path: string): Promise<Buffer> {
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

  /** Clone on first use, fetch afterwards. */
  async ensureCache(repo: Repo) {
    const dir = this.cacheDir(repo);
    if (!existsSync(join(dir, '.git'))) {
      await mkdir(join(dir, '..'), { recursive: true });
      await git(['clone', ...(repo.local_path ? [] : ['--filter=blob:none']), this.remoteUrl(repo), dir]);
    } else {
      await git(['fetch', 'origin', '--prune'], dir);
    }
    return dir;
  }

  /** Make sure every repo of the session has its worktree; returns the cwd for Claude. */
  async prepare(spec: StartSpec): Promise<string> {
    await mkdir(this.sessionDir(spec.session_id), { recursive: true });
    for (const repo of spec.repos) {
      await this.withRepo(repo, async () => {
        const cache = await this.ensureCache(repo);
        const wt = this.repoDir(spec.session_id, repo);
        const base = `origin/${repo.default_branch}`;
        if (existsSync(wt)) {
          if (!spec.branch) await git(['checkout', '--detach', base], wt);
          return;
        }
        await run('git', ['worktree', 'prune'], cache);
        const has = async (ref: string) => (await run('git', ['rev-parse', '--verify', '--quiet', ref], cache)).code === 0;
        if (!spec.branch) {
          await git(['worktree', 'add', '--detach', wt, base], cache);
        } else if (await has(`refs/heads/${spec.branch}`)) {
          // reopened session: keep local (maybe unpushed) commits
          await git(['worktree', 'add', wt, spec.branch], cache);
        } else if (await has(`refs/remotes/origin/${spec.branch}`)) {
          await git(['worktree', 'add', '-b', spec.branch, wt, `origin/${spec.branch}`], cache);
        } else {
          await git(['worktree', 'add', '-b', spec.branch, wt, base], cache);
        }
      });
    }
    return spec.repos.length === 1 ? this.repoDir(spec.session_id, spec.repos[0]) : this.sessionDir(spec.session_id);
  }

  async pushBranch(repo: Repo, sessionId: number, branch: string) {
    const wt = this.repoDir(sessionId, repo);
    if (!existsSync(wt)) throw new Error(`No worktree for ${repo.github_name} in session ${sessionId}`);
    await this.withRepo(repo, () => git(['push', '-u', 'origin', branch], wt));
  }

  /** Merge `branch` into the default branch locally, run the check command, push. */
  mergeLocal(repo: Repo, branch: string, message: string): Promise<{ ok: boolean; conflict?: boolean; output?: string }> {
    return this.withRepo(repo, () => this.mergeLocalUnlocked(repo, branch, message));
  }

  private async mergeLocalUnlocked(repo: Repo, branch: string, message: string): Promise<{ ok: boolean; conflict?: boolean; output?: string }> {
    const cache = await this.ensureCache(repo);
    const tmp = join(this.root, 'merge', randomUUID());
    await mkdir(join(this.root, 'merge'), { recursive: true });
    await git(['worktree', 'add', '--detach', tmp, `origin/${repo.default_branch}`], cache);
    try {
      const m = await run('git', ['merge', '--no-ff', '-m', message, `origin/${branch}`], tmp);
      if (m.code !== 0) {
        await run('git', ['merge', '--abort'], tmp);
        return { ok: false, conflict: true, output: m.out };
      }
      if (repo.check_command) {
        const c = await run('sh', ['-c', repo.check_command], tmp, 30 * 60_000);
        if (c.code !== 0) return { ok: false, output: `Check failed (${repo.check_command}):\n${c.out.slice(-4000)}` };
      }
      const push = await run('git', ['push', 'origin', `HEAD:${repo.default_branch}`], tmp);
      if (push.code !== 0) {
        const why = repo.local_path && /denyCurrentBranch|checked out|working tree|would be overwritten|unstaged/i.test(push.out)
          ? `Could not update ${repo.default_branch} in ${repo.local_path}: it is checked out there with uncommitted changes, or the repo refuses pushes to it. Commit or stash your changes (or run \`git config receive.denyCurrentBranch updateInstead\` in that repo) and merge again.\n\n`
          : '';
        return { ok: false, output: why + push.out };
      }
      return { ok: true };
    } finally {
      await run('git', ['worktree', 'remove', '--force', tmp], cache);
    }
  }

  /** A session branch in a local repo, compared with the default branch (all from the folder's refs). */
  branchStatus(repo: Repo, branch: string): Promise<import('../shared/types.ts').BranchStatus> {
    return this.withRepo(repo, async () => {
      const dir = await this.ensureCache(repo);
      const base = `origin/${repo.default_branch}`;
      const head = `origin/${branch}`;
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
      const dir = await this.ensureCache(repo);
      const range = `origin/${repo.default_branch}...origin/${branch}`;
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

  async cleanup(sessionId: number, repos: Repo[]) {
    for (const repo of repos) {
      const wt = this.repoDir(sessionId, repo);
      if (existsSync(wt)) await this.withRepo(repo, () => run('git', ['worktree', 'remove', '--force', wt], this.cacheDir(repo)));
    }
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }
}
