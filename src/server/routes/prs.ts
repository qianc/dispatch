import type { FastifyInstance, FastifyRequest } from 'fastify';
import { approveInput, mergeInput, type Project, type ProjectPrList, type PullRequest } from '../../shared/types.ts';
import { principalName } from '../access.ts';
import { NO_SESSION, type Caller } from '../github.ts';
import { canDrive } from '../sessionGuard.ts';
import { HttpError, intParam, notFound, type Ctx } from './ctx.ts';

/** A project's list is synced again when it is opened and the last sync is older than this. */
const LIST_FRESH_MS = 60_000;

export function prRoutes(app: FastifyInstance, { github, sessions, store, users }: Ctx) {
  /** Who asks: a PR without a session is read, approved and merged as them (DISP-111). */
  const caller = (req: FastifyRequest): Caller => ({ user: req.principal!.user, name: principalName(req.principal) });
  const project = (req: FastifyRequest): Project => {
    const p = store.projectByKey((req.params as { key: string }).key);
    if (!p) throw notFound('Project');
    return p;
  };
  const projectOf = (pr: PullRequest) => store.project(store.repo(pr.repo_id)!.project_id);

  /** The open PRs of a project's GitHub repos, each with the session and items it belongs to (if any). */
  const list = (p: Project): ProjectPrList => {
    const repos = store.repos(p.id).filter((r) => !r.local_path && r.kind !== 'hosted');
    const prs = repos.flatMap((r) => store.prs({ repo_id: r.id, open_only: true }).filter((pr) => pr.number > 0).sort((a, b) => b.number - a.number)).map((pr) => {
      const s = pr.session_id === null ? undefined : store.session(pr.session_id);
      return { ...pr, linked: s ? { session_id: s.id, title: s.title, item_keys: store.itemsByIds(s.item_ids).map((i) => i.key) } : null };
    });
    return { prs, ...github.prSyncInfo(p.id), github_repos: repos.length };
  };

  /** Answers from the database at once; an old list is synced in the background (its `pr` events refresh the screen). */
  app.get('/api/projects/:key/prs', async (req) => {
    const p = project(req);
    const { synced_at } = github.prSyncInfo(p.id);
    if (!p.disabled && (!synced_at || Date.now() - Date.parse(synced_at) > LIST_FRESH_MS)) {
      void github.syncProjectPrs(p, { caller: caller(req) }).catch((e) => console.warn('PR sync failed:', (e as Error).message));
    }
    return list(p);
  });

  /** Refresh: read every open PR of the project again, as the caller. */
  app.post('/api/projects/:key/prs/sync', async (req) => {
    const p = project(req);
    await github.syncProjectPrs(p, { full: true, caller: caller(req) });
    return list(p);
  });

  app.get('/api/prs/:id', async (req) => {
    const who = caller(req);
    const detail = await github.detail(intParam((req.params as { id: string }).id), who);
    const { pr } = detail;
    // merged by whoever started its session (DISP-63); a PR with no session by anyone who may act
    const s = pr.session_id === null ? undefined : store.session(pr.session_id);
    const acts = req.principal!.scopes.has('sessions');
    const can_merge = detail.merge_here && (pr.session_id === null ? acts : !!s && canDrive(req.principal!, s, users.installOwner));
    // an approval is of one commit, by one person: offered again after a push, to someone else, and when the review did not reach GitHub
    const a = pr.approval;
    const done = !!a && a.sha === pr.head_sha && a.by === who.name && (a.review === 'sent' || a.review === 'own_pr');
    const can_approve = acts && pr.state === 'open' && pr.number > 0 && !projectOf(pr)?.disabled && !done;
    return { ...detail, can_merge, can_approve };
  });

  /** Approve a GitHub PR, with or without a session: kept in Dispatch, and sent to GitHub as the caller's review. */
  app.post('/api/prs/:id/approve', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    if (!store.pr(id)) throw notFound('PR');
    return github.approve(id, caller(req), approveInput.parse(req.body ?? {}).sha);
  });

  app.post('/api/prs/:id/merge', async (req) => {
    const id = intParam((req.params as { id: string }).id);
    const { how, method, sha } = mergeInput.parse(req.body);
    const pr = store.pr(id);
    // auto-merge stopped and the owner merges by hand: their hands were needed
    if (pr?.blocked && pr.session_id !== null && store.session(pr.session_id)?.options.auto_merge !== 'off') store.addMergeEvent(pr.session_id, 'manual_merge', pr.id, pr.blocked);
    return github.merge(id, how, method, caller(req), sha);
  });

  /** A hosted repo's review moves to a PR on its upstream GitHub repo. */
  app.post('/api/prs/:id/github-pr', async (req) => github.openUpstreamPr(intParam((req.params as { id: string }).id)));

  /** Merge conflict: send the session that owns the branch back to work to resolve it. */
  app.post('/api/prs/:id/resolve-conflicts', async (req) => {
    const pr = store.pr(intParam((req.params as { id: string }).id));
    if (!pr) throw new HttpError(404, 'PR not found');
    // agent work starts from an item: a PR with no session has none to send back to work (DISP-111)
    if (pr.session_id === null) throw new HttpError(400, NO_SESSION);
    const repo = store.repo(pr.repo_id)!;
    store.addMergeEvent(pr.session_id, 'resolve_conflicts', pr.id);
    sessions.send(pr.session_id, `PR #${pr.number} in ${pr.repo_full_name} has merge conflicts with ${repo.default_branch}. In this branch (${pr.head_ref}), fetch and merge origin/${repo.default_branch}, resolve the conflicts keeping the intent of both sides, run the tests, commit and push the branch.`);
    return store.session(pr.session_id);
  });
}
