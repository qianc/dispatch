import { useEffect, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { searchTerms } from '../../../src/shared/search.ts';
import type { SessionSearch } from '../../../src/shared/types.ts';
import { NO_FILTER, OPEN_STATUSES, filtering, recentDiscussions, searchQuery, type SessionFilter } from '../activity.ts';
import { Link } from 'react-router';
import { api, type FailedSession, type Inbox, type ProjectSummary, type Session } from '../api.ts';
import { ProjectKey } from '../components/ProjectBadge.tsx';
import { Page } from '../components/Layout.tsx';
import { SessionRow } from '../components/items.tsx';
import { SwipeToClose } from '../components/swipe.tsx';
import { Button, Card, Empty, ErrorText, Section, SessionStatusChip, cx, inputCls, timeAgo } from '../components/ui.tsx';

const KINDS = [
  { value: 'work', label: 'Work' },
  { value: 'planner', label: 'Planning' },
  { value: 'discuss', label: 'Discuss' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'release', label: 'Release' },
];
const PAGE = 30;

export function Activity() {
  const { data: live = [] } = useQuery({ queryKey: ['sessions', 'live'], queryFn: () => api.get<Session[]>(`/sessions?status=${OPEN_STATUSES}`) });
  // item discussions not yet closed, answered or not: found again here, not only on their item (DISP-58).
  // One left alone for 10 days steps aside; it stays open on its item and in search.
  const { data: open = [] } = useQuery({ queryKey: ['sessions', 'discussions'], queryFn: () => api.get<Session[]>(`/sessions?kind=discuss&status=${OPEN_STATUSES}`) });
  const discussions = recentDiscussions(open);
  // same query as the menu: an idle session's attention says whether Dispatch checks or merges it
  const { data: inbox } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<Inbox>('/inbox') });
  const attention = new Map((inbox?.idle ?? []).map((s) => [s.id, s.attention]));
  const { data: recent = [] } = useQuery({ queryKey: ['sessions', 'recent'], queryFn: () => api.get<Session[]>('/sessions?status=completed,failed,stopped') });
  // failed sessions not yet ignored or retried (DISP-81): their own section, not also in Recently finished
  const failed = inbox?.failed ?? [];
  const failedIds = new Set(failed.map((s) => s.id));
  const finished = recent.filter((s) => !failedIds.has(s.id));
  const [filter, setFilter] = useState<SessionFilter>(NO_FILTER);
  const searching = filtering(filter);
  return (
    <Page title="Activity" subtitle="Agent sessions across all projects" wide>
      <SearchBar filter={filter} onChange={setFilter} />
      <div className="lg:grid lg:grid-cols-2 lg:items-start">
      {/* while searching, the results come first and an empty Live list steps aside */}
      {searching && <Results filter={filter} />}
      {(!searching || live.length > 0) && (
        <Section title={`Live (${live.length})`}>
          {live.length ? <Card>{live.map((s) => <SessionRow key={s.id} s={s} showProject attention={attention.get(s.id)} />)}</Card> : <Empty>No sessions running.</Empty>}
        </Section>
      )}
      {!searching && discussions.length > 0 && (
        <Section title={`Open discussions (${discussions.length})`}>
          <Card className="overflow-hidden">{discussions.map((s) => <DiscussionRow key={s.id} s={s} />)}</Card>
        </Section>
      )}
      {!searching && failed.length > 0 && (
        <Section title={`Failed (${failed.length})`}>
          <Card>{failed.map((s) => <FailedRow key={s.id} s={s} />)}</Card>
        </Section>
      )}
      {!searching && finished.length > 0 && (
        <Section title="Recently finished">
          <Card>{finished.slice(0, 30).map((s) => <SessionRow key={s.id} s={s} showProject />)}</Card>
        </Section>
      )}
      </div>
    </Page>
  );
}

/** A failed session and why it failed (DISP-81); its page has the actions. */
function FailedRow({ s }: { s: FailedSession }) {
  return (
    <Link to={`/s/${s.id}`} className="block px-3 py-2.5 border-b border-line last:border-b-0 active:bg-raised">
      <div className="flex items-center gap-2">
        <ProjectKey k={s.project_key} badge />
        <span className="flex-1 min-w-0 truncate font-medium">{s.title}</span>
        <SessionStatusChip status={s.status} />
      </div>
      <div className="flex items-start gap-2 mt-0.5 text-[13px]">
        <span className="flex-1 min-w-0 line-clamp-2 break-words text-bad">{s.reason}</span>
        <span className="text-faint text-[12px] shrink-0">{timeAgo(s.updated_at)}</span>
      </div>
    </Link>
  );
}

/** An open discussion: drag it left to close it (phone), or the Close button (desktop). */
function DiscussionRow({ s }: { s: Session }) {
  const qc = useQueryClient();
  const close = () => api.post(`/items/${s.item_ids[0]}/discuss/new`).then(() => qc.invalidateQueries({ queryKey: ['sessions'] }));
  return (
    <SwipeToClose label="Close" onClose={close}>
      <div className="flex items-center">
        <div className="flex-1 min-w-0"><SessionRow s={s} showProject /></div>
        <span className="hidden lg:block mr-2 shrink-0"><Button type="button" small variant="ghost" aria-label={`Close ${s.title}`} onClick={close}>Close</Button></span>
      </div>
    </SwipeToClose>
  );
}

