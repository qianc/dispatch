# SDD ledger — plan: docs/superpowers/plans/2026-10-19-multi-worker-phase2.md
Spec: docs/superpowers/specs/2026-10-18-multi-worker-design.md (phase 2; cloud move out of scope by owner's choice of the NAS)
Pre-flight: T1 produces HostedGit consumed by T2 (dir), T3 (create/importFrom/retire), T5 (status/diff/merge/upstream), T6 (readFile/deleteBranch/root) — consistent.
Ruling: native execution, final review by a fresh reviewer — as in phase 1 — cost if wrong: no per-task review.
Task 1: Ruling: pushUpstream/fetchUpstreamDefault take the upstream URL as a parameter — the GitHub service owns URLs and credentials — cost if wrong: none
Task 1: Ruling: PullRequest.local is now number < 0 (review rows of local AND hosted repos) — a hosted repo can also have a real GitHub PR — cost if wrong: none
Task 1: complete (commits 22424cc, tests: npx vitest run → 184/184 pass)
Task 2: complete (commits 22424cc..766a09e, tests: npx vitest run → see log)
Task 2: Ruling: tests run git asynchronously — the test server shares the process, so sync git deadlocks — cost if wrong: none
