import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attentionOf, waitsOnOwner } from '../src/shared/attention.ts';
import { markTerms, searchTerms, snippetOf } from '../src/shared/search.ts';
import { DEFAULT_RUN_OPTIONS, type Attention, type PullRequest, type Session, type SessionSearch } from '../src/shared/types.ts';
import { busyStatus, liveGroups, waitingCount } from '../web/src/activity.ts';
import type { Inbox } from '../web/src/api.ts';
import { startServer } from './helpers.ts';

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

describe('Activity search over the full history (DISP-54)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  const ids: Record<string, number> = {};
  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'SRCH', name: 'Search' });
    await s.call('POST', '/projects', { key: 'OTHR', name: 'Other' });
    const { store } = s.ctx;
    const make = (key: string, kind: Session['kind'], title: string, at: string, messages: string[], prompt = '') => {
      const p = store.projectByKey(key)!;
      const made = store.createSession({ project_id: p.id, kind, title, status: 'completed', force_plan: false, branch: null, initial_prompt: prompt, source_id: null, item_ids: [] });
      messages.forEach((text, i) => store.addEvent(made.id, { kind: i % 2 ? 'assistant' : 'user', text }));
      // a chat that ran long ago: dated after its events were written
      store.db.run('UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?', at, at, made.id);
      ids[title] = made.id;
    };
    make('SRCH', 'work', 'Old fix', '2026-03-02T10:00:00.000Z', ['please look at the flaky Zebra parser', 'The zebra parser fails on tabs. Fixed it.']);
    make('SRCH', 'planner', 'Spring plan', '2026-04-10T10:00:00.000Z', ['plan the zebra release', 'Here is the plan.']);
    make('OTHR', 'work', 'Other work', '2026-05-20T10:00:00.000Z', ['nothing here about it'], 'zebra in the prompt only');
    make('SRCH', 'discuss', 'A chat', '2026-06-01T10:00:00.000Z', ['100%_done is a literal']);
    // tool output is not a chat message
    make('SRCH', 'work', 'Tools', '2026-06-02T10:00:00.000Z', []);
    store.addEvent(ids.Tools, { kind: 'tool_result', tool_use_id: 't', is_error: false, text: 'zebra in a tool result' });
    for (let i = 0; i < 5; i++) make('OTHR', 'work', `Filler ${i}`, `2026-07-0${i + 1}T10:00:00.000Z`, ['filler']);
  });
  afterAll(() => s.app.close());

  const search = async (query: string) => {
    const r = await s.call<SessionSearch>('GET', `/sessions/search?${query}`);
    expect(r.status).toBe(200);
    return r.data;
  };
  const titles = (r: SessionSearch) => r.sessions.map((x) => x.title);

  it('finds words in messages, title and first prompt, newest first, with a snippet of the message', async () => {
    const r = await search('q=zebra');
    expect(titles(r)).toEqual(['Other work', 'Spring plan', 'Old fix']);
    expect(r.has_more).toBe(false);
    // the message with the most words of the query; the prompt when only the prompt matched
    expect(r.sessions.find((x) => x.title === 'Old fix')!.snippet).toBe('The zebra parser fails on tabs. Fixed it.');
    expect(r.sessions.find((x) => x.title === 'Other work')!.snippet).toBe('zebra in the prompt only');
    expect(titles(await search('q=ZEBRA%20tabs'))).toEqual(['Old fix']);
    expect(titles(await search('q=Spring'))).toEqual(['Spring plan']);
    expect(titles(await search(`q=${encodeURIComponent('"plan the zebra"')}`))).toEqual(['Spring plan']);
  });

  it('% and _ in the query are plain characters, and chats (discuss, assistant) are searched too', async () => {
    expect(titles(await search(`q=${encodeURIComponent('100%_done')}`))).toEqual(['A chat']);
    expect(titles(await search('q=100x'))).toEqual([]);
  });

  it('filters narrow the list: project, kind, start dates', async () => {
    expect(titles(await search('q=zebra&project=SRCH'))).toEqual(['Spring plan', 'Old fix']);
    expect(titles(await search('q=zebra&kind=planner'))).toEqual(['Spring plan']);
    expect(titles(await search('q=zebra&from=2026-04-01T00:00:00.000Z&to=2026-05-01T00:00:00.000Z'))).toEqual(['Spring plan']);
    expect(titles(await search('project=SRCH&kind=discuss'))).toEqual(['A chat']);
    expect((await s.call('GET', '/sessions/search?kind=nope')).status).toBe(400);
    expect((await s.call('GET', '/sessions/search?project=NOPE')).status).toBe(404);
  });

  it('pages with limit and offset', async () => {
    const first = await search('project=OTHR&limit=4');
    expect(titles(first)).toEqual(['Filler 4', 'Filler 3', 'Filler 2', 'Filler 1']);
    expect(first.has_more).toBe(true);
    const next = await search('project=OTHR&limit=4&offset=4');
    expect(titles(next)).toEqual(['Filler 0', 'Other work']);
    expect(next.has_more).toBe(false);
  });
});

describe('search words and snippets (DISP-54)', () => {
  it('splits words, keeps quoted phrases', () => {
    expect(searchTerms('  Zebra "flaky  Parser" zebra ')).toEqual(['zebra', 'flaky parser']);
    expect(searchTerms('')).toEqual([]);
  });
  it('cuts a long message around the first word', () => {
    const text = `${'word '.repeat(60)}the zebra here ${'tail '.repeat(60)}`;
    const snip = snippetOf(text, ['zebra'], 80);
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
    expect(snip).toContain('the zebra here');
    expect(snippetOf('short zebra', ['zebra'])).toBe('short zebra');
  });
  it('marks the words', () => {
    expect(markTerms('A Zebra and a zebra.', ['zebra'])).toEqual([
      { text: 'A ', hit: false }, { text: 'Zebra', hit: true }, { text: ' and a ', hit: false }, { text: 'zebra', hit: true }, { text: '.', hit: false },
    ]);
  });
});
