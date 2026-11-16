/**
 * Unit tests — HTTP metrics interceptor.
 *
 * Drives `MetricsInterceptor` with a fake HTTP execution context and a real
 * `MetricsService` to assert:
 *   - the `path` label is the matched route template, so query strings and
 *     path parameters do not create new series;
 *   - failed requests (thrown handlers) are counted too;
 *   - the metrics endpoint itself is not recorded.
 */
import {
  CallHandler,
  ExecutionContext,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { recordHttpRequest } from '../http-metrics';
import { MetricsInterceptor } from '../metrics.interceptor';
import { MetricsService } from '../metrics.service';

interface FakeRequest {
  method: string;
  url: string;
  route?: { path?: string };
}

function makeContext(
  request: FakeRequest,
  statusCode = 200,
  type = 'http',
): ExecutionContext {
  const response = { statusCode };
  return {
    getType: () => type,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

const handlerOk = (value: unknown = 'ok'): CallHandler => ({
  handle: () => of(value),
});

const handlerThrows = (err: unknown): CallHandler => ({
  handle: () => throwError(() => err),
});

describe('MetricsInterceptor', () => {
  let service: MetricsService;
  let interceptor: MetricsInterceptor;

  const counterValues = async () =>
    (await service.httpRequestsTotal.get()).values;
  const durationCounts = async () =>
    (await service.httpRequestDuration.get()).values.filter((v) =>
      (v.metricName ?? '').endsWith('_count'),
    );

  beforeEach(() => {
    service = new MetricsService();
    interceptor = new MetricsInterceptor(service);
  });

  it('records requests that differ only by query string in one series', async () => {
    for (const page of [1, 2]) {
      const ctx = makeContext({
        method: 'POST',
        url: `/api/jobs/search?page=${page}`,
        route: { path: '/api/jobs/search' },
      });
      await lastValueFrom(interceptor.intercept(ctx, handlerOk()));
    }

    expect(await counterValues()).toEqual([
      {
        value: 2,
        labels: {
          method: 'POST',
          path: '/api/jobs/search',
          status_code: 200,
        },
      },
    ]);
    const counts = await durationCounts();
    expect(counts).toHaveLength(1);
    expect(counts[0].labels).toEqual({
      method: 'POST',
      path: '/api/jobs/search',
    });
    expect(counts[0].value).toBe(2);
  });

  it('labels by the route template, not the concrete path parameter', async () => {
    for (const id of ['a1', 'b2']) {
      const ctx = makeContext({
        method: 'GET',
        url: `/api/jobs/${id}`,
        route: { path: '/api/jobs/:id' },
      });
      await lastValueFrom(interceptor.intercept(ctx, handlerOk()));
    }

    const values = await counterValues();
    expect(values).toHaveLength(1);
    expect(values[0].labels.path).toBe('/api/jobs/:id');
  });

  it("uses 'unmatched' when no route matched", async () => {
    const ctx = makeContext({ method: 'GET', url: '/nope/123?x=1' }, 404);
    await lastValueFrom(interceptor.intercept(ctx, handlerOk()));

    const values = await counterValues();
    expect(values).toHaveLength(1);
    expect(values[0].labels).toEqual({
      method: 'GET',
      path: 'unmatched',
      status_code: 404,
    });
  });

  it('counts a handler that throws NotFoundException as status 404', async () => {
    const ctx = makeContext({
      method: 'GET',
      url: '/api/jobs/zzz',
      route: { path: '/api/jobs/:id' },
    });

    await expect(
      lastValueFrom(
        interceptor.intercept(ctx, handlerThrows(new NotFoundException())),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(await counterValues()).toEqual([
      {
        value: 1,
        labels: { method: 'GET', path: '/api/jobs/:id', status_code: 404 },
      },
    ]);
    expect(await durationCounts()).toHaveLength(1);
  });

  it('uses the HttpException status for other HTTP errors', async () => {
    const ctx = makeContext({
      method: 'POST',
      url: '/api/jobs/search',
      route: { path: '/api/jobs/search' },
    });

    await expect(
      lastValueFrom(
        interceptor.intercept(
          ctx,
          handlerThrows(new HttpException('slow down', 429)),
        ),
      ),
    ).rejects.toBeInstanceOf(HttpException);

    const values = await counterValues();
    expect(values).toHaveLength(1);
    expect(values[0].labels.status_code).toBe(429);
  });

  it('counts a non-HTTP error as status 500', async () => {
    const ctx = makeContext({
      method: 'GET',
      url: '/api/jobs',
      route: { path: '/api/jobs' },
    });

    await expect(
      lastValueFrom(
        interceptor.intercept(ctx, handlerThrows(new Error('boom'))),
      ),
    ).rejects.toThrow('boom');

    const values = await counterValues();
    expect(values).toHaveLength(1);
    expect(values[0].labels.status_code).toBe(500);
  });

  it('keeps the response status code for successful requests', async () => {
    const ctx = makeContext(
      { method: 'POST', url: '/api/x', route: { path: '/api/x' } },
      201,
    );
    await lastValueFrom(interceptor.intercept(ctx, handlerOk()));

    const values = await counterValues();
    expect(values[0].labels.status_code).toBe(201);
  });

  it('counts a request once when the handler emits several values', async () => {
    const ctx = makeContext({
      method: 'GET',
      url: '/api/stream',
      route: { path: '/api/stream' },
    });
    const multi: CallHandler = { handle: () => of(1, 2, 3) };
    await lastValueFrom(interceptor.intercept(ctx, multi));

    const values = await counterValues();
    expect(values).toHaveLength(1);
    expect(values[0].value).toBe(1);
    const counts = await durationCounts();
    expect(counts[0].value).toBe(1);
  });

  it('does not count the same request again when the exception filter records it', async () => {
    const request: FakeRequest = {
      method: 'GET',
      url: '/api/jobs/zzz',
      route: { path: '/api/jobs/:id' },
    };
    const ctx = makeContext(request);
    await expect(
      lastValueFrom(
        interceptor.intercept(ctx, handlerThrows(new NotFoundException())),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    // The global exception filter sees the same error afterwards.
    recordHttpRequest(service, request, 404);

    const values = await counterValues();
    expect(values).toHaveLength(1);
    expect(values[0].value).toBe(1);
  });

  it('does not record the metrics endpoint itself', async () => {
    const ctx = makeContext({
      method: 'GET',
      url: '/metrics?foo=bar',
      route: { path: '/metrics' },
    });
    await lastValueFrom(interceptor.intercept(ctx, handlerOk()));

    expect(await counterValues()).toEqual([]);
    expect(await durationCounts()).toEqual([]);
  });

  it('does not record GraphQL requests', async () => {
    const ctx = makeContext(
      { method: 'POST', url: '/graphql', route: { path: '/graphql' } },
      200,
      'graphql',
    );
    await lastValueFrom(interceptor.intercept(ctx, handlerOk()));

    expect(await counterValues()).toEqual([]);
  });
});
