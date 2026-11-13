// Messages on the internal WebSocket between server and worker.
import type { ClaudeAccountInfo, LoginHelp } from './accounts.ts';
import type { CheckProgress } from './checkProgress.ts';
import type { GeneratorItem } from './generatorItems.ts';
import type { OrchPhase, ReleaseInfo, WorkerFacts } from './types.ts';
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
  /** the starter's own GitHub account (DISP-63): when set, the worker uses it instead of its env accounts (memory only) */
  github?: GithubCred | null;
  resume: string | null; // sdk session id
  /** Text sent right after resume, when a session is restarted rather than continued by the user. */
  resume_note: string | null;
  /** planner sessions: the workers it can place work on, and the project's text on where work runs */
  workers?: PlannerWorker[];
  placement_md?: string;
  /** a scheduled planner run (DISP-13): it starts what it picks, within this scope, unwatched */
  schedule?: { name: string; scope_md: string; max_batches: number };
  /** release sessions: what to release (the worker takes command and notes from its own config) */
  release?: ReleaseInfo;
  /** orchestrator sessions: the goal, the projects it spans, and the plan as it stands */
  orchestration?: {
    goal: string;
    phase: OrchPhase;
    projects: { key: string; name: string; importance_scale: string[]; effort_scale: string[]; repos: string[] }[];
    max_children: number;
    /** the plan with each step's state, and which steps can start now */
    status_md: string;
  };
}

/** A user's own GitHub credential, sent for the sessions they started (DISP-63). */
export interface GithubCred {
  token: string;
  login: string;
  git_name: string;
  git_email: string;
}

export interface PlannerWorker {
  name: string;
  description: string;
  connected: boolean;
  local_repo_dirs: string[];
  claude_accounts: string[];
  github_accounts: string[];
  /** repos with env files on it, <owner>/<name> (DISP-44) */
  repo_envs?: string[];
}

export type ServerToWorker =
  | { t: 'start'; spec: StartSpec }
  | { t: 'send'; session_id: number; text: string; spec: StartSpec }
  | { t: 'answer'; session_id: number; local_id: string; answer: InputAnswer }
  | { t: 'interrupt'; session_id: number }
  | { t: 'close'; session_id: number; cleanup: boolean; repos: Repo[] }
  | { t: 'rpc_result'; req_id: string; ok: boolean; data?: unknown; error?: string }
  | { t: 'cmd'; req_id: string; cmd: WorkerCommand }
  /**
   * run the repo's deploy command on its merged default branch (DISP-37). No reply: a deploy often
   * restarts the server, so the result comes as `deploy_result`, kept until the server is back.
   * `github`: the starter's credential (DISP-63; the session may be closed by now), null: the
   * worker's env accounts; absent (an older server): the session's, while it lives.
   */
  | { t: 'deploy'; session_id: number; repo: Repo; github?: GithubCred | null };

export type WorkerCommand =
  | { c: 'push_branch'; repo: Repo; session_id: number; branch: string; github?: GithubCred | null }
  /** `items`: the export for the repo's generate command (DISP-56), when it has one */
  | { c: 'merge_local'; repo: Repo; branch: string; message: string; items?: GeneratorItem[]; github?: GithubCred | null }
  | { c: 'branch_status'; repo: Repo; branch: string }
  /** a file from a repo's default branch, or from a host folder (must be in ASSISTANT_READ_DIRS) */
  | { c: 'read_file'; repo?: Repo; base_dir?: string; path: string }
  /** check a folder is a git repo we may use (LOCAL_REPO_DIRS) and read its default branch */
  | { c: 'inspect_local_repo'; path: string }
  /** a local repo's session branch: diff against the default branch */
  | { c: 'branch_diff'; repo: Repo; branch: string; merged_sha?: string }
  /** what a finished session left on disk (worktrees, its branch, merged or not) */
  | { c: 'leftovers'; session_id: number; repos: Repo[]; branch: string | null; merged_repo_ids: number[] }
  /** remove a finished session's worktrees, and its branch where merged */
  /** the newest version tag on a repo's default branch, and its VERSION file */
  | { c: 'release_version'; repo: Repo }
  /** is this Claude account signed in on the worker (DISP-60)? Answers a ClaudeAccountInfo */
  | { c: 'check_login'; account: string | null }
  | { c: 'tidy'; session_id: number; repos: Repo[]; branch: string | null; merged_repo_ids: number[]; delete_merged: boolean; force: boolean };

export type WorkerToServer =
  | { t: 'hello'; live: number[]; claude_accounts?: ClaudeAccountInfo[]; facts?: WorkerFacts }
  /** the worker's free session slots changed (it can serve several servers) */
  | { t: 'slots'; free: number }
  /** the worker did not start a session: 'busy' (no free slot) or why it is not allowed */
  | { t: 'refused'; session_id: number; reason: string }
  /**
   * something the owner should know now (login needed, rate limit): shown in the session and pushed.
   * `login`: the session stopped because its account is not signed in (DISP-60)
   */
  | { t: 'notice'; session_id: number; title: string; body: string; login?: LoginHelp }
  | { t: 'status'; session_id: number; status: SessionStatus; sdk_session_id?: string; error?: string }
  /** images: base64 images from a tool result (e.g. Read of a png); the server stores them as files */
  | { t: 'event'; session_id: number; body: SessionEventBody; images?: { media_type: string; data: string }[] }
  | { t: 'input_request'; session_id: number; local_id: string; payload: PendingInputPayload }
  /**
   * the repo's check command, run in the session's worktree before a turn is reported done (DISP-15):
   * its progress while it runs, then `done` (no `done` and no progress: it was stopped)
   */
  | { t: 'session_check'; session_id: number; repo_id: number; progress?: CheckProgress; done?: { ok: boolean; duration_ms: number; units: number } }
  | { t: 'rpc'; req_id: string; session_id: number; method: RpcMethod; params: unknown }
  | { t: 'cmd_result'; req_id: string; ok: boolean; data?: unknown; error?: string }
  /** a long command's progress so far (merge_local: its check command's test progress, DISP-5) */
  | { t: 'cmd_progress'; req_id: string; data: unknown }
  /** a deploy command finished (DISP-37): `output` is the end of what it printed */
  | { t: 'deploy_result'; session_id: number; repo_id: number; ok: boolean; sha: string | null; output: string; duration_ms: number };

/** Calls the agent's `dispatch` MCP tools make back into the server. */
export type RpcMethod = 'list_items' | 'get_item' | 'get_image' | 'add_to_batch' | 'create_item' | 'add_comment' | 'propose' | 'release_items'
  /** images pasted into the chat (DISP-34): read one, or attach one to an item */
  | 'get_chat_image' | 'attach_image'
  /** planner and discussion chats reach another project, each call approved by the owner (DISP-55) */
  | 'cross_project' | AssistantMethod;

export type AssistantMethod =
  | 'inspect_github_repo' | 'list_projects' | 'create_project' | 'update_project' | 'set_project_state' | 'add_repo' | 'remove_repo'
  | 'list_items' | 'create_items' | 'update_item' | 'create_source' | 'list_sessions' | 'propose_session' | 'import_sections';
