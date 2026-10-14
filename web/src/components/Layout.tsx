import type { ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { savedScroll, saveScroll, tabTarget, trackLocation, type Tab } from '../nav.ts';
import { useQuery } from '@tanstack/react-query';
import { api, type Inbox } from '../api.ts';
import { cx } from './ui.tsx';

const icons = {
  inbox: <path d="M3 12h4l2 3h6l2-3h4M5 5h14l2 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  projects: <path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z" />,
  assistant: <path d="M4 5h16v11H9l-5 4zM8 9.5h8M8 12.5h5" />,
  settings: <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm8 3-2-.6-.6-1.5 1-1.9-1.4-1.4-1.9 1-1.5-.6L13 4h-2l-.6 2-1.5.6-1.9-1L5.6 7l1 1.9L6 10.4 4 11v2l2 .6.6 1.5-1 1.9L7 18.4l1.9-1 1.5.6.6 2h2l.6-2 1.5-.6 1.9 1 1.4-1.4-1-1.9.6-1.5 2-.6z" />,
};

function TabLink({ tab, current, label, icon, badge }: { tab: Tab; current: Tab; label: string; icon: ReactNode; badge?: number }) {
  const nav = useNavigate();
  const active = tab === current;
  return (
    <a
      href={tab}
      onClick={(e) => {
        e.preventDefault();
        nav(tabTarget(tab));
      }}
      aria-current={active ? 'page' : undefined}
      className={cx('tab', active ? 'text-fg' : 'text-faint')}
    >
      <span className="relative">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 1.9 : 1.6} strokeLinejoin="round" strokeLinecap="round">{icon}</svg>
        {!!badge && <span className="absolute -top-1 -right-2 min-w-4 h-4 px-1 rounded-full bg-wait text-black text-[10px] font-bold leading-4 text-center">{badge}</span>}
      </span>
      {label}
    </a>
  );
}

export function Layout() {
  const { data: inbox } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<Inbox>('/inbox') });
  const waiting = (inbox?.inputs.length ?? 0) + (inbox?.idle.length ?? 0);
  const loc = useLocation();
  const current = useMemo(() => trackLocation(loc.pathname, loc.search), [loc.pathname, loc.search]);
  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        <Outlet />
      </div>
      <nav className="tabbar" aria-label="Main">
        <TabLink tab="/" current={current} label="Inbox" icon={icons.inbox} badge={waiting} />
        <TabLink tab="/activity" current={current} label="Activity" icon={icons.activity} />
        <TabLink tab="/assistant" current={current} label="Assistant" icon={icons.assistant} />
        <TabLink tab="/projects" current={current} label="Projects" icon={icons.projects} />
        <TabLink tab="/settings" current={current} label="Settings" icon={icons.settings} />
      </nav>
    </>
  );
}

/** A screen: sticky header + the one scrolling area. */
/**
 * A screen: sticky header + the one scrolling area. The scroll position is remembered per screen
 * (path + query) and restored on return, retrying briefly while cached content renders.
 * `keepScroll={false}` for screens that manage scrolling themselves (chats pin to the bottom).
 */
export function Page({ title, subtitle, back, actions, children, footer, keepScroll = true }: { title: ReactNode; subtitle?: ReactNode; back?: string | true; actions?: ReactNode; children: ReactNode; footer?: ReactNode; keepScroll?: boolean }) {
  const nav = useNavigate();
  const loc = useLocation();
  const key = loc.pathname + loc.search;
  const main = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const el = main.current;
    if (!el || !keepScroll) return;
    const target = savedScroll(key);
    if (!target) return;
    let tries = 0;
    let frame = 0;
    const restore = () => {
      el.scrollTop = target;
      if (Math.abs(el.scrollTop - target) > 2 && tries++ < 60) frame = requestAnimationFrame(restore); // content still loading
    };
    restore();
    return () => cancelAnimationFrame(frame);
  }, [key, keepScroll]);

  useEffect(() => {
    const el = main.current;
    if (!el || !keepScroll) return;
    // remember the position as it changes: by cleanup time the element is detached and reads 0
    let last = el.scrollTop;
    let t: number | undefined;
    const onScroll = () => {
      last = el.scrollTop;
      clearTimeout(t);
      t = window.setTimeout(() => saveScroll(key, last), 120);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      saveScroll(key, last);
      el.removeEventListener('scroll', onScroll);
    };
  }, [key, keepScroll]);

  /** Back goes back in history when we came from inside the app, so the list keeps its place. */
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) nav(-1);
    else nav(back === true ? '/' : (back as string), { replace: true });
  };

  return (
    <>
      <header className="shell-head">
        <div className="flex items-center gap-1 h-full px-2">
          {back && (
            <button
              onClick={goBack}
              className="h-10 w-9 flex items-center justify-center text-muted shrink-0"
              aria-label="Back"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 5l-7 7 7 7" /></svg>
            </button>
          )}
          <div className={cx('min-w-0 flex-1', !back && 'pl-2')}>
            <h1 className="font-semibold truncate leading-tight">{title}</h1>
            {subtitle && <div className="text-[12px] text-muted truncate leading-tight">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-1 shrink-0">{actions}</div>
        </div>
      </header>
      <main ref={main} className="scroll-area">
        <div className="mx-auto max-w-3xl pb-8">{children}</div>
      </main>
      {footer && <div className="shrink-0 border-t border-line bg-panel">{footer}</div>}
    </>
  );
}
