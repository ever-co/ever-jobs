import { Logger } from '@nestjs/common';

/**
 * Pure env resolvers for `POST /api/jobs/search?include_raw=true`
 * (Spec 5161), added during the MakeDeeply fork-sync hardening. The access
 * check itself lives in `auth/include-raw-access.ts`.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Operator opt-in for `include_raw`. Off unless set to true/1/yes/on. */
export const INCLUDE_RAW_ENABLED_ENV_VAR = 'EVER_JOBS_INCLUDE_RAW_ENABLED';

/** How many `include_raw` searches may scrape at once in this process. */
export const INCLUDE_RAW_MAX_CONCURRENT_ENV_VAR = 'EVER_JOBS_INCLUDE_RAW_MAX_CONCURRENT';

/**
 * Each capture can retain up to 20 MiB of upstream bodies and always runs a
 * fresh scrape (it skips the cache read), so only a couple run at once.
 */
export const DEFAULT_INCLUDE_RAW_MAX_CONCURRENT = 2;

/** Upper bound for {@link INCLUDE_RAW_MAX_CONCURRENT_ENV_VAR}. */
export const MAX_INCLUDE_RAW_MAX_CONCURRENT = 64;

/**
 * The API keys that may use `include_raw`: a comma-separated list, each key
 * also listed in `API_KEYS` (the global guard checks that list first). Empty
 * or unset means no key may use it (503), so turning the switch on never
 * opens raw capture to every key holder.
 */
export const INCLUDE_RAW_API_KEYS_ENV_VAR = 'EVER_JOBS_INCLUDE_RAW_API_KEYS';

export interface IncludeRawConfig {
  readonly enabled: boolean;
  readonly maxConcurrent: number;
  /** Keys allowed to use `include_raw` ({@link INCLUDE_RAW_API_KEYS_ENV_VAR}). */
  readonly apiKeys: readonly string[];
}

const logger = new Logger('IncludeRawConfig');

/**
 * Normalise a concurrency limit: an integer in
 * `[1, MAX_INCLUDE_RAW_MAX_CONCURRENT]`, else `undefined`.
 */
function toConcurrencyLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined;
  return Math.min(value, MAX_INCLUDE_RAW_MAX_CONCURRENT);
}

/** Resolve the `rawCapture` config block from the environment. */
export function resolveIncludeRawConfig(
  env: Env,
  warn: (message: string) => void = (message) => logger.warn(message),
): IncludeRawConfig {
  const enabledRaw = env[INCLUDE_RAW_ENABLED_ENV_VAR];
  const enabled =
    enabledRaw !== undefined &&
    ['true', '1', 'yes', 'on'].includes(enabledRaw.trim().toLowerCase());

  const maxRaw = env[INCLUDE_RAW_MAX_CONCURRENT_ENV_VAR];
  let maxConcurrent = DEFAULT_INCLUDE_RAW_MAX_CONCURRENT;
  if (maxRaw !== undefined && maxRaw.trim() !== '') {
    const parsed = toConcurrencyLimit(Number(maxRaw.trim()));
    if (parsed === undefined) {
      warn(
        `${INCLUDE_RAW_MAX_CONCURRENT_ENV_VAR}=${JSON.stringify(maxRaw)} is not a positive integer; ` +
          `using ${DEFAULT_INCLUDE_RAW_MAX_CONCURRENT}.`,
      );
    } else {
      maxConcurrent = parsed;
    }
  }

  // Never log a key: only counts and variable names reach the log.
  const apiKeys = parseKeyList(env[INCLUDE_RAW_API_KEYS_ENV_VAR]);
  if (enabled && apiKeys.length === 0) {
    warn(
      `${INCLUDE_RAW_ENABLED_ENV_VAR} is on but ${INCLUDE_RAW_API_KEYS_ENV_VAR} is empty; ` +
        'every include_raw request gets 503 until it names the keys that may use it.',
    );
  }
  const allKeys = new Set(parseKeyList(env.API_KEYS));
  const unknown = apiKeys.filter((key) => !allKeys.has(key)).length;
  if (unknown > 0) {
    warn(
      `${unknown} key(s) in ${INCLUDE_RAW_API_KEYS_ENV_VAR} are not in API_KEYS; ` +
        'those keys can never use include_raw.',
    );
  }
  return { enabled, maxConcurrent, apiKeys };
}

/** A comma-separated key list, trimmed, blanks and repeats dropped (as `API_KEYS`). */
function parseKeyList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return [...new Set(raw.split(',').map((key) => key.trim()).filter(Boolean))];
}

/**
 * The `include_raw` key list read back from `ConfigService` at request time.
 * Anything that is not a list of non-empty strings (a missing key, a test
 * double) counts as empty, which refuses every request.
 */
export function includeRawApiKeys(configured: unknown): readonly string[] {
  if (!Array.isArray(configured)) return [];
  return configured.filter((key): key is string => typeof key === 'string' && key !== '');
}

/**
 * The concurrency limit read back from `ConfigService` at request time;
 * anything invalid (a missing key, a test double) falls back to the default.
 */
export function includeRawMaxConcurrent(configured: unknown): number {
  return toConcurrencyLimit(configured) ?? DEFAULT_INCLUDE_RAW_MAX_CONCURRENT;
}
