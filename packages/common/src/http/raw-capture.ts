import type { RawCaptureSink, RawCaptureWithheldReason, RawHttpEntry } from '@ever-jobs/models';

import { getRawCapture } from '../context/request-context';

/**
 * Spec 5161 — shared plumbing for raw HTTP capture.
 *
 * Both instrumented transports (`http-client.ts` for axios calls and
 * `browser-pool.ts` for Playwright pages) write `RawHttpEntry`s into a
 * per-source `RawCaptureSink` carried by the request async context.
 *
 * Fork-sync hardening: the entries go back to API callers (`raw_by_source`),
 * so everything stored here is treated as caller-visible, and credentials are
 * removed in four independent layers before an entry is stored:
 *
 * 1. Structure — URLs lose userinfo (`user:pass@`), the values of credential
 *    query keys and known path credentials (`SENSITIVE_PATH_SEGMENTS`).
 * 2. Key names — in request bodies, response / error bodies (parsed JSON, JSON
 *    text, form-encoded text, JS literals, XML) and any header map, the value
 *    of every key whose name looks like a credential (`isSensitiveKeyName`)
 *    becomes `REDACTED`.
 * 3. Values — every string is scrubbed of known secret values, server-held
 *    ones first (credential-named environment variables from
 *    `envSecretValues`, tokens registered with
 *    `registerServerRawCaptureSecrets`), then values a caller may have chosen
 *    (`registerRawCaptureSecrets`), so no caller value can be used to probe a
 *    server secret. A body over the size cap is sanitized past the cap and
 *    only then cut, so a secret straddling the cut is redacted whole
 *    (`retainBody`, `cutTextBody`).
 * 4. Token / auth calls — their request and response bodies are never retained:
 *    a plugin marks the request `rawCapture: false`, and URLs that look like a
 *    token or auth endpoint are withheld by default (`rawCaptureWithholdReason`).
 *
 * On every string, layer 3 runs before layers 1 and 2. Those end a value at a
 * delimiter (`&`, `;`, `/`, a quote, a space), so run first they would split
 * a known secret that contains one, and the value scrub would find nothing
 * whole to match.
 *
 * `drainRawCapture` runs layers 1–3 over every entry once more before the sink
 * closes, so a field written outside these helpers is still scrubbed. The API
 * runs them a last time over `raw_by_source` (`createRawCaptureScrubber`,
 * `scrubRawEntry`) with the request's own `auth` values in the caller tier.
 *
 * Which environment variables hold credentials is decided in one place,
 * `isSecretEnvName`, for every pass.
 */

const DEFAULT_MAX_BODY_BYTES = 5_242_880; // 5 MiB
const DEFAULT_MAX_SOURCE_BYTES = 20_971_520; // 20 MiB
const DEFAULT_DRAIN_MS = 2_000;

/**
 * Bytes past the per-body cap that are decoded and sanitized before a body is
 * cut to the cap, so a secret or credential pair straddling the cap is seen
 * whole and redacted rather than cut in half (`retainBody`).
 */
export const RAW_CAPTURE_CUT_SLACK_BYTES = 16_384;

/** What a removed credential is replaced with. */
export const RAW_CAPTURE_REDACTED = 'REDACTED';

/**
 * Shortest registered secret value that is scrubbed (`registerRawCaptureSecrets`,
 * `registerServerRawCaptureSecrets`, whose values carry no name); shorter ones
 * would mangle ordinary text.
 */
export const RAW_CAPTURE_MIN_SECRET_LENGTH = 8;

/**
 * Shortest value scrubbed when its NAME says it is a credential: a
 * credential-named environment variable (`isSecretEnvName`) or a
 * credential-named field of a request's `auth` block (`rawCaptureAuthSecrets`).
 * Short account ids used as credentials (a 6-digit publisher id) count.
 */
export const RAW_CAPTURE_MIN_CREDENTIAL_LENGTH = 6;

function envCap(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function rawCaptureMaxBodyBytes(): number {
  return envCap('RAW_CAPTURE_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES);
}

export function rawCaptureMaxSourceBytes(): number {
  return envCap('RAW_CAPTURE_MAX_SOURCE_BYTES', DEFAULT_MAX_SOURCE_BYTES);
}

export function createRawCaptureSink(): RawCaptureSink {
  return { entries: [], retained_bytes: 0, pending: [], closed: false };
}

// ---------------------------------------------------------------------------
// Key names
// ---------------------------------------------------------------------------

/**
 * @deprecated Anchored list kept for API compatibility only — it misses
 * `app_key`, `client_secret`, `refresh_token` and friends. Use
 * `isSensitiveKeyName`, which every redactor in this file now uses. Removal
 * target: the first release after the MakeDeeply fork sync (Spec 5161 follow-up).
 */
export const SENSITIVE_QUERY_KEYS =
  /^(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|pwd|auth|authorization|signature|sig|session|credentials?)$/i;

/**
 * Matched anywhere in a key name that is lower-cased with `_` and `-` removed.
 * `auth` is not matched inside `author` (`author`, `authored_by`, `authority`)
 * but is inside `authorization` / `authorise`.
 */
const SENSITIVE_KEY_PART =
  /secret|token|passw(?:or)?d|passphrase|apikey|appkey|credential|signature|cookie|session|private|auth(?!or(?!i[sz]))/;

/** Matched as the whole key or as its last word (`app_key`, `x-api-key`, `privateKey`, `user_pwd`). */
const SENSITIVE_KEY_WORDS = new Set(['key', 'sig', 'pwd', 'pass']);

const keyNameCache = new Map<string, boolean>();
const KEY_NAME_CACHE_MAX = 4096;

/**
 * Whether the value under `key` (query parameter, JSON / form field, header)
 * must be redacted. The key is normalized (lower case, `_` and `-` removed)
 * and matched by substring, so `client_secret`, `clientSecret`,
 * `refresh_token`, `x-api-key`, `app_key`, `Authorization`, `Set-Cookie`,
 * `session_id` and `private_key` all count.
 */
export function isSensitiveKeyName(key: string): boolean {
  if (!key) return false;
  const cached = keyNameCache.get(key);
  if (cached !== undefined) return cached;

  const name = key.length > 256 ? key.slice(0, 256) : key;
  const normalized = name.toLowerCase().replace(/[_-]/g, '');
  let sensitive = SENSITIVE_KEY_PART.test(normalized) || SENSITIVE_KEY_WORDS.has(normalized);
  if (!sensitive) {
    const words = name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[\s_.\-[\]]+/)
      .filter(Boolean);
    const last = words[words.length - 1];
    sensitive = last !== undefined && SENSITIVE_KEY_WORDS.has(last.toLowerCase());
  }

  if (keyNameCache.size >= KEY_NAME_CACHE_MAX) keyNameCache.clear();
  keyNameCache.set(key, sensitive);
  return sensitive;
}

/** A value under a sensitive key that can carry a secret (`true` / `null` / `''` cannot). */
function carriesSecret(value: unknown): boolean {
  return !(value === null || value === undefined || typeof value === 'boolean' || value === '');
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Hosts that carry a credential in the URL *path* rather than the query string,
 * mapped to the zero-based index of the offending path segment. A rule also
 * covers the host's subdomains.
 *
 * - Ceipal routes every tenant call through `https://api.ceipal.com/{apiKey}/job-postings/`.
 * - Jooble posts to `https://jooble.org/api/{apiKey}` (`source-jooble`): the key is
 *   the last segment, index 1. A one-segment page such as `/jobs-python` is left alone.
 * - CareerOneStop puts the account's user id in the path:
 *   `https://api.careeronestop.org/v2/jobsearch/{userId}/…` (`source-careeronestop`).
 *
 * Add a row here if another one appears.
 */
export const SENSITIVE_PATH_SEGMENTS: Record<string, number> = {
  'api.ceipal.com': 0,
  'jooble.org': 1,
  'api.careeronestop.org': 2,
};

/** Scheme + authority of an absolute URL, e.g. `https://api.ceipal.com:443`. */
const URL_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

/** The path-segment rule for `host` or its closest parent domain. */
function pathRuleFor(host: string): number | undefined {
  let candidate = host;
  for (;;) {
    const index = SENSITIVE_PATH_SEGMENTS[candidate];
    if (index !== undefined) return index;
    const dot = candidate.indexOf('.');
    if (dot === -1) return undefined;
    candidate = candidate.slice(dot + 1);
  }
}

/**
 * Drop the userinfo (`user:password@`) of an absolute URL. axios `auth` and
 * `https://user:pass@host` URLs both surface it in follow-redirects'
 * `responseUrl`, which becomes `final_url`.
 */
export function stripUrlUserinfo(url: string): string {
  const authority = URL_AUTHORITY.exec(url);
  if (!authority) return url;
  const at = authority[1].lastIndexOf('@');
  if (at === -1) return url;
  const start = authority[0].length - authority[1].length;
  return url.slice(0, start) + authority[1].slice(at + 1) + url.slice(authority[0].length);
}

/**
 * Replace a credential carried as a path segment (see
 * `SENSITIVE_PATH_SEGMENTS`) with `REDACTED`. Relative URLs and hosts with no
 * rule are returned unchanged.
 */
export function redactPathCredential(url: string): string {
  const authority = URL_AUTHORITY.exec(url);
  if (!authority) return url;

  const host = authority[1].replace(/^.*@/, '').replace(/:\d+$/, '').toLowerCase();
  const index = pathRuleFor(host);
  if (index === undefined) return url;

  const pathStart = authority[0].length;
  const query = url.indexOf('?', pathStart);
  const fragment = url.indexOf('#', pathStart);
  const ends = [query, fragment].filter((i) => i !== -1);
  const pathEnd = ends.length ? Math.min(...ends) : url.length;

  // A path that starts with `/` splits to a leading empty segment, so the
  // first real segment is at index 1.
  const segments = url.slice(pathStart, pathEnd).split('/');
  const target = index + 1;
  if (target >= segments.length || !segments[target]) return url;

  segments[target] = RAW_CAPTURE_REDACTED;
  return url.slice(0, pathStart) + segments.join('/') + url.slice(pathEnd);
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/** Redact the value of every credential key in an `a=1&b=2` list (query, fragment, form body). */
export function redactFormPairs(pairs: string): string {
  return pairs
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq <= 0) return pair;
      const key = pair.slice(0, eq);
      return isSensitiveKeyName(safeDecode(key)) ? `${key}=${RAW_CAPTURE_REDACTED}` : pair;
    })
    .join('&');
}

