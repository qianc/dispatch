/**
 * The diff range that shows a branch's own changes once it is merged. Then `base...branch` is empty
 * (the branch is in the base) and the branch itself may be deleted, so start from its last commit:
 * find the commit on the base's first-parent line that took it in, and compare from that commit's
 * first parent. A branch the base does not contain (a squash merge) still compares with the base.
 */
export async function mergedRange(git: (args: string[]) => Promise<string>, base: string, sha: string): Promise<string> {
  const contained = await git(['merge-base', '--is-ancestor', sha, base]).then(() => true, () => false);
  if (!contained) return `${base}...${sha}`;
  const into = (await git(['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${sha}..${base}`])).split('\n')[0];
  return into ? `${into}^1...${sha}` : `${sha}...${sha}`;
}
