# Tasks: 1761 — Fork sync 2026-11-17 hardening

> Status legend: `[ ]` pending • `[~]` in-progress • `[x]` done • `[-]` dropped

## Phase 1 — Review and merge

- [x] T01 — Read-only review of `a4621490..5fd45911` in five lanes, with 2-vote verification of every
  medium-or-higher finding (14 confirmed, 1 refuted).
- [x] T02 — Merge the fork tip with a merge commit (`9f106583`). Resolve `docs/log.md` and
  `docs/index.md`. Merge `develop` in again after #151, #153, #148 and #152.

## Phase 2 — Raw capture (http lane)

- [x] T03 — Normalised-substring key redaction for query params, fragments, JSON and form bodies,
  headers and text bodies (FR-1).
  - **Files:** `packages/common/src/http/raw-capture.ts`
- [x] T04 — Env and registered secret value scrub with encodings; server secrets first (FR-2).
  - **Files:** `raw-capture.ts`, the 5 keyed plugins
- [x] T05 — `rawCapture: false` opt-out plus the credential-endpoint heuristic. No bodies for token
  or auth calls. `jooble.org` path rule (FR-3).
  - **Files:** `http-client.ts`, `browser-pool.ts`, `raw-capture.interface.ts`, Upwork, France
    Travail, Personio, Adzuna, Jooble
- [x] T06 — `redactUrl` drops userinfo. Sanitise before cut. Buffers cut before decoding (FR-4).
  - **Acceptance:** a fake secret never appears in `JSON.stringify` of drained entries, for each
    leak path in spec §1.1. The Personio and France Travail specs fail on 553a789f.

## Phase 3 — API (api lane)

- [x] T07 — `include_raw` gate: operator flag, auth on, a key in `API_KEYS` and in
  `EVER_JOBS_INCLUDE_RAW_API_KEYS`; per-process concurrency cap (FR-5).
  - **Files:** `apps/api/src/auth/{api-key.guard,include-raw-access}.ts`,
    `apps/api/src/config/include-raw-config.ts`, `jobs.controller.ts`, `jobs.service.ts`
- [x] T08 — Metadata-only raw entries when the caller names the fetch target; API-layer scrub (FR-6).
  - **Files:** `search-input.ts`, `raw-entry-redaction.ts`
- [x] T09 — `deadline_ms` ceiling defaults to the fan-out deadline; unbounded only on opt-in; strict
  parsing; 2^31−1 clamp (FR-7).
  - **Files:** `apps/api/src/config/search-deadline-config.ts`, `jobs.controller.ts`

## Phase 4 — CPU (redos lane)

- [x] T10 — Linear edge trim in `normalizeJobPost` (FR-8).
- [x] T11 — Bounded, linear location-object mapper and page cap (FR-9).
- [x] T12 — Linear `ld+json` script extraction (FR-10).
  - **Acceptance:** 100k interior spaces or U+200B normalise in under 1 s; a 300×300 nested address
    maps in under 2 s; existing behaviour specs unchanged.

## Phase 5 — New plugins (plugins lane)

- [x] T13 — Pin-or-ignore `companyUrl` plus `allowedRedirectHosts` in the 9 new company plugins
  (FR-11).
- [x] T14 — Revoy doc pin, caps and linear regexes; Werco detail-link pin, cap and sequential fetch;
  comma_ai and thoron_us linear literal parsers and chunk pin (FR-12).
- [x] T15 — Jibe tenant guard; `firstPublicUrl()` for scraped apply URLs (FR-13).
  - **Acceptance:** an off-host, http or userinfo `companyUrl` falls back to the default; a
    60-backslash `scalarField` and 100 KB Revoy padding finish fast.

## Phase 6 — Verification and docs

- [x] T16 — Adversarial verification per lane, a repair round, and a final read-only pass on the
  merged branch.
- [x] T17 — `.env.example` documents the new switches. API changelog entry. Dated notes in Specs 5161
  and 5164. Log and index entries.
- [ ] T18 — Follow-ups (spec §4): `source-jsonld` body cap; value-scrub registration for every
  keyed plugin; Tesla browser fallback; Workday facet pass.
