// Releases: which connected worker can release which of a project's repos (from the releases
// in each worker's own config), and labelling the items a release holds.
import { compareVersions, highestLabelVersion, maxVersion, proposeVersion, unreleased } from '../shared/release.ts';
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

export interface ReleaseProposal {
  last: { version: string; from: 'tag' | 'file' | 'label' } | null;
  proposed: string;
  bump: 'minor' | 'patch' | 'first';
  items: Pick<Item, 'id' | 'key' | 'type' | 'title'>[];
  label_prefix: string;
  command: string | null;
  notes: string | null;
  warning?: string;
}

/**
 * The last release (newest of the repo's version tag, its VERSION file and the project's release
 * labels, so a version already used is never proposed again) and the next version.
 */
export async function releaseProposal(deps: { store: Store; hub: WorkerHub }, project: Project, opt: ReleaseOption): Promise<ReleaseProposal> {
  const repo = deps.store.repo(opt.repo_id)!;
  const all = deps.store.items(project.id);
  let found: { tag: string | null; file: string | null } = { tag: null, file: null };
  let warning: string | undefined;
  try {
    const res = await deps.hub.cmd<{ tag?: string | null; file?: string | null }>(opt.worker_id, { c: 'release_version', repo }, 60_000);
    found = { tag: res?.tag ?? null, file: res?.file ?? null };
  } catch (e) {
    warning = `Could not read the version tags of ${opt.repo} on ${opt.worker}: ${(e as Error).message}`;
  }
  const label = highestLabelVersion(all, opt.label_prefix);
  const candidates = [['tag', found.tag], ['file', found.file], ['label', label]] as const;
  const best = maxVersion(candidates.map(([, v]) => v));
  const last = best ? { version: best, from: candidates.find(([, v]) => v && compareVersions(v, best) === 0)![0] } : null;
  const items = unreleased(all, opt.label_prefix);
  const next = proposeVersion(last?.version ?? null, items);
  return {
    last, proposed: next.version, bump: next.bump,
    items: items.map((i) => ({ id: i.id, key: i.key, type: i.type, title: i.title })),
    label_prefix: opt.label_prefix, command: opt.command, notes: opt.notes,
    ...(warning ? { warning } : {}),
  };
}
