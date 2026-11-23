/**
 * Pure env resolver for `ENABLE_GRAPHQL` (T-2673).
 *
 * Kept out of `configuration.ts` (like `trust-proxy-config.ts`) so it can be
 * unit-tested with a synthetic env map, and so `AppModule` decides whether to
 * import `GraphQLModule` with the same parse that `graphql.enabled` (logged by
 * `main.ts`) uses.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Turns the GraphQL API at `/graphql` (or `GRAPHQL_PATH`) on or off. */
export const GRAPHQL_ENABLED_ENV_VAR = 'ENABLE_GRAPHQL';

/**
 * Resolve `ENABLE_GRAPHQL` with the parse `configuration.ts` uses for its other
 * on/off flags: unset or blank is on (the default); any other value is on only
 * when it is `true`, `1`, `yes` or `on` (any case).
 */
export function resolveGraphqlEnabled(env: Env): boolean {
  const raw = env[GRAPHQL_ENABLED_ENV_VAR];
  if (raw === undefined || raw === '') return true;
  return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
}
