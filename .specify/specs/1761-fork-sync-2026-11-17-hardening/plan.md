# Plan: 1761 — Fork sync 2026-11-17 hardening

| Field        | Value       |
| ------------ | ----------- |
| Spec ID      | 1761        |
| Spec         | spec.md     |
| Status       | Implemented |
| Created      | 2026-11-18  |
| Last updated | 2026-11-18  |

## 1. Approach

The sync comes in through a merge, and every fix sits on top of it. `9f106583` merges the
MakeDeeply fork tip `5fd45911` into `develop` with a merge commit, so the fork's history lands
unchanged and the fork tip stays an ancestor of `develop`; a squash would make the next sync
re-present every file. Nothing the fork wrote is reverted. Its new features (`include_raw`,
`deadline_ms`, the location-object mapper, the 10 new plugins) stay, behind safe defaults.

The work ran in five steps:

1. **Review, read-only.** Five lanes covered the diff from the merge base `a4621490`: http/core, API,
   the new plugins, the changed plugins, and utils/config/metadata. No fork code ran. Every
   medium-or-higher finding got two independent skeptic votes: 14 confirmed, 1 refuted. The full
   result is in the PR description.
2. **Merge.** The only conflicts were in `docs/log.md` (one dated heading per day, per docs-lint) and
   `docs/index.md`. `develop` was merged in again after #151/#153 and after #148/#152.
3. **Four fix lanes in four git worktrees**, each owning a separate set of files so they could run in
   parallel:
   - **http** — `packages/common/src/http`, `browser-pool.ts`, `raw-capture.interface.ts`, and the
     token code of Adzuna, Jooble, Personio, Upwork and France Travail (FR-1 to FR-4).
   - **api** — `apps/api` auth, config, controller, service and search input (FR-5 to FR-7).
   - **redos** — `packages/common/src/utils` (FR-8 to FR-10).
   - **plugins** — the 9 new company plugins and `source-ats-jibe` (FR-11 to FR-13).
4. **Adversarial verification per lane, then one repair round.** The plugins lane passed as written.
   The other three lanes' verifiers each found a remaining issue, and each was repaired on the same
   branch:
   - **http:** a caller-registered value overlapping a server secret could unmask its tail in the
     single-alternation scrub. Server secrets now go first, and text bodies are sanitised before the
     cut.
   - **api:** every `API_KEYS` key counted as an admin key. `include_raw` now has its own allow-list,
     `EVER_JOBS_INCLUDE_RAW_API_KEYS`, and an API-layer scrub.
   - **redos:** the first fix rebuilt the alias tables on every call, which made each call about 4×
     slower. The tables are now built once, and one scan is shared per parent.
5. **Merge the four lanes, then verify again.** A read-only final pass re-checked the repair commits
   and the combined branch (lanes http, api, redos and combined). The type-check, docs-lint and the
   targeted suites ran on the merged branch.

## 2. Checks

- `npx tsc --noEmit -p tsconfig.typecheck.json`: clean on the merged branch.
- `npm run lint:docs`: clean.
- Jest, run per lane with `--maxWorkers=2`:
  - **http:** `raw-capture*.spec.ts` plus the Personio, France Travail, Upwork and Adzuna specs;
    the http-client, crawl-policy, redirect, cookie and egress suites; and the API jobs specs.
  - **api:** 9 suites, 328 tests.
  - **redos:** the jsonld, location-object and job-post-normalize specs, plus the 33 plugin specs
    that call the mapper.
  - **plugins:** 10 suites, 260 tests (the baseline was 92).
- **Fail-before-fix:** each lane ran its new specs against the 553a789f versions of the files and
  confirmed they fail. For example, the normalizeJobPost red control did not finish within 280 s.
- **Timing assertions:** generous bounds only, under 1–5 s for inputs the vulnerable code took 10 s
  or more on, so CI on old CPUs does not flake.

## 3. Rollback

Revert the hardening merge commits on the sync branch. `include_raw` and the deadline override then
return to the fork's behaviour.
