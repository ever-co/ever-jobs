import type { RawHttpEntry } from '@ever-jobs/models';

/**
 * Credential scrub for `include_raw` entries (Spec 5161), applied by the API
 * where `raw_by_source` is assembled, just before it leaves the server
 * (fork-sync hardening).
 *
 * The capture layer redacts for log lines: an anchored list of query keys and
 * one keyed-path host. Entries returned to a caller need more, because they
 * carry what the server sent with ITS credentials:
 *
 *  - `url` / `final_url`: Jooble and CareerOneStop put the key in the path,
 *    Adzuna sends `app_id` / `app_key` as query params (`final_url` holds the
 *    serialized params);
 *  - `request_body`: Personio posts `{ client_id, client_secret }`;
 *  - `body`: token endpoints answer with `access_token`, `refresh_token` or
 *    `data.token`, and error bodies can echo the submitted secret.
 *
 * Three independent layers, so a miss in one is caught by another:
 *
 *  1. by value: every credential-looking env var the plugins read (and every
 *     credential in the request's own `auth` block) is replaced wherever it
 *     appears, in any field, plain or URL-encoded;
 *  2. by field name: JSON keys, query and form params whose name contains
 *     token / secret / password / api key / ... (substring match after
 *     dropping `_` and `-`, so `client_secret`, `app_key`, `refresh_token`
 *     and `clientSecret` all count);
 *  3. by URL shape: userinfo, and the path segment of hosts known to carry a
 *     key in the path.
 *
 * Over-redaction is the safe failure for a debugging aid; the scrub never
 * removes structure (keys, array lengths, status, sizes stay).
 */

/** What a redacted value is replaced with (same marker as the capture layer). */
export const RAW_REDACTED = 'REDACTED';

type Env = Readonly<Record<string, string | undefined>>;

/** Shorter values are too likely to be ordinary words or flags. */
const MIN_SECRET_LENGTH = 6;

/** Setting values that are never credentials, whatever the variable is called. */
const NON_SECRET_VALUES = /^(?:true|false|yes|no|on|off|null|undefined|none|enabled|disabled)$/i;

/** Env-name segments (split on `_`, `-`, `.`, ...) that mark a credential. */
const SECRET_NAME_SEGMENTS = new Set([
  'KEY', 'KEYS', 'APIKEY', 'APIKEYS', 'APPKEY', 'SECRET', 'SECRETS', 'TOKEN', 'TOKENS',
  'PASSWORD', 'PASSWORDS', 'PASSWD', 'PASS', 'PWD', 'PASSPHRASE', 'CREDENTIAL', 'CREDENTIALS',
  'COOKIE', 'COOKIES', 'BEARER', 'SIGNATURE', 'AFFID',
]);

/** Env-name segments that contain one of these are credentials too (`AUTHTOKEN`). */
const SECRET_NAME_PARTS = ['TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'APIKEY', 'APPKEY', 'CREDENTIAL'];

/**
 * `<X>_ID` names that are account identifiers used as credentials (Adzuna
 * `ADZUNA_APP_ID`, `CAREERONESTOP_USER_ID`, `TALROO_PUBLISHER_ID`, OAuth
 * client ids).
 */
const SECRET_ID_PREFIXES = new Set([
  'APP', 'CLIENT', 'USER', 'PUBLISHER', 'ACCOUNT', 'PARTNER', 'AFFILIATE', 'CONSUMER',
  'DEVELOPER', 'CUSTOMER', 'SESSION',
]);

/** A last segment that names a setting ABOUT a credential (`API_KEY_HEADER_NAME`). */
const NON_SECRET_LAST_SEGMENTS = new Set([
  'NAME', 'HEADER', 'URL', 'URI', 'ENDPOINT', 'HOST', 'PORT', 'PATH', 'FILE', 'DIR', 'MODE',
  'TYPE', 'STYLE', 'STRATEGY', 'ENABLED', 'TTL', 'MS', 'SECONDS', 'LENGTH', 'COUNT', 'LIMIT',
  'MAX', 'MIN', 'TIMEOUT',
]);

/** Field names (lower-cased, separators dropped) that are credentials outright. */
const SENSITIVE_FIELD_EXACT = new Set([
  'key', 'auth', 'sig', 'pwd', 'pass', 'session', 'appid', 'clientid', 'affid', 'publisherid',
]);

/** Field names that contain one of these are credentials. */
const SENSITIVE_FIELD_PARTS = [
  'token', 'secret', 'passw', 'passphrase', 'apikey', 'appkey', 'accesskey', 'privatekey',
  'signingkey', 'secretkey', 'clientkey', 'credential', 'signature', 'cookie', 'authorization',
  'bearer', 'sessionid',
];

/**
 * Hosts that carry a credential in the URL path, mapped to the zero-based
 * index of that segment. Mirrors the capture layer's list and adds the keyed
 * sources it lacks.
 */
const PATH_CREDENTIAL_SEGMENTS: Readonly<Record<string, number>> = {
  'api.ceipal.com': 0, // /{apiKey}/job-postings/
  'jooble.org': 1, // /api/{apiKey}
  'api.careeronestop.org': 2, // /v2/jobsearch/{userId}/...
};

/** Form-encoded payloads larger than this are left to the value scrub. */
const MAX_FORM_SCAN_CHARS = 65_536;

/** Upper bound on `auth` nodes visited when collecting the caller's credentials. */
const MAX_AUTH_NODES = 1_000;

/** Is this env var a credential, judged by its name alone? */
export function isSecretEnvName(name: string): boolean {
  const segments = name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (segments.length === 0) return false;
  if (NON_SECRET_LAST_SEGMENTS.has(segments[segments.length - 1])) return false;
  return segments.some(
    (segment, index) =>
      SECRET_NAME_SEGMENTS.has(segment) ||
      SECRET_NAME_PARTS.some((part) => segment.includes(part)) ||
      (segment === 'ID' && index > 0 && SECRET_ID_PREFIXES.has(segments[index - 1])),
  );
}

/** Is a JSON key, query or form param with this name a credential? */
export function isSensitiveFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === '') return false;
  if (SENSITIVE_FIELD_EXACT.has(normalized)) return true;
  if (normalized.endsWith('pass') || normalized.endsWith('pwd')) return true;
  return SENSITIVE_FIELD_PARTS.some((part) => normalized.includes(part));
}

