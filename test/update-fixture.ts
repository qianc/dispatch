// A small "Dispatch" for the update tests (DISP-112): an origin with three versions on main and a
// clone of it. A is healthy, B does not start, C is healthy and has other packages.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface Fixture {
  /** the bare origin */
  origin: string;
  /** where the versions are written and pushed from */
  work: string;
  /** the checkout that is updated, on main at A */
  dir: string;
  a: string;
  b: string;
  c: string;
  /** a new commit on origin's main with this app.txt; gives its id */
  push(app: string, extra?: Record<string, string>): string;
  /** a new clone of the origin at `sha` (on main when that is its tip, else detached) */
  clone(sha: string, detached?: boolean): string;
  head(dir?: string): string;
  read(file: string, dir?: string): string;
}

const lockFile = (version: string) => JSON.stringify({ name: 'app', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'app', version } } }, null, 2);

/**
 * `files`: what every version has besides app.txt (the launcher tests add the real launcher and a
 * small main). `build` writes built.txt from app.txt, so a test sees which version was built.
 */
export function fixture(files: Record<string, string> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsp-update-'));
  const origin = join(root, 'origin.git'), work = join(root, 'work');
  mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', origin);
  const write = (dir: string, all: Record<string, string>) => {
    for (const [name, text] of Object.entries(all)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
  };
  write(work, {
    '.gitignore': 'node_modules\nbuilt.txt\n',
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', private: true, type: 'module', scripts: { build: 'node build.mjs' } }, null, 2),
    'build.mjs': "import fs from 'node:fs';\nfs.writeFileSync('built.txt', fs.readFileSync('app.txt'));\n",
    'package-lock.json': lockFile('1.0.0'),
    ...files,
  });
  const push = (app: string, extra: Record<string, string> = {}) => {
    write(work, { 'app.txt': app, ...extra });
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', `version ${app}`);
    git(work, 'push', '-q', 'origin', 'main');
    return git(work, 'rev-parse', 'HEAD');
  };
  const a = push('A');
  const clone = (sha: string, detached = false) => {
    const dir = mkdtempSync(join(root, 'clone-'));
    git(root, 'clone', '-q', origin, dir);
    if (detached) git(dir, 'checkout', '-q', '--detach', sha);
    else git(dir, 'reset', '-q', '--hard', sha);
    return dir;
  };
  const dir = clone(a);
  const b = push('B');
  // C has another lock file: its packages are installed again
  const c = push('C', { 'package-lock.json': lockFile('1.0.1') });
  git(dir, 'fetch', '-q', 'origin');
  return {
    origin, work, dir, a, b, c, push, clone,
    head: (d = dir) => git(d, 'rev-parse', 'HEAD'),
    read: (file, d = dir) => readFileSync(join(d, file), 'utf8'),
  };
}
