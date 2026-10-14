import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type Inbox as InboxData } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { SessionRow } from '../components/items.tsx';
import { Card, Chip, Empty, Section, timeAgo } from '../components/ui.tsx';

export function Inbox() {
  const { data } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<InboxData>('/inbox') });
  const { data: worker } = useQuery({ queryKey: ['worker'], queryFn: () => api.get<{ connected: boolean }>('/worker'), refetchInterval: 15_000 });
  if (!data) return <Page title="Inbox"><Empty>Loading…</Empty></Page>;
  const sessionById = new Map(data.sessions.map((s) => [s.id, s]));
  const nothing = !data.inputs.length && !data.idle.length && !data.prs.length;
  return (
    <Page title="Inbox" subtitle="Everything waiting on you">
      {worker && !worker.connected && (
        <div className="m-3 rounded-lg border border-bad/30 bg-bad/10 text-bad text-sm px-3 py-2">The worker is not connected. Sessions will start when it is back.</div>
      )}
      {nothing && <Empty>Nothing needs you right now.</Empty>}
      {data.inputs.length > 0 && (
        <Section title="Questions & approvals">
          <Card>
            {data.inputs.map((i) => {
              const s = sessionById.get(i.session_id);
              const text = i.payload.kind === 'plan_approval' ? 'Plan ready for approval' : i.payload.questions.map((q) => q.question).join(' · ');
              return (
                <Link key={i.id} to={`/s/${i.session_id}`} className="block px-3 py-2.5 border-b border-line last:border-b-0 active:bg-raised">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-accent">{s?.project_key}</span>
                    <span className="flex-1 min-w-0 truncate font-medium">{s?.title}</span>
                    <Chip tone="wait">{i.payload.kind === 'plan_approval' ? 'Plan' : 'Question'}</Chip>
                  </div>
                  <div className="flex gap-2 text-[13px] text-muted mt-0.5">
                    <span className="flex-1 min-w-0 line-clamp-2">{text}</span>
                    <span className="text-faint text-[12px]">{timeAgo(i.created_at)}</span>
                  </div>
                </Link>
              );
            })}
          </Card>
        </Section>
      )}
      {data.idle.length > 0 && (
        <Section title="Your turn">
          <Card>{data.idle.map((s) => <SessionRow key={s.id} s={s} showProject />)}</Card>
        </Section>
      )}
      {data.prs.length > 0 && (
        <Section title="Pull requests to review">
          <Card>
            {data.prs.map((pr) => (
              <Link key={pr.id} to={`/pr/${pr.id}`} className="flex items-center gap-2 px-3 py-2.5 border-b border-line last:border-b-0 active:bg-raised">
                <span className="text-[12px] text-faint shrink-0">{pr.repo_full_name.split('/')[1]}#{pr.number}</span>
                <span className="flex-1 min-w-0 truncate">{pr.title}</span>
                {pr.mergeable === false && <Chip tone="bad">Conflict</Chip>}
              </Link>
            ))}
          </Card>
        </Section>
      )}
    </Page>
  );
}
