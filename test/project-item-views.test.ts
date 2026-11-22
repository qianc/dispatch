import { QueryClient } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Item } from '../src/shared/types.ts';
import { fetchItems, itemsKey, patchItemList } from '../web/src/itemsCache.ts';
import { startServer } from './helpers.ts';

// DISP-161: the project page loads its open items; done and canceled ones only when Closed is shown.
const item = (id: number, over: Partial<Item> = {}) => ({ id, project_id: 1, marked: false, sort_order: 0, importance: 2, status: 'backlog', title: `i${id}`, ...over }) as Item;
const ids = (qc: QueryClient, key: unknown[]) => qc.getQueryData<Item[]>(key)?.map((i) => i.id);

describe('the project page item lists', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'VW', name: 'Views' });
  });
  afterAll(() => s.app.close());
  afterEach(() => vi.unstubAllGlobals());

  it('asks the server for the open or the closed statuses only', async () => {
    for (const status of ['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'hold', 'done', 'canceled']) {
      const it = (await s.call('POST', '/projects/VW/items', { title: status })).data as Item;
      s.ctx.store.updateItem(it.id, { status: status as Item['status'] });
    }
    const urls: string[] = [];
    // the browser's request, answered by the server
    const realFetch = fetch;
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      urls.push(url);
      return realFetch(`${s.base}${url}`, init);
    }));
    const open = (await fetchItems('VW', 'open')).map((i) => i.status).sort();
    const closed = (await fetchItems('VW', 'closed')).map((i) => i.status).sort();
    expect(open).toEqual(['backlog', 'hold', 'in_progress', 'in_review', 'todo', 'triage']);
    expect(closed).toEqual(['canceled', 'done']);
    expect(urls.every((u) => u.includes('?status='))).toBe(true);
  });
});

describe('live updates of the open and closed lists', () => {
  const setup = (closedCached: boolean) => {
    const qc = new QueryClient();
    qc.setQueryData(itemsKey(1, 'open'), [item(1), item(2)]);
    if (closedCached) qc.setQueryData(itemsKey(1, 'closed'), [item(3, { status: 'done' })]);
    return qc;
  };

  it('moves an item that turns done out of the open list and into the cached closed list', () => {
    const qc = setup(true);
    expect(patchItemList(qc, item(1, { status: 'done' }))).toBe(true);
    expect(ids(qc, itemsKey(1, 'open'))).toEqual([2]);
    expect(ids(qc, itemsKey(1, 'closed'))).toEqual([3, 1]);
    expect(qc.getQueryData<Item[]>(itemsKey(1, 'closed'))![1].status).toBe('done');
  });

  it('takes a canceled item out of the open list when the closed list is not loaded', () => {
    const qc = setup(false);
    expect(patchItemList(qc, item(2, { status: 'canceled' }))).toBe(true);
    expect(ids(qc, itemsKey(1, 'open'))).toEqual([1]);
    expect(qc.getQueryData(itemsKey(1, 'closed'))).toBeUndefined();
  });

  it('moves a reopened item back into the open list', () => {
    const qc = setup(true);
    expect(patchItemList(qc, item(3, { status: 'todo' }))).toBe(true);
    expect(ids(qc, itemsKey(1, 'open'))).toEqual([1, 2, 3]);
    expect(ids(qc, itemsKey(1, 'closed'))).toEqual([]);
  });

  it('a change to a closed item the page has not loaded needs no refetch', () => {
    const qc = setup(false);
    expect(patchItemList(qc, item(9, { status: 'done' }))).toBe(true);
    expect(ids(qc, itemsKey(1, 'open'))).toEqual([1, 2]);
  });

  it('a new open item, or one reopened while the closed list is not loaded, refetches', () => {
    expect(patchItemList(setup(true), item(4))).toBe(false);
    expect(patchItemList(setup(false), item(3, { status: 'todo' }))).toBe(false);
  });

  it('keeps the list of all items (used elsewhere) whole', () => {
    const qc = setup(false);
    qc.setQueryData(['items', 1], [item(1), item(2)]);
    expect(patchItemList(qc, item(1, { status: 'done' }))).toBe(true);
    expect(ids(qc, ['items', 1])).toEqual([1, 2]);
    expect(ids(qc, itemsKey(1, 'open'))).toEqual([2]);
  });
});
