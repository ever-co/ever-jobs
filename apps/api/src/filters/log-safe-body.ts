import { redactCredentials } from '../utils/redact-credentials';

/**
 * Log-safe request bodies (T-2520).
 *
 * The global exception filter logs the body of a request that failed
 * validation, to help debugging. A search body can carry per-request source
 * credentials (`auth`, see `ScraperInputDto.auth`) and proxy URLs with
 * `user:password@` (`proxies`), and logs are shipped elsewhere, so only a
 * redacted, size-capped copy may be logged:
 *
 * - every value under an `auth` key (at any depth) is replaced with `[REDACTED]`
 *   (the keys stay, so the log still shows which source sent credentials);
 * - every value under a key that looks secret (`apiKey`, `clientSecret`,
 *   `accessToken`, `password`, …) at any depth is replaced the same way;
 * - every other string goes through `redactCredentials`, which hides
 *   `user:password@` (proxy URLs in `proxies`, or anywhere else);
 * - the serialised result is capped at `LOG_SAFE_BODY_MAX_CHARS`.
 *
 * Nothing here throws: odd input (a string, a number, `undefined`, a circular
 * or very deep object, binary data) still gives a loggable string.
 */

/** What a redacted value is logged as. */
export const REDACTED = '[REDACTED]';

/** Longest serialised body that is logged, in characters (about 2 KB). */
export const LOG_SAFE_BODY_MAX_CHARS = 2048;

/** Nesting levels copied; anything deeper is logged as `[Truncated]`. */
const MAX_DEPTH = 8;

/** Values copied in total, which bounds the work on a huge body; the rest is logged as `[Truncated]`. */
const MAX_NODES = 1000;

const TRUNCATED = '[Truncated]';

/** A key whose whole value is a bag of credentials. */
const CREDENTIAL_BAG_KEY = /^auth$/i;

/** A key that looks secret, matched anywhere in the key name, ignoring case. */
const SECRET_KEY =
  /api[-_]?key|app[-_]?key|secret|token|passw(?:or)?d|passphrase|pwd|authori[sz]ation|cookie|credential|private[-_]?key|signature|session/i;

interface CopyState {
  nodes: number;
  /** Objects on the current path, to spot a cycle. */
  ancestors: Set<object>;
}

function isSecretKey(key: string): boolean {
  return CREDENTIAL_BAG_KEY.test(key) || SECRET_KEY.test(key);
}

/**
 * A deep copy of `body` that is safe to log (see the file comment). Never throws.
 */
export function toLogSafeBody(body: unknown): unknown {
  try {
    return copyForLog(body, 0, false, { nodes: 0, ancestors: new Set<object>() });
  } catch {
    return '[Unserializable body]';
  }
}

/**
 * `JSON.stringify` of `toLogSafeBody(body)`, cut to `maxChars` characters.
 * Redaction happens before the cut, so a cut never exposes part of a secret.
 * Never throws.
 */
export function serializeBodyForLog(
  body: unknown,
  maxChars: number = LOG_SAFE_BODY_MAX_CHARS,
): string {
  let text: string;
  try {
    const safe = toLogSafeBody(body);
    text = JSON.stringify(safe) ?? String(safe);
  } catch {
    text = '"[Unserializable body]"';
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [truncated, ${text.length} chars in all]`;
}

function copyForLog(value: unknown, depth: number, redact: boolean, state: CopyState): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) return TRUNCATED;

  if (value === null || value === undefined) return redact ? REDACTED : value;
  switch (typeof value) {
    case 'string':
      return redact ? REDACTED : redactCredentials(value);
    case 'number':
    case 'boolean':
      return redact ? REDACTED : value;
    case 'bigint':
      return redact ? REDACTED : `${value.toString()}n`;
    case 'symbol':
    case 'function':
      return redact ? REDACTED : `[${typeof value}]`;
    default:
      break;
  }

  const obj = value as object;
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
    return redact ? REDACTED : `[Binary ${obj.byteLength} bytes]`;
  }
  if (obj instanceof Date) {
    if (redact) return REDACTED;
    return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
  }
  if (state.ancestors.has(obj)) return '[Circular]';
  if (depth >= MAX_DEPTH) return TRUNCATED;

  state.ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const out: unknown[] = [];
      for (let i = 0; i < obj.length; i++) {
        if (state.nodes >= MAX_NODES) {
          out.push(`${TRUNCATED} ${obj.length - i} more`);
          break;
        }
        out.push(copyForLog(obj[i], depth + 1, redact, state));
      }
      return out;
    }

    // A null prototype, so a `__proto__` key in the body is copied as data.
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(obj)) {
      if (state.nodes >= MAX_NODES) {
        out['…'] = TRUNCATED;
        break;
      }
      const child = (obj as Record<string, unknown>)[key];
      out[key] = copyForLog(child, depth + 1, redact || isSecretKey(key), state);
    }
    return out;
  } finally {
    state.ancestors.delete(obj);
  }
}
