import type { ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
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

function Tab({ to, label, icon, badge }: { to: string; label: string; icon: ReactNode; badge?: number }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => cx('flex-1 flex flex-col items-center justify-center gap-0.5 h-14 text-[11px]', isActive ? 'text-fg' : 'text-faint')}>
      <span className="relative">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round">{icon}</svg>
        {!!badge && <span className="absolute -top-1 -right-2 min-w-4 h-4 px-1 rounded-full bg-wait text-black text-[10px] font-bold leading-4 text-center">{badge}</span>}
      </span>
      {label}
    </NavLink>
  );
}

export function Layout() {
  const { data: inbox } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<Inbox>('/inbox') });
  const waiting = (inbox?.inputs.length ?? 0) + (inbox?.idle.length ?? 0);
  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        <Outlet />
      </div>
      <nav className="bottom-bar shrink-0 flex border-t border-line bg-panel pb-safe" aria-label="Main">
        <Tab to="/" label="Inbox" icon={icons.inbox} badge={waiting} />
        <Tab to="/activity" label="Activity" icon={icons.activity} />
        <Tab to="/assistant" label="Assistant" icon={icons.assistant} />
        <Tab to="/projects" label="Projects" icon={icons.projects} />
        <Tab to="/settings" label="Settings" icon={icons.settings} />
      </nav>
    </>
  );
}

/** A screen: sticky header + the one scrolling area. */
export function Page({ title, subtitle, back, actions, children, footer }: { title: ReactNode; subtitle?: ReactNode; back?: string | true; actions?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const nav = useNavigate();
  return (
    <>
      <header className="pt-safe shrink-0 border-b border-line bg-bg">
        <div className="flex items-center gap-1 h-12 px-2">
          {back && (
            <button
              onClick={() => (back === true ? nav(-1) : nav(back))}
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
      <main className="scroll-area">
        <div className="mx-auto max-w-3xl pb-8">{children}</div>
      </main>
      {footer && <div className="shrink-0 border-t border-line bg-panel">{footer}</div>}
    </>
  );
}
