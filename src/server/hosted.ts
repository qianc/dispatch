// Hosted repos: bare git repos the server keeps itself (DATA_DIR/git/r<id>.git). Workers clone from
// and push to them over HTTP (routes/git.ts); review, diff, file reads and merges run here, so they
// need no worker. A linked GitHub repo ("upstream") gets the merged default branch pushed to it.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BranchFile, BranchStatus, Repo } from '../shared/types.ts';

type Env = Record<string, string | undefined>;

interface Out { code: number; out: string; err: string; bytes: Buffer }

/** Run git with GIT_DIR set to a bare repo; never through a shell. */
function git(gitDir: string | null, args: string[], env: Env = {}, cwd?: string): Promise<Out> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        // merges made here need an identity; the server's env may not have one
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Dispatch',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'dispatch@localhost',
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? process.env.GIT_AUTHOR_NAME ?? 'Dispatch',
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? process.env.GIT_AUTHOR_EMAIL ?? 'dispatch@localhost',
        ...(gitDir ? { GIT_DIR: gitDir } : {}),
        ...env,
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      const bytes = Buffer.concat(out);
      resolve({ code: code ?? 1, out: bytes.toString('utf8'), err: Buffer.concat(err).toString('utf8'), bytes });
    });
  });
}

async function must(gitDir: string | null, args: string[], env: Env = {}, cwd?: string) {
  const r = await git(gitDir, args, env, cwd);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.err || r.out).trim()}`);
  return r.out.trim();
}

/**
 * pre-receive hook: the default branch only moves forward. A push cannot rewrite it (force-push)
 * or delete it; other branches are free. The server's own merges (update-ref) do not run hooks.
 */
const GUARD_HOOK = `#!/bin/sh
# Dispatch: the default branch only moves forward (no force-push, no delete)
default=$(git symbolic-ref --short HEAD)
while read old new ref; do
  [ "$ref" = "refs/heads/$default" ] || continue
  case "$new" in *[!0]*) ;; *) echo "Dispatch: $default cannot be deleted" >&2; exit 1;; esac
  case "$old" in *[!0]*) ;; *) continue;; esac
  if ! git merge-base --is-ancestor "$old" "$new"; then
    echo "Dispatch: $default only moves forward here (no force-push)" >&2; exit 1
  fi
