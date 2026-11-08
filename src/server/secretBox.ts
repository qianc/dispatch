// Secrets kept in the database (people's GitHub tokens, DISP-63) are sealed with AES-256-GCM.
// The key is DISPATCH_SECRET_KEY (or _FILE). Without it, Dispatch makes a key file `secret.key`
// (0600) beside the database, so a copy of the database alone does not give the tokens away; the
// owner sees in Settings that the key lives next to the data.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.ts';
import type { Db } from './db.ts';

const VERSION = 'v1.';
const IV = 12;
const TAG = 16;

/** 64 hex characters or base64 of 32 bytes; null when it is neither. */
function parseKey(text: string): Buffer | null {
  const t = text.trim();
  if (/^[0-9a-f]{64}$/i.test(t)) return Buffer.from(t, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(t)) {
    const b = Buffer.from(t, 'base64');
    if (b.length === 32) return b;
  }
  return null;
}

/**
 * The key for secrets in the database: DISPATCH_SECRET_KEY, else `secret.key` beside the database
 * (made on first start), else (an in-memory database, in tests) a random key for this run.
 * `generatedFile`: the key file Dispatch made and uses, or null.
 */
export function loadKey(cfg: Pick<Config, 'secretKey'>, dbFile: string): { key: Buffer; generatedFile: string | null } {
  if (cfg.secretKey) {
    const key = parseKey(cfg.secretKey);
    if (!key) throw new Error('DISPATCH_SECRET_KEY must be 64 hex characters or base64 of 32 bytes (e.g. `openssl rand -hex 32`).');
    return { key, generatedFile: null };
  }
  if (dbFile === ':memory:') return { key: randomBytes(32), generatedFile: null };
  const file = join(dirname(dbFile), 'secret.key');
  try {
    writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    console.warn(`Made a key for secrets in the database: ${file}. Set DISPATCH_SECRET_KEY to keep the key apart from the data.`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`Cannot make the secret key file ${file}: ${(e as Error).message}`);
  }
  if (statSync(file).mode & 0o077) console.warn(`${file} can be read by other users of this machine: chmod 600 it.`);
  const key = parseKey(readFileSync(file, 'utf8'));
  if (!key) throw new Error(`${file} does not hold a key (64 hex characters). Restore it, or delete it and connect GitHub again.`);
  return { key, generatedFile: file };
}

/** Seals short secrets. `aad` binds a sealed value to its place (e.g. "github:alice"). */
export class SecretBox {
  private key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox needs a 32-byte key');
    this.key = key;
  }

  seal(plain: string, aad: string): string {
    const iv = randomBytes(IV);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return VERSION + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
  }

  /** The plain text; throws when the value was changed, sealed with another key or for another place. */
  open(sealed: string, aad: string): string {
    if (!sealed.startsWith(VERSION)) throw new Error('unknown sealed value');
    const raw = Buffer.from(sealed.slice(VERSION.length), 'base64url');
    if (raw.length < IV + TAG) throw new Error('sealed value too short');
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(raw.subarray(IV, IV + TAG));
    return Buffer.concat([d.update(raw.subarray(IV + TAG)), d.final()]).toString('utf8');
  }
}

const CHECK = 'dispatch';

/**
 * Is this the key the database's secrets were sealed with? A check value in the settings tells.
 * false: the key changed (the old secrets cannot be read); the check is sealed again with this key.
 */
export function keyMatches(db: Db, box: SecretBox): boolean {
  const check = db.setting('secret_key_check');
  let ok = true;
  if (check) {
    try {
      ok = box.open(check, 'check') === CHECK;
    } catch {
      ok = false;
    }
  }
  if (!check || !ok) db.setSetting('secret_key_check', box.seal(CHECK, 'check'));
  return ok;
}
