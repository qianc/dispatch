import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeMessage, redactPrivate } from '../src/shared/mergeMessage.ts';
import type { Repo } from '../src/shared/types.ts';
import { Workspaces } from '../src/worker/workspace.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).trim();

describe('merge message (DISP-57)', () => {
  it('names the items, not the branch, and drops the keys the title starts with', () => {
    expect(mergeMessage(['DISP-5'], 'DISP-5 Fix the thing')).toBe('Merge DISP-5: Fix the thing');
    expect(mergeMessage(['DISP-5', 'DISP-6'], 'DISP-5, DISP-6')).toBe('Merge DISP-5, DISP-6');
    expect(mergeMessage(['DISP-5', 'DISP-6'], 'Two fixes')).toBe('Merge DISP-5, DISP-6: Two fixes');
    expect(mergeMessage(['DISP-5'], 'DISP-50 Other')).toBe('Merge DISP-5: DISP-50 Other');
    expect(mergeMessage([], 'A title')).toBe('Merge: A title');
  });

  it('takes the private words out', () => {
    const patterns = '# comment\n\nacmepriv\nsecret-host\\d+\n(broken\n';
    expect(redactPrivate('Merge DISP-5: Move AcmePriv data to secret-host7', patterns)).toBe('Merge DISP-5: Move … data to …');
    expect(redactPrivate('Merge DISP-5: clean', patterns)).toBe('Merge DISP-5: clean');
    expect(redactPrivate('Merge DISP-5: clean', 'x*')).toBe('Merge DISP-5: clean'); // empty matches leave it alone
  });

  describe('in the worker merge', () => {
    const saved = process.env.DISPATCH_PRIVATE_PATTERNS;
    afterEach(() => {
      if (saved === undefined) delete process.env.DISPATCH_PRIVATE_PATTERNS;
      else process.env.DISPATCH_PRIVATE_PATTERNS = saved;
    });

    it('a pre-push hook that refuses a private word lets the merge through', async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsp-mm-'));
      const dir = join(root, 'repo');
      execFileSync('git', ['init', '-b', 'main', dir]);
      writeFileSync(join(dir, 'a.txt'), 'one\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-m', 'init');
      git(dir, 'config', 'receive.denyCurrentBranch', 'updateInstead');
      git(dir, 'checkout', '-b', 'feat');
      writeFileSync(join(dir, 'b.txt'), 'two\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-m', 'add b');
      git(dir, 'checkout', 'main');
      // like .githooks/pre-push → check-private.mjs: refuse a pushed commit message with the word
      const hook = join(dir, '.git', 'hooks', 'pre-push');
      writeFileSync(hook, '#!/bin/sh\nwhile read -r l ls r rs; do git log --format=%B "$ls" | grep -qi acmepriv && exit 1; done\nexit 0\n');
      chmodSync(hook, 0o755);
      const patterns = join(root, 'private-patterns');
      writeFileSync(patterns, 'acmepriv\n');
      process.env.DISPATCH_PRIVATE_PATTERNS = patterns;

      const ws = new Workspaces(mkdtempSync(join(tmpdir(), 'dsp-ws-')));
      const repo: Repo = { id: 9, project_id: 1, github_owner: 'local', github_name: 'repo', default_branch: 'main', check_command: null, local_path: dir, worktree_from: null, setup_command: null };
      expect(await ws.mergeLocal(repo, 'feat', 'Merge ACME-1: Import AcmePriv data')).toMatchObject({ ok: true });
      expect(git(dir, 'log', '-1', '--format=%s', 'main')).toBe('Merge ACME-1: Import … data');
    });
  });
});
