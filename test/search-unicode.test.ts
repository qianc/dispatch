import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/server/db.ts';
import type { LiveEvent, SessionSearch } from '../src/shared/types.ts';
import { searchHits } from '../web/src/activity.ts';
import { OWNER, as, dbBeforeMigration, startMultiUser, startServer } from './helpers.ts';

describe('Activity search: any letter case, from an index (DISP-244)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  const ids: Record<string, number> = {};
  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'SWE', name: 'Svenska' });
    const { store } = s.ctx;
    const make = (title: string, messages: string[]) => {
      const made = store.createSession({ started_by: OWNER, worker_id: store.defaultWorkerId(), project_id: store.projectByKey('SWE')!.id, kind: 'work', title, status: 'completed', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
      messages.forEach((text, i) => store.addEvent(made.id, { kind: i % 2 ? 'assistant' : 'user', text }));
      ids[title] = made.id;
    };
    make('Message', ['Åtgärd klar för ÖVRIGT']);
    make('Ärende i titeln', ['nothing']);
    make('Gone', ['åtgärd i en borttagen chatt']);
  });
  afterAll(() => s.app.close());

  const titles = async (q: string) => (await s.call<SessionSearch>('GET', `/sessions/search?q=${encodeURIComponent(q)}`)).data.sessions.map((x) => x.title);

  it('finds å, ä, ö words in another case, in messages and titles, but keeps å apart from a', async () => {
    expect(await titles('åtgärd')).toEqual(['Gone', 'Message']);
    expect(await titles('övrigt')).toEqual(['Message']);
    expect(await titles('ärende')).toEqual(['Ärende i titeln']);
    expect(await titles('atgard')).toEqual([]);
    const hit = (await s.call<SessionSearch>('GET', '/sessions/search?q=%C3%A5tg%C3%A4rd')).data.sessions.find((x) => x.title === 'Message')!;
    expect(hit.snippet).toBe('Åtgärd klar för ÖVRIGT');
  });

  it('a deleted chat leaves the index', async () => {
    s.ctx.store.db.run('DELETE FROM sessions WHERE id = ?', ids.Gone);
    expect(await titles('åtgärd')).toEqual(['Message']);
    expect(s.ctx.store.db.get('SELECT 1 FROM session_event_text WHERE session_id = ?', ids.Gone)).toBeUndefined();
  });
});

describe('migration 054 indexes the messages already stored (DISP-244)', () => {
  it('backfills user and assistant text, not tool output', () => {
    const { file, raw } = dbBeforeMigration('054', 'dispatch-fts-');
    raw.exec(`INSERT INTO sessions (id, project_id, kind, title, status, initial_prompt) VALUES (1, NULL, 'assistant', 't', 'completed', '');
      INSERT INTO session_events (session_id, seq, body) VALUES
        (1, 1, '{"kind":"user","text":"Åtgärd ett"}'), (1, 2, '{"kind":"assistant","text":"svar"}'), (1, 3, '{"kind":"tool_result","text":"åtgärd i verktyg"}');`);
    raw.close();
    const db = new Db(file);
    expect(db.all("SELECT text FROM session_event_text WHERE session_event_text MATCH 'text : åtgärd' ORDER BY rowid")).toEqual([{ text: 'Åtgärd ett' }]);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM session_event_text')!.n).toBe(2);
    db.raw.close();
    rmSync(dirname(file), { recursive: true, force: true });
  });
});

describe('comments and images are signed by their writer (DISP-244)', () => {
  let s: Awaited<ReturnType<typeof startMultiUser>>;
  beforeAll(async () => {
    s = await startMultiUser();
    await s.call('POST', '/projects', { key: 'TEAM', name: 'Team' }, as('alice'));
  });
  afterAll(() => s.app.close());

  it("a person's comment and image carry their name; a script's own name stays; the item is sent live", async () => {
    const it = (await s.call('POST', '/projects/TEAM/items', { title: 'Who wrote it' }, as('alice'))).data;
    const events: LiveEvent[] = [];
    s.ctx.bus.on((e) => events.push(e));
    expect((await s.call('POST', `/items/${it.id}/comments`, { body_md: 'mine' }, as('bob'))).data.author).toBe('bob');
    expect(events.some((e) => e.t === 'item' && e.item.id === it.id)).toBe(true);
    expect((await s.call('POST', `/items/${it.id}/comments`, { body_md: 'from a skill', author: 'claude' }, as('bob'))).data.author).toBe('claude');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const img = await (await fetch(`${s.base}/api/items/${it.id}/images?name=a.png`, { method: 'POST', headers: { 'content-type': 'image/png', ...as('bob') }, body: new Uint8Array(png) })).json();
    expect(img.author).toBe('bob');
  });
});

describe("search's Load more (DISP-248)", () => {
  it('shows a chat that moved to a later page once', () => {
    const pages = [{ sessions: [{ id: 3 }, { id: 2 }] }, { sessions: [{ id: 2 }, { id: 1 }] }];
    expect(searchHits(pages).map((x) => x.id)).toEqual([3, 2, 1]);
  });
});
