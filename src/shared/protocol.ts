// Messages on the internal WebSocket between server and worker.
import type { ClaudeAccountInfo } from './accounts.ts';
import type { InputAnswer, Item, PendingInputPayload, Repo, RunOptions, SessionEventBody, SessionKind, SessionStatus, Source } from './types.ts';

export interface StartSpec {
  session_id: number;
  kind: SessionKind;
  project_key: string;
  project_name: string;
  importance_scale: string[];
  effort_scale: string[];
  title: string;
  branch: string | null; // null for planner sessions
  repos: Repo[];
  items: Item[];
  source: Source | null;
  prompt: string; // first user message
  force_plan: boolean;
  options: RunOptions;
  /** Claude account to run on (null = legacy default); the worker holds the credentials */
  claude_account: string | null;
  /** the project's GitHub account: token for git/gh and the commit identity */
  github_account: string | null;
  resume: string | null; // sdk session id
  /** Text sent right after resume, when a session is restarted rather than continued by the user. */
  resume_note: string | null;
}

export type ServerToWorker =
  | { t: 'start'; spec: StartSpec }
  | { t: 'send'; session_id: number; text: string; spec: StartSpec }
  | { t: 'answer'; session_id: number; local_id: string; answer: InputAnswer }
  | { t: 'interrupt'; session_id: number }
  | { t: 'close'; session_id: number; cleanup: boolean; repos: Repo[] }
  | { t: 'rpc_result'; req_id: string; ok: boolean; data?: unknown; error?: string }
  | { t: 'cmd'; req_id: string; cmd: WorkerCommand };

export type WorkerCommand =
  | { c: 'push_branch'; repo: Repo; session_id: number; branch: string }
  | { c: 'merge_local'; repo: Repo; branch: string; message: string }
  | { c: 'branch_status'; repo: Repo; branch: string }
  /** a file from a repo's default branch, or from a host folder (must be in ASSISTANT_READ_DIRS) */
  | { c: 'read_file'; repo?: Repo; base_dir?: string; path: string }
  /** check a folder is a git repo we may use (LOCAL_REPO_DIRS) and read its default branch */
  | { c: 'inspect_local_repo'; path: string }
  /** a local repo's session branch: diff against the default branch */
  | { c: 'branch_diff'; repo: Repo; branch: string };

export type WorkerToServer =
  | { t: 'hello'; live: number[]; claude_accounts?: ClaudeAccountInfo[] }
  /** something the owner should know now (login needed, rate limit): shown in the session and pushed */
  | { t: 'notice'; session_id: number; title: string; body: string }
  | { t: 'status'; session_id: number; status: SessionStatus; sdk_session_id?: string; error?: string }
  /** images: base64 images from a tool result (e.g. Read of a png); the server stores them as files */
  | { t: 'event'; session_id: number; body: SessionEventBody; images?: { media_type: string; data: string }[] }
  | { t: 'input_request'; session_id: number; local_id: string; payload: PendingInputPayload }
  | { t: 'rpc'; req_id: string; session_id: number; method: RpcMethod; params: unknown }
  | { t: 'cmd_result'; req_id: string; ok: boolean; data?: unknown; error?: string };

/** Calls the agent's `dispatch` MCP tools make back into the server. */
export type RpcMethod = 'list_items' | 'get_item' | 'get_image' | 'add_to_batch' | 'create_item' | 'add_comment' | 'propose' | AssistantMethod;

export type AssistantMethod =
  | 'inspect_github_repo' | 'list_projects' | 'create_project' | 'update_project' | 'add_repo' | 'remove_repo'
  | 'list_items' | 'create_items' | 'update_item' | 'create_source' | 'list_sessions' | 'propose_session' | 'import_sections';
