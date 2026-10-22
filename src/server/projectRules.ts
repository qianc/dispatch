// A project's own instructions for agents (CLAUDE.md, AGENTS.md on its repos' default branches).
// Agents that file items in a project must follow them over Dispatch's defaults (type, ids, fields).
import type { Project, Repo } from '../shared/types.ts';
import type { HostedGit } from './hosted.ts';
import type { Store } from './store.ts';
import type { WorkerHub } from './workerHub.ts';

export const RULE_FILES = ['CLAUDE.md', 'AGENTS.md'];
const MAX_CHARS = 30_000;

type Deps = { store: Store; hub: WorkerHub; hosted: HostedGit };

/** A file from a repo's default branch: a hosted repo is read here, others on their worker. */
export async function readRepoFile({ store, hub, hosted }: Deps, project: Project, repo: Repo, path: string): Promise<Buffer> {
  if (repo.kind === 'hosted') return hosted.readFile(repo, path);
  const worker = repo.worker_id ?? project.worker_id ?? store.defaultWorkerId();
  const res = await hub.cmd<{ base64: string }>(worker, { c: 'read_file', repo, path }, 60_000);
  return Buffer.from(res.base64, 'base64');
}

/** The project's instruction files as one markdown text; '' when it has none (or no repo can be read). */
export async function projectRules(deps: Deps, project: Project): Promise<string> {
  const parts: string[] = [];
  for (const repo of deps.store.repos(project.id)) {
    for (const name of RULE_FILES) {
      const text = await readRepoFile(deps, project, repo, name).then((b) => b.toString('utf8').trim(), () => '');
      if (text) parts.push(`### ${name} of ${repo.github_name}\n\n${text.slice(0, MAX_CHARS)}`);
    }
  }
  return parts.join('\n\n');
}
