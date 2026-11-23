// DISP-245 (drafts, edits and starts that went to the wrong place), DISP-246 (dead ends and chat
// input limits), and the web findings 94-101 of DISP-248.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { DEFAULT_RUN_OPTIONS, type Attention, type LiveEvent, type Project } from '../src/shared/types.ts';
import type { Accounts, Item, ProjectSummary } from '../web/src/api.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';
import { OWNER, startServer } from './helpers.ts';

/** localStorage backed by a map, for what the web keeps in the browser. */
function storage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, v), removeItem: (k: string) => m.delete(k) });
  return m;
}

beforeEach(() => stubBrowser());
afterEach(() => vi.unstubAllGlobals());

describe('a page is made anew for each id in its path (DISP-245, finding 49)', () => {
  it('keys the page by its path params, and wraps only the routes that have params', async () => {
    const { ByParams, layoutRoute } = await import('../web/src/components/Layout.tsx');
    const { MemoryRouter, Route, Routes } = await import('react-router');
    const { renderToStaticMarkup } = await import('react-dom/server');
    let made: ReactElement | null = null;
    const Probe = () => {
      made = ByParams({ children: 'page' }) as ReactElement;
      return made;
    };
    renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/s/7'] }, createElement(Routes, null, createElement(Route, { path: '/s/:id', element: createElement(Probe) }))));
    expect(made!.key).toBe('7');

    const pages = layoutRoute([{ path: '/s/:id', element: 'session' }, { path: '/settings', element: 'settings' }]).children![0].children!;
    expect((pages[0].element as ReactElement).type).toBe(ByParams);
    expect(pages[1].element).toBe('settings');
  });
});

describe('a remembered Claude account the project no longer allows is not sent (finding 47)', () => {
  it('sends it only while the project allows it', async () => {
    const { sentAccount } = await import('../web/src/components/batch.tsx');
    const accounts = { claude: [{ name: 'personal', label: 'Personal' }, { name: 'work', label: 'Work' }], github: [] } as unknown as Accounts;
    const limited = { claude_account: 'personal', claude_allowed: ['personal'] } as Pick<Project, 'claude_account' | 'claude_allowed'>;
    const open = { claude_account: null, claude_allowed: null } as Pick<Project, 'claude_account' | 'claude_allowed'>;
    expect(sentAccount('work', accounts, limited)).toBeNull();
    expect(sentAccount('personal', accounts, limited)).toBe('personal');
    expect(sentAccount('work', accounts, open)).toBe('work');
    expect(sentAccount('gone', accounts, open)).toBeNull(); // an account taken off the server
    expect(sentAccount('work', undefined, limited)).toBeNull(); // the accounts not loaded yet: the project's list decides
    expect(sentAccount(null, accounts, open)).toBeNull();
  });
});

describe('Activity closes your own discussions, by their id (finding 48)', () => {
  it('lists only the signed-in person\'s discussions; with no sign-in, all', async () => {
    const { ownDiscussions } = await import('../web/src/activity.ts');
    const list = [{ id: 1, started_by: 'alice' }, { id: 2, started_by: 'bob' }];
    expect(ownDiscussions(list, 'alice').map((s) => s.id)).toEqual([1]);
    expect(ownDiscussions(list, null).map((s) => s.id)).toEqual([1, 2]);
  });

  it('a discussion of a failed session (no item) closes by its session id', async () => {
    const s = await startServer();
    try {
      await s.call('POST', '/projects', { key: 'FD', name: 'FD' });
      const chat = s.ctx.store.createSession({ started_by: OWNER, worker_id: s.ctx.store.defaultWorkerId(), project_id: s.ctx.store.projectByKey('FD')!.id,
        kind: 'discuss', title: 'Why did it fail?', status: 'idle', force_plan: false, branch: null, initial_prompt: '', source_id: null, item_ids: [] });
      expect((await s.call('POST', `/sessions/${chat.id}/finish`, { status: 'completed' })).status).toBe(200);
      expect(s.ctx.store.session(chat.id)!.status).toBe('completed');
    } finally {
      await s.app.close();
    }
  });
});

