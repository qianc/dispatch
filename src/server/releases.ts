// Releases: which connected worker can release which of a project's repos (from the releases
// in each worker's own config), and labelling the items a release holds.
import type { Item, Project, ReleaseCapability, Repo } from '../shared/types.ts';
import type { Store } from './store.ts';
import type { WorkerHub } from './workerHub.ts';
import type { Workers } from './workers.ts';

export interface ReleaseOption {
  worker_id: number;
  worker: string;
  repo_id: number;
  /** owner/name, or the folder name of a local repo */
  repo: string;
  cap_repo: string;
  label_prefix: string;
  command: string | null;
  notes: string | null;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** Does a worker's capability name this repo? owner/name, a local path on that worker, or a repo name unique in the project. */
export function matchesRepo(cap: ReleaseCapability, repo: Repo, workerId: number, projectRepos: Repo[]): boolean {
  if (repo.kind === 'hosted') return false;
  const want = cap.repo.trim();
  if (repo.kind === 'local') {
    if (repo.worker_id !== workerId) return false;
    if (want.startsWith('/')) return !!repo.local_path && trimSlash(repo.local_path) === trimSlash(want);
  } else if (want.toLowerCase() === `${repo.github_owner}/${repo.github_name}`.toLowerCase()) return true;
  if (want.includes('/')) return false;
  const same = projectRepos.filter((r) => r.kind !== 'hosted' && r.github_name.toLowerCase() === want.toLowerCase());
  return same.length === 1 && same[0].id === repo.id;
}

export function releaseOptions(deps: { store: Store; hub: WorkerHub; workers: Workers }, project: Project): ReleaseOption[] {
  const repos = deps.store.repos(project.id);
  const out: ReleaseOption[] = [];
  for (const workerId of deps.hub.connectedIds()) {
    const worker = deps.workers.get(workerId);
    if (!worker || worker.revoked_at) continue;
    for (const cap of deps.hub.facts(workerId)?.releases ?? []) {
      for (const repo of repos) {
        if (!matchesRepo(cap, repo, workerId, repos)) continue;
        if (out.some((o) => o.worker_id === workerId && o.repo_id === repo.id)) continue;
        out.push({
          worker_id: workerId, worker: worker.name, repo_id: repo.id,
          repo: repo.kind === 'local' ? repo.github_name : `${repo.github_owner}/${repo.github_name}`,
          cap_repo: cap.repo, label_prefix: cap.label_prefix, command: cap.command, notes: cap.notes,
        });
      }
    }
  }
  return out;
}

/** Add <prefix><version> to these items (default: every done item not yet in a release of this line). Returns the items released. */
export function labelReleased(store: Store, projectId: number, prefix: string, version: string, items?: Item[], emit?: (it: Item) => void): Item[] {
  const tag = `${prefix}${version}`;
  const targets = items?.length ? items : store.items(projectId, { status: ['done'] }).filter((i) => !i.labels.some((l) => l.startsWith(prefix)));
  for (const it of targets) {
    if (it.labels.includes(tag)) continue;
    const up = store.updateItem(it.id, { labels: [...it.labels, tag] });
    emit?.(up);
  }
  return targets;
}
