import { useRef, useState, type ReactNode } from 'react';
import { SWIPE_CLOSE_PX, swipeOffset } from '../activity.ts';
import { cx } from './ui.tsx';

/**
 * A list row that closes when dragged to the left (DISP-58). Behind it, a coloured band says what
 * happens. A drag does not also open the row's link. If closing fails, the row comes back. `label`: the action, e.g. "Close".
 */
export function SwipeToClose({ children, label, onClose }: { children: ReactNode; label: string; onClose: () => Promise<unknown> }) {
  const [offset, setOffset] = useState(0);
  const [gone, setGone] = useState(false);
  const drag = useRef<{ x: number; y: number; id: number; dragging: boolean } | null>(null);
  const dragged = useRef(false);
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.dragging) return;
    if (offset <= -SWIPE_CLOSE_PX) {
      navigator.vibrate?.(10);
      setGone(true);
      onClose().catch(() => { setGone(false); setOffset(0); }); // not closed: back in its place
    } else setOffset(0);
  };
  return (
    <div className="relative overflow-hidden border-b border-line last:border-b-0">
      <div className="absolute inset-0 flex items-center justify-end px-4 bg-accent-strong text-on-accent font-medium" aria-hidden>
        {label}
      </div>
      <div
        className={cx('relative bg-panel [touch-action:pan-y]', !drag.current && 'transition-transform duration-200')}
        style={{ transform: `translateX(${gone ? '-100%' : `${offset}px`})` }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse') return; // a touch gesture; desktop has the button
          drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, dragging: false };
          dragged.current = false;
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          const next = swipeOffset(e.clientX - d.x, e.clientY - d.y, d.dragging);
          if (next.dragging && !d.dragging) {
            d.dragging = dragged.current = true;
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the pointer is gone already */ }
          }
          if (next.dragging) setOffset(next.offset);
        }}
        onPointerUp={end}
        onPointerCancel={() => { drag.current = null; setOffset(0); }}
        onClickCapture={(e) => {
          if (!dragged.current) return;
          e.preventDefault();
          e.stopPropagation();
          dragged.current = false;
        }}
      >
        {children}
      </div>
    </div>
  );
}
