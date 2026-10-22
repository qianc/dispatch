import { PROJECT_ICON_PATHS, ProjectBadge, lookColor } from '../components/ProjectBadge.tsx';
import { PROJECT_COLORS, PROJECT_COLOR_NAMES, PROJECT_ICONS } from '../../../src/shared/projectLook.ts';
import { Icon } from '../components/icons.tsx';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SOURCE_KINDS, type ItemType } from '../../../src/shared/types.ts';
import { api, type Item, type ProjectSummary, type ReleaseOption, type ReleaseProposal, type Repo, type Session, type SourceSummary } from '../api.ts';
import { normalizeVersion, VERSION_RE } from '../../../src/shared/release.ts';
import { Page } from '../components/Layout.tsx';
import { ItemRow, NewItemForm, SessionRow, useFacets } from '../components/items.tsx';
import { BatchForm } from '../components/batch.tsx';
import { useAccounts } from '../accounts.ts';
import { useWorkers, workerName } from '../workers.ts';
import { noteProject } from '../nav.ts';
import { useVeryWide, useWide } from '../wide.ts';
import { ItemDetail } from './ItemDetail.tsx';
import { Button, Card, Chip, CloseButton, Empty, ErrorText, Field, Section, Segmented, Sheet, cx, inputCls, timeAgo } from '../components/ui.tsx';

type Tab = 'backlog' | 'bugs' | 'sessions' | 'sources' | 'settings';
const OPEN = ['triage', 'backlog', 'todo', 'in_progress', 'in_review'];

export function Project() {
  const { key = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'backlog';
  const nav = useNavigate();
  const [sheet, setSheet] = useState<null | 'item' | 'batch' | 'planner' | 'release'>(null);
  const [selectMode, setSelectMode] = useState(false);
  const wide = useWide();
  const veryWide = useVeryWide();
  const openItem = Number(params.get('item')) || null;
  const setOpenItem = (id: number | null) => {
    const next = new URLSearchParams(params);
    next.delete('new');
    if (id) next.set('item', String(id));
    else {
      next.delete('item');
      next.delete('discuss');
    }
    setParams(next, { replace: true });
  };
  /** desktop: the new-item form opens in the side panel (?new=1) */
  const openNew = () => {
    const next = new URLSearchParams(params);
    next.delete('item');
    next.delete('discuss');
    next.set('new', '1');
    setParams(next, { replace: true });
  };
  useEffect(() => noteProject(key), [key]);
  const { data: project } = useQuery({ queryKey: ['project', key], queryFn: () => api.get<ProjectSummary>(`/projects/${key}`) });
  const { data: items = [] } = useQuery({
    queryKey: ['items', project?.id],
    queryFn: () => api.get<Item[]>(`/projects/${key}/items`),
    enabled: !!project,
  });
  // the workers that can release one of this project's repos now
  const { data: releases = [] } = useQuery({
    queryKey: ['releases', key],
    queryFn: () => api.get<ReleaseOption[]>(`/projects/${key}/releases`),
    enabled: !!project,
    staleTime: 15_000,
  });
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (it: Item) => api.patch<Item>(`/items/${it.id}`, { marked: !it.marked }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['items', project?.id] }),
  });
  if (!project) return <Page title={key} back="/projects"><Empty>Loading…</Empty></Page>;

  const marked = items.filter((i) => i.marked);
  const type: ItemType = tab === 'bugs' ? 'bug' : 'backlog';
  // desktop has room for the checkboxes all the time
  const selecting = wide || selectMode || marked.length > 0;
  const listTab = tab === 'backlog' || tab === 'bugs';
  const creating = wide && listTab && params.get('new') === '1';
  const drawer = wide && listTab && openItem && !creating;
  // item | chat side by side in the drawer when there is room; the list gets narrower
  const discussing = veryWide && params.get('discuss') === '1';

  return (
    <div className="flex-1 min-h-0 flex">
    <div className="flex-1 min-w-0 flex flex-col">
    <Page
      wide={!drawer}
      icon={<ProjectBadge project={project} size={32} />}
      title={project.name}
      subtitle={<span style={{ color: lookColor(project) }} className="font-semibold">{project.key}</span>}
      back="/projects"
      actions={
        <>
          {releases.length > 0 && <Button small variant="ghost" onClick={() => setSheet('release')} aria-label="Create release">Release</Button>}
          <Button small variant="ghost" onClick={() => setSheet('planner')} aria-label="Plan with Claude"><Icon name="discuss" size={16} /> Plan</Button>
          {listTab && (wide ? (
            <Button small variant="primary" className="ml-1 pl-2" onClick={openNew}><Icon name="plus" size={18} strokeWidth={2} /> {tab === 'bugs' ? 'New bug' : 'New item'}</Button>
          ) : (
            <button onClick={() => setSheet('item')} aria-label="New item" className="size-10 flex items-center justify-center rounded-lg text-fg active:bg-raised"><Icon name="plus" size={24} strokeWidth={2} /></button>
          ))}
        </>
      }
      footer={marked.length > 0 && (tab === 'backlog' || tab === 'bugs') ? (
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="flex-1 text-[14px]">{marked.length} marked for the agent</span>
          <Button small onClick={() => { marked.forEach((m) => toggle.mutate(m)); setSelectMode(false); }}>Clear</Button>
          <Button small variant="primary" onClick={() => setSheet('batch')}>Start batch</Button>
        </div>
      ) : undefined}
    >
      <div className="px-3 pt-3 overflow-x-auto">
        <Segmented<Tab>
          value={tab}
          onChange={(t) => setParams(openItem ? { tab: t, item: String(openItem) } : { tab: t }, { replace: true })}
          options={[
            { value: 'backlog', label: 'Backlog' },
            { value: 'bugs', label: 'Bugs' },
            { value: 'sessions', label: 'Sessions' },
            { value: 'sources', label: 'Sources' },
            { value: 'settings', label: 'Settings' },
          ]}
        />
      </div>

      {(tab === 'backlog' || tab === 'bugs') && (
        <ItemList
          items={items.filter((i) => i.type === type)}
          project={project}
          onToggle={(it) => toggle.mutate(it)}
          selectMode={selecting}
          wide={wide}
          openItem={drawer ? openItem : null}
          onOpen={wide ? (it) => setOpenItem(it.id) : undefined}
          setSelectMode={(v) => {
            setSelectMode(v);
            if (!v) marked.forEach((m) => toggle.mutate(m));
          }}
        />
      )}
      {tab === 'sessions' && <ProjectSessions project={project} />}
      {tab === 'sources' && <Sources project={project} />}
      {tab === 'settings' && <ProjectSettings project={project} />}

      <Sheet open={sheet === 'item'} onClose={() => setSheet(null)} title={tab === 'bugs' ? 'New bug' : 'New backlog item'}>
        <NewItemForm project={project} type={type} onDone={() => setSheet(null)} />
      </Sheet>
      <Sheet open={sheet === 'batch'} onClose={() => setSheet(null)} title="Start batch">
        <BatchForm project={project} items={marked} onStarted={(s) => nav(`/s/${s.id}`)} />
      </Sheet>
      <Sheet open={sheet === 'planner'} onClose={() => setSheet(null)} title="Plan with Claude">
        <PlannerForm project={project} onStarted={(s) => nav(`/s/${s.id}`)} />
      </Sheet>
      <Sheet open={sheet === 'release'} onClose={() => setSheet(null)} title="Create release">
        {sheet === 'release' && <ReleaseForm project={project} options={releases} onStarted={(s) => nav(`/s/${s.id}`)} />}
      </Sheet>
    </Page>
    </div>
    {creating && (
      <aside className="w-[min(560px,46%)] shrink-0 min-h-0 flex flex-col border-l border-line bg-bg" aria-label="New item">
        <Page title={tab === 'bugs' ? 'New bug' : 'New backlog item'} subtitle={project.name} keepScroll={false} actions={<CloseButton onClick={() => setOpenItem(null)} label="Close" />}>
          <div className="px-4 pt-4">
            <NewItemForm key={type} project={project} type={type} onDone={(it) => setOpenItem(it.id)} />
          </div>
        </Page>
      </aside>
    )}
    {drawer && (
      <aside className={cx('shrink-0 min-h-0 flex flex-col border-l border-line bg-bg', discussing ? 'w-[min(1000px,68%)]' : 'w-[min(560px,46%)]')} aria-label="Item">
        <ItemDetail key={openItem} itemId={openItem} onClose={() => setOpenItem(null)} />
      </aside>
    )}
    </div>
  );
}

