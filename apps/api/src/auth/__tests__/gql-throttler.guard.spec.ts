/**
 * Unit tests for `GqlThrottlerGuard`.
 *
 * The stock `ThrottlerGuard` reads the request through `switchToHttp()`, which
 * is undefined inside a GraphQL resolver, so every query threw a `TypeError`
 * once rate limiting was enabled. These tests drive the guard with GraphQL
 * execution contexts and assert it counts requests (under the limit passes,
 * over the limit throws `ThrottlerException`) and still works for REST.
 *
 * T-2521: a request carrying a VALID API key is counted per key (tracker
 * `key:<sha256>`), every other request per IP, so callers behind one reverse
 * proxy do not share a single bucket.
 */
import { createHash } from 'crypto';
import { ExecutionContext } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ThrottlerException,
  ThrottlerModule,
  ThrottlerModuleOptions,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import { GqlThrottlerGuard } from '../gql-throttler.guard';

interface AuthConfig {
  enabled: boolean;
  apiKeys: string[];
  headerName: string;
}

const AUTH_ON: AuthConfig = {
  enabled: true,
  apiKeys: ['k1', 'k2'],
  headerName: 'x-api-key',
};

function makeRes() {
  return { header: jest.fn() };
}

function makeGqlContext(req: unknown): ExecutionContext {
  const handler = (): void => undefined;
  class FakeResolver {}
  return {
    getType: () => 'graphql',
    getArgs: () => [undefined, {}, { req }, {}],
    switchToHttp: () => ({
      getRequest: () => undefined,
      getResponse: () => undefined,
    }),
    getHandler: () => handler,
    getClass: () => FakeResolver,
  } as unknown as ExecutionContext;
}

function makeHttpContext(req: unknown, res: unknown): ExecutionContext {
  const handler = (): void => undefined;
  class FakeController {}
  return {
    getType: () => 'http',
    getArgs: () => [req, res],
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    getHandler: () => handler,
    getClass: () => FakeController,
  } as unknown as ExecutionContext;
}

