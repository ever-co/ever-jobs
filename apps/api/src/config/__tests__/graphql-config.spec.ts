import { GRAPHQL_ENABLED_ENV_VAR, resolveGraphqlEnabled } from '../graphql-config';
import configuration from '../configuration';

/**
 * T-2673 — `ENABLE_GRAPHQL`: `AppModule` imports `GraphQLModule` only when this
 * resolves to `true`, and `configuration().graphql.enabled` (which `main.ts`
 * logs) reads the same function, so the two cannot disagree. The parse is the
 * one `configuration.ts` used before: unset or blank is on, any other value is
 * on only for `true` / `1` / `yes` / `on` (any case).
 */
describe('resolveGraphqlEnabled (T-2673)', () => {
  it('names the env var ENABLE_GRAPHQL', () => {
    expect(GRAPHQL_ENABLED_ENV_VAR).toBe('ENABLE_GRAPHQL');
  });

  it('is on when unset or blank (the default)', () => {
    expect(resolveGraphqlEnabled({})).toBe(true);
    expect(resolveGraphqlEnabled({ ENABLE_GRAPHQL: '' })).toBe(true);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'On'])('is on for %p', (value) => {
    expect(resolveGraphqlEnabled({ ENABLE_GRAPHQL: value })).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off', 'disabled'])('is off for %p', (value) => {
    expect(resolveGraphqlEnabled({ ENABLE_GRAPHQL: value })).toBe(false);
  });

  describe('configuration().graphql.enabled', () => {
    const saved = process.env.ENABLE_GRAPHQL;

    afterEach(() => {
      if (saved === undefined) delete process.env.ENABLE_GRAPHQL;
      else process.env.ENABLE_GRAPHQL = saved;
    });

    it.each([undefined, '', 'false', 'off', 'true', '1'])('matches resolveGraphqlEnabled for %p', (value) => {
      if (value === undefined) delete process.env.ENABLE_GRAPHQL;
      else process.env.ENABLE_GRAPHQL = value;
      expect(configuration().graphql.enabled).toBe(resolveGraphqlEnabled(process.env));
    });
  });
});
