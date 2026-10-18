// Worker records and their tokens. A worker connects to /worker with its secret (dsw_…); only a
// SHA-256 of the secret is kept. The legacy worker (no hash) connects with the server's WORKER_TOKEN.
import { randomBytes } from 'node:crypto';
import type { Db, Row } from './db.ts';
import { now } from './db.ts';
import { sha256 } from './access.ts';
import type { WorkerFacts, WorkerRecord } from '../shared/types.ts';

export const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class WorkerError extends Error {}

function toWorker(r: Row): WorkerRecord {
  return {
    id: Number(r.id),
    name: String(r.name),
    description: String(r.description ?? ''),
    prefix: String(r.prefix ?? ''),
    created_at: String(r.created_at),
    last_seen_at: (r.last_seen_at as string | null) ?? null,
    revoked_at: (r.revoked_at as string | null) ?? null,
    facts: typeof r.facts === 'string' ? (JSON.parse(r.facts) as WorkerFacts) : null,
    legacy: r.hash === null || r.hash === undefined,
  };
}

export class Workers {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  list(): WorkerRecord[] {
    return this.db.all('SELECT * FROM workers WHERE revoked_at IS NULL ORDER BY id').map(toWorker);
  }

  get(id: number): WorkerRecord | undefined {
    const r = this.db.get('SELECT * FROM workers WHERE id = ?', id);
    return r && toWorker(r);
  }

  byName(name: string): WorkerRecord | undefined {
    const r = this.db.get('SELECT * FROM workers WHERE name = ? AND revoked_at IS NULL', name);
    return r && toWorker(r);
  }

  create(name: string, description: string): { worker: WorkerRecord; secret: string } {
    const n = name.trim();
    if (!WORKER_NAME.test(n)) throw new WorkerError('A worker name is lowercase letters, digits and dashes (at most 40).');
    if (this.db.get('SELECT id FROM workers WHERE name = ?', n)) throw new WorkerError(`A worker named "${n}" already exists.`);
    const secret = `dsw_${randomBytes(32).toString('base64url')}`;
    const { lastId } = this.db.run('INSERT INTO workers (name, description, prefix, hash) VALUES (?, ?, ?, ?)', n, description.trim(), secret.slice(0, 10), sha256(secret));
    return { worker: this.get(Number(lastId))!, secret };
  }

  update(id: number, patch: { name?: string; description?: string }): WorkerRecord {
    const w = this.get(id);
    if (!w || w.revoked_at) throw new WorkerError('Unknown worker');
    const name = patch.name?.trim() ?? w.name;
    if (!WORKER_NAME.test(name)) throw new WorkerError('A worker name is lowercase letters, digits and dashes (at most 40).');
    if (name !== w.name && this.db.get('SELECT id FROM workers WHERE name = ?', name)) throw new WorkerError(`A worker named "${name}" already exists.`);
    this.db.run('UPDATE workers SET name = ?, description = ? WHERE id = ?', name, patch.description?.trim() ?? w.description, id);
    return this.get(id)!;
  }

  /** Cut a worker off. The legacy worker is retired by removing WORKER_TOKEN from the server's env. */
  revoke(id: number) {
    const w = this.get(id);
    if (!w) throw new WorkerError('Unknown worker');
    if (w.legacy) throw new WorkerError('The legacy worker connects with WORKER_TOKEN: remove that from the server to retire it.');
    this.db.run('UPDATE workers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), id);
  }

  verify(secret: string): WorkerRecord | null {
    if (!secret.startsWith('dsw_')) return null;
    const r = this.db.get('SELECT * FROM workers WHERE hash = ? AND revoked_at IS NULL', sha256(secret));
    return r ? toWorker(r) : null;
  }

  legacy(): WorkerRecord {
    const r = this.db.get('SELECT * FROM workers WHERE hash IS NULL ORDER BY id LIMIT 1');
    if (r) return toWorker(r);
    const { lastId } = this.db.run("INSERT INTO workers (name) VALUES ('default')");
    return this.get(Number(lastId))!;
  }

  defaultId(): number {
    const set = Number(this.db.setting('default_worker_id'));
    if (set && this.get(set) && !this.get(set)!.revoked_at) return set;
    return this.legacy().id;
  }

  setDefault(id: number) {
    const w = this.get(id);
    if (!w || w.revoked_at) throw new WorkerError('Unknown worker');
    this.db.setSetting('default_worker_id', String(id));
  }

  seen(id: number, facts: WorkerFacts | null) {
    if (facts) this.db.run('UPDATE workers SET last_seen_at = ?, facts = ? WHERE id = ?', now(), JSON.stringify(facts), id);
    else this.db.run('UPDATE workers SET last_seen_at = ? WHERE id = ?', now(), id);
  }
}
