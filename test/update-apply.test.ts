import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Refusal, applyUpdate, recoverJournal, verifyTarget, type ApplyRequest, type ChildControl } from '../src/update/apply.ts';
import { fixture, git, type Fixture } from './update-fixture.ts';

/**
 * The process that is updated: "healthy" unless the checkout is on version B. `calls` is what the
 * update did with it, with the version it found.
 */
function child(f: Fixture, dir = f.dir) {
  const c = {
    calls: [] as string[],
    /** make the n-th stop fail (1: the stop before the change, 2: the stop of the rollback) */
    failStop: 0,
    stops: 0,
    async stop() {
      c.stops++;
      if (c.stops === c.failStop) throw new Error('the process did not stop');
      c.calls.push('stop');
    },
    async start(expect: string | null) {
      const v = f.read('app.txt', dir);
      c.calls.push(`start ${v}${expect ? '' : ' (any)'}`);
      if (v === 'B') throw new Error('The new version did not start (exit 1).');
      if (expect && f.head(dir) !== expect) throw new Error('wrong commit');
    },
  };
  return c satisfies ChildControl & Record<string, unknown>;
}

const gitFile = (dir: string, name: string) => join(dir, '.git', name);
const clean = (dir: string) => !existsSync(gitFile(dir, 'dispatch-update.json')) && !existsSync(gitFile(dir, 'dispatch-update.lock'));

