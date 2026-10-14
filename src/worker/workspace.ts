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

async function git(args: string[], cwd?: string) {
  const r = await run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.out}`);
  return r.out;
}

export class Workspaces {
  readonly root: string;
  private remoteBase: string;

  constructor(root: string, remoteBase = 'https://github.com') {
    this.root = root;
    this.remoteBase = remoteBase;
  }

  cacheDir(repo: Repo) {
    return join(this.root, 'cache', repo.github_owner, repo.github_name);
  }

  sessionDir(sessionId: number) {
    return join(this.root, 'sessions', String(sessionId));
  }

  repoDir(sessionId: number, repo: Repo) {
    return join(this.sessionDir(sessionId), repo.github_name);
  }

  /** Clone on first use, fetch afterwards. */
  async ensureCache(repo: Repo) {
    const dir = this.cacheDir(repo);
    if (!existsSync(join(dir, '.git'))) {
      await mkdir(join(dir, '..'), { recursive: true });
      await git(['clone', '--filter=blob:none', `${this.remoteBase}/${repo.github_owner}/${repo.github_name}.git`, dir]);
    } else {
      await git(['fetch', 'origin', '--prune'], dir);
    }
    return dir;
  }

  /** Make sure every repo of the session has its worktree; returns the cwd for Claude. */
  async prepare(spec: StartSpec): Promise<string> {
    await mkdir(this.sessionDir(spec.session_id), { recursive: true });
    for (const repo of spec.repos) {
      const cache = await this.ensureCache(repo);
      const wt = this.repoDir(spec.session_id, repo);
      const base = `origin/${repo.default_branch}`;
      if (existsSync(wt)) {
        if (!spec.branch) await git(['checkout', '--detach', base], wt);
        continue;
      }
      if (!spec.branch) {
        await git(['worktree', 'add', '--detach', wt, base], cache);
      } else if ((await run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${spec.branch}`], cache)).code === 0) {
        await git(['worktree', 'add', '-B', spec.branch, wt, `origin/${spec.branch}`], cache);
      } else {
        await git(['worktree', 'add', '-b', spec.branch, wt, base], cache);
      }
    }
    return spec.repos.length === 1 ? this.repoDir(spec.session_id, spec.repos[0]) : this.sessionDir(spec.session_id);
  }

  async pushBranch(repo: Repo, sessionId: number, branch: string) {
    const wt = this.repoDir(sessionId, repo);
    if (!existsSync(wt)) throw new Error(`No worktree for ${repo.github_name} in session ${sessionId}`);
    await git(['push', '-u', 'origin', branch], wt);
  }

  /** Merge `branch` into the default branch locally, run the check command, push. */
  async mergeLocal(repo: Repo, branch: string, message: string): Promise<{ ok: boolean; conflict?: boolean; output?: string }> {
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
      await git(['push', 'origin', `HEAD:${repo.default_branch}`], tmp);
      return { ok: true };
    } finally {
      await run('git', ['worktree', 'remove', '--force', tmp], cache);
    }
  }

  async cleanup(sessionId: number, repos: Repo[]) {
    for (const repo of repos) {
      const wt = this.repoDir(sessionId, repo);
      if (existsSync(wt)) await run('git', ['worktree', 'remove', '--force', wt], this.cacheDir(repo));
    }
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }
}