interface ListFilter { q: string; tags: string[]; modules: string[]; importance: number[]; wrap: boolean }
const NO_FILTER: ListFilter = { q: '', tags: [], modules: [], importance: [], wrap: false };

/** Filter + display settings, remembered per project on this device. */
function useListFilter(projectKey: string) {
  const storageKey = `dispatch:list:${projectKey}`;
  const [f, setF] = useState<ListFilter>(() => {
    try {
      return { ...NO_FILTER, ...JSON.parse(localStorage.getItem(storageKey) ?? '{}') };
    } catch {
      return NO_FILTER;
    }
  });
  const update = (patch: Partial<ListFilter>) => {
    const next = { ...f, ...patch };
    setF(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  };
  return [f, update] as const;
}

function matches(it: Item, f: ListFilter) {
  const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
  if (f.q.trim()) {
    const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = [it.key, it.title, it.body_md, ...it.labels, ...it.modules].join(' ').toLowerCase();
    if (!words.every((w) => hay.includes(w))) return false;
  }
  if (f.tags.length && !lower(it.labels).some((t) => lower(f.tags).includes(t))) return false;
  if (f.modules.length && !lower(it.modules).some((m) => lower(f.modules).includes(m))) return false;
  if (f.importance.length && !f.importance.includes(it.importance)) return false;
  return true;
}

function ToggleChips({ label, options, value, onChange }: { label: string; options: { value: string | number; label: string }[]; value: (string | number)[]; onChange: (v: (string | number)[]) => void }) {
  if (!options.length) return null;
  return (
    <div className="mb-4" role="group" aria-label={label}>
      <div className="text-[13px] text-muted mb-1.5">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = value.includes(o.value);
          return (
            <button
              key={String(o.value)}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
              className={cx('rounded-md border text-[13px] min-h-8 px-2.5 py-1 text-left', on ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted')}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ItemList({ items, project, onToggle, selectMode, setSelectMode, wide, openItem, onOpen }: {
  items: Item[];
  project: ProjectSummary;
  onToggle: (it: Item) => void;
  selectMode: boolean;
  setSelectMode: (v: boolean) => void;
  wide: boolean;
  openItem: number | null;
  onOpen?: (it: Item) => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [f, setF] = useListFilter(project.key);
  const { data: facets } = useFacets(project.key);
  const active = f.tags.length + f.modules.length + f.importance.length;
  const shown = items.filter((i) => matches(i, f));
  const open = shown.filter((i) => OPEN.includes(i.status));
  const held = shown.filter((i) => i.status === 'hold').sort((a, b) => b.importance - a.importance || b.number - a.number);
  const closed = shown.filter((i) => !OPEN.includes(i.status) && i.status !== 'hold');
  const groups = [
    { title: 'In review', items: open.filter((i) => i.status === 'in_review') },
    { title: 'In progress', items: open.filter((i) => i.status === 'in_progress') },
    { title: 'Todo', items: open.filter((i) => i.status === 'todo') },
    { title: 'Triage', items: open.filter((i) => i.status === 'triage') },
    { title: 'Backlog', items: open.filter((i) => i.status === 'backlog').sort((a, b) => b.importance - a.importance || b.number - a.number) },
  ].filter((g) => g.items.length);
  const row = (it: Item, markable = true) => (
    <ItemRow
      key={it.id}
      item={it}
      project={project}
      wrap={f.wrap}
      selectMode={markable && selectMode}
      onToggle={onToggle}
      onOpen={onOpen}
      active={it.id === openItem}
      roomy={!openItem}
      onLongPress={markable ? (x) => { setSelectMode(true); if (!x.marked) onToggle(x); } : undefined}
    />
  );
  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-3">
        <div className="relative flex-1">
          <input
            type="search"
            className={cx(inputCls, 'h-9 py-1 pl-8')}
            placeholder="Search"
            value={f.q}
            onChange={(e) => setF({ q: e.target.value })}
            aria-label="Search items"
          />
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
        </div>
        <Button small onClick={() => setFilterOpen(true)} aria-label="Filter and view">
          Filter{active > 0 && <span className="ml-0.5 min-w-4 h-4 px-1 rounded-full bg-accent-strong text-on-accent text-[10px] leading-4">{active}</span>}
        </Button>
        {!wide && <Button small variant={selectMode ? 'primary' : 'secondary'} onClick={() => setSelectMode(!selectMode)}>{selectMode ? 'Done' : 'Select'}</Button>}
      </div>
      {(active > 0 || f.q) && (
        <div className="px-4 pt-2 text-[12px] text-muted flex items-center gap-2">
          {shown.length} of {items.length} shown
          <button className="text-accent" onClick={() => setF({ ...NO_FILTER, wrap: f.wrap })}>Clear</button>
        </div>
      )}
      {!open.length && !held.length && <Empty>{items.length ? 'Nothing matches.' : 'Nothing open. Tap + to add one.'}</Empty>}
      {groups.map((g) => (
        <Section key={g.title} title={`${g.title} · ${g.items.length}`}>
          <Card>{g.items.map((it) => row(it))}</Card>
        </Section>
      ))}
      {held.length > 0 && (
        <Section title={`On hold · ${held.length}`}>
          <Card>{held.map((it) => row(it))}</Card>
        </Section>
      )}
      {closed.length > 0 && (
        <Section title={`Closed · ${closed.length}`} action={<button className="text-[12px] text-accent" onClick={() => setShowClosed(!showClosed)}>{showClosed ? 'Hide' : 'Show'}</button>}>
          {showClosed && <Card>{closed.map((it) => row(it, false))}</Card>}
        </Section>
      )}
      <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Filter and view">
        <ToggleChips
          label="Importance"
          options={project.importance_scale.map((l, i) => ({ value: i + 1, label: l })).reverse()}
          value={f.importance}
          onChange={(v) => setF({ importance: v as number[] })}
        />
        <ToggleChips label="Modules" options={(facets?.modules ?? []).map((m) => ({ value: m.name, label: `${m.name} · ${m.count}` }))} value={f.modules} onChange={(v) => setF({ modules: v as string[] })} />
        <ToggleChips label="Tags" options={(facets?.tags ?? []).map((t) => ({ value: t.name, label: `#${t.name} · ${t.count}` }))} value={f.tags} onChange={(v) => setF({ tags: v as string[] })} />
        {!facets?.tags.length && !facets?.modules.length && <p className="text-[13px] text-faint mb-4">No tags or modules yet. Add them on an item, or ask the assistant to tag the backlog.</p>}
        <label className="flex items-center justify-between text-[14px] py-2 border-t border-line">
          Show full titles, tags and modules
          <input type="checkbox" checked={f.wrap} onChange={(e) => setF({ wrap: e.target.checked })} className="size-5 accent-[var(--color-accent-strong)]" />
        </label>
        <div className="flex gap-2 mt-3">
          <Button className="flex-1" onClick={() => setF({ ...NO_FILTER, wrap: f.wrap })}>Clear filters</Button>
          <Button variant="primary" className="flex-1" onClick={() => setFilterOpen(false)}>Show {shown.length}</Button>
        </div>
      </Sheet>
    </>
  );
}

function PlannerForm({ project, onStarted }: { project: ProjectSummary; onStarted: (s: Session) => void }) {
  const [prompt, setPrompt] = useState('');
  const start = useMutation({ mutationFn: () => api.post<Session>(`/projects/${project.key}/planner`, { prompt }), onSuccess: onStarted });
  return (
    <form onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
      <p className="text-[13px] text-muted mb-3">Claude reads the code and the tracker (no changes) and proposes the next batch as a card you can edit and start.</p>
      <Field label="What do you want to focus on? (optional)">
        <textarea className={cx(inputCls, 'min-h-24')} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. quick wins before the release" />
      </Field>
      <ErrorText error={start.error} />
      <Button variant="primary" className="w-full" disabled={start.isPending}>Start planning chat</Button>
    </form>
  );
}

const FROM = { tag: 'git tag', file: 'VERSION file', label: 'Dispatch labels' };

/** Review the proposed version, edit it, and start the release on the worker that offers it. */
function ReleaseForm({ project, options, onStarted }: { project: ProjectSummary; options: ReleaseOption[]; onStarted: (s: Session) => void }) {
  const [pick, setPick] = useState(0);
  const opt = options[Math.min(pick, options.length - 1)];
  const { data: proposal, error, isFetching } = useQuery({
    queryKey: ['release-proposal', project.key, opt?.worker_id, opt?.repo_id],
    queryFn: () => api.get<ReleaseProposal>(`/projects/${project.key}/releases/proposal?worker_id=${opt.worker_id}&repo_id=${opt.repo_id}`),
    enabled: !!opt,
  });
  const [version, setVersion] = useState('');
  useEffect(() => setVersion(proposal?.proposed ?? ''), [proposal?.proposed, opt?.worker_id, opt?.repo_id]);
  const start = useMutation({
    mutationFn: () => api.post<Session>(`/projects/${project.key}/releases`, { worker_id: opt.worker_id, repo_id: opt.repo_id, version }),
    onSuccess: onStarted,
  });
  if (!opt) return <Empty>No worker offers a release of this project now.</Empty>;
  const final = normalizeVersion(version, proposal?.last?.version ?? null);
  const valid = VERSION_RE.test(final);
  const items = proposal?.items ?? [];
  return (
    <form onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
      <p className="text-[13px] text-muted mb-3">Claude writes the changelog from the done items, runs the release on the worker, and labels the items once the release succeeded.</p>
      {options.length > 1 ? (
        <Field label="Release">
          <select className={inputCls} value={pick} onChange={(e) => setPick(Number(e.target.value))}>
            {options.map((o, i) => <option key={`${o.worker_id}-${o.repo_id}`} value={i}>{o.repo} · {o.worker} ({o.label_prefix})</option>)}
          </select>
        </Field>
      ) : (
        <div className="text-[14px] mb-3"><span className="font-medium">{opt.repo}</span> <span className="text-muted">on worker {opt.worker}</span></div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] mb-3">
        <dt className="text-muted">Last release</dt>
        <dd>{proposal ? (proposal.last ? `${proposal.last.version} (${FROM[proposal.last.from]})` : 'none found') : isFetching ? 'reading…' : '—'}</dd>
        <dt className="text-muted">Runs</dt>
        <dd className="font-mono break-all">{opt.command ?? "the repo's own release steps"}</dd>
        {opt.notes && <><dt className="text-muted">Notes</dt><dd>{opt.notes}</dd></>}
      </dl>
      {proposal?.warning && <p className="text-[13px] text-wait mb-3">{proposal.warning}</p>}
      <ErrorText error={error} />
      <Field label={`Version${proposal ? ` (proposed: ${proposal.proposed})` : ''}`}>
        <input className={cx(inputCls, 'font-mono')} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v1.2.3" aria-label="Version" />
      </Field>
      <p className={cx('text-[12px] -mt-2 mb-3', valid || !version ? 'text-muted' : 'text-bad')}>
        {valid ? <>Items get the label <span className="font-mono">{opt.label_prefix}{final}</span></> : version ? 'A version looks like v1.2.3' : ''}
      </p>
      <Section title={`Done since the last release · ${items.length}`}>
        {items.length ? (
          <Card>
            {items.map((it) => (
              <div key={it.id} className="flex items-center gap-2 px-3 py-2 border-b border-line last:border-b-0 text-[14px]">
                <span className="text-muted font-mono text-[12px]">{it.key}</span>
                <span className="flex-1 min-w-0 truncate">{it.title}</span>
                {it.type === 'bug' && <Chip tone="bad">bug</Chip>}
              </div>
            ))}
          </Card>
        ) : <Empty>{proposal ? 'Nothing done since the last release.' : 'Loading…'}</Empty>}
      </Section>
      <ErrorText error={start.error} />
      <Button variant="primary" className="w-full mt-3" disabled={!proposal || !items.length || !valid || start.isPending}>Create release {valid ? final : ''}</Button>
    </form>
  );
}

function ProjectSessions({ project }: { project: ProjectSummary }) {
  const { data = [] } = useQuery({ queryKey: ['sessions', 'project', project.key], queryFn: () => api.get<Session[]>(`/sessions?project=${project.key}`) });
  return data.length ? <Card className="mt-3">{data.map((s) => <SessionRow key={s.id} s={s} />)}</Card> : <Empty>No sessions yet.</Empty>;
}

function Sources({ project }: { project: ProjectSummary }) {
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const { data = [] } = useQuery({ queryKey: ['sources', project.id], queryFn: () => api.get<SourceSummary[]>(`/projects/${project.key}/sources`) });
  return (
    <>
      <div className="px-3 mt-3"><Button className="w-full" onClick={() => setAdding(true)}>+ Capture retro or report</Button></div>
      {!data.length && <Empty>Sources are retros, skill-run reports and user reports. Items split from them link back here.</Empty>}
      {data.length > 0 && (
        <Card className="mt-3">
          {data.map((s) => (
            <Link key={s.id} to={`/sources/${s.id}`} className="block px-3 py-2.5 border-b border-line last:border-b-0 active:bg-raised">
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate font-medium">{s.title}</span>
                <Chip>{s.kind.replace('_', ' ')}</Chip>
              </div>
              <div className="text-[13px] text-muted mt-0.5">
                {[s.reporter, s.version_tag, s.skill_name].filter(Boolean).join(' · ') || '—'} · {s.item_count} items · {timeAgo(s.created_at)}
              </div>
            </Link>
          ))}
        </Card>
      )}
      <Sheet open={adding} onClose={() => setAdding(false)} title="Capture source">
        <NewSourceForm project={project} onDone={(id) => nav(`/sources/${id}`)} />
      </Sheet>
    </>
  );
}

function NewSourceForm({ project, onDone }: { project: ProjectSummary; onDone: (id: number) => void }) {
  const [f, setF] = useState({ kind: 'retro', title: '', body_md: '', reporter: '', version_tag: '', skill_name: '' });
  const create = useMutation({
    mutationFn: () => api.post<{ id: number }>(`/projects/${project.key}/sources`, {
      ...f, reporter: f.reporter || null, version_tag: f.version_tag || null, skill_name: f.skill_name || null,
    }),
    onSuccess: (s) => onDone(s.id),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <Field label="Kind">
        <select className={inputCls} value={f.kind} onChange={set('kind')}>
          {SOURCE_KINDS.filter((k) => k !== 'agent_session').map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
        </select>
      </Field>
      <Field label="Title"><input className={inputCls} value={f.title} onChange={set('title')} autoFocus /></Field>
      <div className="grid grid-cols-2 gap-x-2">
        <Field label="Reporter"><input className={inputCls} value={f.reporter} onChange={set('reporter')} placeholder="who" /></Field>
        <Field label="Version tag"><input className={inputCls} value={f.version_tag} onChange={set('version_tag')} placeholder="v1.4.2" /></Field>
      </div>
      <Field label="Skill (if from a skill run)"><input className={inputCls} value={f.skill_name} onChange={set('skill_name')} /></Field>
      <Field label="Retro / report text (markdown)"><textarea className={cx(inputCls, 'min-h-48 font-mono text-[14px]')} value={f.body_md} onChange={set('body_md')} /></Field>
      <ErrorText error={create.error} />
      <Button variant="primary" className="w-full" disabled={!f.title || create.isPending}>Save source</Button>
    </form>
  );
}

/** Where this project's work runs: its default worker, and prose the planner reads to choose. */
function ProjectWorkers({ project, onSave }: { project: ProjectSummary; onSave: (patch: object) => void }) {
  const { data } = useWorkers();
  const [text, setText] = useState(project.placement_md);
  const local = project.repos.find((r) => r.kind === 'local' && r.worker_id);
  return (
    <Section title="Where work runs">
      <Card className="p-3">
        <Field label="Default worker" hint={local ? 'Its local repos are on this worker, so every session runs there.' : undefined}>
          <select className={inputCls} disabled={!!local} value={String(local?.worker_id ?? project.worker_id ?? '')} onChange={(e) => onSave({ worker_id: e.target.value ? Number(e.target.value) : null })} aria-label="Default worker">
            <option value="">The global default ({workerName(data?.workers, data?.default_worker_id)})</option>
            {data?.workers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
        <Field label="Rules for the planner" hint="When to use which worker, and what no worker can do yet. The planner reads this with each worker's description.">
          <textarea className={cx(inputCls, 'min-h-20')} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Use the desktop only for work that runs PowerPoint. Everything else runs on linux." aria-label="Where work runs" />
        </Field>
        <Button small variant="primary" disabled={text === project.placement_md} onClick={() => onSave({ placement_md: text })}>Save</Button>
      </Card>
    </Section>
  );
}

function ProjectSettings({ project }: { project: ProjectSummary }) {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['project', project.key] });
    qc.invalidateQueries({ queryKey: ['projects'] }); // colours and icons elsewhere
  };
  const [f, setF] = useState({ name: project.name, description: project.description, importance: project.importance_scale.join(', '), effort: project.effort_scale.join(', ') });
  const save = useMutation({
    mutationFn: (patch: object) => api.patch(`/projects/${project.key}`, patch),
    onSuccess: refresh,
  });
  const [repo, setRepo] = useState({ full: '', default_branch: '', check_command: '', worker_id: '' });
  const [hostedForm, setHostedForm] = useState<{ on: boolean; name: string; import: string; upstream: string }>({ on: false, name: '', import: '', upstream: '' });
  const addHosted = useMutation({
    mutationFn: () => api.post('/projects/' + project.key + '/repos', { hosted: { name: hostedForm.name.trim(), import: hostedForm.import.trim() || undefined, upstream: hostedForm.upstream.trim() || undefined, default_branch: repo.default_branch || undefined } }),
    onSuccess: () => { setHostedForm({ on: false, name: '', import: '', upstream: '' }); refresh(); },
  });
  const isPath = /^(\/|~\/|\.\.?\/)/.test(repo.full.trim());
  const { data: workerList } = useWorkers();
  const workers = workerList?.workers ?? [];
  const localWorker = project.repos.find((r) => r.kind === 'local' && r.worker_id)?.worker_id ?? null;
  const [repoNote, setRepoNote] = useState<string | null>(null);
  const addRepo = useMutation({
    mutationFn: () => {
      if (isPath) {
        return api.post<{ note?: string | null }>(`/projects/${project.key}/repos`, { local_path: repo.full.trim(), default_branch: repo.default_branch || undefined, check_command: repo.check_command || null, worker_id: localWorker ?? (repo.worker_id ? Number(repo.worker_id) : null) });
      }
      const [github_owner, github_name] = repo.full.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '').split('/');
      return api.post<{ note?: string | null }>(`/projects/${project.key}/repos`, { github_owner, github_name, default_branch: repo.default_branch || 'main', check_command: repo.check_command || null });
    },
    onSuccess: (r) => { setRepo({ full: '', default_branch: '', check_command: '', worker_id: '' }); setRepoNote(r.note ?? null); refresh(); },
  });
  const delRepo = useMutation({ mutationFn: (r: Repo) => api.del(`/repos/${r.id}`), onSuccess: refresh });
  const [editing, setEditing] = useState<Repo | null>(null);
  return (
    <>
      <Section title="Repos">
        <Card>
          {project.repos.map((r) => (
            <div key={r.id} className="flex items-center gap-2 px-3 py-2.5 border-b border-line">
              <div className="flex-1 min-w-0">
                <div className="truncate">
                  {r.kind === 'hosted' ? <><Chip className="mr-1.5">hosted</Chip>{r.github_name}{r.upstream_owner && <span className="text-muted"> → {r.upstream_owner}/{r.upstream_name}</span>}</>
                    : r.local_path ? <><Chip className="mr-1.5">local</Chip>{r.local_path}</> : `${r.github_owner}/${r.github_name}`}
                </div>
                <div className="text-[12px] text-muted truncate">
                  base {r.default_branch}
                  {r.local_path && workers.length > 1 && ` · on ${workerName(workers, r.worker_id)}`}
                  {r.local_path && (r.worktree_from === 'clone' ? ' · separate clone' : ' · worktrees in the repo')}
                  {r.setup_command ? ` · setup: ${r.setup_command}` : ''}
                  {r.read_dirs?.length ? ` · Discuss also reads: ${r.read_dirs.join(', ')}` : ''}
                  {r.check_command ? ` · check: ${r.check_command}` : ''}
                </div>
              </div>
              <Button small variant="ghost" onClick={() => setEditing(r)}>Edit</Button>
            </div>
          ))}
          <label className="flex items-center gap-2 px-3 pt-3 text-[14px]">
            <input type="checkbox" checked={hostedForm.on} onChange={(e) => setHostedForm({ ...hostedForm, on: e.target.checked })} className="size-4 accent-[var(--color-accent-strong)]" />
            Keep the repo in Dispatch (hosted)
          </label>
          {hostedForm.on ? (
            <form className="p-3 space-y-2" onSubmit={(e) => { e.preventDefault(); addHosted.mutate(); }}>
              <p className="text-[12px] text-muted">Dispatch keeps the repo itself. Workers clone and push to it, and you review and merge here. Optionally copy an existing GitHub repo, and push merges on to a GitHub repo.</p>
              <input className={inputCls} placeholder="name, e.g. app" value={hostedForm.name} onChange={(e) => setHostedForm({ ...hostedForm, name: e.target.value })} aria-label="Hosted repo name" />
              <input className={inputCls} placeholder="copy from GitHub (optional): owner/name" value={hostedForm.import} onChange={(e) => setHostedForm({ ...hostedForm, import: e.target.value })} aria-label="Copy from GitHub" />
              <input className={inputCls} placeholder="push merges to GitHub (optional): owner/name" value={hostedForm.upstream} onChange={(e) => setHostedForm({ ...hostedForm, upstream: e.target.value })} aria-label="Push merges to GitHub" />
              <input className={inputCls} placeholder="base branch (main)" value={repo.default_branch} onChange={(e) => setRepo({ ...repo, default_branch: e.target.value })} aria-label="Base branch" />
              <ErrorText error={addHosted.error} />
              <Button className="w-full" disabled={!hostedForm.name.trim() || addHosted.isPending}>{addHosted.isPending ? 'Making the repo…' : 'Add hosted repo'}</Button>
            </form>
          ) : (
          <form className="p-3 space-y-2" onSubmit={(e) => { e.preventDefault(); addRepo.mutate(); }}>
            <input className={inputCls} placeholder="owner/repo, or a local folder like ~/projects/x" value={repo.full} onChange={(e) => setRepo({ ...repo, full: e.target.value })} aria-label="Repository" />
            {isPath && <p className="text-[12px] text-muted">Local repo: agents push their branches into this folder, and you review and merge them here. No GitHub needed.</p>}
            {isPath && workers.length > 1 && (localWorker ? (
              <p className="text-[12px] text-muted">On worker {workerName(workers, localWorker)}, with this project's other local repos.</p>
            ) : (
              <select className={inputCls} value={repo.worker_id || String(project.worker_id ?? workerList?.default_worker_id ?? '')} onChange={(e) => setRepo({ ...repo, worker_id: e.target.value })} aria-label="Worker that has this folder">
                {workers.map((w) => <option key={w.id} value={w.id}>On worker {w.name}</option>)}
              </select>
            ))}
            <div className="grid grid-cols-2 gap-2">
              <input className={inputCls} placeholder={isPath ? 'base (auto)' : 'base branch (main)'} value={repo.default_branch} onChange={(e) => setRepo({ ...repo, default_branch: e.target.value })} aria-label="Base branch" />
              <input className={inputCls} placeholder="check cmd (optional)" value={repo.check_command} onChange={(e) => setRepo({ ...repo, check_command: e.target.value })} aria-label="Check command" />
            </div>
            <ErrorText error={addRepo.error} />
            {repoNote && <p className="text-[12px] text-wait">{repoNote}</p>}
            <Button className="w-full" disabled={!repo.full.includes('/') || addRepo.isPending}>Add repo</Button>
          </form>
          )}
        </Card>
      </Section>
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing ? `Repo ${editing.github_name}` : 'Repo'}>
        {editing && (
          <RepoForm
            repo={editing}
            onDone={() => { setEditing(null); refresh(); }}
            onRemove={() => { if (confirm(`Remove ${editing.github_name} from this project?`)) { delRepo.mutate(editing); setEditing(null); } }}
          />
        )}
      </Sheet>
      <ProjectLook project={project} onSave={(patch) => save.mutate(patch)} />
      <ProjectAccounts project={project} onSaved={refresh} />
      <ProjectWorkers project={project} onSave={(patch) => save.mutate(patch)} />
      <Section title="Agent & notifications">
        <Card className="p-3 space-y-3">
          <label className="flex items-center justify-between text-[14px]">
            Plan first by default
            <input type="checkbox" checked={project.default_force_plan} onChange={(e) => save.mutate({ default_force_plan: e.target.checked })} className="size-5 accent-[var(--color-accent-strong)]" />
          </label>
          <label className="flex items-center justify-between text-[14px]">
            Mute push notifications
            <input type="checkbox" checked={project.muted} onChange={(e) => save.mutate({ muted: e.target.checked })} className="size-5 accent-[var(--color-accent-strong)]" />
          </label>
        </Card>
      </Section>
      <Section title="Project">
        <form className="mx-3" onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            name: f.name, description: f.description,
            importance_scale: f.importance.split(',').map((s) => s.trim()).filter(Boolean),
            effort_scale: f.effort.split(',').map((s) => s.trim()).filter(Boolean),
          });
        }}>
          <Field label="Name"><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Description"><textarea className={inputCls} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="Importance scale" hint="Exactly 4 labels, lowest first"><input className={inputCls} value={f.importance} onChange={(e) => setF({ ...f, importance: e.target.value })} /></Field>
          <Field label="Effort scale" hint="Smallest first. Existing items keep their index."><input className={inputCls} value={f.effort} onChange={(e) => setF({ ...f, effort: e.target.value })} /></Field>
          <ErrorText error={save.error} />
          <Button className="w-full" disabled={save.isPending}>Save</Button>
        </form>
      </Section>
    </>
  );
}

