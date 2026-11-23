/**
 * Ever Jobs MCP Server — Tool implementations
 *
 * These functions connect to the Ever Jobs REST API (or can be used standalone)
 * to search for jobs across 166+ sources.
 */

import axios, { AxiosInstance } from 'axios';

// ── Configuration ──────────────────────────────────────────────────────

/** Read per call (not at import) so the configured URL is always the one reported. */
function getApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.EVER_JOBS_API_URL ?? 'http://localhost:3001';
}

/**
 * Which key spelling `searchJobs` uses in the `POST /api/jobs/search` body
 * (Spec 1689).
 *
 * The API validates the body against `ScraperInputDto` under a global
 * `ValidationPipe({ whitelist: true })`, and that DTO only declares camelCase
 * properties (`searchTerm`, `siteType`, `companySlug`, `resultsWanted`). The
 * legacy snake_case keys were therefore stripped before the handler ran, so an
 * MCP search went out with no search term, no source filter and the DTO's
 * default page size — i.e. a fan-out across the whole catalogue.
 *
 *  - `camel` (default) — the keys `ScraperInputDto` accepts.
 *  - `snake` — the legacy wire shape, kept for API servers that expect it.
 *  - `both`  — send both spellings (whitelisting servers drop the extra set).
 *
 * Unrecognised values fall back to `camel`.
 */
export type SearchRequestKeyStyle = 'camel' | 'snake' | 'both';

export const MCP_REQUEST_KEYS_ENV_VAR = 'EVER_JOBS_MCP_REQUEST_KEYS';

export function readSearchRequestKeyStyle(
  env: NodeJS.ProcessEnv = process.env,
): SearchRequestKeyStyle {
  const raw = env[MCP_REQUEST_KEYS_ENV_VAR]?.trim().toLowerCase();
  return raw === 'snake' || raw === 'both' ? raw : 'camel';
}

/**
 * How `JobResult.location` is rendered from the API's structured
 * `LocationDto` (Spec 1689).
 *
 *  - `full` (default) — `city, state, country` joined, falling back to the
 *    source's `name`, then its raw `text`, then `null`. Mirrors the CLI's
 *    CSV rendering (apps/cli/src/commands/search.command.ts).
 *  - `city` — the legacy output: the `city` field alone when there is one.
 *    Jobs without a city fall back to the `full` rendering, so the declared
 *    `string | null` contract holds (the old code returned the whole location
 *    object in that case).
 *
 * Unrecognised values fall back to `full`.
 */
export type LocationFormat = 'full' | 'city';

export const MCP_LOCATION_FORMAT_ENV_VAR = 'EVER_JOBS_MCP_LOCATION_FORMAT';

export function readLocationFormat(
  env: NodeJS.ProcessEnv = process.env,
): LocationFormat {
  const raw = env[MCP_LOCATION_FORMAT_ENV_VAR]?.trim().toLowerCase();
  return raw === 'city' ? 'city' : 'full';
}

export const MCP_API_KEY_ENV_VAR = 'EVER_JOBS_API_KEY';
export const MCP_API_KEY_HEADER_ENV_VAR = 'EVER_JOBS_API_KEY_HEADER';
const DEFAULT_API_KEY_HEADER = 'x-api-key';

/**
 * Headers for every API request. When `EVER_JOBS_API_KEY` is set the key is
 * sent under `EVER_JOBS_API_KEY_HEADER` (default `x-api-key`, matching the
 * API's `API_KEY_HEADER_NAME` default); with no key, no key header is sent.
 */
function buildHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = env[MCP_API_KEY_ENV_VAR]?.trim();
  if (apiKey) {
    const headerName = env[MCP_API_KEY_HEADER_ENV_VAR]?.trim() || DEFAULT_API_KEY_HEADER;
    headers[headerName] = apiKey;
  }
  return headers;
}

/**
 * `EVER_JOBS_API_URL` as it may appear in a tool error: any `user:password@`
 * part is dropped, so basic-auth credentials put in the URL are never echoed
 * to the MCP client.
 */
export function displayApiUrl(url: string = getApiUrl()): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1');
}

/**
 * The reason text for a failed API request. A refused connection names the
 * API URL, so an unreachable API never looks like "no jobs found". An error
 * with no message (Node's AggregateError when every address of a dual-stack
 * host such as `localhost` fails) falls back to its code.
 */
export function describeRequestError(err: any, url: string = getApiUrl()): string {
  if (err?.code === 'ECONNREFUSED') {
    return (
      `the Ever Jobs API at ${displayApiUrl(url)} is unreachable (connection refused). ` +
      'Check that it is running and that EVER_JOBS_API_URL is correct.'
    );
  }
  return err?.message || err?.code || String(err);
}

function getClient(): AxiosInstance {
  return axios.create({
    baseURL: getApiUrl(),
    timeout: 60_000,
    headers: buildHeaders(),
  });
}

// ── Types ──────────────────────────────────────────────────────────────

export interface JobSearchParams {
  query: string;
  location?: string;
  /** Spec 1700 — several locations; each source is searched once per location. */
  locations?: string[];
  source?: string;
  /**
   * Several sources to search (sent as `siteType`). Used only when `source` is
   * not set; with neither, the API searches its default catalogue.
   */
  sources?: string[];
  company?: string;
  limit?: number;
  remoteOnly?: boolean;
  /** Spec 1700 — drop jobs whose title contains any of these words/phrases. */
  excludeTitleTerms?: string[];
  /** Spec 1700 — drop jobs whose title or description contains any of these. */
  excludeKeywords?: string[];
  /** Spec 1700 — curated exclusion lists (e.g. `security_clearance`). */
  excludePresets?: string[];
  /**
   * Per-request crawl policy (Spec 1690), forwarded to the API unchanged as the
   * camelCase `crawl` object (e.g. `{ maxConcurrentPerHost: 1, minIntervalMs: 1000 }`).
   * The API validates it and applies the operator's `EVER_JOBS_CRAWL_CALLER_OVERRIDES`.
   */
  crawl?: McpCrawlPolicy;
}

/** A crawl-policy object as the API's `crawl` field accepts it (camelCase keys). */
export type McpCrawlPolicy = Record<string, unknown>;

// ── Crawl policy (Spec 1690) ───────────────────────────────────────────
//
// The MCP server is packaged on its own (`apps/mcp`, rootDir `src`), so it
// cannot import `@ever-jobs/models`; the allowed values mirror
// `CRAWL_POLICY_DTO_VALUES` there. `apps/mcp/__tests__/crawl.spec.ts` fails if
// the two drift apart.

/** Allowed values of the enum-like crawl-policy fields. */
export const MCP_CRAWL_ENUMS = {
  userAgentMode: ['identify', 'strict', 'plugin'],
  proxyRotation: ['per-request', 'per-scrape', 'per-host', 'off'],
  rateLimitScope: ['host', 'domain', 'site'],
  retryBackoff: ['exponential', 'linear', 'constant'],
  retryAfterOverMax: ['give-up', 'cap'],
  robotsTxt: ['off', 'crawl-delay', 'respect'],
  discovery: ['auto', 'sitemap', 'listing'],
} as const;

const nonNegativeInt = (description: string) => ({ type: 'integer', minimum: 0, description });

/** `MAX_CRAWL_RETRIES` of `@ever-jobs/models` (copied: this package cannot import it; a test pins the copy). */
export const MCP_MAX_CRAWL_RETRIES = 10;

/**
 * JSON Schema of the `crawl` argument of the `search_jobs` tool. Every field
 * is optional; the API is the authority on validation.
 */
