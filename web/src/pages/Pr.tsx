import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type PrDetail, type Session } from '../api.ts';
import { Page } from '../components/Layout.tsx';
import { Button, Chip, Empty, ErrorText, Md, Section, Segmented, cx } from '../components/ui.tsx';

function Patch({ patch }: { patch: string }) {
  return (
    <pre className="text-[11.5px] leading-[1.45] font-mono overflow-x-auto bg-bg">
      {patch.split('\n').map((line, i) => (
        <div
          key={i}
          className={cx(
            'px-2 whitespace-pre',
            line.startsWith('+') && 'bg-ok/10 text-ok',
            line.startsWith('-') && 'bg-bad/10 text-bad',
            line.startsWith('@@') && 'text-accent bg-accent/5',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

type MergeResult = { ok: true } | { ok: false; conflict: boolean; output: string };

/** Times the owner's hands were needed, in words. */
const HANDS = { asked_update: 'Agent asked to update the branch', resolve_conflicts: 'Session sent to resolve conflicts', manual_merge: 'Merged by hand after auto-merge stopped' } as const;

export function PrView() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [how, setHow] = useState<'github' | 'local'>('github');
  const [method, setMethod] = useState<'squash' | 'merge' | 'rebase'>('squash');
  const { data, error, refetch, isFetching } = useQuery({ queryKey: ['pr', id], queryFn: () => api.get<PrDetail>(`/prs/${id}`) });
  const merge = useMutation({
    mutationFn: () => api.post<MergeResult>(`/prs/${id}/merge`, { how: data?.pr.local ? 'local' : how, method }),
    onSuccess: () => {
      refetch();
      qc.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
  const resolve = useMutation({ mutationFn: () => api.post<Session>(`/prs/${id}/resolve-conflicts`), onSuccess: (s) => nav(`/s/${s.id}`) });
  const toGithub = useMutation({ mutationFn: () => api.post<{ id: number }>(`/prs/${id}/github-pr`), onSuccess: (p) => nav(`/pr/${p.id}`, { replace: true }) });
  if (error) return <Page title="Pull request" back><ErrorText error={error} /></Page>;
  if (!data) return <Page title="Pull request" back><Empty>Loading…</Empty></Page>;
  const { pr } = data;
  const add = data.files.reduce((n, f) => n + f.additions, 0);
  const del = data.files.reduce((n, f) => n + f.deletions, 0);
  const result = merge.data;
  const conflict = pr.mergeable === false || (result && !result.ok && result.conflict);

  return (
    <Page title={pr.title} subtitle={pr.local ? `local branch ${pr.head_ref} → ${data.base_ref}` : `${pr.repo_full_name}#${pr.number} · ${pr.head_ref} → ${data.base_ref}`} back actions={<Button small variant="ghost" onClick={() => refetch()} disabled={isFetching}>↻</Button>}>
      <div className="px-4 pt-3 flex flex-wrap items-center gap-1.5">
        <Chip tone={pr.state === 'merged' ? 'accent' : pr.state === 'open' ? 'ok' : 'neutral'}>{pr.state}</Chip>
        {pr.state === 'open' && pr.mergeable_state && <Chip tone={pr.mergeable ? 'ok' : 'wait'}>{pr.mergeable_state}</Chip>}
        <Chip><span className="text-ok">+{add}</span> <span className="text-bad">−{del}</span></Chip>
        {!pr.local && <a href={pr.url} target="_blank" rel="noreferrer" className="text-[13px] text-accent ml-auto">Open on GitHub ↗</a>}
      </div>

      {data.checks.length > 0 && (
        <div className="px-4 mt-3 space-y-1">
          {data.checks.map((c) => (
            <div key={c.name} className="flex items-center gap-2 text-[13px]">
              <span className={cx('size-2 rounded-full', c.conclusion === 'success' ? 'bg-ok' : c.conclusion === 'failure' ? 'bg-bad' : c.status !== 'completed' ? 'bg-wait animate-pulse' : 'bg-faint')} />
              <span className="flex-1 truncate">{c.name}</span>
              <span className="text-muted">{c.conclusion ?? c.status}</span>
            </div>
          ))}
        </div>
      )}

      {pr.state === 'open' && (
        <div className="mx-3 mt-4 rounded-xl border border-line bg-panel p-3 space-y-2">
          {!pr.local && <Segmented value={how} onChange={setHow} options={[{ value: 'github', label: 'Merge on GitHub' }, { value: 'local', label: 'Merge locally + push' }]} />}
          {how === 'github' && !pr.local && (
            <Segmented value={method} onChange={setMethod} options={[{ value: 'squash', label: 'Squash' }, { value: 'merge', label: 'Merge commit' }, { value: 'rebase', label: 'Rebase' }]} />
          )}
          {data.repo.kind === 'hosted' && pr.local ? (
            <p className="text-[12px] text-muted">
              Dispatch merges the branch into {data.base_ref} in its own repo
              {data.repo.check_command ? `, after the session's worker runs the check (${data.repo.check_command})` : ''}
              {data.repo.upstream ? `, then pushes ${data.base_ref} to ${data.repo.upstream} on GitHub` : ''}.
            </p>
          ) : (how === 'local' || pr.local) && <p className="text-[12px] text-muted">The worker merges the branch into {data.base_ref}, runs the repo's check command if set, and pushes it{pr.local ? ' into your local repo (your working tree must be clean)' : ''}.</p>}
          <Button variant="primary" className="w-full" disabled={merge.isPending} onClick={() => confirm(`Merge ${pr.local ? pr.head_ref : `#${pr.number}`} into ${data.base_ref}?`) && merge.mutate()}>
            {merge.isPending ? 'Merging…' : 'Merge'}
          </Button>
          {data.repo.kind === 'hosted' && pr.local && data.repo.upstream && (
            <Button className="w-full" disabled={toGithub.isPending} onClick={() => confirm(`Push ${pr.head_ref} to ${data.repo.upstream} and review it there as a pull request?`) && toGithub.mutate()}>
              {toGithub.isPending ? 'Opening the PR…' : 'Open a PR on GitHub instead'}
            </Button>
          )}
          {result && !result.ok && <pre className="text-[12px] text-bad whitespace-pre-wrap max-h-40 overflow-y-auto">{result.output}</pre>}
          {conflict && <Button className="w-full" disabled={resolve.isPending} onClick={() => resolve.mutate()}>Start a session to resolve conflicts</Button>}
          <ErrorText error={merge.error ?? resolve.error ?? toGithub.error} />
        </div>
      )}

      {(pr.behind_at_merge !== null || data.hands.length > 0) && (
        <Section title="Staying in sync">
          <div className="px-4 text-[13px] text-muted space-y-0.5">
            {pr.behind_at_merge !== null && <p>Behind {data.base_ref} at merge: {pr.behind_at_merge} commit{pr.behind_at_merge === 1 ? '' : 's'}</p>}
            {data.hands.map((h) => (
              <p key={h.id}>{HANDS[h.kind]}{h.detail ? ` (${h.detail})` : ''} · {new Date(h.created_at).toLocaleString()}</p>
            ))}
          </div>
        </Section>
      )}
      {data.body && <Section title="Description"><div className="px-4"><Md className="text-[14px]">{data.body}</Md></div></Section>}

      <Section title={`Files · ${data.files.length}`}>
        <div className="border-y border-line">
          {data.files.map((f) => {
            const isOpen = open.has(f.filename);
            return (
              <div key={f.filename} className="border-b border-line last:border-b-0">
                <button
                  onClick={() => { const n = new Set(open); if (isOpen) n.delete(f.filename); else n.add(f.filename); setOpen(n); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] active:bg-raised"
                  aria-expanded={isOpen}
                >
                  <span className="text-faint w-3">{isOpen ? '▾' : '▸'}</span>
                  <span className="flex-1 min-w-0 truncate font-mono text-[12px]" dir="rtl">{f.filename}</span>
                  <span className="text-ok">+{f.additions}</span>
                  <span className="text-bad">−{f.deletions}</span>
                </button>
                {isOpen && (f.patch ? <Patch patch={f.patch} /> : <p className="px-3 pb-2 text-[12px] text-muted">No text diff (binary or too large).</p>)}
              </div>
            );
          })}
        </div>
      </Section>
    </Page>
  );
}
