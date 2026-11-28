/**
 * Integration — T-2883: `POST /api/jobs/analyze` applies the `careerLevels` filter, as
 * `POST /api/jobs/search` does, through a real Nest HTTP stack.
 *
 * `/analyze` takes the same `ScraperInputDto` body as `/search`, and the DTO documents
 * `careerLevels` (Spec 1730). Before T-2883 the analysis applied only the exclusions, so
 * `{"searchTerm":"engineer","careerLevels":["internship"]}` returned statistics over every
 * level — senior and principal roles included — while `/search` with the same body returned
 * only the internships, and nothing told the caller.
 *
 * This suite boots the real `JobsController`, `JobsAggregator`, `AnalyticsService` and the
 * deterministic career-level classifier (`CareerLevelClassifierModule`), with the production
 * `ValidationPipe` and the real `configuration()`. Only `JobsService` (the fan-out) and the
 * cache are stubbed.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AnalyticsService } from '@ever-jobs/analytics';
import { CareerLevelClassifierModule } from '@ever-jobs/career-level-classifier';
import { JobPostDto, Site } from '@ever-jobs/models';

import { CacheService } from '../../src/cache/cache.service';
import configuration from '../../src/config/configuration';
import { JobsAggregator } from '../../src/jobs/jobs.aggregator';
import { JobsController } from '../../src/jobs/jobs.controller';
import { JobsService } from '../../src/jobs/jobs.service';
import { createGlobalValidationPipe } from '../../src/pipes/global-validation.pipe';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

const job = (id: string, title: string, companyName: string): JobPostDto =>
  new JobPostDto({ id, title, companyName, jobUrl: `https://example.com/${id}`, site: Site.LINKEDIN });

/** Two internships, one senior and one principal role, at three companies. */
const fixtureJobs = (): JobPostDto[] => [
  job('1', 'Software Engineer Intern', 'Acme'),
  job('2', 'Senior Software Engineer', 'Globex'),
  job('3', 'Principal Engineer', 'Initech'),
  job('4', 'Design Intern', 'Acme'),
];

describe('POST /api/jobs/analyze applies careerLevels like /search (T-2883)', () => {
  let app: INestApplication;
  const jobsService = {
    searchJobs: jest.fn(async () => fixtureJobs()),
    searchJobsWithDiagnostics: jest.fn(async () => ({ jobs: fixtureJobs(), perSource: [] })),
    assertSearchable: jest.fn(),
  };
  const cacheService = { get: jest.fn(async () => null), set: jest.fn(async () => undefined) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [configuration] }), CareerLevelClassifierModule],
      controllers: [JobsController],
      providers: [
        JobsAggregator,
        AnalyticsService,
        { provide: JobsService, useValue: jobsService },
        { provide: CacheService, useValue: cacheService },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const post = (path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(path).send(body).set('Content-Type', 'application/json');

  it('analyses only the internships for careerLevels ["internship"]', async () => {
    const res = await post('/api/jobs/analyze', { searchTerm: 'engineer', careerLevels: ['internship'] });

    expect(res.status).toBe(201);
    expect(res.body.summary.totalJobs).toBe(2);
    expect(res.body.companies.map((c: { companyName: string }) => c.companyName)).toEqual(['Acme']);
  });

  it('analyses the same set /search returns for the same body', async () => {
    for (const body of [
      { searchTerm: 'engineer', careerLevels: ['internship'] },
      { searchTerm: 'engineer', careerLevels: ['senior', 'principal'] },
      { searchTerm: 'engineer', careerLevels: ['internship'], excludeTitleTerms: ['design'] },
    ]) {
      const searched = await post('/api/jobs/search', body);
      const analysed = await post('/api/jobs/analyze', body);

      expect(searched.status).toBe(201);
      expect(analysed.status).toBe(201);
      expect(analysed.body.summary.totalJobs).toBe(searched.body.count);
      expect(analysed.body.summary.totalJobs).toBeLessThan(fixtureJobs().length);
    }
  });

  it('analyses every job without careerLevels (the response is unchanged)', async () => {
    const res = await post('/api/jobs/analyze', { searchTerm: 'engineer' });

    expect(res.status).toBe(201);
    expect(res.body.summary.totalJobs).toBe(4);
    expect(res.body.companies).toHaveLength(3);
  });

  it('rejects an unknown career level with 400 before searching', async () => {
    jobsService.searchJobs.mockClear();
    const res = await post('/api/jobs/analyze', { searchTerm: 'engineer', careerLevels: ['intern'] });

    expect(res.status).toBe(400);
    expect(jobsService.searchJobs).not.toHaveBeenCalled();
  });
});
