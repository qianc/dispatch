import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ItemStatus, SessionStatus } from '../../../src/shared/types.ts';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
// hover is for desktop; active is the press on a phone. Disabled is one look for all: no colour, faint text.
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-strong text-on-accent hover:brightness-110 active:brightness-95 disabled:bg-raised disabled:text-faint disabled:brightness-100',
  secondary: 'bg-raised text-fg border border-line hover:border-faint active:bg-line disabled:text-faint disabled:border-line',
  ghost: 'text-muted hover:bg-raised hover:text-fg active:bg-raised disabled:text-faint disabled:bg-transparent',
  danger: 'bg-bad/15 text-bad border border-bad/30 hover:bg-bad/20 active:bg-bad/25 disabled:opacity-50',
};

export function Button({ variant = 'secondary', small, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean }) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium select-none transition-[color,background-color,border-color,filter] disabled:cursor-default',
        small ? 'h-8 px-2.5 text-[13px]' : 'h-10 px-3.5 text-[15px]',
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export function CloseButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} className="h-10 w-9 flex items-center justify-center text-muted" aria-label={label}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  );
}

export function Md({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cx('md', className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ href = '', children: c }) => (href.startsWith('/') ? <Link to={href}>{c}</Link> : <a href={href} target="_blank" rel="noreferrer">{c}</a>) }}
      >
        {children}
      </Markdown>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-6 py-12 text-center text-muted text-sm">{children}</div>;
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-5">
      <div className="flex items-center justify-between px-4 mb-1.5">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('mx-3 rounded-xl bg-panel border border-line', className)}>{children}</div>;
}

/** Linear-style importance bars: 1–4. */
export function ImportanceIcon({ value, label }: { value: number; label?: string }) {
  const color = value >= 4 ? 'var(--color-bad)' : value === 3 ? 'var(--color-wait)' : 'var(--color-muted)';
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-label={label ?? `Importance ${value}`} role="img" className="shrink-0">
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={1 + i * 3.3} y={10 - i * 3} width="2.4" height={3 + i * 3} rx="0.6" fill={i < value ? color : 'var(--color-line)'} />
      ))}
    </svg>
  );
}

export function Chip({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'wait' | 'ok' | 'bad' | 'run'; className?: string }) {
  const tones = {
    neutral: 'bg-raised text-muted',
    accent: 'bg-accent/15 text-accent',
    wait: 'bg-wait/15 text-wait',
    ok: 'bg-ok/15 text-ok',
    bad: 'bg-bad/15 text-bad',
    run: 'bg-run/15 text-run',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 h-5 text-[11.5px] font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

const SESSION_TONE: Record<SessionStatus, Parameters<typeof Chip>[0]['tone']> = {
  queued: 'neutral', running: 'run', waiting_input: 'wait', idle: 'wait', completed: 'ok', failed: 'bad', stopped: 'neutral',
};
const SESSION_LABEL: Record<SessionStatus, string> = {
  queued: 'Queued', running: 'Running', waiting_input: 'Needs you', idle: 'Your turn', completed: 'Done', failed: 'Failed', stopped: 'Stopped',
};

export function SessionStatusChip({ status }: { status: SessionStatus }) {
  return (
    <Chip tone={SESSION_TONE[status]}>
      {status === 'running' && <span className="size-1.5 rounded-full bg-run animate-pulse" />}
      {SESSION_LABEL[status]}
    </Chip>
  );
}

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  triage: 'Triage', backlog: 'Backlog', todo: 'Todo', in_progress: 'In progress', in_review: 'In review', hold: 'On hold', done: 'Done', canceled: 'Canceled',
};

export function ItemStatusIcon({ status, size = 14 }: { status: ItemStatus; size?: number }) {
  const c = {
    triage: 'var(--color-faint)', backlog: 'var(--color-faint)', todo: 'var(--color-muted)', in_progress: 'var(--color-wait)',
    in_review: 'var(--color-run)', hold: 'var(--color-muted)', done: 'var(--color-accent)', canceled: 'var(--color-faint)',
  }[status];
  const fill = { triage: 0, backlog: 0, todo: 0, in_progress: 0.5, in_review: 0.75, hold: 0, done: 1, canceled: 0 }[status];
  const r = 5.5;
  const circ = 2 * Math.PI * 3;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0" aria-label={ITEM_STATUS_LABEL[status]} role="img">
      <circle cx="7" cy="7" r={r} fill="none" stroke={c} strokeWidth="1.5" strokeDasharray={status === 'backlog' || status === 'triage' ? '2 1.6' : undefined} />
      {fill > 0 && <circle cx="7" cy="7" r="3" fill="none" stroke={c} strokeWidth="6" strokeDasharray={`${circ * fill} ${circ}`} transform="rotate(-90 7 7)" />}
      {status === 'hold' && <path d="M5.6 4.8v4.4M8.4 4.8v4.4" stroke={c} strokeWidth="1.5" strokeLinecap="round" />}
      {status === 'canceled' && <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke={c} strokeWidth="1.5" />}
    </svg>
  );
}

