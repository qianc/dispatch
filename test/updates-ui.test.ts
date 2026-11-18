// DISP-112: Settings → Updates. What the install owner sees of Dispatch's own version, the update
// and its log; and that nobody else sees the section.
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateInfo, UpdateRow } from '../src/shared/types.ts';
import type { Me } from '../web/src/api.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => true, useVeryWide: () => true }));

let Settings: typeof import('../web/src/pages/Settings.tsx').Settings;
let UpdatesSection: typeof import('../web/src/components/updates.tsx').UpdatesSection;
let behindLine: typeof import('../web/src/components/updates.tsx').behindLine;
beforeEach(async () => {
  stubBrowser();
  ({ Settings } = await import('../web/src/pages/Settings.tsx'));
  ({ UpdatesSection, behindLine } = await import('../web/src/components/updates.tsx'));
});
afterEach(() => vi.unstubAllGlobals());

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const NOW = new Date().toISOString();

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  repo: 'you/dispatch', branch: 'main', version: { sha: A, tag: 'v1.2.0' }, mode: 'self', mode_why: null,
  state: {
    checked_at: NOW, for_sha: A, commit: { sha: B, date: NOW }, tag: { name: 'v1.3.0', sha: C, ahead: true }, behind_by: 2, on_branch: true,
    commits: [{ sha: B, subject: 'fix the inbox count' }, { sha: C, subject: 'add the update log' }], error: null,
  },
  settings: { auto: false, follow: 'commits' }, target: { sha: B, tag: null }, rollout: null, waiting: [], workers: [], log: [], ...over,
});
const row = (over: Partial<UpdateRow> = {}): UpdateRow => ({
  id: 1, target: 'server', worker_id: null, worker_name: null, triggered_by: 'auto', from_sha: A, to_sha: B, to_tag: null, state: 'ok', detail: null, created_at: NOW, ended_at: NOW, ...over,
});
const html = (i: UpdateInfo) => {
  const qc = new QueryClient();
  qc.setQueryData(['update'], i);
  return renderPage(createElement(UpdatesSection), { qc });
};
const show = (i: UpdateInfo) => textOf(html(i));

