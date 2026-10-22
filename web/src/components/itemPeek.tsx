import { useNavigate, useSearchParams } from 'react-router';
import { useWide } from '../wide.ts';
import { cx } from './ui.tsx';

/**
 * An item opened from a chat card: on desktop in a panel beside the chat (?peek=<id>), on a phone on
 * its own page, where Back returns to the chat at the same place.
 */
export function useItemPeek() {
  const wide = useWide();
  const nav = useNavigate();
  const [search, setSearch] = useSearchParams();
  const peek = wide ? Number(search.get('peek')) || null : null;
  const set = (id: number | null) => {
    const next = new URLSearchParams(search);
    if (id) next.set('peek', String(id));
    else next.delete('peek');
    setSearch(next, { replace: true });
  };
  const open = (id: number) => (wide ? set(id) : nav(`/items/${id}`));
  return { peek, open, close: () => set(null) };
}

/** An item key that opens the item; usable inside a clickable row (the row does not get the click). */
export function ItemKeyLink({ id, itemKey, className }: { id: number; itemKey: string; className?: string }) {
  const { open } = useItemPeek();
  return (
    <button
      type="button"
      className={cx('text-accent underline-offset-2 hover:underline', className)}
      onClick={(e) => {
        e.stopPropagation();
        open(id);
      }}
      aria-label={`Show ${itemKey}`}
    >
      {itemKey}
    </button>
  );
}
