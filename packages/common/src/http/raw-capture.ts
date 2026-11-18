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
 *    text, form-encoded text) and any header map, the value of every key whose
 *    name looks like a credential (`isSensitiveKeyName`) becomes `REDACTED`.
 * 3. Values — every string is scrubbed of known secret values: credential-named
 *    environment variables (`envSecretValues`) plus values a plugin or the
 *    caller registers with `registerRawCaptureSecrets`.
 * 4. Token / auth calls — their request and response bodies are never retained:
 *    a plugin marks the request `rawCapture: false`, and URLs that look like a
 *    token or auth endpoint are withheld by default (`rawCaptureWithholdReason`).
 *
 * `drainRawCapture` runs layers 1–3 over every entry once more before the sink
 * closes, so a field written outside these helpers is still scrubbed.
 */

const DEFAULT_MAX_BODY_BYTES = 5_242_880; // 5 MiB
const DEFAULT_MAX_SOURCE_BYTES = 20_971_520; // 20 MiB
const DEFAULT_DRAIN_MS = 2_000;

/** What a removed credential is replaced with. */
export const RAW_CAPTURE_REDACTED = 'REDACTED';

/** Shortest secret value that is scrubbed; shorter ones would mangle ordinary text. */
export const RAW_CAPTURE_MIN_SECRET_LENGTH = 8;

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
 *
 * Add a row here if another one appears.
 */
export const SENSITIVE_PATH_SEGMENTS: Record<string, number> = {
  'api.ceipal.com': 0,
  'jooble.org': 1,
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

/** Environment variable names whose values are treated as secrets. */
const ENV_SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|CLIENT_ID|APP_ID/i;

/** …unless the name says the value is a location or setting, not a credential. */
const ENV_NOT_SECRET_SUFFIX = /_(?:URL|URI|HOST|PORT|PATH|FILE|DIR|ENDPOINT)$/i;

/**
 * Values of credential-named environment variables (`*_KEY`, `*_SECRET`,
 * `*_TOKEN`, `*_PASSWORD`, `*_CLIENT_ID`, `*_APP_ID`, …) at least
 * `RAW_CAPTURE_MIN_SECRET_LENGTH` long. A comma-separated value (`API_KEYS`)
 * also contributes each item.
 */
export function envSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length >= RAW_CAPTURE_MIN_SECRET_LENGTH) values.add(trimmed);
  };
  for (const name of Object.keys(env)) {
    if (!ENV_SECRET_NAME.test(name) || ENV_NOT_SECRET_SUFFIX.test(name)) continue;
    const value = env[name];
    if (typeof value !== 'string' || value.length < RAW_CAPTURE_MIN_SECRET_LENGTH) continue;
    add(value);
    if (value.includes(',')) value.split(',').forEach(add);
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
 * One pattern matching every secret and the forms it takes once serialized:
 * percent-encoded (both hex cases), form-encoded and JSON-escaped.
 */
function buildSecretPattern(secrets: Iterable<string>): RegExp | null {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < RAW_CAPTURE_MIN_SECRET_LENGTH) continue;
    variants.add(secret);
    const encoded = encodeURIComponent(secret);
    variants.add(encoded);
    variants.add(encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    variants.add(encoded.replace(/%20/g, '+'));
    variants.add(JSON.stringify(secret).slice(1, -1));
  }
  if (variants.size === 0) return null;
  const alternatives = [...variants].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(alternatives.join('|'), 'g');
}

interface SinkSecrets {
  /** Read lazily, once per sink — a rotated env var is picked up by the next request. */
  env?: string[];
  registered: Set<string>;
  /** Compiled lazily; `undefined` = stale. */
  pattern?: RegExp | null;
  /** Bumped on every registration, so sanitized fields are re-checked. */
  version: number;
}

const sinkSecrets = new WeakMap<RawCaptureSink, SinkSecrets>();

function secretsOf(sink: RawCaptureSink): SinkSecrets {
  let secrets = sinkSecrets.get(sink);
  if (!secrets) {
    secrets = { registered: new Set(), version: 0 };
    sinkSecrets.set(sink, secrets);
  }
  return secrets;
}

