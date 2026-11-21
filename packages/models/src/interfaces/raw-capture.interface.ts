/**
 * Spec 5161 — raw HTTP capture for single-source debug runs.
 *
 * When `POST /api/jobs/search` is called with `include_raw=true`, every HTTP
 * attempt the selected source makes — through the shared axios client or the
 * browser pool — is recorded as a `RawHttpEntry` and returned under
 * `raw_by_source` on the response envelope.
 *
 * Entries go back to the API caller, so every field is credential-scrubbed
 * before it is stored (fork-sync hardening, see `raw-capture.ts` in
 * `@ever-jobs/common`): URLs lose userinfo, credential query values and path
 * credentials; bodies lose the values of credential-looking keys; every string
 * is scrubbed of the server's configured secret values; and the bodies of
 * token / auth requests are never retained (`bodies_withheld`).
 */

/**
 * Why an entry carries no `request_body` / `body`:
 * - `opt_out` — the plugin marked the request `rawCapture: false` (token calls);
 * - `auth_endpoint` — the URL looks like a token / auth endpoint (path heuristic).
 */
export type RawCaptureWithheldReason = 'opt_out' | 'auth_endpoint';

export interface RawHttpEntry {
  /** Per-sink sequence number, assigned when the attempt starts. */
  seq: number;
  /** Retry index (0-based). Always 0 for browser traffic — Playwright does not retry. */
  attempt: number;
  method: string;
  /**
   * Credential-redacted request URL (first hop for redirect chains): no
   * userinfo, credential query values and known path credentials replaced
   * with `REDACTED`, configured secret values scrubbed.
   */
  url: string;
  /** Last hop of a redirect chain; set only when it differs from `url`. Redacted like `url`. */
  final_url?: string;
  /** HTTP status, or null when the request failed before a response. */
  status: number | null;
  error?: string;
  elapsed_ms: number;
  content_type?: string;
  /**
   * JSON request bodies (and form-encoded ones, as a string), sensitive keys
   * recursively redacted. Never set when `bodies_withheld` is.
   */
  request_body?: unknown;
  /**
   * Parsed JSON or text body, sensitive keys redacted; omitted for
   * binary/stream payloads, on truncation, and whenever `bodies_withheld` is set.
   */
  body?: unknown;
  /** Original serialized body size in UTF-8 bytes, even when `body` is omitted. */
  body_bytes: number;
  truncated: boolean;
  /** Set when request and response bodies were deliberately not retained. */
  bodies_withheld?: RawCaptureWithheldReason;
}

export interface RawCaptureSink {
  entries: RawHttpEntry[];
  /** Bytes retained across `entries` so far; capped by RAW_CAPTURE_MAX_SOURCE_BYTES. */
  retained_bytes: number;
  /** In-flight body reads (browser responses); drained before the sink is closed. */
  pending: Promise<void>[];
  /** Set once the response has shipped — late writes are dropped. */
  closed: boolean;
}