export const CRAWL_POLICY_INPUT_SCHEMA = {
  type: 'object',
  description:
    'Optional per-request crawl policy (Spec 1690), sent to the API as `crawl` with camelCase keys, ' +
    'e.g. {"maxConcurrentPerHost":1,"minIntervalMs":1000,"discovery":"sitemap"}. ' +
    'The operator may restrict what a caller can change (EVER_JOBS_CRAWL_CALLER_OVERRIDES), and a site owner ' +
    'may lock its own sources (Spec 1714: e.g. Softy only accepts values that make its traffic more polite); ' +
    'the preset (EVER_JOBS_CRAWL_PRESET) is server-wide and cannot be chosen here.',
  additionalProperties: false,
  properties: {
    userAgent: { type: 'string', description: 'User-Agent to send (keywords: default, browser).' },
    userAgentMode: { type: 'string', enum: [...MCP_CRAWL_ENUMS.userAgentMode] },
    from: { type: 'string', description: 'From: request header (contact address).' },
    stripClientHints: { type: 'boolean' },
    proxyRotation: { type: 'string', enum: [...MCP_CRAWL_ENUMS.proxyRotation] },
    rateLimitScope: { type: 'string', enum: [...MCP_CRAWL_ENUMS.rateLimitScope] },
    maxConcurrentPerHost: nonNegativeInt('Max requests in flight per host/domain/site bucket. 0 = unlimited.'),
    minIntervalMs: nonNegativeInt('Minimum gap between request starts in a bucket, ms.'),
    jitterMs: nonNegativeInt('Random extra 0..jitterMs per gap, ms.'),
    maxQueueWaitMs: nonNegativeInt('Longest wait for a slot before failing fast, ms. 0 = no limit.'),
    adaptiveThrottle: { type: 'boolean' },
    minGapMs: nonNegativeInt(
      'Minimum idle time after a request of the bucket completes before the next one starts, ms, on top of minIntervalMs. 0 = off (Spec 1714).',
    ),
    serverErrorCooldownMs: nonNegativeInt(
      'Whole-bucket cool-down after a 500/502/504, a timeout or a connection reset, ms. 0 = off (Spec 1714).',
    ),
    retries: {
      ...nonNegativeInt(`Retries per request on a retryable status, 0-${MCP_MAX_CRAWL_RETRIES}.`),
      maximum: MCP_MAX_CRAWL_RETRIES,
    },
    retryStatuses: { type: 'array', items: { type: 'integer', minimum: 100, maximum: 599 } },
    retryBackoff: { type: 'string', enum: [...MCP_CRAWL_ENUMS.retryBackoff] },
    retryBaseDelayMs: nonNegativeInt('Base retry delay, ms.'),
    retryMaxDelayMs: nonNegativeInt('Cap on one retry delay, ms.'),
    retryJitter: { type: 'boolean' },
    retryOnNetworkError: { type: 'boolean' },
    respectRetryAfter: { type: 'boolean' },
    maxRetryAfterMs: nonNegativeInt('A Retry-After longer than this triggers retryAfterOverMax, ms.'),
    retryAfterOverMax: { type: 'string', enum: [...MCP_CRAWL_ENUMS.retryAfterOverMax] },
    throttleRetryDelayMs: nonNegativeInt(
      'Back-off floor after a 429/503, ms: retry n waits at least this x 2^n; also the minimum host cool-down. 0 = no floor.',
    ),
    robotsTxt: { type: 'string', enum: [...MCP_CRAWL_ENUMS.robotsTxt] },
    blockPrivateNetworks: { type: 'boolean' },
    discovery: { type: 'string', enum: [...MCP_CRAWL_ENUMS.discovery] },
  },
} as const;

/**
 * Accept the tool's `crawl` argument as an object or as a JSON-object string
 * (some clients stringify nested arguments). Returns `undefined` when absent or
 * empty; throws on anything else so the tool reports the mistake instead of
 * silently searching with the server defaults.
 */
export function normalizeMcpCrawl(raw: unknown): McpCrawlPolicy | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('crawl must be an object (or a JSON object string)');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('crawl must be an object (or a JSON object string)');
  }
  return Object.keys(value as object).length > 0 ? { ...(value as McpCrawlPolicy) } : undefined;
}

/** Largest `locations` list the API accepts (Spec 1700); longer lists are cut here instead of 400ing. */
export const MCP_MAX_LOCATIONS = 25;
/** Longest accepted `locations` entry (Spec 1700). */
export const MCP_MAX_LOCATION_LENGTH = 200;
/** Most terms per exclusion list the API accepts (Spec 1700). */
export const MCP_MAX_EXCLUSION_TERMS = 50;
/** Longest accepted exclusion term (Spec 1700). */
export const MCP_MAX_EXCLUSION_TERM_LENGTH = 100;
/** A search tool's `limit` when none, or no usable one, is given (T-2585). */
export const MCP_DEFAULT_SEARCH_LIMIT = 20;
/** Most jobs one search tool call returns, and the largest `resultsWanted` sent (T-2585). */
export const MCP_MAX_SEARCH_LIMIT = 100;

/**
 * Posting-time detail (Spec 1696). Each key is present only when the API sent
 * it (the source gave finer-than-day information), so a job without it keeps
 * its previous shape.
 */
export interface PostedTimeDetail {
  /** Posting instant, ISO-8601 UTC; only for precision exact, minute or hour. `date_posted` stays the date. */
  date_posted_at?: string;
  /** exact | minute | hour | day | week | month | year. */
  date_posted_precision?: string;
  /** timestamp | date | relative (estimated from an age label at fetch time). */
  date_posted_basis?: string;
}

export interface JobResult extends PostedTimeDetail {
  id: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  description: string | null;
  date_posted: string | null;
  is_remote: boolean;
  source: string;
  salary: string | null;
  department: string | null;
}

export interface SearchResponse {
  /** Jobs returned in `jobs`: at most the search's `limit` (T-2585). */
  total: number;
  /**
   * Jobs found (after `remote_only`) before the list was cut to `limit`
   * (T-2585). Present only when jobs were cut, so a response within the limit
   * keeps its previous shape.
   */
  total_found?: number;
  jobs: JobResult[];
  sources_searched: string[];
  query: string;
  /**
   * Jobs the API removed with the exclusion filters (Spec 1700). Present only
   * when the search carried an exclusion list, so an unfiltered response keeps
   * its previous shape.
   */
  excluded?: number;
}

export interface JobDetailsResponse extends PostedTimeDetail {
  id: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  description: string | null;
  full_description: string | null;
  date_posted: string | null;
  is_remote: boolean;
  source: string;
  salary: string | null;
  department: string | null;
  application_url: string | null;
}

export interface SourceInfo {
  name: string;
  id: string;
  type: 'job_board' | 'ats' | 'company' | 'remote' | 'aggregator';
  requires_company_slug: boolean;
  description: string;
}

// ── Source Catalog ──────────────────────────────────────────────────────

