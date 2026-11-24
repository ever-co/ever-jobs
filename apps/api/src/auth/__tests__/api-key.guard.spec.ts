/**
 * Unit tests for `ApiKeyGuard` — Spec 005 / T07 / Q-017.
 *
 * The guard has two tiers:
 *   - Standard routes — auth optional (no-op when `auth.enabled=false`).
 *   - Admin routes (decorated with `@AdminAuth()`) — auth always
 *     required; misconfigured deploys return 503; missing/invalid key
 *     returns 401 (not 403).
 *
 * These tests stub `ConfigService` and `Reflector` directly rather than
 * bootstrapping a full Nest app — the guard's contract is purely the
 * three-way fork on `(auth.enabled, apiKeys.length, isAdmin)` so a
 * faked `ExecutionContext` is the right unit of test.
 */
import {
  ExecutionContext,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from '../api-key.guard';
import { ADMIN_AUTH_METADATA_KEY } from '../admin-auth.decorator';
import { PROBE_ROUTE_METADATA_KEY } from '../probe-route.decorator';

interface FakeRequest {
  headers: Record<string, string | undefined>;
}

function makeContext(headers: Record<string, string | undefined> = {}): {
  ctx: ExecutionContext;
  handler: () => void;
  cls: { new (): unknown };
} {
  const handler = (): void => undefined;
  class FakeController {}

  const req: FakeRequest = { headers };
  const ctx = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
    }),
    getHandler: () => handler,
    getClass: () => FakeController,
  } as unknown as ExecutionContext;

  return { ctx, handler, cls: FakeController };
}

interface ConfigMap {
  'auth.enabled': boolean;
  'auth.apiKeys': string[];
  'auth.headerName': string;
}

function makeConfig(overrides: Partial<ConfigMap> = {}): ConfigService {
  const map: ConfigMap = {
    'auth.enabled': false,
    'auth.apiKeys': [],
    'auth.headerName': 'x-api-key',
    ...overrides,
  };
  return {
    get: <T>(key: keyof ConfigMap, fallback?: T): T => {
      const v = map[key];
      return (v === undefined ? fallback : v) as T;
    },
  } as unknown as ConfigService;
}

function makeReflector(
  adminMatches: Set<unknown>,
  probeMatches: Set<unknown> = new Set(),
): Reflector {
  const byKey: Record<string, Set<unknown>> = {
    [ADMIN_AUTH_METADATA_KEY]: adminMatches,
    [PROBE_ROUTE_METADATA_KEY]: probeMatches,
  };
  return {
    getAllAndOverride: <T>(
      key: string,
      targets: ReadonlyArray<unknown>,
    ): T | undefined => {
      const matches = byKey[key];
      if (!matches) return undefined;
      for (const t of targets) {
        if (matches.has(t)) return true as unknown as T;
      }
      return undefined;
    },
  } as unknown as Reflector;
}

