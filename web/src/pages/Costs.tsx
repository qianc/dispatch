// Cost and time (DISP-16): what the sessions cost and how long their agents worked. For one project:
// per item, per item type and per tag. For all projects: per project.
import type { ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { AllCosts, CostTotals, ProjectCosts } from '../../../src/shared/types.ts';
import { api } from '../api.ts';
import { countOf, perItem, runTime, usd } from '../cost.ts';
import { Page } from '../components/Layout.tsx';
import { ProjectBadge } from '../components/ProjectBadge.tsx';
import { Card, Empty, ErrorText, Section, Segmented } from '../components/ui.tsx';

type Sort = 'cost' | 'time';
type By = 'items' | 'type' | 'tag';

const TYPE_NAMES: Record<string, string> = { backlog: 'Backlog items', bug: 'Bugs' };

/** The period, the grouping and the order, kept in the address so Back returns to the same view. */
function useView() {
  const [params, setParams] = useSearchParams();
  const set = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  };
  const days = ['30', '90'].includes(params.get('days') ?? '') ? params.get('days')! : '';
  return {
    days,
    query: days ? `?days=${days}` : '',
    sort: (params.get('sort') === 'time' ? 'time' : 'cost') as Sort,
    by: (['type', 'tag'].includes(params.get('by') ?? '') ? params.get('by') : 'items') as By,
    set,
  };
}

const measure = (t: CostTotals, sort: Sort) => (sort === 'time' ? t.duration_ms : t.cost_usd);
const sorted = <T extends CostTotals>(rows: T[], sort: Sort) => [...rows].sort((a, b) => measure(b, sort) - measure(a, sort));

function Controls({ view, groups }: { view: ReturnType<typeof useView>; groups?: boolean }) {
  return (
    <div className="px-3 pt-3 flex flex-col gap-2 lg:flex-row lg:items-center">
      <div className="lg:w-72" role="group" aria-label="Period">
        <Segmented value={view.days} onChange={(v) => view.set('days', v)} options={[{ value: '', label: 'All time' }, { value: '90', label: '90 days' }, { value: '30', label: '30 days' }]} />
      </div>
      {groups && (
        <div className="lg:w-72" role="group" aria-label="Group by">
          <Segmented<By> value={view.by} onChange={(v) => view.set('by', v === 'items' ? '' : v)} options={[{ value: 'items', label: 'Items' }, { value: 'type', label: 'Type' }, { value: 'tag', label: 'Tag' }]} />
        </div>
      )}
      <div className="lg:w-56 lg:ml-auto" role="group" aria-label="Order by">
        <Segmented<Sort> value={view.sort} onChange={(v) => view.set('sort', v === 'cost' ? '' : v)} options={[{ value: 'cost', label: 'By cost' }, { value: 'time', label: 'By time' }]} />
      </div>
    </div>
  );
}

function Total({ t }: { t: CostTotals }) {
  return (
    <Card className="mt-3 px-4 py-3">
      <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">Total</div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 text-[22px] font-semibold tabular-nums" aria-label="Total cost and run time">
        <span>{usd(t.cost_usd)}</span>
        <span className="text-muted">{runTime(t.duration_ms)}</span>
      </div>
      <div className="text-[13px] text-muted">{countOf(t.sessions, 'session')} · {countOf(t.items, 'item')}</div>
    </Card>
  );
}

/** One line of a list: its cost and run time, a bar for its share of the largest line, and a line of detail. */
function Row({ name, lead, to, t, max, sort, detail }: { name: ReactNode; lead?: ReactNode; to?: string; t: CostTotals; max: number; sort: Sort; detail: ReactNode }) {
  const share = max > 0 ? measure(t, sort) / max : 0;
  const body = (
    <>
      {lead}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-3">
          <span className="flex-1 min-w-0 truncate font-medium">{name}</span>
          <span className="shrink-0 text-[14px] tabular-nums">{usd(t.cost_usd)} · {runTime(t.duration_ms)}</span>
        </div>
        <div className="mt-1.5 h-1.5 rounded-full bg-raised overflow-hidden">
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
        <div className="mt-1 text-[13px] text-muted">{detail}</div>
      </div>
    </>
  );
  const cls = 'flex items-center gap-3 px-3 py-2.5';
  return (
    <div role="listitem" className="border-b border-line last:border-b-0">
      {to ? <Link to={to} className={`${cls} active:bg-raised hover:bg-raised`}>{body}</Link> : <div className={cls}>{body}</div>}
    </div>
  );
}

