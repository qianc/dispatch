import type { Attention, OpenProposal, PullRequest, Session, SessionEvent } from './types.ts';

/**
 * Auto-merge still has this open PR in hand: it waits for the checks (GitHub checks, or the repo's
 * check command in a local merge) and then merges. It stops, and sets `blocked`, when it cannot.
 */
export function autoMergePending(autoMerge: Session['options']['auto_merge'], pr: PullRequest): boolean {
  return autoMerge !== 'off' && pr.state === 'open' && !pr.blocked && pr.mergeable !== false;
}

/** The batch and items cards in a transcript that were not started, created, dismissed or replaced. */
export function openProposals(events: Pick<SessionEvent, 'id' | 'body'>[]): OpenProposal[] {
  const done = new Set(events.flatMap((e) => (e.body.kind === 'proposal_done' ? [e.body.event_id] : [])));
  return events.flatMap((e) =>
    e.body.kind === 'proposal' && !done.has(e.id) && (e.body.proposal.type === 'batch' || e.body.proposal.type === 'items')
      ? [{ event_id: e.id, proposal: e.body.proposal }]
      : []);
}

function proposalText(open: OpenProposal[]): string {
  if (open.length > 1) return `Claude proposes ${open.length} cards. Act on them, or open the chat to change them.`;
  const p = open[0].proposal;
  if (p.type === 'items') return `Claude proposes ${p.items.length} new item${p.items.length === 1 ? '' : 's'}. Create ${p.items.length === 1 ? 'it' : 'them'}, or open the chat to change ${p.items.length === 1 ? 'it' : 'them'}.`;
  return 'Claude proposes a batch. Start it, or open the chat to change it.';
}

/** Whether a session with this attention waits on the owner: not while Dispatch checks or merges it (DISP-31). */
export function waitsOnOwner(a: Attention): boolean {
  return a.kind !== 'checking' && a.kind !== 'merging';
}

/**
 * What an idle session needs from you: a signed-out Claude account, a stuck merge, a review, a check after merging, a planning
 * chat's proposal, or a reply; or nothing yet while auto-merge runs or a merge is under way.
 * `events`: the transcript, for planning chats (their open proposal cards). `mergingNow`: ids of
 * PRs being merged at this moment.
 */
export function attentionOf(s: Pick<Session, 'options'> & Partial<Pick<Session, 'kind' | 'login_needed'>>, prs: PullRequest[], events: Pick<SessionEvent, 'id' | 'body'>[] = [], mergingNow: ReadonlySet<number> = new Set()): Attention {
  // the work stopped on a signed-out account: sign it in and retry before anything else (DISP-60)
  if (s.login_needed) return { kind: 'login', login: s.login_needed, text: `${s.login_needed.label} account needs sign-in on ${s.login_needed.worker ?? s.login_needed.host}, then Retry.` };
  const open = prs.filter((p) => p.state === 'open');
  // a batch can have the same branch in several repos: name the repo
  const label = (p: PullRequest) => (p.local ? `${p.repo_full_name.split('/').pop()} branch ${p.head_ref}` : `PR #${p.number}`);
  const inMerge = open.find((p) => mergingNow.has(p.id));
  if (inMerge) return { kind: 'merging', pr_id: inMerge.id, text: `Merging ${label(inMerge)}.` };
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
  if (s.kind === 'planner') {
    const cards = openProposals(events);
    if (cards.length) return { kind: 'proposal', proposals: cards, text: proposalText(cards) };
  }
  return { kind: 'turn', text: 'Claude finished its turn and waits for your reply.' };
}

/** The first line of a text, cut to `max` characters. */
const firstLine = (text: string, max: number) => {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * Why a session failed, in one short line for a list (DISP-81): a signed-out Claude account, else
 * its last error in the chat, else Claude's last message.
 */
export function failureReason(s: Pick<Session, 'login_needed' | 'last_text'>, lastError: string | null): string {
  if (s.login_needed) return `${s.login_needed.label} account needs sign-in on ${s.login_needed.worker ?? s.login_needed.host}.`;
  return firstLine(lastError ?? '', 140) || firstLine(s.last_text ?? '', 140) || 'The session failed.';
}