describe('ApiKeyGuard — Spec 005 / T07 / Q-017', () => {
  describe('standard routes (no @AdminAuth metadata)', () => {
    it('allows the request when auth.enabled=false', () => {
      const { ctx } = makeContext();
      const guard = new ApiKeyGuard(
        makeConfig({ 'auth.enabled': false }),
        makeReflector(new Set()),
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('allows the request when auth.enabled=true but apiKeys=[]', () => {
      const { ctx } = makeContext();
      const guard = new ApiKeyGuard(
        makeConfig({ 'auth.enabled': true, 'auth.apiKeys': [] }),
        makeReflector(new Set()),
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('throws 403 ForbiddenException for missing key when enabled+keys configured', () => {
      const { ctx } = makeContext();
      const guard = new ApiKeyGuard(
        makeConfig({ 'auth.enabled': true, 'auth.apiKeys': ['secret'] }),
        makeReflector(new Set()),
      );
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('throws 403 ForbiddenException for invalid key', () => {
      const { ctx } = makeContext({ 'x-api-key': 'wrong' });
      const guard = new ApiKeyGuard(
        makeConfig({ 'auth.enabled': true, 'auth.apiKeys': ['secret'] }),
        makeReflector(new Set()),
      );
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('passes for valid key', () => {
      const { ctx } = makeContext({ 'x-api-key': 'secret' });
      const guard = new ApiKeyGuard(
        makeConfig({ 'auth.enabled': true, 'auth.apiKeys': ['secret'] }),
        makeReflector(new Set()),
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('honours custom header name', () => {
      const { ctx } = makeContext({ 'x-custom': 'secret' });
      const guard = new ApiKeyGuard(
        makeConfig({
          'auth.enabled': true,
          'auth.apiKeys': ['secret'],
          'auth.headerName': 'X-Custom',
        }),
        makeReflector(new Set()),
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe('GraphQL context (request lives in the GraphQL context, not switchToHttp)', () => {
    function makeGqlContext(
      gqlContext: unknown,
    ): { ctx: ExecutionContext; handler: () => void } {
      const handler = (): void => undefined;
      class FakeResolver {}
      const ctx = {
        getType: () => 'graphql',
        // [root, args, context, info] — the root is undefined for queries.
        getArgs: () => [undefined, {}, gqlContext, {}],
        // switchToHttp().getRequest() is undefined here; the old code crashed on it.
        switchToHttp: () => ({ getRequest: () => undefined }),
        getHandler: () => handler,
        getClass: () => FakeResolver,
      } as unknown as ExecutionContext;
      return { ctx, handler };
    }

    const enabledConfig = () =>
      makeConfig({ 'auth.enabled': true, 'auth.apiKeys': ['secret'] });

    it('passes for a valid key', () => {
      const { ctx } = makeGqlContext({
        req: { headers: { 'x-api-key': 'secret' } },
      });
      const guard = new ApiKeyGuard(enabledConfig(), makeReflector(new Set()));
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('throws 403 ForbiddenException for a missing key', () => {
      const { ctx } = makeGqlContext({ req: { headers: {} } });
      const guard = new ApiKeyGuard(enabledConfig(), makeReflector(new Set()));
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('throws 403 ForbiddenException for an invalid key', () => {
      const { ctx } = makeGqlContext({
        req: { headers: { 'x-api-key': 'wrong' } },
      });
      const guard = new ApiKeyGuard(enabledConfig(), makeReflector(new Set()));
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('treats a GraphQL context without a request as a missing key', () => {
      const { ctx } = makeGqlContext({});
      const guard = new ApiKeyGuard(enabledConfig(), makeReflector(new Set()));
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('throws 401 UnauthorizedException on an @AdminAuth handler without a key', () => {
      const { ctx, handler } = makeGqlContext({ req: { headers: {} } });
      const guard = new ApiKeyGuard(
        enabledConfig(),
        makeReflector(new Set([handler])),
      );
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('allows everything when auth is disabled, without touching the request', () => {
      const { ctx } = makeGqlContext(undefined);
      const guard = new ApiKeyGuard(
        makeConfig({ 'auth.enabled': false }),
        makeReflector(new Set()),
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  // T-2672 — a Docker healthcheck or a Kubernetes probe sends no key, so the
  // probes (`@ProbeRoute()`: GET /health, /ping, /ready) must answer without
  // one even when API key auth is on.
  describe('probe routes (@ProbeRoute() metadata present)', () => {
    const enabledConfig = () =>
      makeConfig({ 'auth.enabled': true, 'auth.apiKeys': ['secret'] });

    it('allows a probe handler without a key when enabled+keys configured', () => {
      const { ctx, handler } = makeContext();
      const guard = new ApiKeyGuard(
        enabledConfig(),
        makeReflector(new Set(), new Set([handler])),
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('allows a probe handler with an invalid key', () => {
      const { ctx, handler } = makeContext({ 'x-api-key': 'wrong' });
      const guard = new ApiKeyGuard(
        enabledConfig(),
        makeReflector(new Set(), new Set([handler])),
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('still throws 403 for a handler without the probe metadata', () => {
      const { ctx } = makeContext();
      const other = (): void => undefined;
      const guard = new ApiKeyGuard(
        enabledConfig(),
        makeReflector(new Set(), new Set([other])),
      );
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('does not open an @AdminAuth handler that also carries the probe metadata', () => {
      const { ctx, handler } = makeContext();
      const guard = new ApiKeyGuard(
        enabledConfig(),
        makeReflector(new Set([handler]), new Set([handler])),
      );
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });

  describe('admin routes (@AdminAuth() metadata present)', () => {
    it('throws 503 ServiceUnavailableException when no apiKeys configured', () => {
      const { ctx, handler } = makeContext({ 'x-api-key': 'anything' });
      const guard = new ApiKeyGuard(
        makeConfig({ 'auth.enabled': false, 'auth.apiKeys': [] }),
        makeReflector(new Set([handler])),
      );
      expect(() => guard.canActivate(ctx)).toThrow(
        ServiceUnavailableException,
      );
    });

    it('throws 401 UnauthorizedException for missing key (NOT 403)', () => {
      const { ctx, handler } = makeContext();
      const guard = new ApiKeyGuard(
        makeConfig({ 'auth.enabled': false, 'auth.apiKeys': ['secret'] }),
        makeReflector(new Set([handler])),
      );
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws 401 UnauthorizedException for invalid key (NOT 403)', () => {
      const { ctx, handler } = makeContext({ 'x-api-key': 'wrong' });
      const guard = new ApiKeyGuard(
        makeConfig({ 'auth.enabled': false, 'auth.apiKeys': ['secret'] }),
        makeReflector(new Set([handler])),
      );
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('passes for valid key on admin route, even when auth.enabled=false', () => {
      const { ctx, handler } = makeContext({ 'x-api-key': 'secret' });
      const guard = new ApiKeyGuard(
        makeConfig({ 'auth.enabled': false, 'auth.apiKeys': ['secret'] }),
        makeReflector(new Set([handler])),
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('admin metadata picked up via class-level decorator (not just handler)', () => {
      const { ctx, cls } = makeContext({ 'x-api-key': 'wrong' });
      const guard = new ApiKeyGuard(
        makeConfig({ 'auth.enabled': false, 'auth.apiKeys': ['secret'] }),
        makeReflector(new Set([cls])),
      );
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });
});
