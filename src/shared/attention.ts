import type { Attention, PullRequest, Session } from './types.ts';

/**
 * Auto-merge still has this open PR in hand: it waits for the checks (GitHub checks, or the repo's
 * check command in a local merge) and then merges. It stops, and sets `blocked`, when it cannot.
 */
export function autoMergePending(autoMerge: Session['options']['auto_merge'], pr: PullRequest): boolean {
  return autoMerge !== 'off' && pr.state === 'open' && !pr.blocked && pr.mergeable !== false;
}

/** What an idle session needs from you: a stuck merge, a review, a check after merging, or a reply; or nothing yet while auto-merge runs. */
export function attentionOf(s: Pick<Session, 'options'>, prs: PullRequest[]): Attention {
  const open = prs.filter((p) => p.state === 'open');
  const label = (p: PullRequest) => (p.local ? `Branch ${p.head_ref}` : `PR #${p.number}`);
  const stuck = open.find((p) => p.blocked || p.mergeable === false);
  if (stuck) {
    const why = stuck.blocked ?? 'it has merge conflicts';
    return { kind: 'merge_blocked', pr_id: stuck.id, text: `${s.options.auto_merge !== 'off' ? 'Auto-merge stopped' : 'Cannot merge'}: ${label(stuck)} — ${why}.` };
  }
  if (open.length && open.every((p) => autoMergePending(s.options.auto_merge, p))) {
    return { kind: 'checking', pr_id: open[0].id, text: open.length > 1 ? `Checking ${open.length} changes, then auto-merge.` : `Checking ${label(open[0])}, then auto-merge.` };
  }
  if (open.length) {
    return { kind: 'review', pr_id: open[0].id, text: open.length > 1 ? `${open.length} changes ready to review and merge.` : `${label(open[0])} is ready to review and merge.` };
  }
  if (prs.some((p) => p.state === 'merged')) return { kind: 'merged', text: 'Merged. Check the result, then mark it complete.' };
  return { kind: 'turn', text: 'Claude finished its turn and waits for your reply.' };
}
