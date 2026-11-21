/**
 * Integration tests — HTTP request metrics through a booted app.
 *
 * The other metrics specs drive `MetricsInterceptor` and `HttpExceptionFilter`
 * with fake contexts. This one boots Nest + Express with the same global
 * enhancers `AppModule` registers (`ApiKeyGuard`, `ThrottlerGuard`,
 * `MetricsInterceptor`, `HttpExceptionFilter`, and `MetricsModule` for the
 * service), sends real requests and reads the series back. It checks the
 * paths only a real app has:
 *   - a guard rejection never reaches the interceptor, so the filter must
 *     count it (and only works if Nest injects `MetricsService` into it);
 *   - a request that matches no route goes to Nest's not-found handler and is
 *     labelled `'unmatched'`;
 *   - a handler error seen by both the interceptor and the filter is counted
 *     once.
 */
import 'reflect-metadata';
import {
  Controller,
  Get,
  INestApplication,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ApiKeyGuard } from '../../auth/api-key.guard';
import { HttpExceptionFilter } from '../../filters/http-exception.filter';
import { MetricsInterceptor } from '../metrics.interceptor';
import { MetricsModule } from '../metrics.module';
import { MetricsService } from '../metrics.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

const API_KEY = 'test-key';

@Controller('api/probe')
class ProbeController {
  @Get('missing/:id')
  missing(): never {
    throw new NotFoundException('no such probe');
  }

  @Get('boom')
  boom(): never {
    throw new Error('boom');
  }

  @Get('limited')
  @Throttle({ default: { limit: 1, ttl: 60_000 } })
  limited(): { ok: boolean } {
    return { ok: true };
  }

  @Get(':id')
  one(@Param('id') id: string): { id: string } {
    return { id };
  }
}

describe('HTTP request metrics through a booted app', () => {
  let app: INestApplication;
  let metrics: MetricsService;
  const config: Record<string, unknown> = {
    'auth.enabled': true,
    'auth.apiKeys': [API_KEY],
    'auth.headerName': 'x-api-key',
  };

  const counter = async () => (await metrics.httpRequestsTotal.get()).values;
  const durationCounts = async () =>
    (await metrics.httpRequestDuration.get()).values.filter((v) =>
      (v.metricName ?? '').endsWith('_count'),
    );

  const get = (path: string, key: string | null = API_KEY) => {
    const req = request(app.getHttpServer()).get(path);
    return key === null ? req : req.set('x-api-key', key);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MetricsModule,
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 1_000 }] }),
      ],
      controllers: [ProbeController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: unknown) =>
              key in config ? config[key] : fallback,
          },
        },
        // Same order as AppModule.
        { provide: APP_GUARD, useClass: ApiKeyGuard },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    metrics = app.get(MetricsService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    metrics.httpRequestsTotal.reset();
    metrics.httpRequestDuration.reset();
  });

  it('records requests that differ only by query string or id in one series', async () => {
    await get('/api/probe/a1?page=1').expect(200);
    await get('/api/probe/b2?page=2').expect(200);

    expect(await counter()).toEqual([
      {
        value: 2,
        labels: { method: 'GET', path: '/api/probe/:id', status_code: 200 },
      },
    ]);
    const counts = await durationCounts();
    expect(counts).toHaveLength(1);
    expect(counts[0].value).toBe(2);
  });

  it('counts a request the API key guard rejects, under the route template', async () => {
    await get('/api/probe/a1?secret=1', null).expect(403);
    await get('/api/probe/a1', 'wrong-key').expect(403);

    expect(await counter()).toEqual([
      {
        value: 2,
        labels: { method: 'GET', path: '/api/probe/:id', status_code: 403 },
      },
    ]);
  });

  it('counts a request the rate-limit guard rejects', async () => {
    await get('/api/probe/limited').expect(200);
    await get('/api/probe/limited').expect(429);

    const byStatus = Object.fromEntries(
      (await counter()).map((v) => [v.labels.status_code, v.labels.path]),
    );
    expect(byStatus).toEqual({
      200: '/api/probe/limited',
      429: '/api/probe/limited',
    });
  });

  it("counts a request that matches no route as 'unmatched'", async () => {
    await get('/nope/123?x=1').expect(404);
    await get('/also/not/here').expect(404);

    expect(await counter()).toEqual([
      {
        value: 2,
        labels: { method: 'GET', path: 'unmatched', status_code: 404 },
      },
    ]);
  });

  it('counts a handler error once, with its status and a duration sample', async () => {
    await get('/api/probe/missing/zzz').expect(404);
    await get('/api/probe/boom').expect(500);

    const values = await counter();
    expect(values).toHaveLength(2);
    expect(values).toContainEqual({
      value: 1,
      labels: { method: 'GET', path: '/api/probe/missing/:id', status_code: 404 },
    });
    expect(values).toContainEqual({
      value: 1,
      labels: { method: 'GET', path: '/api/probe/boom', status_code: 500 },
    });
    expect((await durationCounts()).map((v) => v.value)).toEqual([1, 1]);
  });

  it('does not record the metrics endpoint', async () => {
    await get('/metrics?foo=bar').expect(200);

    expect(await counter()).toEqual([]);
    expect(await durationCounts()).toEqual([]);
  });
});