const SOURCES: SourceInfo[] = [
  // Job Boards
  { name: 'LinkedIn', id: 'linkedin', type: 'job_board', requires_company_slug: false, description: 'Largest professional job board' },
  { name: 'Indeed', id: 'indeed', type: 'job_board', requires_company_slug: false, description: 'Most popular general job search engine' },
  { name: 'Glassdoor', id: 'glassdoor', type: 'job_board', requires_company_slug: false, description: 'Job board with company reviews and salary data' },
  { name: 'ZipRecruiter', id: 'zip_recruiter', type: 'job_board', requires_company_slug: false, description: 'AI-powered job matching platform' },
  { name: 'Google Jobs', id: 'google', type: 'job_board', requires_company_slug: false, description: 'Google job search aggregator' },
  { name: 'Dice', id: 'dice', type: 'job_board', requires_company_slug: false, description: 'Technology-focused job board' },
  { name: 'SimplyHired', id: 'simplyhired', type: 'job_board', requires_company_slug: false, description: 'General job search engine' },
  { name: 'Monster', id: 'monster', type: 'job_board', requires_company_slug: false, description: 'One of the original job boards' },
  { name: 'CareerBuilder', id: 'careerbuilder', type: 'job_board', requires_company_slug: false, description: 'Large general job board' },
  { name: 'StepStone', id: 'stepstone', type: 'job_board', requires_company_slug: false, description: 'European job board' },
  { name: 'Wellfound', id: 'wellfound', type: 'job_board', requires_company_slug: false, description: 'Startup and tech company jobs (formerly AngelList Talent)' },
  { name: 'Bayt', id: 'bayt', type: 'job_board', requires_company_slug: false, description: 'Middle East and North Africa job board' },
  { name: 'Naukri', id: 'naukri', type: 'job_board', requires_company_slug: false, description: 'India\'s largest job board' },
  { name: 'BDJobs', id: 'bdjobs', type: 'job_board', requires_company_slug: false, description: 'Bangladesh job board' },
  { name: 'Internshala', id: 'internshala', type: 'job_board', requires_company_slug: false, description: 'Internships and entry-level jobs (India)' },
  { name: 'Upwork', id: 'upwork', type: 'job_board', requires_company_slug: false, description: 'Freelancing and contract work platform' },
  { name: 'USAJobs', id: 'usajobs', type: 'job_board', requires_company_slug: false, description: 'US federal government jobs' },
  { name: 'Exa', id: 'exa', type: 'job_board', requires_company_slug: false, description: 'AI-powered semantic job search' },

  // Remote Job Boards
  { name: 'RemoteOK', id: 'remoteok', type: 'remote', requires_company_slug: false, description: 'Remote-first job board' },
  { name: 'Remotive', id: 'remotive', type: 'remote', requires_company_slug: false, description: 'Remote jobs in tech' },
  { name: 'We Work Remotely', id: 'weworkremotely', type: 'remote', requires_company_slug: false, description: 'Largest remote work community' },
  { name: 'Jobicy', id: 'jobicy', type: 'remote', requires_company_slug: false, description: 'Remote jobs worldwide' },
  { name: 'Himalayas', id: 'himalayas', type: 'remote', requires_company_slug: false, description: 'Remote jobs with company profiles' },
  { name: 'Arbeitnow', id: 'arbeitnow', type: 'remote', requires_company_slug: false, description: 'Remote and visa-sponsored jobs' },

  // Aggregator APIs
  { name: 'Adzuna', id: 'adzuna', type: 'aggregator', requires_company_slug: false, description: 'Job search aggregator across multiple countries' },
  { name: 'Reed', id: 'reed', type: 'aggregator', requires_company_slug: false, description: 'UK job search aggregator' },
  { name: 'Jooble', id: 'jooble', type: 'aggregator', requires_company_slug: false, description: 'International job aggregator' },
  { name: 'CareerJet', id: 'careerjet', type: 'aggregator', requires_company_slug: false, description: 'Global job search engine' },

  // ATS Platforms
  { name: 'Ashby', id: 'ashby', type: 'ats', requires_company_slug: true, description: 'Modern ATS used by growing startups' },
  { name: 'Greenhouse', id: 'greenhouse', type: 'ats', requires_company_slug: true, description: 'Popular ATS for mid-to-large companies' },
  { name: 'Lever', id: 'lever', type: 'ats', requires_company_slug: true, description: 'Collaborative ATS platform' },
  { name: 'Workable', id: 'workable', type: 'ats', requires_company_slug: true, description: 'All-in-one hiring platform' },
  { name: 'SmartRecruiters', id: 'smartrecruiters', type: 'ats', requires_company_slug: true, description: 'Enterprise talent acquisition suite' },
  { name: 'Rippling', id: 'rippling', type: 'ats', requires_company_slug: true, description: 'HR platform with ATS' },
  { name: 'Workday', id: 'workday', type: 'ats', requires_company_slug: true, description: 'Enterprise HR and ATS' },
  { name: 'BambooHR', id: 'bamboohr', type: 'ats', requires_company_slug: true, description: 'SMB-focused HR with job board' },
  { name: 'Personio', id: 'personio', type: 'ats', requires_company_slug: true, description: 'European HR platform' },
  { name: 'JazzHR', id: 'jazzhr', type: 'ats', requires_company_slug: true, description: 'SMB recruiting software' },
  { name: 'Recruitee', id: 'recruitee', type: 'ats', requires_company_slug: true, description: 'Collaborative hiring for growing companies' },
  { name: 'Teamtailor', id: 'teamtailor', type: 'ats', requires_company_slug: true, description: 'Employer branding and ATS' },
  { name: 'iCIMS', id: 'icims', type: 'ats', requires_company_slug: true, description: 'Enterprise talent cloud' },
  { name: 'Taleo', id: 'taleo', type: 'ats', requires_company_slug: true, description: 'Oracle enterprise ATS' },
  { name: 'SuccessFactors', id: 'successfactors', type: 'ats', requires_company_slug: true, description: 'SAP enterprise HR' },
  { name: 'Jobvite', id: 'jobvite', type: 'ats', requires_company_slug: true, description: 'End-to-end recruiting platform' },
  { name: 'ADP', id: 'adp', type: 'ats', requires_company_slug: true, description: 'ADP workforce solutions' },
  { name: 'UKG', id: 'ukg', type: 'ats', requires_company_slug: true, description: 'UKG HR service delivery' },
  { name: 'Breezy HR', id: 'breezyhr', type: 'ats', requires_company_slug: true, description: 'Visual hiring pipeline ATS' },
  { name: 'Comeet', id: 'comeet', type: 'ats', requires_company_slug: true, description: 'Collaborative hiring platform' },
  { name: 'Pinpoint', id: 'pinpoint', type: 'ats', requires_company_slug: true, description: 'Smart recruiting software' },

  // Company Career Pages
  { name: 'Amazon', id: 'amazon', type: 'company', requires_company_slug: false, description: 'Amazon.jobs career page' },
  { name: 'Apple', id: 'apple', type: 'company', requires_company_slug: false, description: 'Apple Jobs career page' },
  { name: 'Microsoft', id: 'microsoft', type: 'company', requires_company_slug: false, description: 'Microsoft Careers' },
  { name: 'NVIDIA', id: 'nvidia', type: 'company', requires_company_slug: false, description: 'NVIDIA Careers' },
  { name: 'TikTok', id: 'tiktok', type: 'company', requires_company_slug: false, description: 'TikTok/ByteDance careers' },
  { name: 'Uber', id: 'uber', type: 'company', requires_company_slug: false, description: 'Uber Careers' },
  { name: 'Cursor', id: 'cursor', type: 'company', requires_company_slug: false, description: 'Cursor AI careers' },
  { name: 'Google Careers', id: 'google_careers', type: 'company', requires_company_slug: false, description: 'Google career page' },
  { name: 'Meta', id: 'meta', type: 'company', requires_company_slug: false, description: 'Meta Careers' },
  { name: 'Netflix', id: 'netflix', type: 'company', requires_company_slug: false, description: 'Netflix jobs' },
  { name: 'Stripe', id: 'stripe', type: 'company', requires_company_slug: false, description: 'Stripe careers' },
  { name: 'OpenAI', id: 'openai', type: 'company', requires_company_slug: false, description: 'OpenAI careers' },

  // Phase 7: Additional Job Boards
  { name: 'BuiltIn', id: 'builtin', type: 'job_board', requires_company_slug: false, description: 'Tech-focused job board for startups and tech companies' },
  { name: 'Snagajob', id: 'snagajob', type: 'job_board', requires_company_slug: false, description: 'Hourly and part-time job board' },
  { name: 'Dribbble Jobs', id: 'dribbble', type: 'job_board', requires_company_slug: false, description: 'Design-focused job board' },

  // Phase 8: ATS Expansion
  { name: 'Manatal', id: 'manatal', type: 'ats', requires_company_slug: true, description: 'ATS for 160K+ orgs (Asia-Pacific, global SMB)' },
  { name: 'Paylocity', id: 'paylocity', type: 'ats', requires_company_slug: true, description: 'US mid-market ATS (30K+ companies)' },
  { name: 'Freshteam', id: 'freshteam', type: 'ats', requires_company_slug: true, description: 'Freshworks HR platform with ATS' },
  { name: 'Bullhorn', id: 'bullhorn', type: 'ats', requires_company_slug: true, description: '#1 ATS for staffing agencies (10K+)' },
  { name: 'Trakstar Hire', id: 'trakstar', type: 'ats', requires_company_slug: true, description: 'Formerly RecruiterBox ATS' },
  { name: 'HiringThing', id: 'hiringthing', type: 'ats', requires_company_slug: true, description: 'White-label ATS platform' },
  { name: 'Loxo', id: 'loxo', type: 'ats', requires_company_slug: true, description: 'AI-powered recruiting platform' },
  { name: 'Fountain', id: 'fountain', type: 'ats', requires_company_slug: true, description: 'High-volume hourly hiring ATS' },
  { name: 'Deel', id: 'deel', type: 'ats', requires_company_slug: true, description: 'Global hiring/EOR platform with ATS' },
  { name: 'Phenom', id: 'phenom', type: 'ats', requires_company_slug: true, description: 'Enterprise talent experience platform (900+ enterprises)' },

  // Phase 8: Company Scrapers
  { name: 'IBM', id: 'ibm', type: 'company', requires_company_slug: false, description: 'IBM Careers' },
  { name: 'Boeing', id: 'boeing', type: 'company', requires_company_slug: false, description: 'Boeing careers (Phenom-powered)' },
  { name: 'Zoom', id: 'zoom', type: 'company', requires_company_slug: false, description: 'Zoom Video careers (Eightfold)' },

  // Phase 9: Job Board Expansion
  { name: 'The Muse', id: 'themuse', type: 'job_board', requires_company_slug: false, description: 'Career advice and curated job listings' },
  { name: 'Working Nomads', id: 'workingnomads', type: 'remote', requires_company_slug: false, description: 'Curated remote jobs worldwide' },
  { name: '4 Day Week', id: 'fourdayweek', type: 'remote', requires_company_slug: false, description: '4-day work week job listings' },
  { name: 'Startup.jobs', id: 'startupjobs', type: 'job_board', requires_company_slug: false, description: 'Startup jobs worldwide' },
  { name: 'NoDesk', id: 'nodesk', type: 'remote', requires_company_slug: false, description: 'Remote and flexible jobs' },
  { name: 'Web3 Career', id: 'web3career', type: 'job_board', requires_company_slug: false, description: 'Web3/crypto/blockchain jobs' },
  { name: 'Echojobs', id: 'echojobs', type: 'job_board', requires_company_slug: false, description: 'Curated tech jobs from top companies' },
  { name: 'Jobstreet', id: 'jobstreet', type: 'job_board', requires_company_slug: false, description: 'Major Southeast Asian job board (SEEK)' },

  // Phase 10: Government Boards & ATS Expansion
  { name: 'CareerOneStop', id: 'careeronestop', type: 'job_board', requires_company_slug: false, description: 'US Dept of Labor job search (NLx)' },
  { name: 'Arbeitsagentur', id: 'arbeitsagentur', type: 'job_board', requires_company_slug: false, description: 'German Federal Employment Agency' },
  { name: 'Jobylon', id: 'jobylon', type: 'ats', requires_company_slug: true, description: 'Scandinavian ATS (Nordic companies)' },
  { name: 'Homerun', id: 'homerun', type: 'ats', requires_company_slug: true, description: 'European SMB ATS' },
  // Phase 11: Niche boards & developer API expansion
  { name: 'Hacker News', id: 'hackernews', type: 'job_board', requires_company_slug: false, description: 'YC startup job postings via HN' },
  { name: 'Landing.jobs', id: 'landingjobs', type: 'job_board', requires_company_slug: false, description: 'European tech jobs with salary data' },
  { name: 'FindWork', id: 'findwork', type: 'aggregator', requires_company_slug: false, description: 'Developer/tech jobs aggregator' },
  { name: 'JobDataAPI', id: 'jobdataapi', type: 'aggregator', requires_company_slug: false, description: 'Global jobs aggregator API' },
  // Phase 12: ATS & niche board expansion
  { name: 'Authentic Jobs', id: 'authenticjobs', type: 'job_board', requires_company_slug: false, description: 'Creative/dev job board' },
  { name: 'JobScore', id: 'jobscore', type: 'ats', requires_company_slug: true, description: 'JobScore ATS (public JSON feed)' },
  { name: 'TalentLyft', id: 'talentlyft', type: 'ats', requires_company_slug: true, description: 'TalentLyft ATS (European)' },
  // Phase 13: RSS niche board expansion
  { name: 'CryptoJobsList', id: 'cryptojobslist', type: 'job_board', requires_company_slug: false, description: 'Crypto, blockchain & Web3 jobs' },
  { name: 'Jobspresso', id: 'jobspresso', type: 'remote', requires_company_slug: false, description: 'Curated remote jobs' },
  { name: 'HigherEdJobs', id: 'higheredjobs', type: 'job_board', requires_company_slug: false, description: 'Higher education jobs' },
  { name: 'FOSS Jobs', id: 'fossjobs', type: 'job_board', requires_company_slug: false, description: 'Free & open source software jobs' },
  { name: 'LaraJobs', id: 'larajobs', type: 'job_board', requires_company_slug: false, description: 'Laravel/PHP jobs' },
  { name: 'Python.org Jobs', id: 'pythonjobs', type: 'job_board', requires_company_slug: false, description: 'Official Python job board' },
  { name: 'Drupal Jobs', id: 'drupaljobs', type: 'job_board', requires_company_slug: false, description: 'Drupal community jobs' },
  { name: 'Real Work From Anywhere', id: 'realworkfromanywhere', type: 'remote', requires_company_slug: false, description: 'Remote jobs with category feeds' },
  { name: 'Golang Projects', id: 'golangjobs', type: 'job_board', requires_company_slug: false, description: 'Go/Golang jobs' },
  { name: 'WordPress Jobs', id: 'wordpressjobs', type: 'job_board', requires_company_slug: false, description: 'Official WordPress job board' },
  // Phase 14: API-key sources & ATS expansion
  { name: 'Talroo', id: 'talroo', type: 'aggregator', requires_company_slug: false, description: 'Major job aggregator (millions of jobs)' },
  { name: 'InfoJobs', id: 'infojobs', type: 'job_board', requires_company_slug: false, description: 'Largest job site in Spain/Southern Europe' },
  { name: 'Crelate', id: 'crelate', type: 'ats', requires_company_slug: true, description: 'Crelate ATS (recruiting firms)' },
  { name: 'iSmartRecruit', id: 'ismartrecruit', type: 'ats', requires_company_slug: true, description: 'iSmartRecruit ATS' },
  { name: 'Recruiterflow', id: 'recruiterflow', type: 'ats', requires_company_slug: true, description: 'Recruiterflow ATS' },
  // Phase 15: European government & regional boards
  { name: 'JobTech Dev', id: 'jobtechdev', type: 'job_board', requires_company_slug: false, description: 'Swedish Employment Service (50-80K jobs)' },
  { name: 'France Travail', id: 'francetravail', type: 'job_board', requires_company_slug: false, description: 'French National Employment Service (800K+ jobs)' },
  { name: 'NAV Arbeidsplassen', id: 'navjobs', type: 'job_board', requires_company_slug: false, description: 'Norwegian Labour and Welfare Administration' },
  { name: 'jobs.ac.uk', id: 'jobsacuk', type: 'job_board', requires_company_slug: false, description: 'UK academic/higher education jobs' },
  { name: 'Jobindex', id: 'jobindex', type: 'job_board', requires_company_slug: false, description: "Denmark's largest job board" },
  // Phase 16: Global expansion (LatAm, gig, startup, Canada)
  { name: 'Get on Board', id: 'getonboard', type: 'job_board', requires_company_slug: false, description: 'Latin American tech job board (6K+ jobs)' },
  { name: 'Freelancer.com', id: 'freelancercom', type: 'job_board', requires_company_slug: false, description: 'Freelance/gig marketplace (8K+ projects)' },
  { name: 'JoinRise', id: 'joinrise', type: 'job_board', requires_company_slug: false, description: 'Tech startup job aggregator (10K+ jobs)' },
  { name: 'Canada Job Bank', id: 'canadajobbank', type: 'job_board', requires_company_slug: false, description: 'Canadian government job bank (51K+ jobs)' },
  // Phase 17: Niche & international expansion (NGO, UN, IT)
  { name: 'ReliefWeb', id: 'reliefweb', type: 'job_board', requires_company_slug: false, description: 'NGO/humanitarian jobs across 195+ countries' },
  { name: 'UNDP Jobs', id: 'undpjobs', type: 'job_board', requires_company_slug: false, description: 'United Nations Development Programme jobs' },
  { name: 'DevITjobs', id: 'devitjobs', type: 'job_board', requires_company_slug: false, description: 'IT/developer jobs with salary transparency' },
  // Phase 18: Niche RSS expansion (tech, design, environment, regional)
  { name: 'PyJobs', id: 'pyjobs', type: 'job_board', requires_company_slug: false, description: 'Python developer job board' },
  { name: 'VueJobs', id: 'vuejobs', type: 'job_board', requires_company_slug: false, description: 'Vue.js/frontend developer jobs' },
  { name: 'Conservation Job Board', id: 'conservationjobs', type: 'job_board', requires_company_slug: false, description: 'Conservation/environmental sector jobs' },
  { name: 'Coroflot', id: 'coroflot', type: 'job_board', requires_company_slug: false, description: 'Design/creative industry job board' },
  { name: 'Berlin Startup Jobs', id: 'berlinstartupjobs', type: 'job_board', requires_company_slug: false, description: 'Berlin tech startup jobs' },
  // Phase 19: Tech niche, crypto, regional expansion
  { name: 'Rails Job Board', id: 'railsjobs', type: 'job_board', requires_company_slug: false, description: 'Ruby on Rails developer jobs' },
  { name: 'Elixir Jobs', id: 'elixirjobs', type: 'job_board', requires_company_slug: false, description: 'Elixir/Phoenix developer jobs' },
  { name: 'Crunchboard', id: 'crunchboard', type: 'job_board', requires_company_slug: false, description: 'TechCrunch job board' },
  { name: 'Cryptocurrency Jobs', id: 'cryptocurrencyjobs', type: 'job_board', requires_company_slug: false, description: 'Blockchain/Web3/crypto jobs' },
  { name: 'HasJob', id: 'hasjob', type: 'job_board', requires_company_slug: false, description: 'India/South Asia tech job board' },
  // Phase 20: European regional & niche expansion
  { name: 'iCrunchData', id: 'icrunchdata', type: 'job_board', requires_company_slug: false, description: 'Data science & analytics jobs' },
  { name: 'SwissDevJobs', id: 'swissdevjobs', type: 'job_board', requires_company_slug: false, description: 'Swiss IT jobs with salary transparency' },
  { name: 'GermanTechJobs', id: 'germantechjobs', type: 'job_board', requires_company_slug: false, description: 'German IT jobs with salary transparency' },
  { name: 'VirtualVocations', id: 'virtualvocations', type: 'remote', requires_company_slug: false, description: 'Screened remote/work-from-home jobs' },
  { name: 'NoFluffJobs', id: 'nofluffjobs', type: 'job_board', requires_company_slug: false, description: 'Polish/CEE tech jobs with salary transparency' },
  // Phase 21: Niche & academic expansion
  { name: 'Green Jobs Board', id: 'greenjobsboard', type: 'job_board', requires_company_slug: false, description: 'Environmental & sustainability jobs' },
  { name: 'EuroJobs', id: 'eurojobs', type: 'job_board', requires_company_slug: false, description: 'European multi-country job board' },
  { name: 'Open Source Design Jobs', id: 'opensourcedesignjobs', type: 'job_board', requires_company_slug: false, description: 'Design jobs for open source projects' },
  { name: 'Academic Careers', id: 'academiccareers', type: 'job_board', requires_company_slug: false, description: 'Higher education & academic positions' },
  { name: 'RemoteFirstJobs', id: 'remotefirstjobs', type: 'remote', requires_company_slug: false, description: 'Remote-first job listings' },
  // Phase 22: Eastern European, CIS & Singapore expansion
  { name: 'Djinni', id: 'djinni', type: 'job_board', requires_company_slug: false, description: 'Ukrainian tech job board' },
  { name: 'HeadHunter', id: 'headhunter', type: 'job_board', requires_company_slug: false, description: 'Russian/CIS job board (140K+ vacancies)' },
  { name: 'Habr Career', id: 'habrcareer', type: 'job_board', requires_company_slug: false, description: 'Russian tech job board (Habr community)' },
  { name: 'MyCareersFuture', id: 'mycareersfuture', type: 'job_board', requires_company_slug: false, description: 'Singapore government job portal (77K+ jobs)' },
  // Phase 23: Japan, Nordic & Swiss expansion
  { name: 'Jobs in Japan', id: 'jobsinjapan', type: 'job_board', requires_company_slug: false, description: 'English-language Japan tech jobs' },
  { name: 'Duunitori', id: 'duunitori', type: 'job_board', requires_company_slug: false, description: 'Finnish job board' },
  { name: 'Jobs.ch', id: 'jobsch', type: 'job_board', requires_company_slug: false, description: 'Swiss job board' },
  // Phase 24: UK & mobile dev expansion
  { name: 'Guardian Jobs', id: 'guardianjobs', type: 'job_board', requires_company_slug: false, description: 'UK job board (The Guardian newspaper)' },
  { name: 'AndroidJobs', id: 'androidjobs', type: 'job_board', requires_company_slug: false, description: 'Android developer job board' },
  { name: 'iOS Dev Jobs', id: 'iosdevjobs', type: 'job_board', requires_company_slug: false, description: 'iOS/Swift developer job board' },
  // Phase 25: DevOps, FP, diversity & niche expansion
  { name: 'DevOpsJobs', id: 'devopsjobs', type: 'job_board', requires_company_slug: false, description: 'DevOps & infrastructure job board (875+ jobs)' },
  { name: 'Functional Works', id: 'functionalworks', type: 'job_board', requires_company_slug: false, description: 'Functional programming job board (Haskell, Scala, Clojure, Erlang)' },
  { name: 'PowerToFly', id: 'powertofly', type: 'job_board', requires_company_slug: false, description: 'Diversity-focused remote job board' },
  { name: 'Clojure Jobs', id: 'clojurejobs', type: 'job_board', requires_company_slug: false, description: 'Clojure programming language job board' },
  // Phase 26: Sustainability & niche expansion
  { name: 'EcoJobs', id: 'ecojobs', type: 'job_board', requires_company_slug: false, description: 'Environmental and conservation job board' },
];

