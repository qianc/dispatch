import type { Project, Repo } from '../src/shared/types.ts';
import { fakeGithub } from './github.ts';
import { startServer } from './helpers.ts';

type GhPr = Record<string, any>;

/** One open PR as GitHub's API gives it (`pulls.get`; the list leaves the computed fields out). */
export function ghPr(number: number, over: GhPr = {}): GhPr {
  return {
    number, html_url: `https://github.com/me/app/pull/${number}`, title: `PR ${number}`, state: 'open', merged_at: null, draft: false,
    user: { login: 'dependabot[bot]' }, head: { ref: `dep-${number}`, sha: `sha${number}` }, base: { ref: 'main' },
    updated_at: '2026-11-01T00:00:00Z', mergeable: true, mergeable_state: 'clean', changed_files: 2, body: '', ...over,
  };
}

/** `status` as an Octokit request error carries it. */
export const ghError = (status: number, message: string) => Object.assign(new Error(message), { status });

/**
 * A test server with project PP, GitHub repo me/app, and a fake GitHub that answers from `prs`
 * (the PRs of me/app by number; the test changes it). `repos` holds the PRs of other repos by
 * name. `fail.list` fails the list of me/app; `fail.review` fails every review. `hold.checks`: a
 * promise every read of check runs waits for.
 */
export async function prServer(start: (env?: Record<string, string>) => ReturnType<typeof startServer> = startServer, headers: Record<string, string> = {}) {
  const s = await start();
  const project: Project = (await s.call('POST', '/projects', { key: 'PP', name: 'PP' }, headers)).data;
  const repo: Repo = (await s.call('POST', '/projects/PP/repos', { github_owner: 'me', github_name: 'app' }, headers)).data;
  const prs = new Map<number, GhPr>();
  const repos = new Map<string, Map<number, GhPr>>([['app', prs]]);
  const checks = new Map<string, { name: string; status: string; conclusion: string | null }[]>();
  const fail: { list: unknown | null; review: unknown | null } = { list: null, review: null };
  const hold: { checks: Promise<void> | null } = { checks: null };
  const of = (a: { repo: string; pull_number: number }) => {
    const p = repos.get(a.repo)?.get(a.pull_number);
    if (!p) throw ghError(404, 'Not Found');
    return p;
  };
  const gh = fakeGithub(s.ctx, {
    pulls: {
      list: async (a: { repo: string; state?: string; head?: string; per_page?: number; page?: number }) => {
        if (fail.list && a.repo === 'app') throw fail.list;
        const all = [...(repos.get(a.repo)?.values() ?? [])]
          .filter((p) => a.state === 'all' || p.state === (a.state ?? 'open'))
          // `head` is `owner:branch`: a fork's branch of the same name belongs to another owner
          .filter((p) => !a.head || (`me:${p.head.ref}` === a.head && (!p.head.repo || p.head.repo.full_name.startsWith('me/'))))
          .map(({ mergeable: _m, mergeable_state: _s, changed_files: _c, ...listed }) => listed);
        const per = a.per_page ?? 30;
        return { data: all.slice(((a.page ?? 1) - 1) * per, (a.page ?? 1) * per) };
      },
      get: async (a: { repo: string; pull_number: number }) => ({ data: of(a) }),
      listFiles: async () => ({ data: [{ filename: 'package.json', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' }] }),
      createReview: async () => {
        if (fail.review) throw fail.review;
        return { data: { id: 1 } };
      },
      merge: async (a: { repo: string; pull_number: number }) => {
        Object.assign(of(a), { state: 'closed', merged_at: '2026-11-02T00:00:00Z' });
        return { data: {} };
      },
    },
    checks: {
      listForRef: async (a: { ref: string }) => {
        await hold.checks;
        return { data: { check_runs: checks.get(a.ref) ?? [] } };
      },
    },
    repos: { compareCommits: async () => ({ data: { behind_by: 0 } }) },
    // as Octokit: page after page until a short one
    paginate: async (fn: (a: Record<string, unknown>) => Promise<{ data: unknown[] }>, args: { per_page?: number }) => {
      const out: unknown[] = [];
      for (let page = 1; ; page++) {
        const { data } = await fn({ ...args, page });
        out.push(...data);
        if (data.length < (args.per_page ?? 30)) return out;
      }
    },
  });
  /** the arguments of every call of `method` */
  const args = (method: string) => gh.calls.filter((c) => c.method === method).map((c) => c.args as Record<string, any>);
  return { s, project, repo, prs, repos, checks, fail, hold, gh, args };
}
