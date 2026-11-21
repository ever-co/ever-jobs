/**
 * HTTP metrics for requests rejected by the REAL global guards.
 *
 * Guards run before interceptors, so `MetricsInterceptor` never sees a request
 * the API key guard or the rate limiter turns away. The global exception
 * filter records those. This suite boots a tiny app with the production
 * `ApiKeyGuard`, `ThrottlerGuard`, `MetricsInterceptor` and
 * `HttpExceptionFilter`, sends real HTTP requests, and reads the counters back
 * from a real `MetricsService`.
 */
import 'reflect-metadata';
import { Controller, Get, INestApplication, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { ApiKeyGuard } from '../../src/auth/api-key.guard';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { MetricsInterceptor } from '../../src/metrics/metrics.interceptor';
import { MetricsService } from '../../src/metrics/metrics.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

@Controller('api/things')
class ThingsController {
  @Get(':id')
  get(@Param('id') id: string) {
    return { id };
  }
}

describe('HTTP metrics for guard-rejected requests', () => {
  let app: INestApplication;
  let metrics: MetricsService;

  const config = {
    get: (key: string, def?: unknown) => {
      if (key === 'auth.enabled') return true;
      if (key === 'auth.apiKeys') return ['secret'];
      return def;
    },
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1 }])],
      controllers: [ThingsController],
      providers: [
        MetricsService,
        { provide: ConfigService, useValue: config },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    metrics = moduleRef.get(MetricsService);
  });

  afterEach(async () => {
    await app?.close();
  });

  const counter = async () => (await metrics.httpRequestsTotal.get()).values;
  const seriesFor = async (status: number) =>
    (await counter()).filter((v) => v.labels.status_code === status);

  it('counts requests rejected by the API key guard, under the route template', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/things/a?x=1').expect(403);
    await request(server).get('/api/things/b?x=2').expect(403);

    expect(await seriesFor(403)).toEqual([
      {
        value: 2,
        labels: { method: 'GET', path: '/api/things/:id', status_code: 403 },
      },
    ]);
  });

  it('counts requests rejected by the rate limiter as 429', async () => {
    const server = app.getHttpServer();
    const headers = { 'x-api-key': 'secret' };
    await request(server).get('/api/things/a').set(headers).expect(200);
    await request(server).get('/api/things/b').set(headers).expect(429);

    expect(await seriesFor(429)).toEqual([
      {
        value: 1,
        labels: { method: 'GET', path: '/api/things/:id', status_code: 429 },
      },
    ]);
    // The successful request is counted once by the interceptor, not twice.
    expect(await seriesFor(200)).toEqual([
      {
        value: 1,
        labels: { method: 'GET', path: '/api/things/:id', status_code: 200 },
      },
    ]);
  });
});
