export type ItemSort = 'importance-desc' | 'importance-asc' | 'effort-asc' | 'effort-desc' | 'created-desc' | 'created-asc';
export interface ItemSortOption { value: ItemSort; /** on the button */ short: string; /** in the menu */ label: string }

export const DEFAULT_ITEM_SORT: ItemSort = 'importance-desc';

export const ITEM_SORT_GROUPS: { label: string; options: ItemSortOption[] }[] = [
  { label: 'Severity', options: [
    { value: 'importance-desc', short: 'Most severe', label: 'Most severe first' },
    { value: 'importance-asc', short: 'Least severe', label: 'Least severe first' },
  ] },
  { label: 'Size', options: [
    { value: 'effort-asc', short: 'Smallest', label: 'Smallest first' },
    { value: 'effort-desc', short: 'Largest', label: 'Largest first' },
  ] },
  { label: 'Created', options: [
    { value: 'created-desc', short: 'Newest', label: 'Newest first' },
    { value: 'created-asc', short: 'Oldest', label: 'Oldest first' },
  ] },
];

/** The option for a sort, or the default when a saved value is not (or no longer) one. */
export function itemSortOption(value: unknown): ItemSortOption {
  const all = ITEM_SORT_GROUPS.flatMap((g) => g.options);
  return all.find((o) => o.value === value) ?? all.find((o) => o.value === DEFAULT_ITEM_SORT)!;
}

interface Sortable { number: number; importance: number | null; effort: number | null; created_at: string }

/** Items without a value go last in both directions, so this does not simply flip the sign. */
const byValue = (a: number | null, b: number | null, dir: number) => {
  if (a === null || b === null) return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  return (a - b) * dir;
};

/** A sorted copy. Ties: most severe, then the newest number (oldest first when sorting oldest first). */
export function sortItems<T extends Sortable>(items: T[], sort: ItemSort): T[] {
  const [by, direction] = sort.split('-');
  const dir = direction === 'asc' ? 1 : -1;
  const main = (a: T, b: T) => {
    if (by === 'importance') return byValue(a.importance, b.importance, dir);
    if (by === 'effort') return byValue(a.effort, b.effort, dir);
    return (Date.parse(a.created_at) - Date.parse(b.created_at)) * dir;
  };
  return [...items].sort((a, b) =>
    main(a, b)
    || byValue(a.importance, b.importance, -1)
    || (b.number - a.number) * (by === 'created' ? -dir : 1));
}