/**
 * Replace the value of every credential-bearing query parameter with
 * `REDACTED`. A fragment holding `key=value` pairs (an OAuth implicit-flow
 * `#access_token=…`) is redacted the same way; any other fragment is kept.
 */
export function redactQuery(url: string): string {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  if (queryAt === -1 && hashAt === -1) return url;

  let out = queryAt === -1 ? beforeHash : `${beforeHash.slice(0, queryAt)}?${redactFormPairs(beforeHash.slice(queryAt + 1))}`;
  if (hashAt !== -1) {
    const hash = url.slice(hashAt + 1);
    out += `#${hash.includes('=') ? redactFormPairs(hash) : hash}`;
  }
  return out;
}

/**
 * Strip credentials out of a URL before it reaches a log line or a capture
 * entry, leaving the rest intact so it still names its target: userinfo is
 * dropped, credential query values and known path credentials become
 * `REDACTED`. Splits on delimiters rather than parsing, so a relative or
 * malformed URL degrades to "unchanged" instead of throwing inside a logging path.
 */
export function redactUrl(url: string): string {
  return redactQuery(redactPathCredential(stripUrlUserinfo(url)));
}

/** Redact any absolute URLs embedded in free text (error messages). */
export function sanitizeErrorText(text: string): string {
  return text.replace(/https?:\/\/\S+/g, (u) => redactUrl(u.replace(/[).,;]+$/, '')));
}

// ---------------------------------------------------------------------------
// Token / auth endpoints
// ---------------------------------------------------------------------------

/** Path segments (lower case, `_` / `-` and any extension removed) that name a token or auth endpoint. */
const AUTH_PATH_SEGMENTS = new Set([
  'auth',
  'authorize',
  'authorise',
  'authorization',
  'authenticate',
  'authentication',
  'login',
  'signin',
  'token',
  'tokens',
  'tokeninfo',
  'introspect',
  'revoke',
]);

/**
 * Whether `url` looks like a token or auth endpoint: a path segment named like
 * one (`/v1/auth`, `/oauth2/token`, `/connexion/oauth2/access_token`,
 * `/openid-connect/token`, `/login`), or a query carrying `grant_type`. Whole
 * segments are matched rather than any `/oauth|token|auth/` substring, so a
 * company board slug such as `auth0` or `tokenmetrics` keeps its bodies.
 */
export function isCredentialEndpoint(url: string): boolean {
  const authority = URL_AUTHORITY.exec(url);
  const rest = authority ? url.slice(authority[0].length) : url;
  const hashAt = rest.indexOf('#');
  const beforeHash = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? '' : beforeHash.slice(queryAt + 1);

  if (/(?:^|&)grant_type=/i.test(query)) return true;
  for (const raw of path.split('/')) {
    if (!raw) continue;
    const segment = safeDecode(raw).toLowerCase().split('.')[0].replace(/[_-]/g, '');
    if (!segment) continue;
    if (AUTH_PATH_SEGMENTS.has(segment)) return true;
    if (segment.startsWith('oauth') || segment.endsWith('token') || segment.endsWith('tokens')) return true;
  }
  return false;
}

/**
 * Why a request's bodies must not be retained, or `undefined` when they may
 * be: `rawCapture: false` on the request (`opt_out`), else a URL that looks
 * like a token / auth endpoint (`auth_endpoint`).
 */
export function rawCaptureWithholdReason(
  url: string | undefined,
  rawCapture?: boolean,
): RawCaptureWithheldReason | undefined {
  if (rawCapture === false) return 'opt_out';
  if (url && isCredentialEndpoint(url)) return 'auth_endpoint';
  return undefined;
}

// ---------------------------------------------------------------------------
// Secret values
// ---------------------------------------------------------------------------

/**
 * Env-name fragments that mark a credential wherever they appear, inside a
 * word too (`AUTHTOKEN`, `APIKEYS`, `CAREERJET_AFFID`).
 */
const ENV_SECRET_PART = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|COOKIE|BEARER|SIGNATURE|AFFID/;

/** Env-name words that mark a credential only as a whole word (`TALROO_PUBLISHER_PASS`, `DB_PWD`). */
const ENV_SECRET_WORDS = new Set(['PASS', 'PWD']);

/**
 * Words before an `ID` word that make `<X>_ID` an account id used as a
 * credential (`ADZUNA_APP_ID`, `PERSONIO_CLIENT_ID`, `CAREERONESTOP_USER_ID`,
 * `TALROO_PUBLISHER_ID`, `*_ACCOUNT_ID`).
 */
const ENV_SECRET_ID_PREFIXES = new Set([
  'APP', 'CLIENT', 'USER', 'PUBLISHER', 'ACCOUNT', 'PARTNER', 'AFFILIATE', 'CONSUMER',
  'DEVELOPER', 'CUSTOMER', 'SESSION',
]);

/**
 * A last word that names a setting ABOUT a credential, not the credential:
 * `API_KEY_HEADER_NAME`, `EVER_JOBS_API_KEY_HEADER`, `UPWORK_TOKEN_URL`,
 * `UPWORK_GRANT_TYPE`, `SESSION_TTL`.
 */
const ENV_NOT_SECRET_LAST_WORDS = new Set([
  'NAME', 'HEADER', 'URL', 'URI', 'ENDPOINT', 'HOST', 'PORT', 'PATH', 'FILE', 'DIR', 'MODE',
  'TYPE', 'STYLE', 'STRATEGY', 'ENABLED', 'TTL', 'MS', 'SECONDS', 'LENGTH', 'COUNT', 'LIMIT',
  'MAX', 'MIN', 'TIMEOUT',
]);

/** Setting values that are never credentials, whatever the variable is called. */
const NON_SECRET_VALUES = /^(?:true|false|yes|no|on|off|null|undefined|none|enabled|disabled)$/i;

const envNameCache = new Map<string, boolean>();

