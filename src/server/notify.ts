import webpush from 'web-push';
import { pushEndpointProblem } from './pushEndpoint.ts';
import type { Bus } from './bus.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { isRemovedUser } from './identity.ts';
import type { Store } from './store.ts';
import type { Users } from './users.ts';
import type { NoticeLogEntry } from '../shared/types.ts';

export interface Notice {
  title: string;
  body: string;
  url: string;
  tag?: string;
  project_id?: number;
  /** the session it is about; its orchestration is found from it (DISP-267) */
  session_id?: number;
  /** the code path that sends it, for the notice log (DISP-267), e.g. `orchestrator.needsOwner` */
  source: string;
}

/** How long the notice log keeps a notice (DISP-267). */
const KEEP_MS = 30 * 24 * 3_600_000;

/**
 * What a step's batch's notice means for its orchestration (DISP-122). routine: news the step's
 * state tells anyway. turn_end: the batch ended its turn. needs_owner: only the owner can act on it.
 */
export type ChildNoticeKind = 'routine' | 'turn_end' | 'needs_owner';

/**
 * Who a notice is for (DISP-65): a user name, several, or nobody named (null, undefined, an empty
 * list), which means the install owner: notices about the install itself, and about work no user started.
 */
export type NoticeTarget = string | null | undefined | (string | null | undefined)[];

/** How long a device's "the app is in focus" lasts without a renewal (the app renews it every 20 s). */
const ACTIVE_FOR_MS = 45_000;

export class Notifier {
  readonly publicKey: string;
  /** Last notices, for tests and the debug endpoint; `to`: the users they went to. */
  readonly sent: (Notice & { to: string[] })[] = [];
  private store: Store;
  private db: Db;
  private bus: Bus;
  private users: Pick<Users, 'installOwner'>;
  private cfg: Pick<Config, 'authUsers'>;
  /** Devices (push endpoints) that have the app in focus, until when. */
  private active = new Map<string, number>();

  constructor(cfg: Config, db: Db, store: Store, bus: Bus, users: Pick<Users, 'installOwner'>) {
    this.store = store;
    this.db = db;
    this.bus = bus;
    this.users = users;
    this.cfg = cfg;
    let keys = { publicKey: process.env.VAPID_PUBLIC_KEY ?? '', privateKey: process.env.VAPID_PRIVATE_KEY ?? '' };
    if (!keys.publicKey || !keys.privateKey) {
      const saved = db.setting('vapid');
      keys = saved ? JSON.parse(saved) : webpush.generateVAPIDKeys();
      db.setSetting('vapid', JSON.stringify(keys));
    }
    webpush.setVapidDetails(cfg.vapidSubject, keys.publicKey, keys.privateKey);
    this.publicKey = keys.publicKey;
  }

  /** A device of `user` says whether the app has focus there: while it has, it gets no system notification. */
  setActive(endpoint: string, active: boolean, user: string) {
    if (active && this.store.pushSubscriptions(user).some((s) => s.endpoint === endpoint)) this.active.set(endpoint, Date.now() + ACTIVE_FOR_MS);
    else this.active.delete(endpoint);
  }

  activeCount() {
    const now = Date.now();
    for (const [endpoint, until] of this.active) if (until <= now) this.active.delete(endpoint);
    return this.active.size;
  }

  /** Sends one push; tests replace it. The push service's answer, when there is one. */
  deliver = async (endpoint: string, keys: { p256dh: string; auth: string }, payload: string): Promise<unknown> => {
    // checked again: a name can resolve elsewhere now, and rows from before the check exist (DISP-225)
    const problem = await pushEndpointProblem(endpoint);
    if (problem) throw new Error(`push endpoint refused: ${problem}`);
    return webpush.sendNotification({ endpoint, keys }, payload, { TTL: 3600 });
  };

  /** The users a target names; nobody named, or someone taken off AUTH_USERS (DISP-237): the install owner. */
  private targets(to: NoticeTarget): string[] {
    const owner = this.users.installOwner;
    const names = [...new Set((Array.isArray(to) ? to : [to]).map((u) => (isRemovedUser(this.cfg.authUsers, u) ? owner : u)).filter((u): u is string => !!u))];
    return names.length ? names : [owner];
  }

