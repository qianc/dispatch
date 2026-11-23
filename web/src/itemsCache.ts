// A project's item lists in the React Query cache, patched in place: ['items', project id] holds
// them all, ['items', project id, 'open' | 'closed'] one view of them (DISP-161).
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { ITEM_STATUSES, type ItemStatus } from '../../src/shared/types.ts';
import { api, type Item } from './api.ts';

type ItemView = 'open' | 'closed';
const CLOSED_STATUSES: readonly ItemStatus[] = ['done', 'canceled'];
const OPEN_STATUSES = ITEM_STATUSES.filter((s) => !CLOSED_STATUSES.includes(s));

export const itemsKey = (projectId: number | undefined, view: ItemView) => ['items', projectId, view];
/** The project page's lists: the open items at once, the closed ones only when shown. */
export const fetchItems = (projectKey: string, view: ItemView) =>
  api.get<Item[]>(`/projects/${projectKey}/items?status=${(view === 'open' ? OPEN_STATUSES : CLOSED_STATUSES).join(',')}`);

const holds = (key: QueryKey, status: ItemStatus) =>
  key[2] === 'open' ? !CLOSED_STATUSES.includes(status) : key[2] === 'closed' ? CLOSED_STATUSES.includes(status) : true;

/**
 * Put a changed item into its project's cached lists: out of a view it left, into one it moved to.
 * False when that can't be done in place (a new item, or its place in the list changed): refetch the lists then.
 */
export function patchItemList(qc: QueryClient, item: Item): boolean {
  const lists = qc.getQueriesData<Item[]>({ queryKey: ['items', item.project_id] }).filter((e): e is [QueryKey, Item[]] => !!e[1]);
  const known = lists.some(([, list]) => list.some((i) => i.id === item.id));
  let patched = true;
  for (const [key, list] of lists) {
    const old = list.find((i) => i.id === item.id);
    if (!holds(key, item.status)) {
      if (old) qc.setQueryData<Item[]>(key, list.filter((i) => i.id !== item.id));
    } else if (old) {
      if (old.sort_order !== item.sort_order || old.importance !== item.importance) patched = false;
      else qc.setQueryData<Item[]>(key, list.map((i) => (i.id === item.id ? item : i)));
    } else if (known) {
      // moved here from another cached view; the page sorts the list itself
      qc.setQueryData<Item[]>(key, [...list, item]);
    } else patched = false;
  }
  return patched && lists.length > 0;
}

/** Tick or untick an item's checkbox: shown at once, undone if the server says no (DISP-36). */
export function toggleMarked(qc: QueryClient) {
  return {
    mutationFn: (it: Item) => api.patch<Item>(`/items/${it.id}`, { marked: !it.marked }),
    onMutate: async (it: Item) => {
      const key = ['items', it.project_id];
      // only refetches of lists that have data: a cancelled first fetch (the Closed list just shown) stays on "Loading…" (DISP-248)
      await qc.cancelQueries({ queryKey: key, predicate: (q) => q.state.data !== undefined });
      qc.setQueriesData<Item[]>({ queryKey: key }, (list) => list?.map((i) => (i.id === it.id ? { ...i, marked: !it.marked } : i)));
    },
    onError: (_e: unknown, it: Item) => {
      qc.setQueriesData<Item[]>({ queryKey: ['items', it.project_id] }, (list) => list?.map((i) => (i.id === it.id ? { ...i, marked: it.marked } : i)));
    },
    onSuccess: (updated: Item) => {
      if (!patchItemList(qc, updated)) void qc.invalidateQueries({ queryKey: ['items', updated.project_id] });
    },
  };
}

/** A deleted item: out of its project's cached lists at once, then the lists and project counts refetched (DISP-213). */
export function dropDeletedItem(qc: QueryClient, item: Pick<Item, 'id' | 'project_id'>) {
  qc.setQueriesData<Item[]>({ queryKey: ['items', item.project_id] }, (list) => list?.filter((i) => i.id !== item.id));
  void qc.invalidateQueries({ queryKey: ['items', item.project_id] });
  void qc.invalidateQueries({ queryKey: ['projects'] });
}