/**
 * Whether the environment variable `name` holds a credential, judged by its
 * name alone. The one classifier for every raw-capture pass: the sink's
 * server tier (`envSecretValues`) and the API's last pass over
 * `raw_by_source` both use it.
 *
 * Words are split on anything but letters and digits. A credential: a
 * fragment from `ENV_SECRET_PART` anywhere, a whole `PASS` / `PWD` word, or
 * `ID` after an account word (`APP_ID`, `USER_ID`, `PUBLISHER_ID`, …). Not a
 * credential: a name whose last word names a setting about one (`_NAME`,
 * `_HEADER`, `_URL`, `_TYPE`, `_TTL`, … — so `API_KEY_HEADER_NAME=x-api-key`
 * is kept), and `KEYWORD` / `KEYWORDS`, which are search terms, not keys.
 */
export function isSecretEnvName(name: string): boolean {
  const cached = envNameCache.get(name);
  if (cached !== undefined) return cached;

  const words = name
    .toUpperCase()
    .replace(/KEYWORDS?/g, ' ')
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const secret =
    words.length > 0 &&
    !ENV_NOT_SECRET_LAST_WORDS.has(words[words.length - 1]) &&
    words.some(
      (word, index) =>
        ENV_SECRET_PART.test(word) ||
        ENV_SECRET_WORDS.has(word) ||
        (word === 'ID' && index > 0 && ENV_SECRET_ID_PREFIXES.has(words[index - 1])),
    );

  if (envNameCache.size >= KEY_NAME_CACHE_MAX) envNameCache.clear();
  envNameCache.set(name, secret);
  return secret;
}

/**
 * Add a credential value, and each item of a comma-separated one (`API_KEYS`),
 * when at least `RAW_CAPTURE_MIN_CREDENTIAL_LENGTH` long and not a plain
 * setting value (`true`, `enabled`, …).
 */
function addCredentialValue(values: Set<string>, raw: string): void {
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length >= RAW_CAPTURE_MIN_CREDENTIAL_LENGTH && !NON_SECRET_VALUES.test(trimmed)) values.add(trimmed);
  };
  add(raw);
  if (raw.includes(',')) raw.split(',').forEach(add);
}

/**
 * Values of credential-named environment variables (`isSecretEnvName`: `*_KEY`,
 * `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `*_PASS`, `*_PWD`, `*_CLIENT_ID`,
 * `*_APP_ID`, `*_USER_ID`, `*_PUBLISHER_ID`, `*_ACCOUNT_ID`, `*_AFFID`, …) at
 * least `RAW_CAPTURE_MIN_CREDENTIAL_LENGTH` long. A comma-separated value
 * (`API_KEYS`) also contributes each item.
 */
export function envSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const name of Object.keys(env)) {
    const value = env[name];
    if (typeof value !== 'string' || value.length < RAW_CAPTURE_MIN_CREDENTIAL_LENGTH) continue;
    if (isSecretEnvName(name)) addCredentialValue(values, value);
  }
  return [...values];
}

/**
 * `auth` field names (lower case, separators dropped) that hold an account id
 * used as a credential. `isSensitiveKeyName` covers the rest (`apiKey`,
 * `clientSecret`, `accessToken`, `corpToken`, …); `email` and `subdomain` are
 * not credentials.
 */
const AUTH_ID_FIELDS = new Set([
  'appid', 'clientid', 'userid', 'publisherid', 'accountid', 'partnerid', 'affiliateid', 'affid',
  'consumerid', 'developerid', 'customerid',
]);

/** Upper bound on `auth` nodes visited by `rawCaptureAuthSecrets`. */
const MAX_AUTH_NODES = 1_000;

function isAuthCredentialField(key: string): boolean {
  return isSensitiveKeyName(key) || AUTH_ID_FIELDS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/**
 * The credential values in a request's `auth` block (`input.auth`): every
 * string under a credential-named field (`apiKey`, `clientSecret`, `appId`,
 * `affId`, …, also inside an array under one), at least
 * `RAW_CAPTURE_MIN_CREDENTIAL_LENGTH` long. A caller chose them, so they belong
 * in the caller tier (`createRawCaptureScrubber({ caller })`).
 */
export function rawCaptureAuthSecrets(auth: unknown): string[] {
  const values = new Set<string>();
  const stack: Array<{ node: unknown; credential: boolean }> = [{ node: auth, credential: false }];
  for (let visited = 0; stack.length > 0 && visited < MAX_AUTH_NODES; visited++) {
    const { node, credential } = stack.pop() as { node: unknown; credential: boolean };
    if (typeof node === 'string') {
      if (credential) addCredentialValue(values, node);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        stack.push({ node: value, credential: credential || isAuthCredentialField(key) });
      }
    }
  }
  return [...values];
}

/** String leaves of `value` (a string, an array, or an object such as `input.auth`). */
function collectStrings(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 16 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.length >= RAW_CAPTURE_MIN_SECRET_LENGTH) out.add(value);
    return;
  }
  if (typeof value !== 'object') return;
  const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const item of items) collectStrings(item, out, depth + 1);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every secret plus the forms it takes once serialized:
 *
 * - `encodeURIComponent`, with upper- and lower-case hex, and with `+` for a space;
 * - axios `params` (axios 1.x `helpers/buildURL.js` `encode`): `encodeURIComponent`
 *   with `:` `$` `,` left raw and `+` for a space;
 * - `URLSearchParams` (WHATWG form encoding, also what axios writes for a form
 *   body): `!` `'` `(` `)` `~` percent-encoded as well, `+` for a space;
 * - JSON-escaped.
 */
