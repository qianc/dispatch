import { afterEach, describe, expect, it } from 'vitest';
import type { GithubAccess } from '../src/shared/types.ts';
import { fakeGithub } from './github.ts';
import { as, startMultiUser } from './helpers.ts';

type Server = Awaited<ReturnType<typeof startMultiUser>>;

const BOB_TOKEN = 'ghp_bobsOwnToken0001';
const ENV_TOKEN = 'ghp_sharedEnvToken01';

// DISP-63: "Who can act on GitHub here" on the project page.
describe('GET /api/projects/:key/github-access', () => {
  let s: Server;
  afterEach(async () => {
    await s.app.close();
  });

  const setup = async (env: Record<string, string> = { GITHUB_TOKEN: ENV_TOKEN }) => {
    s = await startMultiUser(env);
    s.ctx.identities.profile = async (token) => {
      if (token !== BOB_TOKEN) throw new Error('GitHub did not accept this token.');
      return { id: 42, login: 'bob-gh', name: 'Bob Builder', email: 'bob@example.com', scopes: 'repo' };
    };
    // the env account's login, without asking GitHub
    s.ctx.github.accountsInfo = async () => s.ctx.cfg.githubAccounts.map((a) => ({ name: a.name, login: 'alice-gh', git_name: null, git_email: null }));
    await s.call('POST', '/projects', { key: 'GH', name: 'GitHub project' }, as('alice'));
    await s.call('POST', '/projects/GH/repos', { github_owner: 'me', github_name: 'gh' }, as('alice'));
    return s;
  };
  const connectBob = () => s.call('PUT', '/me/github', { token: BOB_TOKEN }, as('bob'));
  const get = (who: string, q = '') => s.call<GithubAccess>('GET', `/projects/GH/github-access${q}`, undefined, as(who));

  it('lists connected users and the install owner\'s env account, with no tokens', async () => {
    await setup();
    await connectBob();
    const r = await get('bob');
    expect(r.status).toBe(200);
    expect(r.data).toEqual({
      needs_github: true,
      you: { ok: true },
      accounts: [
        { user: 'alice', login: 'alice-gh', source: 'owner-env', account: 'default' },
        { user: 'bob', login: 'bob-gh', source: 'user' },
      ],
    });
    const text = JSON.stringify(r.data);
    expect(text).not.toContain(BOB_TOKEN);
    expect(text).not.toContain(ENV_TOKEN);
  });

  it('tells a user who has not connected GitHub, with the link to connect', async () => {
    await setup();
    const r = await get('bob');
    expect(r.data.you).toMatchObject({ ok: false, connect_url: '/settings#your-github' });
    expect(r.data.you.message).toContain('bob has not connected GitHub');
    expect(r.data.accounts.map((a) => a.user)).toEqual(['alice']);
  });

  it('a project that reaches no GitHub needs no identity', async () => {
    await setup({});
    await s.call('POST', '/projects', { key: 'LOC', name: 'Local' }, as('alice'));
    const r = await s.call<GithubAccess>('GET', '/projects/LOC/github-access', undefined, as('bob'));
    expect(r.data).toMatchObject({ needs_github: false, you: { ok: true } });
  });

  it('verify asks GitHub as each account, per repo, and keeps the answer', async () => {
    await setup();
    await connectBob();
    await s.call('POST', '/projects/GH/repos', { github_owner: 'me', github_name: 'secret' }, as('alice'));
    const gh = fakeGithub(s.ctx, {
      repos: {
        get: async ({ repo }: { repo: string }) => {
          if (repo === 'secret') throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: { permissions: { admin: false, push: true, pull: true } } };
        },
      },
    });
    // the env account's client is the fake's shared one
    s.ctx.github.clientFor = () => s.ctx.github.octo;

    const r = await get('bob', '?verify=1');
    const bob = r.data.accounts.find((a) => a.user === 'bob')!;
    const alice = r.data.accounts.find((a) => a.user === 'alice')!;
    expect(bob).toMatchObject({ permission: 'none', repos: expect.arrayContaining([{ repo: 'me/gh', permission: 'write' }, { repo: 'me/secret', permission: 'none' }]) });
    expect(alice.permission).toBe('none');
    expect(gh.by(BOB_TOKEN)).toEqual(['repos.get', 'repos.get']);
    expect(gh.by('shared')).toEqual(['repos.get', 'repos.get']);
    expect(JSON.stringify(r.data)).not.toContain(BOB_TOKEN);

    // the second look comes from the cache
    await get('alice', '?verify=1');
    expect(gh.calls).toHaveLength(4);
  });

  it('needs the read scope (in ROUTE_ACCESS)', async () => {
    await setup();
    const r = await s.call('GET', '/projects/GH/github-access');
    expect(r.status).toBe(401);
  });
});
