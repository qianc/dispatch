// DISP-56: a repo's generate command writes files (e.g. backlog.md) from the items at merge.
import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatorItems } from '../src/shared/generatorItems.ts';
import type { Item, Repo } from '../src/shared/types.ts';
import { Workspaces } from '../src/worker/workspace.ts';
import { startServer, startWorker, stopWorker, waitFor } from './helpers.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();

/** Writes backlog.md as "<key> <status>" lines of the open items it is given. */
const GENERATE = `node -e "const i=require(process.env.DISPATCH_ITEMS);require('fs').writeFileSync('backlog.md',i.filter(x=>x.status!=='done').map(x=>x.key+' '+x.status+' '+x.effort).join('\\\\n')+'\\\\n')"`;

function localRepo(root: string, name: string) {
  const dir = join(root, name);
  execFileSync('git', ['init', '-b', 'main', dir]);
  writeFileSync(join(dir, 'backlog.md'), 'hand-written\n');
  writeFileSync(join(dir, 'archive.md'), '');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'config', 'receive.denyCurrentBranch', 'updateInstead');
  return dir;
}

/** A branch off main with one commit that writes these files. */
function branchWith(dir: string, branch: string, files: Record<string, string>) {
  git(dir, 'checkout', '-b', branch);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', `edit ${Object.keys(files).join(' ')}`);
  git(dir, 'checkout', 'main');
}

const item = (n: number, extra: Partial<Item> = {}): Item => ({
  id: n, project_id: 1, number: n, key: `ACME-${n}`, type: 'backlog', title: `Item ${n}`, body_md: `Body ${n}`, status: 'backlog', importance: 2, effort: 1,
  source_id: null, labels: [], modules: [], marked: false, sort_order: 0, created_at: '', updated_at: '', done_at: null, ...extra,
});

describe('the item export for a generate command (DISP-56)', () => {
  it('has every item, the closing batch done, and the effort as the scale label', () => {
    const out = generatorItems([item(2, { effort: null }), item(1, { modules: ['convert'] }), item(3, { status: 'canceled' })], ['XS', 'S', 'M', 'L'], [1, 3]);
    expect(out).toEqual([
      { key: 'ACME-1', type: 'backlog', title: 'Item 1', status: 'done', importance: 2, effort: 'S', modules: ['convert'], labels: [], description: 'Body 1' },
      { key: 'ACME-2', type: 'backlog', title: 'Item 2', status: 'backlog', importance: 2, effort: null, modules: [], labels: [], description: 'Body 2' },
      { key: 'ACME-3', type: 'backlog', title: 'Item 3', status: 'canceled', importance: 2, effort: 'S', modules: [], labels: [], description: 'Body 3' },
    ]);
    expect(generatorItems([item(1, { effort: 7 })], ['XS'], [])[0].effort).toBe(7); // off the scale: the index
  });
});

