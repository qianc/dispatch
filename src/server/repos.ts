// Adding a repo to a project: a GitHub repo (owner/name or URL), or a local folder on the worker host.
import type { Project, Repo } from '../shared/types.ts';
import type { Store } from './store.ts';
import { HttpError } from './routes/ctx.ts';
import type { WorkerHub } from './workerHub.ts';
import type { GitHub } from './github.ts';
import type { HostedGit } from './hosted.ts';

export const looksLikePath = (s: string) => /^(\/|~\/|~$|\.\.?\/)/.test(s.trim());

export interface LocalRepoInfo { path: string; name: string; default_branch: string; receive_deny_current_branch: string; root_sha?: string | null }

const workerName = (store: Store, id: number) => store.db.get<{ name: string }>('SELECT name FROM workers WHERE id = ?', id)?.name ?? `#${id}`;

async function inspect(hub: WorkerHub, workerId: number, path: string): Promise<LocalRepoInfo> {
  try {
    return await hub.cmd<LocalRepoInfo>(workerId, { c: 'inspect_local_repo', path }, 30_000);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

/** Is this folder the same repo as `repo`? The same first commit; a repo not checked yet has none to compare. */
const sameRepo = (repo: Repo, info: LocalRepoInfo) => {
  const known = (repo.placements ?? []).map((p) => p.root_sha).filter(Boolean);
  return !known.length || !info.root_sha || known.includes(info.root_sha);
};

/**
 * Add a local repo after the worker has checked it (inside LOCAL_REPO_DIRS, is a git repo). The
 * same repo already in the project on another worker (same first commit, or same name) gets this
 * folder as its copy on this worker (DISP-45).
 */
export async function addLocalRepo(store: Store, hub: WorkerHub, project: Project, path: string, opts: { default_branch?: string; check_command?: string | null; worker_id?: number | null } = {}) {
  const workerId = opts.worker_id ?? project.worker_id ?? store.defaultWorkerId();
  const info = await inspect(hub, workerId, path);
  const local = store.repos(project.id).filter((r) => r.kind === 'local');
  const existing = local.find((r) => r.placements?.some((p) => p.worker_id === workerId && p.local_path === info.path));
  if (existing) return { repo: existing, info, already: true };
  const bySha = info.root_sha ? local.find((r) => r.placements?.some((p) => p.root_sha === info.root_sha)) : undefined;
  const same = bySha ?? local.find((r) => r.github_name === info.name);
  if (same) {
    if (!sameRepo(same, info)) throw new HttpError(409, `This project already has a local repo named ${info.name}, and ${info.path} is a different repo (another first commit).`);
    const there = same.placements?.find((p) => p.worker_id === workerId);
    if (there) throw new HttpError(409, `${same.github_name} already has its copy on worker ${workerName(store, workerId)} at ${there.local_path}. Change that path in the repo's settings.`);
    return { repo: store.setPlacement(same.id, workerId, info.path, info.root_sha ?? null), info, already: false, copy: true };
  }
  const repo: Repo = store.addRepo(project.id, {
    github_owner: 'local', github_name: info.name, default_branch: opts.default_branch ?? info.default_branch,
    check_command: opts.check_command ?? null, local_path: info.path, worker_id: workerId, root_sha: info.root_sha ?? null,
  });
  return { repo, info, already: false };
}

/** Set a local repo's copy on a worker (new, or another path), after that worker checked the folder (DISP-45). */
export async function setPlacement(store: Store, hub: WorkerHub, repo: Repo, workerId: number, path: string) {
  if (repo.kind !== 'local') throw new HttpError(400, 'Only a local repo has copies on workers.');
  const info = await inspect(hub, workerId, path);
  const others = { ...repo, placements: (repo.placements ?? []).filter((p) => p.worker_id !== workerId) };
  if (!sameRepo(others, info)) throw new HttpError(409, `${info.path} is a different repo than ${repo.github_name} (another first commit).`);
  return { repo: store.setPlacement(repo.id, workerId, info.path, info.root_sha ?? null), info };
}

/**
 * Check every local repo copy on a worker (after its hello): the folder is still there and allowed,
 * is a git repo, and is still the same repo. Sessions only go to workers whose copies are ok.
 */
export async function checkPlacements(store: Store, hub: WorkerHub, workerId: number) {
  for (const { repo, placement } of store.placementsOn(workerId)) {
    try {
      const info = await hub.cmd<LocalRepoInfo>(workerId, { c: 'inspect_local_repo', path: placement.local_path }, 30_000);
      if (placement.root_sha && info.root_sha && info.root_sha !== placement.root_sha) {
        store.checkedPlacement(repo.id, workerId, 'mismatch', `${placement.local_path} now holds another repo (first commit ${info.root_sha.slice(0, 8)}, expected ${placement.root_sha.slice(0, 8)})`);
      } else store.checkedPlacement(repo.id, workerId, 'ok', null, info.root_sha ?? null);
    } catch (e) {
      if (!hub.isConnected(workerId)) return; // gone again: nothing was checked
      store.checkedPlacement(repo.id, workerId, 'missing', (e as Error).message);
    }
  }
}

/** Why this worker cannot run sessions on these local repos, or null when its copies of all are ok. */
export function placementProblem(store: Store, repos: Repo[], workerId: number): string | null {
  const bad = repos.filter((r) => r.kind === 'local').flatMap((r) => {
    const p = r.placements?.find((x) => x.worker_id === workerId);
    if (!p) return [`no copy of ${r.github_name}`];
    if (p.status !== 'ok') return [`${r.github_name} at ${p.local_path} is ${p.status}${p.detail ? ` (${p.detail})` : ''}`];
    return [];
  });
  return bad.length ? `Worker ${workerName(store, workerId)} has ${bad.join('; ')}.` : null;
}

/** A worker that can read a local repo now: a connected one with an ok copy, home first. */
export function readerFor(hub: WorkerHub, repo: Repo): number | null {
  const ok = (repo.placements ?? []).filter((p) => p.status === 'ok').map((p) => p.worker_id);
  const order = [repo.worker_id, ...ok].filter((id): id is number => id != null);
  return order.find((id) => ok.includes(id) && hub.isConnected(id)) ?? repo.worker_id ?? null;
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
