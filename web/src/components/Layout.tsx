import { ProjectBadge, ProjectKey } from './ProjectBadge.tsx';
import type { ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { recentProjects, savedScroll, saveScroll, tabTarget, trackLocation, type Tab } from '../nav.ts';
import { useQuery } from '@tanstack/react-query';
import { api, type Inbox, type ProjectSummary, type Session } from '../api.ts';
import { useWide } from '../wide.ts';
import { icons } from './icons.tsx';
import { cx } from './ui.tsx';


function TabLink({ tab, current, label, icon, badge, badgeTone = 'wait' }: { tab: Tab; current: Tab; label: string; icon: ReactNode; badge?: number; badgeTone?: 'wait' | 'run' }) {
  const nav = useNavigate();
  const loc = useLocation();
  const active = tab === current;
  return (
    <a
      href={tab}
      onClick={(e) => {
        e.preventDefault();
        nav(tabTarget(tab, loc.pathname + loc.search));
      }}
      aria-current={active ? 'page' : undefined}
      className={cx('tab', active ? 'text-fg' : 'text-faint')}
    >
      <span className="relative">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 1.9 : 1.6} strokeLinejoin="round" strokeLinecap="round">{icon}</svg>
        {!!badge && (
          <span
            className={cx('absolute -top-1 -right-2 min-w-4 h-4 px-1 rounded-full text-[10px] font-bold leading-4 text-center', badgeTone === 'run' ? 'bg-run text-on-status' : 'bg-wait text-on-status')}
            aria-label={badgeTone === 'run' ? `${badge} running` : `${badge} waiting`}
          >
            {badge}
          </span>
        )}
      </span>
      {label}
    </a>
  );
}

export function Layout() {
  const { data: inbox } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<Inbox>('/inbox') });
  const waiting = (inbox?.inputs.length ?? 0) + (inbox?.idle.length ?? 0);
  // same query as the Activity page, so they share one cache entry
  const { data: live = [] } = useQuery({ queryKey: ['sessions', 'live'], queryFn: () => api.get<Session[]>('/sessions?status=queued,running,waiting_input,idle') });
  const running = live.filter((s) => s.status === 'running').length;
  const loc = useLocation();
  // keyed on loc.key too: navigating to the same path is still a navigation (tab change)
  const current = useMemo(() => trackLocation(loc.pathname, loc.search), [loc.pathname, loc.search, loc.key]);
  const tabs = (
    <>
      <TabLink tab="/" current={current} label="Inbox" icon={icons.inbox} badge={waiting} />
      <TabLink tab="/activity" current={current} label="Activity" icon={icons.activity} badge={running} badgeTone="run" />
      <TabLink tab="/assistant" current={current} label="Assistant" icon={icons.assistant} />
      <TabLink tab="/projects" current={current} label="Projects" icon={icons.projects} />
      <TabLink tab="/settings" current={current} label="Settings" icon={icons.settings} />
    </>
  );
  return (
    <>
      <div className="flex-1 min-h-0 flex">
        <Sidebar inbox={inbox} live={live} tabs={tabs} />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <Outlet />
        </div>
      </div>
      <nav className="tabbar" aria-label="Main">{tabs}</nav>
    </>
  );
}

/** Desktop: the tabs as a left menu, with what waits on you, what runs, and recent projects. */
function Sidebar({ inbox, live, tabs }: { inbox?: Inbox; live: Session[]; tabs: ReactNode }) {
  const loc = useLocation();
  const wide = useWide();
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: () => api.get<ProjectSummary[]>('/projects'), enabled: wide });
  const [recent, setRecent] = useState(recentProjects);
  useEffect(() => {
    const on = () => setRecent(recentProjects());
    window.addEventListener('dispatch:recent', on);
    return () => window.removeEventListener('dispatch:recent', on);
  }, []);
  if (!wide) return null;
  const sessions = new Map((inbox?.sessions ?? []).map((s) => [s.id, s]));
  const needs = [
    ...(inbox?.inputs ?? []).map((i) => ({ id: i.session_id, key: sessions.get(i.session_id)?.project_key ?? null, title: sessions.get(i.session_id)?.title ?? 'Question', tone: 'wait' as const })),
    ...(inbox?.idle ?? []).map((s) => ({ id: s.id, key: s.project_key, title: s.title, tone: (s.attention.kind === 'merge_blocked' ? 'bad' : s.attention.kind === 'merged' ? 'ok' : 'wait') as 'wait' | 'bad' | 'ok' })),
  ];
  const runningNow = live.filter((s) => s.status === 'running' || s.status === 'queued');
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const recentList = [...recent.filter((k) => byKey.has(k)), ...projects.map((p) => p.key).filter((k) => !recent.includes(k))].slice(0, 6).map((k) => byKey.get(k)!);
  const here = loc.pathname;
  const row = (to: string, children: ReactNode, key: string | number) => (
    <Link key={key} to={to} className={cx('flex items-center gap-2 h-8 px-2 rounded-md text-[13px] hover:bg-raised', here === to ? 'bg-raised text-fg' : 'text-muted')}>{children}</Link>
  );
  return (
    <aside className="sidebar" aria-label="Menu">
      <div className="px-4 h-[52px] flex items-center font-semibold tracking-tight">Dispatch</div>
      <nav className="side-tabs px-2" aria-label="Main">{tabs}</nav>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-4">
        {needs.length > 0 && (
          <SideGroup title="Needs you">
            {needs.slice(0, 10).map((n) => row(`/s/${n.id}`, <>
              <span className={cx('size-1.5 rounded-full shrink-0', n.tone === 'bad' ? 'bg-bad' : n.tone === 'ok' ? 'bg-ok' : 'bg-wait')} />
              <ProjectKey k={n.key} className="text-[11px]" />
              <span className="truncate">{n.title}</span>
            </>, `n-${n.id}`))}
          </SideGroup>
        )}
        {runningNow.length > 0 && (
          <SideGroup title="Running">
            {runningNow.slice(0, 10).map((s) => row(`/s/${s.id}`, <>
              <span className={cx('size-1.5 rounded-full shrink-0', s.status === 'running' ? 'bg-run animate-pulse' : 'bg-faint')} />
              <ProjectKey k={s.project_key} className="text-[11px]" />
              <span className="truncate">{s.title}</span>
            </>, `r-${s.id}`))}
          </SideGroup>
        )}
        {recentList.length > 0 && (
          <SideGroup title="Projects">
            {recentList.map((p) => row(`/p/${p.key}`, <>
              <ProjectBadge project={p} size={20} />
              <span className="truncate flex-1">{p.name}</span>
              {!!p.counts?.waiting && <span className="text-[11px] text-wait">{p.counts.waiting}</span>}
            </>, `p-${p.key}`))}
          </SideGroup>
        )}
      </div>
    </aside>
  );
}

function SideGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <div className="px-2 mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</div>
      {children}
    </div>
  );
}

/** A screen: sticky header + the one scrolling area. */
/**
 * A screen: sticky header + the one scrolling area. The scroll position is remembered per screen
 * (path + query) and restored on return, retrying briefly while cached content renders.
 * `keepScroll={false}` for screens that manage scrolling themselves (chats pin to the bottom).
 */
export function Page({ title, subtitle, icon, back, actions, children, footer, keepScroll = true }: { title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; back?: string | true; actions?: ReactNode; children: ReactNode; footer?: ReactNode; keepScroll?: boolean }) {
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
          {icon && <span className={cx('shrink-0 mr-1', !back && 'pl-2')}>{icon}</span>}
          <div className={cx('min-w-0 flex-1', !back && !icon && 'pl-2')}>
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
