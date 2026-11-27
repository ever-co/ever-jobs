import { BadRequestException } from '@nestjs/common';
import { SITE_CATEGORIES, SiteCategory, isSiteCategory } from '@ever-jobs/models';

/**
 * Search-input normalisation shared by every entry point (Spec 1720).
 *
 * REST, GraphQL, the CLI and unit tests all reach `JobsService`, and only the
 * REST path runs `ValidationPipe`. Normalising here — not in a DTO
 * `@Transform` — is what gives every caller the same list-mode semantics.
 */

/**
 * Progress snapshot reported by the fan-out (Spec 1721 NDJSON heartbeat).
 * `jobs` counts raw (pre-dedup) jobs collected so far.
 */
export interface SearchProgress {
  sourcesDone: number;
  sourcesTotal: number;
  jobs: number;
}

/** Optional per-call hooks for `JobsService.searchJobsWithDiagnostics`. */
export interface SearchRunOptions {
  /** Called once when the fan-out starts, then after every source settles. */
  onProgress?: (progress: SearchProgress) => void;
  /**
   * Spec 1721 / FR-14 — polled before each source is STARTED, next to the
   * deadline check. Once it returns `true` no further source starts (in-flight
   * ones finish) and the result carries `cancelled: true`. The NDJSON path
   * passes "the client has disconnected".
   */
  isCancelled?: () => boolean;
  /**
   * Spec 5161 — capture raw HTTP for the request's single source into
   * `rawBySource`. Valid only when the request resolves to exactly one
   * source; the service 400s otherwise.
   */
  captureRaw?: boolean;
  /**
   * Spec 5164 — per-request fan-out deadline override in ms (`0` disables the
   * deadline for this call). Single-source requests only, like `captureRaw`.
   */
  deadlineMs?: number;
}

/**
 * Reduce a caller-supplied keyword to either a trimmed non-empty string or
 * `undefined`. `undefined`, `null`, `""` and whitespace-only all mean
 * "no keyword" — list mode. Non-strings (a number sent over GraphQL/CLI) are
 * treated as absent rather than stringified into a query.
 */
