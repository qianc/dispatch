import type {
  InputAnswer, Item, PendingInput, Project, PullRequest, Repo, Session, SessionEvent, Source,
} from '../../src/shared/types.ts';

export type { InputAnswer, Item, PendingInput, Project, PullRequest, Repo, Session, SessionEvent, Source };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') window.dispatchEvent(new Event('dispatch:unauthorized'));
    throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => req<T>('GET', p),
  post: <T>(p: string, b: unknown = {}) => req<T>('POST', p, b),
  patch: <T>(p: string, b: unknown) => req<T>('PATCH', p, b),
  del: <T>(p: string) => req<T>('DELETE', p),
};

export type ProjectSummary = Project & {
  muted: boolean;
  repos: Repo[];
  counts?: { backlog: number; bugs: number; active_sessions: number; waiting: number };
};

export interface Comment { id: number; item_id: number; author: string; body_md: string; created_at: string }
export type ItemDetail = Item & { comments: Comment[]; source: Source | null; sessions: Session[]; project: Project };
export type SourceDetail = Source & { items: Item[]; project_key: string; project: Project };
export type SourceSummary = Source & { item_count: number };

export interface SessionDetail {
  session: Session;
  events: SessionEvent[];
  inputs: PendingInput[];
  items: Item[];
  prs: PullRequest[];
  repos: Repo[];
  source: Source | null;
  project: Project | null;
}

export interface Inbox {
  inputs: PendingInput[];
  idle: Session[];
  prs: PullRequest[];
  sessions: Session[];
}

export interface PrDetail {
  pr: PullRequest;
  body: string;
  base_ref: string;
  files: { filename: string; status: string; additions: number; deletions: number; patch: string | null }[];
  checks: { name: string; status: string; conclusion: string | null; url: string | null }[];
}

export interface Me { authed: boolean; auth_disabled: boolean; vapid_public_key: string }
