import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReleaseSource } from '../src/server/updates.ts';
import { as, startMultiUser, startServer } from './helpers.ts';

const sha = (c: string) => c.repeat(40);

/**
 * A release branch as a list of commits, oldest first, and tags on some of them (or on a commit
 * that is not on the branch).
 */
export function fakeSource(branch: string[], tags: { name: string; sha: string }[] = []) {
  const src = {
    branch,
    tags,
    fail: null as string | null,
    calls: 0,
    async latest() {
      src.calls++;
      if (src.fail) throw new Error(src.fail);
      return { branch_sha: src.branch.at(-1)!, branch_date: '2026-11-18T10:00:00Z', tags: src.tags };
    },
    async compare(base: string, head: string) {
      const b = src.branch.findIndex((c) => c.startsWith(base)), h = src.branch.findIndex((c) => c.startsWith(head));
      if (b < 0 || h < 0) return { status: 'diverged' as const, ahead_by: 1, commits: [] };
      if (b === h) return { status: 'identical' as const, ahead_by: 0, commits: [] };
      if (b > h) return { status: 'behind' as const, ahead_by: 0, commits: [] };
      return { status: 'ahead' as const, ahead_by: h - b, commits: src.branch.slice(b + 1, h + 1).map((c) => ({ sha: c, message: `commit ${c[0]}\n\nbody` })) };
    },
  };
  return src satisfies ReleaseSource & Record<string, unknown>;
}

describe('finding new versions of Dispatch (DISP-112)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    s = await startServer({ UPDATE_REPO: 'you/dispatch' });
    s.ctx.version.sha = sha('a');
  });
  afterEach(() => s.app.close());

  it('says how far behind the server is, with the first lines of the commits', async () => {
    s.ctx.updates.source = fakeSource([sha('a'), sha('b'), sha('c')]);
    const info = (await s.call('POST', '/update/check')).data;
    expect(info.repo).toBe('you/dispatch');
    expect(info.branch).toBe('main');
    expect(info.version.sha).toBe(sha('a'));
    expect(info.state).toMatchObject({ commit: { sha: sha('c') }, tag: null, behind_by: 2, on_branch: true, error: null });
    // newest first
    expect(info.state.commits).toEqual([{ sha: sha('c'), subject: 'commit c' }, { sha: sha('b'), subject: 'commit b' }]);
    expect(info.target).toEqual({ sha: sha('c'), tag: null });
    expect(info.settings).toEqual({ auto: false, follow: 'commits' });
    // and it is kept
    expect((await s.call('GET', '/update')).data.state.behind_by).toBe(2);
  });

  it('the highest version tag on the branch counts; a tag off the branch does not', async () => {
    s.ctx.updates.source = fakeSource([sha('a'), sha('b'), sha('c')], [
      { name: 'v1.2.0', sha: sha('b') },
      { name: 'v1.10.0', sha: sha('e') }, // not on the branch
      { name: 'nightly', sha: sha('c') },
      { name: 'v1.0.0', sha: sha('a') },
    ]);
    let info = (await s.call('POST', '/update/check')).data;
    expect(info.state.tag).toEqual({ name: 'v1.2.0', sha: sha('b'), ahead: true });
    // following commits: the newest commit; following tags: the tag's commit
    expect(info.target).toEqual({ sha: sha('c'), tag: null });
    info = (await s.call('PUT', '/update/settings', { follow: 'tags' })).data;
    expect(info.settings).toEqual({ auto: false, follow: 'tags' });
    expect(info.target).toEqual({ sha: sha('b'), tag: 'v1.2.0' });

    // the server runs the tag's commit: nothing to do when following tags
    s.ctx.version.sha = sha('b');
    info = (await s.call('POST', '/update/check')).data;
    expect(info.state.tag).toEqual({ name: 'v1.2.0', sha: sha('b'), ahead: false });
    expect(info.target).toBeNull();
  });

  it('a server that is up to date, ahead of the branch or off it has no target', async () => {
    const src = fakeSource([sha('a'), sha('b')]);
    s.ctx.updates.source = src;
    s.ctx.version.sha = sha('b');
    let info = (await s.call('POST', '/update/check')).data;
    expect(info.state).toMatchObject({ behind_by: 0, on_branch: true });
    expect(info.target).toBeNull();

    s.ctx.version.sha = sha('f'); // a commit the branch does not have
    info = (await s.call('POST', '/update/check')).data;
    expect(info.state).toMatchObject({ behind_by: null, on_branch: false });
    expect(info.target).toBeNull();

    s.ctx.version.sha = null; // an image built without DISPATCH_VERSION
    info = (await s.call('POST', '/update/check')).data;
    expect(info.state).toMatchObject({ commit: { sha: sha('b') }, behind_by: null });
    expect(info.target).toBeNull();
  });

  it('what was found for another commit of the server is no target', async () => {
    s.ctx.updates.source = fakeSource([sha('a'), sha('b')]);
    await s.call('POST', '/update/check');
    // the server was updated by hand since
    s.ctx.version.sha = sha('b');
    expect((await s.call('GET', '/update')).data.target).toBeNull();
  });

  it('keeps what it knew when GitHub does not answer, with the error', async () => {
    const src = fakeSource([sha('a'), sha('b')]);
    s.ctx.updates.source = src;
    await s.call('POST', '/update/check');
    src.fail = 'rate limit';
    const info = (await s.call('POST', '/update/check')).data;
    expect(info.state.error).toContain('rate limit');
    expect(info.state.behind_by).toBe(1);
    expect(info.target).toEqual({ sha: sha('b'), tag: null });
  });

  it('tells the owner once for each new version', async () => {
    const src = fakeSource([sha('a'), sha('b')]);
    s.ctx.updates.source = src;
    await s.ctx.updates.check();
    await s.ctx.updates.check();
    const told = () => s.ctx.notifier.sent.filter((n) => n.tag === 'update');
    expect(told()).toHaveLength(1);
    expect(told()[0]).toMatchObject({ title: 'Dispatch: a new version', url: '/settings#updates' });
    expect(told()[0].body).toContain('1 commit');
    src.branch.push(sha('c'));
    await s.ctx.updates.check();
    expect(told()).toHaveLength(2);
  });

  it('without a repo it says so and asks nobody', async () => {
    const t = await startServer();
    try {
      const info = (await t.call('POST', '/update/check')).data;
      expect(info.repo).toBeNull();
      expect(info.state.error).toContain('UPDATE_REPO');
      expect(info.target).toBeNull();
    } finally {
      await t.app.close();
    }
  });

  it('refuses a setting that is not one', async () => {
    expect((await s.call('PUT', '/update/settings', { follow: 'branches' })).status).toBe(400);
    expect((await s.call('PUT', '/update/settings', { auto: true })).data.settings).toEqual({ auto: true, follow: 'commits' });
  });
});

describe('updates are the install owner\'s', () => {
  it('nobody else reads or changes them', async () => {
    const s = await startMultiUser();
    try {
      for (const [method, path, body] of [['GET', '/update'], ['PUT', '/update/settings', { auto: true }], ['POST', '/update/check'], ['POST', '/update/start', {}], ['POST', '/update/cancel']] as const) {
        const r = await s.call(method, path, body, as('bob'));
        expect([method, path, r.status, r.data.error]).toEqual([method, path, 403, 'Only the install owner (alice) can change this.']);
      }
      expect((await s.call('GET', '/update', undefined, as('alice'))).status).toBe(200);
      expect(s.ctx.updates.settings().auto).toBe(false);
    } finally {
      await s.app.close();
    }
  });
});
