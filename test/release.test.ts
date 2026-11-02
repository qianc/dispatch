import { describe, expect, it } from 'vitest';
import { bump, compareVersions, highestLabelVersion, labelDate, maxVersion, normalizeVersion, parseVersion, proposeVersion, unreleased, VERSION_RE } from '../src/shared/release.ts';
import type { Item } from '../src/shared/types.ts';

const item = (key: string, over: Partial<Item> = {}): Item => ({
  id: Number(key.split('-')[1]), project_id: 1, number: 1, key, type: 'backlog', title: key, body_md: '', status: 'done', importance: 2, effort: null,
  source_id: null, labels: [], modules: [], marked: false, sort_order: 0, created_at: '', updated_at: '', done_at: null, ...over,
});

describe('release versions', () => {
  it('parses and compares versions, numerically and with or without a v', () => {
    expect(VERSION_RE.test('v1.2.3')).toBe(true);
    expect(VERSION_RE.test('1.2.3-rc.1')).toBe(true);
    expect(VERSION_RE.test('1.2')).toBe(false);
    expect(VERSION_RE.test('v1.2.3; rm -rf /')).toBe(false);
    expect(parseVersion('v1.10.0')).toEqual({ v: true, nums: [1, 10, 0], pre: null });
    expect(parseVersion('nope')).toBeNull();
    expect(compareVersions('v1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0-rc1', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
    expect(maxVersion(['v0.9.0', 'junk', 'v0.10.0', '0.2.0'])).toBe('v0.10.0');
    expect(maxVersion([])).toBeNull();
  });

  it('bumps minor or patch and keeps the v', () => {
    expect(bump('v1.4.2', 'minor')).toBe('v1.5.0');
    expect(bump('1.4.2', 'patch')).toBe('1.4.3');
    expect(bump('v2.0.0-rc.1', 'patch')).toBe('v2.0.1');
  });

  it('normalizes what the owner typed to the style of the last version', () => {
    expect(normalizeVersion(' 1.5.0 ', 'v1.4.0')).toBe('v1.5.0');
    expect(normalizeVersion('1.5.0', '1.4.0')).toBe('1.5.0');
    expect(normalizeVersion('v1.5.0', null)).toBe('v1.5.0');
    expect(normalizeVersion('1.5.0', null)).toBe('1.5.0');
  });

  it('finds unreleased done items and the highest release label', () => {
    const items = [
      item('A-1', { labels: ['rel:v1.0.0'] }), item('A-2'), item('A-3', { status: 'todo' }),
      item('A-4', { labels: ['convert:v3.0.0', 'ux'] }), item('A-5', { labels: ['rel:v1.2.0'] }),
    ];
    // A-4 shipped in another release line
    expect(unreleased(items, 'rel:').map((i) => i.key)).toEqual(['A-2']);
    const tagged = [item('A-6', { labels: ['python3.11.2', 'ux', 'v2'] }), item('A-7', { labels: ['convert#1.2.0'] })];
    expect(unreleased(tagged, 'rel:').map((i) => i.key)).toEqual(['A-6']);
    expect(highestLabelVersion(items, 'rel:')).toBe('v1.2.0');
    expect(highestLabelVersion(items, 'convert:')).toBe('v3.0.0');
    expect(highestLabelVersion(items, 'x:')).toBeNull();
  });

  it('counts only the items done since the last release, when its date is known', () => {
    const items = [
      item('A-1', { done_at: '2026-10-30T10:00:00.000Z' }), item('A-2', { done_at: '2026-11-01T10:00:00.000Z' }),
      item('A-3', { done_at: '2026-11-01T10:00:00.000Z', labels: ['rel:v1.0.0'] }), item('A-4', { status: 'todo' }),
    ];
    // the date comes from git with an offset: 11:00 +01:00 is 10:00 UTC, and the same moment counts
    expect(unreleased(items, 'rel:', '2026-11-01T11:00:00+01:00').map((i) => i.key)).toEqual(['A-2']);
    expect(unreleased(items, 'rel:', null).map((i) => i.key)).toEqual(['A-1', 'A-2']);
  });

  it('dates a labelled release by the first item labelled, whatever changed on the others later', () => {
    const items = [
      item('A-1', { labels: ['rel:v1.0.0'], updated_at: '2026-11-02T10:00:00.000Z' }), item('A-2', { labels: ['rel:1.0.0'], updated_at: '2026-11-01T10:00:00.000Z' }),
      item('A-3', { labels: ['rel:v0.9.0'], updated_at: '2026-10-01T10:00:00.000Z' }),
    ];
    expect(labelDate(items, 'rel:', 'v1.0.0')).toBe('2026-11-01T10:00:00.000Z');
    expect(labelDate(items, 'rel:', 'v2.0.0')).toBeNull();
  });

  it('proposes minor for backlog work, patch for bugs only, v0.1.0 for a first release', () => {
    expect(proposeVersion('v1.4.2', [item('A-1'), item('A-2', { type: 'bug' })])).toEqual({ version: 'v1.5.0', bump: 'minor' });
    expect(proposeVersion('v1.4.2', [item('A-2', { type: 'bug' })])).toEqual({ version: 'v1.4.3', bump: 'patch' });
    expect(proposeVersion(null, [item('A-1')])).toEqual({ version: 'v0.1.0', bump: 'first' });
    expect(proposeVersion('v2.0.0-rc.2', [item('A-1')])).toEqual({ version: 'v2.0.0', bump: 'release' });
  });
});