/** Search box (debounced) and filters: project, kind, start dates (DISP-54). */
function SearchBar({ filter, onChange }: { filter: SessionFilter; onChange: (f: SessionFilter) => void }) {
  const [text, setText] = useState(filter.q);
  const [open, setOpen] = useState(false);
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: () => api.get<ProjectSummary[]>('/projects') });
  useEffect(() => {
    if (text === filter.q) return;
    const t = setTimeout(() => onChange({ ...filter, q: text }), 300);
    return () => clearTimeout(t);
  }, [text, filter, onChange]);
  const set = (patch: Partial<SessionFilter>) => onChange({ ...filter, q: text, ...patch });
  const count = [filter.project, filter.kind, filter.from || filter.to].filter(Boolean).length;
  const select = cx(inputCls, 'h-10 py-0');
  return (
    <div className="px-3 pt-3">
      <div className="flex gap-2">
        <input
          type="search"
          className={cx(inputCls, 'flex-1 min-w-0 h-10')}
          placeholder="Search all chats"
          aria-label="Search chats"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') set({}); }}
          enterKeyHint="search"
        />
        <Button type="button" className="h-10 shrink-0" aria-expanded={open || count > 0} onClick={() => setOpen(!open)}>
          Filters{count ? ` (${count})` : ''}
        </Button>
      </div>
      {(open || count > 0) && (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <select className={select} aria-label="Project" value={filter.project} onChange={(e) => set({ project: e.target.value })}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.key}>{p.key} · {p.name}</option>)}
          </select>
          <select className={select} aria-label="Session kind" value={filter.kind} onChange={(e) => set({ kind: e.target.value })}>
            <option value="">All kinds</option>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
          <DateField label="From" value={filter.from} max={filter.to} onChange={(from) => set({ from })} />
          <DateField label="To" value={filter.to} min={filter.from} onChange={(to) => set({ to })} />
          {(count > 0 || text) && (
            <Button type="button" small className="col-span-2" onClick={() => { setText(''); onChange(NO_FILTER); }}>
              Clear search and filters
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A day, drawn like the other fields. iOS Safari gives a bare date input its own width and height
 * (it overflowed the grid, and was blank when empty), so the native input lies invisible on top:
 * a tap still opens the system date picker.
 */
function DateField({ label, value, min, max, onChange }: { label: string; value: string; min?: string; max?: string; onChange: (day: string) => void }) {
  const shown = value ? new Date(`${value}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Any day';
  return (
    <div className="min-w-0">
      <span className="block text-[12px] text-muted mb-0.5">{label}</span>
      <div className="relative overflow-hidden rounded-lg">
        <div className={cx(inputCls, 'h-10 py-0 flex items-center truncate', value ? 'pr-9' : 'text-faint')} aria-hidden>{shown}</div>
        <input
          type="date"
          aria-label={`${label} date`}
          className="absolute inset-0 w-full h-full min-w-0 opacity-0 cursor-pointer"
          value={value}
          min={min || undefined}
          max={max || undefined}
          onChange={(e) => onChange(e.target.value)}
          // desktop browsers open the picker only from their own icon, which is hidden here
          onClick={(e) => { try { e.currentTarget.showPicker(); } catch { /* not offered: typing works */ } }}
        />
        {value && (
          <button type="button" aria-label={`Clear ${label.toLowerCase()} date`} onClick={() => onChange('')} className="absolute right-0 inset-y-0 w-9 flex items-center justify-center text-muted text-lg">×</button>
        )}
      </div>
    </div>
  );
}

/** What the search found, newest first, a page at a time. */
function Results({ filter }: { filter: SessionFilter }) {
  const terms = searchTerms(filter.q);
  const { data, error, isPending, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['sessions', 'search', filter],
    queryFn: ({ pageParam }) => api.get<SessionSearch>(`/sessions/search?${searchQuery(filter, pageParam, PAGE)}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.has_more ? pages.length * PAGE : undefined),
    placeholderData: keepPreviousData,
  });
  const hits = data?.pages.flatMap((p) => p.sessions) ?? [];
  return (
    <Section title={isPending ? 'Searching…' : `Found${hasNextPage ? ` (${hits.length}+)` : ` (${hits.length})`}`}>
      <ErrorText error={error} />
      {hits.length ? (
        <Card className={cx(isFetching && !isFetchingNextPage && 'opacity-60')}>
          {hits.map((s) => <SessionRow key={s.id} s={s} showProject snippet={s.snippet} terms={terms} />)}
        </Card>
      ) : !isPending && <Empty>No chats match.</Empty>}
      {hasNextPage && (
        <div className="px-3 mt-2">
          <Button type="button" className="w-full" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </Section>
  );
}
