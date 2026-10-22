import type { ClaudeAccountInfo } from './accounts.ts';
import { PROJECT_COLOR_NAMES, PROJECT_ICONS, type ProjectColor } from './projectLook.ts';
import { z } from 'zod';

// ---------- domain ----------

export const ITEM_TYPES = ['backlog', 'bug'] as const;
export const ITEM_STATUSES = ['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'hold', 'done', 'canceled'] as const;
export const SOURCE_KINDS = ['manual', 'retro', 'skill_run', 'user_report', 'agent_session'] as const;
export const SESSION_KINDS = ['work', 'planner', 'assistant', 'discuss', 'release'] as const;
/** Light read-only chats: no worker slot, not listed as agent work, no push when a reply is ready. */
export const CHAT_KINDS: SessionKind[] = ['assistant', 'discuss'];
export const SESSION_STATUSES = ['queued', 'running', 'waiting_input', 'idle', 'completed', 'failed', 'stopped'] as const;

export type ItemType = (typeof ITEM_TYPES)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type SessionKind = (typeof SESSION_KINDS)[number];
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Sessions in these states hold a worker slot. */
export const ACTIVE_STATUSES: SessionStatus[] = ['running', 'waiting_input'];
/** Sessions in these states are finished for good. */
export const FINAL_STATUSES: SessionStatus[] = ['completed', 'failed', 'stopped'];

export const DEFAULT_IMPORTANCE_SCALE = ['Low', 'Medium', 'High', 'Critical'];
export const DEFAULT_EFFORT_SCALE = ['XS', 'S', 'M', 'L', 'XL'];

export interface Project {
  id: number;
  key: string;
  name: string;
  description: string;
  default_force_plan: boolean;
  importance_scale: string[];
  effort_scale: string[];
  /** GitHub account its repos use (null = the first configured) */
  github_account: string | null;
  /** default Claude account for its sessions (null = the first configured) */
  claude_account: string | null;
  /** Claude accounts its sessions may use (null = any) */
  claude_allowed: string[] | null;
  /** look in lists (names from projectLook.ts); null = default colour from the key / its first letter */
  color: string | null;
  icon: string | null;
  /** default worker for its sessions (null = the global default) */
  worker_id: number | null;
  /** prose for the planner: when to use which worker */
  placement_md: string;
  created_at: string;
}

export interface Repo {
  id: number;
  project_id: number;
  github_owner: string;
  github_name: string;
  default_branch: string;
  check_command: string | null;
  /** set for a local-only repo: a git folder on the worker host (github_owner is then 'local') */
  local_path: string | null;
  /** local repos: make session worktrees in the repo itself (default) or in a separate clone */
  worktree_from: 'repo' | 'clone' | null;
  /** run in each new session worktree before the agent starts (venv, npm ci, ...) */
  setup_command: string | null;
  /** local repos: folders of the real checkout (relative, often not in git) that Discuss may read */
  read_dirs?: string[];
  /** worker only: this session's worktree is a worktree of the owner's repo itself */
  attached?: boolean;
  /** the project's GitHub account (filled in by the server; tokens stay in env) */
  github_account?: string | null;
  /** github: any worker clones it; local: a folder on one worker (`worker_id`); hosted: kept by the server */
  kind?: 'github' | 'local' | 'hosted';
  /** hosted repos: a GitHub repo the merged default branch is pushed to (or PRs are opened on) */
  upstream_owner?: string | null;
  upstream_name?: string | null;
  /** local repos: the worker whose machine holds the folder */
  worker_id?: number | null;
}

export interface Source {
  id: number;
  project_id: number;
  kind: SourceKind;
  title: string;
  body_md: string;
  reporter: string | null;
  version_tag: string | null;
  skill_name: string | null;
  session_id: number | null;
  created_at: string;
}

export interface Item {
  id: number;
  project_id: number;
  number: number;
  key: string; // e.g. "HC-42"
  type: ItemType;
  title: string;
  body_md: string;
  status: ItemStatus;
  importance: number; // 1..4
  effort: number | null; // index into project effort_scale
  source_id: number | null;
  /** tags */
  labels: string[];
  modules: string[];
  marked: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /** set where an item is handed to an agent: how many images it has */
  image_count?: number;
  /** set where an item is handed to an agent: its comments, oldest first */
  comments?: { author: string; body_md: string; created_at: string }[];
}

export const MODELS = ['default', 'opus', 'sonnet', 'haiku'] as const;
export const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const SUBAGENT_MODES = ['auto', 'prefer', 'none'] as const;
export const START_MODES = ['now', 'after'] as const;
export const AUTO_MERGE = ['off', 'github', 'local'] as const;

export const runOptions = z.object({
  /** Claude Code model alias; 'default' = the worker's AGENT_MODEL / Claude Code default */
  model: z.enum(MODELS).default('default'),
  effort: z.enum(EFFORTS).default('default'),
  /** how superpowers should run the implementation plan: Claude decides, subagent-driven, or inline */
  subagents: z.enum(SUBAGENT_MODES).default('auto'),
  /** now = start at once, in parallel with anything running; after = wait for this project's running agents */
  start: z.enum(START_MODES).default('now'),
  /** merge the PR when the agent is done and checks pass */
  auto_merge: z.enum(AUTO_MERGE).default('off'),
  /** before auto-merge: if the branch is behind the default branch, ask the agent to update it first */
  base_check: z.boolean().default(true),
  /** Claude account for this batch; null = the project's default */
  claude_account: z.string().nullable().default(null),
  /** worker to run on; null = the project's (or the global) default */
  worker_id: z.number().int().nullable().default(null),
});
export type RunOptions = z.infer<typeof runOptions>;
export const DEFAULT_RUN_OPTIONS: RunOptions = runOptions.parse({});

export interface Session {
  id: number;
  /** null for assistant chats, which span all projects */
  project_id: number | null;
  project_key: string | null;
  kind: SessionKind;
  title: string;
  status: SessionStatus;
  force_plan: boolean;
  branch: string | null;
  sdk_session_id: string | null;
  initial_prompt: string;
  source_id: number | null;
  waiting_reason: string | null;
  last_text: string | null;
  usage: { cost_usd?: number; turns?: number; input_tokens?: number; output_tokens?: number } | null;
  options: RunOptions;
  /** Claude account this session runs on; fixed once started (null = legacy default) */
  claude_account: string | null;
  /** the worker it runs on, for its whole life */
  worker_id: number | null;
  /** a queued session the owner paused: it does not start until resumed */
  paused: boolean;
  /** a reply sent while the worker was away; delivered when it starts */
  pending_prompt: string | null;
  /** the session this one was moved from (Move to another worker) */
  moved_from: number | null;
  item_ids: number[];
  /** release sessions: what is being released, fixed at creation */
  release: ReleaseInfo | null;
  /** planner sessions a schedule started (null: started by hand, or the schedule was deleted) */
  schedule_id: number | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

/** A planner run at set times on a project, which starts the work it picks (DISP-13). */
export interface Schedule {
  id: number;
  project_id: number;
  name: string;
  /** HH:MM, the server's local time */
  at_time: string;
  /** weekdays it runs on, 0 = Sunday … 6 = Saturday */
  days: number[];
  /** what the planner may pick, in prose (modules, tags, "triage new bugs", …) */
  scope_md: string;
  /** the most batches one run may start */
  max_batches: number;
  /** run options for the batches it starts */
  options: RunOptions;
  enabled: boolean;
  /** the last slot (ISO time) that ran or was passed over: each slot runs once */
  last_slot: string | null;
  last_session_id: number | null;
  /** why the last run could not start */
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** A release a worker offers, from its own config: `repo` is owner/name, a repo name, or a local path. */
export interface ReleaseCapability {
  repo: string;
  /** the label the released items get, before the version: rel:, convert: */
  label_prefix: string;
  /** the repo's release step; {version} is replaced. null: the agent follows the repo's own docs */
  command: string | null;
  notes: string | null;
}

/** A release session's release: the repo, the agreed version and the capability it runs under. */
export interface ReleaseInfo {
  repo_id: number;
  /** the capability's `repo`, as the worker's config names it */
  cap_repo: string;
  version: string;
  label_prefix: string;
  command: string | null;
  notes: string | null;
  last_version: string | null;
}

/** What a worker reported about itself at hello (names only, never credentials). */
export interface WorkerFacts {
  os: string;
  hostname: string;
  slots: number;
  free_slots: number;
  claude_accounts: ClaudeAccountInfo[];
  github_accounts: string[];
  local_repo_dirs: string[];
  /** releases it can run (missing from workers older than releases) */
  releases?: ReleaseCapability[];
}

export interface WorkerRecord {
  id: number;
  name: string;
  description: string;
  prefix: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  facts: WorkerFacts | null;
  /** the legacy worker connects with the server's WORKER_TOKEN */
  legacy: boolean;
  connected?: boolean;
}

/** Compact, UI-ready transcript event. */
export type SessionEventBody =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_use'; tool_use_id: string; name: string; summary: string; input: unknown }
  | { kind: 'tool_result'; tool_use_id: string; is_error: boolean; text: string; images?: { url: string; media_type: string }[] }
  | { kind: 'result'; subtype: string; cost_usd?: number; turns?: number; duration_ms?: number }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'input_request'; input_id: number }
  | { kind: 'proposal'; proposal: Proposal }
  | { kind: 'proposal_done'; event_id: number; note: string };

export interface SessionEvent {
  id: number;
  session_id: number;
  seq: number;
  body: SessionEventBody;
  created_at: string;
}

export interface QuestionOption { label: string; description: string; preview?: string }
export interface Question { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }

export type PendingInputPayload =
  | { kind: 'question'; questions: Question[] }
  | { kind: 'plan_approval'; plan: string };

export type InputAnswer =
  | { kind: 'question'; answers: Record<string, string> }
  | { kind: 'plan_approval'; approve: boolean; feedback?: string };

export interface PendingInput {
  id: number;
  session_id: number;
  payload: PendingInputPayload;
  answer: InputAnswer | null;
  answered_at: string | null;
  expired: boolean;
  created_at: string;
}

/** Tags/modules: trimmed, no empties, no case-insensitive duplicates. */
export const tagList = z.array(z.string()).transform((xs) => {
  const seen = new Set<string>();
  return xs.map((x) => x.trim().slice(0, 40)).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
});

export const proposedItemSchema = z.object({
  type: z.enum(ITEM_TYPES).default('backlog'),
  title: z.string().min(1).max(200),
  body_md: z.string().default(''),
  importance: z.number().int().min(1).max(4).default(2),
  effort: z.number().int().min(0).nullable().default(null),
  labels: tagList.default([]),
  modules: tagList.default([]),
});
export type ProposedItem = z.infer<typeof proposedItemSchema>;

export type Proposal =
  /** project_key is set when the proposal comes from the assistant (not tied to one project) */
  | { type: 'batch'; project_key?: string; title: string; item_ids: number[]; new_items: ProposedItem[]; prompt: string; force_plan: boolean; worker?: string; worker_reason?: string }
  | { type: 'planner'; project_key: string; prompt: string }
  | { type: 'items'; source_id: number | null; items: ProposedItem[] }
  /** Discuss: a change to one item that the owner applies (or not). `before` holds the old values. */
  | { type: 'item_update'; item_id: number; item_key: string; changes: ItemChanges; before: ItemChanges; comment: string | null; reason: string };

export interface ItemChanges {
  title?: string;
  body_md?: string;
  type?: ItemType;
  status?: ItemStatus;
  importance?: number;
  effort?: number | null;
  labels?: string[];
  modules?: string[];
}

export interface PullRequest {
  id: number;
  session_id: number;
  repo_id: number;
  repo_full_name: string;
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  mergeable: boolean | null;
  mergeable_state: string | null;
  head_ref: string;
  head_sha: string | null;
  last_synced: string | null;
  /** a local repo's session branch (no GitHub PR): number is -session id, url is empty */
  local: boolean;
  /** why auto-merge stopped, while that still holds (open, same head commit) */
  blocked: string | null;
  /** commits the default branch had that the branch lacked, when it was merged */
  behind_at_merge: number | null;
}

/** A time the owner's hands were needed to get work merged. */
export interface MergeEvent {
  id: number;
  session_id: number;
  pr_id: number | null;
  kind: 'asked_update' | 'resolve_conflicts' | 'manual_merge';
  detail: string | null;
  created_at: string;
}

/** An image on an item (or on one of its comments). `url` serves it; `file` stays on the server. */
export interface ItemImage {
  id: number;
  item_id: number;
  comment_id: number | null;
  name: string;
  mime: string;
  size: number;
  author: string;
  created_at: string;
  url: string;
}

/** What an idle session in the inbox needs from you. */
export type Attention =
  | { kind: 'merge_blocked'; text: string; pr_id: number }
  | { kind: 'review'; text: string; pr_id: number }
  /** auto-merge waits for the checks, then merges: nothing to do yet (room for live test progress later) */
  | { kind: 'checking'; text: string; pr_id: number }
  /** a merge runs now (the repo's check command, then the merge): nothing to do yet (DISP-31) */
  | { kind: 'merging'; text: string; pr_id: number }
  | { kind: 'merged'; text: string }
  /** a planning chat with a batch or items card you have not acted on yet */
  | { kind: 'proposal'; text: string; proposals: OpenProposal[] }
  | { kind: 'turn'; text: string };

/** A batch or items card that is still on offer in a planning chat. */
export interface OpenProposal { event_id: number; proposal: Extract<Proposal, { type: 'batch' } | { type: 'items' }> }

// ---------- API inputs ----------

const scale = (n?: number) => (n ? z.array(z.string().min(1)).length(n) : z.array(z.string().min(1)).min(2).max(10));

export const projectInput = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Key: 2–10 capitals/digits, starting with a letter'),
  name: z.string().min(1),
  description: z.string().default(''),
  default_force_plan: z.boolean().default(false),
  importance_scale: scale(4).default(DEFAULT_IMPORTANCE_SCALE),
  effort_scale: scale().default(DEFAULT_EFFORT_SCALE),
});
// PATCH schemas are written out on purpose: every field optional, no defaults. Zod 4 applies
// .default() even inside .partial(), so a partial of a create schema would reset every field a
// request leaves out (marking an item wiped its description, scales, tags and source).
export const projectPatch = z.object({
  github_account: z.string().nullable().optional(),
  claude_account: z.string().nullable().optional(),
  claude_allowed: z.array(z.string()).nullable().optional(),
  color: z.enum(PROJECT_COLOR_NAMES as [ProjectColor, ...ProjectColor[]]).nullable().optional(),
  icon: z.enum(PROJECT_ICONS).nullable().optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  default_force_plan: z.boolean().optional(),
  importance_scale: scale(4).optional(),
  effort_scale: scale().optional(),
  worker_id: z.number().int().nullable().optional(),
  placement_md: z.string().max(20_000).optional(),
});

