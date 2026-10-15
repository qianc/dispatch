import { useQuery } from '@tanstack/react-query';
import { api, type Accounts } from './api.ts';
import type { Project } from '../../src/shared/types.ts';

export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Accounts>('/accounts'), staleTime: 60_000 });

/** Claude accounts a project may use, with its default first. */
export function projectClaude(accounts: Accounts | undefined, project: Pick<Project, 'claude_account' | 'claude_allowed'>) {
  const all = accounts?.claude ?? [];
  const allowed = project.claude_allowed?.length ? all.filter((a) => project.claude_allowed!.includes(a.name)) : all;
  const def = allowed.find((a) => a.name === project.claude_account) ?? allowed[0];
  return { allowed, def };
}

export const claudeLabel = (accounts: Accounts | undefined, name: string | null) =>
  accounts?.claude.find((a) => a.name === (name ?? 'default'))?.label ?? name ?? 'default';
