/**
 * Integration — T-2880: a REST caller's `caCert` through a real Nest HTTP stack.
 *
 * `caCert` loads no CA. Any non-empty value makes `HttpClient` build its agents
 * with `rejectUnauthorized: false` (`packages/common/src/http/http-client.ts`,
 * the default agent and `getGuardedAgents({ insecureTls })`). The production
 * `ValidationPipe` keeps the field because it is decorated, so before T-2880
 * `{"searchTerm":"x","caCert":"1"}` on `POST /api/jobs/search` or
 * `/api/jobs/analyze` turned off upstream certificate checks for every direct
 * HTTPS request of that search, including sources that send the operator's API
 * keys.
 *
 * This suite boots `JobsController` with the production pipe
 * (`createGlobalValidationPipe`) and the real `configuration()` factory, then
 * sends real requests. `EVER_JOBS_ALLOW_CALLER_INSECURE_TLS` is set before the
 * boot and restored after it. Only `JobsService`, the aggregator, the analytics
 * and the cache are stubbed.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AnalyticsService } from '@ever-jobs/analytics';
import { JobPostDto } from '@ever-jobs/models';

import { CacheService } from '../../src/cache/cache.service';
import configuration from '../../src/config/configuration';
import { JobsAggregator } from '../../src/jobs/jobs.aggregator';
import { JobsController } from '../../src/jobs/jobs.controller';
import { JobsService } from '../../src/jobs/jobs.service';
import { createGlobalValidationPipe } from '../../src/pipes/global-validation.pipe';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

const ENV_VAR = 'EVER_JOBS_ALLOW_CALLER_INSECURE_TLS';
const BODY = { searchTerm: 'engineer', caCert: '1' };

const fixtureJobs = (): JobPostDto[] => [
  new JobPostDto({ id: '1', title: 'Engineer', jobUrl: 'https://example.com/1', site: 'linkedin' }),
];

interface Harness {
  app: INestApplication;
  jobsService: { searchJobs: jest.Mock; searchJobsWithDiagnostics: jest.Mock; assertSearchable: jest.Mock };
  cacheService: { get: jest.Mock; set: jest.Mock };
}

/** Boot the REST controller with `EVER_JOBS_ALLOW_CALLER_INSECURE_TLS` set to `optIn` (or unset). */
async function boot(optIn: string | undefined): Promise<Harness> {
  const jobsService = {
    searchJobs: jest.fn(async () => fixtureJobs()),
    searchJobsWithDiagnostics: jest.fn(async () => ({ jobs: fixtureJobs(), perSource: [] })),
    assertSearchable: jest.fn(),
  };
  const cacheService = { get: jest.fn(async () => null), set: jest.fn(async () => undefined) };
  const aggregator = {
    aggregateRaw: jest.fn(async (jobs: JobPostDto[]) => ({
      jobs,
      rawCount: jobs.length,
      outputCount: jobs.length,
      deduped: false,
    })),
  };
  const analytics = {
    analyze: jest.fn(() => ({ summary: { totalJobs: 1 }, companies: [], siteComparison: [] })),
  };

  const saved = process.env[ENV_VAR];
  if (optIn === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = optIn;
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [configuration] })],
      controllers: [JobsController],
      providers: [
        { provide: JobsService, useValue: jobsService },
        { provide: JobsAggregator, useValue: aggregator },
        { provide: AnalyticsService, useValue: analytics },
        { provide: CacheService, useValue: cacheService },
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    return { app, jobsService, cacheService };
  } finally {
    if (saved === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = saved;
  }
}

const post = (h: Harness, path: string) =>
  request(h.app.getHttpServer()).post(path).send(BODY).set('Content-Type', 'application/json');

describe('A REST caller cannot turn off upstream TLS verification with caCert (T-2880)', () => {
  describe(`${ENV_VAR} unset (the default)`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await boot(undefined);
    });
    afterAll(async () => {
      await h?.app.close();
    });
    beforeEach(() => {
      h.jobsService.searchJobs.mockClear();
      h.jobsService.searchJobsWithDiagnostics.mockClear();
      h.cacheService.get.mockClear();
      h.cacheService.set.mockClear();
    });

    it('POST /api/jobs/search: neither the service nor the cache key gets caCert', async () => {
      const res = await post(h, '/api/jobs/search');

      expect(res.status).toBe(201);
      expect(res.body.count).toBe(1);
      expect(h.jobsService.searchJobsWithDiagnostics).toHaveBeenCalledTimes(1);
      expect(h.jobsService.searchJobsWithDiagnostics.mock.calls[0][0]).toEqual(
        expect.objectContaining({ searchTerm: 'engineer' }),
      );
      expect(h.jobsService.searchJobsWithDiagnostics.mock.calls[0][0]).not.toHaveProperty('caCert');
      expect(h.cacheService.get.mock.calls[0][0]).not.toHaveProperty('caCert');
    });

    it('POST /api/jobs/search?format=ndjson: the service does not get caCert', async () => {
      const res = await post(h, '/api/jobs/search?format=ndjson');

      expect(res.status).toBe(201);
      expect(String(res.text)).toContain('"type":"end"');
      expect(h.jobsService.searchJobsWithDiagnostics).toHaveBeenCalledTimes(1);
      expect(h.jobsService.searchJobsWithDiagnostics.mock.calls[0][0]).not.toHaveProperty('caCert');
      expect(h.cacheService.get.mock.calls[0][0]).not.toHaveProperty('caCert');
    });

    it('POST /api/jobs/analyze: the service does not get caCert', async () => {
      const res = await post(h, '/api/jobs/analyze');

      expect(res.status).toBe(201);
      expect(h.jobsService.searchJobs).toHaveBeenCalledTimes(1);
      expect(h.jobsService.searchJobs.mock.calls[0][0]).toEqual(
        expect.objectContaining({ searchTerm: 'engineer' }),
      );
      expect(h.jobsService.searchJobs.mock.calls[0][0]).not.toHaveProperty('caCert');
    });
  });

  describe(`${ENV_VAR}=false`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await boot('false');
    });
    afterAll(async () => {
      await h?.app.close();
    });

    it('still drops caCert', async () => {
      await post(h, '/api/jobs/search');
      expect(h.jobsService.searchJobsWithDiagnostics.mock.calls[0][0]).not.toHaveProperty('caCert');
    });
  });

  describe(`${ENV_VAR}=true (the operator allows it)`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await boot('true');
    });
    afterAll(async () => {
      await h?.app.close();
    });

    it('POST /api/jobs/search passes caCert through to the service', async () => {
      const res = await post(h, '/api/jobs/search');

      expect(res.status).toBe(201);
      expect(h.jobsService.searchJobsWithDiagnostics.mock.calls[0][0]).toHaveProperty('caCert', '1');
    });

    it('POST /api/jobs/analyze passes caCert through to the service', async () => {
      const res = await post(h, '/api/jobs/analyze');

      expect(res.status).toBe(201);
      expect(h.jobsService.searchJobs.mock.calls[0][0]).toHaveProperty('caCert', '1');
    });
  });
});
