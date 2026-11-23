// As whom a session acts on GitHub (DISP-63). One rule for every start path and every server-side
// GitHub call: the person who started it, with their own connection. The install owner may use the
// env accounts (today's behaviour); a session with no user uses the shared env account. Never
// another user's token.
import type { Project, Repo } from '../shared/types.ts';
import type { GithubCredential, Identities } from './identities.ts';
import type { Store } from './store.ts';

/** The starter's own account (`user`), or the env accounts: the owner's (`owner-env`) or the shared one (`shared`). */
export type GithubIdentity =
  | ({ source: 'user'; user: string } & GithubCredential)
  | { source: 'owner-env' | 'shared'; account: string | null };

export type RefusalCode = 'github_not_connected' | 'github_token_unreadable' | 'github_shared_missing' | 'worker_too_old' | 'user_removed';

/** No identity may act: the session must not start (403 with `code` and `connect_url`). */
export interface IdentityRefusal {
  refused: true;
  code: RefusalCode;
  /** whose connection is missing (null: the session has no user) */
  user: string | null;
  message: string;
  connect_url: string;
}

export interface IdentityDeps {
  identities: Pick<Identities, 'get'>;
  installOwner: string;
  /** the server's env accounts (GITHUB_TOKEN / GITHUB_ACCOUNTS) */
  envAccounts: { name: string }[];
  /** the GitHub OAuth App is set up: connecting is one click */
  oauth: boolean;
  /** the env GitHub accounts a worker has (live, or as last reported) */
  workerAccounts: (workerId: number) => string[];
}

export const isRefusal = (r: GithubIdentity | IdentityRefusal | null | undefined): r is IdentityRefusal => !!r && 'refused' in r;

/** Was `user` taken off a non-empty AUTH_USERS? The one check for tokens, devices, workers, apps and sessions. */
export const isRemovedUser = (authUsers: string[], user: string | null | undefined): user is string => !!user && authUsers.length > 0 && !authUsers.includes(user);

/**
 * A starter taken off a non-empty AUTH_USERS (DISP-195, DISP-200): their sessions neither start nor
 * resume, and nothing acts on GitHub as them. Null while they may use the install (or nobody started it).
 */
export function removedStarter(authUsers: string[], startedBy: string | null): IdentityRefusal | null {
  if (!isRemovedUser(authUsers, startedBy)) return null;
  return { refused: true, code: 'user_removed', user: startedBy, message: `${startedBy} may no longer use this install (not in AUTH_USERS), so their sessions do not run.`, connect_url: '/settings' };
}

/** The GitHub repos a project's work reaches: GitHub repos and hosted repos' upstreams ("owner/name"). */
export function githubRepos(repos: Repo[]): { owner: string; repo: string }[] {
  return repos.flatMap((r) => {
    const kind = r.kind ?? (r.local_path ? 'local' : 'github');
    if (kind === 'github') return [{ owner: r.github_owner, repo: r.github_name }];
    if (kind === 'hosted' && r.upstream_owner && r.upstream_name) return [{ owner: r.upstream_owner, repo: r.upstream_name }];
    return [];
  });
}

/** Does work in this project reach GitHub? */
export function needsGithub(store: Pick<Store, 'repos'>, project: Pick<Project, 'id'> | null | undefined): boolean {
  return !!project && githubRepos(store.repos(project.id)).length > 0;
}

/** Where to connect GitHub: the OAuth sign-in (back to `to`), else Settings. */
export function connectUrl(oauth: boolean, to: string) {
  return oauth ? `/api/github/oauth/start?to=${encodeURIComponent(to)}` : '/settings#your-github';
}

export function resolveGithubIdentity(deps: IdentityDeps, who: { started_by: string | null }, project: Pick<Project, 'key' | 'github_account'> | null, workerId?: number): GithubIdentity | IdentityRefusal {
  const account = project?.github_account ?? null;
  const link = connectUrl(deps.oauth, project ? `/p/${project.key}` : '/settings');
  const user = who.started_by;
  if (user === null) {
    if (deps.envAccounts.length || (workerId !== undefined && deps.workerAccounts(workerId).length)) return { source: 'shared', account };
    // nobody's own connection helps: the install owner sets up a shared account
    return {
      refused: true, code: 'github_shared_missing', user: null, connect_url: '/settings',
      message: 'This session has no user, and the server has no shared GitHub account (GITHUB_TOKEN or GITHUB_ACCOUNTS).',
    };
  }
  const owner = user === deps.installOwner;
  const cred = deps.identities.get(user);
  if (cred && 'token' in cred) {
    // the install owner keeps a project's own env account
    if (owner && account) return { source: 'owner-env', account };
    return { source: 'user', user, ...cred };
  }
  // the install owner without (a working) connection: the env accounts, as before users
  if (owner) return { source: 'owner-env', account };
  if (cred) {
    return {
      refused: true, code: 'github_token_unreadable', user, connect_url: link,
      message: `${user}'s GitHub connection cannot be used: ${cred.error} Dispatch never acts on GitHub with someone else's account. Connect again in Settings → Your GitHub.`,
    };
  }
  return {
    refused: true, code: 'github_not_connected', user, connect_url: link,
    message: `${user} has not connected GitHub, and Dispatch never acts on GitHub with someone else's account. Connect yours in Settings → Your GitHub.`,
  };
}
