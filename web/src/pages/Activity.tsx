import { useEffect, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { searchTerms } from '../../../src/shared/search.ts';
import type { SessionSearch } from '../../../src/shared/types.ts';
import { NO_FILTER, filtering, searchQuery, type SessionFilter } from '../activity.ts';
import { api, type Inbox, type ProjectSummary, type Session } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { SessionRow } from '../components/items.tsx';
import { Button, Card, Empty, ErrorText, Section, cx, inputCls } from '../components/ui.tsx';

const KINDS = [
  { value: 'work', label: 'Work' },
  { value: 'planner', label: 'Planning' },
  { value: 'discuss', label: 'Discuss' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'release', label: 'Release' },
];
const PAGE = 30;

export function Activity() {
  const { data: live = [] } = useQuery({ queryKey: ['sessions', 'live'], queryFn: () => api.get<Session[]>('/sessions?status=queued,running,waiting_input,idle') });
  // same query as the menu: an idle session's attention says whether Dispatch checks or merges it
  const { data: inbox } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<Inbox>('/inbox') });
  const attention = new Map((inbox?.idle ?? []).map((s) => [s.id, s.attention]));
  const { data: recent = [] } = useQuery({ queryKey: ['sessions', 'recent'], queryFn: () => api.get<Session[]>('/sessions?status=completed,failed,stopped') });
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
      {!searching && recent.length > 0 && (
        <Section title="Recently finished">
          <Card>{recent.slice(0, 30).map((s) => <SessionRow key={s.id} s={s} showProject />)}</Card>
        </Section>
      )}
      </div>
    </Page>
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
          <label className="block text-[12px] text-muted">From
            <input type="date" className={cx(select, 'mt-0.5')} value={filter.from} max={filter.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label className="block text-[12px] text-muted">To
            <input type="date" className={cx(select, 'mt-0.5')} value={filter.to} min={filter.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          </label>
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
