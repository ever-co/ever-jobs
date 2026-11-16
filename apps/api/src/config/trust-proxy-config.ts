/**
 * Pure env resolver for Express's `trust proxy` setting (T-2521).
 *
 * Kept out of `configuration.ts` (like `shutdown-config.ts`) so it can be
 * unit-tested with a synthetic env map.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Which proxies Express trusts to set `X-Forwarded-For` (and so `req.ip`). */
export const TRUST_PROXY_ENV_VAR = 'TRUST_PROXY';

/**
 * A value Express accepts for `app.set('trust proxy', value)`: `true` (trust
 * every hop; any client can then spoof `X-Forwarded-For`), `false`, a hop
 * count, or a list of addresses, CIDRs and range names (`loopback`,
 * `linklocal`, `uniquelocal`).
 */
export type TrustProxySetting = boolean | number | string[];

/**
 * Resolve `TRUST_PROXY`.
 *
 * - Unset or blank: `undefined`. `main.ts` then leaves Express alone, so
 *   `X-Forwarded-For` is ignored and `req.ip` is the socket peer (the
 *   behaviour before T-2521).
 * - `true` / `false` (any case): that boolean.
 * - A whole number: the number of proxy hops to trust.
 * - Anything else: a comma-separated list of addresses, CIDRs or range names,
 *   trimmed, empty entries dropped (no entries left: `undefined`). Express
 *   validates the list when `main.ts` applies it, so an invalid address stops
 *   the API at startup.
 */
export function resolveTrustProxy(env: Env): TrustProxySetting | undefined {
  const raw = env[TRUST_PROXY_ENV_VAR]?.trim();
  if (!raw) return undefined;

  const lowered = raw.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);

  const list = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}