describe('one update of a checkout, and its way back (DISP-112)', () => {
  let f: Fixture;
  let req: (sha: string, more?: Partial<ApplyRequest>) => ApplyRequest;
  beforeEach(() => {
    f = fixture();
    req = (sha, more = {}) => ({ sha, branch: 'main', role: 'server', dir: f.dir, from: f.a, ...more });
  });

  it('a healthy new version: the checkout moves forward on its branch, is installed, built and started', async () => {
    const c = child(f);
    const r = await applyUpdate(req(f.c), c);
    expect(r).toMatchObject({ ok: true, from: f.a, to: f.c, rolled_back: false });
    expect(f.head()).toBe(f.c);
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(f.read('built.txt')).toBe('C');
    expect(c.calls).toEqual(['stop', 'start C']);
    // the lock file differs between A and C: the packages were installed again
    expect(r.log_tail).toContain('$ npm ci');
    expect(r.log_tail).toContain('$ npm run build');
    expect(clean(f.dir)).toBe(true);
  });

  it('a new version that does not start is taken back: the old commit, its build, and the old process again', async () => {
    const c = child(f);
    const r = await applyUpdate(req(f.b), c);
    expect(r).toMatchObject({ ok: false, from: f.a, to: f.b, rolled_back: true });
    expect(r.error).toContain('did not start');
    expect(f.head()).toBe(f.a);
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(f.dir, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(f.read('built.txt')).toBe('A');
    expect(c.calls).toEqual(['stop', 'start B', 'stop', 'start A']);
    // the lock file is the same in A and B: no install on the way there or back
    expect(r.log_tail).not.toContain('npm ci');
    expect(clean(f.dir)).toBe(true);
    // and the same update can be tried again later
    expect((await applyUpdate(req(f.c), child(f))).ok).toBe(true);
  });

  it('a detached checkout stays detached, forward and back', async () => {
    const dir = f.clone(f.a, true);
    let r = await applyUpdate(req(f.b, { dir, role: 'worker' }), child(f, dir));
    expect(r).toMatchObject({ ok: false, rolled_back: true });
    expect(f.head(dir)).toBe(f.a);
    r = await applyUpdate(req(f.c, { dir, role: 'worker' }), child(f, dir));
    expect(r.ok).toBe(true);
    expect(f.head(dir)).toBe(f.c);
    expect(() => git(dir, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    // a worker builds nothing
    expect(existsSync(join(dir, 'built.txt'))).toBe(false);
  });

  it('a step that does not end in time is stopped, and the old version comes back', async () => {
    const c = child(f);
    const r = await applyUpdate(req(f.c, { installCommand: 'sleep 30' }), c, { installMs: 300, buildMs: 300 });
    expect(r).toMatchObject({ ok: false, rolled_back: false });
    // the same command fails on the way back too: the result says so, and the journal stays
    expect(r.error).toContain('did not finish');
    expect(r.error).toContain('did not come back');
    expect(existsSync(gitFile(f.dir, 'dispatch-update.json'))).toBe(true);
  });

  it('UPDATE_INSTALL_COMMAND runs in place of the npm steps, and again on the way back', async () => {
    const cmd = 'echo "$DISPATCH_UPDATE_ROLE $DISPATCH_UPDATE_SHA rollback=$DISPATCH_UPDATE_ROLLBACK" >> ../installs.txt';
    const r = await applyUpdate(req(f.b, { installCommand: cmd }), child(f));
    expect(r.rolled_back).toBe(true);
    expect(f.read('../installs.txt').trim().split('\n')).toEqual([`server ${f.b} rollback=`, `server ${f.a} rollback=1`]);
    expect(existsSync(join(f.dir, 'built.txt'))).toBe(false);
  });

  describe('refused, with nothing changed and the process never stopped', () => {
    const refused = async (r: ApplyRequest, why: string | RegExp) => {
      const c = child(f, r.dir);
      const before = f.head(r.dir);
      const res = await applyUpdate(r, c);
      expect(res).toMatchObject({ ok: false, rolled_back: false });
      expect(res.error).toMatch(why);
      expect(c.calls).toEqual([]);
      expect(f.head(r.dir)).toBe(before);
      expect(clean(r.dir)).toBe(true);
    };

    it('anything that is not a full commit id: a branch name, an address, an option', async () => {
      for (const sha of ['main', 'origin/main', 'v1.0.0', f.c.slice(0, 12), f.c.toUpperCase(), 'https://example.com/evil.git', '--upload-pack=touch /tmp/x', `${f.c}\n`]) {
        await refused(req(sha), /full commit id/);
      }
      await refused(req(f.c, { branch: '--force' }), /not a branch name/);
      await refused(req(f.c, { branch: 'main..other' }), /not a branch name/);
    });

    it('a commit that is not on the release branch', async () => {
      // in the checkout, but on no branch of origin
      git(f.dir, 'checkout', '-q', '-b', 'side');
      writeFileSync(join(f.dir, 'app.txt'), 'X');
      git(f.dir, 'commit', '-q', '-am', 'local');
      const local = f.head();
      git(f.dir, 'checkout', '-q', 'main');
      await refused(req(local), /not on the release branch main/);
      // on another branch of origin
      git(f.work, 'checkout', '-q', '-b', 'other');
      writeFileSync(join(f.work, 'app.txt'), 'Y');
      git(f.work, 'commit', '-q', '-am', 'other');
      git(f.work, 'push', '-q', 'origin', 'other');
      const other = git(f.work, 'rev-parse', 'HEAD');
      git(f.dir, 'fetch', '-q', 'origin');
      await refused(req(other), /not on the release branch main/);
      // a commit the checkout does not have at all
      await refused(req('1'.repeat(40)), /is not in origin\/main/);
    });

    it('a checkout with a changed file', async () => {
      writeFileSync(join(f.dir, 'app.txt'), 'mine');
      await refused(req(f.c), /changed files \(app\.txt\)/);
    });

    it('a checkout on another branch', async () => {
      git(f.dir, 'checkout', '-q', '-b', 'feature');
      await refused(req(f.c), /on branch feature, not on the release branch main/);
    });

    it('a step back', async () => {
      const dir = f.clone(f.c);
      await refused(req(f.a, { dir, from: f.c }), /already past/);
      await refused(req(f.c, { dir, from: f.c }), /already runs/);
    });

    it('a folder that is no checkout', async () => {
      mkdirSync(join(f.dir, 'sub'));
      const res = await applyUpdate(req(f.c, { dir: join(f.dir, 'sub') }), child(f));
      expect(res).toMatchObject({ ok: false, rolled_back: false });
      expect(res.error).toContain('not a git checkout');
    });

    it('while another update works in the checkout', async () => {
      mkdirSync(gitFile(f.dir, 'dispatch-update.lock'));
      // a process that lives: this test's parent
      writeFileSync(join(gitFile(f.dir, 'dispatch-update.lock'), 'pid'), String(process.ppid));
      const c = child(f);
      const res = await applyUpdate(req(f.c), c, { lockWaitMs: 100 });
      expect(res.error).toContain('Another update is running');
      expect(c.calls).toEqual([]);
      // the lock of a process that is gone is taken over
      writeFileSync(join(gitFile(f.dir, 'dispatch-update.lock'), 'pid'), '999999999');
      expect((await applyUpdate(req(f.c), child(f), { lockWaitMs: 100 })).ok).toBe(true);
    });
  });

  it('the asker fetches: a commit pushed since is known after, and "already there" is told apart from "refused"', async () => {
    const d = f.push('D');
    await expect(verifyTarget(req(d), { fetch: false })).rejects.toThrow(/is not in origin\/main/);
    expect(await verifyTarget(req(d), { fetch: true })).toEqual({ head: f.a, attached: true, moves: true });
    const past = await verifyTarget(req(f.a, { dir: f.clone(f.c), from: f.c }), { fetch: true }).catch((e) => e);
    expect(past).toBeInstanceOf(Refusal);
    expect(past.kind).toBe('ahead');
    const bad = await verifyTarget(req('main'), { fetch: true }).catch((e) => e);
    expect(bad.kind).toBe('refused');
  });

  it('an update that was cut off is taken back at the next start', async () => {
    // B does not start, and then the launcher "dies": the stop of the rollback never happens
    const c = child(f);
    c.failStop = 2;
    const r = await applyUpdate(req(f.b), c, { ctx: { update_id: 7 } });
    expect(r).toMatchObject({ ok: false, rolled_back: false });
    expect(f.head()).toBe(f.b);
    expect(existsSync(gitFile(f.dir, 'dispatch-update.json'))).toBe(true);

    const back = await recoverJournal(f.dir);
    expect(back?.result).toMatchObject({ ok: false, from: f.a, to: f.b, rolled_back: true });
    expect(back?.ctx).toEqual({ update_id: 7 });
    expect(f.head()).toBe(f.a);
    expect(f.read('built.txt')).toBe('A');
    expect(clean(f.dir)).toBe(true);
    // nothing left to do
    expect(await recoverJournal(f.dir)).toBeNull();
  });

  describe('a checkout that another process already moved (server and worker in one folder)', () => {
    it('is installed and started, without a move', async () => {
      git(f.dir, 'merge', '-q', '--ff-only', f.c);
      const c = child(f);
      const r = await applyUpdate(req(f.c), c);
      expect(r).toMatchObject({ ok: true, from: f.a, to: f.c });
      expect(f.read('built.txt')).toBe('C');
      expect(r.log_tail).toContain('$ npm ci');
      expect(r.log_tail).not.toContain('git merge');
    });

    it('a server goes back to the commit it ran', async () => {
      git(f.dir, 'merge', '-q', '--ff-only', f.b);
      const c = child(f);
      const r = await applyUpdate(req(f.b), c);
      expect(r).toMatchObject({ ok: false, rolled_back: true, from: f.a });
      expect(f.head()).toBe(f.a);
      expect(c.calls).toEqual(['stop', 'start B', 'stop', 'start A']);
    });

    it('a worker leaves the checkout where the server put it', async () => {
      git(f.dir, 'merge', '-q', '--ff-only', f.b);
      const c = child(f);
      const r = await applyUpdate(req(f.b, { role: 'worker' }), c);
      expect(r.ok).toBe(false);
      expect(f.head()).toBe(f.b);
      // started again on what is there, whatever commit that is
      expect(c.calls.slice(0, 4)).toEqual(['stop', 'start B', 'stop', 'start B (any)']);
    });
  });
});
