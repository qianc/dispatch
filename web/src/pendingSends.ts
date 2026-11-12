// Messages the owner sent that the server has not shown yet (DISP-83). A message is on screen the
// moment it is sent; the reply waits for the server, the chat does not. Each message has a client
// id: the server stores it with the message, so a retry is stored once, and the chat drops the
// pending copy when the message comes back in the session's events.
import { useSyncExternalStore } from 'react';
import type { SessionEvent } from '../../src/shared/types.ts';

/** an image that goes with the message: its uploaded name and the picture on this device */
export interface PendingImage { file: string; preview: string }

export interface Pending {
  client_id: string;
  /** where it shows: `session:<id>`, or a chat that does not exist yet (`assistant:new`) */
  chat: string;
  text: string;
  images: PendingImage[];
  project_keys: string[];
  /** sent: the server has it, and its event is on the way */
  state: 'sending' | 'slow' | 'sent' | 'failed';
  error?: string;
}

export interface SendBody { text: string; images: string[]; client_id: string; project_keys: string[] }
/** Sends the message. Its answer may name the chat the message went to (the first message of a chat). */
export type Post = (body: SendBody) => Promise<{ chat?: string } | void>;

/** after this long with no answer, the message shows "Still sending" */
export const SLOW_MS = 4000;

let entries: Pending[] = [];
const posts = new Map<string, Post>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** per chat: the last send, so the server gets the messages in the order they were written */
const queues = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const EMPTY: Pending[] = [];
let byChat = new Map<string, Pending[]>();

function set(next: Pending[]) {
  entries = next;
  byChat = new Map();
  for (const p of entries) byChat.set(p.chat, [...(byChat.get(p.chat) ?? []), p]);
  listeners.forEach((l) => l());
}
const patch = (id: string, change: Partial<Pending>) => set(entries.map((p) => (p.client_id === id ? { ...p, ...change } : p)));
const find = (id: string) => entries.find((p) => p.client_id === id);

export const pendingOf = (chat: string): Pending[] => byChat.get(chat) ?? EMPTY;

/** The pending messages of a chat, in the order they were sent. */
export function usePending(chat: string): Pending[] {
  const get = () => pendingOf(chat);
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, get, get);
}

function run(id: string) {
  const p = find(id);
  const post = posts.get(id);
  if (!p || !post) return;
  patch(id, { state: 'sending', error: undefined });
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { if (find(id)?.state === 'sending') patch(id, { state: 'slow' }); }, SLOW_MS));
  const chat = p.chat;
  const prev = queues.get(chat) ?? Promise.resolve();
  const body: SendBody = { text: p.text, images: p.images.map((i) => i.file), client_id: id, project_keys: p.project_keys };
  const done = prev.then(() => post(body)).then(
    (r) => {
      if (find(id)) patch(id, { state: 'sent' });
      // the first message made the chat: the messages waiting with it move there too
      const to = r && r.chat;
      if (to && to !== chat) set(entries.map((x) => (x.chat === chat ? { ...x, chat: to } : x)));
    },
    (e: unknown) => { if (find(id)) patch(id, { state: 'failed', error: e instanceof Error ? e.message : String(e) }); },
  ).finally(() => clearTimeout(timers.get(id)));
  queues.set(chat, done);
}

/** Show the message at once and send it. Returns its client id. */
export function sendPending(chat: string, msg: { text: string; images?: PendingImage[]; project_keys?: string[] }, post: Post): string {
  const id = crypto.randomUUID();
  posts.set(id, post);
  set([...entries, { client_id: id, chat, text: msg.text, images: msg.images ?? [], project_keys: msg.project_keys ?? [], state: 'sending' }]);
  run(id);
  return id;
}

/** Send a message that was not sent again, with the same client id: the server stores it once. */
export const retryPending = (id: string) => run(id);

function drop(id: string, revoke: boolean) {
  const p = find(id);
  if (!p) return;
  clearTimeout(timers.get(id));
  timers.delete(id);
  posts.delete(id);
  if (revoke) p.images.forEach((i) => URL.revokeObjectURL?.(i.preview));
  set(entries.filter((x) => x.client_id !== id));
}

/** Take a message that was not sent off the chat, to edit it: its text and images go back to the input. */
export function editPending(id: string): Pending | undefined {
  const p = find(id);
  drop(id, false);
  return p;
}

/** The client ids of the owner's messages the server has stored. */
export const storedIds = (events: SessionEvent[]) =>
  new Set(events.flatMap((e) => (e.body.kind === 'user' && e.body.client_id ? [e.body.client_id] : [])));

/** Drop the pending copies of messages that are in the session's events now. */
export function reconcile(chat: string, events: SessionEvent[]) {
  const stored = storedIds(events);
  for (const p of pendingOf(chat)) if (stored.has(p.client_id)) drop(p.client_id, true);
}

/** For tests: forget everything. */
export function resetPending() {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
  posts.clear();
  queues.clear();
  set([]);
}
