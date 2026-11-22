import type {
  Attention, FailedSession, GithubAccess, GithubAccessAccount, GithubPermission, InputAnswer, ItemImage, Item, Orchestration, PendingInput, Project, PullRequest, Repo, Schedule, Session, SessionEvent, Source,
} from '../../src/shared/types.ts';
import type { SessionAccess } from './access.ts';
import type { ClaudeAccountInfo } from '../../src/shared/accounts.ts';
import type { CheckRun } from '../../src/shared/checkProgress.ts';

export type { Attention, FailedSession, GithubAccess, GithubAccessAccount, GithubPermission, InputAnswer, ItemImage, Item, PendingInput, Project, PullRequest, Repo, Session, SessionEvent, Source };

export class ApiError extends Error {
  status: number;
  /** the answer did not come from Dispatch (a sign-in proxy turned the request away) */
  foreign: boolean;
  /** why, for the app to act on (e.g. `github_not_connected`) */
  code?: string;
  /** where to connect GitHub, when that is what is missing (DISP-63) */
  connect_url?: string;
  constructor(status: number, message: string, foreign = false, extra: { code?: string; connect_url?: string } = {}) {
    super(message);
    this.status = status;
    this.foreign = foreign;
    if (extra.code) this.code = extra.code;
    if (extra.connect_url) this.connect_url = extra.connect_url;
  }
}

/** The error's body as the server sent it. */
type ErrorBody = { error?: string; code?: unknown; connect_url?: unknown };
const extraOf = (d: ErrorBody) => ({
  code: typeof d.code === 'string' ? d.code : undefined,
  connect_url: typeof d.connect_url === 'string' ? d.connect_url : undefined,
});

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    // ask for JSON: a sign-in proxy then answers 401 instead of redirecting to its login page.
    // x-dispatch-path: the page this comes from, where connecting GitHub comes back to (DISP-63)
    headers: { accept: 'application/json', ...(globalThis.location ? { 'x-dispatch-path': location.pathname + location.search } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    // a sign-in proxy that redirects to its login all the same (Entra, …): the browser blocks that
    // request to another origin, so do not follow it (DISP-107)
    redirect: 'manual',
  });
  // "ask /me again"; not for /me itself, which would ask again without end
  const unauthorized = () => path !== '/login' && path !== '/me' && window.dispatchEvent(new Event('dispatch:unauthorized'));
  if (res.type === 'opaqueredirect') {
    unauthorized();
    throw new ApiError(401, 'Signed out', true);
  }
  const json = (res.headers.get('content-type') ?? '').includes('application/json');
  const data = json ? await res.json().catch(() => ({})) : {};
  if (!res.ok) {
    if (res.status === 401) unauthorized();
    throw new ApiError(res.status, (data as ErrorBody).error ?? res.statusText, !json, extraOf(data as ErrorBody));
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
  if (!res.ok) throw new ApiError(res.status, (data as ErrorBody).error ?? res.statusText, false, extraOf(data as ErrorBody));
  return data as ItemImage;
}

export const api = {
  get: <T>(p: string) => req<T>('GET', p),
  post: <T>(p: string, b: unknown = {}) => req<T>('POST', p, b),
  patch: <T>(p: string, b: unknown) => req<T>('PATCH', p, b),
  del: <T>(p: string) => req<T>('DELETE', p),
  put: <T>(p: string, b: unknown) => req<T>('PUT', p, b),
};

export type ProjectSummary = Project & {
  muted: boolean;
  repos: Repo[];
  counts?: { backlog: number; bugs: number; active_sessions: number; waiting: number; running: number; queued: number };
};

export interface Comment { id: number; item_id: number; author: string; body_md: string; created_at: string }
export type ItemDetail = Omit<Item, 'comments'> & { comments: Comment[]; source: Source | null; sessions: Session[]; project: Project; images: ItemImage[] };
export type SourceDetail = Source & { items: Item[]; project_key: string; project: Project };
export type SourceSummary = Source & { item_count: number };

export interface SessionDetail {
  session: Session;
  events: SessionEvent[];
  /** there are events before the first one here: the page loads the last ones, "Show earlier" the rest (DISP-162) */
  earlier?: boolean;
  inputs: PendingInput[];
  items: Item[];
  prs: PullRequest[];
  /** what it needs from you, as the inbox says it (DISP-159): the server knows which PRs it merges now */
  attention: Attention;
  repos: Repo[];
  source: Source | null;
  project: Project | null;
  /** check commands running now for this session's merges (DISP-5) */
  checks?: CheckRun[];
  /** what you may do with it (DISP-63; missing from older servers) */
  access?: SessionAccess;
  /** a failed session (DISP-81): why, the session that retries it, your open discussion of it */
  failure?: SessionFailure | null;
  /** an orchestrator session: its plan and steps */
  orchestration?: Orchestration | null;
  /** a step's batch: the orchestration and step it is part of */
  part_of?: PartOf | null;
}