describe('Settings → Updates (DISP-112)', () => {
  it('shows the running version, what is new, and the update to the newest commit', () => {
    const text = show(info());
    expect(text).toContain('Dispatch runs aaaaaaa (v1.2.0)');
    expect(text).toContain('Update available');
    expect(text).toMatch(/2 commits behind main · checked just now · you\/dispatch/);
    expect(text).toContain('Newest commit bbbbbbb · newest version v1.3.0 ( ccccccc )');
    expect(text).toContain('bbbbbbb fix the inbox count');
    expect(text).toContain('Update automatically');
    expect(text).toContain('Every commit');
    expect(text).toContain('Version tags only');
    expect(text).toContain('The server updates itself.');
    expect(text).toContain('Update now to bbbbbbb');
    expect(text).toContain('No update yet.');
    expect(text).toContain('Check now');
  });

  it('names the version tag when tags are followed, and says when there is nothing newer', () => {
    expect(show(info({ settings: { auto: true, follow: 'tags' }, target: { sha: C, tag: 'v1.3.0' } }))).toContain('Update now to v1.3.0');
    const current = info({ state: { ...info().state, commit: { sha: A, date: NOW }, tag: null, behind_by: 0, commits: [] }, target: null });
    const page = html(current);
    expect(textOf(page)).toMatch(/Up to date.*Up to date with main/);
    // nothing to update to: the button is off
    expect(page).toMatch(/<button[^>]*disabled=""[^>]*>Update now<\/button>/);
    expect(textOf(page)).not.toContain('What is new');
  });

  it('says in plain words why the version is not known', () => {
    expect(behindLine(info({ repo: null })).text).toMatch(/Set UPDATE_REPO/);
    expect(behindLine(info({ version: { sha: null, tag: null } })).text).toMatch(/Set DISPATCH_VERSION/);
    expect(behindLine(info({ state: { ...info().state, checked_at: null } })).text).toBe('Not checked yet.');
    expect(behindLine(info({ state: { ...info().state, for_sha: C } })).text).toBe('Not checked since the server started.');
    expect(behindLine(info({ state: { ...info().state, on_branch: false } })).text).toBe("The server's commit is not on main. It is not updated.");
    expect(behindLine(info({ state: { ...info().state, behind_by: 1 } })).text).toBe('1 commit behind main');
    const text = show(info({ state: { ...info().state, error: 'GitHub answered 404' }, mode: 'none', mode_why: 'It was not started through the launcher (node src/launch.ts server).' }));
    expect(text).toContain('The last check failed: GitHub answered 404');
    expect(text).toContain('The server cannot be updated from here. It was not started through the launcher (node src/launch.ts server).');
  });

  it('shows an update that waits, with why, and Cancel in place of Update now', () => {
    const waiting = 'The server updates to bbbbbbb when it is idle. Now: session #4 is working.';
    const text = show(info({ rollout: { sha: B, tag: null, by: 'ana' }, waiting: [waiting] }));
    expect(text).toContain('Updating to bbbbbbb , started by ana.');
    expect(text).toContain('Cancel');
    expect(text).not.toContain('Update now');
    expect(text).toContain(waiting);
  });

  it("lists each worker's version and state, and why one cannot update itself", () => {
    const page = info({
      target: null,
      state: { ...info().state, commit: { sha: A, date: NOW }, behind_by: 0, commits: [] },
      workers: [
        { id: 1, name: 'desk', connected: true, sha: A, updatable: true, why: null, status: 'current' },
        { id: 2, name: 'nas', connected: true, sha: C, updatable: true, why: null, status: 'failed' },
        { id: 3, name: 'pi', connected: false, sha: null, updatable: false, why: 'It runs from an image.', status: 'unknown' },
      ],
    });
    const text = show(page);
    expect(text).toMatch(/Worker desk · aaaaaaa Up to date/);
    expect(text).toMatch(/Worker nas · ccccccc Update failed/);
    expect(text).toMatch(/Worker pi · unknown · offline Cannot update itself\. It runs from an image\. Unknown/);
    // the server is current, a worker is not: the button updates the workers
    expect(text).toContain('Update the workers now');
  });

  it('logs each update: what, from which version to which, who started it, and how it ended', () => {
    const text = show(info({
      log: [
        row({ id: 3, target: 'worker', worker_id: 2, worker_name: 'nas', triggered_by: 'ana', state: 'failed', detail: 'npm ci failed (exit 1).' }),
        row({ id: 2, to_sha: C, to_tag: 'v1.3.0', state: 'rolled_back', detail: 'The new version did not start.' }),
        row({ id: 1 }),
      ],
    }));
    expect(text).toMatch(/Worker nas aaaaaaa → bbbbbbb · by ana · just now Failed npm ci failed \(exit 1\)\./);
    expect(text).toMatch(/Server aaaaaaa → ccccccc \(v1\.3\.0\) · automatic · just now Rolled back The new version did not start\./);
    expect(text).toMatch(/Server aaaaaaa → bbbbbbb · automatic · just now Updated/);
    expect(text).not.toContain('No update yet.');
    // while an update runs, a second one cannot be started
    expect(html(info({ log: [row({ state: 'running', ended_at: null })] }))).toMatch(/<button[^>]*disabled=""[^>]*>Update now to bbbbbbb<\/button>/);
  });

  it('is on the Settings page for the install owner only', () => {
    const me = (is_owner: boolean): Me => ({ authed: true, user: is_owner ? 'ana' : 'ben', is_owner, install_owner: 'ana', secret_key_file: null, auth_mode: 'proxy', auth_disabled: false, password_login: false, vapid_public_key: 'k' });
    const settings = (is_owner: boolean) => {
      const qc = new QueryClient();
      qc.setQueryData(['me'], me(is_owner));
      qc.setQueryData(['update'], info());
      return textOf(renderPage(createElement(Settings), { qc }));
    };
    expect(settings(true)).toContain('Dispatch runs aaaaaaa');
    const other = settings(false);
    expect(other).not.toContain('Dispatch runs');
    expect(other).not.toContain('Update automatically');
  });
});
