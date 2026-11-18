// Settings → Updates (DISP-112): which version of Dispatch runs, what is new on its release branch,
// and the update of the server and its workers. Only the install owner sees it.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateInfo, UpdateRow, UpdateSettings, UpdateWorker } from '../../../src/shared/types.ts';
import { api } from '../api.ts';
import { Button, Card, Chip, ErrorText, Section, Segmented, timeAgo } from './ui.tsx';

type Tone = Parameters<typeof Chip>[0]['tone'];

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : 'unknown');
const ago = (iso: string) => (timeAgo(iso) === 'now' ? 'just now' : `${timeAgo(iso)} ago`);

/** The line under the running version: how far behind the release branch the server is. */
export function behindLine(info: UpdateInfo): { text: string; tone: Tone } {
  const { state: st, version, branch } = info;
  if (!info.repo) return { text: 'Dispatch does not know its own repo. Set UPDATE_REPO on the server.', tone: 'wait' };
  if (!st.checked_at) return { text: 'Not checked yet.', tone: 'neutral' };
  if (!version.sha) return { text: 'The server does not know which commit it runs. Set DISPATCH_VERSION on the server.', tone: 'wait' };
  if (st.for_sha !== version.sha) return { text: 'Not checked since the server started.', tone: 'neutral' };
  if (!st.on_branch) return { text: `The server's commit is not on ${branch}. It is not updated.`, tone: 'wait' };
  if (st.behind_by) return { text: `${st.behind_by} commit${st.behind_by === 1 ? '' : 's'} behind ${branch}`, tone: 'accent' };
  return { text: `Up to date with ${branch}`, tone: 'ok' };
}

