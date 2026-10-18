import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cx, inputCls } from './ui.tsx';

// Touch screens: Enter adds a line and the button sends (the on-screen keyboard has no Shift+Enter).
// With a keyboard and mouse: Enter or Ctrl/Cmd+Enter sends, Shift+Enter adds a line.
const touch = window.matchMedia('(pointer: coarse)');

/**
 * The message box of every chat (sessions, Assistant, Discuss). It grows with its lines up to 40% of
 * the visible screen (at least 120px), then scrolls. `action` replaces the send button (e.g. Interrupt).
 */
export function ChatInput({ value, onChange, onSubmit, canSubmit = true, disabled, placeholder, action }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  canSubmit?: boolean;
  disabled?: boolean;
  placeholder?: string;
  action?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [, setViewport] = useState(0);
  const ready = !disabled && canSubmit && !!value.trim();

  // re-measure when the visible area changes (keyboard, rotation, window size)
  useLayoutEffect(() => {
    const on = () => setViewport((n) => n + 1);
    window.addEventListener('dispatch:viewport', on);
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('dispatch:viewport', on);
      window.removeEventListener('resize', on);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const visible = window.visualViewport?.height ?? window.innerHeight;
    const max = Math.max(120, Math.round(visible * 0.4));
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, max)}px`; // +2: the border
    el.style.overflowY = el.scrollHeight + 2 > max ? 'auto' : 'hidden';
  });

  return (
    <form className="flex items-end gap-2 p-2" onSubmit={(e) => { e.preventDefault(); if (ready) onSubmit(); }}>
      <textarea
        ref={ref}
        className={cx(inputCls, 'min-h-10 resize-none py-2 leading-snug')}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          if (touch.matches && !e.ctrlKey && !e.metaKey) return; // phone: a new line
          e.preventDefault();
          if (ready) onSubmit();
        }}
        aria-label="Message"
      />
      {action ?? <button type="submit" disabled={!ready} aria-label="Send" className="h-10 px-3.5 rounded-lg bg-accent-strong text-on-accent font-medium hover:brightness-110 active:brightness-95 disabled:bg-raised disabled:text-faint disabled:brightness-100 border border-transparent disabled:border-line shrink-0">↑</button>}
    </form>
  );
}