// ── Recent search results (get_job_details) ───────────────────────────
//
// The API has no route that returns one job (it serves `POST /api/jobs/search`
// and `POST /api/jobs/analyze` only), so `getJobDetails` answers from the raw
// API jobs that this process's `searchJobs` calls received (T-2586). The memory
// is per process: in HTTP mode (`MCP_TRANSPORT=http`) each replica keeps its
// own, so details work for jobs found by the same server process.

/** How many jobs `searchJobs` remembers for `getJobDetails`; the oldest are dropped first. */
export const MCP_RECENT_JOBS_LIMIT = 1000;

const JOB_NOT_FOUND = 'job not found in recent search results; call search_jobs first';

interface RecentJob {
  /** The job object exactly as `POST /api/jobs/search` returned it. */
  job: Record<string, unknown>;
  /** The lookup keys (`id:<id>`, `url:<jobUrl>`) that point at this job. */
  keys: string[];
}

/** Remembered jobs, oldest first (a Set keeps insertion order). */
const recentJobs = new Set<RecentJob>();
/** Lookup by `id:<id>` and `url:<jobUrl>`: at most two keys per remembered job. */
const recentJobsByKey = new Map<string, RecentJob>();

function lookupKey(kind: 'id' | 'url', value: unknown): string | null {
  const text = nonEmpty(value);
  return text ? `${kind}:${text}` : null;
}

