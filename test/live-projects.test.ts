import { describe, expect, it } from 'vitest';
import type { LiveEvent } from '../src/shared/types.ts';
import { startServer } from './helpers.ts';

describe('live events for projects', () => {
  it('creating, changing a project and adding a repo tell every open app', async () => {
    const s = await startServer();
    const got: LiveEvent[] = [];
    s.ctx.bus.on((e) => got.push(e));
    await s.call('POST', '/projects', { key: 'LV', name: 'Live' });
    await s.call('PATCH', '/projects/LV', { name: 'Live 2' });
    await s.call('POST', '/projects/LV/repos', { github_owner: 'me', github_name: 'lv' });
    expect(got.filter((e) => e.t === 'project').map((e) => (e as { key: string }).key)).toEqual(['LV', 'LV', 'LV']);
    await s.app.close();
  });
});
