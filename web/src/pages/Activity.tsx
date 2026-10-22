import { useQuery } from '@tanstack/react-query';
import { api, type Inbox, type Session } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { SessionRow } from '../components/items.tsx';
import { Card, Empty, Section } from '../components/ui.tsx';

export function Activity() {
  const { data: live = [] } = useQuery({ queryKey: ['sessions', 'live'], queryFn: () => api.get<Session[]>('/sessions?status=queued,running,waiting_input,idle') });
  // same query as the menu: an idle session's attention says whether Dispatch checks or merges it
  const { data: inbox } = useQuery({ queryKey: ['inbox'], queryFn: () => api.get<Inbox>('/inbox') });
  const attention = new Map((inbox?.idle ?? []).map((s) => [s.id, s.attention]));
  const { data: recent = [] } = useQuery({ queryKey: ['sessions', 'recent'], queryFn: () => api.get<Session[]>('/sessions?status=completed,failed,stopped') });
  return (
    <Page title="Activity" subtitle="Agent sessions across all projects" wide>
      <div className="lg:grid lg:grid-cols-2 lg:items-start">
      <Section title={`Live (${live.length})`}>
        {live.length ? <Card>{live.map((s) => <SessionRow key={s.id} s={s} showProject attention={attention.get(s.id)} />)}</Card> : <Empty>No sessions running.</Empty>}
      </Section>
      {recent.length > 0 && (
        <Section title="Recently finished">
          <Card>{recent.slice(0, 30).map((s) => <SessionRow key={s.id} s={s} showProject />)}</Card>
        </Section>
      )}
      </div>
    </Page>
  );
}
