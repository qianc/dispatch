// Settings → Updates (DISP-112): which version of Dispatch runs, what is new on its release branch,
// and the update of the server and its workers. Only the install owner sees it.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router';
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

/** The chip beside the running version. "Update available" only when there is something to update to. */
export function versionChip(info: UpdateInfo): { label: string; tone: Tone } {
  const { tone } = behindLine(info);
  if (tone === 'ok') return { label: 'Up to date', tone };
  if (tone !== 'accent') return { label: 'Not known', tone };
  if (info.target) return { label: 'Update available', tone };
  // behind the branch, with nothing to update to: only version tags are followed, and none is newer
  return { label: info.settings.follow === 'tags' ? 'No newer version tag' : 'Behind', tone: 'neutral' };
}

const WORKER_LOOK: Record<UpdateWorker['status'], { label: string; tone: Tone }> = {
  current: { label: 'Up to date', tone: 'ok' },
  behind: { label: 'Behind', tone: 'wait' },
  updating: { label: 'Updating', tone: 'run' },
  failed: { label: 'Update failed', tone: 'bad' },
  newer: { label: 'Newer than the server', tone: 'neutral' },
  newest: { label: 'On the newest commit', tone: 'ok' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

/** A worker's chip. On the server's commit is "Up to date" only when the server is (DISP-194). */
export function workerLook(info: UpdateInfo, w: UpdateWorker): { label: string; tone: Tone } {
  if (w.status === 'current' && behindLine(info).tone !== 'ok') return { label: 'Same as server', tone: 'neutral' };
  return WORKER_LOOK[w.status];
}

/** The line under a worker: why it cannot update itself, said as the reason when it is behind. */
export function workerWhy(w: UpdateWorker): string | null {
  if (w.updatable || !w.why) return null;
  if (w.status === 'behind' || w.status === 'failed') return `Behind the server · update it by hand, it cannot update itself. ${w.why}`;
  return `Cannot update itself. ${w.why}`;
}

const clock = (at: Date) => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** What "Check now" found, against what the card showed before (DISP-194): also when nothing changed. */
export function checkResult(before: UpdateInfo | undefined, after: UpdateInfo, at: Date): { text: string; tone: Tone } {
  const { state: st, branch } = after;
  const t = clock(at);
  if (st.error) return { text: `The check at ${t} failed: ${st.error}`, tone: 'bad' };
  if (!st.commit) return { text: `Checked at ${t}. ${behindLine(after).text}`, tone: 'neutral' };
  if (before?.state.commit?.sha === st.commit.sha && before.state.for_sha === st.for_sha) {
    return { text: `No new commits as of ${t}. ${short(st.commit.sha)} is still the newest on ${branch}.`, tone: 'neutral' };
  }
  return { text: `New on ${branch} as of ${t}: ${short(st.commit.sha)}.`, tone: 'accent' };
}

/** The first line of the newest commit of the branch, when the last look read it. */
const newestSubject = (info: UpdateInfo) => {
  const c = info.state.commit;
  return c ? info.state.commits.find((x) => x.sha === c.sha)?.subject ?? null : null;
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
  // what the last "Check now" found, so a check that changes nothing still shows
  const [checked, setChecked] = useState<{ text: string; tone: Tone } | null>(null);
  const check = useMutation({
    mutationFn: () => api.post<UpdateInfo>('/update/check'),
    onMutate: () => setChecked(null),
    onSuccess: (d) => {
      setChecked(checkResult(info, d, new Date()));
      done(d);
    },
    onError: (e) => setChecked({ text: `The check at ${clock(new Date())} failed: ${(e as Error).message}`, tone: 'bad' }),
  });
  const save = useMutation({ mutationFn: (s: Partial<UpdateSettings>) => api.put<UpdateInfo>('/update/settings', s), onSuccess: done });
  const start = useMutation({ mutationFn: () => api.post<UpdateInfo>('/update/start'), onSuccess: done });
  const cancel = useMutation({ mutationFn: () => api.post<UpdateInfo>('/update/cancel'), onSuccess: done });
  const failed = save.error ?? start.error ?? cancel.error ?? error;
  // a notice of an update opens Settings here
  const { hash } = useLocation();
  const loaded = !!info;
  useEffect(() => {
    if (hash === '#updates') document.getElementById('updates')?.scrollIntoView();
  }, [hash, loaded]);
  if (!info) return <Section title="Updates" id="updates"><Card className="p-3 text-sm text-muted">{error ? <ErrorText error={error} /> : 'Loading…'}</Card></Section>;

  const { state: st, version, rollout } = info;
  const behind = behindLine(info);
  const chip = versionChip(info);
  // a server that cannot be updated has nothing to update to: only its workers move
  const target = info.mode === 'none' ? null : info.target;
  const running = info.log.some((r) => r.state === 'running');
  // also with no newer version: a worker that is behind the server, or whose update failed
  const workersBehind = info.workers.some((w) => w.connected && w.updatable && (w.status === 'behind' || w.status === 'failed'));
  const canStart = !rollout && (!!target || workersBehind);
  const targetName = target ? (target.tag ? `${target.tag} (${short(target.sha)})` : short(target.sha)) : null;
  const subject = newestSubject(info);
  return (
    <Section
      title="Updates"
      id="updates"
      action={<Button small variant="ghost" disabled={check.isPending || !info.repo} onClick={() => check.mutate()}>{check.isPending ? 'Checking…' : 'Check now'}</Button>}
    >
      <Card>
        <div className="px-3 py-2.5 border-b border-line">
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 text-[14px]">
              The server runs <code>{short(version.sha)}</code>{version.tag && <span className="text-muted"> ({version.tag})</span>}
            </div>
            <Chip tone={chip.tone}>{chip.label}</Chip>
          </div>
          <div className="text-[12px] text-muted mt-0.5">
            {behind.text}
            {st.checked_at && ` · checked ${ago(st.checked_at)}`}
            {info.repo && ` · ${info.repo}`}
          </div>
          {st.commit && (
            <div className="text-[12px] text-muted">
              Newest on {info.branch}: <code>{short(st.commit.sha)}</code>
              {subject && <> “{subject}”</>}
              {st.commit.date && <> · {ago(st.commit.date)}</>}
              {st.tag && <> · newest version {st.tag.name} (<code>{short(st.tag.sha)}</code>)</>}
            </div>
          )}
          {checked && <p className={`text-[12px] mt-1 ${checked.tone === 'bad' ? 'text-bad' : checked.tone === 'accent' ? 'text-accent' : 'text-muted'}`}>{checked.text}</p>}
          {st.error && checked?.tone !== 'bad' && <p className="text-[12px] text-bad mt-1">The last check failed: {st.error}</p>}
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
              {targetName ? `Update the server and workers to ${targetName}` : workersBehind ? `Update the workers to ${short(version.sha)}, the server's commit` : 'Update now'}
            </Button>
          )}
          {!rollout && target && (
            <p className="text-[12px] text-muted">
              Installs <code>{short(target.sha)}</code>
              {target.sha === st.commit?.sha ? <>, the newest commit on {info.branch}{subject && <> (“{subject}”)</>}</> : target.tag && <>, version {target.tag}</>}
              , on the server first, then on each worker that can update itself. The server now runs <code>{short(version.sha)}</code>.
            </p>
          )}
          {info.waiting.map((w) => <p key={w} className="text-[13px] text-wait">{w}</p>)}
          <ErrorText error={failed} />
        </div>

        {info.workers.length > 0 && (
          <div className="border-b border-line">
            {info.workers.map((w) => {
              const look = workerLook(info, w);
              const why = workerWhy(w);
              return (
                <div key={w.id} className="flex items-center gap-2 px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] truncate">Worker {w.name}<span className="text-muted"> · <code>{short(w.sha)}</code>{!w.connected && ' · offline'}</span></div>
                    {why && <div className={`text-[12px] ${w.status === 'behind' ? 'text-wait' : 'text-muted'}`}>{why}</div>}
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