export interface PartOf { orchestrator_id: number; title: string; step_position: number | null; step_count: number }

export interface SessionFailure { reason: string; retried_as: number | null; discussion: number | null }

/** The open assistant thread (or null), with Claude's replies since the owner last read it. */
export interface AssistantChat {
  session_id: number | null;
  unread: number;
  last_seq: number;
}

export interface Inbox {
  inputs: PendingInput[];
  /** card_text: the last message to show on the card; null when the pull requests moved on after it (DISP-106) */
  idle: (Session & { attention: Attention; card_text?: string | null })[];
  /** failed sessions not yet ignored or retried, with a short reason (DISP-81; missing from older servers) */
  failed?: FailedSession[];
  prs: PullRequest[];
  sessions: Session[];
  /** leftovers of finished sessions on disk, if any */
  cleanup: { sessions: { id: number; title: string; project_key: string | null; worktrees: number; branches: number; checked_out?: { repo: string; path: string }[] }[]; worktrees: number; branches: number; checked_out?: number; checked_at: string } | null;
}

export interface PrDetail {
  pr: PullRequest;
  repo: { kind: 'github' | 'local' | 'hosted'; upstream: string | null; check_command: string | null };
  /** times the owner's hands were needed for this session's merges */
  hands: { id: number; kind: 'asked_update' | 'resolve_conflicts' | 'manual_merge'; detail: string | null; created_at: string }[];
  body: string;
  base_ref: string;
  files: { filename: string; status: string; additions: number; deletions: number; patch: string | null }[];
  checks: { name: string; status: string; conclusion: string | null; url: string | null }[];
  auto_merge: Session['options']['auto_merge'];
  /** you may merge it: you started its session (DISP-63; missing from older servers); a PR with no session: anyone who may act */
  can_merge?: boolean;
  /** you may approve it: an open GitHub PR you have not approved at this commit (DISP-111) */
  can_approve?: boolean;
  /** what to know before merging a PR with no session (its deploy does not run), or why it cannot merge here */
  merge_note: string | null;
  /** false: Dispatch cannot merge it (no session, and the repo merges only on a session's worker) */
  merge_here: boolean;
}

export interface Me {
  authed: boolean;
  user: string | null;
  /** the signed-in person owns this install (projects, install settings) */
  is_owner: boolean;
  install_owner: string | null;
  /** install owner only: the key file Dispatch made for stored GitHub tokens, or null */
  secret_key_file: string | null;
  auth_mode: 'password' | 'proxy' | 'off';
  auth_disabled: boolean;
  password_login: boolean;
  vapid_public_key: string;
}

/** The signed-in person's own GitHub connection (never its token). */
export interface MyGithub {
  connected: boolean;
  login: string | null;
  git_name: string | null;
  git_email: string | null;
  kind: 'oauth' | 'pat' | null;
  verified_at: string | null;
  /** set when the token stopped working: connect again */
  last_error: string | null;
  /** "Connect with GitHub" is set up (GITHUB_OAUTH_CLIENT_ID / _SECRET) */
  oauth_available: boolean;
  /** the install owner: without a connection, actions use the server's GitHub accounts */
  uses_env_when_unconnected: boolean;
  env_accounts: { name: string; login: string | null }[];
}

export interface Accounts {
  claude: ClaudeAccountInfo[];
  github: { name: string; login: string | null; git_name: string | null; git_email: string | null }[];
  assistant_claude_account: string | null;
}

/** A connected worker that can release one of the project's repos (from its own config). */
/** A scheduled planner run, with its next run and its last run's session. */
export type ScheduleView = Schedule & {
  /** the server's time zone: at_time and the runs are in it */
  time_zone: string;
  next_run: string | null;
  last_session: Pick<Session, 'id' | 'status' | 'title' | 'last_text' | 'created_at'> | null;
};

export interface ReleaseOption {
  worker_id: number;
  worker: string;
  repo_id: number;
  repo: string;
  cap_repo: string;
  label_prefix: string;
  command: string | null;
  notes: string | null;
}

export interface ReleaseProposal {
  last: { version: string; from: 'tag' | 'file' | 'label'; date: string | null } | null;
  proposed: string;
  bump: 'minor' | 'patch' | 'first' | 'release';
  items: Pick<Item, 'id' | 'key' | 'type' | 'title'>[];
  older: number;
  label_prefix: string;
  command: string | null;
  notes: string | null;
  warning?: string;
}
