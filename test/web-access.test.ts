import { describe, expect, it } from 'vitest';
import { accountSource, canAct, openedBy, permissionLook, readOnlyText, scheduleRights, startedBy } from '../web/src/access.ts';

// DISP-63: what the app shows and hides on other people's sessions, PRs and schedules.
describe('session access in the app', () => {
  it('follows what the server says the caller may do', () => {
    expect(canAct({ drive: false, stop: true }, 'drive')).toBe(false);
    expect(canAct({ drive: false, stop: true }, 'stop')).toBe(true);
    expect(canAct({ drive: true, stop: true }, 'drive')).toBe(true);
    expect(canAct({ drive: false, stop: false }, 'stop')).toBe(false);
  });

  it('allows everything when an older server sends no access', () => {
    expect(canAct(undefined, 'drive')).toBe(true);
    expect(canAct(undefined, 'stop')).toBe(true);
  });

  it('says who started a session, and as whom it acts on GitHub', () => {
    expect(startedBy({ started_by: 'bob', github_login: 'bob-gh' })).toBe('Started by bob as @bob-gh');
    expect(startedBy({ started_by: 'bob', github_login: null })).toBe('Started by bob');
    expect(startedBy({ started_by: null, github_login: null })).toBeNull();
    expect(readOnlyText({ started_by: 'bob' })).toBe('Started by bob. You can read this session.');
    expect(readOnlyText({ started_by: null })).toBe('Started by an API token. You can read this session.');
  });

  it('says who opened a PR', () => {
    expect(openedBy({ started_by: 'bob', github_login: 'bob-gh' })).toBe('Opened by bob (@bob-gh)');
    expect(openedBy({ started_by: 'bob', github_login: null })).toBe('Opened by bob');
    expect(openedBy({ started_by: null, github_login: null })).toBeNull();
  });
});

describe('schedule rights in the app', () => {
  const bobs = { owner: 'bob', enabled: true };
  it('gives the owner everything', () => {
    expect(scheduleRights(bobs, 'bob', false)).toEqual({ edit: true, run: true, toggle: true, remove: true });
  });
  it('lets the install owner switch off and delete, not edit or run', () => {
    expect(scheduleRights(bobs, 'alice', true)).toEqual({ edit: false, run: false, toggle: true, remove: true });
    // switched off already: the install owner cannot switch it back on
    expect(scheduleRights({ ...bobs, enabled: false }, 'alice', true).toggle).toBe(false);
  });
  it('lets anyone else only read it', () => {
    expect(scheduleRights(bobs, 'carol', false)).toEqual({ edit: false, run: false, toggle: false, remove: false });
    expect(scheduleRights(bobs, null, false).edit).toBe(false);
  });
});

describe('who can act on GitHub here', () => {
  it('names where each account comes from', () => {
    expect(accountSource({ source: 'user' })).toBe('Own GitHub account');
    expect(accountSource({ source: 'owner-env', account: 'default' })).toBe('Server account "default"');
  });
  it('shows a checked permission plainly', () => {
    expect(permissionLook('write')).toEqual({ label: 'write', tone: 'ok' });
    expect(permissionLook('read')).toEqual({ label: 'read only', tone: 'wait' });
    expect(permissionLook('none')).toEqual({ label: 'no access', tone: 'bad' });
    expect(permissionLook(null)).toEqual({ label: 'unknown', tone: 'neutral' });
  });
});
