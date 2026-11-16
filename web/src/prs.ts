// A pull request in words: what it belongs to, how its approval went, its CI state (DISP-111).
import type { CiState, ProjectPr, PullRequest } from '../../src/shared/types.ts';

/** The chips that say what a PR belongs to: its items' keys, "Session" for a session with no item, or "No item". */
export function linkLabels(pr: Pick<ProjectPr, 'linked'>): string[] {
  if (!pr.linked) return ['No item'];
  return pr.linked.item_keys.length ? pr.linked.item_keys : ['Session'];
}

/** null: not approved. `current`: the approval is of the head commit. `text`: the state in words. */
export function approvalView(pr: Pick<PullRequest, 'approval' | 'head_sha'>): { current: boolean; chip: 'Approved' | 'Approved earlier'; text: string } | null {
  const a = pr.approval;
  if (!a) return null;
  const current = a.sha === pr.head_sha;
  const onGithub = a.review === 'sent' ? 'Sent to GitHub as a review.'
    : a.review === 'own_pr' ? 'GitHub does not accept an approval of your own pull request.'
    : a.review === 'failed' ? `The review did not reach GitHub: ${a.note ?? 'no reason given'}`
    : '';
  const first = !current ? `Approved by ${a.by} before the last push.` : a.review === 'sent' ? `Approved by ${a.by}.` : `Approved by ${a.by} in Dispatch.`;
  return { current, chip: current ? 'Approved' : 'Approved earlier', text: [first, onGithub].filter(Boolean).join(' ') };
}

type MergeHow = 'github' | 'local';
type MergeMethod = 'squash' | 'merge' | 'rebase';

/**
 * What the Merge button sends. A local review merges on the worker. A PR with no session has no
 * worker: it merges on GitHub, and only at the commit the page shows.
 */
export function mergeBody(pr: Pick<PullRequest, 'local' | 'session_id' | 'head_sha'>, how: MergeHow, method: MergeMethod): { how: MergeHow; method: MergeMethod; sha?: string } {
  if (pr.local) return { how: 'local', method };
  if (pr.session_id === null) return { how: 'github', method, ...(pr.head_sha ? { sha: pr.head_sha } : {}) };
  return { how, method };
}

/** An open PR page shows one commit's diff: true when the PR is not at that commit, or in that state, any more. */
export function prPageStale(shown: Pick<PullRequest, 'head_sha' | 'state'> | undefined, now: Pick<PullRequest, 'head_sha' | 'state'>): boolean {
  return !!shown && (shown.head_sha !== now.head_sha || shown.state !== now.state);
}

/** The CI dot: a class for the colour and a word for screen readers; null: not known, no dot. */
export function ciLook(ci: CiState | null): { cls: string; label: string } | null {
  if (ci === 'success') return { cls: 'bg-ok', label: 'Checks passed' };
  if (ci === 'failure') return { cls: 'bg-bad', label: 'Checks failed' };
  if (ci === 'pending') return { cls: 'bg-wait animate-pulse', label: 'Checks running' };
  return null;
}