/** Colour and icon, so projects are easy to tell apart in lists. */
function ProjectLook({ project, onSave }: { project: ProjectSummary; onSave: (patch: { color?: string | null; icon?: string | null }) => void }) {
  const current = lookColor(project);
  return (
    <Section title="Look">
      <Card className="p-3">
        <div className="flex items-center gap-3 mb-3">
          <ProjectBadge project={project} size={40} />
          <div className="text-[13px] text-muted">Colour and icon for this project in lists, the menu and the inbox.</div>
        </div>
        <div className="text-[13px] text-muted mb-1.5">Colour</div>
        <div className="flex flex-wrap gap-2 mb-4" role="radiogroup" aria-label="Colour">
          {PROJECT_COLOR_NAMES.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={project.color === c}
              aria-label={c}
              onClick={() => onSave({ color: c })}
              className={cx('size-8 rounded-full border-2', PROJECT_COLORS[c] === current && project.color === c ? 'border-fg' : 'border-transparent')}
              style={{ background: PROJECT_COLORS[c] }}
            />
          ))}
          <button type="button" role="radio" aria-checked={!project.color} onClick={() => onSave({ color: null })} className={cx('h-8 px-2.5 rounded-full border text-[12px]', !project.color ? 'border-fg text-fg' : 'border-line text-muted')}>Auto</button>
        </div>
        <div className="text-[13px] text-muted mb-1.5">Icon</div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Icon">
          <button type="button" role="radio" aria-checked={!project.icon} aria-label="First letter of the key" onClick={() => onSave({ icon: null })}
            className={cx('size-10 rounded-lg border flex items-center justify-center font-bold', !project.icon ? 'border-fg' : 'border-line')} style={{ color: current }}>
            {project.key.charAt(0)}
          </button>
          {PROJECT_ICONS.map((icon) => (
            <button key={icon} type="button" role="radio" aria-checked={project.icon === icon} aria-label={icon} onClick={() => onSave({ icon })}
              className={cx('size-10 rounded-lg border flex items-center justify-center', project.icon === icon ? 'border-fg' : 'border-line')} style={{ color: current }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"><path d={PROJECT_ICON_PATHS[icon]} /></svg>
            </button>
          ))}
        </div>
      </Card>
    </Section>
  );
}

