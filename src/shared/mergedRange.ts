import type { BranchFile } from './types.ts';

/**
 * The diff range that shows a branch's own changes once it is merged. Then `base...branch` is empty
 * (the branch is in the base) and the branch itself may be deleted, so start from its last commit:
 * find the commit on the base's first-parent line that took it in, and compare from that commit's
 * first parent. A branch the base does not contain (a squash merge) still compares with the base.
 * A fast-forward puts the branch's commits on the base's own line, so nothing marks where they
 * start: `forkSha` (where the branch left the base, stored while it was open) does (DISP-248).
 */
export async function mergedRange(git: (args: string[]) => Promise<string>, base: string, sha: string, forkSha?: string | null): Promise<string> {
  const contained = await git(['merge-base', '--is-ancestor', sha, base]).then(() => true, () => false);
  if (!contained) return `${base}...${sha}`;
  const into = (await git(['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${sha}..${base}`])).split('\n')[0];
  const fastForward = !into || (await git(['rev-parse', `${into}^1`])) === (await git(['rev-parse', sha]));
  if (!fastForward) return `${into}^1...${sha}`;
  return forkSha ? `${forkSha}...${sha}` : `${sha}...${sha}`;
}

/**
 * The files a diff range changes, with patches (like a PR's files). Names are read NUL-separated
 * and given back as literal paths, so a name with "ü", a tab or a quote works (DISP-240).
 */
export async function diffFiles(git: (args: string[]) => Promise<string>, range: string): Promise<BranchFile[]> {
  const stat = await git(['diff', '-z', '--numstat', '--no-renames', range]);
  const names = (await git(['diff', '-z', '--name-status', '--no-renames', range])).split('\0');
  const status = new Map<string, string>();
  for (let i = 0; i + 1 < names.length; i += 2) status.set(names[i + 1], ({ A: 'added', D: 'removed', M: 'modified' } as Record<string, string>)[names[i][0]] ?? 'changed');
  const files: BranchFile[] = [];
  for (const entry of stat.split('\0').filter(Boolean)) {
    const [add, del, ...rest] = entry.split('\t');
    const filename = rest.join('\t');
    const diff = add === '-' ? '' : await git(['diff', '--no-renames', range, '--', `:(literal)${filename}`]);
    // from the first hunk, like GitHub's patch (an added or removed file has one more header line)
    const at = diff.indexOf('\n@@');
    const patch = at < 0 ? null : diff.slice(at + 1);
    files.push({ filename, status: status.get(filename) ?? 'modified', additions: Number(add) || 0, deletions: Number(del) || 0, patch: patch && patch.length > 200_000 ? null : patch });
  }
  return files;
}
