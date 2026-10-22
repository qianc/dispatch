import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/worker/config.ts';

describe('worker config', () => {
  it("without a file, today's environment is a config with one server", () => {
    const cfg = loadWorkerConfig({ SERVER_WS_URL: 'ws://192.0.2.1:3000/worker', WORKER_TOKEN: 't0k', LOCAL_REPO_DIRS: '~/projects:/srv/repos', ASSISTANT_READ_DIRS: '~/notes', MAX_CONCURRENT_SESSIONS: '2' });
    expect(cfg).toEqual({
      max_concurrent: 2,
      servers: [{
        name: 'default', url: 'ws://192.0.2.1:3000/worker', token: 't0k',
        local_repo_dirs: [join(homedir(), 'projects'), '/srv/repos'], read_dirs: [join(homedir(), 'notes')],
        claude_accounts: null, github_accounts: null, releases: [],
      }],
    });
    expect(loadWorkerConfig({ WORKER_TOKEN: 'x' }).max_concurrent).toBe(3);
    expect(() => loadWorkerConfig({})).toThrow(/WORKER_TOKEN/);
  });

  it('reads several servers from WORKER_CONFIG, tokens inline or from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-wcfg-'));
    writeFileSync(join(dir, 'work.token'), 'dsw_work_secret\n');
    writeFileSync(join(dir, 'worker.json'), JSON.stringify({
      max_concurrent: 4,
      servers: [
        { name: 'home', url: 'wss://dispatch.example.com/worker', token: 'dsw_home', local_repo_dirs: ['~/projects'], read_dirs: [] },
        { name: 'work', url: 'wss://dispatch.work.example/worker', token_file: join(dir, 'work.token'), local_repo_dirs: ['/srv/work'], claude_accounts: ['work'], github_accounts: ['work'] },
      ],
    }));
    const cfg = loadWorkerConfig({ WORKER_CONFIG: join(dir, 'worker.json') });
    expect(cfg.max_concurrent).toBe(4);
    expect(cfg.servers.map((s) => [s.name, s.token, s.claude_accounts])).toEqual([['home', 'dsw_home', null], ['work', 'dsw_work_secret', ['work']]]);
    expect(cfg.servers[1].read_dirs).toEqual([]);
  });

  it('refuses bad names, duplicate names and servers without a token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-wcfg-'));
    const write = (o: unknown) => {
      writeFileSync(join(dir, 'w.json'), JSON.stringify(o));
      return () => loadWorkerConfig({ WORKER_CONFIG: join(dir, 'w.json') });
    };
    expect(write({ servers: [{ name: 'Home', url: 'ws://x', token: 't' }] })).toThrow(/name/);
    expect(write({ servers: [{ name: 'a', url: 'ws://x', token: 't' }, { name: 'a', url: 'ws://y', token: 't' }] })).toThrow(/twice/);
    expect(write({ servers: [{ name: 'a', url: 'ws://x' }] })).toThrow(/token/);
    expect(write({ servers: [] })).toThrow(/at least one/);
  });

  it('reads the releases a server may start, from the file or RELEASES', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-wcfg-'));
    writeFileSync(join(dir, 'w.json'), JSON.stringify({ servers: [{ name: 'a', url: 'ws://x', token: 't', releases: [
      { repo: 'me/app', label_prefix: 'rel:', command: './release.sh {version} --yes', notes: 'The credential is here.' },
      { repo: '~/projects/tool/', label_prefix: 'convert:' },
    ] }, { name: 'b', url: 'ws://y', token: 't' }] }));
    const cfg = loadWorkerConfig({ WORKER_CONFIG: join(dir, 'w.json'), HOME: '/home/me' });
    expect(cfg.servers[0].releases).toEqual([
      { repo: 'me/app', label_prefix: 'rel:', command: './release.sh {version} --yes', notes: 'The credential is here.' },
      { repo: '/home/me/projects/tool', label_prefix: 'convert:', command: null, notes: null },
    ]);
    expect(cfg.servers[1].releases).toEqual([]);
    const env = loadWorkerConfig({ WORKER_TOKEN: 't', RELEASES: '[{"repo":"app"}]' });
    expect(env.servers[0].releases).toEqual([{ repo: 'app', label_prefix: 'rel:', command: null, notes: null }]);
    expect(() => loadWorkerConfig({ WORKER_TOKEN: 't', RELEASES: '[{"repo":"app","label_prefix":""}]' })).toThrow();
  });
});
