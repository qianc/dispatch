import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FINAL_STATUSES } from '../../../src/shared/types.ts';
import { api, type ProjectSummary, type Session } from '../api.ts';
import { canAct } from '../access.ts';
import { fetchSession } from '../pages/Session.tsx';
import { Transcript } from './transcript.tsx';
import { Button, Empty, ErrorText, Section } from './ui.tsx';

/**
 * The GitHub check on a project's PRs page (DISP-258): an agent reads GitHub's security, code
 * quality and failed-run findings, files items and proposes a batch to fix the ones you tick. Its
 * chat shows here, with the batch card, so you start a fix without leaving the page.
 */
export function GithubCheck({ project }: { project: ProjectSummary }) {
  const qc = useQueryClient();
  const key = ['github-check', project.key];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => api.get<{ session: Session | null }>(`/projects/${project.key}/github-check`) });
  const start = useMutation({
    mutationFn: () => api.post<Session>(`/projects/${project.key}/github-check`),
    onSuccess: (session) => qc.setQueryData(key, { session }),
  });
  const id = data?.session?.id;
  const { data: detail } = useQuery({ queryKey: ['session', id], queryFn: () => fetchSession(qc, id!), enabled: !!id });
  const s = detail?.session ?? data?.session;
  const open = !!s && !FINAL_STATUSES.includes(s.status) && s.status !== 'idle';
  return (
    <Section
      title="GitHub findings"
      intro="An agent reads the open security alerts, code quality findings and failed Actions runs of this project's repos, files an item for each one that matters, and offers a batch to fix the ones you tick."
      action={(
        <Button small disabled={start.isPending || open || project.disabled} onClick={() => start.mutate()}>
          {open ? 'Checking…' : s ? 'Check again' : 'Check GitHub'}
        </Button>
      )}
    >
      <div className="px-4"><ErrorText error={error ?? start.error} /></div>
      {s && (
        <>
          <p className="px-4 text-[12.5px] text-muted">
            <Link className="text-accent" to={`/s/${s.id}`}>Check #{s.id}</Link>
            {s.status === 'queued' ? ': waiting to start' : s.status === 'running' ? ': working' : s.status === 'failed' ? ': failed' : ''}
          </p>
          {detail
            ? <Transcript session={detail.session} events={detail.events} inputs={detail.inputs} project={detail.project} readOnly={!canAct(detail.access, 'drive')} partial={!!detail.earlier} />
            : <Empty>Loading…</Empty>}
        </>
      )}
    </Section>
  );
}