  /** Tells `to` (see NoticeTarget) on every device of theirs, and in their open apps. */
  async send(n: Notice, to?: NoticeTarget) {
    const users = this.targets(to);
    if (n.project_id && this.store.isMuted(n.project_id)) return void this.log(n, users, 'held', 'project muted');
    const id = this.log(n, users, 'app_only', null);
    this.sent.push({ ...n, to: users });
    if (this.sent.length > 50) this.sent.shift();
    const notice = { title: n.title, body: n.body, url: n.url, tag: n.tag };
    // open apps show it themselves (the stream passes it to those users' tabs); devices with the app in focus get no system notification
    this.bus.emit({ t: 'notice', notice, to: users });
    this.activeCount(); // drops expired focus
    const payload = JSON.stringify(notice);
    const subs = users.flatMap((u) => this.store.pushSubscriptions(u));
    const devices: NoticeLogEntry['devices'] = [];
    let pushed = 0;
    await Promise.all(
      subs.map(async (s) => {
        const service = serviceOf(s.endpoint);
        if (this.active.has(s.endpoint)) return void devices.push({ service, result: 'in focus: no push' });
        try {
          const r = await this.deliver(s.endpoint, { p256dh: s.p256dh, auth: s.auth }, payload);
          pushed++;
          devices.push({ service, result: String((r as { statusCode?: number } | undefined)?.statusCode ?? 'sent') });
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          devices.push({ service, result: `failed${code ? ` ${code}` : ''}: ${(e as Error).message}${code === 404 || code === 410 ? ' (device removed)' : ''}`.slice(0, 300) });
          if (code === 404 || code === 410) {
            this.store.removePushSubscription(s.endpoint);
            this.active.delete(s.endpoint);
          }
          else console.warn('push failed', code, (e as Error).message);
        }
      }),
    );
    const reason = pushed ? null : !subs.length ? 'no device gets notifications' : devices.every((d) => d.result.startsWith('in focus')) ? 'the app is in focus on every device' : 'no push went through';
    this.db.run('UPDATE notice_log SET outcome = ?, reason = ?, devices = ? WHERE id = ?', pushed ? 'pushed' : 'app_only', reason, JSON.stringify(devices), id);
  }

  /** A notice that is not sent (DISP-267): only logged, with why (the orchestrator took it, a newer one replaced it). */
  hold(n: Notice, to: NoticeTarget, reason: string) {
    this.log(n, this.targets(to), 'held', reason);
  }

  /** Keep a notice in the log; a pushed one with the same tag is replaced on the devices by this one. Prunes old ones. */
  private log(n: Notice, users: string[], outcome: NoticeLogEntry['outcome'], reason: string | null): number {
    const s = n.session_id ? this.store.session(n.session_id) : undefined;
    const orch = s ? (s.kind === 'orchestrator' ? s.id : s.orchestrator_id ?? null) : null;
    this.db.run('DELETE FROM notice_log WHERE created_at < ?', new Date(Date.now() - KEEP_MS).toISOString());
    const { lastId } = this.db.run(
      'INSERT INTO notice_log (users, title, body, url, tag, project_id, session_id, orchestration_id, source, outcome, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      JSON.stringify(users), n.title, n.body, n.url, n.tag ?? null, n.project_id ?? s?.project_id ?? null, n.session_id ?? null, orch, n.source, outcome, reason,
    );
    if (n.tag && outcome !== 'held') this.db.run("UPDATE notice_log SET replaced_by = ? WHERE tag = ? AND id < ? AND replaced_by IS NULL AND outcome != 'held'", lastId, n.tag, lastId);
    return lastId;
  }

  /**
   * The notice log, newest first. `user`: only notices to them. `session_id`: that session's;
   * `orchestration_id`: the orchestration's own and its batches'.
   */
  notices(f: { user?: string; session_id?: number; orchestration_id?: number; limit?: number }): NoticeLogEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.user !== undefined) { where.push('EXISTS (SELECT 1 FROM json_each(users) WHERE value = ?)'); args.push(f.user); }
    if (f.session_id !== undefined) { where.push('session_id = ?'); args.push(f.session_id); }
    if (f.orchestration_id !== undefined) { where.push('(orchestration_id = ? OR session_id = ?)'); args.push(f.orchestration_id, f.orchestration_id); }
    const rows = this.db.all(`SELECT * FROM notice_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...args, f.limit ?? 200);
    const num = (v: unknown) => (v === null ? null : Number(v));
    return rows.map((r) => ({
      id: Number(r.id), created_at: String(r.created_at), users: JSON.parse(String(r.users)), title: String(r.title), body: String(r.body), url: String(r.url),
      tag: r.tag === null ? null : String(r.tag), project_id: num(r.project_id), session_id: num(r.session_id), orchestration_id: num(r.orchestration_id),
      source: String(r.source), outcome: String(r.outcome) as NoticeLogEntry['outcome'], reason: r.reason === null ? null : String(r.reason),
      devices: JSON.parse(String(r.devices)), replaced_by: num(r.replaced_by),
    }));
  }
}

/** A push endpoint's service, to name a device in the log without its secret URL. */
const serviceOf = (endpoint: string) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
};