const weekdays = z.array(z.number().int().min(0).max(6)).min(1).max(7).transform((d) => [...new Set(d)].sort());
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time: HH:MM, 24-hour');

export const scheduleInput = z.object({
  name: z.string().trim().min(1).max(100),
  at_time: hhmm,
  days: weekdays.default([0, 1, 2, 3, 4, 5, 6]),
  scope_md: z.string().max(20_000).default(''),
  max_batches: z.number().int().min(1).max(10).default(1),
  options: runOptions.default(DEFAULT_RUN_OPTIONS),
  enabled: z.boolean().default(true),
});
export const schedulePatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  at_time: hhmm.optional(),
  days: weekdays.optional(),
  scope_md: z.string().max(20_000).optional(),
  max_batches: z.number().int().min(1).max(10).optional(),
  options: runOptions.optional(),
  enabled: z.boolean().optional(),
});

export const repoInput = z.object({
  github_owner: z.string().min(1),
  github_name: z.string().min(1),
  local_path: z.string().nullable().default(null),
  worktree_from: z.enum(['repo', 'clone']).nullable().default(null),
  setup_command: z.string().nullable().default(null),
  default_branch: z.string().min(1).default('main'),
  check_command: z.string().nullable().default(null),
});

export const itemInput = z.object({
  type: z.enum(ITEM_TYPES).default('backlog'),
  title: z.string().min(1).max(200),
  body_md: z.string().default(''),
  status: z.enum(ITEM_STATUSES).default('backlog'),
  importance: z.number().int().min(1).max(4).default(2),
  effort: z.number().int().min(0).nullable().default(null),
  source_id: z.number().int().nullable().default(null),
  labels: tagList.default([]),
  modules: tagList.default([]),
});
export const itemPatch = z.object({
  type: z.enum(ITEM_TYPES).optional(),
  title: z.string().min(1).max(200).optional(),
  body_md: z.string().optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  importance: z.number().int().min(1).max(4).optional(),
  effort: z.number().int().min(0).nullable().optional(),
  source_id: z.number().int().nullable().optional(),
  labels: tagList.optional(),
  modules: tagList.optional(),
  marked: z.boolean().optional(),
  sort_order: z.number().optional(),
});

