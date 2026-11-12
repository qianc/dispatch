import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { deleteChip, filterProjects, insertMention, mentionAt, moveActive, segments, type MentionProject } from '../mentions.ts';
import { ProjectBadge, lookColor } from './ProjectBadge.tsx';
import { cx, inputCls } from './ui.tsx';

// Touch screens: Enter adds a line and the button sends (the on-screen keyboard has no Shift+Enter).
// With a keyboard and mouse: Enter or Ctrl/Cmd+Enter sends, Shift+Enter adds a line.
const touch = window.matchMedia('(pointer: coarse)');

/**
 * The message box of every chat (sessions, Assistant, Discuss). It grows with its lines up to 40% of
 * the visible screen (at least 120px), then scrolls. `action` replaces the send button (e.g. Interrupt).
 */
export function ChatInput({ value, onChange, onSubmit, canSubmit = true, disabled, placeholder, action, onImages, attachments, hasImages, projects, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  canSubmit?: boolean;
  disabled?: boolean;
  placeholder?: string;
  action?: ReactNode;
  /** images pasted or picked (DISP-34); without it the box takes text only */
  onImages?: (files: File[]) => void;
  /** shown above the box: the images that go with the message */
  attachments?: ReactNode;
  /** images go with the message: it may be sent without text */
  hasImages?: boolean;
  /** @ opens a list of these projects; a chosen one is a tag chip in the text (DISP-82) */
  projects?: MentionProject[];
  /** focus the box with the caret at the end (a prefilled tag, DISP-84) */
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(-1);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const nextCaret = useRef<number | null>(null);
  const keys = useMemo(() => new Set((projects ?? []).map((p) => p.key)), [projects]);
  const byKey = useMemo(() => new Map((projects ?? []).map((p) => [p.key, p])), [projects]);
  const mention = projects && caret >= 0 ? mentionAt(value, caret) : null;
  const options = mention && mention.start !== dismissed ? filterProjects(projects!, mention.query) : [];
  const open = options.length > 0;
  const setText = (text: string, at: number) => {
    nextCaret.current = at;
    setCaret(at);
    onChange(text);
  };
  const choose = (p: MentionProject) => {
    if (!mention) return;
    const r = insertMention(value, caret, mention.start, p.key);
    setActive(0);
    setText(r.text, r.caret);
  };
  const picker = useRef<HTMLInputElement>(null);
  const [, setViewport] = useState(0);
  const ready = !disabled && canSubmit && (!!value.trim() || !!hasImages);

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

  // the caret after a chosen or deleted tag, once the text is in the box
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || nextCaret.current === null) return;
    el.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = null;
  }, [value]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !autoFocus) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    setCaret(el.value.length);
  }, [autoFocus]);

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
    <form className="p-2" onSubmit={(e) => { e.preventDefault(); if (ready) onSubmit(); }}>
      {attachments}
      <div className="flex items-end gap-2">
      {onImages && (
        <>
          <input ref={picker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) onImages(files);
          }} />
          <button type="button" disabled={disabled} onClick={() => picker.current?.click()} aria-label="Add an image" className="h-10 w-9 shrink-0 rounded-lg text-muted hover:text-fg disabled:text-faint flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="m21 16-5-5-9 9" /></svg>
          </button>
        </>
      )}
      <div className="relative flex-1 min-w-0 flex">
      {open && <MentionList options={options} active={Math.min(active, options.length - 1)} onChoose={choose} />}
      {projects && (
        // the text again, behind the box, with the tags as chips; the box's own text is transparent
        <div ref={backdrop} aria-hidden className={cx(inputCls, 'absolute inset-0 min-h-10 py-2 leading-snug whitespace-pre-wrap break-words overflow-hidden pointer-events-none')}>
          {segments(value, keys).map((seg, i) => {
            const p = seg.key ? byKey.get(seg.key) : undefined;
            return p ? (
              <span key={i} data-chip={p.key} className="rounded font-medium" style={{ color: lookColor(p), background: `color-mix(in srgb, ${lookColor(p)} 18%, transparent)`, boxShadow: `0 0 0 2px color-mix(in srgb, ${lookColor(p)} 18%, transparent)` }}>{seg.text}</span>
            ) : <span key={i}>{seg.text}</span>;
          })}
          {'\u200b'}
        </div>
      )}
      <textarea
        ref={ref}
        className={cx(inputCls, 'min-h-10 resize-none py-2 leading-snug', projects && 'relative bg-transparent! text-transparent! caret-fg')}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          setCaret(e.target.selectionStart);
          // Escape closed the list for that @ only: a new @ opens it again
          if (dismissed !== null && mentionAt(e.target.value, e.target.selectionStart)?.start !== dismissed) setDismissed(null);
          onChange(e.target.value);
        }}
        onSelect={projects ? (e) => setCaret(e.currentTarget.selectionStart) : undefined}
        onScroll={projects ? (e) => { if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop; } : undefined}
        onBlur={projects ? () => setCaret(-1) : undefined}
        role={projects ? 'combobox' : undefined}
        aria-expanded={projects ? open : undefined}
        aria-controls={open ? 'mention-list' : undefined}
        aria-autocomplete={projects ? 'list' : undefined}
        onPaste={onImages ? (e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
          if (!files.length) return; // plain text pastes as usual
          e.preventDefault();
          onImages(files);
        } : undefined}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => moveActive(Math.min(i, options.length - 1), e.key === 'ArrowDown' ? 1 : -1, options.length));
              return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              choose(options[Math.min(active, options.length - 1)]);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDismissed(mention!.start);
              return;
            }
          }
          if (projects && e.key === 'Backspace' && !e.altKey && !e.ctrlKey && !e.metaKey) {
            const el = e.currentTarget;
            const r = el.selectionStart === el.selectionEnd ? deleteChip(value, el.selectionStart, keys) : null;
            if (r) {
              e.preventDefault();
              setText(r.text, r.caret);
              return;
            }
          }
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          if (touch.matches && !e.ctrlKey && !e.metaKey) return; // phone: a new line
          e.preventDefault();
          if (ready) onSubmit();
        }}
        aria-label="Message"
      />
      </div>
      {action ?? <button type="submit" disabled={!ready} aria-label="Send" className="h-10 px-3.5 rounded-lg bg-accent-strong text-on-accent font-medium hover:brightness-110 active:brightness-95 disabled:bg-raised disabled:text-faint disabled:brightness-100 border border-transparent disabled:border-line shrink-0">↑</button>}
      </div>
    </form>
  );
}

/** The projects for a typed @, above the box: badge, key and name; rows large enough to tap (DISP-82). */
export function MentionList({ options, active, onChoose }: { options: MentionProject[]; active: number; onChoose: (p: MentionProject) => void }) {
  return (
    <ul id="mention-list" role="listbox" aria-label="Projects" className="absolute bottom-full left-0 right-0 mb-1 z-20 max-h-72 overflow-y-auto rounded-xl border border-line bg-panel shadow-lg py-1">
      {options.map((p, i) => (
        <li
          key={p.key}
          role="option"
          aria-selected={i === active}
          // mouse down, not click: the box keeps the focus and the caret
          onMouseDown={(e) => { e.preventDefault(); onChoose(p); }}
          className={cx('min-h-11 flex items-center gap-2.5 px-3 cursor-pointer text-[14px]', i === active ? 'bg-raised' : 'hover:bg-raised/60')}
        >
          <ProjectBadge project={p} size={24} />
          <span className="font-semibold shrink-0" style={{ color: lookColor(p) }}>{p.key}</span>
          <span className="truncate text-muted">{p.name}</span>
        </li>
      ))}
    </ul>
  );
}
