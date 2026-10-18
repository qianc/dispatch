# SDD ledger — plan: docs/superpowers/plans/2026-10-19-multi-worker-phase2.md
Spec: docs/superpowers/specs/2026-10-18-multi-worker-design.md (phase 2; cloud move out of scope by owner's choice of the NAS)
Pre-flight: T1 produces HostedGit consumed by T2 (dir), T3 (create/importFrom/retire), T5 (status/diff/merge/upstream), T6 (readFile/deleteBranch/root) — consistent.
Ruling: native execution, final review by a fresh reviewer — as in phase 1 — cost if wrong: no per-task review.
Task 1: Ruling: pushUpstream/fetchUpstreamDefault take the upstream URL as a parameter — the GitHub service owns URLs and credentials — cost if wrong: none
Task 1: Ruling: PullRequest.local is now number < 0 (review rows of local AND hosted repos) — a hosted repo can also have a real GitHub PR — cost if wrong: none
Task 1: complete (commits 22424cc, tests: npx vitest run → 184/184 pass)
Task 2: complete (commits 22424cc..766a09e, tests: npx vitest run → see log)
Task 2: Ruling: tests run git asynchronously — the test server shares the process, so sync git deadlocks — cost if wrong: none
Task 3: complete (commits 766a09e..33e5455, tests: npx vitest run → see /tmp/h3.log, all pass)
Task 3: Ruling: GITHUB_GIT_BASE setting (default https://github.com) — lets tests use a folder for GitHub — cost if wrong: none
Task 3: Ruling: GitHub credentials for server-side git go through an env-based credential helper — keeps tokens out of URLs, argv and files — cost if wrong: none
Task 4: complete (commits 33e5455..f4ab91d, tests: npx vitest run → 191/191 pass)
Task 4: Ruling: hosted repos allow partial clones (uploadpack.allowFilter) — the worker clones with --filter=blob:none — cost if wrong: none
Task 5: complete (commits f4ab91d..5e3855d, tests: npx vitest run → 196/196 pass)
Task 5: Ruling: a hosted merge records the review row as merged itself — a squash merge leaves the branch outside the history, so ancestry cannot tell — cost if wrong: none
Task 5: Ruling: 'rebase' as merge method for hosted repos merges (no server-side rebase) — keeps the server merge simple — cost if wrong: a merge commit where a rebase was chosen
Task 5: Ruling: PrDetail gains repo { kind, upstream, check_command } — the PR page needs to explain a hosted merge — cost if wrong: none
Task 6: complete (commits 5e3855d..d029abf, tests: npx vitest run → all pass)