export function normalizeSearchTerm(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalise the keyword fields of `input` in place and return it. Idempotent,
 * so the controller (before its cache lookup) and the service (for direct
 * callers) can both call it.
 *
 * An absent keyword is *deleted*, not set to `undefined`, so the cache key and
 * any `JSON.stringify` of the input are identical to a request that never sent
 * the field.
 */
export function normalizeSearchInput<T extends { searchTerm?: unknown; googleSearchTerm?: unknown }>(
  input: T,
): T {
  for (const key of ['searchTerm', 'googleSearchTerm'] as const) {
    if (!(key in input)) continue;
    const normalised = normalizeSearchTerm(input[key]);
    if (normalised === undefined) {
      delete input[key];
    } else {
      input[key] = normalised as T[typeof key];
    }
  }
  return input;
}

/**
 * Clamp `input.resultsWanted` to `max` in place (Spec 1720 / FR-12).
 * `max <= 0` means no cap. Returns the value the caller asked for when it was
 * clamped (for a log line), `undefined` otherwise. Idempotent, so the
 * controller (before its cache key) and the service (for every other entry
 * point) can both call it.
 */
export function clampResultsWanted(
  input: { resultsWanted?: number },
  max: number,
): number | undefined {
  if (!(max > 0)) return undefined;
  const requested = input.resultsWanted;
  if (typeof requested !== 'number' || Number.isNaN(requested) || requested <= max) {
    return undefined;
  }
  input.resultsWanted = max;
  return requested;
}

/** Operator opt-in that lets REST callers send `caCert` (T-2880). Off by default. */
export const ALLOW_CALLER_INSECURE_TLS_ENV_VAR = 'EVER_JOBS_ALLOW_CALLER_INSECURE_TLS';

/**
 * Drop a REST caller's `caCert` unless the operator allows it (T-2880).
 *
 * `caCert` loads no CA. Any non-empty value makes `HttpClient` build its agents
 * with `rejectUnauthorized: false`, so a caller could turn off upstream
 * certificate checks for every direct HTTPS request of its search, including
 * sources that send the operator's API keys. That choice is the operator's:
 * the CLI's `--ca-cert` calls `JobsService` directly and keeps it, and
 * {@link ALLOW_CALLER_INSECURE_TLS_ENV_VAR}`=true` lets REST callers send it.
 *
 * The controller calls this before the cache key, so the field reaches neither
 * the key nor any plugin. The key is deleted (not set to `undefined`), so the
 * cache key equals that of a request that never sent it. Logs one warning when
 * the caller had set a value, without the value. Idempotent.
 */
export function dropCallerCaCert(
  input: { caCert?: unknown },
  allowCallerInsecureTls: boolean,
  logger: { warn(message: string): void },
): void {
  if (allowCallerInsecureTls || !('caCert' in input)) return;
  const supplied = input.caCert !== undefined && input.caCert !== null;
  delete input.caCert;
  if (supplied) {
    logger.warn(
      `caCert ignored: a request may not turn off upstream TLS certificate checks ` +
        `(${ALLOW_CALLER_INSECURE_TLS_ENV_VAR}=true allows it)`,
    );
  }
}

/** True when the request carries no usable keyword (Spec 1720 list mode). */
export function isListMode(input: { searchTerm?: unknown }): boolean {
  return normalizeSearchTerm(input.searchTerm) === undefined;
}

/**
 * Render the keyword for a log line: `<none>` in list mode, a JSON-quoted
 * string otherwise — never the literal `undefined` or `null`.
 */
export function describeTerm(input: { searchTerm?: unknown }): string {
  const term = normalizeSearchTerm(input.searchTerm);
  return term === undefined ? '<none>' : JSON.stringify(term);
}

/**
 * Validate `siteCategories` for callers that bypass `ValidationPipe`.
 * Returns `undefined` when the filter is absent or empty (no narrowing), the
 * de-duplicated set otherwise.
 *
 * @throws {@link BadRequestException} naming the unknown values and the
 *         allowed list.
 */
export function parseSiteCategories(raw: unknown): Set<SiteCategory> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new BadRequestException(
      `siteCategories must be an array of: ${SITE_CATEGORIES.join(', ')}`,
    );
  }
  if (raw.length === 0) return undefined;
  const unknown = raw.filter((value) => !isSiteCategory(value));
  if (unknown.length > 0) {
    throw new BadRequestException(
      `Unknown siteCategories value(s): ${unknown.map((v) => JSON.stringify(v)).join(', ')}. ` +
        `Allowed: ${SITE_CATEGORIES.join(', ')}`,
    );
  }
  return new Set(raw as SiteCategory[]);
}

/**
 * Characters a `companySlug` may hold without being able to name a host of
 * its own. A dot is left out on purpose: several ATS plugins treat a dotted
 * slug as a bare hostname (`https://${slug}`), and Avature builds
 * `https://${slug}.avature.net`, where `/`, `?`, `#` or `@` end the host
 * early. `:` stays allowed for the Workday `company:wd:site` compound slug,
 * which only ever lands inside a `*.myworkdayjobs.com` URL.
 */
const HOST_NEUTRAL_SLUG = /^[A-Za-z0-9_:-]+$/;

/**
 * Did the CALLER choose what the selected source fetches? (Spec 5161
 * hardening, fork sync.) True when the request carries a `companyUrl`
 * (jsonld and the company-URL plugins fetch it as given; the ATS fallback
 * derives its target from it), or a `companySlug` that can name a host
 * rather than a tenant on the plugin's own domain.
 *
 * `include_raw` keeps only request metadata for such a request: with bodies,
 * it would hand the caller the full content of any URL the egress guard
 * allows, fetched from the server's own address.
 */
export function callerSuppliesFetchTarget(input: {
  companyUrl?: unknown;
  companySlug?: unknown;
}): boolean {
  const { companyUrl, companySlug } = input;
  if (typeof companyUrl === 'string') {
    if (companyUrl.trim() !== '') return true;
  } else if (companyUrl !== undefined && companyUrl !== null) {
    // Not a string (GraphQL / CLI bypass ValidationPipe): be conservative.
    return true;
  }

  if (typeof companySlug === 'string') {
    const slug = companySlug.trim();
    return slug !== '' && !HOST_NEUTRAL_SLUG.test(slug);
  }
  return companySlug !== undefined && companySlug !== null;
}
