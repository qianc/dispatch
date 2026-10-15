import type { Attention, PullRequest, Session } from './types.ts';

/** What an idle session needs from you: a stuck merge, a review, a check after merging, or a reply. */
export function attentionOf(s: Pick<Session, 'options'>, prs: PullRequest[]): Attention {
  const open = prs.filter((p) => p.state === 'open');
  const label = (p: PullRequest) => (p.local ? `Branch ${p.head_ref}` : `PR #${p.number}`);
  const stuck = open.find((p) => p.blocked || p.mergeable === false);
  if (stuck) {
    const why = stuck.blocked ?? 'it has merge conflicts';
    return { kind: 'merge_blocked', pr_id: stuck.id, text: `${s.options.auto_merge !== 'off' ? 'Auto-merge stopped' : 'Cannot merge'}: ${label(stuck)} — ${why}.` };
  }
  if (open.length) {
    return { kind: 'review', pr_id: open[0].id, text: open.length > 1 ? `${open.length} changes ready to review and merge.` : `${label(open[0])} is ready to review and merge.` };
  }
  if (prs.some((p) => p.state === 'merged')) return { kind: 'merged', text: 'Merged. Check the result, then mark it complete.' };
  return { kind: 'turn', text: 'Claude finished its turn and waits for your reply.' };
}
