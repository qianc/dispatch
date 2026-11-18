import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../src/server/db.ts';
import { dropCopy, keepCopy, restoreCopy } from '../src/server/preUpdate.ts';

const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);

/** A database as the old version leaves it when it stops for its update: with a copy next to it. */
function stopped() {
  const file = join(mkdtempSync(join(tmpdir(), 'dsp-preupdate-')), 'dispatch.db');
  const db = new Db(file);
  db.setSetting('mark', 'before the update');
  keepCopy(db.raw, file, { from: OLD, to: NEW });
  db.raw.close();
  return file;
}

/** What the new version does at its start: `migration` (a file the old code does not have), and some writing. */
function newVersionRan(file: string, migration: string | null) {
  const db = new Db(file);
  if (migration) db.run('INSERT INTO _migrations (name) VALUES (?)', migration);
  db.setSetting('mark', 'written by the new version');
  db.raw.close();
}

const mark = (file: string) => {
  const db = new Db(file);
  try {
    return db.setting('mark');
  } finally {
    db.raw.close();
  }
};

describe('the server\'s database across its own update (DISP-112)', () => {
  it('the old version puts the copy back when the new version changed the database', () => {
    const file = stopped();
    newVersionRan(file, '999_from_the_future.sql');
    const said = restoreCopy(file, OLD);
    expect(said).toContain('999_from_the_future.sql');
    expect(mark(file)).toBe('before the update');
    // what the new version left is kept for a look
    expect(existsSync(`${file}.failed-update`)).toBe(true);
    // the copy stays until the update is logged; the old version's own migrations are all known, so nothing more happens
    expect(restoreCopy(file, OLD)).toBeNull();
    dropCopy(file);
    expect(existsSync(`${file}.pre-update`)).toBe(false);
    expect(existsSync(`${file}.pre-update.json`)).toBe(false);
  });

  it('a database the new version did not change is left as it is', () => {
    const file = stopped();
    newVersionRan(file, null);
    expect(restoreCopy(file, OLD)).toBeNull();
    expect(mark(file)).toBe('written by the new version');
  });

  it('the new version, and any other, leaves it alone', () => {
    const file = stopped();
    newVersionRan(file, '999_from_the_future.sql');
    expect(restoreCopy(file, NEW)).toBeNull();
    expect(restoreCopy(file, 'c'.repeat(40))).toBeNull();
    expect(restoreCopy(file, null)).toBeNull();
    expect(mark(file)).toBe('written by the new version');
  });

  it('a short commit id (an image) is the same version', () => {
    const file = stopped();
    newVersionRan(file, '999_from_the_future.sql');
    expect(restoreCopy(file, OLD.slice(0, 7))).toContain('is back');
    expect(mark(file)).toBe('before the update');
  });

  it('without a copy nothing happens, and a database in memory has none', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dsp-preupdate-')), 'dispatch.db');
    new Db(file).raw.close();
    expect(restoreCopy(file, OLD)).toBeNull();
    const mem = new Db(':memory:');
    keepCopy(mem.raw, ':memory:', { from: OLD, to: NEW });
    expect(restoreCopy(':memory:', OLD)).toBeNull();
    dropCopy(':memory:');
    mem.raw.close();
  });
});
