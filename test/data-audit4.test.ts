// DISP-248: the fourth audit's data findings 76-81.
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_OPTIONS, type Item } from '../src/shared/types.ts';
import { parseRepo } from '../src/server/assistant.ts';
import { parseSections } from '../src/shared/markdownSections.ts';
import { unreleased } from '../src/shared/release.ts';
import { releasable } from '../src/server/releases.ts';
import { startServer, OWNER } from './helpers.ts';
import { fakeGithub } from './github.ts';

describe('fourth audit, data findings (DISP-248)', () => {
  it('76: an empty claude_allowed is stored as "all allowed"', async () => {
    const s = await startServer();
    await s.call('POST', '/projects', { key: 'CA', name: 'CA' });
    const r = await s.call('PATCH', '/projects/CA', { claude_allowed: [] });
    expect(r.status).toBe(200);
    expect(s.ctx.store.projectByKey('CA')!.claude_allowed).toBeNull();
    await s.app.close();
  });

  it('77: a refused manual merge records no manual-merge event', async () => {
    const s = await startServer();
    await s.call('POST', '/projects', { key: 'MM', name: 'MM' });
    await s.call('POST', '/projects/MM/repos', { github_owner: 'me', github_name: 'r' });
    const item = (await s.call('POST', '/projects/MM/items', { title: 'x' })).data;
    const session = s.ctx.store.createSession({ started_by: OWNER, worker_id: s.ctx.store.defaultWorkerId(),
      project_id: item.project_id, kind: 'work', title: 't', status: 'idle', force_plan: false, branch: 'dispatch/mm-1-x',
      initial_prompt: '', source_id: null, item_ids: [item.id], options: { ...DEFAULT_RUN_OPTIONS, auto_merge: 'github' },
    });
    const pr = { number: 7, html_url: 'u', title: 'PR', state: 'open', merged_at: null, mergeable: false, mergeable_state: 'dirty', head: { ref: 'dispatch/mm-1-x', sha: 'abc' }, base: { ref: 'main' }, body: '' };
    fakeGithub(s.ctx, {
      pulls: { list: async () => ({ data: [pr] }), get: async () => ({ data: pr }), merge: async () => ({ data: {} }), listFiles: async () => ({ data: [] }) },
      checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
      repos: { compareCommits: async () => ({ data: { behind_by: 0 } }) },
      paginate: async () => [],
    });
    await s.ctx.github.syncSession(session);
    const row = s.ctx.store.prs({ session_id: session.id })[0];
    expect(row.blocked).toBeTruthy();
    // the head moved since the page loaded: the merge is refused
    const r = await s.call('POST', `/prs/${row.id}/merge`, { how: 'github', method: 'squash', sha: 'old' });
    expect(r.status).not.toBe(200);
    expect(s.ctx.store.mergeEvents(session.id)).toEqual([]);
    await s.app.close();
  });

  it('78: parseRepo takes owner/name only from the start of a GitHub URL', () => {
    expect(parseRepo('https://github.com/o/r.git')).toEqual({ owner: 'o', name: 'r' });
    expect(parseRepo('git@github.com:o/r.git')).toEqual({ owner: 'o', name: 'r' });
    expect(parseRepo('github.com/o/r/')).toEqual({ owner: 'o', name: 'r' });
    expect(parseRepo('o/r')).toEqual({ owner: 'o', name: 'r' });
    expect(() => parseRepo('https://github.com/o/decks/tree/main')).toThrow(/Not a GitHub repo/);
  });

  it('79: a heading that ends in "#" with no space before it keeps it', () => {
    const { sections } = parseSections('## Add support for C#\nbody\n## Closed ##\nmore');
    expect(sections.map((s) => s.title)).toEqual(['Add support for C#', 'Closed']);
  });

  it('80: a tag that ends in -version or _version is not a release label; prefix:version still is', () => {
    const item = (labels: string[]) => ({ id: 1, status: 'done', labels, done_at: null }) as unknown as Item;
    expect(unreleased([item(['electron-33.0.1']), item(['lib_2.0.0'])], 'rel:')).toHaveLength(2);
    expect(unreleased([item(['convert:0.3.0'])], 'rel:')).toHaveLength(0);
    expect(unreleased([item(['rel:v1.2.3'])], 'rel:')).toHaveLength(0);
  });

  it('81: removing a repo keeps its merged PRs, so its items stay out of another repo\'s release', async () => {
    const s = await startServer();
    const store = s.ctx.store;
    const project = (await s.call('POST', '/projects', { key: 'RD', name: 'RD' })).data;
    const a = (await s.call('POST', '/projects/RD/repos', { github_owner: 'me', github_name: 'a' })).data;
    const b = (await s.call('POST', '/projects/RD/repos', { github_owner: 'me', github_name: 'b' })).data;
    const item = (await s.call('POST', '/projects/RD/items', { title: 'x' })).data;
    store.updateItem(item.id, { status: 'done' });
    const session = store.createSession({ started_by: OWNER, worker_id: store.defaultWorkerId(),
      project_id: project.id, kind: 'work', title: 't', status: 'idle', force_plan: false, branch: 'dispatch/rd-1-x',
      initial_prompt: '', source_id: null, item_ids: [item.id], options: { ...DEFAULT_RUN_OPTIONS },
    });
    const pr = { session_id: session.id, url: 'u', title: 'PR', mergeable: null, mergeable_state: null, head_ref: 'dispatch/rd-1-x', head_sha: 'abc' };
    store.upsertPr({ ...pr, repo_id: a.id, number: 1, state: 'merged' });
    store.upsertPr({ ...pr, repo_id: a.id, number: 2, state: 'open' });
    store.deleteRepo(a.id);
    expect(store.prs({ session_id: session.id })).toEqual([]); // no repo: not listed
    expect(releasable(store, project.id, store.items(project.id), { repo_id: b.id, label_prefix: 'rel:' })).toEqual([]);
    expect(store.db.get('SELECT count(*) AS n FROM pull_requests')).toEqual({ n: 1 }); // the open one went
    await s.app.close();
  });
});
