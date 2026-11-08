// DISP-45: a local repo's copies are told apart by their first commit, so a path that now holds
// another repo is not used.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addLocalRepo, checkPlacements, setPlacement, type LocalRepoInfo } from '../src/server/repos.ts';
import { startServer, OWNER } from './helpers.ts';

describe('local repo copies (DISP-45)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let found: Record<string, Partial<LocalRepoInfo>>;
  let other: number;
  beforeEach(async () => {
    s = await startServer();
    other = s.ctx.workers.create('other', '', OWNER).worker.id;
    found = {};
    // a worker that finds the repos in `found`
    s.ctx.hub.cmd = (async (_w: number, cmd: { c: string; path: string }) => {
      const f = found[cmd.path];
      if (!f) throw new Error(`${cmd.path} is not a git repository`);
      return { path: cmd.path, name: cmd.path.split('/').pop(), default_branch: 'main', receive_deny_current_branch: 'updateInstead', ...f };
    }) as never;
    s.ctx.hub.isConnected = () => true;
    await s.call('POST', '/projects', { key: 'RP', name: 'RP' });
  });
  afterEach(() => s.app.close());

  it('matches a copy by its first commit, also under another folder name, and refuses another repo', async () => {
    const p = s.ctx.store.projectByKey('RP')!;
    const home = s.ctx.workers.legacy().id;
    found['/a/app'] = { root_sha: 'aaa' };
    const { repo } = await addLocalRepo(s.ctx.store, s.ctx.hub, p, '/a/app', { worker_id: home });
    found['/b/app-checkout'] = { root_sha: 'aaa' };
    const copy = await addLocalRepo(s.ctx.store, s.ctx.hub, p, '/b/app-checkout', { worker_id: other });
    expect(copy.repo.id).toBe(repo.id);
    found['/c/app'] = { root_sha: 'zzz' };
    await expect(setPlacement(s.ctx.store, s.ctx.hub, s.ctx.store.repo(repo.id)!, other, '/c/app')).rejects.toThrow(/different repo/);
    await expect(addLocalRepo(s.ctx.store, s.ctx.hub, p, '/c/app', { worker_id: other })).rejects.toThrow(/already has a local repo named app/);
  });

  it('marks a copy mismatch when its path now holds another repo, missing when it is gone, ok again when fixed', async () => {
    const p = s.ctx.store.projectByKey('RP')!;
    found['/a/app'] = { root_sha: 'aaa' };
    const { repo } = await addLocalRepo(s.ctx.store, s.ctx.hub, p, '/a/app', { worker_id: other });
    const status = () => s.ctx.store.repo(repo.id)!.placements![0];
    found['/a/app'] = { root_sha: 'bbb' };
    await checkPlacements(s.ctx.store, s.ctx.hub, other);
    expect(status()).toMatchObject({ status: 'mismatch', detail: expect.stringContaining('another repo') });
    delete found['/a/app'];
    await checkPlacements(s.ctx.store, s.ctx.hub, other);
    expect(status()).toMatchObject({ status: 'missing', detail: '/a/app is not a git repository' });
    expect(() => s.ctx.sessions.workerFor(p, null)).toThrow(/No worker has an ok copy/);
    found['/a/app'] = { root_sha: 'aaa' };
    await checkPlacements(s.ctx.store, s.ctx.hub, other);
    expect(status()).toMatchObject({ status: 'ok', detail: null, root_sha: 'aaa' });
    expect(s.ctx.sessions.workerFor(p, null)).toBe(other);
  });

  it('a new local repo has its home copy', () => {
    const p = s.ctx.store.projectByKey('RP')!;
    const r = s.ctx.store.addRepo(p.id, { github_owner: 'local', github_name: 'x', default_branch: 'main', check_command: null, local_path: '/x' });
    expect(r.placements).toEqual([{ worker_id: s.ctx.workers.legacy().id, local_path: '/x', root_sha: null, status: 'ok', detail: null, checked_at: null }]);
  });
});
