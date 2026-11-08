// Releases: which connected worker can release which of a project's repos (from the releases
// in each worker's own config), and labelling the items a release holds.
import { compareVersions, highestLabelVersion, isReleaseDate, labelDate, lastLabelDate, MANY_RELEASE_ITEMS, maxVersion, proposeVersion, unreleased } from '../shared/release.ts';
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
    // that worker's own copy (DISP-45)
    const copy = repo.placements ? repo.placements.find((p) => p.worker_id === workerId)?.local_path : repo.worker_id === workerId ? repo.local_path : null;
    if (!copy) return false;
    if (want.startsWith('/')) return trimSlash(copy) === trimSlash(want);
  } else if (want.toLowerCase() === `${repo.github_owner}/${repo.github_name}`.toLowerCase()) return true;
  if (want.includes('/')) return false;
  const same = projectRepos.filter((r) => r.kind !== 'hosted' && r.github_name.toLowerCase() === want.toLowerCase());
  return same.length === 1 && same[0].id === repo.id;
}

export function releaseOptions(deps: { store: Store; hub: WorkerHub; workers: Workers }, project: Project, owner?: string): ReleaseOption[] {
  const repos = deps.store.repos(project.id);
  const out: ReleaseOption[] = [];
  for (const workerId of deps.hub.connectedIds()) {
    const worker = deps.workers.get(workerId);
    if (!worker || worker.revoked_at) continue;
    // only workers of whoever releases (DISP-63)
    if (owner !== undefined && worker.owner !== owner) continue;
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

/** The items to label when no keys are given: unreleased since `since`, else since the last release in the labels. With no date, only a short list. */
function unreleasedTargets(all: Item[], prefix: string, version: string, since?: string): Item[] {
  if (since !== undefined && !isReleaseDate(since)) throw new Error(`since "${since}" is not a date. Use YYYY-MM-DD or an ISO date and time.`);
  const date = since ?? lastLabelDate(all, prefix, version);
  const targets = unreleased(all, prefix, date);
  if (!date && targets.length > MANY_RELEASE_ITEMS) {
    throw new Error(`${targets.length} done items have no release label and no ${prefix} label dates a last release, so all of them would be labelled. Pass since (the date of the last release) or the keys of the items.`);
  }
  return targets;
}

/** Add <prefix><version> to these items (default: the done items since the last release, see unreleasedTargets). Returns the items released. */
export function labelReleased(store: Store, projectId: number, prefix: string, version: string, items?: Item[], emit?: (it: Item) => void, since?: string): Item[] {
  const tag = `${prefix}${version}`;
  const targets = items?.length ? items : unreleasedTargets(store.items(projectId), prefix, version, since);
  for (const it of targets) {
    if (it.labels.includes(tag)) continue;
    const up = store.updateItem(it.id, { labels: [...it.labels, tag] });
    emit?.(up);
  }
  return targets;
}

export interface ReleaseProposal {
  /** date: when that release was made; null when it cannot be found */
  last: { version: string; from: 'tag' | 'file' | 'label'; date: string | null } | null;
  proposed: string;
  bump: 'minor' | 'patch' | 'first' | 'release';
  items: Pick<Item, 'id' | 'key' | 'type' | 'title'>[];
  /** done items with no label that are older than the last release: not in this one */
  older: number;
  label_prefix: string;
  command: string | null;
  notes: string | null;
  warning?: string;
}

/** Items a release of this repo can hold: not released yet, and not merged only into other repos of the project. */
export function releasable(store: Store, projectId: number, all: Item[], opt: Pick<ReleaseOption, 'repo_id' | 'label_prefix'>, since?: string | null): Item[] {
  const merged = store.mergedRepos(projectId);
  return unreleased(all, opt.label_prefix, since).filter((i) => merged.get(i.id)?.includes(opt.repo_id) ?? true);
}

/** What a worker says about a repo's last version. Older workers send only tag and file. */
interface FoundVersion {
  tag: string | null;
  tag_date?: string | null;
  file: string | null;
  file_date?: string | null;
  /** the version in the VERSION file has a tag on the worker */
  file_tagged?: boolean;
  fetch_error?: string | null;
}

/**
 * The last release (newest of the repo's version tag, its VERSION file and the project's release
 * labels, so a version already used is never proposed again), the next version, and the items
 * done since that release.
 */
export async function releaseProposal(deps: { store: Store; hub: WorkerHub }, project: Project, opt: ReleaseOption): Promise<ReleaseProposal> {
  const repo = deps.store.repo(opt.repo_id)!;
  const all = deps.store.items(project.id);
  let found: FoundVersion = { tag: null, file: null };
  const warnings: string[] = [];
  try {
    const res = await deps.hub.cmd<Partial<FoundVersion>>(opt.worker_id, { c: 'release_version', repo }, 60_000);
    found = { ...res, tag: res?.tag ?? null, file: res?.file ?? null };
  } catch (e) {
    warnings.push(`Could not read the version tags of ${opt.repo} on ${opt.worker}: ${(e as Error).message}`);
  }
  if (found.fetch_error) warnings.push(`Could not fetch the tags of ${opt.repo} on ${opt.worker}, so they can be behind the repo: ${found.fetch_error}`);
  const label = highestLabelVersion(all, opt.label_prefix);
  const candidates = [['tag', found.tag], ['file', found.file], ['label', label]] as const;
  const best = maxVersion(candidates.map(([, v]) => v));
  const isBest = (v: string | null) => !!v && !!best && compareVersions(v, best) === 0;
  const date = [isBest(found.tag) && found.tag_date, isBest(found.file) && found.file_date, isBest(label) && labelDate(all, opt.label_prefix, best!)].find(Boolean) || null;
  const last = best ? { version: best, from: candidates.find(([, v]) => isBest(v))![0], date } : null;
  if (isBest(found.file) && found.file_tagged === false) warnings.push(`The VERSION file says ${found.file}, but ${opt.worker} has no tag for it.`);
  if (last && !date) warnings.push(`Could not find the date of ${last.version}, so this list holds every done item with no release label.`);
  const items = releasable(deps.store, project.id, all, opt, date);
  const next = proposeVersion(last?.version ?? null, items);
  return {
    last, proposed: next.version, bump: next.bump,
    items: items.map((i) => ({ id: i.id, key: i.key, type: i.type, title: i.title })),
    older: releasable(deps.store, project.id, all, opt).length - items.length,
    label_prefix: opt.label_prefix, command: opt.command, notes: opt.notes,
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  };
}