function secretVariants(secrets: Iterable<string>): string[] {
  const variants = new Set<string>();
  for (const secret of secrets) {
    // Callers apply their own minimum (8 for registered values, 6 for named
    // credentials); this floor only keeps an explicit list from scrubbing words.
    if (secret.length < RAW_CAPTURE_MIN_CREDENTIAL_LENGTH) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
    variants.add(new URLSearchParams([['', secret]]).toString().slice(1));
    let encoded: string;
    try {
      encoded = encodeURIComponent(secret);
    } catch {
      continue; // a lone surrogate: no percent-encoded form exists
    }
    variants.add(encoded);
    variants.add(encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    variants.add(encoded.replace(/%20/g, '+'));
    variants.add(encoded.replace(/%3A/g, ':').replace(/%24/g, '$').replace(/%2C/g, ',').replace(/%20/g, '+'));
  }
  return [...variants];
}

/** One pass of the value scrub: a set of secrets that are redacted together. */
interface SecretTier {
  /** Matches when any variant occurs anywhere; no `g` flag, so `test` keeps no state. */
  probe: RegExp;
  variants: string[];
}

/**
 * The value scrub for one sink. Tiers run in order, each over the output of
 * the one before:
 *
 * 1. Server-held secrets — credential-named env values and values registered
 *    with `registerServerRawCaptureSecrets` (tokens a provider issued).
 * 2. Values a caller may have chosen — registered with
 *    `registerRawCaptureSecrets` (anything resolved from `input.auth`).
 *
 * The order is the security property. Matching a caller-chosen value against
 * text that still holds a server secret is an oracle: a caller value that
 * overlaps the secret's first characters changes what is redacted, so a
 * caller can confirm guesses one character at a time. Run second, a caller
 * value only ever sees server secrets as `REDACTED`.
 */
interface SecretScrubber {
  tiers: SecretTier[];
  /** Longest variant: how much a body cut mid-secret loses at its tail (`dropCutTail`). */
  longest: number;
  /** Shortest variant: a shorter string, or a number with fewer digits, cannot hold one. */
  shortest: number;
}

function buildTier(secrets: Iterable<string>): SecretTier | null {
  const variants = secretVariants(secrets);
  if (variants.length === 0) return null;
  return { probe: new RegExp(variants.map(escapeRegExp).join('|')), variants };
}

function buildScrubber(server: Iterable<string>, caller: Iterable<string>): SecretScrubber | null {
  const tiers: SecretTier[] = [];
  let longest = 0;
  let shortest = Number.POSITIVE_INFINITY;
  for (const tier of [buildTier(server), buildTier(caller)]) {
    if (!tier) continue;
    tiers.push(tier);
    for (const variant of tier.variants) {
      longest = Math.max(longest, variant.length);
      shortest = Math.min(shortest, variant.length);
    }
  }
  return tiers.length > 0 ? { tiers, longest, shortest } : null;
}

/** More occurrences than this of one tier's secrets in one string withholds the whole string. */
const MAX_SECRET_SPANS = 65_536;

/**
 * Replace every occurrence of every variant in `tier` with `REDACTED`.
 * Occurrences are found independently on the original text (`indexOf` per
 * variant) and overlapping ones are merged, so no value can hide another by
 * matching first — a single left-to-right alternation lets an earlier,
 * overlapping match consume a secret's first characters and leave the rest in
 * clear. The work is linear in the text per variant; a string with an absurd
 * number of occurrences is withheld whole rather than spliced.
 */
function scrubTier(text: string, tier: SecretTier): string {
  if (!tier.probe.test(text)) return text;
  const spans: Array<[number, number]> = [];
  for (const variant of tier.variants) {
    const length = variant.length;
    let start = -1;
    let end = -1;
    // Resuming at `end - length + 1` skips occurrences the current run already covers.
    for (let at = text.indexOf(variant); at !== -1; at = text.indexOf(variant, end - length + 1)) {
      if (at < end) {
        end = at + length;
        continue;
      }
      if (start !== -1) spans.push([start, end]);
      if (spans.length >= MAX_SECRET_SPANS) return RAW_CAPTURE_REDACTED;
      start = at;
      end = at + length;
    }
    if (start !== -1) spans.push([start, end]);
  }
  if (spans.length === 0) return text;

  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (let i = 0; i < spans.length; ) {
    const start = spans[i][0];
    let end = spans[i][1];
    for (i++; i < spans.length && spans[i][0] < end; i++) end = Math.max(end, spans[i][1]);
    out += text.slice(cursor, start) + RAW_CAPTURE_REDACTED;
    cursor = end;
  }
  return out + text.slice(cursor);
}

interface SinkSecrets {
  /** Read lazily, once per sink — a rotated env var is picked up by the next request. */
  env?: string[];
  /** Registered with `registerServerRawCaptureSecrets`: no caller chose them. */
  server: Set<string>;
  /** Registered with `registerRawCaptureSecrets`: a caller may have chosen them. */
  caller: Set<string>;
  /** Built lazily; `undefined` = stale. */
  scrubber?: SecretScrubber | null;
  /** Bumped on every registration, so sanitized fields are re-checked. */
  version: number;
}

const sinkSecrets = new WeakMap<RawCaptureSink, SinkSecrets>();

function secretsOf(sink: RawCaptureSink): SinkSecrets {
  let secrets = sinkSecrets.get(sink);
  if (!secrets) {
    secrets = { server: new Set(), caller: new Set(), version: 0 };
    sinkSecrets.set(sink, secrets);
  }
  return secrets;
}

/**
 * The value scrubber for `sink`: env secrets (cached on the sink) and the
 * values registered on it. Without a sink, env secrets are read afresh.
 */
function scrubberFor(sink: RawCaptureSink | undefined): SecretScrubber | null {
  if (!sink) return buildScrubber(envSecretValues(), []);
  const secrets = secretsOf(sink);
  if (secrets.scrubber === undefined) {
    secrets.env ??= envSecretValues();
    secrets.scrubber = buildScrubber([...secrets.env, ...secrets.server], secrets.caller);
  }
  return secrets.scrubber;
}

function addSecrets(values: unknown, sink: RawCaptureSink | undefined, target: 'server' | 'caller'): void {
  if (!sink) return;
  const found = new Set<string>();
  collectStrings(values, found);
  if (found.size === 0) return;
  const secrets = secretsOf(sink);
  const set = secrets[target];
  let added = false;
  for (const value of found) {
    if (set.has(value)) continue;
    set.add(value);
    added = true;
  }
  if (added) {
    secrets.scrubber = undefined;
    secrets.version += 1;
  }
}

/**
 * Register credential values to scrub from every entry of `sink` (by default
 * the sink in scope; a no-op when `include_raw` is off). `values` may be a
 * string, an array, or an object whose string leaves are taken — e.g. a
 * scraper input's `auth` block. Strings shorter than
 * `RAW_CAPTURE_MIN_SECRET_LENGTH` are ignored.
 *
 * Values registered here are treated as ones a caller may have chosen
 * (anything from `input.auth`, or a credential resolved from it or from the
 * environment), so they are scrubbed after the server-held secrets — see
 * `SecretScrubber`. An env-sourced credential needs no special call: its
 * environment variable already puts it in the server-held pass. Tokens a
 * provider issued go through `registerServerRawCaptureSecrets`.
 */
export function registerRawCaptureSecrets(
  values: unknown,
  sink: RawCaptureSink | undefined = getRawCapture(),
): void {
  addSecrets(values, sink, 'caller');
}

/**
 * Register server-held secret values — ones no caller can choose, such as a
 * token a provider issued or a credential from server configuration — to be
 * scrubbed in the same first pass as the env secrets. Never pass a value that
 * came from the request (`input.auth`): matched in this pass it could be used
 * to probe the server's own secrets. Same arguments as
 * `registerRawCaptureSecrets`.
 */
export function registerServerRawCaptureSecrets(
  values: unknown,
  sink: RawCaptureSink | undefined = getRawCapture(),
): void {
  addSecrets(values, sink, 'server');
}

// ---------------------------------------------------------------------------
// Sanitizing values
// ---------------------------------------------------------------------------

const MAX_SANITIZE_DEPTH = 64;

interface SanitizeState {
  scrubber: SecretScrubber | null;
  changed: boolean;
  ancestors: Set<object>;
}

function scrubString(text: string, state: SanitizeState): string {
  if (!state.scrubber || text.length < state.scrubber.shortest) return text;
  let scrubbed = text;
  for (const tier of state.scrubber.tiers) scrubbed = scrubTier(scrubbed, tier);
  if (scrubbed !== text) state.changed = true;
  return scrubbed;
}

function isBinary(value: object): boolean {
  return (
    Buffer.isBuffer(value) ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    typeof (value as { pipe?: unknown }).pipe === 'function'
  );
}

/** A redacted deep copy of a JSON-like value; the input is never mutated. */
function sanitizeNode(value: unknown, state: SanitizeState, depth: number): unknown {
  if (typeof value === 'string') return scrubString(value, state);
  if (typeof value === 'number') {
    // A numeric secret (an app id, say) parsed out of JSON text is a number, not a string.
    if (!state.scrubber || Math.abs(value) < 10 ** (state.scrubber.shortest - 1)) return value;
    const text = String(value);
    if (scrubString(text, state) === text) return value;
    return RAW_CAPTURE_REDACTED;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_SANITIZE_DEPTH) {
    state.changed = true;
    return '[Truncated]';
  }
  if (state.ancestors.has(value)) {
    state.changed = true;
    return '[Circular]';
  }
  // Parsed JSON is all plain objects and arrays: only anything else needs the
  // binary / URLSearchParams / toJSON checks.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
    if (isBinary(value)) {
      state.changed = true;
      return '[Binary]';
    }
    if (value instanceof URLSearchParams) {
      state.changed = true;
      return redactFormPairs(scrubString(value.toString(), state));
    }
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      try {
        return sanitizeNode(toJSON.call(value), state, depth + 1);
      } catch {
        state.changed = true;
        return undefined;
      }
    }
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = new Array(value.length);
      for (let i = 0; i < value.length; i++) items[i] = sanitizeNode(value[i], state, depth + 1);
      return items;
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const item = source[key];
      const outKey = scrubString(key, state);
      let clean: unknown;
      if (isSensitiveKeyName(key) && carriesSecret(item)) {
        clean = RAW_CAPTURE_REDACTED;
        state.changed = true;
      } else {
        clean = sanitizeNode(item, state, depth + 1);
      }
      // `JSON.parse` makes `__proto__` an own key; plain assignment would call
      // the setter instead, change the copy's prototype and drop the key.
      if (outKey === '__proto__') {
        Object.defineProperty(out, outKey, { value: clean, enumerable: true, writable: true, configurable: true });
      } else {
        out[outKey] = clean;
      }
    }
    return out;
  } finally {
    state.ancestors.delete(value);
  }
}

