import type { RawHttpEntry } from '@ever-jobs/models';
import {
  createRawCaptureScrubber,
  rawCaptureAuthSecrets,
  scrubRawEntry,
  type RawCaptureScrubber,
} from '@ever-jobs/common';

/**
 * Credential scrub for `include_raw` entries (Spec 5161), applied by the API
 * where `raw_by_source` is assembled, just before it leaves the server
 * (fork-sync hardening; reduced to a thin pass in round 3).
 *
 * The capture layer (`@ever-jobs/common`, `http/raw-capture.ts`) already
 * removes credentials from every entry when it is captured and again when its
 * sink is drained, in three layers:
 *
 *  1. structure: userinfo, credential-named query and fragment params, and the
 *     key carried in the URL path by Jooble, Ceipal and CareerOneStop;
 *  2. key names: JSON fields, form pairs, JS literals, XML elements, CDATA
 *     and attributes whose name looks like a credential;
 *  3. values: every credential-named env var (`isSecretEnvName`: `*_API_KEY`,
 *     `*_SECRET`, `*_TOKEN`, `*_PASS`, `*_APP_ID`, `*_USER_ID`,
 *     `*_PUBLISHER_ID`, `*_AFFID`, ...) and every token a plugin registered,
 *     in two tiers: server-held values first, caller-chosen values second.
 *
 * This module runs those same rules once more over the drained entries
 * (`scrubRawEntry`), adding every credential in the request's own `auth`
 * block (`rawCaptureAuthSecrets`), whether or not the source that ran
 * registered it. The `auth` values go in the caller tier, after the env
 * values, with overlapping occurrences merged, so a value the caller chose can
 * never hide, or expose, part of a server credential. A JSON text body is
 * rewritten only when something in it was redacted, so an entry with nothing
 * to remove keeps its body exactly as received.
 *
 * Over-redaction is the safe failure for a debugging aid; the scrub never
 * removes structure (keys, array lengths, status, sizes stay).
 */

/**
 * The value scrub for one request's raw entries: the credential-named values
 * of `env` (server tier) and the credentials in the request's `auth` block
 * (caller tier).
 */
export function collectRawCaptureSecrets(env: NodeJS.ProcessEnv, auth?: unknown): RawCaptureScrubber {
  return createRawCaptureScrubber({ env, caller: rawCaptureAuthSecrets(auth) });
}

/**
 * One raw entry with credentials removed from every field, by the capture
 * layer's rules under `scrubber` (see the module comment). Returns a copy;
 * the input is untouched.
 */
export function redactRawEntry<T extends RawHttpEntry>(entry: T, scrubber: RawCaptureScrubber): T {
  return scrubRawEntry(entry, scrubber);
}
