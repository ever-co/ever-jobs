import { Logger } from '@nestjs/common';

/**
 * Pure resolvers for the per-request `?deadline_ms` override (Spec 5164),
 * hardened during the MakeDeeply fork sync.
 *
 * The override exists so a caller debugging ONE slow source can give it a
 * different budget. Before the hardening, an unset ceiling meant "uncapped":
 * any anonymous caller could pass `deadline_ms=0` (or a blank value, which
 * `Number('')` reads as `0`) and turn the fan-out deadline off, so a source
 * pointed at a slow server kept its handler, socket and scrape alive forever.
 *
 * The rules now:
 *  - `EVER_JOBS_SEARCH_DEADLINE_MAX_MS` unset or blank → the ceiling is the
 *    operator's own fan-out deadline (`search.deadlineMs`): callers can only
 *    SHORTEN it.
 *  - A positive value → that ceiling (an operator may let callers extend the
 *    deadline up to it).
 *  - `0`, negative or non-numeric → a configuration error: logged, and the
 *    ceiling falls back to the fan-out deadline (fail closed, never open).
 *  - `deadline_ms=0` (no deadline for this call), and any value above the
 *    ceiling, are honoured only with `EVER_JOBS_SEARCH_DEADLINE_ALLOW_UNBOUNDED=true`.
 *    Without it they are capped at the ceiling.
 *  - Whatever the settings, a value is never above {@link MAX_TIMER_DELAY_MS}:
 *    `setTimeout` fires after 1 ms for anything larger.
 *
 * When the operator runs with no fan-out deadline at all (`search.deadlineMs`
 * ≤ 0) and sets no maximum, there is no ceiling: every caller value is a
 * shortening of "unbounded", and `0` is what every request already gets.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Operator ceiling for a caller's `deadline_ms` (ms). */
export const SEARCH_DEADLINE_MAX_ENV_VAR = 'EVER_JOBS_SEARCH_DEADLINE_MAX_MS';

/** Operator opt-in that lets callers disable or exceed the fan-out deadline. */
export const SEARCH_DEADLINE_ALLOW_UNBOUNDED_ENV_VAR =
  'EVER_JOBS_SEARCH_DEADLINE_ALLOW_UNBOUNDED';

/** Largest delay `setTimeout` honours (2^31 − 1 ms, about 24.8 days). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

const logger = new Logger('SearchDeadlineConfig');

/** What the controller needs to clamp one caller value. */
export interface DeadlineOverridePolicy {
  /** Ceiling for a caller's value, ms; `0` = no ceiling (the fan-out deadline is off). */
  readonly maxMs: number;
  /** `true` = callers may pass `0` (no deadline) or any value up to {@link MAX_TIMER_DELAY_MS}. */
  readonly allowUnbounded: boolean;
}

/**
 * The ceiling used when the operator sets none: the fan-out deadline itself,
 * or `0` (no ceiling) when the operator runs without one (`≤ 0`). A positive
 * deadline below 1 ms is still a deadline the service enforces, so it caps at
 * 1 ms rather than reading as "no ceiling".
 */
export function defaultDeadlineCap(fanoutDeadlineMs: unknown): number {
  if (typeof fanoutDeadlineMs !== 'number' || !Number.isFinite(fanoutDeadlineMs)) {
    return 0;
  }
  if (fanoutDeadlineMs <= 0) return 0;
  return Math.max(1, Math.min(Math.floor(fanoutDeadlineMs), MAX_TIMER_DELAY_MS));
}

/**
 * Resolve `EVER_JOBS_SEARCH_DEADLINE_MAX_MS` against the resolved fan-out
 * deadline. See the module comment for the rules. `warn` is injectable for
 * tests; by default the warning goes to the Nest logger.
 */
export function resolveSearchDeadlineMaxMs(
  env: Env,
  fanoutDeadlineMs: number,
  warn: (message: string) => void = (message) => logger.warn(message),
): number {
  const fallback = defaultDeadlineCap(fanoutDeadlineMs);
  const raw = env[SEARCH_DEADLINE_MAX_ENV_VAR];
  if (raw === undefined || raw.trim() === '') return fallback;

  const n = Number(raw.trim());
  if (Number.isFinite(n) && n >= 1) {
    return Math.min(Math.floor(n), MAX_TIMER_DELAY_MS);
  }

  const fallbackText =
    fallback > 0
      ? `the fan-out deadline (${fallback}ms), so callers can only shorten it`
      : 'no ceiling, because the fan-out deadline itself is off';
  const zeroHint =
    n === 0
      ? ` 0 no longer lifts the ceiling: set ${SEARCH_DEADLINE_ALLOW_UNBOUNDED_ENV_VAR}=true to let callers pass deadline_ms=0.`
      : '';
  warn(
    `${SEARCH_DEADLINE_MAX_ENV_VAR}=${JSON.stringify(raw)} is not a positive number of milliseconds; ` +
      `using ${fallbackText}.${zeroHint}`,
  );
  return fallback;
}

/** `EVER_JOBS_SEARCH_DEADLINE_ALLOW_UNBOUNDED`: `true`/`1`/`yes`/`on`, default off. */
export function resolveDeadlineAllowUnbounded(env: Env): boolean {
  const raw = env[SEARCH_DEADLINE_ALLOW_UNBOUNDED_ENV_VAR];
  if (raw === undefined) return false;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Re-validate the ceiling read back from `ConfigService` at request time.
 * Anything that is not a positive finite number (a missing key, a test double,
 * a hand-edited config) falls back to {@link defaultDeadlineCap}: fail closed.
 */
export function sanitizeDeadlineCap(configured: unknown, fanoutDeadlineMs: unknown): number {
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1) {
    return Math.min(Math.floor(configured), MAX_TIMER_DELAY_MS);
  }
  return defaultDeadlineCap(fanoutDeadlineMs);
}

/**
 * The deadline one request actually gets for a validated, non-negative
 * integer `requested` (`0` = "no deadline").
 */
export function clampRequestedDeadline(
  requested: number,
  policy: DeadlineOverridePolicy,
): number {
  if (policy.allowUnbounded || policy.maxMs <= 0) {
    // Opted in, or the operator runs without a fan-out deadline: `0` stays
    // "none" and positive values are only kept within what a timer can hold.
    return Math.min(requested, MAX_TIMER_DELAY_MS);
  }
  // `0` asks for an infinite deadline, i.e. more than any ceiling.
  if (requested === 0) return policy.maxMs;
  return Math.min(requested, policy.maxMs);
}
