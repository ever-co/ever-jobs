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

export interface IncludeRawConfig {
  readonly enabled: boolean;
  readonly maxConcurrent: number;
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
  return { enabled, maxConcurrent };
}

/**
 * The concurrency limit read back from `ConfigService` at request time;
 * anything invalid (a missing key, a test double) falls back to the default.
 */
export function includeRawMaxConcurrent(configured: unknown): number {
  return toConcurrencyLimit(configured) ?? DEFAULT_INCLUDE_RAW_MAX_CONCURRENT;
}