export const repoPatch = z.object({
  github_owner: z.string().min(1).optional(),
  github_name: z.string().min(1).optional(),
  default_branch: z.string().min(1).optional(),
  check_command: z.string().nullable().optional(),
  worktree_from: z.enum(['repo', 'clone']).nullable().optional(),
  setup_command: z.string().nullable().optional(),
  read_dirs: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
});

/** A folder inside the repo: relative, no "..", no leading "/" or "~". */
export const isRepoSubdir = (d: string) => !/^[/~]/.test(d) && !d.split(/[/\\]/).includes('..') && !/^[A-Za-z]:/.test(d);

export const sourcePatch = z.object({
  kind: z.enum(SOURCE_KINDS).optional(),
  title: z.string().min(1).optional(),
  body_md: z.string().optional(),
  reporter: z.string().nullable().optional(),
  version_tag: z.string().nullable().optional(),
  skill_name: z.string().nullable().optional(),
});

export interface BranchFile { filename: string; status: string; additions: number; deletions: number; patch: string | null }
/** State of a session branch in a local repo (the stand-in for a PR). */
/** `differs`: the branch's tree is not the default branch's (false when only the commits differ, e.g. main was rewritten). */
export interface BranchStatus { exists: boolean; ahead: number; behind: number; merged: boolean; conflicts: boolean; differs: boolean; head_sha: string | null }

