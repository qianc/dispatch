// A worker's session folders belong to a server, not to its place in worker.json (DISP-62): each
// server's are WORKSPACES_DIR/servers/<name>, and the old layout (the first server's folders in
// WORKSPACES_DIR itself) moves there once, worktrees and Claude transcripts included.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Repo } from '../src/shared/types.ts';
import { claudeProjectName, LEGACY_MARKER, migrateLegacyLayout, serverRoot } from '../src/worker/layout.ts';
import { ServerLink, Slots } from '../src/worker/serverLink.ts';
import { Workspaces } from '../src/worker/workspace.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();

function links(ws: string, names: string[]) {
  const slots = new Slots(1);
  return names.map((name) => new ServerLink(
    { name, url: 'http://127.0.0.1:1', token: 't', local_repo_dirs: [], read_dirs: [], claude_accounts: null, github_accounts: null, releases: [], repo_env_dir: '/nonexistent' },
    { fake: true, opts: { assistantReadDirs: [] } as never, workspacesDir: ws, slots, claudeAccounts: () => [], githubAccounts: [], gitEnv: () => ({}), remoteBase: 'https://github.com' },
  ));
}

const spec = (id: number, branch: string, repo: Repo) => ({ session_id: id, kind: 'work' as const, project_key: 'T', project_name: 'T', importance_scale: [], effort_scale: [], title: 't', branch, repos: [repo], items: [], source: null, prompt: '', force_plan: false, options: DEFAULT_RUN_OPTIONS, claude_account: null, github_account: null, resume: null, resume_note: null });

/** A repo to work on: `local` makes worktrees in the owner's repo, else in a clone under cache/. */
function source(local: boolean, id: number): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-lay-src-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return local
    ? { id, project_id: 1, github_owner: 'local', github_name: `loc${id}`, default_branch: 'main', check_command: null, local_path: dir, worktree_from: null, setup_command: null }
    : { id, project_id: 1, github_owner: 'o', github_name: dir.split('/').pop()!, default_branch: 'main', check_command: null, local_path: null, worktree_from: null, setup_command: null };
}

describe("a worker's folders per server", () => {
  it('each server has its own folder, in either order of worker.json', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsp-lay-'));
    for (const order of [['home', 'work'], ['work', 'home']]) {
      const [a, b] = links(ws, order);
      expect(a.workspaces.root).toBe(serverRoot(ws, order[0]));
      expect(b.workspaces.root).toBe(serverRoot(ws, order[1]));
    }
  });

  it('moves the old layout to its server once, so either order still finds every worktree', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsp-lay-'));
    const claudeDir = mkdtempSync(join(tmpdir(), 'dsp-lay-claude-'));
    const local = source(true, 1);
    const hosted = source(false, 2);
    // the old layout: Workspaces right in WORKSPACES_DIR
    const old = new Workspaces(ws);
    // the clone comes from the source folder, not GitHub
    old.remoteUrl = (r: Repo) => r.local_path ?? join(tmpdir(), r.github_name);
    const wtLocal = await old.prepare(spec(7, 'dispatch/t-7', local));
    const wtHosted = await old.prepare(spec(8, 'dispatch/t-8', hosted));
    writeFileSync(join(wtLocal, 'draft.md'), 'unsaved work');
    expect(wtLocal).toBe(join(ws, 'sessions', '7', 'loc1'));
    // Claude's transcript of session 8, kept under its cwd's name
    const oldProject = join(claudeDir, 'projects', claudeProjectName(wtHosted));
    mkdirSync(oldProject, { recursive: true });
    writeFileSync(join(oldProject, 'abc.jsonl'), '{}\n');

    const logs: string[] = [];
    const m = await migrateLegacyLayout(ws, 'home', [claudeDir], (s) => logs.push(s));
    expect(m).toMatchObject({ owner: 'home', stayed: [], failed: [] });
    expect(m!.repaired).toHaveLength(2);
    expect(readFileSync(join(ws, LEGACY_MARKER), 'utf8').trim()).toBe('home');
    expect(existsSync(join(ws, 'sessions'))).toBe(false);
    expect(existsSync(join(ws, 'cache'))).toBe(false);

    const home = serverRoot(ws, 'home');
    const newLocal = join(home, 'sessions', '7', 'loc1');
    const newHosted = join(home, 'sessions', '8', hosted.github_name);
    expect(readFileSync(join(newLocal, 'draft.md'), 'utf8')).toBe('unsaved work');
    expect(git(newLocal, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('dispatch/t-7');
    expect(git(newHosted, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('dispatch/t-8');
    // git knows the new places both ways: a prune (prepare runs one) keeps them
    git(local.local_path!, 'worktree', 'prune');
    expect(git(local.local_path!, 'worktree', 'list')).toContain(newLocal);
    const clone = join(home, 'cache', 'o', hosted.github_name);
    git(clone, 'worktree', 'prune');
    expect(git(clone, 'worktree', 'list')).toContain(newHosted);
    // the transcript moved along, so the session still resumes
    expect(existsSync(join(claudeDir, 'projects', claudeProjectName(newHosted), 'abc.jsonl'))).toBe(true);
    expect(existsSync(oldProject)).toBe(false);

    // nothing left to move: a second start does nothing
    expect(await migrateLegacyLayout(ws, 'work', [claudeDir], () => undefined)).toBeNull();

    // either order of worker.json: the home link finds both sessions' worktrees
    for (const order of [['home', 'work'], ['work', 'home']]) {
      const link = links(ws, order).find((l) => l.entry.name === 'home')!;
      expect(await link.workspaces.leftovers(7, [local], 'dispatch/t-7')).toEqual([expect.objectContaining({ worktree: true, untracked: true, branch: 'dispatch/t-7', checked_out: null })]);
      expect(await link.workspaces.leftovers(8, [hosted], 'dispatch/t-8')).toEqual([expect.objectContaining({ worktree: true, branch: 'dispatch/t-8', checked_out: null })]);
    }
  });

  it('the marker names the owner; what is already there stays and is reported', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsp-lay-'));
    writeFileSync(join(ws, LEGACY_MARKER), 'work\n');
    mkdirSync(join(ws, 'sessions', '5'), { recursive: true });
    mkdirSync(join(ws, 'sessions', '6'), { recursive: true });
    writeFileSync(join(ws, 'sessions', '6', 'x'), 'old');
    mkdirSync(join(serverRoot(ws, 'work'), 'sessions', '6'), { recursive: true });
    writeFileSync(join(serverRoot(ws, 'work'), 'sessions', '6', 'x'), 'new');
    const m = await migrateLegacyLayout(ws, 'home', [], () => undefined);
    expect(m!.owner).toBe('work');
    expect(existsSync(join(serverRoot(ws, 'work'), 'sessions', '5'))).toBe(true);
    expect(m!.stayed).toEqual([join(ws, 'sessions', '6', 'x')]);
    expect(readFileSync(join(serverRoot(ws, 'work'), 'sessions', '6', 'x'), 'utf8')).toBe('new');
  });
});
