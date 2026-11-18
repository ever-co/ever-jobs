# Spec: 1761 — Fork sync 2026-11-17 hardening: raw-capture credential leaks, include_raw gate, deadline cap, ReDoS, unpinned company URLs

| Field          | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| Spec ID        | 1761                                                         |
| Slug           | fork-sync-2026-11-17-hardening                               |
| Status         | Implemented                                                  |
| Owner          | agent                                                        |
| Created        | 2026-11-18                                                   |
| Last updated   | 2026-11-18                                                   |
| Supersedes     | —                                                            |
| Related specs  | 1689, 5161, 5164, 5153–5175 (fork), 5171, 5172, 5173         |

## 1. Problem Statement

Branch `fork-sync/makedeeply-2026-11-17` merges the MakeDeeply fork tip `5fd45911` (fork PRs up to
#185, Specs 5153–5175: 67 commits, 264 files, +19,391 / −748 against the merge base `a4621490`)
into `develop` with a merge commit (`9f106583`), so the fork tip stays an ancestor of `develop`.

Before any fork code ran, the diff was reviewed read-only in five lanes: http/core, API, the 10 new
plugins, the 32 changed plugins, and utils/config/metadata. That last lane covered hidden Unicode,
agent-directed text, commit authors and lint/test suppressions. Every medium-or-higher finding was
then checked by two independent skeptics told to refute it. 14 of 15 were confirmed. The 15th, Comeet
fetching `companyUrl` unpinned, was refuted: it predates this sync.

**What the review did not find.** No supply-chain change: the new plugin `package.json` files have
no scripts, dependencies or install hooks. No `eval`, `new Function`, `vm`, `child_process`, dynamic
`require` or fs writes in added source, apart from the constant `import('playwright')` shim in
`source-tesla`. No bidi controls, TAG characters or agent-directed text in the 2.7 MB diff or in the
67 commit messages. No guard (`pinUrlToHosts`, `allowedRedirectHosts`, `assertPublic*`, redaction)
removed from a changed plugin.

**What it did find:**

### 1.1 `include_raw` returned the server's own credentials (Spec 5161) — high

`POST /api/jobs/search?include_raw=true` returns one source's upstream requests and responses as
`raw_by_source`. Those requests are made with **this server's** credentials. The capture reused the
log-line redactor, whose key list is anchored (`^(?:api[-_]?key|access[-_]?token|token|secret|…)$`).
Response bodies were not redacted at all. Reproduced with the fork's own helpers:

- Adzuna `app_id` / `app_key` in `final_url`: follow-redirects' `responseUrl` carries axios `params`.
- The Jooble API key as a path segment of `url`.
- Personio `client_id` / `client_secret` in `request_body`, recorded before the request is sent.
- OAuth token responses (Upwork access and refresh token, France Travail and Personio bearer
  tokens) and error bodies that echo `client_secret`, kept verbatim.
- `redactUrl` kept `user:pass@` userinfo.

### 1.2 `include_raw` was ungated — medium

Any caller could use it: on the standard tier, or anyone at all while API-key auth is off (the
default). With `source-jsonld` and a caller-supplied `companyUrl`, it became a full-read fetch proxy
for any URL the egress guard allows (up to 5 MiB per body). Under the `legacy` crawl preset, private
and metadata hosts are reachable too.

### 1.3 `deadline_ms` could switch the fan-out deadline off (Spec 5164) — medium

With `EVER_JOBS_SEARCH_DEADLINE_MAX_MS` unset (the default), there was no ceiling. `deadline_ms=0`,
`deadline_ms=` (`Number('') === 0`) or any large value let an anonymous caller keep handlers, sockets
and browser contexts alive with no fan-out abort.

### 1.4 Quadratic CPU in shared normalisers — high

- **`normalizeJobPost`** (`EDGE_WS_RE = /^[\s\u200B-\u200D\uFEFF]+|[\s\u200B-\u200D\uFEFF]+$/g`) runs on every fresh search
  result. 80k interior spaces took 18 s and 40k U+200B took 9 s, on one field of one job. The input
  is attacker-hostable through a caller's `companyUrl` or `companySlug`.
- **The location-object mapper** (Spec 5171): expanding an `address` array cloned every parent key
  per entry, and `buildExtras` re-stringified the extras on every field. A 35 KiB JSON-LD block
  blocked the event loop for about 94 s. It is reachable from `source-jsonld` with a caller
  `companyUrl` and from the 29 + 4 plugins moved to the mapper (Specs 5172, 5173).
- **Found while fixing:** `jsonld.ts` `SCRIPT_BLOCK_RE` (Spec 5022, in a fork-changed file) was
  quadratic on unclosed `<script ` openers: 125 KiB took 4.5 s.

### 1.5 The 9 new company plugins fetched any `companyUrl` — high/medium

`buildnebula`, `comma_ai`, `int-dyn`, `minervahumanoids`, `revoy`, `thoron_us`, `wercomfg`,
`xgsenergy` and `xlight` skip the Spec 1689 pin-or-ignore check and pass no
`allowedRedirectHosts`. That reopens the SSRF and request-relay hole PR #91 closed. Also:

- **Revoy:** the caller's page chooses which Google Docs are fetched, with no cap, and five of the
  doc-header regexes were quadratic.
- **Werco:** every detail link scraped from the page was fetched on any host, all at once.
- **`comma_ai` and `thoron_us`:** they bring back the exponential `scalarField` regex Spec 1689
  removed. Comma's `templateField` has the same flaw.
- **Low note:** `source-ats-jibe` accepted any scheme, port, IP literal or private host.

## 2. Requirements and what was done

| # | Requirement | Where |
| - | ----------- | ----- |
| FR-1 | Credential-named keys are redacted by normalised substring (lower-cased, `_`/`-` removed: `secret`, `token`, `passw(or)d`, `apikey`, `appkey`, `credential`, `signature`, `cookie`, `session`, `private`, `auth` except `author`/`authority`; `key`/`sig`/`pwd`/`pass` as the whole key or its last word). This covers query params (URL-decoded), fragments, nested JSON and form bodies, headers, and JSON, form or JSON-ish response and error text. Linear scans only. | `packages/common/src/http/raw-capture.ts` |
| FR-2 | Secret values are scrubbed from every captured field. Sources: env vars whose names match `KEY\|SECRET\|TOKEN\|PASSWORD\|PASSWD\|CREDENTIAL\|CLIENT_ID\|APP_ID` (8+ chars, comma lists split; `_URL/_URI/_HOST/_PORT/_PATH/_FILE/_DIR/_ENDPOINT` skipped), plus values plugins register with `registerRawCaptureSecrets`. One exported classifier (`isSecretEnvName`) decides which env names count; setting names such as `_NAME`, `_HEADER`, `_URL` and keyword lists do not. Each value is matched raw, percent-encoded (both hex cases), form-encoded, JSON-escaped, in the axios params form and in the `URLSearchParams` form. The value scrub runs **before** the key-name text rules, so a secret containing `;`, `&`, `)` or a space is never cut in half. Server-held secrets are scrubbed before caller-supplied values, so an overlapping caller value cannot unmask one. | same |
| FR-3 | Token and auth calls never keep a body (request or response, success or error). A per-request `rawCapture: false` on `CrawlRequestConfig` is stripped before axios and carried across redirect hops. A path heuristic (`isCredentialEndpoint`) also matches `oauth*`, `*token(s)`, `auth`, `login`, `authorize`, `introspect`, `revoke` and `grant_type=`. Such entries carry `bodies_withheld` and keep method, URL, status, timing and size. Upwork, France Travail and Personio opt out and register their credentials and tokens; Adzuna and Jooble register their keys; `jooble.org` (and subdomains) gets a path rule. | `http-client.ts`, `browser-pool.ts`, 5 plugins |
| FR-4 | `redactUrl` drops userinfo. Bodies are sanitised on a window 16 KiB past the cap and cut afterwards, so a secret that straddles the cut is not left half visible. Buffers are cut before decoding, binary content types are not decoded, and the browser pool stops pulling bodies once the source budget is spent. | `raw-capture.ts`, `browser-pool.ts` |
| FR-5 | `include_raw` requires, in order: `EVER_JOBS_INCLUDE_RAW_ENABLED=true` (default off → 403); API-key auth on (503 while off); a key that is in `API_KEYS` **and** in `EVER_JOBS_INCLUDE_RAW_API_KEYS` (403 for a missing or unknown key, answered first by the global API-key guard, or for a key not listed; 503 with no `API_KEYS` or an empty list; constant-time compare). The check runs per request, before the cache and the scrape. The endpoint stays public without `include_raw`. `JobsService` refuses `captureRaw` again while the flag is off. At most `EVER_JOBS_INCLUDE_RAW_MAX_CONCURRENT` (default 2) such searches run per process; more get 429. | `apps/api/src/auth/include-raw-access.ts`, `config/include-raw-config.ts`, `jobs.controller.ts`, `jobs.service.ts` |
| FR-6 | A request that names its own fetch target (a non-blank `companyUrl`, or a `companySlug` outside `[A-Za-z0-9_:-]`) gets metadata-only raw entries, built from an allow-list (`body_withheld: 'caller_supplied_url'`). The API then runs a thin last pass over every entry with the same tiered scrubber from `packages/common` (env values first, caller `input.auth` values second). It rewrites a JSON text body only when something was redacted, so an unredacted body comes back byte for byte. | `search-input.ts`, `raw-entry-redaction.ts` |
| FR-7 | `deadline_ms` can only shorten the fan-out deadline unless the operator opts in. With `EVER_JOBS_SEARCH_DEADLINE_MAX_MS` unset, the ceiling is the fan-out deadline; `0` or a larger value is capped unless `EVER_JOBS_SEARCH_DEADLINE_ALLOW_UNBOUNDED=true`. A blank, whitespace, non-integer, negative, `Infinity` or repeated value gets 400. An invalid configured maximum is logged and fails closed. Values are clamped to 2^31−1 ms (setTimeout overflow), and the applied value is sent in `X-Search-Deadline-Ms`. | `config/search-deadline-config.ts`, `jobs.controller.ts` |
| FR-8 | `normalizeJobPost` trims with two index loops over the same character set. No `/[…]+$/` regex is left. | `utils/job-post-normalize.ts` |
| FR-9 | The location-object mapper is bounded and linear: at most 20 `address`/`postalAddress` entries, the first 200 own keys per object, alias tables built once per module (custom ones cached), extras sized incrementally, and one shared scan per parent instead of a clone per address. A page maps at most 2,000 JSON-LD addresses. | `utils/location-object.ts`, `utils/jsonld.ts` |
| FR-10 | `ld+json` script extraction uses forward-only index scans. | `utils/jsonld.ts` |
| FR-11 | Each of the 9 new company plugins pins `companyUrl` to its own domain with `pinUrlToHosts(…, { upgradeHttp: true })`, falls back to its default URL with a host-only debug log, and passes `allowedRedirectHosts`. `buildnebula` and `minervahumanoids` derive the origin from the pinned URL. | 9 plugins |
| FR-12 | Revoy reads doc ids only from pinned-page links to `https://docs.google.com`. It fetches at most 50 docs, caps each export at 2 MB and parses the first 64 KB, and its header regexes are linear. Werco pins every detail link to `wercomfg.com`, caps them at 50 and fetches them one at a time. `comma_ai` and `thoron_us` use the disjoint-alternative `scalarField`; comma's `templateField` is linear and its chunk path is pinned to `comma.ai`. | revoy, wercomfg, comma_ai, thoron_us |
| FR-13 | Jibe refuses credentials, explicit ports, IP literals and non-public hostnames, upgrades http to https and pins redirects to the tenant. Scraped apply URLs in minervahumanoids, Werco and Jibe go through `firstPublicUrl()`. | `source-ats-jibe`, 3 plugins |

## 3. Behaviour changes (all deliberate)

- **`include_raw`** is off unless the operator enables it and lists the keys allowed to use it. A
  deploy that relied on the fork's open `include_raw` now gets 403 or 503.
- **`deadline_ms`** above the fan-out deadline, or `0`, is capped unless the operator opts in. A
  blank value is now a 400 instead of "no deadline".
- **Raw entries** show `REDACTED` where a credential was. The values of any env var whose name looks
  like a credential (6 or more characters) are scrubbed too. Setting names (`_NAME`, `_HEADER`,
  `_URL`, keyword lists) are not treated as credentials. This affects only the debug capture.
- **Oversized inputs only:**
  - Objects with more than 200 keys are read by their first 200.
  - Only 20 address entries per object, and 2,000 per page, are mapped.
  - Revoy reads 50 docs, and Werco 50 detail pages.
- **Revoy's** header labels allow only spaces and tabs before them. A label indented with U+00A0 is no
  longer read. No real export does this.

## 4. Known gaps

- Caller-supplied `input.auth` values are scrubbed by value only for the 5 plugins that register them.
  For other plugins they are covered by key names, path rules and the auth-endpoint heuristic.
- `source-jsonld` sets no `maxContentLength`. Mapping is bounded (FR-9), but extracting and parsing a
  huge body is still linear in its size.
- `isPubliclyRoutableHostname` judges a name by its shape. A two-label in-cluster name such as
  `svc.namespace` passes the name check, and the egress guard's resolved-IP check is what stops it
  (as Spec 1689 documents).
- Raw capture, residual and pre-existing: the whole-value oracle any value scrub has (one include_raw
  request with a long `searchTerm` tests many windows against env secrets; it needs an include_raw key);
  very long caller `input.auth` values (38k+ characters) make the caller-tier pattern throw, which fails
  the scrape closed; the PHP `\/`, HTML-entity and `encodeURI` forms of a secret are not matched.
- JSON-LD, pre-existing: malformed `ld+json` blocks are not capped (about 1 s per MiB of them),
  `collectJobPostings` recursion has no depth bound (a deep block rejects the scrape), and the
  per-page address cap drops later postings' locations without a log line.
- The changed-plugins lane's low notes are left for later: Tesla's browser fallback starts its own
  Chromium, and the Workday category-facet pass walks the whole board.
