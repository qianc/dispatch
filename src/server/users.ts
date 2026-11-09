// People who use this install (DISP-63). A user row appears the first time someone signs in. The
// install owner inherits everything from before users: claim() gives them every row that belongs to
// nobody, once. Read the owner here (installOwner), not from the config: in proxy mode without
// DISPATCH_OWNER or AUTH_USERS the first person signed in through the proxy becomes it (adopt()).
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { now } from './db.ts';
import { Workers } from './workers.ts';

export interface User {
  name: string;
  default_worker_id: number | null;
  created_at: string;
  last_seen_at: string | null;
}

/** Owners from before DISPATCH_OWNER was set: the single user's stand-in names. */
const PLACEHOLDERS = ['owner', 'local'];

/** Every column that names the person a row belongs to. */
const OWNER_COLUMNS = [['workers', 'owner'], ['api_tokens', 'user'], ['schedules', 'owner'], ['sessions', 'started_by'], ['devices', 'user'], ['oauth_grants', 'user'], ['push_subscriptions', 'user']] as const;

export class Users {
  private db: Db;
  private owner: string;
  /** the owner is still a placeholder, for the first person signed in through the proxy to take */
  private adoptable: boolean;
  /** name → when last_seen_at was last written (a write a minute is plenty) */
  private seen = new Map<string, number>();

  constructor(db: Db, cfg: Pick<Config, 'installOwner'> & Partial<Pick<Config, 'adoptOwner'>>) {
    this.db = db;
    this.owner = cfg.installOwner;
    this.adoptable = !!cfg.adoptOwner;
  }

  /** Give rows from before users to the install owner; move them on when the owner gets a real name. */
  claim() {
    const was = this.db.setting('install_owner');
    if (this.adoptable) {
      // taken before: that person stays the owner
      if (was !== undefined && !PLACEHOLDERS.includes(was)) {
        this.owner = was;
        this.adoptable = false;
        return;
      }
      console.warn('AUTH_MODE=proxy without DISPATCH_OWNER or AUTH_USERS: the first person to sign in through the proxy becomes the install owner. Set DISPATCH_OWNER to your user name to choose.');
    }
    if (was === this.owner) return;
    if (was === undefined) {
      this.db.tx(() => {
        // devices and grants always had a user: only the single user's placeholder names change
        for (const [table, col] of OWNER_COLUMNS) {
          if (table === 'devices' || table === 'oauth_grants') this.db.run(`UPDATE ${table} SET ${col} = ? WHERE ${col} IN (?, ?)`, this.owner, ...PLACEHOLDERS);
          else this.db.run(`UPDATE ${table} SET ${col} = ? WHERE ${col} IS NULL`, this.owner);
        }
        const def = Number(this.db.setting('default_worker_id'));
        const worker = def && this.db.get('SELECT id FROM workers WHERE id = ?', def) ? def : null;
        this.db.run('INSERT INTO users (name, default_worker_id) VALUES (?, ?) ON CONFLICT(name) DO NOTHING', this.owner, worker);
        this.db.setSetting('install_owner', this.owner);
      });
      return;
    }
    if (!PLACEHOLDERS.includes(was)) {
      console.warn(`The install owner was "${was}" and is now "${this.owner}": rows stay with "${was}". Set DISPATCH_OWNER=${was} to keep the old owner.`);
      return;
    }
    this.moveFrom(was);
  }

  /** Every row of the placeholder owner `was` goes to the install owner, who then is the one on record. */
  private moveFrom(was: string) {
    this.db.tx(() => {
      for (const [table, col] of OWNER_COLUMNS) this.db.run(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, this.owner, was);
      const old = this.db.get<{ default_worker_id: number | null }>('SELECT default_worker_id FROM users WHERE name = ?', was);
      this.db.run('DELETE FROM users WHERE name = ?', was);
      this.db.run(
        'INSERT INTO users (name, default_worker_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET default_worker_id = COALESCE(users.default_worker_id, excluded.default_worker_id)',
        this.owner, old?.default_worker_id ?? null,
      );
      this.db.setSetting('install_owner', this.owner);
    });
  }

  /**
   * Someone signed in through the proxy. While the install owner is still a placeholder (proxy mode
   * without DISPATCH_OWNER or AUTH_USERS), the first such person becomes it and gets its rows.
   */
  adopt(name: string) {
    if (!this.adoptable || !name || PLACEHOLDERS.includes(name)) return;
    const was = this.owner;
    this.owner = name;
    this.adoptable = false;
    this.moveFrom(was);
    console.warn(`${name} is the install owner: the first person to sign in through the proxy. Set DISPATCH_OWNER=${name} to make it explicit.`);
  }

  /** A signed-in person was here: their row, and last_seen_at at most once a minute. */
  touch(name: string) {
    const t = Date.now();
    if ((this.seen.get(name) ?? 0) > t - 60_000) return;
    this.seen.set(name, t);
    this.db.run('INSERT INTO users (name, last_seen_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_seen_at = excluded.last_seen_at', name, now());
  }

  /** the install owner's name */
  get installOwner(): string {
    return this.owner;
  }

  isOwner(name: string | null | undefined): boolean {
    return !!name && name === this.owner;
  }

  /** Whose tokens, devices and apps `name` manages: their own, or everyone's (undefined) for the install owner. */
  manages(name: string | null): string | undefined {
    return this.isOwner(name) ? undefined : name ?? '';
  }

  /**
   * The user's own default worker: the one they picked, if it is still live and theirs, else their
   * first worker. The install owner falls back to the install's default (the legacy worker).
   * null: the user has no worker.
   */
  defaultWorker(name: string): number | null {
    const own = (id: number | null | undefined) =>
      !!id && !!this.db.get('SELECT id FROM workers WHERE id = ? AND owner = ? AND revoked_at IS NULL', id, name);
    const picked = this.db.get<{ default_worker_id: number | null }>('SELECT default_worker_id FROM users WHERE name = ?', name)?.default_worker_id;
    if (own(picked)) return picked!;
    if (this.isOwner(name)) return new Workers(this.db).defaultId();
    return this.db.get<{ id: number }>('SELECT id FROM workers WHERE owner = ? AND revoked_at IS NULL ORDER BY id LIMIT 1', name)?.id ?? null;
  }

  setDefaultWorker(name: string, id: number | null) {
    this.db.run('INSERT INTO users (name, default_worker_id) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET default_worker_id = excluded.default_worker_id', name, id);
  }

  list(): User[] {
    return this.db.all<User>('SELECT name, default_worker_id, created_at, last_seen_at FROM users ORDER BY name');
  }
}
