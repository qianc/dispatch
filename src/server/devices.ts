// Paired devices. A phone's home-screen app may be unable to use the sign-in proxy's SSO (on iOS a
// web app runs in its own browser context, which a managed-browser-only policy turns away). It pairs
// instead, like a device-code login:
//   1. the app asks for a pairing (POST /api/devices/pair) and shows the short code
//   2. a person signed in through the proxy (or the password) enters the code in Settings
//   3. the app's poll collects a device cookie, once; the device then acts as that person
// Device sessions last DEVICE_DAYS, are listed in Settings and can be revoked there.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Db } from './db.ts';

export const DEVICE_COOKIE = 'dispatch_device';
export const DEVICE_DAYS = 90;
const PAIR_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;
/** no 0/O, 1/I/L: read off a phone and typed on a desktop */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface Device {
  id: number;
  name: string;
  user: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
}

interface Pending { code: string; name: string; expires: number; secret: string | null }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A short name for the device from its user agent, e.g. "iPhone". */
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  for (const [re, name] of [[/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'], [/Macintosh/, 'Mac'], [/Windows/, 'Windows'], [/Linux/, 'Linux']] as const) {
    if (re.test(ua)) return name;
  }
  return 'Device';
}

export class Devices {
  private db: Db;
  /** pair_id → pending pairing; short-lived, so memory is enough (a restart just means pairing again) */
  private pending = new Map<string, Pending>();

  constructor(db: Db) {
    this.db = db;
  }

  private prune() {
    const t = Date.now();
    for (const [id, p] of this.pending) if (p.expires < t) this.pending.delete(id);
    // nobody can approve without signing in, but keep a flood of requests from growing the map
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
  }

  start(name: string): { pair_id: string; code: string; expires_at: string } {
    this.prune();
    const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const pairId = randomBytes(24).toString('base64url');
    const expires = Date.now() + PAIR_TTL_MS;
    this.pending.set(pairId, { code: raw, name, expires, secret: null });
    return { pair_id: pairId, code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expires_at: new Date(expires).toISOString() };
  }

  /** Approve the pairing showing this code; the device acts as `user`. Null when no live pairing has it. */
  approve(code: string, user: string): Device | null {
    this.prune();
    const want = normalize(code);
    const p = [...this.pending.values()].find((x) => x.code === want && !x.secret);
    if (!p) return null;
    p.secret = `dsd_${randomBytes(32).toString('base64url')}`;
    const expires = new Date(Date.now() + DEVICE_DAYS * 86_400_000).toISOString();
    const { lastId } = this.db.run('INSERT INTO devices (name, user, hash, expires_at) VALUES (?, ?, ?, ?)', p.name, user, sha256(p.secret), expires);
    return this.list().find((d) => d.id === Number(lastId))!;
  }

  /** The phone's poll: its secret once approved (then the pairing is gone). */
  collect(pairId: string): { status: 'pending' } | { status: 'expired' } | { status: 'approved'; secret: string } {
    this.prune();
    const p = this.pending.get(pairId);
    if (!p) return { status: 'expired' };
    if (!p.secret) return { status: 'pending' };
    this.pending.delete(pairId);
    return { status: 'approved', secret: p.secret };
  }

  /** The live device for a cookie value, or null. */
  find(secret: string | undefined): (Device & { id: number }) | null {
    if (!secret?.startsWith('dsd_')) return null;
    const row = this.db.get<Device & { revoked_at: string | null }>('SELECT * FROM devices WHERE hash = ?', sha256(secret));
    if (!row || row.revoked_at || row.expires_at < now()) return null;
    // a use a minute is plenty for "last used"
    if (!row.last_used_at || Date.parse(row.last_used_at) < Date.now() - 60_000) this.db.run('UPDATE devices SET last_used_at = ? WHERE id = ?', now(), row.id);
    return row;
  }

  /** Live devices: all, or only those `user` approved. */
  list(user?: string): Device[] {
    return this.db.all<Device>(
      `SELECT id, name, user, created_at, expires_at, last_used_at FROM devices WHERE revoked_at IS NULL AND expires_at > ?${user === undefined ? '' : ' AND user = ?'} ORDER BY id DESC`,
      now(), ...(user === undefined ? [] : [user]),
    );
  }

  /** Who a device acts as (live or not), or undefined. */
  userOf(id: number): string | undefined {
    return this.db.get<{ user: string }>('SELECT user FROM devices WHERE id = ?', id)?.user;
  }

  revoke(id: number) {
    this.db.run('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), id);
  }

  /** tests: let every pending pairing run out */
  expireAll() {
    for (const p of this.pending.values()) p.expires = 0;
  }
}