function acceptSecret(value: string): boolean {
  return value.length >= MIN_SECRET_LENGTH && !NON_SECRET_VALUES.test(value);
}

function addSecret(out: Set<string>, raw: string): void {
  const candidates = [raw.trim()];
  // A list-valued variable (`API_KEYS=a,b`) also contributes each entry.
  if (raw.includes(',')) candidates.push(...raw.split(',').map((part) => part.trim()));
  for (const candidate of candidates) {
    if (!acceptSecret(candidate)) continue;
    out.add(candidate);
    // The same value as it appears in a query string or form body.
    const encoded = encodeURIComponent(candidate);
    if (encoded !== candidate) out.add(encoded);
    const formEncoded = encoded.replace(/%20/g, '+');
    if (formEncoded !== encoded) out.add(formEncoded);
  }
}

/**
 * The credential values to scrub from one request's raw entries: every
 * credential-named env var (plugins read their keys from the environment),
 * plus every credential-named string in the request's own `auth` block.
 * Longest first, so a secret that contains another is replaced whole.
 */
export function collectRawCaptureSecrets(env: Env, auth?: unknown): string[] {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && isSecretEnvName(name)) addSecret(secrets, value);
  }

  const stack: unknown[] = [auth];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_AUTH_NODES) {
    const node = stack.pop();
    visited++;
    if (node === null || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string') {
        if (isSensitiveFieldName(key)) addSecret(secrets, value);
      } else if (value !== null && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return [...secrets].sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of every secret in `text`. */
function scrubSecretValues(text: string, secrets: readonly string[]): string {
  if (text.length < MIN_SECRET_LENGTH) return text;
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(RAW_REDACTED);
  }
  return out;
}

function decodeParamName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, ' '));
  } catch {
    return name;
  }
}

/** Redact the values of credential-named params in `a=1&b=2` (query, fragment or form). */
function redactParamString(params: string): string {
  return params
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq <= 0 || eq === pair.length - 1) return pair;
      const name = pair.slice(0, eq);
      return isSensitiveFieldName(decodeParamName(name)) ? `${name}=${RAW_REDACTED}` : pair;
    })
    .join('&');
}

/** Scheme + authority of an absolute URL. Anchored, linear. */
const URL_AUTHORITY = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i;

