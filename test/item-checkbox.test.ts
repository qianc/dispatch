import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../src/shared/types.ts';
import { patchItemList, toggleMarked } from '../web/src/itemsCache.ts';

const item = (id: number, over: Partial<Item> = {}) => ({ id, project_id: 1, marked: false, sort_order: 0, importance: 2, title: `i${id}`, ...over }) as Item;
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(respond: (resolve: (r: Response) => void) => void) {
  const qc = new QueryClient();
  const fetchList = vi.fn(async () => [item(1), item(2)]);
  qc.setQueryData(['items', 1], [item(1), item(2)]);
  // the list on screen: an invalidation would refetch it
  new QueryObserver(qc, { queryKey: ['items', 1], queryFn: fetchList, staleTime: Infinity }).subscribe(() => undefined);
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => respond(resolve))));
  const marked = () => qc.getQueryData<Item[]>(['items', 1])!.map((i) => i.marked);
  return { qc, fetchList, marked, toggle: new MutationObserver(qc, toggleMarked(qc)) };
}

afterEach(() => vi.unstubAllGlobals());

describe('ticking an item checkbox (DISP-36)', () => {
  it('shows at once, keeps the server answer, and does not refetch the list', async () => {
    let reply!: (r: Response) => void;
    const t = setup((r) => (reply = r));
    const done = t.toggle.mutate(item(1));
    await vi.waitFor(() => expect(t.marked()).toEqual([true, false])); // before the server answered
    reply(answer(200, { ...item(1), marked: true, updated_at: 'now' }));
    await done;
    expect(t.marked()).toEqual([true, false]);
    expect(t.qc.getQueryData<Item[]>(['items', 1])![0]).toMatchObject({ updated_at: 'now' });
    expect(t.qc.getQueryState(['items', 1])!.isInvalidated).toBe(false);
    expect(t.fetchList).not.toHaveBeenCalled();
  });

  it('goes back when the change fails', async () => {
    const t = setup((r) => r(answer(500, { error: 'no' })));
    await expect(t.toggle.mutate(item(2, { marked: false }))).rejects.toThrow('no');
    expect(t.marked()).toEqual([false, false]);
  });

  it('a change that moves the item in the list refetches it', () => {
    const qc = new QueryClient();
    qc.setQueryData(['items', 1], [item(1), item(2)]);
    expect(patchItemList(qc, { ...item(1), marked: true })).toBe(true);
    expect(patchItemList(qc, item(2, { importance: 4 }))).toBe(false);
    expect(patchItemList(qc, item(3))).toBe(false);
  });
});
