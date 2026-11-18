import type { ReleaseSource } from '../src/server/updates.ts';

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