/*
 * Key-name rules for text that is not JSON that parses (HTML, XML, form text,
 * truncated JSON, JS literals). Every pattern below stays linear on hostile
 * input: a match starts at a fixed character (`{` / `,`, a separator, `<`),
 * every run but a value is bounded, and a value runs to its own terminator. A
 * value cut off by the end of the text — a body truncated by the per-body cap
 * — still counts, so its first characters are redacted rather than kept.
 *
 * They run AFTER the value scrub (`sanitizeText`): a rule ends a value at a
 * delimiter (`&`, `;`, `)`, a quote, a space, ...), so run first it would cut
 * a known secret that contains one in two, and the value scrub would then
 * find nothing whole to match and leave the tail in clear.
 */

/**
 * `"key": "value"` / `"key": 123` pairs in JSON-ish text that does not parse
 * (truncated JSON, JSON inside HTML). A match can only start at `{` or `,`.
 */
const JSON_TEXT_PAIR =
  /([{,]\s{0,16})"((?:[^"\\\r\n]|\\.){1,128})"(\s{0,16}:\s{0,16})("(?:[^"\\\r\n]|\\.)*(?:"|\\?$)|-?\d[\d.eE+-]{0,64})/g;

/**
 * Fragments every credential key name contains in its raw spelling (a
 * superset of `isSensitiveKeyName`, which decides). The rules below only
 * match keys that contain one, so the many ordinary attributes and pairs of an
 * HTML page cost a failed check, not a replacement callback. A key that
 * spells a fragment across `_` / `-` (`sec_ret`) is not seen here.
 */
const KEY_FRAGMENT = '(?:secret|token|pass|key|credential|cookie|session|private|auth|sig|pwd)';

/**
 * `key: 'value'`, `'key': "value"`, `key="value"` — JS object literals,
 * single-quoted pairs, XML / HTML attributes. The match starts at the
 * separator; lookbehinds read the key (bare, `"quoted"` or `'quoted'`).
 * Groups: key (one of three), value.
 */
const QUOTED_TEXT_PAIR = new RegExp(
  String.raw`[:=](?<=${KEY_FRAGMENT}[\w$.-]{0,127}["']?\s{0,16}[:=])` +
    String.raw`(?<=(?:"([\w$.-]{1,128})"|'([\w$.-]{1,128})'|(?<![\w$.-])([A-Za-z_$][\w$.-]{0,127}))\s{0,16}[:=])` +
    String.raw`\s{0,16}("(?:[^"\\\r\n]|\\.)*(?:"|\\?$)|'(?:[^'\\\r\n]|\\.)*(?:'|\\?$))`,
  'gi',
);

/**
 * `key=value` pairs in free text: a form-encoded body with whitespace around
 * it, a query string inside HTML or a log line. The match starts at `=`; the
 * key (read by lookbehind) follows a separator, the unquoted value runs to
 * the next one. Groups: key, value.
 */
const FORM_TEXT_PAIR = new RegExp(
  String.raw`=(?<=${KEY_FRAGMENT}[\w.%[\]-]{0,127}=)(?<=(?:^|[\s&?;#"'(,{>])([\w.%[\]-]{1,128})=)([^\s&"'<>;)}\]]+)`,
  'gi',
);

/**
 * `<access_token>value</access_token>` — an XML element named like a
 * credential. Only its text is replaced; the tags are kept. A CDATA value is
 * handled by `redactCdataSections`. Groups: name, attributes.
 */
const XML_TEXT_ELEMENT = new RegExp(
  String.raw`<(?=[\w.:-]{0,255}?${KEY_FRAGMENT})([A-Za-z_][\w.-]{0,127}(?::[A-Za-z_][\w.-]{0,127})?)` +
    String.raw`(\s[^<>]{0,1024})?(?<!\/)>([^<]+)(?=<\/\1\s*>|$)`,
  'gi',
);

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

/** Longest start tag read back from a CDATA section (the name and attributes `XML_TEXT_ELEMENT` allows). */
const MAX_START_TAG = 1_300;

/** A whole start tag, as read back from a CDATA section. Groups: name. */
const START_TAG = /^<([A-Za-z_][\w.-]{0,127}(?::[A-Za-z_][\w.-]{0,127})?)(?:\s[^<>]*)?>$/;

function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Whether `text[lt..gt)` — found by scanning back from `gt`, never below
 * `floor` — is the start tag of an element named like a credential.
 */
function startTagIsCredential(text: string, gt: number, floor: number): boolean {
  const limit = Math.max(floor, gt - MAX_START_TAG);
  let lt = gt - 2;
  for (; lt >= limit; lt--) {
    const code = text.charCodeAt(lt);
    if (code === 0x3c /* < */) break;
    if (code === 0x3e /* > */) return false;
  }
  if (lt < limit) return false;
  const tag = text.slice(lt, gt);
  if (tag.charCodeAt(tag.length - 2) === 0x2f /* / */) return false; // `<x/>` holds no text
  const match = START_TAG.exec(tag);
  return match !== null && isSensitiveKeyName(match[1].slice(match[1].indexOf(':') + 1));
}

/**
 * Replace each CDATA section that is the text of an element named like a
 * credential (`<password> <![CDATA[…]]> </password>`) with `REDACTED`.
 * Whitespace may surround the section, its value may hold `]` or `<`, and a
 * value split over several adjacent sections loses all of them. Sections never
 * nest, so one forward scan finds them all, and the look-back from each stops
 * at the end of the one before: the work is linear in the text.
 */
