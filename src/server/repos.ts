// Adding a repo to a project: a GitHub repo (owner/name or URL), or a local folder on the worker host.
import type { Project, Repo } from '../shared/types.ts';
import type { Store } from './store.ts';
import { HttpError } from './routes/ctx.ts';
import type { WorkerHub } from './workerHub.ts';
import type { GitHub } from './github.ts';
import type { HostedGit } from './hosted.ts';

export const looksLikePath = (s: string) => /^(\/|~\/|~$|\.\.?\/)/.test(s.trim());

export interface LocalRepoInfo { path: string; name: string; default_branch: string; receive_deny_current_branch: string }

/** Add a local repo after the worker has checked it (inside LOCAL_REPO_DIRS, is a git repo). */
export async function addLocalRepo(store: Store, hub: WorkerHub, project: Project, path: string, opts: { default_branch?: string; check_command?: string | null; worker_id?: number | null } = {}) {
  const workerId = opts.worker_id ?? project.worker_id ?? store.defaultWorkerId();
  // all of a project's local repos are on one worker (its sessions run there)
  const other = store.repos(project.id).find((r) => r.kind === 'local' && r.worker_id && r.worker_id !== workerId);
  if (other) {
    const name = store.db.get<{ name: string }>('SELECT name FROM workers WHERE id = ?', other.worker_id!)?.name ?? other.worker_id;
    throw new HttpError(400, `This project's local repos are on worker ${name}; add this one there too, or use another project.`);
  }
  let info: LocalRepoInfo;
  try {
    info = await hub.cmd<LocalRepoInfo>(workerId, { c: 'inspect_local_repo', path }, 30_000);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const existing = store.repos(project.id).find((r) => r.local_path === info.path);
  if (existing) return { repo: existing, info, already: true };
  const repo: Repo = store.addRepo(project.id, {
    github_owner: 'local', github_name: info.name, default_branch: opts.default_branch ?? info.default_branch,
    check_command: opts.check_command ?? null, local_path: info.path, worker_id: workerId,
  });
  return { repo, info, already: false };
}

/** What to tell the owner about pushing merges into a checked-out branch. */
export function mergeNote(info: LocalRepoInfo) {
  return info.receive_deny_current_branch === 'updateInstead'
    ? null
    : `Merging pushes ${info.default_branch} into ${info.path}. If that branch is checked out there, run \`git config receive.denyCurrentBranch updateInstead\` in the repo first.`;
}

const OWNER_NAME = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** "owner/name" → its parts, or an error the owner can read. */
export function ownerName(v: string): { owner: string; name: string } {
  const m = OWNER_NAME.exec(v.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''));
  if (!m) throw new HttpError(400, `"${v}" is not a GitHub repo: write it as owner/name.`);
  return { owner: m[1], name: m[2] };
}

/**
 * A repo the server keeps itself: empty, or a copy of a GitHub repo (with the project's GitHub
 * account). `upstream` links a GitHub repo that merges are pushed to.
 */
export async function addHostedRepo(store: Store, hosted: HostedGit, github: GitHub, project: Project, input: { name: string; default_branch?: string; import?: string; upstream?: string; check_command?: string | null }) {
  if (!REPO_NAME.test(input.name)) throw new HttpError(400, 'A repo name is letters, digits, dots, dashes and underscores.');
  if (store.repos(project.id).some((r) => r.github_name === input.name)) throw new HttpError(409, `This project already has a repo named ${input.name}.`);
  const from = input.import ? ownerName(input.import) : null;
  const up = input.upstream ? ownerName(input.upstream) : null;
  const repo = store.addRepo(project.id, {
    github_owner: 'hosted', github_name: input.name, default_branch: input.default_branch ?? 'main', check_command: input.check_command ?? null,
    kind: 'hosted', upstream_owner: up?.owner ?? null, upstream_name: up?.name ?? null,
  });
  try {
    if (from) {
      // the copy keeps the source's default branch (master, trunk…) unless one was given
      const branch = await hosted.importFrom(repo, github.gitUrl(from.owner, from.name), github.gitEnv(repo), input.default_branch);
      if (branch !== repo.default_branch) store.updateRepo(repo.id, { default_branch: branch });
    } else await hosted.create(repo, repo.default_branch);
  } catch (e) {
    store.deleteRepo(repo.id);
    throw new HttpError(400, `Could not ${from ? `import ${input.import}` : 'create the repo'}: ${(e as Error).message}`);
  }
  return store.repo(repo.id)!;
}