const dot = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' · ');

export function ProjectCostsPage() {
  const { key = '' } = useParams();
  const view = useView();
  const { data, error } = useQuery({ queryKey: ['costs', key, view.days], queryFn: () => api.get<ProjectCosts>(`/projects/${key}/costs${view.query}`) });
  const groups = data ? sorted(view.by === 'type' ? data.by_type : data.by_tag, view.sort) : [];
  const items = data ? sorted(data.items, view.sort) : [];
  const shown: CostTotals[] = data ? [...(view.by === 'items' ? items : groups), data.unlinked] : [];
  const max = Math.max(0, ...shown.map((t) => measure(t, view.sort)));
  return (
    <Page
      title="Cost and time"
      subtitle={key.toUpperCase()}
      back={`/p/${key}?tab=sessions`}
      wide
      actions={<Link to={`/costs${view.query}`} className="px-2 text-[14px] font-medium text-accent">All projects</Link>}
    >
      <Controls view={view} groups />
      <ErrorText error={error} />
      {data && <Total t={data.total} />}
      {data && !data.total.sessions && <Empty>No sessions in this period.</Empty>}
      {data && data.total.sessions > 0 && (
        <Section
          title={view.by === 'items' ? 'Items' : view.by === 'type' ? 'Item types' : 'Tags'}
          intro={
            view.by === 'tag'
              ? 'An item with several tags counts in full under each of them, so the tags can add up to more than the total.'
              : 'A session that covers several items gives each item an equal share of its cost and time.'
          }
        >
          <Card>
            <div role="list">
            {view.by === 'items' && items.map((i) => (
              <Row
                key={i.id}
                to={`/items/${i.id}`}
                name={<><span className="text-muted font-normal mr-1.5">{i.key}</span>{i.title}</>}
                t={i}
                max={max}
                sort={view.sort}
                detail={dot([i.type === 'bug' ? 'Bug' : 'Backlog', i.labels.join(', '), countOf(i.sessions, 'session')])}
              />
            ))}
            {view.by !== 'items' && groups.map((g) => (
              <Row
                key={g.name ?? ''}
                name={g.name === null ? 'No tag' : view.by === 'type' ? TYPE_NAMES[g.name] ?? g.name : g.name}
                t={g}
                max={max}
                sort={view.sort}
                detail={dot([countOf(g.items, 'item'), countOf(g.sessions, 'session'), perItem(g)])}
              />
            ))}
            {data.unlinked.sessions > 0 && (
              <Row name="Not tied to an item" t={data.unlinked} max={max} sort={view.sort} detail={dot([countOf(data.unlinked.sessions, 'session'), 'planning and other chats with no item'])} />
            )}
            </div>
          </Card>
        </Section>
      )}
    </Page>
  );
}

export function Costs() {
  const view = useView();
  const { data, error } = useQuery({ queryKey: ['costs', 'all', view.days], queryFn: () => api.get<AllCosts>(`/costs${view.query}`) });
  const projects = data ? sorted(data.projects, view.sort) : [];
  const max = data ? Math.max(0, ...[...projects, data.unlinked].map((t) => measure(t, view.sort))) : 0;
  const carry = new URLSearchParams({ ...(view.days ? { days: view.days } : {}), ...(view.sort === 'time' ? { sort: 'time' } : {}) }).toString();
  return (
    <Page title="Cost and time" subtitle="All projects" back="/projects" wide>
      <Controls view={view} />
      <ErrorText error={error} />
      {data && <Total t={data.total} />}
      {data && !data.total.sessions && <Empty>No sessions in this period.</Empty>}
      {data && data.total.sessions > 0 && (
        <Section title="Projects" intro="Each project's total is all of its sessions. Open a project to see its items, item types and tags.">
          <Card>
            <div role="list">
            {projects.map((p) => (
              <Row
                key={p.id}
                to={`/p/${p.key}/costs${carry ? `?${carry}` : ''}`}
                lead={<ProjectBadge project={p} size={32} />}
                name={p.name}
                t={p}
                max={max}
                sort={view.sort}
                detail={dot([p.key, countOf(p.sessions, 'session'), countOf(p.items, 'item')])}
              />
            ))}
            {data.unlinked.sessions > 0 && (
              <Row name="Not tied to a project" t={data.unlinked} max={max} sort={view.sort} detail={dot([countOf(data.unlinked.sessions, 'session'), 'Assistant chats and orchestrators'])} />
            )}
            </div>
          </Card>
        </Section>
      )}
    </Page>
  );
}
