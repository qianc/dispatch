import type { PullRequest, Session } from '../../../src/shared/types.ts';
import { autoMergePending } from '../../../src/shared/attention.ts';
import { Chip } from './ui.tsx';

/** A PR's state; an open one that auto-merge still checks and merges shows as in progress. */
export function PrStateChip({ pr, autoMerge }: { pr: PullRequest; autoMerge: Session['options']['auto_merge'] }) {
  if (autoMergePending(autoMerge, pr)) return <Chip tone="run">checking</Chip>;
  return <Chip tone={pr.state === 'merged' ? 'accent' : pr.state === 'open' ? 'ok' : 'neutral'}>{pr.state}</Chip>;
}