function redactCdataSections(text: string): string {
  let open = text.indexOf(CDATA_OPEN);
  if (open === -1) return text;
  let out = '';
  let cursor = 0;
  let floor = 0;
  let redactedEnd = -1;
  while (open !== -1) {
    const close = text.indexOf(CDATA_CLOSE, open + CDATA_OPEN.length);
    const end = close === -1 ? text.length : close + CDATA_CLOSE.length;
    let before = open;
    while (before > floor && isXmlSpace(text.charCodeAt(before - 1))) before--;
    const credential =
      before === redactedEnd ||
      (before > floor && text.charCodeAt(before - 1) === 0x3e /* > */ && startTagIsCredential(text, before, floor));
    if (credential) {
      out += text.slice(cursor, open) + RAW_CAPTURE_REDACTED;
      cursor = end;
      redactedEnd = end;
    }
    if (close === -1) break;
    floor = end;
    open = text.indexOf(CDATA_OPEN, floor);
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

/**
 * A start tag with a `value` attribute: `<param name="access_token" value="…"/>`,
 * `<input type="hidden" name="client_secret" value="…">`, `<token value="…"/>`.
 * A match starts at `<` and cannot run past the next `<` or `>`, so matches
 * never overlap and the work is linear; `(?=\s)` ends the name at once, so a
 * shorter name is never retried against the long look-ahead. Groups: name,
 * attributes.
 */
const VALUE_ATTRIBUTE_TAG =
  /<([A-Za-z_][\w.:-]{0,127})(?=\s)(?=[^<>]{0,4096}?\svalue\s{0,16}=)(\s[^<>]{0,4096})>/gi;

/**
 * One attribute of a start tag, read left to right with the sticky flag (each
 * call consumes at least one character, so a tag is read in one pass). A quote
 * left open runs to the end of the tag. Groups: name, raw value (with quotes).
 */
const ATTRIBUTE_TOKEN = /\s*([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"?|'[^']*'?|[^\s"'<>]*))?|[\s\S]/y;

/**
 * The tag with its `value` redacted when it holds a credential: the element
 * is named like one, its `name` attribute is, or it is `type="password"`.
 */
function redactValueAttribute(tag: string, name: string, attributes: string): string {
  let credential = isSensitiveKeyName(name.slice(name.indexOf(':') + 1));
  let valueAt = -1;
  let valueRaw = '';
  ATTRIBUTE_TOKEN.lastIndex = 0;
  while (ATTRIBUTE_TOKEN.lastIndex < attributes.length) {
    const at = ATTRIBUTE_TOKEN.lastIndex;
    const token = ATTRIBUTE_TOKEN.exec(attributes);
    if (!token) break;
    const [whole, attribute, raw] = token;
    if (attribute === undefined || raw === undefined) continue;
    const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : '';
    const unquoted = quote ? raw.slice(1, raw.length > 1 && raw.endsWith(quote) ? -1 : undefined) : raw;
    const lower = attribute.toLowerCase();
    if (lower === 'value') {
      valueAt = at + whole.length - raw.length;
      valueRaw = raw;
    } else if (lower === 'name' && isSensitiveKeyName(unquoted)) {
      credential = true;
    } else if (lower === 'type' && unquoted.toLowerCase() === 'password') {
      credential = true;
    }
  }
  const quote = valueRaw[0] === '"' || valueRaw[0] === "'" ? valueRaw[0] : '';
  const empty = valueRaw.length === 0 || (quote !== '' && valueRaw.length <= 2);
  if (!credential || valueAt === -1 || empty) return tag;
  const start = 1 + name.length + valueAt; // `<` + name + offset in the attributes
  return `${tag.slice(0, start)}${quote}${RAW_CAPTURE_REDACTED}${quote}${tag.slice(start + valueRaw.length)}`;
}

/** Longest text checked for being a whole form-encoded body (`a=1&b=2`). */
const MAX_FORM_TEXT = 65_536;

/** A whole `a=1&b=2` body; whitespace around it (a trailing newline) is allowed. */
function looksFormEncoded(text: string): boolean {
  if (text.length === 0 || text.length > MAX_FORM_TEXT || !text.includes('=')) return false;
  const body = text.trim();
  if (body.length === 0 || /\s/.test(body)) return false;
  return body.split('&').every((pair) => pair.indexOf('=') > 0);
}

/** `redactFormPairs` over a form body, keeping the whitespace around it. */
function redactFormBody(text: string): string {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  return text.slice(0, start) + redactFormPairs(text.slice(start, end)) + text.slice(end);
}

/** Apply the key-name rules above to text that is not JSON that parses. */
function redactTextPairs(text: string): string {
  let out = text;
  if (out.includes('"')) {
    out = out.replace(
      JSON_TEXT_PAIR,
      (match: string, lead: string, key: string, separator: string, value: string) =>
        value !== '""' && isSensitiveKeyName(key) ? `${lead}"${key}"${separator}"${RAW_CAPTURE_REDACTED}"` : match,
    );
  }
  if (out.includes('"') || out.includes("'")) {
    out = out.replace(
      QUOTED_TEXT_PAIR,
      (
        match: string,
        doubleQuoted: string | undefined,
        singleQuoted: string | undefined,
        bare: string | undefined,
        value: string,
      ) => {
        if (value.length === 2 && value[0] === value[1]) return match; // '' or ""
        if (!isSensitiveKeyName(doubleQuoted ?? singleQuoted ?? bare ?? '')) return match;
        const q = value[0];
        return `${match.slice(0, match.length - value.length)}${q}${RAW_CAPTURE_REDACTED}${q}`;
      },
    );
  }
  if (out.includes('=')) {
    out = out.replace(FORM_TEXT_PAIR, (match: string, key: string) =>
      isSensitiveKeyName(safeDecode(key)) ? `=${RAW_CAPTURE_REDACTED}` : match,
    );
  }
  if (out.includes('<')) {
    out = redactCdataSections(out);
    out = out.replace(VALUE_ATTRIBUTE_TAG, redactValueAttribute);
    out = out.replace(XML_TEXT_ELEMENT, (match: string, name: string, attributes: string | undefined) =>
      isSensitiveKeyName(name.slice(name.indexOf(':') + 1))
        ? `<${name}${attributes ?? ''}>${RAW_CAPTURE_REDACTED}`
        : match,
    );
  }
  return out;
}

/**
 * A redacted copy of a text body. Secret values are scrubbed first, on the
 * text exactly as received (server-held, then caller-chosen: `scrubString`).
 * Then JSON text that parses is redacted by key and re-serialized only when
 * that changed something; any other text goes through the key-name rules
 * (`redactTextPairs`: JSON-ish and JS-literal pairs, form pairs, XML elements,
 * CDATA and attributes).
 *
 * The value scrub runs on the text rather than only on the parsed copy:
 * `JSON.parse` drops an earlier duplicate key and rounds integers past 2^53,
 * so a secret in either never reaches the parsed copy, and returning the text
 * because the parsed copy looked clean would return it in clear.
 */
function sanitizeText(text: string, state: SanitizeState): string {
  const scrubbed = scrubString(text, state);
  const first = scrubbed.trimStart()[0];
  if (first === '{' || first === '[') {
    let parsed: unknown;
    let parsedOk = false;
    try {
      parsed = JSON.parse(scrubbed);
      parsedOk = true;
    } catch {
      /* not JSON (or no longer, a bare-number secret became REDACTED) — the text rules below */
    }
    if (parsedOk) {
      const outer = state.changed;
      state.changed = false;
      const clean = sanitizeNode(parsed, state, 0);
      if (state.changed) return JSON.stringify(clean);
      state.changed = outer;
      // Nothing to redact by key: the text as received, value-scrubbed (the
      // original string itself when the value scrub found nothing either).
      return scrubbed;
    }
  }

  let out = looksFormEncoded(scrubbed) ? redactFormBody(scrubbed) : scrubbed;
  out = redactTextPairs(out);
  if (out !== scrubbed) state.changed = true;
  return out;
}

function stateWith(scrubber: SecretScrubber | null): SanitizeState {
  return { scrubber, changed: false, ancestors: new Set() };
}

function newState(sink: RawCaptureSink | undefined): SanitizeState {
  return stateWith(scrubberFor(sink));
}

function sanitizeValueWith(value: unknown, scrubber: SecretScrubber | null): unknown {
  const state = stateWith(scrubber);
  return typeof value === 'string' ? sanitizeText(value, state) : sanitizeNode(value, state, 0);
}

/**
 * The secret-value scrub, then `redactUrl`. The value scrub goes first so a
 * secret holding `/`, `?`, `&` or `@` is matched whole before the structural
 * rules split the URL on those characters.
 */
function cleanUrlWith(url: string, scrubber: SecretScrubber | null): string {
  return redactUrl(scrubString(url, stateWith(scrubber)));
}

/** The secret-value scrub, then embedded URLs redacted. */
function cleanErrorTextWith(text: string, scrubber: SecretScrubber | null): string {
  return sanitizeErrorText(scrubString(text, stateWith(scrubber)));
}

/**
 * A caller-safe copy of a captured body (request or response): strings via
 * `sanitizeText`, structured values via a redacting deep copy. Never mutates
 * the input — the plugin still holds the original response.
 */
export function sanitizeCapturedValue(value: unknown, sink?: RawCaptureSink): unknown {
  return sanitizeValueWith(value, scrubberFor(sink));
}

/** `url` as stored on an entry: the secret-value scrub, then `redactUrl` (`cleanUrlWith`). */
export function captureUrl(url: string, sink?: RawCaptureSink): string {
  return cleanUrlWith(url, scrubberFor(sink));
}

/** Error text as stored on an entry: the secret-value scrub, then embedded URLs redacted. */
export function captureErrorText(text: string, sink?: RawCaptureSink): string {
  return cleanErrorTextWith(text, scrubberFor(sink));
}

/** Recursively redact sensitive keys in a JSON-parsed value (returns a copy). */
export function redactSensitiveKeys(value: unknown): unknown {
  return sanitizeNode(value, { scrubber: null, changed: false, ancestors: new Set() }, 0);
}

/**
 * `data` as a redacted, caller-safe request body, or `undefined` when it is
 * not one we capture. JSON (object, array, or a string that parses) is kept
 * structured; a form-encoded string or `URLSearchParams` is kept as a redacted
 * string; binary payloads, streams and any other text are dropped.
 */
export function captureRequestBody(data: unknown, sink?: RawCaptureSink): unknown {
  if (data === null || data === undefined) return undefined;
  const state = newState(sink);
  if (typeof data === 'string') {
    try {
      return sanitizeNode(JSON.parse(data), state, 0);
    } catch {
      if (!looksFormEncoded(data)) return undefined;
      // Value scrub first: a secret holding `&` would otherwise be split by the pair rule.
      return redactFormBody(scrubString(data, state));
    }
  }
  if (typeof data === 'object') {
    if (data instanceof URLSearchParams) return redactFormPairs(scrubString(data.toString(), state));
    if (isBinary(data)) return undefined;
    // FormData / Blob bodies are not JSON — keep them out rather than guess.
    const tag = Object.prototype.toString.call(data);
    if (tag === '[object FormData]' || tag === '[object Blob]') return undefined;
    return sanitizeNode(data, state, 0);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Body size and truncation
// ---------------------------------------------------------------------------

/** Content types whose payloads are never decoded into text. */
const BINARY_CONTENT_TYPE =
  /^\s*(?:image|audio|video|font)\/|^\s*application\/(?:octet-stream|pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|wasm|x-protobuf|protobuf|msword|vnd\.ms-|vnd\.openxmlformats)/i;

/**
 * End offset (≤ `maxBytes`) that does not split a UTF-8 sequence: if the first
 * excluded byte is a continuation byte, back up to the start of its character.
 */
function utf8SafeEnd(buf: Uint8Array, maxBytes: number): number {
  if (buf.byteLength <= maxBytes) return buf.byteLength;
  let end = Math.max(0, maxBytes);
  for (let steps = 0; end > 0 && steps < 3 && (buf[end] & 0xc0) === 0x80; steps++) end--;
  return end;
}

function asBuffer(data: Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Normalize a response payload to a retainable form. Returns the value plus
 * its UTF-8 byte length, or `null` when the payload is a binary / stream type
 * we deliberately do not capture.
 *
 * A Buffer is cut to the per-body cap (plus `RAW_CAPTURE_CUT_SLACK_BYTES`,
 * which `retainBody` sanitizes before the final cut) *before* it is decoded,
 * so a huge body never becomes a huge string. A parsed JSON value is still
 * serialized once to measure it: axios already parsed it, and its size
 * decides whether it fits.
 */
export function normalizeBody(
  data: unknown,
  contentType?: string,
): { value: unknown; bytes: number } | null {
  if (data === null || data === undefined) return null;
  if (typeof data === 'string') {
    return { value: data, bytes: Buffer.byteLength(data, 'utf8') };
  }
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    if (contentType && BINARY_CONTENT_TYPE.test(contentType)) return null;
    const buf = asBuffer(data);
    const window = rawCaptureMaxBodyBytes() + RAW_CAPTURE_CUT_SLACK_BYTES;
    const text = buf.subarray(0, utf8SafeEnd(buf, window)).toString('utf8');
    return { value: text, bytes: buf.byteLength };
  }
  if (typeof data === 'object') {
    // Streams (axios `responseType: 'stream'`) expose `pipe` — never read.
    if (typeof (data as { pipe?: unknown }).pipe === 'function') return null;
    let serialized: string;
    try {
      serialized = JSON.stringify(data);
    } catch {
      return null;
    }
    if (serialized === undefined) return null;
    return { value: data, bytes: Buffer.byteLength(serialized, 'utf8') };
  }
  if (typeof data === 'number' || typeof data === 'boolean') {
    const serialized = String(data);
    return { value: serialized, bytes: Buffer.byteLength(serialized, 'utf8') };
  }
  return null;
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * character. Only a prefix that can fit is ever encoded (every UTF-16 code
 * unit takes at least one byte), so a huge string is not copied whole.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let prefix = text;
  if (text.length > maxBytes) {
    prefix = text.slice(0, maxBytes);
    // Do not leave half of a surrogate pair at the cut.
    const last = prefix.charCodeAt(prefix.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  } else if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }
  const buf = Buffer.from(prefix, 'utf8');
  return buf.subarray(0, utf8SafeEnd(buf, maxBytes)).toString('utf8');
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** Fields whose values are small scalars set by the transports, never scrubbed. */
const META_FIELDS = new Set(['seq', 'attempt', 'status', 'elapsed_ms', 'body_bytes', 'truncated', 'bodies_withheld']);

/** Body fields already sanitized, so the final pass in `drainRawCapture` can skip them. */
const sanitizedBodies = new WeakMap<RawHttpEntry, { field: 'body' | 'request_body'; value: unknown; version: number }[]>();

function markSanitized(sink: RawCaptureSink, entry: RawHttpEntry, field: 'body' | 'request_body', value: unknown): void {
  const version = secretsOf(sink).version;
  const marks = (sanitizedBodies.get(entry) ?? []).filter((m) => m.field !== field);
  marks.push({ field, value, version });
  sanitizedBodies.set(entry, marks);
}

function isMarkedSanitized(sink: RawCaptureSink, entry: RawHttpEntry, field: 'body' | 'request_body'): boolean {
  const mark = sanitizedBodies.get(entry)?.find((m) => m.field === field);
  return mark !== undefined && mark.value === entry[field] && mark.version === secretsOf(sink).version;
}

/** A sanitized copy of entry fields (`url`, `final_url`, `error`, bodies, any extra field such as headers). */
function sanitizeFieldsWith<T extends Partial<RawHttpEntry>>(scrubber: SecretScrubber | null, fields: T): T {
  const out: Record<string, unknown> = { ...fields };
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined || META_FIELDS.has(key)) continue;
    if (key === 'url' || key === 'final_url') {
      if (typeof value === 'string') out[key] = cleanUrlWith(value, scrubber);
    } else if (key === 'error') {
      out[key] = cleanErrorTextWith(typeof value === 'string' ? value : String(value), scrubber);
    } else if (key === 'body' || key === 'request_body') {
      out[key] = sanitizeValueWith(value, scrubber);
    } else if (typeof value === 'string') {
      out[key] = scrubString(value, stateWith(scrubber));
    } else if (typeof value === 'object') {
      out[key] = sanitizeNode(value, stateWith(scrubber), 0);
    }
  }
  return out as unknown as T;
}

function sanitizeFields<T extends Partial<RawHttpEntry>>(sink: RawCaptureSink, fields: T): T {
  return sanitizeFieldsWith(scrubberFor(sink), fields);
}

/**
 * Push an entry skeleton onto the sink, or return `null` when the sink is
 * closed — the response already shipped, so late writes are dropped rather
 * than buffered for nobody. Every field is sanitized on the way in (pass raw
 * URLs and errors); an entry with `bodies_withheld` never keeps a request body.
 */
export function pushRawEntry(
  sink: RawCaptureSink,
  fields: Omit<RawHttpEntry, 'seq'>,
): RawHttpEntry | null {
  if (sink.closed) return null;
  const clean = sanitizeFields(sink, fields);
  if (clean.bodies_withheld) {
    delete clean.request_body;
    delete clean.body;
  }
  const entry: RawHttpEntry = { seq: sink.entries.length, ...clean };
  if (entry.request_body !== undefined) markSanitized(sink, entry, 'request_body', entry.request_body);
  sink.entries.push(entry);
  return entry;
}

/**
 * Apply `patch` to `entry`, sanitized like `pushRawEntry`. Dropped once the
 * sink is closed. A `final_url` that redacts to the entry's `url` is not set.
 */
export function updateRawEntry(
  sink: RawCaptureSink,
  entry: RawHttpEntry,
  patch: Partial<Omit<RawHttpEntry, 'seq'>>,
): void {
  if (sink.closed) return;
  const clean = sanitizeFields(sink, patch);
  if (clean.final_url !== undefined && clean.final_url === entry.url) delete clean.final_url;
  if (entry.bodies_withheld || clean.bodies_withheld) {
    delete clean.request_body;
    delete clean.body;
  }
  Object.assign(entry, clean);
}

/** Entries whose text body was cut by the per-body cap (`dropCutTail` applies on every re-sanitize). */
const cutBodies = new WeakSet<RawHttpEntry>();

/** `dropCutTail` drops a multiple of this many characters, so the amount barely reflects secret lengths. */
const CUT_TAIL_QUANTUM = 64;

/**
 * Text that ends where a body was cut can end in the first characters of a
 * secret whose rest was cut off, and the value scrub only matches whole
 * secrets. Drop the last characters of the sanitized text: at least the
 * longest secret variant, rounded up. Run after sanitizing, so a secret that
 * ends before the cut is already `REDACTED` and only a partial one can be in
 * the raw tail. The amount depends on the registered secrets, never on the
 * text, so what is dropped does not tell a caller whether a secret was there.
 */
function dropCutTail(text: string, sink: RawCaptureSink): string {
  const scrubber = scrubberFor(sink);
  if (!scrubber) return text;
  const margin = Math.ceil(scrubber.longest / CUT_TAIL_QUANTUM) * CUT_TAIL_QUANTUM;
  if (text.length <= margin) return '';
  let end = text.length - margin;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // never keep half of a surrogate pair
  return text.slice(0, end);
}

/**
 * A text body over the per-body cap, ready to retain. `window` is the body
 * cut to the cap plus `RAW_CAPTURE_CUT_SLACK_BYTES`, and is sanitized
 * *before* the cut to the cap: a secret or a `"token": "…"` pair that
 * straddles the cap is seen whole, redacted, and only then cut. When the
 * window itself cut through the body, its tail goes too (`dropCutTail`); with
 * ordinary secret lengths that tail lies past the cap and costs nothing.
 */
function cutTextBody(window: string, windowCut: boolean, maxBody: number, sink: RawCaptureSink): unknown {
  const clean = sanitizeCapturedValue(window, sink);
  if (typeof clean !== 'string') return clean;
  return truncateUtf8(windowCut ? dropCutTail(clean, sink) : clean, maxBody);
}

/**
 * Retain `body` on `entry` under both budgets: the per-body cap truncates the
 * value, the per-source cap decides whether anything is retained at all.
 * `body_bytes` always records the original serialized size. The retained
 * value is a sanitized copy; nothing is retained for an entry with
 * `bodies_withheld` or once the sink is closed.
 */
export function retainBody(
  sink: RawCaptureSink,
  entry: RawHttpEntry,
  normalized: { value: unknown; bytes: number } | null,
): void {
  if (!normalized || sink.closed) return;
  entry.body_bytes = normalized.bytes;
  if (entry.bodies_withheld) return;

  let value = normalized.value;
  let bytes = normalized.bytes;
  let cut = false;
  let windowCut = false;
  const maxBody = rawCaptureMaxBodyBytes();
  if (bytes > maxBody) {
    entry.truncated = true;
    if (typeof value === 'string') {
      // Sanitized past the cap first, then cut (`cutTextBody`).
      const window = maxBody + RAW_CAPTURE_CUT_SLACK_BYTES;
      windowCut = bytes > window;
      value = truncateUtf8(value, window);
      bytes = maxBody; // what is retained at most
      cut = true;
    } else {
      // A JSON body cannot be partially parsed — omit it entirely.
      value = undefined;
      bytes = 0;
    }
  }

  if (sink.retained_bytes + bytes > rawCaptureMaxSourceBytes()) {
    entry.truncated = true;
    return;
  }
  if (value !== undefined) {
    let clean: unknown;
    if (cut) {
      cutBodies.add(entry);
      clean = cutTextBody(value as string, windowCut, maxBody, sink);
    } else {
      clean = sanitizeCapturedValue(value, sink);
    }
    entry.body = clean;
    markSanitized(sink, entry, 'body', clean);
    sink.retained_bytes += bytes;
  }
}

/**
 * Retain a raw response `buf` (browser traffic). A body over the per-body cap
 * is never decoded whole: JSON is omitted (it cannot be partially parsed, as
 * on the axios path) and text keeps a decoded prefix.
 */
export function retainBufferBody(
  sink: RawCaptureSink,
  entry: RawHttpEntry,
  buf: Uint8Array,
  contentType?: string,
): void {
  if (sink.closed) return;
  const json = contentType?.toLowerCase().includes('json') ?? false;
  if (buf.byteLength > rawCaptureMaxBodyBytes()) {
    if (json) {
      entry.body_bytes = buf.byteLength;
      entry.truncated = true;
      return;
    }
    retainBody(sink, entry, normalizeBody(buf, contentType));
    return;
  }
  if (contentType && BINARY_CONTENT_TYPE.test(contentType)) {
    entry.body_bytes = buf.byteLength;
    return;
  }
  const text = asBuffer(buf).toString('utf8');
  let value: unknown = text;
  if (json) {
    try {
      value = JSON.parse(text);
    } catch {
      /* keep the raw text */
    }
  }
  retainBody(sink, entry, normalizeBody(value, contentType));
}

/**
 * Run the sanitizers over a whole entry once more (layers 1–3). Bodies already
 * sanitized under the current secret set are skipped. If anything throws,
 * the bodies are dropped — the entry fails closed.
 */
function sanitizeRawEntry(sink: RawCaptureSink, entry: RawHttpEntry): void {
  try {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (META_FIELDS.has(key) || value === undefined) continue;
      if ((key === 'body' || key === 'request_body') && isMarkedSanitized(sink, entry, key)) continue;
      fields[key] = value;
    }
    const clean = sanitizeFields(sink, fields as Partial<RawHttpEntry>);
    // A cut body re-sanitized under new secrets loses its tail again: a
    // secret registered since may be longer than the first margin.
    if (typeof clean.body === 'string' && cutBodies.has(entry)) clean.body = dropCutTail(clean.body, sink);
    if (entry.bodies_withheld) {
      delete entry.body;
      delete entry.request_body;
      delete clean.body;
      delete clean.request_body;
    }
    Object.assign(entry, clean);
  } catch {
    delete entry.body;
    delete entry.request_body;
    entry.truncated = true;
  }
}

/**
 * Wait for in-flight body reads (browser responses finish asynchronously),
 * run the final sanitize pass over every entry, then close the sink so no
 * further writes are accepted. The cap keeps a wedged body read from delaying
 * the response.
 */
export async function drainRawCapture(
  sink: RawCaptureSink,
  capMs: number = DEFAULT_DRAIN_MS,
): Promise<void> {
  if (sink.pending.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...sink.pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, capMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }
  for (const entry of sink.entries) sanitizeRawEntry(sink, entry);
  sink.closed = true;
}

// ---------------------------------------------------------------------------
// A last pass outside the sink (the API's `raw_by_source`)
// ---------------------------------------------------------------------------

/**
 * An opaque value scrub built from explicit secrets (`createRawCaptureScrubber`),
 * for a pass over entries after their sink closed.
 */
export interface RawCaptureScrubber {
  readonly kind: 'raw-capture-scrubber';
}

const scrubberHandles = new WeakMap<RawCaptureScrubber, SecretScrubber | null>();

/**
 * A value scrub with the same two tiers as a sink (`SecretScrubber`): first
 * the server-held secrets — the credential-named values of `env`
 * (`envSecretValues`, default `process.env`) plus `server` — then the values a
 * caller may have chosen (`caller`, e.g. `rawCaptureAuthSecrets(input.auth)`).
 * Occurrences are merged into spans within a tier, so a caller value can never
 * hide or expose part of a server secret.
 */
export function createRawCaptureScrubber(
  secrets: { env?: NodeJS.ProcessEnv; server?: Iterable<string>; caller?: Iterable<string> } = {},
): RawCaptureScrubber {
  const handle: RawCaptureScrubber = Object.freeze({ kind: 'raw-capture-scrubber' as const });
  const server = [...envSecretValues(secrets.env ?? process.env), ...(secrets.server ?? [])];
  scrubberHandles.set(handle, buildScrubber(server, secrets.caller ?? []));
  return handle;
}

function resolveScrubber(scrubber: RawCaptureScrubber | undefined): SecretScrubber | null {
  return scrubber ? (scrubberHandles.get(scrubber) ?? null) : null;
}

/**
 * A copy of `entry` with every field sanitized again — the same rules as
 * `drainRawCapture` (layers 1–3), under `scrubber`'s secrets instead of the
 * sink's. A JSON text body is rewritten only when something in it is redacted,
 * so an entry with nothing to remove keeps its body exactly as received.
 * Without a scrubber only the structure and key-name rules apply.
 */
export function scrubRawEntry<T extends RawHttpEntry>(entry: T, scrubber?: RawCaptureScrubber): T {
  const clean: RawHttpEntry = sanitizeFieldsWith(resolveScrubber(scrubber), entry);
  if (clean.bodies_withheld) {
    delete clean.body;
    delete clean.request_body;
  }
  return clean as T;
}

/** A URL scrubbed as `scrubRawEntry` scrubs `url` / `final_url`. */
export function scrubRawUrl(url: string, scrubber?: RawCaptureScrubber): string {
  return cleanUrlWith(url, resolveScrubber(scrubber));
}

/** Error text scrubbed as `scrubRawEntry` scrubs `error`. */
export function scrubRawErrorText(text: string, scrubber?: RawCaptureScrubber): string {
  return cleanErrorTextWith(text, resolveScrubber(scrubber));
}