describe('project settings (findings 51, 52)', () => {
  it('a failed save is sent again: what was sent goes back, unless a newer send replaced it', async () => {
    const { unsend } = await import('../web/src/pages/Project.tsx');
    const prev = { name: 'Old', description: 'd' };
    expect(unsend({ name: 'New', description: 'd' }, { name: 'New' }, prev)).toEqual(prev);
    expect(unsend({ name: 'Newer', description: 'd' }, { name: 'New' }, prev)).toEqual({ name: 'Newer', description: 'd' });
  });

  it('a toggle shows at once, so the next builds on it; only the last answer in flight is kept', async () => {
    const { saveProject } = await import('../web/src/pages/Project.tsx');
    const qc = new QueryClient();
    const key = ['project', 'PX'];
    qc.setQueryData(key, { key: 'PX', neighbours: [] } as unknown as ProjectSummary);
    const last = { seq: 0 };
    let answer1!: (p: ProjectSummary) => void;
    const first = saveProject(qc, 'PX', last, { neighbours: ['A'] }, () => new Promise((r) => { answer1 = r; }));
    // the second tick reads the cache, which has A already
    const now = qc.getQueryData<ProjectSummary>(key)!.neighbours;
    expect(now).toEqual(['A']);
    const second = saveProject(qc, 'PX', last, { neighbours: [...now, 'B'] }, async () => ({ key: 'PX', neighbours: ['A', 'B'] }) as unknown as ProjectSummary);
    answer1({ key: 'PX', neighbours: ['A'] } as unknown as ProjectSummary);
    await Promise.all([first, second]);
    expect(qc.getQueryData<ProjectSummary>(key)!.neighbours).toEqual(['A', 'B']);

    // a failed save reads the project again
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    await expect(saveProject(qc, 'PX', last, { neighbours: [] }, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
  });
});

describe('the item edit sheet sends only what it changed (finding 53)', () => {
  it('leaves the fields it did not touch to whatever the server has now', async () => {
    const { changedFields } = await import('../web/src/pages/ItemDetail.tsx');
    const opened = { title: 'Tpyo', status: 'todo', labels: ['a'], effort: 1 };
    expect(changedFields(opened, { ...opened, title: 'Typo' })).toEqual({ title: 'Typo' });
    expect(changedFields(opened, { ...opened, labels: ['a', 'b'] })).toEqual({ labels: ['a', 'b'] });
    expect(changedFields(opened, { ...opened })).toEqual({});
  });
});

describe('Start in the Inbox starts what the chat card says (finding 59)', () => {
  const card = { new_picked: [0, 1], title: 'Card title', prompt: 'Card prompt', force_plan: false };

  it('reads the card\'s saved edits, and only new-item picks the card has', async () => {
    const { savedCardEdits } = await import('../web/src/components/proposals.ts');
    storage({ k: JSON.stringify({ new_picked: [1, 5], title: 'Mine', prompt: 'Do it my way', force_plan: true }) });
    expect(savedCardEdits('k', card)).toEqual({ new_picked: [1], title: 'Mine', prompt: 'Do it my way', force_plan: true });
    expect(savedCardEdits('none', card)).toEqual(card);
    storage({ k: '{bad' });
    expect(savedCardEdits('k', card)).toEqual(card);
  });

  it('the Inbox button counts the new items left on the card', async () => {
    const { NextSteps } = await import('../web/src/components/nextSteps.tsx');
    storage({ 'dispatch:card-edits:5:9': JSON.stringify({ new_picked: [1], title: 'Edited title', prompt: 'p', force_plan: false }) });
    const qc = new QueryClient();
    qc.setQueryData(['project', 'IB'], { id: 1, key: 'IB', worker_id: null, repos: [], claude_account: null, claude_allowed: null });
    const attention = { kind: 'proposal', text: '', proposals: [{ event_id: 9, proposal: {
      type: 'batch', title: 'Card title', item_ids: [], prompt: '', force_plan: false,
      new_items: [{ title: 'one', type: 'feature', body_md: '' }, { title: 'two', type: 'feature', body_md: '' }],
    } }] } as unknown as Attention;
    const text = textOf(renderPage(createElement(NextSteps, { sessionId: 5, projectKey: 'IB', attention }), { qc }));
    expect(text).toContain('Start batch (1)');
  });
});

describe('the "did not start" overlay goes once the app runs (finding 55)', () => {
  it('a load after the watchdog fired takes its overlay away', async () => {
    const { markStarted } = await import('../web/src/boot.ts');
    const body: { id: string; remove: () => void }[] = [];
    const el = () => {
      const e = { id: '', style: {}, textContent: '', onclick: null, appendChild: (c: unknown) => c, remove: () => { body.splice(body.indexOf(e), 1); } };
      return e;
    };
    const doc = { createElement: el, body: { appendChild: (e: { id: string; remove: () => void }) => body.push(e) }, getElementById: (id: string) => body.find((e) => e.id === id) ?? null };
    const win = {} as { __dispatchStarted?: boolean };
    let fire = () => {};
    runInNewContext(readFileSync(new URL('../web/public/boot-watchdog.js', import.meta.url), 'utf8'), { window: win, document: doc, setTimeout: (f: () => void) => { fire = f; } });
    fire(); // 8 s, and the app has not started
    expect(body.map((e) => e.id)).toEqual(['boot-fail']);
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    markStarted();
    expect(win.__dispatchStarted).toBe(true);
    expect(body).toEqual([]);
  });
});

describe('a missing item, session or project says so (finding 50)', () => {
  it('shows the error in place of "Loading…"', async () => {
    const { loadingText } = await import('../web/src/components/ui.tsx');
    const { ApiError } = await import('../web/src/api.ts');
    expect(loadingText(null)).toBe('Loading…');
    expect(loadingText(new ApiError(404, 'Item not found'))).toMatch(/Not found/);
    expect(loadingText(new ApiError(500, 'Boom'))).toBe('Boom');
  });

  it('a delete is a live event, and other devices drop the item', async () => {
    const s = await startServer();
    try {
      await s.call('POST', '/projects', { key: 'DL', name: 'DL' });
      const it = (await s.call('POST', '/projects/DL/items', { title: 'x' })).data;
      const seen: LiveEvent[] = [];
      s.ctx.bus.on((e) => seen.push(e));
      await s.call('DELETE', `/items/${it.id}`);
      expect(seen).toContainEqual({ t: 'item_deleted', id: it.id, project_id: it.project_id });
    } finally {
      await s.app.close();
    }
    const { apply } = await import('../web/src/live.ts');
    const qc = new QueryClient();
    qc.setQueryData(['items', 2, 'open'], [{ id: 1, project_id: 2 }, { id: 4, project_id: 2 }]);
    qc.setQueryData(['item', 1], { id: 1 });
    apply(qc, { t: 'item_deleted', id: 1, project_id: 2 });
    expect(qc.getQueryData<Item[]>(['items', 2, 'open'])!.map((i) => i.id)).toEqual([4]);
    expect(qc.getQueryData(['item', 1])).toBeUndefined();
  });
});

describe('chat images: at most 10 a message, no GIF too large (findings 56, 57)', () => {
  it('takes only as many as fit beside those attached, and counts the rest', async () => {
    const { fitImages } = await import('../web/src/components/chatImages.tsx');
    const files = (n: number) => Array.from({ length: n }, () => ({ type: 'image/png', size: 1 }));
    expect(fitImages(files(12), 0)).toMatchObject({ leftOut: 2 });
    expect(fitImages(files(12), 0).fit).toHaveLength(10);
    expect(fitImages(files(6), 6)).toMatchObject({ leftOut: 2 });
    expect(fitImages(files(3), 10)).toMatchObject({ fit: [], leftOut: 3 });
  });

  it('refuses a GIF over the limit; a large PNG is shrunk instead', async () => {
    const { gifTooBig } = await import('../web/src/components/chatImages.tsx');
    expect(gifTooBig({ type: 'image/gif', size: 6_000_000 })).toBe(true);
    expect(gifTooBig({ type: 'image/gif', size: 1_000_000 })).toBe(false);
    expect(gifTooBig({ type: 'image/png', size: 6_000_000 })).toBe(false);
  });
});

describe('a multi-select answer keeps picks and "Other" apart (finding 58)', () => {
  const q = { multiSelect: true, options: [{ label: 'Yes, merge it' }, { label: 'Tests' }] } as never;

  it('joins them only when sent, so Other may hold ", "', async () => {
    const { joinAnswer } = await import('../web/src/components/transcript.tsx');
    expect(joinAnswer(q, { picked: ['Tests'], other: 'a, b' })).toBe('Tests, a, b');
    expect(joinAnswer(q, { picked: [], other: '  ' })).toBe('');
    expect(joinAnswer({ multiSelect: false } as never, { picked: ['Tests'], other: '' })).toBe('Tests');
    expect(joinAnswer({ multiSelect: false } as never, { picked: [], other: 'mine' })).toBe('mine');
  });

  it('reads a sent answer back with an option that holds ", "', async () => {
    const { parseAnswer } = await import('../web/src/components/transcript.tsx');
    expect(parseAnswer(q, 'Yes, merge it, Tests, a, b')).toEqual({ picked: ['Yes, merge it', 'Tests'], other: 'a, b' });
    expect(parseAnswer(q, 'Yes, merge it')).toEqual({ picked: ['Yes, merge it'], other: '' });
    expect(parseAnswer(q, '')).toEqual({ picked: [], other: '' });
  });
});

describe('the server says which card items are gone (finding 60)', () => {
  it('an item whose session waits for its usage limit can still be started', async () => {
    const s = await startServer();
    try {
      await s.call('POST', '/projects', { key: 'GN', name: 'GN' });
      const [waiting, busy, done, free] = await Promise.all(['w', 'b', 'd', 'f'].map(async (title) => (await s.call('POST', '/projects/GN/items', { title })).data as Item));
      const session = (item: Item, extra: object) => s.ctx.store.createSession({ started_by: OWNER, worker_id: s.ctx.store.defaultWorkerId(), project_id: item.project_id,
        kind: 'work', title: 't', status: 'running', force_plan: false, branch: `b-${item.id}`, initial_prompt: '', source_id: null, item_ids: [item.id], options: DEFAULT_RUN_OPTIONS, ...extra });
      const w = session(waiting, {});
      s.ctx.store.updateSession(w.id, { limit_wait: { resets_at: '2026-11-24T00:00:00.000Z' } });
      session(busy, {});
      s.ctx.store.updateItem(done.id, { status: 'done' });
      const ids = [waiting, busy, done, free].map((i) => i.id);
      const res = await s.call<number[]>('GET', `/projects/GN/items/gone?ids=${ids.join(',')}`);
      expect(res.data.sort()).toEqual([busy.id, done.id].sort());
    } finally {
      await s.app.close();
    }
  });
});

describe('web findings of DISP-248', () => {
  it('94: ticking an item does not cancel the Closed list\'s first fetch', async () => {
    const { toggleMarked } = await import('../web/src/itemsCache.ts');
    const qc = new QueryClient();
    let done!: (v: Item[]) => void;
    void qc.fetchQuery({ queryKey: ['items', 2, 'closed'], queryFn: () => new Promise<Item[]>((r) => { done = r; }) });
    qc.setQueryData(['items', 2, 'open'], [{ id: 1, project_id: 2, marked: false } as Item]);
    await toggleMarked(qc).onMutate({ id: 1, project_id: 2, marked: false } as Item);
    done([]);
    await vi.waitFor(() => expect(qc.getQueryState(['items', 2, 'closed'])!.status).toBe('success'));
    expect(qc.getQueryData<Item[]>(['items', 2, 'open'])![0].marked).toBe(true);
  });

  it('95: an item from a source refreshes its project\'s Sources list', async () => {
    const { apply } = await import('../web/src/live.ts');
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    apply(qc, { t: 'item', item: { id: 1, project_id: 2, source_id: 8 } as Item });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sources', 2] });
  });

  it('96: a new source says "just now", not "now ago"', async () => {
    const { createdLabel } = await import('../web/src/components/ui.tsx');
    expect(createdLabel(new Date().toISOString())).toMatch(/· just now$/);
    expect(createdLabel(new Date(Date.now() - 2 * 86_400_000).toISOString())).toMatch(/· 2d ago$/);
  });

  it('98: the server tells signed-in people the commit it runs', async () => {
    const s = await startServer();
    try {
      const me = (await s.call('GET', '/me')).data;
      expect(me).toHaveProperty('server_sha', s.ctx.version.sha);
    } finally {
      await s.app.close();
    }
  });

  it('100: an image upload turned away by a sign-in proxy says "Signed out"', async () => {
    const { uploadImage } = await import('../web/src/api.ts');
    const fetch = vi.fn(async () => ({ type: 'opaqueredirect', ok: false, status: 0, headers: new Headers() }) as unknown as Response);
    vi.stubGlobal('fetch', fetch);
    await expect(uploadImage(3, new File(['x'], 'a.png', { type: 'image/png' }))).rejects.toMatchObject({ status: 401, message: 'Signed out', foreign: true });
    expect(fetch).toHaveBeenCalledWith('/api/items/3/images?name=a.png', expect.objectContaining({ redirect: 'manual', headers: expect.objectContaining({ 'content-type': 'image/png' }) }));
  });

  it('101: "Most batches per run" keeps what you type and is clamped on save', async () => {
    const { batchesPerRun } = await import('../web/src/components/schedules.tsx');
    expect(batchesPerRun('')).toBe(1);
    expect(batchesPerRun('3')).toBe(3);
    expect(batchesPerRun('13')).toBe(10);
    expect(batchesPerRun('0')).toBe(1);
  });
});
