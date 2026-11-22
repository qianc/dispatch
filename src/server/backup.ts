// Nightly backup of the server's data: an online copy of the SQLite database (consistent while the
// server runs) and a tarball of the attachments, into a backup folder, keeping `retention` days.
// The database is opened read-only, so a wrong --data folder fails the run instead of backing up a
// new empty file. Retention always keeps the newest KEEP_MIN copies of each kind, whatever their age,
// so failures nobody notices can never leave zero good copies (DISP-135).
//
//   node src/server/backup.ts --data /data --out /backups --at 03:15 --keep 14   # loop, once a night
//   node src/server/backup.ts --data /data --out /backups --once                  # one copy now
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
import { join } from 'node:path';

const KEEP_MIN = 3;
const pad =(n: number) => String(n).padStart(2, '0');
const stampOf = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** Make one backup; returns the files written (names in `outDir`). */
export async function backupOnce(dataDir: string, outDir: string, keepDays: number, now = new Date()): Promise<string[]> {
  const stamp = stampOf(now);
  const made: string[] = [];
  const dbName = `dispatch-db-${stamp}.db`;
  const dbFile = join(dataDir, 'dispatch.db');
  if (!existsSync(dbFile)) throw new Error(`no database at ${dbFile}; check the --data folder`);
  const src = new DatabaseSync(dbFile, { readOnly: true });
  try {
    // to .tmp first, so a partial copy is never mistaken for a good backup
    await backup(src, join(outDir, `${dbName}.tmp`)).catch((e: Error) => {
      throw new Error(`cannot write the copy into ${outDir} (${e.message}); check that the folder exists and is writable`);
    });
    renameSync(join(outDir, `${dbName}.tmp`), join(outDir, dbName));
    made.push(dbName);
  } finally {
    src.close();
  }
  if (existsSync(join(dataDir, 'attachments'))) {
    const tgz = `dispatch-attachments-${stamp}.tgz`;
    execFileSync('tar', ['czf', join(outDir, `${tgz}.tmp`), '-C', dataDir, 'attachments']);
    renameSync(join(outDir, `${tgz}.tmp`), join(outDir, tgz));
    made.push(tgz);
  }
  // hosted repos (the server keeps their only copy unless they push to a GitHub upstream)
  if (existsSync(join(dataDir, 'git'))) {
    const tgz = `dispatch-git-${stamp}.tgz`;
    execFileSync('tar', ['czf', join(outDir, `${tgz}.tmp`), '-C', dataDir, 'git']);
    renameSync(join(outDir, `${tgz}.tmp`), join(outDir, tgz));
    made.push(tgz);
  }
  const cutoff = now.getTime() - keepDays * 86_400_000;
  const files = readdirSync(outDir).filter((f) => f.startsWith('dispatch-'))
    .map((f) => ({ f, mtime: statSync(join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const seen = new Map<string, number>();
  for (const { f, mtime } of files) {
    const kind = f.endsWith('.tmp') ? null : /^dispatch-(db|attachments|git)-/.exec(f)?.[1];
    const rank = kind ? (seen.get(kind) ?? 0) : Infinity;
    if (kind) seen.set(kind, rank + 1);
    if (!made.includes(f) && rank >= KEEP_MIN && mtime < cutoff) rmSync(join(outDir, f));
  }
  return made;
}

/** The next time it is `hh:mm` (local time), after `from`. */
export function nextRun(at: string, from = new Date()): Date {
  const [h, m] = at.split(':').map(Number);
  const next = new Date(from);
  next.setHours(h, m, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

if (import.meta.main) {
  const arg = (name: string, def?: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const data = arg('data', '/data')!;
  const out = arg('out', '/backups')!;
  const keep = Number(arg('keep', '14'));
  const run = async () => {
    try {
      const made = await backupOnce(data, out, keep);
      console.log(`[backup] ${new Date().toISOString()} ok: ${made.join(', ')}`);
    } catch (e) {
      console.error(`[backup] ${new Date().toISOString()} FAILED: ${(e as Error).message}`);
    }
  };
  if (process.argv.includes('--once')) await run();
  else {
    const at = arg('at', '03:15')!;
    console.log(`[backup] daily at ${at}, keeping ${keep} days, from ${data} to ${out}`);
    for (;;) {
      const wait = nextRun(at).getTime() - Date.now();
      await new Promise((r) => setTimeout(r, wait));
      await run();
    }
  }
}
