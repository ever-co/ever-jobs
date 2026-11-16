/**
 * Unit tests for `GqlThrottlerGuard`.
 *
 * The stock `ThrottlerGuard` reads the request through `switchToHttp()`, which
 * is undefined inside a GraphQL resolver, so every query threw a `TypeError`
 * once rate limiting was enabled. These tests drive the guard with GraphQL
 * execution contexts and assert it counts requests (under the limit passes,
 * over the limit throws `ThrottlerException`) and still works for REST.
 */
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerException,
  ThrottlerModuleOptions,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import { GqlThrottlerGuard } from '../gql-throttler.guard';

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

  async function makeGuard(limit: number): Promise<GqlThrottlerGuard> {
    storage = new ThrottlerStorageService();
    const options: ThrottlerModuleOptions = {
      throttlers: [{ ttl: 60_000, limit }],
    };
    const guard = new GqlThrottlerGuard(options, storage, new Reflector());
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
});