const WORKER_LOOK: Record<UpdateWorker['status'], { label: string; tone: Tone }> = {
  current: { label: 'Up to date', tone: 'ok' },
  behind: { label: 'Behind', tone: 'wait' },
  updating: { label: 'Updating', tone: 'run' },
  failed: { label: 'Update failed', tone: 'bad' },
  newer: { label: 'Newer than the server', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

const RUN_LOOK: Record<UpdateRow['state'], { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'run' },
  ok: { label: 'Updated', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  rolled_back: { label: 'Rolled back', tone: 'bad' },
};

const MODE_TEXT: Record<UpdateInfo['mode'], string> = {
  self: 'The server updates itself.',
  worker: "A worker's command updates the server.",
  none: 'The server cannot be updated from here.',
};

export function UpdatesSection() {
  const qc = useQueryClient();
  const { data: info, error } = useQuery({ queryKey: ['update'], queryFn: () => api.get<UpdateInfo>('/update') });
  const done = (d: UpdateInfo) => qc.setQueryData(['update'], d);
  const check = useMutation({ mutationFn: () => api.post<UpdateInfo>('/update/check'), onSuccess: done });
  const save = useMutation({ mutationFn: (s: Partial<UpdateSettings>) => api.put<UpdateInfo>('/update/settings', s), onSuccess: done });
  const start = useMutation({ mutationFn: () => api.post<UpdateInfo>('/update/start'), onSuccess: done });
  const cancel = useMutation({ mutationFn: () => api.post<UpdateInfo>('/update/cancel'), onSuccess: done });
  const failed = check.error ?? save.error ?? start.error ?? cancel.error ?? error;
  if (!info) return <Section title="Updates"><Card className="p-3 text-sm text-muted">{error ? <ErrorText error={error} /> : 'Loading…'}</Card></Section>;

  const { state: st, version, target, rollout } = info;
  const behind = behindLine(info);
  const running = info.log.some((r) => r.state === 'running');
  // also with no newer version: a worker that is behind the server, or whose update failed
  const workersBehind = info.workers.some((w) => w.connected && w.updatable && (w.status === 'behind' || w.status === 'failed'));
  const canStart = !rollout && (!!target || workersBehind);
  const targetName = target ? target.tag ?? short(target.sha) : null;
  return (
    <Section
      title="Updates"
      action={<Button small variant="ghost" disabled={check.isPending || !info.repo} onClick={() => check.mutate()}>{check.isPending ? 'Checking…' : 'Check now'}</Button>}
    >
      <Card>
        <div className="px-3 py-2.5 border-b border-line">
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 text-[14px]">
              Dispatch runs <code>{short(version.sha)}</code>{version.tag && <span className="text-muted"> ({version.tag})</span>}
            </div>
            <Chip tone={behind.tone}>{behind.tone === 'ok' ? 'Up to date' : behind.tone === 'accent' ? 'Update available' : 'Not known'}</Chip>
          </div>
          <div className="text-[12px] text-muted mt-0.5">
            {behind.text}
            {st.checked_at && ` · checked ${ago(st.checked_at)}`}
            {info.repo && ` · ${info.repo}`}
          </div>
          {st.commit && (
            <div className="text-[12px] text-muted">
              Newest commit <code>{short(st.commit.sha)}</code>
              {st.tag && <> · newest version {st.tag.name} (<code>{short(st.tag.sha)}</code>)</>}
            </div>
          )}
          {st.error && <p className="text-[12px] text-bad mt-1">The last check failed: {st.error}</p>}
          {st.commits.length > 0 && (
            <details className="mt-1.5">
              <summary className="text-[13px] text-accent cursor-pointer">What is new</summary>
              <ul className="mt-1 space-y-0.5">
                {st.commits.map((c) => (
                  <li key={c.sha} className="text-[12.5px] flex gap-2"><code className="text-faint shrink-0">{short(c.sha)}</code><span className="min-w-0 break-words">{c.subject}</span></li>
                ))}
                {st.behind_by !== null && st.behind_by > st.commits.length && <li className="text-[12px] text-faint">and {st.behind_by - st.commits.length} more</li>}
              </ul>
            </details>
          )}
        </div>

        <div className="px-3 py-2.5 border-b border-line space-y-2.5">
          <label className="flex items-start gap-2.5 text-[14px]">
            <input type="checkbox" className="size-4 mt-0.5 accent-[var(--color-accent-strong)]" checked={info.settings.auto} disabled={save.isPending}
              onChange={(e) => save.mutate({ auto: e.target.checked })} />
            <span>
              <span className="font-medium">Update automatically</span>
              <span className="block text-[12px] text-muted">The server first, then one worker at a time. Each waits until no session works on it.</span>
            </span>
          </label>
          <div>
            <div className="text-[12px] text-muted mb-1">Update to</div>
            <Segmented<UpdateSettings['follow']>
              value={info.settings.follow}
              options={[{ value: 'commits', label: 'Every commit' }, { value: 'tags', label: 'Version tags only' }]}
              onChange={(follow) => save.mutate({ follow })}
            />
          </div>
          <p className={`text-[12px] ${info.mode === 'none' ? 'text-wait' : 'text-muted'}`}>{MODE_TEXT[info.mode]}{info.mode_why && ` ${info.mode_why}`}</p>
          {rollout ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 text-[13px]">Updating to <code>{rollout.tag ?? short(rollout.sha)}</code>, started by {rollout.by}.</div>
              <Button small disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel</Button>
            </div>
          ) : (
            <Button variant={canStart ? 'primary' : 'secondary'} className="w-full" disabled={!canStart || running || start.isPending} onClick={() => start.mutate()}>
              {targetName ? `Update now to ${targetName}` : workersBehind ? 'Update the workers now' : 'Update now'}
            </Button>
          )}
          {info.waiting.map((w) => <p key={w} className="text-[13px] text-wait">{w}</p>)}
          <ErrorText error={failed} />
        </div>

        {info.workers.length > 0 && (
          <div className="border-b border-line">
            {info.workers.map((w) => {
              const look = WORKER_LOOK[w.status];
              return (
                <div key={w.id} className="flex items-center gap-2 px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] truncate">Worker {w.name}<span className="text-muted"> · <code>{short(w.sha)}</code>{!w.connected && ' · offline'}</span></div>
                    {!w.updatable && w.why && <div className="text-[12px] text-muted">Cannot update itself. {w.why}</div>}
                  </div>
                  <Chip tone={look.tone}>{look.label}</Chip>
                </div>
              );
            })}
          </div>
        )}

        <div className="px-3 py-2.5">
          <div className="text-[12px] font-medium text-muted mb-1">Update log</div>
          {info.log.length === 0 && <p className="text-[13px] text-muted">No update yet.</p>}
          {info.log.map((r) => <LogRow key={r.id} row={r} />)}
        </div>
      </Card>
    </Section>
  );
}

function LogRow({ row: r }: { row: UpdateRow }) {
  const look = RUN_LOOK[r.state];
  const head = (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0 text-[13px]">
        <span className="font-medium">{r.target === 'server' ? 'Server' : `Worker ${r.worker_name ?? r.worker_id}`}</span>
        {' '}<code>{short(r.from_sha)}</code> → <code>{short(r.to_sha)}</code>{r.to_tag && ` (${r.to_tag})`}
        <span className="text-muted"> · {r.triggered_by === 'auto' ? 'automatic' : `by ${r.triggered_by}`} · {ago(r.created_at)}</span>
      </div>
      <Chip tone={look.tone}>{look.label}</Chip>
    </div>
  );
  if (!r.detail) return <div className="py-1">{head}</div>;
  return (
    <details className="py-1" open={r.state === 'running'}>
      <summary className="cursor-pointer list-none">{head}</summary>
      <pre className="mt-1 text-[12px] text-muted whitespace-pre-wrap break-words">{r.detail}</pre>
    </details>
  );
}