export const sourceInput = z.object({
  kind: z.enum(SOURCE_KINDS).default('retro'),
  title: z.string().min(1),
  body_md: z.string().default(''),
  reporter: z.string().nullable().default(null),
  version_tag: z.string().nullable().default(null),
  skill_name: z.string().nullable().default(null),
  /** Optional: items split from this source, created in the same call. */
  items: z.array(proposedItemSchema).default([]),
});

export const batchInput = z.object({
  title: z.string().min(1).max(200).optional(),
  item_ids: z.array(z.number().int()).default([]),
  new_items: z.array(proposedItemSchema).default([]),
  prompt: z.string().default(''),
  force_plan: z.boolean().optional(),
  options: runOptions.optional(),
  /** a worker by name (a planner's proposal names one); options.worker_id wins */
  worker: z.string().optional(),
  /** Set when the batch comes from a planner proposal card. */
  proposal: z.object({ session_id: z.number().int(), event_id: z.number().int() }).optional(),
});

export const plannerInput = z.object({
  prompt: z.string().default(''),
  source_id: z.number().int().nullable().default(null),
  proposal: z.object({ session_id: z.number().int(), event_id: z.number().int() }).optional(),
});

export const answerInput = z.union([
  z.object({ kind: z.literal('question'), answers: z.record(z.string(), z.string()) }),
  z.object({ kind: z.literal('plan_approval'), approve: z.boolean(), feedback: z.string().optional() }),
]);

export const mergeInput = z.object({
  how: z.enum(['github', 'local']),
  method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
});

// ---------- live events (server → browser over SSE) ----------

export type LiveEvent =
  | { t: 'hello' }
  | { t: 'session'; session: Session }
  | { t: 'session_event'; event: SessionEvent }
  | { t: 'input'; input: PendingInput }
  | { t: 'item'; item: Item }
  | { t: 'pr'; pr: PullRequest }
  /** a project, or its repos, changed (lists and the project page refresh) */
  | { t: 'project'; key: string }
  /** finished sessions' leftovers were cleaned up */
  | { t: 'cleanup' }
  /** a notification: open apps show it in the page (devices with the app in focus get no system notification) */
  | { t: 'notice'; notice: { title: string; body: string; url: string; tag?: string } };

export function itemKey(projectKey: string, n: number) {
  return `${projectKey}-${n}`;
}
