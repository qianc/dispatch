import { describe, expect, it } from 'vitest';
import { attentionOf, openProposals } from '../src/shared/attention.ts';
import { DEFAULT_RUN_OPTIONS, type Proposal, type PullRequest, type SessionEventBody } from '../src/shared/types.ts';

const batch: Proposal = { type: 'batch', title: 'Price work', item_ids: [3, 4], new_items: [], prompt: '', force_plan: false };
const items: Proposal = { type: 'items', source_id: null, items: [{ type: 'backlog', title: 'A', body_md: '', importance: 2, effort: null, labels: [], modules: [] }] };
const ev = (id: number, body: SessionEventBody) => ({ id, body });
const planner = { kind: 'planner' as const, options: DEFAULT_RUN_OPTIONS };
const work = { kind: 'work' as const, options: DEFAULT_RUN_OPTIONS };
const pr = (patch: Partial<PullRequest>): PullRequest => ({
  id: 1, session_id: 1, repo_id: 1, repo_full_name: 'me/r', number: 7, url: '', title: '', state: 'open', mergeable: true, mergeable_state: null,
  head_ref: 'b', head_sha: null, last_synced: null, local: false, blocked: null, behind_at_merge: null, ...patch,
});

describe('openProposals', () => {
  it('lists batch and items cards that were not acted on', () => {
    const events = [
      ev(1, { kind: 'assistant', text: 'Here is a plan' }),
      ev(2, { kind: 'proposal', proposal: batch }),
      ev(3, { kind: 'proposal', proposal: items }),
      ev(4, { kind: 'proposal_done', event_id: 2, note: 'Dismissed' }),
      ev(5, { kind: 'proposal', proposal: { type: 'planner', project_key: 'HC', prompt: '' } }),
    ];
    expect(openProposals(events)).toEqual([{ event_id: 3, proposal: items }]);
  });
});

describe('attentionOf (DISP-21)', () => {
  it('a planning chat with an open batch card offers the proposal, not a reply', () => {
    const a = attentionOf(planner, [], [ev(2, { kind: 'proposal', proposal: batch })]);
    expect(a).toEqual({ kind: 'proposal', proposals: [{ event_id: 2, proposal: batch }], text: 'Claude proposes a batch. Start it, or open the chat to change it.' });
  });

  it('an items card says how many items', () => {
    const a = attentionOf(planner, [], [ev(2, { kind: 'proposal', proposal: items })]);
    expect(a.kind).toBe('proposal');
    expect(a.text).toBe('Claude proposes 1 new item. Create it, or open the chat to change it.');
  });

  it('several open cards are all offered', () => {
    const a = attentionOf(planner, [], [ev(2, { kind: 'proposal', proposal: batch }), ev(3, { kind: 'proposal', proposal: items })]);
    expect(a.kind === 'proposal' && a.proposals.map((p) => p.event_id)).toEqual([2, 3]);
  });

  it('with nothing left to act on, it is a turn (Mark as complete)', () => {
    expect(attentionOf(planner, []).kind).toBe('turn');
    expect(attentionOf(planner, [], [ev(2, { kind: 'proposal', proposal: batch }), ev(3, { kind: 'proposal_done', event_id: 2, note: 'Started session #9' })]).kind).toBe('turn');
  });

  it('only planning chats: a work session with a card still waits for a reply', () => {
    expect(attentionOf(work, [], [ev(2, { kind: 'proposal', proposal: batch })]).kind).toBe('turn');
  });

  it('a local branch is named with its repo: a batch can have the same branch in several (DISP-32)', () => {
    const am = { kind: 'work' as const, options: { ...DEFAULT_RUN_OPTIONS, auto_merge: 'local' as const } };
    expect(attentionOf(am, [pr({ local: true, head_ref: 'dispatch/x', repo_full_name: 'me/convert', blocked: 'it is still 3 commits behind main' })]).text)
      .toBe('Auto-merge stopped: convert branch dispatch/x — it is still 3 commits behind main.');
  });

  it('PRs come first', () => {
    expect(attentionOf(planner, [pr({})], [ev(2, { kind: 'proposal', proposal: batch })]).kind).toBe('review');
    expect(attentionOf(planner, [pr({ state: 'merged' })], [ev(2, { kind: 'proposal', proposal: batch })]).kind).toBe('merged');
  });
});
