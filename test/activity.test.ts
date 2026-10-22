import { describe, expect, it } from 'vitest';
import { attentionOf, waitsOnOwner } from '../src/shared/attention.ts';
import { DEFAULT_RUN_OPTIONS, type Attention, type PullRequest, type Session } from '../src/shared/types.ts';
import { busyStatus, liveGroups, waitingCount } from '../web/src/activity.ts';
import type { Inbox } from '../web/src/api.ts';

const pr = (patch: Partial<PullRequest>): PullRequest => ({
  id: 1, session_id: 1, repo_id: 1, repo_full_name: 'me/r', number: 7, url: '', title: '', state: 'open', mergeable: true, mergeable_state: null,
  head_ref: 'b', head_sha: null, last_synced: null, local: false, blocked: null, behind_at_merge: null, ...patch,
});
const session = (id: number, status: Session['status']) => ({ id, status, title: `S${id}`, project_key: 'DISP' }) as Session;
const idle = (id: number, attention: Attention) => ({ ...session(id, 'idle'), attention });
const inbox = (idleSessions: Inbox['idle']): Inbox => ({ inputs: [], idle: idleSessions, prs: [], sessions: [], cleanup: null });

describe('attention while a merge runs (DISP-31)', () => {
  it('an open PR being merged is "merging", even if it was blocked before', () => {
    const work = { kind: 'work' as const, options: DEFAULT_RUN_OPTIONS };
    expect(attentionOf(work, [pr({ id: 4 })], [], new Set([4]))).toMatchObject({ kind: 'merging', pr_id: 4, text: 'Merging PR #7.' });
    expect(attentionOf(work, [pr({ id: 4, blocked: 'checks failed' })], [], new Set([4])).kind).toBe('merging');
    expect(attentionOf(work, [pr({ id: 4 })]).kind).toBe('review');
  });

  it('checking and merging do not wait on the owner; the rest does', () => {
    expect(waitsOnOwner({ kind: 'checking', text: '', pr_id: 1 })).toBe(false);
    expect(waitsOnOwner({ kind: 'merging', text: '', pr_id: 1 })).toBe(false);
    expect(waitsOnOwner({ kind: 'review', text: '', pr_id: 1 })).toBe(true);
    expect(waitsOnOwner({ kind: 'turn', text: '' })).toBe(true);
  });
});

describe('Activity grouping (DISP-31)', () => {
  const checking = idle(2, { kind: 'checking', text: 'Checking PR #7, then auto-merge.', pr_id: 1 });
  const merging = idle(3, { kind: 'merging', text: 'Merging PR #8.', pr_id: 2 });
  const review = idle(4, { kind: 'review', text: 'PR #9 is ready to review and merge.', pr_id: 3 });
  const live = [session(1, 'running'), checking, merging, review, session(5, 'queued')];
  const data = inbox([checking, merging, review]);

  it('sessions Dispatch checks or merges are not in "needs you": they run', () => {
    const g = liveGroups(live, data);
    expect(g.needs.map((n) => n.id)).toEqual([4]);
    expect(g.running.map((r) => [r.session.id, r.attention?.kind])).toEqual([[1, undefined], [2, 'checking'], [3, 'merging']]);
    expect(g.queued.map((s) => s.id)).toEqual([5]);
    expect(waitingCount(data)).toBe(1);
  });

  it('their row shows checking or merging, not "Your turn"', () => {
    expect(busyStatus(checking, checking.attention)).toEqual({ label: 'Checking', text: 'Checking PR #7, then auto-merge.' });
    expect(busyStatus(merging, merging.attention)).toEqual({ label: 'Merging', text: 'Merging PR #8.' });
    expect(busyStatus(review, review.attention)).toBeNull();
    expect(busyStatus(session(1, 'running'))).toBeNull();
  });
});
