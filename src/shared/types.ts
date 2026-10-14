import { z } from 'zod';

// ---------- domain ----------

export const ITEM_TYPES = ['backlog', 'bug'] as const;
export const ITEM_STATUSES = ['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'] as const;
export const SOURCE_KINDS = ['manual', 'retro', 'skill_run', 'user_report', 'agent_session'] as const;
export const SESSION_KINDS = ['work', 'planner', 'assistant', 'discuss'] as const;
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
  item_ids: number[];
  created_at: string;
  updated_at: string;
  ended_at: string | null;
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
  | { type: 'batch'; project_key?: string; title: string; item_ids: number[]; new_items: ProposedItem[]; prompt: string; force_plan: boolean }
  | { type: 'planner'; project_key: string; prompt: string }
  | { type: 'items'; source_id: number | null; items: ProposedItem[] };

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
}

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
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  default_force_plan: z.boolean().optional(),
  importance_scale: scale(4).optional(),
  effort_scale: scale().optional(),
});

export const repoInput = z.object({
  github_owner: z.string().min(1),
  github_name: z.string().min(1),
  local_path: z.string().nullable().default(null),
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
});

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
export interface BranchStatus { exists: boolean; ahead: number; behind: number; merged: boolean; conflicts: boolean; head_sha: string | null }

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
  | { t: 'pr'; pr: PullRequest };

export function itemKey(projectKey: string, n: number) {
  return `${projectKey}-${n}`;
}
