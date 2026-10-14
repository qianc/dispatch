import { z } from 'zod';

// ---------- domain ----------

export const ITEM_TYPES = ['backlog', 'bug'] as const;
export const ITEM_STATUSES = ['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'] as const;
export const SOURCE_KINDS = ['manual', 'retro', 'skill_run', 'user_report', 'agent_session'] as const;
export const SESSION_KINDS = ['work', 'planner'] as const;
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
  labels: string[];
  marked: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: number;
  project_id: number;
  project_key: string;
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
  | { kind: 'tool_result'; tool_use_id: string; is_error: boolean; text: string }
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

export const proposedItemSchema = z.object({
  type: z.enum(ITEM_TYPES).default('backlog'),
  title: z.string().min(1).max(200),
  body_md: z.string().default(''),
  importance: z.number().int().min(1).max(4).default(2),
  effort: z.number().int().min(0).nullable().default(null),
});
export type ProposedItem = z.infer<typeof proposedItemSchema>;

export type Proposal =
  | { type: 'batch'; title: string; item_ids: number[]; new_items: ProposedItem[]; prompt: string; force_plan: boolean }
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
export const projectPatch = projectInput.omit({ key: true }).partial();

export const repoInput = z.object({
  github_owner: z.string().min(1),
  github_name: z.string().min(1),
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
  labels: z.array(z.string()).default([]),
});
export const itemPatch = itemInput.partial().extend({ marked: z.boolean().optional(), sort_order: z.number().optional() });

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
  /** Set when the batch comes from a planner proposal card. */
  proposal: z.object({ session_id: z.number().int(), event_id: z.number().int() }).optional(),
});

export const plannerInput = z.object({
  prompt: z.string().default(''),
  source_id: z.number().int().nullable().default(null),
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
  | { t: 'session'; session: Session }
  | { t: 'session_event'; event: SessionEvent }
  | { t: 'input'; input: PendingInput }
  | { t: 'item'; item: Item }
  | { t: 'pr'; pr: PullRequest };

export function itemKey(projectKey: string, n: number) {
  return `${projectKey}-${n}`;
}