/** Userinfo out, keyed path segment out (see {@link PATH_CREDENTIAL_SEGMENTS}). */
function redactAuthorityAndPath(url: string): string {
  const match = URL_AUTHORITY.exec(url);
  if (!match) return url;
  const [whole, scheme, authority] = match;
  const at = authority.lastIndexOf('@');
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  const newAuthority = at === -1 ? authority : `${RAW_REDACTED}@${hostPort}`;

  const host = hostPort.replace(/:\d*$/, '').toLowerCase().replace(/^www\./, '');
  const rest = url.slice(whole.length);
  const index = PATH_CREDENTIAL_SEGMENTS[host];
  if (index === undefined) return scheme + newAuthority + rest;

  const pathEnd = rest.search(/[?#]/);
  const path = pathEnd === -1 ? rest : rest.slice(0, pathEnd);
  const tail = pathEnd === -1 ? '' : rest.slice(pathEnd);
  // A path that starts with `/` splits to a leading empty segment.
  const segments = path.split('/');
  const target = index + 1;
  if (target < segments.length && segments[target] !== '') segments[target] = RAW_REDACTED;
  return scheme + newAuthority + segments.join('/') + tail;
}

/**
 * A URL with credentials removed: userinfo, the keyed path segment of known
 * hosts, credential-named query and fragment params, and any known secret
 * value anywhere. Splits on delimiters rather than parsing, so a relative or
 * malformed URL still gets the value scrub instead of throwing.
 */
export function redactRawUrl(url: string, secrets: readonly string[]): string {
  let out = redactAuthorityAndPath(url);
  const hash = out.indexOf('#');
  let main = hash === -1 ? out : out.slice(0, hash);
  let fragment = hash === -1 ? undefined : out.slice(hash + 1);
  const query = main.indexOf('?');
  if (query !== -1) main = main.slice(0, query + 1) + redactParamString(main.slice(query + 1));
  // `#access_token=...` (OAuth implicit-flow style) carries params too.
  if (fragment !== undefined && fragment.includes('=')) fragment = redactParamString(fragment);
  out = fragment === undefined ? main : `${main}#${fragment}`;
  return scrubSecretValues(out, secrets);
}

/** Absolute URLs inside free text (error messages). Linear: one greedy class. */
const EMBEDDED_URL = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** Free text (an error message): embedded URLs redacted, then the value scrub. */
export function redactRawText(text: string, secrets: readonly string[]): string {
  const withUrls = text.replace(EMBEDDED_URL, (url) => redactRawUrl(url, secrets));
  return scrubSecretValues(withUrls, secrets);
}

/** Own enumerable property, even for `__proto__` (no prototype change). */
function setField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * A redacted deep copy of a JSON-like value. Iterative, so a deeply nested
 * body cannot overflow the stack; a repeated or cyclic reference becomes
 * `[Circular]` instead of looping.
 */
export function redactRawJson(root: unknown, secrets: readonly string[]): unknown {
  const secretSet = new Set(secrets);
  const seen = new Set<object>();
  let result: unknown;
  const stack: Array<{ value: unknown; assign: (v: unknown) => void }> = [
    { value: root, assign: (v) => { result = v; } },
  ];

  while (stack.length > 0) {
    const { value, assign } = stack.pop() as (typeof stack)[number];
    if (typeof value === 'string') {
      assign(scrubSecretValues(value, secrets));
    } else if (typeof value === 'number' || typeof value === 'bigint') {
      assign(secretSet.has(String(value)) ? RAW_REDACTED : value);
    } else if (value !== null && typeof value === 'object') {
      if (seen.has(value)) {
        assign('[Circular]');
        continue;
      }
      seen.add(value);
      if (Array.isArray(value)) {
        const copy: unknown[] = new Array(value.length);
        assign(copy);
        for (let i = 0; i < value.length; i++) {
          stack.push({ value: value[i], assign: (v) => { copy[i] = v; } });
        }
      } else {
        const copy: Record<string, unknown> = {};
        assign(copy);
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          const safeKey = scrubSecretValues(key, secrets);
          // Defined now, in source order; a deferred child fills its value
          // later without moving the key.
          setField(copy, safeKey, undefined);
          // null and booleans carry no credential and help debugging.
          if (isSensitiveFieldName(key) && child !== null && typeof child !== 'boolean') {
            setField(copy, safeKey, RAW_REDACTED);
          } else {
            stack.push({ value: child, assign: (v) => setField(copy, safeKey, v) });
          }
        }
      }
    } else {
      assign(value);
    }
  }
  return result;
}

/**
 * A redacted `body` / `request_body`. Parsed JSON is walked. Text is parsed
 * when it looks like JSON (a token endpoint served as text/plain), treated
 * as form params when it looks form-encoded, and value-scrubbed either way.
 */
export function redactRawPayload(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value !== 'string') return redactRawJson(value, secrets);

  const first = value.trimStart().charAt(0);
  if (first === '{' || first === '[') {
    try {
      return JSON.stringify(redactRawJson(JSON.parse(value), secrets));
    } catch {
      // Not JSON after all (or too deep to re-serialize): value scrub below.
    }
  }
  let text = value;
  if (text.length <= MAX_FORM_SCAN_CHARS && text.includes('=') && !/\s/.test(text)) {
    text = redactParamString(text);
  }
  return scrubSecretValues(text, secrets);
}

/**
 * One raw entry with credentials removed from every field: URLs through
 * {@link redactRawUrl}, bodies through {@link redactRawPayload}, any other
 * text through {@link redactRawText}. Returns a copy; the input is untouched.
 * A field added to `RawHttpEntry` later is scrubbed too (strings and objects).
 */
export function redactRawEntry<T extends RawHttpEntry>(entry: T, secrets: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(entry)) {
    let redacted: unknown = value;
    if ((field === 'url' || field === 'final_url') && typeof value === 'string') {
      redacted = redactRawUrl(value, secrets);
    } else if (field === 'body' || field === 'request_body') {
      redacted = redactRawPayload(value, secrets);
    } else if (typeof value === 'string') {
      redacted = redactRawText(value, secrets);
    } else if (value !== null && typeof value === 'object') {
      redacted = redactRawJson(value, secrets);
    }
    setField(out, field, redacted);
  }
  return out as T;
}
