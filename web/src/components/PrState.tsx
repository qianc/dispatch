import type { PullRequest, Session } from '../../../src/shared/types.ts';
import { autoMergePending } from '../../../src/shared/attention.ts';
import { openedBy } from '../access.ts';
import { Chip, cx } from './ui.tsx';

/** A PR's state; an open one that auto-merge still checks and merges shows as in progress. */
export function PrStateChip({ pr, autoMerge }: { pr: PullRequest; autoMerge: Session['options']['auto_merge'] }) {
  if (autoMergePending(autoMerge, pr)) return <Chip tone="run">checking</Chip>;
  return <Chip tone={pr.state === 'merged' ? 'accent' : pr.state === 'open' ? 'ok' : 'neutral'}>{pr.state}</Chip>;
}

/** "Opened by bob (@bob-gh)", when a person started its session (DISP-63). */
export function PrOpenedBy({ pr, className }: { pr: Pick<PullRequest, 'started_by' | 'github_login'>; className?: string }) {
  const text = openedBy(pr);
  return text ? <span className={cx('text-[12px] text-muted', className)}>{text}</span> : null;
}
