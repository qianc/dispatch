import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readVersion, sameVersion } from '../src/update/version.ts';
import { startServer, waitFor } from './helpers.ts';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-version-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  return dir;
}

describe('which version runs', () => {
  it('a git checkout gives its commit, and its version tag', () => {
    const dir = repo();
    const sha = git(dir, 'rev-parse', 'HEAD');
    expect(readVersion(dir, {})).toEqual({ sha, tag: null, source: 'git' });
    git(dir, 'tag', 'v1.2.0');
    git(dir, 'tag', 'v1.10.0');
    git(dir, 'tag', 'nightly');
    expect(readVersion(dir, { DISPATCH_VERSION: 'abcdef1' })).toEqual({ sha, tag: 'v1.10.0', source: 'git' });
  });

  it('a folder inside another repo is not a checkout of its own', () => {
    const dir = repo();
    const sub = join(dir, 'app');
    execFileSync('mkdir', [sub]);
    expect(readVersion(sub, {})).toEqual({ sha: null, tag: null, source: 'none' });
  });

  it('without git, DISPATCH_VERSION says it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-version-none-'));
    expect(readVersion(dir, { DISPATCH_VERSION: ' ABCDEF1234 ' })).toEqual({ sha: 'abcdef1234', tag: null, source: 'env' });
    expect(readVersion(dir, { DISPATCH_VERSION: 'main' })).toEqual({ sha: null, tag: null, source: 'none' });
    expect(readVersion(dir, {})).toEqual({ sha: null, tag: null, source: 'none' });
  });

  it('a short commit id is the same version as the full one', () => {
    const full = 'a'.repeat(40);
    expect(sameVersion(full, full)).toBe(true);
    expect(sameVersion(full, 'aaaaaaa')).toBe(true);
    expect(sameVersion('AAAAAAA', full)).toBe(true);
    expect(sameVersion(full, 'aaaaaa')).toBe(false); // too short to mean anything
    expect(sameVersion(full, 'b'.repeat(40))).toBe(false);
    expect(sameVersion(null, null)).toBe(false);
    expect(sameVersion(full, undefined)).toBe(false);
  });
});

describe('server and worker tell each other their version', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer();
  });
  afterAll(() => s.app.close());

  it('the server answers a hello with its version, and keeps the worker\'s', async () => {
    s.ctx.version.sha = 'c'.repeat(40);
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/worker`, { headers: { 'x-worker-token': 'test-token' } });
    const got: { t: string; version?: string | null }[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    const version = { sha: 'd'.repeat(40), updatable: false, why: 'Not started through the launcher.' };
    ws.send(JSON.stringify({ t: 'hello', live: [], facts: { os: 'linux', hostname: 'h', slots: 1, free_slots: 1, claude_accounts: [], github_accounts: [], local_repo_dirs: [], caps: ['self_update'], version } }));
    await waitFor(() => got.find((m) => m.t === 'welcome'), 'welcome');
    expect(got.find((m) => m.t === 'welcome')).toEqual({ t: 'welcome', version: 'c'.repeat(40) });
    const list = (await s.call('GET', '/workers')).data.workers;
    expect(list[0].facts.version).toEqual(version);
    ws.close();
  });
});
