import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectPr, ProjectPrList, PrApproval, Repo, Session } from '../src/shared/types.ts';
import type { PrDetail, ProjectSummary } from '../web/src/api.ts';
import { approvalView, ciLook, linkLabels, mergeBody, prPageStale } from '../web/src/prs.ts';
import { renderPage, stubBrowser, textOf } from './web-render.ts';

vi.mock('../web/src/wide.ts', () => ({ useWide: () => false, useVeryWide: () => false }));

let list: typeof import('../web/src/components/projectPrs.tsx');
let PrView: typeof import('../web/src/pages/Pr.tsx').PrView;
let Project: typeof import('../web/src/pages/Project.tsx').Project;
beforeEach(async () => {
  stubBrowser();
  list = await import('../web/src/components/projectPrs.tsx');
  ({ PrView } = await import('../web/src/pages/Pr.tsx'));
  ({ Project } = await import('../web/src/pages/Project.tsx'));
});
afterEach(() => vi.unstubAllGlobals());

const OWN_PR = 'GitHub does not accept an approval of your own pull request.';
const NO_DEPLOY = "The repo's deploy command does not run for this merge: it needs a session's worker.";
const NO_MERGE_GENERATE = "This repo merges only in Dispatch, on a session's worker (it has a generate command). A pull request without a session cannot be merged here.";

const approval = (over: Partial<PrApproval> = {}): PrApproval => ({ at: '2026-11-02T00:00:00Z', by: 'alice', sha: 'sha41', review: 'sent', note: null, ...over });
const pr = (number: number, over: Partial<ProjectPr> = {}): ProjectPr => ({
  id: number, session_id: null, repo_id: 1, repo_full_name: 'me/app', number, url: `https://github.com/me/app/pull/${number}`, title: `PR ${number}`, state: 'open', mergeable: true, mergeable_state: 'clean',
  head_ref: `dep-${number}`, head_sha: `sha${number}`, last_synced: null, local: false, blocked: null, behind_at_merge: null, started_by: null, github_login: null, author: 'dependabot[bot]', base_ref: 'main', fork_sha: null,
  draft: false, changed_files: 2, ci_state: 'success', gh_updated_at: null, approval: null, linked: null, ...over,
});
const repo = (id: number, over: Partial<Repo> = {}): Repo => ({ id, project_id: 1, github_owner: 'me', github_name: 'app', default_branch: 'main', check_command: null, local_path: null, worktree_from: null, setup_command: null, kind: 'github', ...over });
const project = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 1, key: 'PP', name: 'PP', description: '', default_force_plan: false, importance_scale: [], effort_scale: [], github_account: null, claude_account: null, claude_allowed: null,
  color: null, icon: null, worker_id: null, placement_md: '', agents_edit_items: false, neighbours: [], disabled: false, disabled_at: null, disabled_by: null, created_at: '2026-01-01T00:00:00Z', muted: false, repos: [repo(1)], ...over,
});
const prList = (over: Partial<ProjectPrList> = {}): ProjectPrList => ({ prs: [], synced_at: new Date().toISOString(), error: null, github_repos: 1, ...over });
const linked = { session_id: 3, title: 'Batch', item_keys: ['PP-1'] };

/** The buttons in some HTML, by their text. */
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => textOf(m[1]));

const listHtml = (data: ProjectPrList, p = project()) => {
  const qc = new QueryClient();
  qc.setQueryData(['project-prs', p.key], data);
  return renderPage(createElement(list.ProjectPrs, { project: p }), { qc });
};

const detail = (p: ProjectPr, over: Partial<PrDetail> = {}): PrDetail => {
  const { linked: _linked, ...row } = p;
  return {
    pr: row, repo: { kind: 'github', upstream: null, check_command: null }, hands: [], body: '', base_ref: 'main', files: [], checks: [], auto_merge: 'off',
    can_merge: true, can_approve: true, merge_note: null, merge_here: true, ...over,
  };
};
const pageHtml = (d: PrDetail) => {
  const qc = new QueryClient();
  qc.setQueryData(['pr', d.pr.id], d);
  return renderPage(createElement(PrView), { qc, path: `/pr/${d.pr.id}`, route: '/pr/:id' });
};

