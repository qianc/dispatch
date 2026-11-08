// Where each server's folders live on a worker (DISP-62): WORKSPACES_DIR/servers/<name>, always, so
// the order of the servers in worker.json does not matter. Older workers kept the first server's
// folders in WORKSPACES_DIR itself; migrateLegacyLayout moves them to that server's folder once.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { run } from './workspace.ts';

/** The folder of one server's sessions, clones and assistant. */
export function serverRoot(workspacesDir: string, name: string) {
  return join(resolve(workspacesDir), 'servers', name);
}

/** What the old layout kept in WORKSPACES_DIR for its first server (all of Workspaces' folders). */
export const LEGACY_DIRS = ['sessions', 'cache', 'assistant', 'merge', 'deploy'];
/** Names the server that owns the old folders; written before they move, so a stopped move ends the same way. */
export const LEGACY_MARKER = 'legacy-server';

/** Claude Code's folder name for a cwd's transcripts (~/.claude/projects/<this>). */
export function claudeProjectName(path: string) {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Move `src` to `dst`; where `dst` already exists, move what it lacks, entry by entry. Returns what stayed. */
async function mergeMove(src: string, dst: string): Promise<string[]> {
  if (!existsSync(dst)) {
    await mkdir(dirname(dst), { recursive: true });
    await rename(src, dst);
    return [];
  }
  if (!statSync(src).isDirectory() || !statSync(dst).isDirectory()) return [src];
  const stayed: string[] = [];
  for (const name of await readdir(src)) stayed.push(...(await mergeMove(join(src, name), join(dst, name))));
  if (!stayed.length) await rmdir(src);
  return stayed;
}

/** The repo's git dir a worktree belongs to (its `.git` file says `gitdir: <common>/worktrees/<name>`). */
async function worktreeCommonDir(wt: string): Promise<string | null> {
  const gitFile = join(wt, '.git');
  if (!existsSync(gitFile) || statSync(gitFile).isDirectory()) return null;
  const m = /^gitdir:\s*(.+)$/m.exec(await readFile(gitFile, 'utf8'));
  if (!m) return null;
  const gitdir = resolve(wt, m[1].trim());
  return dirname(dirname(gitdir));
}

export interface Migration {
  owner: string;
  moved: string[];
  /** entries that were in both places: left in WORKSPACES_DIR, to look at by hand */
  stayed: string[];
  repaired: string[];
  failed: string[];
}

/**
 * Move the old layout's folders (WORKSPACES_DIR/sessions, cache, …) to servers/<owner>, once.
 * The owner is the server the marker names, else `defaultOwner` (the first server, which used
 * them). Every moved worktree is repaired, both ways, so git still knows it (and a later
 * `git worktree prune` does not drop it), and Claude's transcripts for the moved folders move
 * along in each of `claudeConfigDirs`, so sessions still resume. Run it before any session starts.
 */
export async function migrateLegacyLayout(workspacesDir: string, defaultOwner: string, claudeConfigDirs: string[], log: (msg: string) => void = console.log): Promise<Migration | null> {
  const ws = resolve(workspacesDir);
  const present = LEGACY_DIRS.filter((d) => existsSync(join(ws, d)));
  if (!present.length) return null;
  const marker = join(ws, LEGACY_MARKER);
  const owner = existsSync(marker) ? (await readFile(marker, 'utf8')).trim() || defaultOwner : defaultOwner;
  await writeFile(marker, `${owner}\n`);
  const dst = serverRoot(ws, owner);
  log(`Moving the old workspace folders (${present.join(', ')}) to ${dst} (DISP-62)`);
  const out: Migration = { owner, moved: [], stayed: [], repaired: [], failed: [] };
  for (const d of present) {
    const stayed = await mergeMove(join(ws, d), join(dst, d));
    out.stayed.push(...stayed);
    if (!stayed.length) out.moved.push(d);
  }
  for (const s of out.stayed) log(`  ${s} is also in ${dst}; left where it is`);

  // a moved worktree's .git file may point into the old cache: map it, then repair from the repo's side
  const mapOld = (p: string) => {
    for (const d of present) {
      const from = join(ws, d);
      if (p === from || p.startsWith(from + sep)) return join(dst, d) + p.slice(from.length);
    }
    return p;
  };
  const sessions = join(dst, 'sessions');
  for (const id of existsSync(sessions) ? readdirSync(sessions) : []) {
    const dir = join(sessions, id);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const wt = join(dir, name);
      const common = await worktreeCommonDir(wt).catch(() => null);
      if (!common) continue;
      const res = await run('git', ['--git-dir', mapOld(common), 'worktree', 'repair', wt]);
      if (res.code === 0) out.repaired.push(wt);
      else {
        out.failed.push(wt);
        log(`  git worktree repair ${wt} failed: ${res.out.split('\n')[0]}`);
      }
    }
  }

  // Claude keeps a session's transcript under its cwd's name: rename those of the moved folders
  for (const cfg of new Set(claudeConfigDirs)) {
    const projects = join(cfg, 'projects');
    if (!existsSync(projects)) continue;
    for (const name of readdirSync(projects)) {
      for (const d of out.moved) {
        const from = claudeProjectName(join(ws, d));
        if (name !== from && !name.startsWith(from + '-')) continue;
        const to = claudeProjectName(join(dst, d)) + name.slice(from.length);
        const stayed = await mergeMove(join(projects, name), join(projects, to)).catch(() => [name]);
        if (stayed.length) log(`  Claude transcripts ${join(projects, name)} not moved (already in ${to})`);
        break;
      }
    }
  }
  log(`Moved ${out.moved.length} folder(s); repaired ${out.repaired.length} worktree(s)${out.failed.length ? `; ${out.failed.length} could not be repaired` : ''}`);
  return out;
}