/** The lookup keys of a raw API job: `id:<id>` and `url:<jobUrl>`, when present. */
function jobKeys(raw: Record<string, unknown>): string[] {
  return [lookupKey('id', raw.id), lookupKey('url', raw.jobUrl ?? raw.job_url)].filter(
    (key): key is string => key !== null,
  );
}

/**
 * Remember one raw API job under its id and its job URL. A job found again
 * becomes the newest. A key that pointed at another job now points at this one;
 * the other job stays reachable by its remaining key, and is dropped when it
 * has none left. Past {@link MCP_RECENT_JOBS_LIMIT} jobs the oldest is dropped.
 */
function rememberJob(job: unknown): void {
  if (!job || typeof job !== 'object') return;
  const raw = job as Record<string, unknown>;
  const keys = jobKeys(raw);
  if (keys.length === 0) return;

  for (const key of keys) {
    const previous = recentJobsByKey.get(key);
    if (!previous) continue;
    previous.keys = previous.keys.filter((k) => k !== key);
    if (previous.keys.length === 0) recentJobs.delete(previous);
  }

  const entry: RecentJob = { job: raw, keys };
  recentJobs.add(entry);
  for (const key of keys) recentJobsByKey.set(key, entry);

  while (recentJobs.size > MCP_RECENT_JOBS_LIMIT) {
    const oldest = recentJobs.values().next().value;
    if (!oldest) break;
    recentJobs.delete(oldest);
    for (const key of oldest.keys) recentJobsByKey.delete(key);
  }
}