describe('GqlThrottlerGuard', () => {
  let storage: ThrottlerStorageService;

  async function makeGuard(
    limit: number,
    auth?: AuthConfig,
  ): Promise<GqlThrottlerGuard> {
    storage = new ThrottlerStorageService();
    const options: ThrottlerModuleOptions = {
      throttlers: [{ ttl: 60_000, limit }],
    };
    const config = new ConfigService(auth ? { auth } : {});
    const guard = new GqlThrottlerGuard(
      options,
      storage,
      new Reflector(),
      config,
    );
    await guard.onModuleInit();
    return guard;
  }

  afterEach(() => {
    // Clears the storage's cleanup timer so Jest can exit.
    storage?.onApplicationShutdown?.();
  });

  it('lets a GraphQL request under the limit through', async () => {
    const guard = await makeGuard(2);
    const ctx = makeGqlContext({ ip: '10.0.0.1', res: makeRes() });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('throws ThrottlerException (not TypeError) for a GraphQL request over the limit', async () => {
    const guard = await makeGuard(2);
    const req = { ip: '10.0.0.1', res: makeRes() };
    await expect(guard.canActivate(makeGqlContext(req))).resolves.toBe(true);
    await expect(guard.canActivate(makeGqlContext(req))).resolves.toBe(true);
    await expect(guard.canActivate(makeGqlContext(req))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('tracks clients separately by IP', async () => {
    const guard = await makeGuard(1);
    const a = { ip: '10.0.0.1', res: makeRes() };
    const b = { ip: '10.0.0.2', res: makeRes() };
    await expect(guard.canActivate(makeGqlContext(a))).resolves.toBe(true);
    await expect(guard.canActivate(makeGqlContext(b))).resolves.toBe(true);
    await expect(guard.canActivate(makeGqlContext(a))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('does not crash when the GraphQL context has no response object', async () => {
    const guard = await makeGuard(1);
    const req = { ip: '10.0.0.3' };
    await expect(guard.canActivate(makeGqlContext(req))).resolves.toBe(true);
    await expect(guard.canActivate(makeGqlContext(req))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('keeps the REST behaviour: counts via switchToHttp and throws over the limit', async () => {
    const guard = await makeGuard(1);
    const req = { ip: '10.0.0.4' };
    const res = makeRes();
    await expect(
      guard.canActivate(makeHttpContext(req, res)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(makeHttpContext(req, res)),
    ).rejects.toBeInstanceOf(ThrottlerException);
  });

  describe('per API key tracking (T-2521)', () => {
    const IP = '10.0.0.10';

    function rest(key: string | undefined, ip = IP, headerName = 'x-api-key') {
      const headers: Record<string, string> = {};
      if (key !== undefined) headers[headerName] = key;
      return makeHttpContext({ ip, headers }, makeRes());
    }

    function trackerOf(
      guard: GqlThrottlerGuard,
      req: Record<string, unknown>,
    ): Promise<string> {
      return (
        guard as unknown as {
          getTracker(r: Record<string, unknown>): Promise<string>;
        }
      ).getTracker(req);
    }

    it('gives each valid key its own bucket: k1 then k2 from one IP both pass', async () => {
      const guard = await makeGuard(1, AUTH_ON);
      await expect(guard.canActivate(rest('k1'))).resolves.toBe(true);
      await expect(guard.canActivate(rest('k2'))).resolves.toBe(true);
      // Each key's own budget is still enforced.
      await expect(guard.canActivate(rest('k1'))).rejects.toBeInstanceOf(
        ThrottlerException,
      );
    });

    it('does the same for GraphQL requests', async () => {
      const guard = await makeGuard(1, AUTH_ON);
      const gql = (key: string) =>
        makeGqlContext({ ip: IP, headers: { 'x-api-key': key }, res: makeRes() });
      await expect(guard.canActivate(gql('k1'))).resolves.toBe(true);
      await expect(guard.canActivate(gql('k2'))).resolves.toBe(true);
      await expect(guard.canActivate(gql('k2'))).rejects.toBeInstanceOf(
        ThrottlerException,
      );
    });

    it('counts one valid key in one bucket whatever IP it comes from', async () => {
      const guard = await makeGuard(1, AUTH_ON);
      await expect(guard.canActivate(rest('k1', '10.0.0.11'))).resolves.toBe(true);
      await expect(
        guard.canActivate(rest('k1', '10.0.0.12')),
      ).rejects.toBeInstanceOf(ThrottlerException);
    });

    it('puts two requests with the same invalid key from one IP in the IP bucket', async () => {
      const guard = await makeGuard(1, AUTH_ON);
      await expect(guard.canActivate(rest('bogus'))).resolves.toBe(true);
      await expect(guard.canActivate(rest('bogus'))).rejects.toBeInstanceOf(
        ThrottlerException,
      );
    });

    it('does not let a caller buy budget by rotating invalid keys (or sending none)', async () => {
      const guard = await makeGuard(1, AUTH_ON);
      await expect(guard.canActivate(rest('fake-1'))).resolves.toBe(true);
      await expect(guard.canActivate(rest('fake-2'))).rejects.toBeInstanceOf(
        ThrottlerException,
      );
      await expect(guard.canActivate(rest(undefined))).rejects.toBeInstanceOf(
        ThrottlerException,
      );
    });

    it('never puts the raw key in the tracker', async () => {
      const guard = await makeGuard(1, AUTH_ON);
      const tracker = await trackerOf(guard, {
        ip: IP,
        headers: { 'x-api-key': 'k1' },
      });
      expect(tracker).toBe(
        `key:${createHash('sha256').update('k1').digest('hex')}`,
      );
      expect(tracker).not.toContain('k1');
      // An invalid key is not tracked at all: the IP is.
      await expect(
        trackerOf(guard, { ip: IP, headers: { 'x-api-key': 'bogus' } }),
      ).resolves.toBe(IP);
    });

    it('reads the key from the configured header name', async () => {
      const guard = await makeGuard(1, { ...AUTH_ON, headerName: 'X-Client-Key' });
      // Node lower-cases incoming header names.
      await expect(
        guard.canActivate(rest('k1', IP, 'x-client-key')),
      ).resolves.toBe(true);
      await expect(
        guard.canActivate(rest('k2', IP, 'x-client-key')),
      ).resolves.toBe(true);
      // The default header is not read when another one is configured: keys
      // sent there are counted per IP, so k1 and k2 now share one bucket.
      await expect(guard.canActivate(rest('k1'))).resolves.toBe(true);
      await expect(guard.canActivate(rest('k2'))).rejects.toBeInstanceOf(
        ThrottlerException,
      );
    });

    it('tracks by IP when API key auth is disabled, even for a configured key', async () => {
      const guard = await makeGuard(1, { ...AUTH_ON, enabled: false });
      await expect(guard.canActivate(rest('k1'))).resolves.toBe(true);
      await expect(guard.canActivate(rest('k2'))).rejects.toBeInstanceOf(
        ThrottlerException,
      );
    });

    it('resolves through Nest DI (throttler providers + ConfigService) and tracks per key', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            load: [() => ({ auth: AUTH_ON })],
          }),
          ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 1 }] }),
        ],
        providers: [GqlThrottlerGuard],
      }).compile();
      await moduleRef.init();
      try {
        const guard = moduleRef.get(GqlThrottlerGuard);
        await expect(guard.canActivate(rest('k1'))).resolves.toBe(true);
        await expect(guard.canActivate(rest('k2'))).resolves.toBe(true);
      } finally {
        await moduleRef.close();
      }
    });
  });
});
