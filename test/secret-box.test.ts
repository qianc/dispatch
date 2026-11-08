import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretBox, loadKey } from '../src/server/secretBox.ts';
import { loadConfig } from '../src/server/config.ts';

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32));

  it('opens what it sealed, and the sealed text holds no plain text', () => {
    const sealed = box.seal('ghp_secret123', 'github:alice');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('ghp_secret123');
    expect(box.open(sealed, 'github:alice')).toBe('ghp_secret123');
    // a fresh IV every time
    expect(box.seal('ghp_secret123', 'github:alice')).not.toBe(sealed);
  });

  it("is bound to its user: another user's aad cannot open it", () => {
    const sealed = box.seal('ghp_secret123', 'github:alice');
    expect(() => box.open(sealed, 'github:bob')).toThrow();
  });

  it('detects tampering and a wrong key', () => {
    const sealed = box.seal('ghp_secret123', 'github:alice');
    const raw = Buffer.from(sealed.slice(3), 'base64url');
    raw[raw.length - 1] ^= 1;
    expect(() => box.open(`v1.${raw.toString('base64url')}`, 'github:alice')).toThrow();
    expect(() => box.open('v2.' + sealed.slice(3), 'github:alice')).toThrow();
    expect(() => new SecretBox(randomBytes(32)).open(sealed, 'github:alice')).toThrow();
  });
});

describe('loadKey', () => {
  const dirs: string[] = [];
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'dsp-key-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates secret.key beside the database (0600) and reuses it', () => {
    const d = dir();
    const first = loadKey({ secretKey: null }, join(d, 'dispatch.db'));
    expect(first.generatedFile).toBe(join(d, 'secret.key'));
    expect(first.key.length).toBe(32);
    expect(statSync(join(d, 'secret.key')).mode & 0o777).toBe(0o600);
    const again = loadKey({ secretKey: null }, join(d, 'dispatch.db'));
    expect(again.key.equals(first.key)).toBe(true);
    expect(again.generatedFile).toBe(join(d, 'secret.key'));
  });

  it('warns when the key file is readable by others', () => {
    const d = dir();
    loadKey({ secretKey: null }, join(d, 'dispatch.db'));
    chmodSync(join(d, 'secret.key'), 0o644);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadKey({ secretKey: null }, join(d, 'dispatch.db'));
    expect(warn.mock.calls.flat().join(' ')).toMatch(/secret\.key/);
  });

  it('takes DISPATCH_SECRET_KEY as 64 hex characters or base64 of 32 bytes', () => {
    const k = randomBytes(32);
    const d = dir();
    const hex = loadKey({ secretKey: k.toString('hex') }, join(d, 'dispatch.db'));
    expect(hex.key.equals(k)).toBe(true);
    expect(hex.generatedFile).toBeNull();
    expect(loadKey({ secretKey: k.toString('base64') }, join(d, 'dispatch.db')).key.equals(k)).toBe(true);
    // no key file is made when the env has the key
    expect(() => statSync(join(d, 'secret.key'))).toThrow();
  });

  it('refuses a bad DISPATCH_SECRET_KEY', () => {
    const d = dir();
    for (const bad of ['short', 'z'.repeat(64), randomBytes(16).toString('base64'), randomBytes(31).toString('hex')]) {
      expect(() => loadKey({ secretKey: bad }, join(d, 'dispatch.db'))).toThrow(/DISPATCH_SECRET_KEY/);
    }
  });

  it('reads DISPATCH_SECRET_KEY_FILE', () => {
    const d = dir();
    const k = randomBytes(32).toString('hex');
    writeFileSync(join(d, 'key'), `${k}\n`);
    const cfg = loadConfig({ WORKER_TOKEN: 'w', DISABLE_AUTH: '1', DISPATCH_SECRET_KEY_FILE: join(d, 'key') });
    expect(cfg.secretKey).toBe(k);
    expect(loadKey(cfg, join(d, 'dispatch.db')).key.toString('hex')).toBe(k);
  });

  it('an in-memory database gets a random in-memory key', () => {
    const a = loadKey({ secretKey: null }, ':memory:');
    expect(a.generatedFile).toBeNull();
    expect(a.key.length).toBe(32);
    expect(loadKey({ secretKey: null }, ':memory:').key.equals(a.key)).toBe(false);
  });
});