/** How many jobs `getJobDetails` can currently answer for (never above {@link MCP_RECENT_JOBS_LIMIT}). */
export function recentJobCount(): number {
  return recentJobs.size;
}

// ── Tool Implementations ───────────────────────────────────────────────

/**
 * Search for jobs via the Ever Jobs API. Every job it returns, and the first
 * other jobs received up to {@link MCP_RECENT_JOBS_LIMIT} in all, are
 * remembered for {@link getJobDetails}.
 */
export async function searchJobs(params: JobSearchParams): Promise<SearchResponse> {
  return (await runJobSearch(params)).response;
}

/**
 * What {@link runJobSearch} gives: the tool response, and the raw API job of
 * every mapped job, so a tool can read fields the response leaves out (the
 * structured `compensation` for {@link getSalaryInsights}, T-2674).
 */
interface JobSearchOutcome {
  response: SearchResponse;
  rawJobs: Map<JobResult, Record<string, unknown>>;
}

async function runJobSearch(params: JobSearchParams): Promise<JobSearchOutcome> {
  const client = getClient();

  try {
    const response = await client.post('/api/jobs/search', buildSearchRequestBody(params));

    const data = response.data;
    const locationFormat = readLocationFormat();
    const jobs: JobResult[] = (data.jobs ?? []).map((job: any) => ({
      id: job.id ?? '',
      title: job.title ?? '',
      company: job.companyName ?? job.company_name ?? '',
      location: formatJobLocation(job.location, locationFormat),
      url: job.jobUrl ?? job.job_url ?? '',
      description: truncateDescription(job.description),
      date_posted: job.datePosted ?? job.date_posted ?? null,
      ...postedTimeDetail(job),
      is_remote: job.isRemote ?? job.is_remote ?? false,
      source: job.site ?? '',
      salary: formatSalary(job.compensation),
      department: job.department ?? null,
    }));

    // Filter remote-only if requested
    const filteredJobs = params.remoteOnly
      ? jobs.filter((j) => j.is_remote)
      : jobs;

    // The API applies resultsWanted per source (and per location), so its
    // answer can be far longer than `limit`: cut it here, after the
    // remote_only filter, keeping jobs from every source (T-2585).
    const returnedJobs = takeJobsAcrossSources(filteredJobs, normalizeSearchLimit(params.limit));

    // A search across the whole catalogue can return more jobs than the memory
    // holds, and the cut takes each source's jobs in turn, so it can return jobs
    // listed past the first MCP_RECENT_JOBS_LIMIT. Remember, in the API's order,
    // every returned job and as many of the others as there is room for, first
    // ones first: at most MCP_RECENT_JOBS_LIMIT jobs, so this response cannot
    // push its own returned jobs out.
    const returned = new Set(returnedJobs);
    let room = MCP_RECENT_JOBS_LIMIT - returnedJobs.length;
    jobs.forEach((job, index) => {
      if (returned.has(job)) {
        rememberJob(data.jobs[index]);
      } else if (room > 0) {
        room--;
        rememberJob(data.jobs[index]);
      }
    });

    return {
      response: {
        total: returnedJobs.length,
        ...(filteredJobs.length > returnedJobs.length ? { total_found: filteredJobs.length } : {}),
        jobs: returnedJobs,
        sources_searched: requestedSites(params) ?? ['all'],
        query: params.query,
        ...(hasExclusions(params)
          ? { excluded: Number(data.exclusion_metrics?.excluded_count ?? 0) || 0 }
          : {}),
      },
      rawJobs: new Map(jobs.map((job, index) => [job, data.jobs[index]])),
    };
  } catch (err: any) {
    // An unreachable API must not look like "no jobs found": fail loudly.
    throw new Error(`Search failed: ${describeRequestError(err)}`);
  }
}

/**
 * Get detailed information about a job that a recent search returned, by its
 * id (looked up first) or its job URL; given both, the job that has both wins.
 * Answers from the jobs {@link searchJobs} remembered and makes no API request;
 * an unknown job is an error asking the caller to search first.
 */
export async function getJobDetails(params: {
  jobUrl?: string;
  jobId?: string;
}): Promise<JobDetailsResponse> {
  const idKey = lookupKey('id', params.jobId);
  const urlKey = lookupKey('url', params.jobUrl);
  if (!idKey && !urlKey) {
    throw new Error('Either job_url or job_id must be provided');
  }

  const byId = idKey ? recentJobsByKey.get(idKey) : undefined;
  const byUrl = urlKey ? recentJobsByKey.get(urlKey) : undefined;
  // Given both, answer with the job that has both. Some sources reuse an id
  // across searches (Working Nomads numbers its jobs per search), so the id
  // alone can point at a newer, different job while the URL still names the
  // one the caller means.
  const hasBoth = (entry: RecentJob | undefined): boolean =>
    !!entry && !!idKey && !!urlKey && jobKeys(entry.job).includes(idKey) && jobKeys(entry.job).includes(urlKey);
  const found = (hasBoth(byUrl) && !hasBoth(byId) ? byUrl : byId) ?? byUrl;
  if (!found) {
    throw new Error(JOB_NOT_FOUND);
  }

  const job = found.job as any;
  return {
    id: job.id ?? '',
    title: job.title ?? '',
    company: job.companyName ?? job.company_name ?? '',
    location: formatJobLocation(job.location, readLocationFormat()),
    url: job.jobUrl ?? job.job_url ?? '',
    description: truncateDescription(job.description),
    full_description: job.description ?? null,
    date_posted: job.datePosted ?? job.date_posted ?? null,
    ...postedTimeDetail(job),
    is_remote: job.isRemote ?? job.is_remote ?? false,
    source: job.site ?? '',
    salary: formatSalary(job.compensation),
    department: job.department ?? null,
    application_url:
      job.applyUrl ?? job.apply_url ?? job.applicationUrl ?? job.application_url ?? job.jobUrl ?? null,
  };
}

/**
 * List available job sources, optionally filtered by type.
 */
export function listSources(
  type: string = 'all',
): { total: number; sources: SourceInfo[] } {
  const filtered =
    type === 'all'
      ? SOURCES
      : SOURCES.filter((s) => s.type === type);

  return {
    total: filtered.length,
    sources: filtered,
  };
}

/**
 * Convenience: search remote jobs across all remote-first boards. A `source`
 * that is a remote board narrows the search to it; without one (or with a
 * source that is not a remote board) every remote board is sent as `siteType`,
 * so the API never falls back to its whole-catalogue fan-out.
 */
export async function searchRemoteJobs(params: {
  query: string;
  source?: string;
  limit?: number;
}): Promise<SearchResponse> {
  const remoteSources = SOURCES.filter((s) => s.type === 'remote').map((s) => s.id);
  const targetSource = params.source && remoteSources.includes(params.source)
    ? params.source
    : undefined;

  return searchJobs({
    query: params.query,
    location: 'Remote',
    source: targetSource,
    ...(targetSource ? {} : { sources: remoteSources }),
    limit: params.limit ?? 25,
    remoteOnly: true,
  });
}

