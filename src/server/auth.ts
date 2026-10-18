import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import type { Db } from './db.ts';

export const COOKIE = 'dispatch_session';
const MAX_AGE_S = 60 * 60 * 24 * 90;

/** `scrypt:<salt b64>:<hash b64>` — create with `node src/server/hash-password.ts <password>`. No `$`, so it is safe in compose .env files. */
export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('base64')}:${scryptSync(password, salt, 32).toString('base64')}`;
}

function eq(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The app's own sign-in: a password and a signed session cookie. Tokens and the proxy header live in access.ts. */
export class Auth {
  private secret: string;
  private cfg: Config;

  constructor(cfg: Config, db: Db) {
    this.cfg = cfg;
    this.secret = db.setting('session_secret') ?? randomBytes(32).toString('hex');
    db.setSetting('session_secret', this.secret);
  }

  checkPassword(password: string): boolean {
    if (this.cfg.appPasswordHash) {
      const [, salt, hash] = this.cfg.appPasswordHash.split(':');
      return eq(scryptSync(password, Buffer.from(salt, 'base64'), 32), Buffer.from(hash, 'base64'));
    }
    return eq(Buffer.from(password), Buffer.from(this.cfg.appPassword ?? ''));
  }

  issueCookie(reply: FastifyReply) {
    const issued = Date.now().toString();
    const sig = createHmac('sha256', this.secret).update(issued).digest('base64url');
    reply.setCookie(COOKIE, `${issued}.${sig}`, {
      path: '/', httpOnly: true, sameSite: 'lax', maxAge: MAX_AGE_S,
      secure: this.cfg.publicUrl.startsWith('https://'),
    });
  }

  /** A valid, unexpired session cookie from the password login. */
  hasSessionCookie(req: FastifyRequest): boolean {
    const raw = req.cookies[COOKIE];
    if (!raw) return false;
    const [issued, sig] = raw.split('.');
    if (!issued || !sig) return false;
    const want = createHmac('sha256', this.secret).update(issued).digest('base64url');
    return eq(Buffer.from(sig), Buffer.from(want)) && Date.now() - Number(issued) < MAX_AGE_S * 1000;
  }
}
