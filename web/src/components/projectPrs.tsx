import { useEffect } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectPr, ProjectPrList } from '../../../src/shared/types.ts';
import { api, type ProjectSummary } from '../api.ts';
import { approvalView, ciLook, linkLabels } from '../prs.ts';
import { Button, Card, Chip, Empty, ErrorText, Section, cx, timeAgo } from './ui.tsx';

/** The server syncs a list older than this when it is read. */
const LIST_FRESH_MS = 60_000;

/** The open pull requests of a project's GitHub repos, with or without a session (DISP-111). */
export function useProjectPrs(key: string, enabled = true) {
  return useQuery({ queryKey: ['project-prs', key], queryFn: () => api.get<ProjectPrList>(`/projects/${key}/prs`), enabled });
}

function PrRow({ pr, showRepo }: { pr: ProjectPr; showRepo: boolean }) {
  const ci = ciLook(pr.ci_state);
  const approved = approvalView(pr);
  const about = [
    `${showRepo ? pr.repo_full_name.split('/')[1] : ''}#${pr.number}`,
    pr.author,
    pr.changed_files === null ? null : `${pr.changed_files} file${pr.changed_files === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ');
  return (
    <Link to={`/pr/${pr.id}`} className="block min-w-0 px-3 py-2.5 border-b border-line last:border-b-0 active:bg-raised">
      <div className="flex items-start gap-2">
        <span className="flex-1 min-w-0 font-medium line-clamp-2 break-words">{pr.title}</span>
        {ci && <span role="img" aria-label={ci.label} title={ci.label} className={cx('mt-2 size-2 rounded-full shrink-0', ci.cls)} />}
      </div>
      <div className="mt-0.5 text-[12px] text-muted truncate">{about}</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {linkLabels(pr).map((l) => <Chip key={l} tone={pr.linked?.item_keys.length ? 'accent' : 'neutral'}>{l}</Chip>)}
        {pr.draft && <Chip>Draft</Chip>}
        {approved && <Chip tone={approved.current ? 'ok' : 'wait'}>{approved.chip}</Chip>}
      </div>
    </Link>
  );
}

export function ProjectPrs({ project }: { project: ProjectSummary }) {
  const qc = useQueryClient();
  const { data, error, refetch } = useProjectPrs(project.key);
  const sync = useMutation({
    mutationFn: () => api.post<ProjectPrList>(`/projects/${project.key}/prs/sync`),
    onSuccess: (fresh) => qc.setQueryData(['project-prs', project.key], fresh),
  });
  // the server syncs an old list when it is read: read it again for the result (a PR that changed also arrives as an event)
  const old = !project.disabled && !!data && data.github_repos > 0 && (!data.synced_at || Date.now() - Date.parse(data.synced_at) > LIST_FRESH_MS);
  useEffect(() => {
    if (!old) return;
    const t = setInterval(() => refetch(), 5000);
    return () => clearInterval(t);
  }, [old, refetch]);

  if (!data) return error ? <div className="px-4"><ErrorText error={error} /></div> : <Empty>Loading…</Empty>;
  if (!data.github_repos) return <Empty>This project has no GitHub repo.</Empty>;
  const synced = !data.synced_at ? 'not synced yet' : timeAgo(data.synced_at) === 'now' ? 'synced just now' : `synced ${timeAgo(data.synced_at)} ago`;
  return (
    <Section
      title="Open pull requests"
      action={(
        <span className="flex items-center gap-1 text-[12px] text-muted">
          {sync.isPending ? 'syncing…' : synced}
          <Button small variant="ghost" aria-label="Refresh pull requests" disabled={sync.isPending || project.disabled} onClick={() => sync.mutate()}>↻</Button>
        </span>
      )}
    >
      {(data.error || sync.error) && (
        <div className="px-4">
          {data.error && <p className="text-bad text-sm my-2 break-words">GitHub did not answer for every repo: {data.error}</p>}
          <ErrorText error={sync.error} />
        </div>
      )}
      {data.prs.length
        ? <Card className="overflow-hidden">{data.prs.map((pr) => <PrRow key={pr.id} pr={pr} showRepo={data.github_repos > 1} />)}</Card>
        : <Empty>No open pull requests.</Empty>}
    </Section>
  );
}