describe('the generate command in a local merge (DISP-56)', () => {
  const repoAt = (dir: string, extra: Partial<Repo> = {}): Repo => ({
    id: 9, project_id: 1, github_owner: 'local', github_name: 'tpl', default_branch: 'main', check_command: null, local_path: dir, worktree_from: null, setup_command: null,
    generate_command: GENERATE, generated_paths: ['backlog.md'], ...extra,
  });
  const items = generatorItems([item(1), item(2, { status: 'done' })], ['XS', 'S', 'M', 'L'], []);

  it('puts the generated file in the merge commit, next to the branch\'s own edits', async () => {
    const dir = localRepo(mkdtempSync(join(tmpdir(), 'dsp-gen-')), 'tpl');
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')));
    branchWith(dir, 'fix', { 'archive.md': 'ACME-2 moved here\n' });
    const before = git(dir, 'rev-parse', 'main');
    const res = await ws.mergeLocal(repoAt(dir, { check_command: 'grep -q "ACME-1 backlog S" backlog.md' }), 'fix', 'Merge fix', undefined, items);
    expect(res).toMatchObject({ ok: true, check: { ok: true } }); // the check saw the generated file
    expect(readFileSync(join(dir, 'backlog.md'), 'utf8')).toBe('ACME-1 backlog S\n');
    expect(readFileSync(join(dir, 'archive.md'), 'utf8')).toBe('ACME-2 moved here\n');
    // one merge commit on main, with both parents, and nothing after it
    expect(git(dir, 'log', '--format=%s', `${before}..main`, '--first-parent')).toBe('Merge fix');
    expect(git(dir, 'rev-parse', 'main^1')).toBe(before);
    expect(git(dir, 'rev-parse', 'main^2')).toBe(git(dir, 'rev-parse', 'fix'));
    expect(git(dir, 'show', '--format=', '--name-only', '--first-parent', 'main').split('\n').sort()).toEqual(['archive.md', 'backlog.md']);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('refuses a branch that edits a generated file by hand', async () => {
    const dir = localRepo(mkdtempSync(join(tmpdir(), 'dsp-gen-')), 'tpl');
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')));
    branchWith(dir, 'hand', { 'backlog.md': 'edited by hand\n', 'c.txt': 'x\n' });
    const before = git(dir, 'rev-parse', 'main');
    const res = await ws.mergeLocal(repoAt(dir), 'hand', 'Merge hand', undefined, items);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/hand edits backlog\.md, which only the generate command writes/);
    expect(git(dir, 'rev-parse', 'main')).toBe(before);
  });

  it('a failing generate command blocks the merge', async () => {
    const dir = localRepo(mkdtempSync(join(tmpdir(), 'dsp-gen-')), 'tpl');
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')));
    branchWith(dir, 'fix', { 'c.txt': 'x\n' });
    const before = git(dir, 'rev-parse', 'main');
    const res = await ws.mergeLocal(repoAt(dir, { generate_command: 'echo backlog check: ACME-9 has no importance; exit 1' }), 'fix', 'Merge fix', undefined, items);
    expect(res).toMatchObject({ ok: false });
    expect(res.output).toMatch(/Generate command failed[\s\S]*ACME-9 has no importance/);
    expect(git(dir, 'rev-parse', 'main')).toBe(before);
  });

  it('leaves the merge commit as it is when nothing changes', async () => {
    const dir = localRepo(mkdtempSync(join(tmpdir(), 'dsp-gen-')), 'tpl');
    const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')));
    branchWith(dir, 'fix', { 'c.txt': 'x\n' });
    expect(await ws.mergeLocal(repoAt(dir, { generate_command: 'true' }), 'fix', 'Merge fix', undefined, items)).toMatchObject({ ok: true });
    expect(git(dir, 'show', '--format=', '--name-only', '--first-parent', 'main')).toBe('c.txt');
  });
});

describe('a merge through Dispatch regenerates the file from the items (DISP-56)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let worker: ChildProcess;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'dsp-gen-e2e-'));
    s = await startServer();
    worker = startWorker(s.port, { LOCAL_REPO_DIRS: root, WORKSPACES_DIR: mkdtempSync(join(tmpdir(), 'dsp-ws-')) });
    await waitFor(() => s.ctx.hub.connected, 'worker');
  });
  afterAll(async () => {
    await stopWorker(worker);
    await s.app.close();
  });

  it('closes the batch\'s items in the file and shows status changes made in Dispatch', async () => {
    await s.call('POST', '/projects', { key: 'GEN', name: 'GEN' });
    const added = (await s.call('POST', '/projects/GEN/repos', { local_path: localRepo(root, 'gen') })).data;
    const repo = (await s.call('PATCH', `/repos/${added.id}`, { generate_command: GENERATE, generated_paths: ['backlog.md', 'backlog.md'] })).data as Repo;
    expect(repo).toMatchObject({ generate_command: GENERATE, generated_paths: ['backlog.md'] });
    expect((await s.call('PATCH', `/repos/${added.id}`, { generated_paths: ['../x.md'] })).status).toBe(400);

    const base = { type: 'backlog' as const, body_md: '', importance: 2, effort: 0, source_id: null, labels: [] };
    const fixed = s.ctx.store.createItem(repo.project_id, { ...base, title: 'Fixed', status: 'in_progress' });
    const open = s.ctx.store.createItem(repo.project_id, { ...base, title: 'Open', status: 'backlog' });
    const branch = 'dispatch/gen-1-x';
    const session = s.ctx.store.createSession({
      project_id: repo.project_id, kind: 'work', title: 'Fix it', status: 'idle', force_plan: false, branch,
      initial_prompt: '', source_id: null, item_ids: [fixed.id],
    });
    branchWith(repo.local_path!, branch, { 'archive.md': `${fixed.key} archived\n` });
    // a status change in Dispatch, with no commit for it
    s.ctx.store.updateItem(open.id, { status: 'todo' });

    const [review] = await s.ctx.github.syncSession(session);
    expect((await s.call('POST', `/prs/${review.id}/merge`, { how: 'local' })).data).toMatchObject({ ok: true });
    expect(readFileSync(join(repo.local_path!, 'backlog.md'), 'utf8')).toBe(`${open.key} todo XS\n`);
    expect(readFileSync(join(repo.local_path!, 'archive.md'), 'utf8')).toBe(`${fixed.key} archived\n`);
    expect(git(repo.local_path!, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2); // the merge commit itself
    expect(s.ctx.store.item(fixed.id)?.status).toBe('done');
  }, 30_000);
});
