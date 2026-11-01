import { describe, expect, it } from 'vitest';
import { DEFAULT_ITEM_SORT, ITEM_SORT_GROUPS, itemSortOption, sortItems, type ItemSort } from '../web/src/itemSort.ts';

type Row = { number: number; importance: number | null; effort: number | null; created_at: string };
const row = (number: number, importance: number | null, effort: number | null, created_at = `2026-01-${String(number).padStart(2, '0')}T10:00:00.000Z`): Row =>
  ({ number, importance, effort, created_at });
const order = (rows: Row[], sort: ItemSort) => sortItems(rows, sort).map((r) => r.number);

describe('sorting the item list (DISP-49)', () => {
  const rows = [row(1, 2, 3), row(2, 4, null), row(3, null, 0), row(4, 1, 1)];

  it('sorts by severity, most severe first by default', () => {
    expect(DEFAULT_ITEM_SORT).toBe('importance-desc');
    expect(order(rows, 'importance-desc')).toEqual([2, 1, 4, 3]);
  });

  it('flips severity and keeps items without one last', () => {
    expect(order(rows, 'importance-asc')).toEqual([4, 1, 2, 3]);
  });

  it('sorts by size in both directions and keeps items without one last', () => {
    expect(order(rows, 'effort-asc')).toEqual([3, 4, 1, 2]);
    expect(order(rows, 'effort-desc')).toEqual([1, 4, 3, 2]);
  });

  it('sorts by creation time in both directions', () => {
    expect(order(rows, 'created-desc')).toEqual([4, 3, 2, 1]);
    expect(order(rows, 'created-asc')).toEqual([1, 2, 3, 4]);
  });

  it('compares creation time as time, not by item number', () => {
    const moved = [row(1, 2, 0, '2026-03-01T00:00:00.000Z'), row(2, 2, 0, '2026-01-01T00:00:00.000Z')];
    expect(order(moved, 'created-desc')).toEqual([1, 2]);
    expect(order(moved, 'created-asc')).toEqual([2, 1]);
  });

  it('breaks ties with the most severe, then the newest number', () => {
    const tied = [row(1, 2, 1), row(2, 3, 1), row(3, 3, 1)];
    expect(order(tied, 'effort-asc')).toEqual([3, 2, 1]);
    expect(order(tied, 'effort-desc')).toEqual([3, 2, 1]);
    expect(order([row(1, 2, 1), row(2, 2, 0)], 'importance-desc')).toEqual([2, 1]);
  });

  it('leaves the given list as it was', () => {
    const copy = [...rows];
    sortItems(rows, 'created-desc');
    expect(rows).toEqual(copy);
  });

  it('offers each sort in both directions', () => {
    expect(ITEM_SORT_GROUPS.map((g) => g.label)).toEqual(['Severity', 'Size', 'Created']);
    expect(ITEM_SORT_GROUPS.flatMap((g) => g.options.map((o) => o.value))).toEqual(['importance-desc', 'importance-asc', 'effort-asc', 'effort-desc', 'created-desc', 'created-asc']);
  });

  it('falls back to the default for a saved value it does not know', () => {
    expect(itemSortOption('effort-asc').value).toBe('effort-asc');
    expect(itemSortOption('nonsense').value).toBe(DEFAULT_ITEM_SORT);
    expect(itemSortOption(undefined).value).toBe(DEFAULT_ITEM_SORT);
  });
});
