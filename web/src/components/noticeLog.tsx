import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { NoticeLogEntry } from '../../../src/shared/types.ts';
import { api } from '../api.ts';
import { Card, ErrorText, Section, inputCls } from './ui.tsx';

/** The notice log (DISP-267). `id`: a session's notices; an orchestration's include its batches'. */
function useNotices(id?: number) {
  return useQuery({
    queryKey: ['notices', id ?? null],
    queryFn: () => api.get<NoticeLogEntry[]>(`/notices${id ? `?orchestration_id=${id}` : ''}`),
  });
}

const OUTCOME: Record<NoticeLogEntry['outcome'], string> = { pushed: 'Pushed', app_only: 'Open app only', held: 'Held back' };

function outcomeText(n: NoticeLogEntry) {
  const devices = n.devices.length ? ` · ${n.devices.map((d) => `${d.service}: ${d.result}`).join(', ')}` : '';
  return `${OUTCOME[n.outcome]}${n.reason ? `: ${n.reason}` : ''}${devices}${n.replaced_by ? ` · replaced by a newer one` : ''}`;
}

/** Settings: every notice sent or held back in the last 30 days, with where it came from and what happened. */
export function NoticeLogSection() {
  const [params] = useSearchParams();
  const [filter, setFilter] = useState(params.get('notices') ?? '');
  const id = Number(filter.replace('#', '')) || undefined;
  const { data, error } = useNotices(id);
  return (
    <Section title="Recent notices" id="notices" intro="Every notice of the last 30 days: pushed, shown in the open app only, or held back, with the code that sent it.">
      <Card className="p-3 space-y-2">
        <input className={inputCls} inputMode="numeric" placeholder="Session or orchestration #" aria-label="Filter by session or orchestration" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <ErrorText error={error} />
        {data && !data.length && <p className="text-sm text-muted">No notices.</p>}
        <ul className="space-y-2 max-h-[28rem] overflow-y-auto">
          {data?.map((n) => (
            <li key={n.id} className="text-[13px] border-b border-line last:border-0 pb-2" data-outcome={n.outcome}>
              <div className="flex gap-2 justify-between">
                <Link to={n.url} className="font-medium min-w-0 truncate">{n.title}</Link>
                <span className="text-faint shrink-0">{new Date(n.created_at).toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              {n.body && <div className="text-muted line-clamp-2 whitespace-pre-wrap">{n.body}</div>}
              <div className={n.outcome === 'held' ? 'text-wait' : 'text-faint'}>{outcomeText(n)}</div>
              <div className="text-faint font-mono text-[11px]">{n.source}{n.session_id ? ` · #${n.session_id}` : ''}</div>
            </li>
          ))}
        </ul>
      </Card>
    </Section>
  );
}

/** A session's (or orchestration's, with its batches') notices, as a line of its details. */
export function NoticeCount({ sessionId }: { sessionId: number }) {
  const { data } = useNotices(sessionId);
  if (!data?.length) return null;
  const held = data.filter((n) => n.outcome === 'held').length;
  return (
    <>
      <dt className="text-muted">Notices</dt>
      <dd><Link className="text-accent" to={`/settings?notices=${sessionId}#notices`}>{data.length - held} sent{held ? `, ${held} held back` : ''}</Link></dd>
    </>
  );
}