interface Scrubber {
  pattern: RegExp | null;
  version: number;
}

/**
 * The secret-value scrubber for `sink`: env secrets (cached on the sink) plus
 * the values registered on it. Without a sink, env secrets are read afresh.
 */
function scrubberFor(sink: RawCaptureSink | undefined): Scrubber {
  if (!sink) return { pattern: buildSecretPattern(envSecretValues()), version: 0 };
  const secrets = secretsOf(sink);
  if (secrets.pattern === undefined) {
    secrets.env ??= envSecretValues();
    secrets.pattern = buildSecretPattern([...secrets.env, ...secrets.registered]);
  }
  return { pattern: secrets.pattern, version: secrets.version };
}

/**
 * Register credential values to scrub from every entry of `sink` (by default
 * the sink in scope; a no-op when `include_raw` is off). `values` may be a
 * string, an array, or an object whose string leaves are taken — e.g. a
 * scraper input's `auth` block. Strings shorter than
 * `RAW_CAPTURE_MIN_SECRET_LENGTH` are ignored. Plugins call this with the
 * credentials and tokens they resolve (`source-ats-personio`,
 * `source-francetravail`, `source-upwork`, `source-adzuna`, `source-jooble`).
 */
export function registerRawCaptureSecrets(
  values: unknown,
  sink: RawCaptureSink | undefined = getRawCapture(),
): void {
  if (!sink) return;
  const found = new Set<string>();
  collectStrings(values, found);
  if (found.size === 0) return;
  const secrets = secretsOf(sink);
  let added = false;
  for (const value of found) {
    if (secrets.registered.has(value)) continue;
    secrets.registered.add(value);
    added = true;
  }
  if (added) {
    secrets.pattern = undefined;
    secrets.version += 1;
  }
}

// ---------------------------------------------------------------------------
// Sanitizing values
// ---------------------------------------------------------------------------

const MAX_SANITIZE_DEPTH = 64;

interface SanitizeState {
  pattern: RegExp | null;
  changed: boolean;
  ancestors: Set<object>;
}

function scrubString(text: string, state: SanitizeState): string {
  if (!state.pattern || text.length < RAW_CAPTURE_MIN_SECRET_LENGTH) return text;
  const scrubbed = text.replace(state.pattern, RAW_CAPTURE_REDACTED);
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
    if (!state.pattern || Math.abs(value) < 10 ** (RAW_CAPTURE_MIN_SECRET_LENGTH - 1)) return value;
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
      return scrubString(redactFormPairs(value.toString()), state);
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
      if (isSensitiveKeyName(key) && carriesSecret(item)) {
        out[outKey] = RAW_CAPTURE_REDACTED;
        state.changed = true;
      } else {
        out[outKey] = sanitizeNode(item, state, depth + 1);
      }
    }
    return out;
  } finally {
    state.ancestors.delete(value);
  }
}

/**
 * `"key": "value"` / `"key": 123` pairs in JSON-ish text that does not parse
 * (truncated JSON, JSON inside HTML). A match can only start at `{` or `,`, and
 * every run but the value string is bounded, so quote-heavy input stays linear.
 */