/**
 * Get salary insights: aggregate salary data from search results.
 *
 * The stats are built from the API's structured `compensation` of each
 * returned job, never from the salary strings (T-2674): every amount is made
 * yearly by its pay period ({@link yearlyPay}), and only the jobs paid in the
 * most common currency count, so the stats never mix currencies or periods.
 * A job whose pay period is unknown is left out of the stats but still counts
 * in `jobsWithSalary` and can appear in `sampleJobs`.
 */
export async function getSalaryInsights(params: {
  query: string;
  location?: string;
  limit?: number;
}): Promise<SalaryInsightsResponse> {
  const { response: searchResult, rawJobs } = await runJobSearch({
    query: params.query,
    location: params.location,
    limit: params.limit ?? 50,
  });

  const jobsWithSalary = searchResult.jobs.filter((j) => j.salary);
  const pay = jobsWithSalary
    .map((j) => yearlyPay(rawJobs.get(j)?.compensation))
    .filter((p): p is YearlyPay => p !== null);
  const currency = mostCommonCurrency(pay);
  const salaryValues = pay
    .filter((p) => p.currency === currency)
    .flatMap((p) => p.amounts);

  salaryValues.sort((a, b) => a - b);

  const median = salaryValues.length > 0
    ? salaryValues[Math.floor(salaryValues.length / 2)]
    : null;

  return {
    query: params.query,
    location: params.location ?? 'Any',
    totalJobsSearched: searchResult.total,
    jobsWithSalary: jobsWithSalary.length,
    salaryPercentage: searchResult.total > 0
      ? Math.round((jobsWithSalary.length / searchResult.total) * 100)
      : 0,
    stats: currency !== null && salaryValues.length > 0
      ? {
          currency,
          min: Math.min(...salaryValues),
          max: Math.max(...salaryValues),
          median: median!,
          p25: salaryValues[Math.floor(salaryValues.length * 0.25)] ?? median!,
          p75: salaryValues[Math.floor(salaryValues.length * 0.75)] ?? median!,
        }
      : null,
    sampleJobs: jobsWithSalary.slice(0, 10).map((j) => ({
      title: j.title,
      company: j.company,
      salary: j.salary!,
      source: j.source,
      location: j.location,
    })),
  };
}

export interface SalaryInsightsResponse {
  query: string;
  location: string;
  totalJobsSearched: number;
  jobsWithSalary: number;
  salaryPercentage: number;
  /**
   * Yearly amounts (T-2674), over the jobs paid in `currency` (the most common
   * currency among the jobs whose pay period is known); null when there are none.
   */
  stats: {
    currency: string;
    min: number;
    max: number;
    median: number;
    p25: number;
    p75: number;
  } | null;
  sampleJobs: {
    title: string;
    company: string;
    salary: string;
    source: string;
    location: string | null;
  }[];
}

/**
 * Compare job sources by result quality metrics.
 */
export function compareSources(): {
  total: number;
  byType: Record<string, number>;
  types: {
    type: string;
    count: number;
    sources: string[];
    requiresSlug: boolean;
  }[];
} {
  const byType: Record<string, SourceInfo[]> = {};
  for (const source of SOURCES) {
    if (!byType[source.type]) byType[source.type] = [];
    byType[source.type].push(source);
  }

  const typeCounts: Record<string, number> = {};
  const types = Object.entries(byType).map(([type, sources]) => {
    typeCounts[type] = sources.length;
    return {
      type,
      count: sources.length,
      sources: sources.map((s) => s.name),
      requiresSlug: sources.some((s) => s.requires_company_slug),
    };
  });

  return {
    total: SOURCES.length,
    byType: typeCounts,
    types,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * A search tool's `limit` as a whole number of jobs, 1 to
 * {@link MCP_MAX_SEARCH_LIMIT} (T-2585). A number, or a numeric string (some
 * clients stringify arguments), is rounded down and capped at 100; anything
 * else, and anything below 1, gives {@link MCP_DEFAULT_SEARCH_LIMIT}.
 *
 * It is both the `resultsWanted` sent to the API and the most jobs
 * {@link searchJobs} returns: the API applies `resultsWanted` per source (and
 * per location when `locations` is set), so its answer can be far longer.
 */
export function normalizeSearchLimit(limit: unknown): number {
  const n =
    typeof limit === 'number'
      ? limit
      : typeof limit === 'string' && limit.trim() !== ''
        ? Number(limit)
        : NaN;
  if (!(n >= 1)) return MCP_DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.floor(n), MCP_MAX_SEARCH_LIMIT);
}

/**
 * At most `limit` of `jobs`, shared across their sources (T-2585). The API
 * sorts its answer by site name, then newest first, so the first `limit` jobs
 * of a search over several sources would all come from the first site in
 * alphabetical order. This takes each source's jobs in turn (its first job,
 * then every source's second job, and so on) until `limit` are picked, and
 * returns them in the order they had in `jobs`. A list within the limit is
 * returned as it is.
 */
export function takeJobsAcrossSources<T extends { source: string }>(jobs: T[], limit: number): T[] {
  if (jobs.length <= limit) return jobs;
  const bySource = new Map<string, number[]>();
  jobs.forEach((job, index) => {
    const indexes = bySource.get(job.source);
    if (indexes) indexes.push(index);
    else bySource.set(job.source, [index]);
  });
  const queues = [...bySource.values()];
  const picked: number[] = [];
  for (let round = 0; picked.length < limit; round++) {
    for (const queue of queues) {
      if (round < queue.length) picked.push(queue[round]);
      if (picked.length === limit) break;
    }
  }
  return picked.sort((a, b) => a - b).map((index) => jobs[index]);
}

/**
 * Build the `POST /api/jobs/search` body for {@link searchJobs}. See
 * {@link SearchRequestKeyStyle} for why camelCase is the default (Specs 1689,
 * 1690 §4.9).
 *
 * The source filter is `[source]` when `source` is set, else a non-empty
 * `sources` list (see {@link requestedSites}). An absent source filter or
 * company is omitted, not sent as an `undefined` key, so an unfiltered search
 * stays exactly `{ searchTerm, location, resultsWanted }`. The
 * per-request `crawl` object (Spec 1690) is added unchanged when given — its key
 * is spelled the same in every style, and its own keys are the camelCase ones
 * the API's `CrawlPolicyDto` declares. `locations` and the exclusion lists
 * (Spec 1700) are added, cleaned, only when non-empty, in the chosen style.
 */
export function buildSearchRequestBody(
  params: JobSearchParams,
  style: SearchRequestKeyStyle = readSearchRequestKeyStyle(),
): Record<string, unknown> {
  const siteType = requestedSites(params);
  const resultsWanted = normalizeSearchLimit(params.limit);
  const location = params.location ?? '';

  const camel: Record<string, unknown> = {
    searchTerm: params.query,
    location,
    ...(siteType ? { siteType } : {}),
    ...(params.company ? { companySlug: params.company } : {}),
    resultsWanted,
  };
  const snake: Record<string, unknown> = {
    search_term: params.query,
    location,
    ...(siteType ? { site_type: siteType } : {}),
    ...(params.company ? { company_slug: params.company } : {}),
    results_wanted: resultsWanted,
  };
  const crawl = params.crawl ? { crawl: params.crawl } : {};

  // Spec 1700 — added only when non-empty, so a plain search body stays
  // byte-identical. `locations` is one word, so both spellings agree.
  const locations = cleanList(params.locations, MCP_MAX_LOCATIONS, MCP_MAX_LOCATION_LENGTH);
  if (locations) {
    camel.locations = locations;
    snake.locations = locations;
  }
  const exclusions: [string, string, string[] | undefined][] = [
    ['excludeTitleTerms', 'exclude_title_terms', cleanList(params.excludeTitleTerms, MCP_MAX_EXCLUSION_TERMS, MCP_MAX_EXCLUSION_TERM_LENGTH)],
    ['excludeKeywords', 'exclude_keywords', cleanList(params.excludeKeywords, MCP_MAX_EXCLUSION_TERMS, MCP_MAX_EXCLUSION_TERM_LENGTH)],
    ['excludePresets', 'exclude_presets', knownPresets(params.excludePresets)],
  ];
  for (const [camelKey, snakeKey, list] of exclusions) {
    if (!list) continue;
    camel[camelKey] = list;
    snake[snakeKey] = list;
  }

  if (style === 'snake') return { ...snake, ...crawl };
  if (style === 'both') return { ...snake, ...camel, ...crawl };
  return { ...camel, ...crawl };
}

/**
 * The sources a search sends as `siteType` (and reports in `sources_searched`):
 * `[source]` when `source` is set, else a copy of `sources` when it is
 * non-empty, else `undefined` (no source filter; the API's default fan-out).
 */
function requestedSites(params: JobSearchParams): string[] | undefined {
  if (params.source) return [params.source];
  return params.sources && params.sources.length > 0 ? [...params.sources] : undefined;
}

/**
 * Normalise a list argument from a tool call (Spec 1700): a bare string
 * becomes a one-item list, non-strings and blanks are dropped, entries over
 * `maxLength` are dropped (truncating would change their meaning), and the
 * list is cut to `maxItems` so the API's validator never 400s the search.
 * Returns `undefined` for an empty result.
 */
export function cleanList(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const out = raw
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length <= maxLength)
    .slice(0, maxItems);
  return out.length > 0 ? out : undefined;
}

