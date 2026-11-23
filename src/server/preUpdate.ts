// The server's database across its own update (DISP-112). A new version may change the database
// (migrations run at start), and the old code cannot read what it does not know. So a server that
// stops for its own update keeps a copy, and the old version, started again by a rollback, puts
// the copy back when the new version had changed the database. The same for a checkout and for an
// image: the copy lives next to the database.
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sameVersion } from '../update/version.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

const copyFile = (dbFile: string) => `${dbFile}.pre-update`;
const noteFile = (dbFile: string) => `${dbFile}.pre-update.json`;

interface Note { from: string | null; to: string; at: string }

const inMemory = (dbFile: string) => dbFile === ':memory:';

/**
 * Keep a copy of the database as it is now, when the server is about to stop for its own update
 * from `from` to `to`: right before it asks for the stop, not in the shutdown, whose time limit a
 * large copy could outlast (DISP-242).
 */
export function keepCopy(db: DatabaseSync, dbFile: string, update: { from: string | null; to: string }) {
  if (inMemory(dbFile)) return;
  rmSync(copyFile(dbFile), { force: true });
  rmSync(noteFile(dbFile), { force: true });
  // one whole, consistent file, whatever is still in the write-ahead log
  db.prepare('VACUUM INTO ?').run(copyFile(dbFile));
  writeFileSync(noteFile(dbFile), JSON.stringify({ from: update.from, to: update.to, at: new Date().toISOString() } satisfies Note));
}

/** The update is over (logged): the copy is not needed any more. */
export function dropCopy(dbFile: string) {
  if (inMemory(dbFile)) return;
  rmSync(copyFile(dbFile), { force: true });
  rmSync(noteFile(dbFile), { force: true });
}

/** The migrations a database has that `migrationsDir` does not: a newer version made them. */
function unknownMigrations(dbFile: string, migrationsDir: string): string[] {
  const known = new Set(readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')));
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name).filter((n) => !known.has(n));
  } finally {
    db.close();
  }
}

/**
 * Before the database opens: this server runs the old version of an update that did not hold, and
 * the new version changed the database → the copy from before the update is put back. The
 * database the new version left is kept next to it (`.failed-update`). Says what it did, or null.
 */
export function restoreCopy(dbFile: string, runningSha: string | null, migrationsDir = MIGRATIONS_DIR): string | null {
  if (inMemory(dbFile) || !existsSync(copyFile(dbFile)) || !existsSync(noteFile(dbFile)) || !existsSync(dbFile)) return null;
  let n: Note;
  try {
    n = JSON.parse(readFileSync(noteFile(dbFile), 'utf8')) as Note;
  } catch {
    return null;
  }
  // only the version the update came from puts it back; the new version, or any other, leaves it
  if (!runningSha || !sameVersion(runningSha, n.from) || sameVersion(runningSha, n.to)) return null;
  let unknown: string[];
  try {
    unknown = unknownMigrations(dbFile, migrationsDir);
  } catch (e) {
    return `The database could not be read to see whether the failed update changed it: ${(e as Error).message}`;
  }
  if (!unknown.length) return null;
  for (const ext of ['', '-wal', '-shm']) {
    rmSync(`${dbFile}.failed-update${ext}`, { force: true });
    if (existsSync(`${dbFile}${ext}`)) renameSync(`${dbFile}${ext}`, `${dbFile}.failed-update${ext}`);
  }
  copyFileSync(copyFile(dbFile), dbFile);
  return `The update to ${n.to.slice(0, 7)} changed the database (${unknown.join(', ')}) and did not hold: the database from before the update is back. The changed one is kept as ${dbFile}.failed-update.`;
}