/**
 * Bottom sheet on phones, centered dialog on wide screens. Portaled to <body>: iOS traps fixed
 * elements inside the scroll container's stacking context, under the bottom bar. Sized to the
 * visible area (--app-h, set from visualViewport), so with the keyboard up the sheet sits above it,
 * and the field you type in is scrolled into view inside the sheet.
 */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    // keep the focused field visible: set the sheet's own scrollTop (scrollIntoView would also
    // scroll the locked page on iOS)
    const reveal = () => requestAnimationFrame(() => {
      const box = body.current;
      const el = document.activeElement as HTMLElement | null;
      if (!box || !el || !box.contains(el)) return;
      const b = box.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.bottom > b.bottom - 8) box.scrollTop += r.bottom - b.bottom + 16;
      else if (r.top < b.top + 8) box.scrollTop -= b.top - r.top + 16;
    });
    window.addEventListener('dispatch:viewport', reveal);
    document.addEventListener('focusin', reveal);
    return () => {
      window.removeEventListener('dispatch:viewport', reveal);
      document.removeEventListener('focusin', reveal);
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-x-0 top-0 z-50 flex items-end sm:items-center justify-center" style={{ height: 'var(--app-h, 100dvh)' }} role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg max-h-[92%] sm:max-h-[88%] flex flex-col rounded-t-2xl sm:rounded-2xl bg-panel border border-line pb-safe [.kb-open_&]:pb-0">
        <div className="flex items-center justify-between px-4 h-12 border-b border-line shrink-0">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="text-muted px-2 h-8" aria-label="Close">✕</button>
        </div>
        <div ref={body} className="overflow-y-auto overscroll-contain p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** A labelled form field. Use `group` for button groups (Segmented), which a <label> must not wrap. */
export function Field({ label, children, hint, group }: { label: string; children: ReactNode; hint?: string; group?: boolean }) {
  const id = useId();
  const body = (
    <>
      <span id={id} className="block text-[13px] text-muted mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[12px] text-faint mt-1">{hint}</span>}
    </>
  );
  return group
    ? <div role="group" aria-labelledby={id} className="block mb-3">{body}</div>
    : <label className="block mb-3">{body}</label>;
}

export const inputCls = 'w-full rounded-lg bg-bg border border-line px-3 py-2 text-fg placeholder:text-faint focus:outline-none focus:border-accent';

/** Pick one. Short labels sit in a row; long ones (or many) stack as a list so nothing overflows. */
export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  const longest = Math.max(...options.map((o) => (typeof o.label === 'string' ? o.label.length : 6)));
  const stacked = longest * options.length > 44;
  return (
    <div className={cx('flex rounded-lg bg-bg border border-line p-0.5 gap-0.5', stacked && 'flex-col')} role="radiogroup">
      {options.map((o) => (
        <button
          type="button"
          role="radio"
          aria-checked={o.value === value}
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-md text-[13px] font-medium leading-tight',
            stacked ? 'min-h-9 px-3 py-2 text-left' : 'flex-1 min-h-8 px-1 py-1',
            o.value === value ? 'bg-panel text-fg shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="text-bad text-sm my-2">{(error as Error).message}</p>;
}

export function timeAgo(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