describe('what a pull request belongs to, and its approval, in words (DISP-111)', () => {
  it('linkLabels', () => {
    expect(linkLabels({ linked: null })).toEqual(['No item']);
    expect(linkLabels({ linked: { session_id: 3, title: 'Batch', item_keys: ['PP-1', 'PP-2'] } })).toEqual(['PP-1', 'PP-2']);
    expect(linkLabels({ linked: { session_id: 3, title: 'Plan', item_keys: [] } })).toEqual(['Session']);
  });

  it('mergeBody: a PR with no session merges on GitHub; every merge only the commit the page shows (DISP-232)', () => {
    expect(mergeBody({ local: false, session_id: null, head_sha: 'sha41' }, 'local', 'squash')).toEqual({ how: 'github', method: 'squash', sha: 'sha41' });
    expect(mergeBody({ local: false, session_id: 3, head_sha: 'sha5' }, 'local', 'merge')).toEqual({ how: 'local', method: 'merge', sha: 'sha5' });
    expect(mergeBody({ local: false, session_id: 3, head_sha: 'sha5' }, 'github', 'rebase')).toEqual({ how: 'github', method: 'rebase', sha: 'sha5' });
    expect(mergeBody({ local: true, session_id: 3, head_sha: 'sha5' }, 'github', 'squash')).toEqual({ how: 'local', method: 'squash', sha: 'sha5' });
    expect(mergeBody({ local: true, session_id: 3, head_sha: null }, 'github', 'squash')).toEqual({ how: 'local', method: 'squash' });
  });

  it('prPageStale: an open PR page is read again when the branch or the state moved on', () => {
    const shown = { head_sha: 'sha41', state: 'open' as const };
    expect(prPageStale(undefined, shown)).toBe(false);
    expect(prPageStale(shown, { head_sha: 'sha41', state: 'open' })).toBe(false);
    expect(prPageStale(shown, { head_sha: 'sha41b', state: 'open' })).toBe(true);
    expect(prPageStale(shown, { head_sha: 'sha41', state: 'merged' })).toBe(true);
  });

  it('approvalView', () => {
    expect(approvalView({ approval: null, head_sha: 'sha41' })).toBeNull();
    expect(approvalView({ approval: approval(), head_sha: 'sha41' })).toEqual({ current: true, chip: 'Approved', text: 'Approved by alice. Sent to GitHub as a review.' });
    const earlier = approvalView({ approval: approval(), head_sha: 'sha42' })!;
    expect(earlier.current).toBe(false);
    expect(earlier.chip).toBe('Approved earlier');
    expect(earlier.text).toBe('Approved by alice before the last push. Sent to GitHub as a review.');
    expect(approvalView({ approval: approval({ review: 'own_pr', note: OWN_PR }), head_sha: 'sha41' })!.text).toBe(`Approved by alice in Dispatch. ${OWN_PR}`);
    expect(approvalView({ approval: approval({ review: 'failed', note: 'Resource not accessible by personal access token' }), head_sha: 'sha41' })!.text)
      .toBe('Approved by alice in Dispatch. The review did not reach GitHub: Resource not accessible by personal access token');
    expect(approvalView({ approval: approval({ review: null }), head_sha: 'sha41' })!.text).toBe('Approved by alice in Dispatch.');
    expect(approvalView({ approval: approval({ review: null }), head_sha: 'sha42' })!.text).toBe('Approved by alice before the last push.');
  });

  it('ciLook: a dot for a known result, none when there is nothing to say', () => {
    expect(ciLook('success')).toEqual({ cls: 'bg-ok', label: 'Checks passed' });
    expect(ciLook('failure')).toEqual({ cls: 'bg-bad', label: 'Checks failed' });
    expect(ciLook('pending')).toEqual({ cls: 'bg-wait animate-pulse', label: 'Checks running' });
    expect(ciLook('none')).toBeNull();
    expect(ciLook(null)).toBeNull();
  });
});

