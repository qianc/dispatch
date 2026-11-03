import { useEffect, useState } from 'react';
import { formatLeft, timeLeft, type CheckRun } from '../../../src/shared/checkProgress.ts';

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A repo's check command while it runs before a merge (DISP-5): the step, the last finished test
 * file, passed and failed counts, and the time left from earlier runs. It counts down between the
 * worker's reports; the server takes it away when the check ends.
 */
export function CheckProgressCard({ run }: { run: CheckRun }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const p = run.progress;
  // between reports the run goes on: count from its start, not from the last report
  const elapsed = Math.max(p.elapsed_ms, now - Date.parse(run.started_at));
  const left = timeLeft(p, elapsed, run.expected);
  const of = p.total !== null && p.total_open && run.expected ? Math.max(p.total, run.expected.units) : p.total ?? run.expected?.units ?? null;
  const share = left !== null && elapsed + left > 0 ? elapsed / (elapsed + left) : of ? Math.min(p.units / of, 1) : null;
  return (
    <div className="mx-4 my-2 rounded-xl border border-line bg-panel px-3 py-2.5 text-[14px]" role="status" aria-label={`Tests running in ${run.repo}`}>
      <div className="flex items-baseline gap-2">
        <span className="font-medium">Tests running in {run.repo}</span>
        <span className="ml-auto text-[13px] text-muted tabular-nums">{clock(elapsed)}</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-raised overflow-hidden">
        {share !== null
          ? <div className="h-full bg-run transition-[width] duration-1000" style={{ width: `${Math.round(Math.min(share, 0.99) * 100)}%` }} />
          : <div className="h-full w-1/3 bg-run animate-pulse" />}
      </div>
      <p className="mt-1.5 text-[13px] flex flex-wrap gap-x-3">
        <span className="text-ok">{p.passed} passed</span>
        {p.failed > 0 && <span className="text-bad">{p.failed} failed</span>}
        {p.skipped > 0 && <span className="text-muted">{p.skipped} skipped</span>}
        {of !== null && <span className="text-muted tabular-nums">{p.units} of {p.total !== null && !p.total_open ? '' : '~'}{of}</span>}
        <span className="ml-auto text-muted">
          {left === null ? 'no earlier run to estimate from' : left > 0 ? `${formatLeft(left)} left` : 'longer than usual'}
        </span>
      </p>
      {(p.stage || p.current) && (
        <p className="mt-0.5 text-[12px] text-faint font-mono truncate">
          {p.stage}{p.stage && p.current ? ' · ' : ''}{p.current}
        </p>
      )}
    </div>
  );
}