const JSON_TEXT_PAIR =
  /([{,]\s{0,16})"((?:[^"\\\r\n]|\\.){1,128})"(\s{0,16}:\s{0,16})("(?:[^"\\\r\n]|\\.)*"|-?\d[\d.eE+-]{0,64})/g;

/** Longest text checked for being a whole form-encoded body (`a=1&b=2`). */
const MAX_FORM_TEXT = 65_536;

function looksFormEncoded(text: string): boolean {
  if (text.length === 0 || text.length > MAX_FORM_TEXT || /\s/.test(text) || !text.includes('=')) return false;
  return text.split('&').every((pair) => pair.indexOf('=') > 0);
}

/**
 * A redacted copy of a text body: JSON text that parses is redacted by key
 * (and re-serialized only when something changed); form-encoded text by key;
 * any other text has its `"secret_key": "…"` pairs redacted. Secret values are
 * then scrubbed in every case.
 */
function sanitizeText(text: string, state: SanitizeState): string {
  const first = text.trimStart()[0];
  if (first === '{' || first === '[') {
    let parsed: unknown;
    let parsedOk = false;
    try {
      parsed = JSON.parse(text);
      parsedOk = true;
    } catch {
      /* not JSON after all — fall through to the text rules */
    }
    if (parsedOk) {
      const outer = state.changed;
      state.changed = false;
      const clean = sanitizeNode(parsed, state, 0);
      if (!state.changed) {
        state.changed = outer;
        return text;
      }
      return JSON.stringify(clean);
    }
  }

  let out = text;
  if (looksFormEncoded(out)) {
    out = redactFormPairs(out);
  } else if (out.includes('"')) {
    out = out.replace(
      JSON_TEXT_PAIR,
      (match: string, lead: string, key: string, separator: string, value: string) =>
        value !== '""' && isSensitiveKeyName(key) ? `${lead}"${key}"${separator}"${RAW_CAPTURE_REDACTED}"` : match,
    );
  }
  if (out !== text) state.changed = true;
  return scrubString(out, state);
}

function newState(sink: RawCaptureSink | undefined): SanitizeState {
  return { pattern: scrubberFor(sink).pattern, changed: false, ancestors: new Set() };
}

/**
 * A caller-safe copy of a captured body (request or response): strings via
 * `sanitizeText`, structured values via a redacting deep copy. Never mutates
 * the input — the plugin still holds the original response.
 */
export function sanitizeCapturedValue(value: unknown, sink?: RawCaptureSink): unknown {
  const state = newState(sink);
  return typeof value === 'string' ? sanitizeText(value, state) : sanitizeNode(value, state, 0);
}

/** `url` as stored on an entry: `redactUrl` plus the secret-value scrub. */
export function captureUrl(url: string, sink?: RawCaptureSink): string {
  return scrubString(redactUrl(url), newState(sink));
}

/** Error text as stored on an entry: embedded URLs redacted plus the secret-value scrub. */
export function captureErrorText(text: string, sink?: RawCaptureSink): string {
  return scrubString(sanitizeErrorText(text), newState(sink));
}

/** Recursively redact sensitive keys in a JSON-parsed value (returns a copy). */
export function redactSensitiveKeys(value: unknown): unknown {
  return sanitizeNode(value, { pattern: null, changed: false, ancestors: new Set() }, 0);
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
      return looksFormEncoded(data) ? scrubString(redactFormPairs(data), state) : undefined;
    }
  }
  if (typeof data === 'object') {
    if (data instanceof URLSearchParams) return scrubString(redactFormPairs(data.toString()), state);
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
 * A Buffer is cut to the per-body cap *before* it is decoded, so a huge body
 * never becomes a huge string. A parsed JSON value is still serialized once to
 * measure it: axios already parsed it, and its size decides whether it fits.
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
    const text = buf.subarray(0, utf8SafeEnd(buf, rawCaptureMaxBodyBytes())).toString('utf8');
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
function sanitizeFields<T extends Partial<RawHttpEntry>>(sink: RawCaptureSink, fields: T): T {
  const out: Record<string, unknown> = { ...fields };
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined || META_FIELDS.has(key)) continue;
    if (key === 'url' || key === 'final_url') {
      if (typeof value === 'string') out[key] = captureUrl(value, sink);
    } else if (key === 'error') {
      out[key] = captureErrorText(typeof value === 'string' ? value : String(value), sink);
    } else if (key === 'body' || key === 'request_body') {
      out[key] = sanitizeCapturedValue(value, sink);
    } else if (typeof value === 'string') {
      out[key] = scrubString(value, newState(sink));
    } else if (typeof value === 'object') {
      out[key] = sanitizeNode(value, newState(sink), 0);
    }
  }
  return out as unknown as T;
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
  const maxBody = rawCaptureMaxBodyBytes();
  if (bytes > maxBody) {
    entry.truncated = true;
    if (typeof value === 'string') {
      const shortened = truncateUtf8(value, maxBody);
      value = shortened;
      bytes = Buffer.byteLength(shortened, 'utf8');
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
    const clean = sanitizeCapturedValue(value, sink);
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
