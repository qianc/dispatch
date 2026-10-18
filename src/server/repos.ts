// Adding a repo to a project: a GitHub repo (owner/name or URL), or a local folder on the worker host.
import type { Project, Repo } from '../shared/types.ts';
import type { Store } from './store.ts';
import { HttpError } from './routes/ctx.ts';
import type { WorkerHub } from './workerHub.ts';

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