function RepoForm({ repo, onDone, onRemove }: { repo: Repo; onDone: () => void; onRemove: () => void }) {
  const [f, setF] = useState({
    default_branch: repo.default_branch,
    check_command: repo.check_command ?? '',
    setup_command: repo.setup_command ?? '',
    worktree_from: repo.worktree_from ?? 'repo',
    read_dirs: (repo.read_dirs ?? []).join('\n'),
    upstream: repo.upstream_owner ? `${repo.upstream_owner}/${repo.upstream_name}` : '',
  });
  const save = useMutation({
    mutationFn: () => api.patch(`/repos/${repo.id}`, {
      default_branch: f.default_branch,
      check_command: f.check_command.trim() || null,
      setup_command: f.setup_command.trim() || null,
      ...(repo.local_path ? { worktree_from: f.worktree_from, read_dirs: f.read_dirs.split('\n').map((d) => d.trim()).filter(Boolean) } : {}),
      ...(repo.kind === 'hosted' ? { upstream: f.upstream.trim() || null } : {}),
    }),
    onSuccess: onDone,
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <p className="text-[13px] text-muted mb-3 break-all">{repo.kind === 'hosted' ? `${repo.github_name} · hosted by Dispatch` : repo.local_path ?? `${repo.github_owner}/${repo.github_name}`}</p>
      <Field label="Base branch"><input className={inputCls} value={f.default_branch} onChange={(e) => setF({ ...f, default_branch: e.target.value })} /></Field>
      {repo.kind === 'hosted' && (
        <Field label="GitHub repo to push merges to (optional)" hint="After a merge in Dispatch, the base branch is pushed there, with the project's GitHub account. You can also open PRs there instead of merging in Dispatch.">
          <input className={inputCls} value={f.upstream} onChange={(e) => setF({ ...f, upstream: e.target.value })} placeholder="owner/name" aria-label="Upstream GitHub repo" />
        </Field>
      )}
      {repo.local_path && (
        <Field
          label="Session worktrees"
          group
          hint={f.worktree_from === 'repo'
            ? 'Worktrees of your repo itself: its own tools see your checkout as main (venv, test cache, current main). Branches appear in your repo at once.'
            : 'A separate Dispatch clone: fully isolated, but tools that expect a worktree of your checkout will not find its venv or caches.'}
        >
          <Segmented value={f.worktree_from} onChange={(worktree_from) => setF({ ...f, worktree_from })} options={[{ value: 'repo', label: 'From the repo itself' }, { value: 'clone', label: 'Separate clone' }]} />
        </Field>
      )}
      <Field label="Setup command (optional)" hint="Runs in each new session worktree before the agent starts, e.g. a venv setup or npm ci.">
        <input className={cx(inputCls, 'font-mono text-[14px]')} value={f.setup_command} onChange={(e) => setF({ ...f, setup_command: e.target.value })} placeholder="bash tools/setup.sh" />
      </Field>
      {repo.local_path && (
        <Field
          label="Extra folders Discuss may read (optional)"
          hint="One per line, inside the repo. For material git does not track, so sessions do not have it (e.g. reference renders). Discuss chats can then read these folders in your checkout, and show images from them. Leave empty to keep them out."
        >
          <textarea className={cx(inputCls, 'min-h-16 font-mono text-[14px]')} value={f.read_dirs} onChange={(e) => setF({ ...f, read_dirs: e.target.value })} placeholder="reference-decks/library-work" />
        </Field>
      )}
      <Field label="Check command (optional)" hint="Must pass before a local merge.">
        <input className={cx(inputCls, 'font-mono text-[14px]')} value={f.check_command} onChange={(e) => setF({ ...f, check_command: e.target.value })} placeholder="npm test" />
      </Field>
      <ErrorText error={save.error} />
      <Button variant="primary" className="w-full" disabled={save.isPending}>Save</Button>
      <Button type="button" variant="danger" className="w-full mt-2" onClick={onRemove}>Remove repo</Button>
    </form>
  );
}

function ProjectAccounts({ project, onSaved }: { project: ProjectSummary; onSaved: () => void }) {
  const { data: accounts } = useAccounts();
  const save = useMutation({ mutationFn: (patch: object) => api.patch(`/projects/${project.key}`, patch), onSuccess: onSaved });
  if (!accounts || (accounts.claude.length < 2 && accounts.github.length < 2)) return null;
  const allowed = project.claude_allowed ?? accounts.claude.map((a) => a.name);
  const toggle = (name: string) => {
    const next = allowed.includes(name) ? allowed.filter((n) => n !== name) : [...allowed, name];
    if (!next.length) return;
    const all = accounts.claude.every((a) => next.includes(a.name));
    save.mutate({ claude_allowed: all ? null : next, ...(project.claude_account && !next.includes(project.claude_account) ? { claude_account: next[0] } : {}) });
  };
  return (
    <Section title="Accounts">
      <Card className="p-3">
        {accounts.github.length > 1 && (
          <Field label="GitHub account" group hint="Its repos are cloned, pushed and merged with this account, and commits carry its identity.">
            <Segmented value={project.github_account ?? accounts.github[0].name} onChange={(v) => save.mutate({ github_account: v })} options={accounts.github.map((a) => ({ value: a.name, label: a.login ? `${a.name} (@${a.login})` : a.name }))} />
          </Field>
        )}
        {accounts.claude.length > 1 && (
          <>
            <Field label="Allowed Claude accounts" group hint="A sensitive project can be limited to the work account; batches cannot start on others.">
              <div className="flex flex-wrap gap-1.5">
                {accounts.claude.map((a) => (
                  <button key={a.name} type="button" aria-pressed={allowed.includes(a.name)} onClick={() => toggle(a.name)}
                    className={cx('rounded-md border text-[13px] h-8 px-2.5', allowed.includes(a.name) ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted')}>
                    {a.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Default Claude account" group>
              <Segmented
                value={project.claude_account && allowed.includes(project.claude_account) ? project.claude_account : allowed[0]}
                onChange={(v) => save.mutate({ claude_account: v })}
                options={accounts.claude.filter((a) => allowed.includes(a.name)).map((a) => ({ value: a.name, label: a.label }))}
              />
            </Field>
          </>
        )}
        <ErrorText error={save.error} />
      </Card>
    </Section>
  );
}
