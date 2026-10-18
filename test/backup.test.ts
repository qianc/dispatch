import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupOnce, nextRun } from '../src/server/backup.ts';

describe('nightly backup', () => {
  it('copies the live database and the attachments, and removes copies older than the retention', async () => {
    const data = mkdtempSync(join(tmpdir(), 'dsp-bk-data-'));
    const out = mkdtempSync(join(tmpdir(), 'dsp-bk-out-'));
    const db = new DatabaseSync(join(data, 'dispatch.db'));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')"); // open, as the server keeps it
    mkdirSync(join(data, 'attachments', 'items', '1'), { recursive: true });
    writeFileSync(join(data, 'attachments', 'items', '1', 'a.png'), 'png');
    const old = join(out, 'dispatch-db-20200101-000000.db');
    writeFileSync(old, 'old');
    utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));

    const made = await backupOnce(data, out, 14, new Date('2026-10-19T01:15:00Z'));
    expect(made.map((f) => f.replace(/\d{8}-\d{6}/, 'STAMP')).sort()).toEqual(['dispatch-attachments-STAMP.tgz', 'dispatch-db-STAMP.db']);
    const copy = new DatabaseSync(join(out, made.find((f) => f.endsWith('.db'))!), { readOnly: true });
    expect(copy.prepare('SELECT v FROM t').all()).toEqual([{ v: 'kept' }]);
    expect(existsSync(old)).toBe(false);
    expect(readdirSync(out).some((f) => f.endsWith('.tmp'))).toBe(false);
    db.close();
  });

  it('runs next at the given local time: today if still ahead, else tomorrow', () => {
    expect(nextRun('03:15', new Date(2026, 9, 19, 1, 0)).getTime()).toBe(new Date(2026, 9, 19, 3, 15).getTime());
    expect(nextRun('03:15', new Date(2026, 9, 19, 4, 0)).getTime()).toBe(new Date(2026, 9, 20, 3, 15).getTime());
  });
});

describe('backup errors', () => {
  it('says which folder it could not write to', async () => {
    const data = mkdtempSync(join(tmpdir(), 'dsp-bk-data-'));
    new DatabaseSync(join(data, 'dispatch.db')).exec('CREATE TABLE t (v TEXT)');
    await expect(backupOnce(data, '/nonexistent/backups', 14)).rejects.toThrow(/cannot write the copy into \/nonexistent\/backups/);
  });
});
