import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.ts';

describe('secrets from files (swarm secrets)', () => {
  it('reads NAME_FILE into NAME when NAME is not set, trimming the newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-sec-'));
    writeFileSync(join(dir, 'worker'), 'from-a-file\n');
    writeFileSync(join(dir, 'pw'), 'pw-from-file');
    const cfg = loadConfig({ WORKER_TOKEN_FILE: join(dir, 'worker'), APP_PASSWORD_FILE: join(dir, 'pw') });
    expect(cfg.workerToken).toBe('from-a-file');
    expect(cfg.appPassword).toBe('pw-from-file');
  });

  it('a value set directly wins, and a missing file is an error that names it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-sec-'));
    writeFileSync(join(dir, 'worker'), 'file');
    expect(loadConfig({ WORKER_TOKEN: 'direct', WORKER_TOKEN_FILE: join(dir, 'worker'), APP_PASSWORD: 'x' }).workerToken).toBe('direct');
    expect(() => loadConfig({ WORKER_TOKEN_FILE: '/nonexistent/worker', APP_PASSWORD: 'x' })).toThrow(/WORKER_TOKEN_FILE/);
  });
});

describe('an enterprise GitHub', () => {
  it('git and the API can point at another GitHub', async () => {
    const { startServer } = await import('./helpers.ts');
    const s = await startServer({ GITHUB_TOKEN: 'x', GITHUB_GIT_BASE: 'https://github.example.com', GITHUB_API_URL: 'https://github.example.com/api/v3' });
    try {
      expect(s.ctx.github.gitUrl('team', 'app')).toBe('https://github.example.com/team/app.git');
      expect(s.ctx.github.octo!.request.endpoint.DEFAULTS.baseUrl).toBe('https://github.example.com/api/v3');
    } finally {
      await s.app.close();
    }
  });
});
