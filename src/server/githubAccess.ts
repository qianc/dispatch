// "Who can act on GitHub here" (DISP-63): the accounts that may act on GitHub in a project, and
// whether the caller can start work there. With `verify`, each account's permission on each of the
// project's GitHub repos is asked of GitHub (as that account), and kept 10 minutes. No token leaves.
import type { Octokit } from '@octokit/rest';
import type { GithubAccess, GithubAccessAccount, GithubPermission, Project, Repo } from '../shared/types.ts';
import type { GitHub } from './github.ts';
import type { Identities } from './identities.ts';
import { isRefusal, needsGithub, type GithubIdentity, type IdentityRefusal } from './identity.ts';
import type { Store } from './store.ts';

const CACHE_MS = 10 * 60_000;
const ORDER: GithubPermission[] = ['none', 'read', 'write', 'admin'];

export interface GithubAccessDeps {
  store: Pick<Store, 'repos'>;
  github: Pick<GitHub, 'clientFor' | 'clientForToken' | 'accountsInfo'>;
  identities: Pick<Identities, 'listConnected' | 'get'>;
  installOwner: string;
  /** as whom `user` acts in `project` (resolveGithubIdentity) */
  identity: (user: string | null, project: Project) => GithubIdentity | IdentityRefusal;
}

/** The GitHub repos a project's work reaches: GitHub repos and hosted repos' upstreams ("owner/name"). */
function githubRepos(repos: Repo[]): { owner: string; repo: string }[] {
  return repos.flatMap((r) => {
    const kind = r.kind ?? (r.local_path ? 'local' : 'github');
    if (kind === 'github') return [{ owner: r.github_owner, repo: r.github_name }];
    if (kind === 'hosted' && r.upstream_owner && r.upstream_name) return [{ owner: r.upstream_owner, repo: r.upstream_name }];
    return [];
  });
}

/** GitHub's permissions object as one level. */
export function permissionOf(p: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean } | undefined): GithubPermission {
  if (!p) return 'none';
  if (p.admin) return 'admin';
  if (p.push || p.maintain) return 'write';
  if (p.pull || p.triage) return 'read';
  return 'none';
}

/** The weakest of several permissions (null if any could not be checked). */
function weakest(ps: (GithubPermission | null)[]): GithubPermission | null {
  if (ps.some((p) => p === null)) return null;
  return (ps as GithubPermission[]).reduce((a, b) => (ORDER.indexOf(b) < ORDER.indexOf(a) ? b : a), 'admin');
}

export class GithubAccessChecker {
  private deps: GithubAccessDeps;
  private cache = new Map<string, { at: number; permission: GithubPermission | null }>();

  constructor(deps: GithubAccessDeps) {
    this.deps = deps;
  }

  async view(project: Project, caller: string | null, verify: boolean): Promise<GithubAccess> {
    const { store, identities, installOwner, identity } = this.deps;
    const needs = needsGithub(store, project);
    const mine = needs ? identity(caller, project) : null;
    const you: GithubAccess['you'] = isRefusal(mine) ? { ok: false, message: mine.message, connect_url: mine.connect_url } : { ok: true };

    // as whom each person who could act here does act: their own connection, or the owner's env account
    const accounts: (GithubAccessAccount & { client: () => Octokit | null; key: string })[] = [];
    const people = [...new Set([...identities.listConnected().map((c) => c.user), installOwner])].sort();
    const env = await this.deps.github.accountsInfo().catch(() => []);
    for (const user of people) {
      const id = identity(user, project);
      if (isRefusal(id)) continue;
      if (id.source === 'user') {
        const token = id.token;
        accounts.push({ user, login: id.login, source: 'user', client: () => this.deps.github.clientForToken(token), key: `user:${user}:${id.login}` });
      } else if (id.source === 'owner-env') {
        const a = env.find((x) => x.name === id.account) ?? (id.account ? undefined : env[0]);
        if (!a) continue;
        accounts.push({ user, login: a.login, source: 'owner-env', account: a.name, client: () => this.deps.github.clientFor({ github_account: a.name }), key: `env:${a.name}` });
      }
    }

    const repos = verify ? githubRepos(store.repos(project.id)) : [];
    return {
      needs_github: needs,
      you,
      accounts: await Promise.all(accounts.map(async ({ client, key, ...a }) => {
        if (!verify) return a;
        const per = await Promise.all(repos.map(async (r) => ({ repo: `${r.owner}/${r.repo}`, permission: await this.check(key, client, r) })));
        return { ...a, permission: per.length ? weakest(per.map((p) => p.permission)) : null, repos: per };
      })),
    };
  }

  /** One account's permission on one repo, from GitHub (or the 10-minute cache). Not found: none. */
  private async check(key: string, client: () => Octokit | null, r: { owner: string; repo: string }): Promise<GithubPermission | null> {
    const k = `${key}|${r.owner}/${r.repo}`;
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.permission;
    let permission: GithubPermission | null;
    try {
      const octo = client();
      if (!octo) return null;
      const { data } = await octo.repos.get({ owner: r.owner, repo: r.repo });
      permission = permissionOf(data.permissions);
    } catch (e) {
      const status = (e as { status?: number }).status;
      // GitHub hides private repos the account cannot see
      if (status !== 404 && status !== 403) return null;
      permission = 'none';
    }
    this.cache.set(k, { at: Date.now(), permission });
    return permission;
  }
}