/**
 * The presets the API knows (`ExclusionPreset` in `@ever-jobs/models`; the MCP
 * server does not import the monorepo packages). An unknown preset would 400
 * the whole search, so it is dropped here instead.
 */
export const MCP_EXCLUSION_PRESETS: readonly string[] = ['security_clearance'];

function knownPresets(value: unknown): string[] | undefined {
  const list = cleanList(value, MCP_MAX_EXCLUSION_TERMS, MCP_MAX_EXCLUSION_TERM_LENGTH)
    ?.map((p) => p.toLowerCase())
    .filter((p) => MCP_EXCLUSION_PRESETS.includes(p));
  return list && list.length > 0 ? [...new Set(list)] : undefined;
}

/** Did the search send any exclusion filter? */
function hasExclusions(params: JobSearchParams): boolean {
  return (
    cleanList(params.excludeTitleTerms, MCP_MAX_EXCLUSION_TERMS, MCP_MAX_EXCLUSION_TERM_LENGTH) !== undefined ||
    cleanList(params.excludeKeywords, MCP_MAX_EXCLUSION_TERMS, MCP_MAX_EXCLUSION_TERM_LENGTH) !== undefined ||
    knownPresets(params.excludePresets) !== undefined
  );
}

/**
 * Render the API's structured location as the `string | null` the MCP tools
 * declare. The API returns a `LocationDto` object (`city`/`state`/`country`,
 * plus the source's `name` and raw `text`); older servers may return a plain
 * string, which is passed through.
 *
 * Remote-only postings carry no location object at all and render `null` —
 * `is_remote` carries that signal.
 */
export function formatJobLocation(
  location: unknown,
  format: LocationFormat = 'full',
): string | null {
  if (location == null) return null;
  if (typeof location === 'string') return nonEmpty(location);
  if (typeof location !== 'object') return null;

  const loc = location as Record<string, unknown>;
  const city = nonEmpty(loc.city);
  if (format === 'city' && city) return city;

  const geo = [city, nonEmpty(loc.state), nonEmpty(loc.country)].filter(
    (part): part is string => part !== null,
  );
  if (geo.length > 0) return geo.join(', ');

  return nonEmpty(loc.name) ?? nonEmpty(loc.text);
}

/**
 * The Spec 1696 posting-time detail of an API job, in the tools' snake_case:
 * only the keys the API sent as a non-blank string, so a job without the
 * detail maps exactly as before. Reads the camelCase (current API) and the
 * snake_case spelling, like the other job fields.
 */
export function postedTimeDetail(job: unknown): PostedTimeDetail {
  const j = (job && typeof job === 'object' ? job : {}) as Record<string, unknown>;
  const at = nonEmpty(j.datePostedAt ?? j.date_posted_at);
  const precision = nonEmpty(j.datePostedPrecision ?? j.date_posted_precision);
  const basis = nonEmpty(j.datePostedBasis ?? j.date_posted_basis);
  return {
    ...(at ? { date_posted_at: at } : {}),
    ...(precision ? { date_posted_precision: precision } : {}),
    ...(basis ? { date_posted_basis: basis } : {}),
  };
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateDescription(desc: string | null | undefined): string | null {
  if (!desc) return null;
  const maxLen = 500;
  if (desc.length <= maxLen) return desc;
  return desc.slice(0, maxLen) + '...';
}

/**
 * T-2674 — per pay period the API sends (`CompensationInterval` in
 * `@ever-jobs/models`), how a salary string names it and how many of it make
 * a year (hourly = 40 h x 52 weeks, daily = 5 days x 52 weeks), the factors
 * the API's `convertToAnnual` uses. Kept here because the MCP server imports
 * no `@ever-jobs` package.
 */
const PAY_PERIODS: ReadonlyMap<string, { label: string; perYear: number }> = new Map([
  ['hourly', { label: 'per hour', perYear: 2080 }],
  ['daily', { label: 'per day', perYear: 260 }],
  ['weekly', { label: 'per week', perYear: 52 }],
  ['monthly', { label: 'per month', perYear: 12 }],
  ['yearly', { label: 'per year', perYear: 1 }],
]);

function payPeriod(interval: unknown): { label: string; perYear: number } | undefined {
  return typeof interval === 'string' ? PAY_PERIODS.get(interval.trim().toLowerCase()) : undefined;
}

/** One job's pay for {@link getSalaryInsights}: its currency and its amounts made yearly. */
interface YearlyPay {
  currency: string;
  amounts: number[];
}

/**
 * The yearly pay of an API `compensation` object: `minAmount` and `maxAmount`
 * (each when a number above zero) times the pay period's factor. `null` when
 * the pay period is unknown or there is no amount. A missing currency is USD,
 * as {@link formatSalary} shows it.
 */
function yearlyPay(compensation: unknown): YearlyPay | null {
  if (!compensation || typeof compensation !== 'object') return null;
  const c = compensation as Record<string, unknown>;
  const period = payPeriod(c.interval);
  if (!period) return null;
  const amounts = [c.minAmount, c.maxAmount]
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
    .map((v) => Math.round(v * period.perYear));
  if (amounts.length === 0) return null;
  const currency = typeof c.currency === 'string' && c.currency.trim() ? c.currency.trim().toUpperCase() : 'USD';
  return { currency, amounts };
}

/** The currency most jobs are paid in; on a tie, the one met first. `null` for no jobs. */
function mostCommonCurrency(pay: YearlyPay[]): string | null {
  const counts = new Map<string, number>();
  for (const p of pay) counts.set(p.currency, (counts.get(p.currency) ?? 0) + 1);
  let best: string | null = null;
  for (const [currency, count] of counts) {
    if (best === null || count > counts.get(best)!) best = currency;
  }
  return best;
}

/**
 * A job's salary as the tools show it, e.g. `USD 45 - 60 per hour`. Amounts
 * are written the en-US way whatever the server locale is, and the pay period
 * is named when the API sent one (T-2674).
 */
function formatSalary(compensation: any): string | null {
  if (!compensation) return null;
  const { minAmount, maxAmount, currency } = compensation;
  if (!minAmount && !maxAmount) return null;
  const cur = currency ?? 'USD';
  const period = payPeriod(compensation.interval);
  const per = period ? ` ${period.label}` : '';
  if (minAmount && maxAmount) return `${cur} ${minAmount.toLocaleString('en-US')} - ${maxAmount.toLocaleString('en-US')}${per}`;
  if (minAmount) return `${cur} ${minAmount.toLocaleString('en-US')}+${per}`;
  return `Up to ${cur} ${maxAmount.toLocaleString('en-US')}${per}`;
}