done
exit 0
`;

export type MergeResult = { ok: true; sha: string } | { ok: false; conflict: boolean; output: string };

export class HostedGit {
  readonly root: string;
  private locks = new Map<number, Promise<unknown>>();

  constructor(dataDir: string) {
    this.root = join(dataDir, 'git');
  }

  dir(repo: Pick<Repo, 'id'>) {
    return join(this.root, `r${repo.id}.git`);
  }

  exists(repo: Pick<Repo, 'id'>) {
    return existsSync(join(this.dir(repo), 'HEAD'));
  }

  /** One change at a time per repo (merges, ref updates). */
  private serial<T>(repo: Repo, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repo.id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(repo.id, next);
    return next;
  }

  private safe = new Set<number>();

  /** The guard hook and a ref log, also for repos made before they existed (once per process). */
  async ensureSafe(repo: Pick<Repo, 'id'>) {
    if (this.safe.has(repo.id)) return;
    const dir = this.dir(repo);
    await must(dir, ['config', 'core.logAllRefUpdates', 'always']);
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(join(dir, 'hooks', 'pre-receive'), GUARD_HOOK);
    await chmod(join(dir, 'hooks', 'pre-receive'), 0o755);
    this.safe.add(repo.id);
  }

  /** The repo's default branch (HEAD), e.g. after a change in the app. */
  async setDefaultBranch(repo: Pick<Repo, 'id'>, branch: string) {
    await must(this.dir(repo), ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  }

  private async configure(dir: string, defaultBranch: string) {
    await must(dir, ['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`]);
    // pushes over HTTP (http-backend allows them once the request is authenticated)
    await must(dir, ['config', 'http.receivepack', 'true']);
    // workers clone with --filter=blob:none
    await must(dir, ['config', 'uploadpack.allowFilter', 'true']);
  }

  async create(repo: Repo, defaultBranch: string) {
    const dir = this.dir(repo);
    if (this.exists(repo)) throw new Error(`Hosted repo ${dir} already exists`);
    await mkdir(this.root, { recursive: true });
    await must(null, ['init', '--quiet', '--bare', dir]);
    await this.configure(dir, defaultBranch);
    await this.ensureSafe(repo);
  }

  /**
   * A copy of an existing repo (all branches and tags), e.g. from GitHub. Its default branch is the
   * source's, unless one is given. Returns the default branch.
   */
  async importFrom(repo: Repo, url: string, env: Env, defaultBranch?: string): Promise<string> {
    const dir = this.dir(repo);
    if (this.exists(repo)) throw new Error(`Hosted repo ${dir} already exists`);
    await mkdir(this.root, { recursive: true });
    try {
      await must(null, ['clone', '--quiet', '--bare', url, dir], env);
      const branch = defaultBranch ?? ((await git(dir, ['symbolic-ref', '--short', 'HEAD'])).out.trim() || 'main');
      await this.configure(dir, branch);
      await this.ensureSafe(repo);
      return branch;
    } catch (e) {
      // leave nothing half-made behind (the next try with this id would find it)
      await rename(dir, `${dir}.failed-${Date.now()}`).catch(() => undefined);
      throw e;
    }
  }

  /** Keep the data when a repo is removed from a project. */
  async retire(repo: Repo) {
    if (this.exists(repo)) await rename(this.dir(repo), join(this.root, `r${repo.id}.deleted-${Date.now()}.git`));
  }

  private base(repo: Repo) {
    return `refs/heads/${repo.default_branch}`;
  }

  async branchStatus(repo: Repo, branch: string): Promise<BranchStatus> {
    const dir = this.dir(repo);
    const head = `refs/heads/${branch}`;
    const sha = await git(dir, ['rev-parse', '--verify', '--quiet', head]);
    if (sha.code !== 0) return { exists: false, ahead: 0, behind: 0, merged: false, conflicts: false, head_sha: null };
    const base = this.base(repo);
    const counts = (await must(dir, ['rev-list', '--left-right', '--count', `${base}...${head}`])).split(/\s+/).map(Number);
    const merged = (await git(dir, ['merge-base', '--is-ancestor', head, base])).code === 0;
    const conflicts = !merged && (await git(dir, ['merge-tree', '--write-tree', base, head])).code === 1;
    return { exists: true, behind: counts[0], ahead: counts[1], merged, conflicts, head_sha: sha.out.trim() };
  }

  async branchDiff(repo: Repo, branch: string): Promise<BranchFile[]> {
    const dir = this.dir(repo);
    const range = `${this.base(repo)}...refs/heads/${branch}`;
    const stat = await must(dir, ['diff', '--numstat', '--no-renames', range]);
    const names = await must(dir, ['diff', '--name-status', '--no-renames', range]);
    const status = new Map(names.split('\n').filter(Boolean).map((l) => {
      const [s, f] = l.split('\t');
      return [f, ({ A: 'added', D: 'removed', M: 'modified' } as Record<string, string>)[s[0]] ?? 'changed'];
    }));
    const files: BranchFile[] = [];
    for (const line of stat.split('\n').filter(Boolean)) {
      const [add, del, filename] = line.split('\t');
      const patch = add === '-' ? null : (await must(dir, ['diff', '--no-renames', range, '--', filename])).split('\n').slice(4).join('\n') || null;
      files.push({ filename, status: status.get(filename) ?? 'modified', additions: Number(add) || 0, deletions: Number(del) || 0, patch: patch && patch.length > 200_000 ? null : patch });
    }
    return files;
  }

  /** A file as it is on the default branch. */
  async readFile(repo: Repo, path: string): Promise<Buffer> {
    const r = await git(this.dir(repo), ['show', `${this.base(repo)}:${path}`]);
    if (r.code !== 0) throw new Error(`${path} is not on ${repo.default_branch}`);
    return r.bytes;
  }

  /**
   * Merge a branch into the default branch without a working tree: merge-tree makes the result,
   * commit-tree the commit, and update-ref moves the branch only if nobody else moved it meanwhile.
   */
  merge(repo: Repo, branch: string, message: string, method: 'merge' | 'squash'): Promise<MergeResult> {
    return this.serial(repo, async () => {
      const dir = this.dir(repo);
      const baseRef = this.base(repo);
      const base = await must(dir, ['rev-parse', '--verify', baseRef]);
      const head = await must(dir, ['rev-parse', '--verify', `refs/heads/${branch}`]);
      if ((await git(dir, ['merge-base', '--is-ancestor', head, base])).code === 0) return { ok: true, sha: base };
      const mt = await git(dir, ['merge-tree', '--write-tree', '--name-only', base, head]);
      if (mt.code === 1) return { ok: false, conflict: true, output: mt.out.trim() };
      if (mt.code !== 0) return { ok: false, conflict: false, output: (mt.err || mt.out).trim() };
      const tree = mt.out.split('\n')[0].trim();
      const parents = method === 'squash' ? ['-p', base] : ['-p', base, '-p', head];
      const commit = await must(dir, ['commit-tree', tree, ...parents, '-m', message]);
      const moved = await git(dir, ['update-ref', '-m', `dispatch: ${message}`, baseRef, commit, base]);
      if (moved.code !== 0) return { ok: false, conflict: false, output: `${repo.default_branch} moved during the merge; try again.` };
      return { ok: true, sha: commit };
    });
  }

  deleteBranch(repo: Repo, branch: string): Promise<boolean> {
    if (branch === repo.default_branch) return Promise.resolve(false);
    return this.serial(repo, async () => (await git(this.dir(repo), ['update-ref', '-d', `refs/heads/${branch}`])).code === 0);
  }

  /** Push refs to the upstream (GitHub). `env` carries the credentials (never in the URL). */
  async pushUpstream(repo: Repo, url: string, refs: string[], env: Env): Promise<{ ok: boolean; output: string }> {
    const r = await git(this.dir(repo), ['push', '--porcelain', url, ...refs.map((ref) => `${ref}:${ref}`)], env);
    return { ok: r.code === 0, output: (r.err || r.out).trim() };
  }

  /** Bring the upstream's default branch here: fast-forward only (a PR merged on GitHub). */
  fetchUpstreamDefault(repo: Repo, url: string, env: Env): Promise<{ ok: boolean; output: string }> {
    return this.serial(repo, async () => {
      const ref = this.base(repo);
      const r = await git(this.dir(repo), ['fetch', '--quiet', url, `${ref}:${ref}`], env);
      return { ok: r.code === 0, output: (r.err || r.out).trim() };
    });
  }
}
