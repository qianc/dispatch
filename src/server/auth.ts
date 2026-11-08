// The app's own sign-in (AUTH_MODE=password, and loopback behind a proxy): a password, and a
// session cookie whose secret is a row in web_sessions (DISP-71). A row can be deleted, so a session
// can be revoked: sign out, "sign out everywhere" in Settings, or a changed password at start.
// Tokens and the proxy header live in access.ts.
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import type { Db } from './db.ts';

export const COOKIE = 'dispatch_session';
const MAX_AGE_S = 60 * 60 * 24 * 90;
const KEY_LEN = 32;

/** `scrypt:<salt b64>:<hash b64>` — create with `node src/server/hash-password.ts <password>`. No `$`, so it is safe in compose .env files. */
export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('base64')}:${scryptSync(password, salt, KEY_LEN).toString('base64')}`;
}

function eq(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verify against hashPassword's format, off the event loop (a flood of wrong passwords must not stall the server). */
function verifyHash(password: string, stored: string): Promise<boolean> {
  const [, salt, hash] = stored.split(':');
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(salt ?? '', 'base64'), KEY_LEN, (err, key) => (err ? reject(err) : resolve(eq(key, Buffer.from(hash ?? '', 'base64')))));
  });
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();

export interface WebSession { id: number; name: string; created_at: string; expires_at: string; last_used_at: string | null }

export class Auth {
  private cfg: Config;
  private db: Db;

  constructor(cfg: Config, db: Db) {
    this.cfg = cfg;
    this.db = db;
    this.endSessionsOfOldPassword();
  }

  /**
   * A changed password ends every session. The password is the operator's env, so the change shows
   * at start: a fingerprint (a salted hash of the password, or of its hash) is kept in settings and
   * compared; a mismatch deletes the sessions. The one sync scrypt here runs once, before listening.
   */
  private endSessionsOfOldPassword() {
    const secret = this.cfg.appPasswordHash ?? this.cfg.appPassword;
    if (!secret) return;
    const fp = this.db.setting('password_fingerprint');
    if (fp) {
      const [, salt, hash] = fp.split(':');
      if (eq(scryptSync(secret, Buffer.from(salt ?? '', 'base64'), KEY_LEN), Buffer.from(hash ?? '', 'base64'))) return;
      const { changes } = this.db.run('DELETE FROM web_sessions');
      if (changes) console.log(`the password changed: ${changes} browser session(s) signed out`);
    }
    this.db.setSetting('password_fingerprint', hashPassword(secret));
  }

  checkPassword(password: string): Promise<boolean> {
    if (this.cfg.appPasswordHash) return verifyHash(password, this.cfg.appPasswordHash);
    return Promise.resolve(eq(Buffer.from(password), Buffer.from(this.cfg.appPassword ?? '')));
  }

  /** A new session for a browser called `name`; the secret goes in the cookie, only its hash is kept. */
  create(name: string): { id: number; secret: string } {
    const secret = `dss_${randomBytes(32).toString('base64url')}`;
    const expires = new Date(Date.now() + MAX_AGE_S * 1000).toISOString();
    const { lastId } = this.db.run('INSERT INTO web_sessions (name, hash, expires_at) VALUES (?, ?, ?)', name, sha256(secret), expires);
    return { id: lastId, secret };
  }

  issueCookie(reply: FastifyReply, name: string) {
    reply.setCookie(COOKIE, this.create(name).secret, {
      path: '/', httpOnly: true, sameSite: 'lax', maxAge: MAX_AGE_S,
      secure: this.cfg.publicUrl.startsWith('https://'),
    });
  }

  /** The live session for a cookie value, or null (unknown, revoked, expired, or a cookie of an earlier version). */
  find(secret: string | undefined): WebSession | null {
    if (!secret?.startsWith('dss_')) return null;
    const row = this.db.get<WebSession>('SELECT id, name, created_at, expires_at, last_used_at FROM web_sessions WHERE hash = ?', sha256(secret));
    if (!row || row.expires_at < now()) return null;
    // a use a minute is plenty for "last used"
    if (!row.last_used_at || Date.parse(row.last_used_at) < Date.now() - 60_000) this.db.run('UPDATE web_sessions SET last_used_at = ? WHERE id = ?', now(), row.id);
    return row;
  }

  /** The password session this request comes from, or null. */
  session(req: FastifyRequest): WebSession | null {
    return this.find(req.cookies?.[COOKIE]);
  }

  /** A valid, unexpired session cookie from the password login. */
  hasSessionCookie(req: FastifyRequest): boolean {
    return this.session(req) !== null;
  }

  /** Live sessions, newest first. */
  sessions(): WebSession[] {
    return this.db.all<WebSession>('SELECT id, name, created_at, expires_at, last_used_at FROM web_sessions WHERE expires_at > ? ORDER BY id DESC', now());
  }

  revoke(id: number) {
    return this.db.run('DELETE FROM web_sessions WHERE id = ?', id).changes > 0;
  }

  /** "Sign out everywhere". Expired rows go with the janitor. */
  revokeAll() {
    return this.db.run('DELETE FROM web_sessions').changes;
  }
}

// ---------- login rate limit ----------

/** wrong passwords an address may try before it waits */
const FREE_FAILURES = 5;
/** the first wait, doubled with every further failure, up to the cap */
const FIRST_WAIT_MS = 30_000;
const MAX_WAIT_MS = 3600_000;
/** an address with no failure for this long is forgotten */
const FORGET_MS = MAX_WAIT_MS;
const MAX_TRACKED = 10_000;

/**
 * Wrong passwords per address (DISP-71): five are free, then the address waits 30 s, 1 min, 2 min, …
 * up to an hour, checked before the password is looked at. In memory: a restart forgives, which is
 * fine, as a restart is slower than the wait.
 */
export class LoginLimiter {
  private failures = new Map<string, { n: number; last: number }>();

  /** Seconds this address must still wait, or 0. */
  wait(ip: string, at = Date.now()): number {
    const f = this.failures.get(ip);
    if (!f || f.n < FREE_FAILURES) return 0;
    const until = f.last + Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (f.n - FREE_FAILURES));
    return until > at ? Math.ceil((until - at) / 1000) : 0;
  }

  failed(ip: string, at = Date.now()) {
    this.prune(at);
    const f = this.failures.get(ip);
    this.failures.set(ip, { n: (f && at - f.last < FORGET_MS ? f.n : 0) + 1, last: at });
  }

  succeeded(ip: string) {
    this.failures.delete(ip);
  }

  private prune(at: number) {
    for (const [ip, f] of this.failures) if (at - f.last > FORGET_MS) this.failures.delete(ip);
    // a flood from many addresses must not grow the map without end: the oldest go first
    while (this.failures.size >= MAX_TRACKED) this.failures.delete(this.failures.keys().next().value!);
  }
}
