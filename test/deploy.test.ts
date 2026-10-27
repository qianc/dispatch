// DISP-37: a repo's deploy command runs on the worker after Dispatch merges into its default branch.
import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS } from '../src/shared/types.ts';
import { startServer, startWorker, stopWorker, waitFor } from './helpers.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();

function localRepo(root: string, name: string) {
  const dir = join(root, name);
  execFileSync('git', ['init', '-b', 'main', dir]);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, '.gitignore'), 'deployed.txt\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'config', 'receive.denyCurrentBranch', 'updateInstead');
  return dir;
}

describe('deploy after a merge (DISP-37)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let worker: ChildProcess;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'dsp-deploy-'));
    s = await startServer();
    worker = startWorker(s.port, { LOCAL_REPO_DIRS: root, WORKSPACES_DIR: mkdtempSync(join(tmpdir(), 'dsp-ws-')) });
    await waitFor(() => s.ctx.hub.connected, 'worker');
  });
  afterAll(async () => {
    await stopWorker(worker);
    await s.app.close();
  });

  /** A session with one commit on its branch in a new local repo with this deploy command. */
  async function mergeable(key: string, deploy: string | null, autoMerge = false) {
    await s.call('POST', '/projects', { key, name: key });
    const added = (await s.call('POST', `/projects/${key}/repos`, { local_path: localRepo(root, key.toLowerCase()) })).data;
    const repo = (await s.call('PATCH', `/repos/${added.id}`, { deploy_command: deploy })).data;
    expect(repo.deploy_command).toBe(deploy);
    const branch = `dispatch/${key.toLowerCase()}-1-x`;
    const session = s.ctx.store.createSession({
      project_id: repo.project_id, kind: 'work', title: 'Add b', status: 'idle', force_plan: false, branch,
      initial_prompt: '', source_id: null, item_ids: [],
      options: autoMerge ? { ...DEFAULT_RUN_OPTIONS, auto_merge: 'local' } : undefined,
    });
    git(repo.local_path, 'checkout', '-b', branch);
    writeFileSync(join(repo.local_path, 'b.txt'), 'two\n');
    git(repo.local_path, 'add', '.');
    git(repo.local_path, 'commit', '-m', 'add b');
    git(repo.local_path, 'checkout', 'main');
    return { repo, session };
  }
  const notices = (id: number) => s.ctx.notifier.sent.filter((n) => n.url === `/s/${id}`).map((n) => n.title);
  const events = async (id: number) => ((await s.call('GET', `/sessions/${id}`)).data.events as { body: { kind: string; text: string } }[]).map((e) => e.body);

  it('auto-merge deploys the merged default branch and says so in the session and a notice', async () => {
    const { repo, session } = await mergeable('DEPA', 'git rev-parse HEAD > deployed.txt && echo "$DISPATCH_DEPLOY_SHA" >> deployed.txt && cat b.txt', true);
    await s.ctx.github.syncSession(session); // the branch shows for review, and auto-merge merges it
    const done = await waitFor(async () => (await events(session.id)).find((e) => /^Deployed/.test(e.text)), 'deploy event', 20_000);
    const main = git(repo.local_path, 'rev-parse', 'main');
    // it ran in the repo, on the merged default branch, and was given its sha
    expect(readFileSync(join(repo.local_path, 'deployed.txt'), 'utf8')).toBe(`${main}\n${main}\n`);
    expect(done).toMatchObject({ kind: 'system' });
    expect(done.text).toContain('two'); // the end of its output
    expect((await events(session.id)).some((e) => /^Deploying depa/.test(e.text))).toBe(true);
    // one notice for the session, sent after the deploy (DISP-40): no "done and merged" before it
    expect(notices(session.id)).toEqual(['DEPA: done, merged and deployed']);
  }, 30_000);

  it('a failed deploy after an auto-merge is the only notice of the session (DISP-40)', async () => {
    const { session } = await mergeable('DEPD', 'echo broken registry; exit 3', true);
    await s.ctx.github.syncSession(session);
    await waitFor(async () => (await events(session.id)).find((e) => /^Deploy failed/.test(e.text)), 'deploy failure', 20_000);
    expect(notices(session.id)).toEqual(['DEPD: merged, but the deploy failed']);
  }, 30_000);

  it('a failed deploy is an error in the session and a notice', async () => {
    const { session } = await mergeable('DEPB', 'echo broken registry; exit 3');
    const [review] = await s.ctx.github.syncSession(session);
    expect((await s.call('POST', `/prs/${review.id}/merge`, { how: 'local' })).data).toMatchObject({ ok: true });
    const failed = await waitFor(async () => (await events(session.id)).find((e) => /^Deploy failed/.test(e.text)), 'deploy failure', 20_000);
    expect(failed.kind).toBe('error');
    expect(failed.text).toContain('broken registry');
    const notice = s.ctx.notifier.sent.find((n) => n.title === 'DEPB: merged, but the deploy failed');
    expect(notice?.body).toContain('broken registry');
    expect(notice?.url).toBe(`/s/${session.id}`);
  }, 30_000);

  it('runs nothing for a repo without a deploy command', async () => {
    const { session } = await mergeable('DEPC', null);
    const [review] = await s.ctx.github.syncSession(session);
    expect((await s.call('POST', `/prs/${review.id}/merge`, { how: 'local' })).data).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 500));
    expect((await events(session.id)).some((e) => /^Deploy/.test(e.text))).toBe(false);
  });
});
