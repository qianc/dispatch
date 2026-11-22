// Which commit of Dispatch runs here (DISP-112). Read once at start: a server and a worker may
// share one checkout, and the files can move on while the process still runs the old code.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { maxVersion } from '../shared/release.ts';
import { isCheckout } from './apply.ts';

/** A full commit id: the only thing an update is ever asked for by. */
export const SHA_RE = /^[0-9a-f]{40}$/;

export interface VersionInfo {
  sha: string | null;
  /** the highest version tag on that commit */
  tag: string | null;
  /** git: a checkout; env: DISPATCH_VERSION (an image); none: unknown */
  source: 'git' | 'env' | 'none';
}

/** The folder Dispatch's code is in. */
export const APP_DIR = resolve(import.meta.dirname, '../..');

export function gitOut(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

export function readVersion(dir = APP_DIR, env: NodeJS.ProcessEnv = process.env): VersionInfo {
  if (isCheckout(dir)) {
    const sha = gitOut(dir, ['rev-parse', 'HEAD']);
    if (sha && SHA_RE.test(sha)) {
      const tags = (gitOut(dir, ['tag', '--points-at', 'HEAD']) ?? '').split('\n').filter(Boolean);
      return { sha, tag: maxVersion(tags), source: 'git' };
    }
  }
  const given = (env.DISPATCH_VERSION ?? '').trim().toLowerCase();
  if (/^[0-9a-f]{7,40}$/.test(given)) return { sha: given, tag: null, source: 'env' };
  return { sha: null, tag: null, source: 'none' };
}

let running: VersionInfo | undefined;

/** The version of this process, read at its first call. */
export function runningVersion(): VersionInfo {
  return (running ??= readVersion());
}

/** One is the other, or its short form (7 characters or more). */
export function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}
