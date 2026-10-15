import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SOURCE_KINDS, type ItemType } from '../../../src/shared/types.ts';
import { api, type Item, type ProjectSummary, type Repo, type Session, type SourceSummary } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { ItemRow, NewItemForm, SessionRow, useFacets } from '../components/items.tsx';
import { BatchForm } from '../components/batch.tsx';
import { useAccounts } from '../accounts.ts';
import { Button, Card, Chip, Empty, ErrorText, Field, Section, Segmented, Sheet, cx, inputCls, timeAgo } from '../components/ui.tsx';

type Tab = 'backlog' | 'bugs' | 'sessions' | 'sources' | 'settings';
const OPEN = ['triage', 'backlog', 'todo', 'in_progress', 'in_review'];

export function Project() {
  const { key = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'backlog';
  const nav = useNavigate();
  const [sheet, setSheet] = useState<null | 'item' | 'batch' | 'planner'>(null);
  const [selectMode, setSelectMode] = useState(false);
  const { data: project } = useQuery({ queryKey: ['project', key], queryFn: () => api.get<ProjectSummary>(`/projects/${key}`) });
  const { data: items = [] } = useQuery({
    queryKey: ['items', project?.id],
    queryFn: () => api.get<Item[]>(`/projects/${key}/items`),
    enabled: !!project,
  });
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (it: Item) => api.patch<Item>(`/items/${it.id}`, { marked: !it.marked }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['items', project?.id] }),
  });
  if (!project) return <Page title={key} back="/projects"><Empty>Loading…</Empty></Page>;

  const marked = items.filter((i) => i.marked);
  const type: ItemType = tab === 'bugs' ? 'bug' : 'backlog';
  const selecting = selectMode || marked.length > 0;

  return (
    <Page
      title={project.name}
      subtitle={project.key}
      back="/projects"
      actions={
        <>
          <Button small variant="ghost" onClick={() => setSheet('planner')} aria-label="Plan with Claude">💬 Plan</Button>
          {(tab === 'backlog' || tab === 'bugs') && <Button small variant="ghost" onClick={() => setSheet('item')} aria-label="New item">+</Button>}
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
          onChange={(t) => setParams({ tab: t }, { replace: true })}
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
    </Page>
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

function ItemList({ items, project, onToggle, selectMode, setSelectMode }: {
  items: Item[];
  project: ProjectSummary;
  onToggle: (it: Item) => void;
  selectMode: boolean;
  setSelectMode: (v: boolean) => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [f, setF] = useListFilter(project.key);
  const { data: facets } = useFacets(project.key);
  const active = f.tags.length + f.modules.length + f.importance.length;
  const shown = items.filter((i) => matches(i, f));
  const open = shown.filter((i) => OPEN.includes(i.status));
  const closed = shown.filter((i) => !OPEN.includes(i.status));
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
          Filter{active > 0 && <span className="ml-0.5 min-w-4 h-4 px-1 rounded-full bg-accent-strong text-white text-[10px] leading-4">{active}</span>}
        </Button>
        <Button small variant={selectMode ? 'primary' : 'secondary'} onClick={() => setSelectMode(!selectMode)}>{selectMode ? 'Done' : 'Select'}</Button>
      </div>
      {(active > 0 || f.q) && (
        <div className="px-4 pt-2 text-[12px] text-muted flex items-center gap-2">
          {shown.length} of {items.length} shown
          <button className="text-accent" onClick={() => setF({ ...NO_FILTER, wrap: f.wrap })}>Clear</button>
        </div>
      )}
      {!open.length && <Empty>{items.length ? 'Nothing matches.' : 'Nothing open. Tap + to add one.'}</Empty>}
      {groups.map((g) => (
        <Section key={g.title} title={`${g.title} · ${g.items.length}`}>
          <Card>{g.items.map((it) => row(it))}</Card>
        </Section>
      ))}
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

function ProjectSettings({ project }: { project: ProjectSummary }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['project', project.key] });
  const [f, setF] = useState({ name: project.name, description: project.description, importance: project.importance_scale.join(', '), effort: project.effort_scale.join(', ') });
  const save = useMutation({
    mutationFn: (patch: object) => api.patch(`/projects/${project.key}`, patch),
    onSuccess: refresh,
  });
  const [repo, setRepo] = useState({ full: '', default_branch: '', check_command: '' });
  const isPath = /^(\/|~\/|\.\.?\/)/.test(repo.full.trim());
  const [repoNote, setRepoNote] = useState<string | null>(null);
  const addRepo = useMutation({
    mutationFn: () => {
      if (isPath) {
        return api.post<{ note?: string | null }>(`/projects/${project.key}/repos`, { local_path: repo.full.trim(), default_branch: repo.default_branch || undefined, check_command: repo.check_command || null });
      }
      const [github_owner, github_name] = repo.full.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '').split('/');
      return api.post<{ note?: string | null }>(`/projects/${project.key}/repos`, { github_owner, github_name, default_branch: repo.default_branch || 'main', check_command: repo.check_command || null });
    },
    onSuccess: (r) => { setRepo({ full: '', default_branch: '', check_command: '' }); setRepoNote(r.note ?? null); refresh(); },
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
                  {r.local_path ? <><Chip className="mr-1.5">local</Chip>{r.local_path}</> : `${r.github_owner}/${r.github_name}`}
                </div>
                <div className="text-[12px] text-muted truncate">
                  base {r.default_branch}
                  {r.local_path && (r.worktree_from === 'clone' ? ' · separate clone' : ' · worktrees in the repo')}
                  {r.setup_command ? ` · setup: ${r.setup_command}` : ''}
                  {r.check_command ? ` · check: ${r.check_command}` : ''}
                </div>
              </div>
              <Button small variant="ghost" onClick={() => setEditing(r)}>Edit</Button>
            </div>
          ))}
          <form className="p-3 space-y-2" onSubmit={(e) => { e.preventDefault(); addRepo.mutate(); }}>
            <input className={inputCls} placeholder="owner/repo, or a local folder like ~/projects/x" value={repo.full} onChange={(e) => setRepo({ ...repo, full: e.target.value })} aria-label="Repository" />
            {isPath && <p className="text-[12px] text-muted">Local repo: agents push their branches into this folder, and you review and merge them here. No GitHub needed.</p>}
            <div className="grid grid-cols-2 gap-2">
              <input className={inputCls} placeholder={isPath ? 'base (auto)' : 'base branch (main)'} value={repo.default_branch} onChange={(e) => setRepo({ ...repo, default_branch: e.target.value })} aria-label="Base branch" />
              <input className={inputCls} placeholder="check cmd (optional)" value={repo.check_command} onChange={(e) => setRepo({ ...repo, check_command: e.target.value })} aria-label="Check command" />
            </div>
            <ErrorText error={addRepo.error} />
            {repoNote && <p className="text-[12px] text-wait">{repoNote}</p>}
            <Button className="w-full" disabled={!repo.full.includes('/') || addRepo.isPending}>Add repo</Button>
          </form>
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
      <ProjectAccounts project={project} onSaved={refresh} />
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

function RepoForm({ repo, onDone, onRemove }: { repo: Repo; onDone: () => void; onRemove: () => void }) {
  const [f, setF] = useState({
    default_branch: repo.default_branch,
    check_command: repo.check_command ?? '',
    setup_command: repo.setup_command ?? '',
    worktree_from: repo.worktree_from ?? 'repo',
  });
  const save = useMutation({
    mutationFn: () => api.patch(`/repos/${repo.id}`, {
      default_branch: f.default_branch,
      check_command: f.check_command.trim() || null,
      setup_command: f.setup_command.trim() || null,
      ...(repo.local_path ? { worktree_from: f.worktree_from } : {}),
    }),
    onSuccess: onDone,
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <p className="text-[13px] text-muted mb-3 break-all">{repo.local_path ?? `${repo.github_owner}/${repo.github_name}`}</p>
      <Field label="Base branch"><input className={inputCls} value={f.default_branch} onChange={(e) => setF({ ...f, default_branch: e.target.value })} /></Field>
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