describe("a project's open pull requests (DISP-111)", () => {
  it('the list shows each PR with its link state', () => {
    const html = listHtml(prList({
      prs: [pr(41, { draft: true }), pr(40, { session_id: 3, author: 'octo', linked, approval: approval({ sha: 'sha40' }), ci_state: 'pending', changed_files: 1 })],
    }));
    const text = textOf(html);
    for (const part of ['Open pull requests', 'PR 41', '#41', 'dependabot[bot]', '2 files', 'No item', 'Draft', 'PR 40', '#40', 'octo', '1 file', 'PP-1', 'Approved']) expect(text).toContain(part);
    expect(text).not.toContain('1 files');
    expect(text).not.toContain('Approved earlier');
    expect(html.match(/href="\/pr\//g)).toHaveLength(2);
    expect(html).toContain('href="/pr/41"');
    expect(html).toContain('aria-label="Checks passed"');
    expect(html).toContain('aria-label="Checks running"');
    expect(text).toContain('synced just now');
    // one GitHub repo: its name is not repeated on every row
    expect(text).not.toContain('app#41');
  });

  it('with several GitHub repos a row names its repo; an approval of an older commit says so', () => {
    const p = project({ repos: [repo(1), repo(2, { github_name: 'api' })] });
    const text = textOf(listHtml(prList({ github_repos: 2, prs: [pr(41, { approval: approval({ sha: 'old' }) }), pr(7, { repo_id: 2, repo_full_name: 'me/api', author: null, changed_files: null })] }), p));
    expect(text).toContain('app#41 · dependabot[bot] · 2 files');
    expect(text).toContain('api#7');
    expect(text).toContain('Approved earlier');
  });

  it('under the list: the GitHub check, with its chat and batch card once it ran (DISP-258)', () => {
    const none = textOf(listHtml(prList()));
    expect(none).toContain('GitHub findings');
    expect(none).toContain('Check GitHub');
    const qc = new QueryClient();
    const check = { id: 9, kind: 'planner', title: 'GitHub check', status: 'idle', github_check: true, project_id: 1, project_key: 'PP', source_id: null, options: {} } as unknown as Session;
    qc.setQueryData(['project-prs', 'PP'], prList());
    qc.setQueryData(['github-check', 'PP'], { session: check });
    qc.setQueryData(['session', 9], {
      session: check, inputs: [], items: [], prs: [], repos: [], source: null, project: project(), access: { drive: true, stop: true, read: true },
      events: [{ id: 1, seq: 1, session_id: 9, created_at: '2026-11-20T00:00:00Z', body: { kind: 'assistant', text: 'One failed run: the test job fails on main. Filed PP-3.' } }],
    });
    const html = renderPage(createElement(list.ProjectPrs, { project: project() }), { qc });
    const text = textOf(html);
    expect(text).toContain('Check again');
    expect(text).toContain('Filed PP-3.');
    expect(html).toContain('href="/s/9"');
  });

  it('the list says when there is nothing to show', () => {
    expect(textOf(listHtml(prList()))).toContain('No open pull requests.');
    expect(textOf(listHtml(prList({ github_repos: 0, synced_at: null })))).toContain('This project has no GitHub repo.');
    const failed = textOf(listHtml(prList({ error: 'me/app: Bad credentials', prs: [pr(41)] })));
    expect(failed).toContain('me/app: Bad credentials');
    expect(failed).toContain('PR 41');
  });

  it('refresh is there, and off on a disabled project', () => {
    const on = listHtml(prList());
    expect(on).toMatch(/<button[^>]*aria-label="Refresh pull requests"/);
    expect(on).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="Refresh pull requests"|<button[^>]*aria-label="Refresh pull requests"[^>]*disabled=""/);
    const off = listHtml(prList(), project({ disabled: true }));
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Refresh pull requests"|<button[^>]*aria-label="Refresh pull requests"[^>]*disabled=""/);
  });

  it('the project page has a PRs tab, with the open count when there is one', () => {
    const page = (data: ProjectPrList) => {
      const qc = new QueryClient();
      qc.setQueryData(['project', 'PP'], project());
      qc.setQueryData(['project-prs', 'PP'], data);
      return renderPage(createElement(Project), { qc, path: '/p/PP?tab=prs', route: '/p/:key' });
    };
    const html = page(prList({ prs: [pr(41), pr(40)] }));
    expect(buttons(html)).toContain('PRs · 2');
    const tabs = buttons(html);
    expect(tabs.indexOf('PRs · 2')).toBe(tabs.indexOf('Sessions') + 1);
    expect(textOf(html)).toContain('PR 41');
    expect(buttons(page(prList()))).toContain('PRs');
  });
});

describe('the page of a pull request (DISP-111)', () => {
  it('the PR page of an unlinked PR', () => {
    const html = pageHtml(detail(pr(41, { author: 'octo', mergeable: false, mergeable_state: 'dirty' }), { merge_note: NO_DEPLOY }));
    const text = textOf(html);
    expect(text).toContain('Not linked to an item');
    expect(text).toContain('opened by @octo');
    expect(text).toContain(NO_DEPLOY);
    expect(buttons(html)).toContain('Approve');
    expect(buttons(html)).toContain('Merge');
    expect(buttons(html)).toContain('Squash');
    expect(text).not.toContain('Merge locally');
    expect(text).not.toMatch(/resolve conflicts/i);
  });

  it('an unlinked PR whose author is not known says only that it is not linked', () => {
    const text = textOf(pageHtml(detail(pr(41, { author: null }))));
    expect(text).toContain('Not linked to an item');
    expect(text).not.toContain('opened by');
  });

  it('the PR page says an approval of your own PR stays in Dispatch', () => {
    const html = pageHtml(detail(pr(41, { approval: approval({ review: 'own_pr', note: OWN_PR }) }), { can_approve: false }));
    expect(textOf(html)).toContain(`Approved by alice in Dispatch. ${OWN_PR}`);
    expect(buttons(html)).not.toContain('Approve');
    expect(buttons(html)).toContain('Merge');
  });

  it('no Merge button when the PR cannot merge here', () => {
    const html = pageHtml(detail(pr(41), { merge_here: false, can_merge: false, merge_note: NO_MERGE_GENERATE }));
    expect(textOf(html)).toContain(NO_MERGE_GENERATE);
    expect(buttons(html)).not.toContain('Merge');
    expect(buttons(html)).not.toContain('Squash');
    expect(buttons(html)).toContain('Approve');
    // nobody started it: no "Only … can merge this"
    expect(textOf(html)).not.toContain('can merge this');
  });

  it('a reader of an unlinked PR sees its state and no buttons', () => {
    const html = pageHtml(detail(pr(41, { approval: approval() }), { can_merge: false, can_approve: false }));
    expect(textOf(html)).toContain('Approved by alice. Sent to GitHub as a review.');
    expect(buttons(html)).not.toContain('Approve');
    expect(buttons(html)).not.toContain('Merge');
  });

  it('a linked GitHub PR also gets Approve; a local review does not', () => {
    const mine = pageHtml(detail(pr(5, { session_id: 3, started_by: 'alice', mergeable: false })));
    expect(buttons(mine)).toContain('Approve');
    expect(buttons(mine)).toContain('Merge');
    expect(textOf(mine)).toContain('Merge locally + push');
    expect(textOf(mine)).toMatch(/resolve conflicts/i);
    expect(textOf(mine)).not.toContain('Not linked to an item');

    const theirs = pageHtml(detail(pr(5, { session_id: 3, started_by: 'bob' }), { can_merge: false }));
    expect(textOf(theirs)).toContain('Only bob can merge this.');
    expect(buttons(theirs)).toContain('Approve');
    expect(buttons(theirs)).not.toContain('Merge');

    const local = pageHtml(detail(pr(-3, { session_id: 3, local: true, url: '' }), { repo: { kind: 'local', upstream: null, check_command: null }, can_approve: false }));
    expect(buttons(local)).not.toContain('Approve');
    expect(buttons(local)).toContain('Merge');
  });

  it('a merged PR has no Approve', () => {
    const html = pageHtml(detail(pr(41, { state: 'merged' }), { can_approve: false, can_merge: true }));
    expect(buttons(html)).not.toContain('Approve');
    expect(buttons(html)).not.toContain('Merge');
  });
});
