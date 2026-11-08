// Who can act on GitHub in a project, and Connect GitHub when you cannot (DISP-63).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type GithubAccess } from '../api.ts';
import { accountSource, permissionLook } from '../access.ts';
import { Button, Card, Chip, ErrorText, Section } from './ui.tsx';

/** The project's GitHub access; `verify`: also ask GitHub each account's permission (kept 10 minutes on the server). */
export function useGithubAccess(key: string, verify = false) {
  return useQuery({
    queryKey: ['github-access', key, verify],
    queryFn: () => api.get<GithubAccess>(`/projects/${key}/github-access${verify ? '?verify=1' : ''}`),
    staleTime: 60_000,
  });
}

/** You cannot start work here until you connect GitHub: why, and the button (a server route: a plain link). */
export function GithubConnectBanner({ projectKey, className = 'mx-3 mt-3' }: { projectKey: string; className?: string }) {
  const { data } = useGithubAccess(projectKey);
  if (!data?.needs_github || data.you.ok) return null;
  return (
    <section className={`${className} rounded-xl border border-wait/40 bg-wait/5 px-3 py-2.5`} aria-label="Connect GitHub">
      <p className="text-[13px]">{data.you.message ?? 'Connect your GitHub account to start work here.'}</p>
      {data.you.connect_url && (
        <a href={data.you.connect_url} className="mt-2 inline-flex items-center h-8 px-2.5 rounded-lg text-[13px] font-medium bg-accent-strong text-on-accent hover:brightness-110">Connect GitHub</a>
      )}
    </section>
  );
}

/** Project settings: the accounts that act on GitHub here, with their permission once checked. */
export function GithubAccessPanel({ projectKey }: { projectKey: string }) {
  const [verify, setVerify] = useState(false);
  const { data, error, isFetching, refetch } = useGithubAccess(projectKey, verify);
  // until the check is back, show the list without permissions
  const { data: plain } = useGithubAccess(projectKey);
  const shown = data ?? plain;
  if (!shown?.needs_github) return null;
  return (
    <Section
      title="Who can act on GitHub here"
      action={<Button small variant="ghost" disabled={isFetching && verify} onClick={() => (verify ? refetch() : setVerify(true))}>{isFetching && verify ? 'Checking…' : 'Check access'}</Button>}
    >
      <Card>
        {shown.accounts.length === 0 && <p className="px-3 py-2.5 text-[13px] text-muted">Nobody yet. Each person connects GitHub in Settings.</p>}
        {shown.accounts.map((a) => {
          const look = 'permission' in a ? permissionLook(a.permission ?? null) : null;
          return (
            <div key={`${a.source}:${a.user}:${a.account ?? ''}`} className="flex items-center gap-2 px-3 py-2.5 border-b border-line last:border-b-0">
              <div className="flex-1 min-w-0">
                <div className="truncate text-[14px]">{a.user ?? 'No user'}{a.login && <span className="text-muted"> @{a.login}</span>}</div>
                <div className="text-[12px] text-muted truncate">
                  {accountSource(a)}
                  {a.repos && a.repos.length > 1 && ` · ${a.repos.map((r) => `${r.repo}: ${r.permission ?? 'unknown'}`).join(', ')}`}
                </div>
              </div>
              {look && <Chip tone={look.tone}>{look.label}</Chip>}
            </div>
          );
        })}
      </Card>
      <ErrorText error={error} />
    </Section>
  );
}
