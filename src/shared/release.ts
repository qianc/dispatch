// Release versions: parsing, the proposed next version, and which items a release holds.
// Shared by the server and the web app.
import type { Item } from './types.ts';

/** v1.2.3, 1.2.3, 1.2.3-rc.1: what a release version may look like. */
export const VERSION_RE = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export interface ParsedVersion { v: boolean; nums: [number, number, number]; pre: string | null }

export function parseVersion(s: string): ParsedVersion | null {
  const m = s.trim().match(/^(v?)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { v: m[1] === 'v', nums: [Number(m[2]), Number(m[3]), Number(m[4])], pre: m[5] ?? null };
}

/** Numeric, field by field; a pre-release sorts before its release. Unparsable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export function maxVersion(list: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const s of list) if (s && parseVersion(s) && (best === null || compareVersions(s, best) > 0)) best = s.trim();
  return best;
}

export function bump(version: string, part: 'minor' | 'patch'): string {
  const p = parseVersion(version);
  if (!p) throw new Error(`Not a version: ${version}`);
  const [major, minor, patch] = p.nums;
  const next = part === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  return `${p.v ? 'v' : ''}${next}`;
}

/** Trim, and add the leading v when the last release had one and the input does not. */
export function normalizeVersion(input: string, last: string | null): string {
  const s = input.trim();
  return last?.startsWith('v') && /^\d/.test(s) ? `v${s}` : s;
}

/** Done items with no label of this release line yet (the rule release_items uses). */
export function unreleased(items: Item[], prefix: string): Item[] {
  return items.filter((i) => i.status === 'done' && !i.labels.some((l) => l.startsWith(prefix)));
}

export function highestLabelVersion(items: Item[], prefix: string): string | null {
  return maxVersion(items.flatMap((i) => i.labels.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length))));
}

/** Minor when the release holds backlog work, patch for fixes only; after a pre-release, its release. */
export function proposeVersion(last: string | null, items: Item[]): { version: string; bump: 'minor' | 'patch' | 'first' | 'release' } {
  if (!last) return { version: 'v0.1.0', bump: 'first' };
  const p = parseVersion(last);
  if (p?.pre) return { version: `${p.v ? 'v' : ''}${p.nums.join('.')}`, bump: 'release' };
  const part = items.some((i) => i.type === 'backlog') ? 'minor' : 'patch';
  return { version: bump(last, part), bump: part };
}
