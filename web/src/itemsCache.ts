// A project's item list in the React Query cache (['items', project id]), patched in place.
import type { QueryClient } from '@tanstack/react-query';
import { api, type Item } from './api.ts';

/**
 * Put a changed item into its project's cached list. False when that can't be done in place
 * (not in the list, or its place in the list changed): refetch the list then.
 */
export function patchItemList(qc: QueryClient, item: Item): boolean {
  const list = qc.getQueryData<Item[]>(['items', item.project_id]);
  const old = list?.find((i) => i.id === item.id);
  if (!list || !old || old.sort_order !== item.sort_order || old.importance !== item.importance) return false;
  qc.setQueryData<Item[]>(['items', item.project_id], list.map((i) => (i.id === item.id ? item : i)));
  return true;
}

/** Tick or untick an item's checkbox: shown at once, undone if the server says no (DISP-36). */
export function toggleMarked(qc: QueryClient) {
  return {
    mutationFn: (it: Item) => api.patch<Item>(`/items/${it.id}`, { marked: !it.marked }),
    onMutate: async (it: Item) => {
      const key = ['items', it.project_id];
      await qc.cancelQueries({ queryKey: key });
      qc.setQueryData<Item[]>(key, (list) => list?.map((i) => (i.id === it.id ? { ...i, marked: !it.marked } : i)));
    },
    onError: (_e: unknown, it: Item) => {
      qc.setQueryData<Item[]>(['items', it.project_id], (list) => list?.map((i) => (i.id === it.id ? { ...i, marked: it.marked } : i)));
    },
    onSuccess: (updated: Item) => {
      if (!patchItemList(qc, updated)) void qc.invalidateQueries({ queryKey: ['items', updated.project_id] });
    },
  };
}
