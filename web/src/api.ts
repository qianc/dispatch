import type {
  Attention, InputAnswer, ItemImage, Item, PendingInput, Project, PullRequest, Repo, Session, SessionEvent, Source,
} from '../../src/shared/types.ts';

export type { Attention, InputAnswer, ItemImage, Item, PendingInput, Project, PullRequest, Repo, Session, SessionEvent, Source };

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

/** Upload one image file to an item (raw body; the server checks it is an image). */
export async function uploadImage(itemId: number, file: File, commentId?: number) {
  const q = new URLSearchParams({ name: file.name || 'image' });
  if (commentId) q.set('comment_id', String(commentId));
  const res = await fetch(`/api/items/${itemId}/images?${q}`, {
    method: 'POST',
    headers: { 'content-type': file.type.startsWith('image/') ? file.type : 'application/octet-stream' },
    body: file,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as ItemImage;
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
export type ItemDetail = Omit<Item, 'comments'> & { comments: Comment[]; source: Source | null; sessions: Session[]; project: Project; images: ItemImage[] };
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
  idle: (Session & { attention: Attention })[];
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

export interface Accounts {
  claude: { name: string; label: string; kind: string; logged_in: boolean | null; config_dir: string | null }[];
  github: { name: string; login: string | null; git_name: string | null; git_email: string | null }[];
  assistant_claude_account: string | null;
}
