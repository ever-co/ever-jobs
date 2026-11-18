import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  StreamableFile,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DatePostedBasis,
  DatePostedPrecision,
  ScraperInputDto,
  JobPostDto,
  JobAnalysisDto,
  SourceDiagnosticDto,
} from '@ever-jobs/models';
import { JobsController } from '../jobs.controller';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeJobsService(jobs: JobPostDto[] = []) {
  return {
    searchJobs: jest.fn().mockResolvedValue(jobs),
    searchJobsWithDiagnostics: jest
      .fn()
      .mockResolvedValue({ jobs, perSource: [] }),
  };
}

function makeAnalyticsService() {
  return {
    analyze: jest.fn().mockReturnValue({
      summary: { totalJobs: 1, remoteCount: 0, remotePercentage: 0, withSalaryCount: 0, salaryStats: null, bySite: {} },
      companies: [],
      siteComparison: [],
    }),
  };
}

function makeCacheService(cachedValue: any = null) {
  return {
    get: jest.fn().mockReturnValue(cachedValue),
    set: jest.fn(),
  };
}

/**
 * Pass-through aggregator stub. Mirrors the production
 * "no engine bound → return raw" path so existing controller tests
 * keep their pre-Phase-5 semantics.
 */
function makePassthroughAggregator() {
  return {
    aggregateRaw: jest.fn(async (rawJobs: JobPostDto[], options: { dedup?: boolean } = {}) => ({
      jobs: rawJobs,
      rawCount: rawJobs.length,
      outputCount: rawJobs.length,
      deduped: false,
      dedupMetrics: undefined,
      // record the option so dedup-flag tests can assert on it
      _calledWith: options,
    })),
    aggregate: jest.fn(),
  };
}

function createController(
  opts: {
    jobs?: JobPostDto[];
    cachedValue?: any;
    aggregator?: any;
    configValues?: Record<string, unknown>;
  } = {},
) {
  const jobsService = makeJobsService(opts.jobs ?? []);
  const analyticsService = makeAnalyticsService();
  const cacheService = makeCacheService(opts.cachedValue);
  const aggregator = opts.aggregator ?? makePassthroughAggregator();
  // Spec 5024 — ConfigService seam. Returning the caller's default keeps
  // `store.persistSearch` at its `true` default for these cases. Spec 5164
  // adds `configValues` for keys that need a non-default value in a test
  // (e.g. `search.deadlineMaxMs`, or the include_raw gate's `rawCapture.*`
  // and `auth.*` keys).
  const configService = {
    get: (key: string, def?: unknown) => opts.configValues?.[key] ?? def,
  };
  const controller = new JobsController(
    jobsService as any,
    aggregator as any,
    analyticsService as any,
    cacheService as any,
    configService as any,
  );
  return { controller, jobsService, cacheService, analyticsService, aggregator };
}

function makeJob(overrides: Partial<JobPostDto> = {}): JobPostDto {
  return new JobPostDto({
    id: overrides.id ?? 'test-1',
    title: overrides.title ?? 'Software Engineer',
    companyName: overrides.companyName ?? 'Acme Corp',
    jobUrl: overrides.jobUrl ?? 'https://example.com/job/1',
    site: overrides.site ?? 'linkedin',
    isRemote: overrides.isRemote ?? false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobsController', () => {
  describe('POST /search — JSON responses', () => {
    it('should return job results with count', async () => {
      const jobs = [makeJob({ title: 'SWE' }), makeJob({ title: 'PM' })];
      const { controller } = createController({ jobs });

      const result = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
      ) as any;

      expect(result).toMatchObject({
        count: 2,
        jobs,
        cached: false,
        deduped: false,        // pass-through aggregator → no engine bound
        raw_count: 2,
      });
    });

    it('should return cached results when available', async () => {
      const cachedJobs = [makeJob({ title: 'Cached Job' })];
      const { controller, jobsService } = createController({ cachedValue: cachedJobs });

      const result = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
      ) as any;

      expect(result).toMatchObject({
        count: 1,
        jobs: cachedJobs,
        cached: true,
        deduped: false,
        raw_count: 1,
      });
      // Should NOT call jobsService when cache hit
      expect(jobsService.searchJobs).not.toHaveBeenCalled();
    });

    it('should cache results on miss', async () => {
      const jobs = [makeJob()];
      const { controller, cacheService } = createController({ jobs });

      await controller.searchJobs(new ScraperInputDto({ searchTerm: 'node' }));

      // Spec 1721 / FR-19 — one entry holds the raw set (and its completeness
      // record when the service reports one; this stub reports none).
      expect(cacheService.set).toHaveBeenCalledWith(
        expect.any(Object),
        { jobs },
      );
    });
  });

  describe('POST /search — pagination', () => {
    it('should paginate results when paginate=true', async () => {
      const jobs = Array.from({ length: 25 }, (_, i) =>
        makeJob({ id: `job-${i}`, title: `Job ${i}` }),
      );
      const { controller } = createController({ jobs });

      const result = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,
        'true',   // paginate
        '2',      // page
        '10',     // page_size
      ) as any;

      expect(result).toMatchObject({
        count: 25,
        total_pages: 3,
        current_page: 2,
        page_size: 10,
        next_page: 3,
        previous_page: 1,
        cached: false,
      });
      expect(result.jobs).toHaveLength(10);
    });

    it('should clamp page_size to max 100', async () => {
      const jobs = Array.from({ length: 5 }, () => makeJob());
      const { controller } = createController({ jobs });

      const result = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,
        'true',
        '1',
        '999',  // exceeds max
      ) as any;

      expect(result.page_size).toBe(100);
    });

    it('should return null for next_page on last page', async () => {
      const jobs = [makeJob()];
      const { controller } = createController({ jobs });

      const result = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,
        'true',
        '1',
        '10',
      ) as any;

      expect(result.next_page).toBeNull();
      expect(result.previous_page).toBeNull();
    });
  });

  describe('POST /search — CSV export', () => {
    it('should return CSV when format=csv', async () => {
      const jobs = [
        makeJob({ title: 'SWE', companyName: 'Acme' }),
      ];
      const { controller } = createController({ jobs });

      const mockRes = {
        setHeader: jest.fn(),
      };

      const result = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        'csv',
        undefined,
        undefined,
        undefined,
        undefined,    // dedup
        undefined,    // liveness  (Spec 740)
        undefined,    // legitimacy (Spec 740)
        mockRes as any,
      );

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename=jobs.csv',
      );
      // Result should be a StreamableFile
      expect(result).toBeDefined();
    });

    it('neutralises formula titles and keeps object array items readable', async () => {
      const jobs = [
        makeJob({
          title: '=HYPERLINK("x")',
          locations: [{ city: 'A' }, { city: 'B' }] as any,
        }),
      ];
      const { controller } = createController({ jobs });
      const file = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        'csv',
        undefined, undefined, undefined, undefined, undefined, undefined,
        { setHeader: jest.fn() } as any,
      ) as StreamableFile;

      const chunks: Buffer[] = [];
      for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk));
      const csv = Buffer.concat(chunks).toString('utf8');

      expect(csv).toContain('"\'=HYPERLINK(""x"")"');
      expect(csv).not.toContain('[object Object]');
      expect(csv).toContain('{""city"":""A""}; {""city"":""B""}');
    });

    it('carries the Spec 1696 posted-time columns, empty for a job without them', async () => {
      const jobs = [
        makeJob({
          id: 'li-1',
          datePosted: '2026-09-24',
          datePostedAt: '2026-09-24T19:34:00.000Z',
          datePostedPrecision: DatePostedPrecision.MINUTE,
          datePostedBasis: DatePostedBasis.RELATIVE,
        }),
        makeJob({ id: 'lever-1', datePosted: '2026-09-20' }),
      ];
      const { controller } = createController({ jobs });
      const file = await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        'csv',
        undefined, undefined, undefined, undefined, undefined, undefined,
        { setHeader: jest.fn() } as any,
      ) as StreamableFile;

      const chunks: Buffer[] = [];
      for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk));
      const [header, first, second] = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n');
      const columns = header.split(',');
      const cell = (row: string, name: string) => row.split(',')[columns.indexOf(name)];
      for (const name of ['datePostedAt', 'datePostedPrecision', 'datePostedBasis']) {
        expect(columns).toContain(name);
      }
      expect(cell(first, 'datePostedAt')).toBe('2026-09-24T19:34:00.000Z');
      expect(cell(first, 'datePostedPrecision')).toBe('minute');
      expect(cell(first, 'datePostedBasis')).toBe('relative');
      expect(cell(second, 'datePostedAt')).toBe('');
      expect(cell(second, 'datePosted')).toBe('2026-09-20');
    });
  });

  describe('POST /search — persist flag (Spec 5024)', () => {
    /** Build a controller whose ConfigService reports a given store.persistSearch. */
    function createWithPersist(persistSearch: boolean, jobs: JobPostDto[]) {
      const jobsService = makeJobsService(jobs);
      const analyticsService = makeAnalyticsService();
      const cacheService = makeCacheService(undefined);
      const aggregator = makePassthroughAggregator();
      const configService = {
        get: (key: string, def?: unknown) =>
          key === 'store.persistSearch' ? persistSearch : def,
      };
      const controller = new JobsController(
        jobsService as any,
        aggregator as any,
        analyticsService as any,
        cacheService as any,
        configService as any,
      );
      return { controller, aggregator };
    }

    it('passes persist=true by default (historical behaviour)', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createWithPersist(true, jobs);

      await controller.searchJobs(new ScraperInputDto({ searchTerm: 'engineer' }));

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, {
        dedup: true,
        persist: true,
        deferCareerLevel: true,
      });
    });

    it('passes persist=false when EVER_JOBS_PERSIST_SEARCH is disabled', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createWithPersist(false, jobs);

      await controller.searchJobs(new ScraperInputDto({ searchTerm: 'engineer' }));

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, {
        dedup: true,
        persist: false,
        deferCareerLevel: true,
      });
    });

    it('the persist flag is independent of the dedup flag', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createWithPersist(false, jobs);

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'engineer' }),
        undefined,
        undefined,
        undefined,
        undefined,
        'false', // dedup=false
      );

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, {
        dedup: false,
        persist: false,
        deferCareerLevel: true,
      });
    });
  });

  describe('POST /search — dedup flag (Spec 003 / T14)', () => {
    it('defaults dedup=true when query param is absent', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createController({ jobs });

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
      );

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: true, persist: true, deferCareerLevel: true });
    });

    it('honours dedup=false explicitly', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createController({ jobs });

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,    // format
        undefined,    // paginate
        undefined,    // page
        undefined,    // page_size
        'false',      // dedup
      );

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: false, persist: true, deferCareerLevel: true });
    });

    it('honours dedup=0 explicitly', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createController({ jobs });

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,
        undefined,
        undefined,
        undefined,
        '0',
      );

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: false, persist: true, deferCareerLevel: true });
    });

    it('honours dedup=true explicitly', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createController({ jobs });

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,
        undefined,
        undefined,
        undefined,
        'true',
      );

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: true, persist: true, deferCareerLevel: true });
    });

    it('falls back to dedup=true on garbage values', async () => {
      const jobs = [makeJob()];
      const { controller, aggregator } = createController({ jobs });

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined,
        undefined,
        undefined,
        undefined,
        'not-a-bool',
      );

      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(jobs, { dedup: true, persist: true, deferCareerLevel: true });
    });

    it('runs dedup on cached responses too', async () => {
      const cachedJobs = [makeJob({ title: 'Cached' })];
      const { controller, jobsService, aggregator } = createController({ cachedValue: cachedJobs });

      await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
      );

      expect(jobsService.searchJobs).not.toHaveBeenCalled();
      expect(aggregator.aggregateRaw).toHaveBeenCalledWith(cachedJobs, { dedup: true, persist: true, deferCareerLevel: true });
    });

    it('caches RAW jobs (pre-dedup) so cache invalidation is independent of engine version', async () => {
      const jobs = [makeJob(), makeJob({ id: 'test-2' })];
      const { controller, cacheService } = createController({ jobs });

      await controller.searchJobs(new ScraperInputDto({ searchTerm: 'node' }));

      // Cache write should hold the unmodified raw list (Spec 1721 / FR-19: in
      // the one entry that also carries the completeness record).
      expect(cacheService.set).toHaveBeenCalledWith(expect.any(Object), { jobs });
    });

    it('returns dedup_metrics when the engine ran', async () => {
      const jobs = [makeJob(), makeJob({ id: 'test-2' })];
      const fakeMetrics = {
        inputCount: 2,
        outputCount: 1,
        mergedPairs: 1,
        elapsedMs: 4,
      };
      const aggregator = {
        aggregateRaw: jest.fn().mockResolvedValue({
          jobs: [jobs[0]],
          rawCount: 2,
          outputCount: 1,
          deduped: true,
          dedupMetrics: fakeMetrics,
        }),
        aggregate: jest.fn(),
      };
      const { controller } = createController({ jobs, aggregator });

      const result = (await controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
      )) as any;

      expect(result.deduped).toBe(true);
      expect(result.raw_count).toBe(2);
      expect(result.count).toBe(1);
      expect(result.dedup_metrics).toEqual(fakeMetrics);
    });
  });

  describe('POST /analyze', () => {
    it('should search then analyze jobs', async () => {
      const jobs = [makeJob()];
      const { controller, analyticsService } = createController({ jobs });

      const result = await controller.analyzeJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
      );

      expect(analyticsService.analyze).toHaveBeenCalledWith(jobs);
      expect(result.summary).toBeDefined();
      expect(result.summary.totalJobs).toBe(1);
    });
  });

  /**
   * `per_source` is opt-in because a full fan-out covers ~1 800 sources, and a
   * row for each put hundreds of KB of mostly-`ok`/`empty` noise on every
   * response. The summary must stay complete regardless of what is returned.
   */
  describe('per-source diagnostics (opt-in, filtered, capped)', () => {
    const perSource: SourceDiagnosticDto[] = [
      new SourceDiagnosticDto('linkedin', 3, 'ok'),
      new SourceDiagnosticDto('indeed', 0, 'empty'),
      new SourceDiagnosticDto('greenhouse', 0, 'blocked', 'cloudflare'),
      new SourceDiagnosticDto('gusto', 0, 'browser_unavailable', 'no chromium'),
      new SourceDiagnosticDto('workday', 0, 'circuit_open', 'circuit open for workday'),
    ];

    /** A controller whose fan-out reports the rows above. */
    function controllerWithDiagnostics() {
      const jobs = [makeJob()];
      const jobsService = {
        searchJobs: jest.fn().mockResolvedValue(jobs),
        searchJobsWithDiagnostics: jest.fn().mockResolvedValue({ jobs, perSource }),
      };
      return new JobsController(
        jobsService as any,
        makePassthroughAggregator() as any,
        makeAnalyticsService() as any,
        makeCacheService(undefined) as any,
        { get: (_k: string, d?: unknown) => d } as any,
      );
    }

    /** searchJobs(input, format, paginate, page, page_size, dedup, liveness, legitimacy, res, diagnostics, limit) */
    const search = (controller: JobsController, diagnostics?: string, limit?: string) =>
      controller.searchJobs(
        new ScraperInputDto({ searchTerm: 'node' }),
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined,
        diagnostics,
        limit,
      ) as any;

    it('returns no rows by default', async () => {
      const result = await search(controllerWithDiagnostics());

      expect(result.per_source).toEqual([]);
    });

    it('still reports complete counts by default', async () => {
      const result = await search(controllerWithDiagnostics());

      expect(result.per_source_summary).toMatchObject({
        total: 5,
        actionable: 3,
        returned: 0,
        by_reason: { ok: 1, empty: 1, blocked: 1, browser_unavailable: 1, circuit_open: 1 },
      });
    });

    it('returns only actionable rows for ?diagnostics=true', async () => {
      const result = await search(controllerWithDiagnostics(), 'true');

      expect(result.per_source.map((r: SourceDiagnosticDto) => r.site).sort()).toEqual(
        ['greenhouse', 'gusto', 'workday'],
      );
      expect(result.per_source_summary.returned).toBe(3);
    });

    it('returns every row for ?diagnostics=all', async () => {
      const result = await search(controllerWithDiagnostics(), 'all');

      expect(result.per_source).toHaveLength(5);
    });

    it('honours ?diagnostics_limit and reports the truncation', async () => {
      const result = await search(controllerWithDiagnostics(), 'all', '2');

      expect(result.per_source).toHaveLength(2);
      expect(result.per_source_summary).toMatchObject({ returned: 2, truncated: 3, total: 5 });
    });

    it.each(['false', '0', 'no', 'nonsense'])('treats ?diagnostics=%s as off', async (v) => {
      const result = await search(controllerWithDiagnostics(), v);

      expect(result.per_source).toEqual([]);
    });

    /**
     * `?diagnostics_limit=0` is the documented "no cap" escape hatch. The generic
     * `parseNum` helper returns `Number(v) || undefined`, so a literal zero is
     * falsy and silently fell through to the 200-row default — truncating the
     * exact request that asked not to be truncated.
     */
    it('treats ?diagnostics_limit=0 as no cap, not as the default', async () => {
      const many = Array.from(
        { length: 250 },
        (_, i) => new SourceDiagnosticDto(`s-${i}`, 0, 'blocked', 'nope'),
      );
      const jobsService = {
        searchJobs: jest.fn().mockResolvedValue([]),
        searchJobsWithDiagnostics: jest.fn().mockResolvedValue({ jobs: [], perSource: many }),
      };
      const controller = new JobsController(
        jobsService as any,
        makePassthroughAggregator() as any,
        makeAnalyticsService() as any,
        makeCacheService(undefined) as any,
        { get: (_k: string, d?: unknown) => d } as any,
      );

      const result = await search(controller, 'all', '0');

      expect(result.per_source).toHaveLength(250);
      expect(result.per_source_summary).toMatchObject({ returned: 250, truncated: 0 });
    });

    it('falls back to the default cap for a non-numeric limit', async () => {
      const result = await search(controllerWithDiagnostics(), 'all', 'abc');

      expect(result.per_source).toHaveLength(5);
      expect(result.per_source_summary.truncated).toBe(0);
    });
    describe('include_raw — Spec 5161', () => {
      const entry = {
        seq: 0,
        attempt: 0,
        method: 'GET',
        url: 'https://acme.example.com/jobs',
        status: 200,
        elapsed_ms: 12,
        body_bytes: 9,
        truncated: false,
        body: { jobs: [] },
      };

      // Obvious fakes — never a real-looking credential.
      const ADMIN_KEY = 'FAKE_ADMIN_KEY_123456';
      /** Fork-sync hardening: operator opt-in + auth on + a configured admin key. */
      const allowedConfig = {
        'rawCapture.enabled': true,
        'auth.enabled': true,
        'auth.apiKeys': [ADMIN_KEY],
      };
      const requestWithKey = (key?: string) =>
        ({ headers: key === undefined ? {} : { 'x-api-key': key } }) as any;

      // include_raw is the 12th positional query param; the request is the 14th.
      const searchRaw = (
        controller: JobsController,
        req: unknown = requestWithKey(ADMIN_KEY),
        input: ScraperInputDto = new ScraperInputDto({ siteType: ['linkedin' as never] }),
        format?: string,
      ) =>
        controller.searchJobs(
          input,
          format, undefined, undefined, undefined, undefined, undefined, undefined,
          undefined, undefined, undefined,
          'true',
          undefined,
          req as any,
        );

      it('passes captureRaw to the service and returns raw_by_source', async () => {
        const { controller, jobsService } = createController({
          jobs: [makeJob()],
          configValues: allowedConfig,
        });
        jobsService.searchJobsWithDiagnostics.mockResolvedValue({
          jobs: [makeJob()],
          perSource: [],
          rawBySource: { linkedin: [entry] },
        });

        const result = (await searchRaw(controller)) as any;

        expect(jobsService.searchJobsWithDiagnostics).toHaveBeenCalledWith(
          expect.any(ScraperInputDto),
          { captureRaw: true },
        );
        expect(result.raw_by_source).toEqual({ linkedin: [entry] });
      });

      it('skips the cache read when include_raw is set', async () => {
        const { controller, cacheService } = createController({
          jobs: [makeJob()],
          cachedValue: [makeJob()],
          configValues: allowedConfig,
        });
        await searchRaw(controller);
        expect(cacheService.get).not.toHaveBeenCalled();
      });

      it('omits raw_by_source entirely when the flag is absent', async () => {
        const { controller } = createController({ jobs: [makeJob()] });
        const result = (await controller.searchJobs(
          new ScraperInputDto({ siteType: ['linkedin' as never] }),
        )) as any;
        expect('raw_by_source' in result).toBe(false);
      });

      it('returns no raw_by_source on a later request without the flag (cache round-trip)', async () => {
        const jobs = [makeJob()];
        const { controller, jobsService, cacheService } = createController({
          jobs,
          configValues: allowedConfig,
        });
        jobsService.searchJobsWithDiagnostics.mockResolvedValue({
          jobs,
          perSource: [],
          rawBySource: { linkedin: [entry] },
        });

        // First request: capture on, writes the raw job list to cache.
        await searchRaw(controller);
        const cachedWrite = cacheService.set.mock.calls[0][1];
        expect(cachedWrite.jobs).toBe(jobs);
        expect(cachedWrite.raw_by_source).toBeUndefined();

        // Second request: flag off, cache hit — response carries no capture key.
        cacheService.get.mockReturnValueOnce(cachedWrite);
        const result = (await controller.searchJobs(
          new ScraperInputDto({ siteType: ['linkedin' as never] }),
        )) as any;
        expect(result.cached).toBe(true);
        expect('raw_by_source' in result).toBe(false);
      });

      describe('access gate (fork-sync hardening)', () => {
        it('is refused with 403 while the operator flag is off, even with auth on and an admin key', async () => {
          const { controller, jobsService, cacheService } = createController({
            jobs: [makeJob()],
            configValues: { ...allowedConfig, 'rawCapture.enabled': false },
          });
          await expect(searchRaw(controller)).rejects.toBeInstanceOf(ForbiddenException);
          await expect(searchRaw(controller)).rejects.toThrow(/EVER_JOBS_INCLUDE_RAW_ENABLED/);
          expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
          expect(cacheService.get).not.toHaveBeenCalled();
        });

        it('is refused while the flag is unset (default off)', async () => {
          const { controller, jobsService } = createController({ jobs: [makeJob()] });
          await expect(searchRaw(controller)).rejects.toBeInstanceOf(ForbiddenException);
          expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
        });

        it('is refused with 503 while API key auth is off, even with a configured key', async () => {
          const { controller, jobsService } = createController({
            jobs: [makeJob()],
            configValues: { ...allowedConfig, 'auth.enabled': false },
          });
          await expect(searchRaw(controller)).rejects.toBeInstanceOf(ServiceUnavailableException);
          expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
        });

        it('is refused with 503 when no API keys are configured (same as @AdminAuth)', async () => {
          const { controller, jobsService } = createController({
            jobs: [makeJob()],
            configValues: { ...allowedConfig, 'auth.apiKeys': [] },
          });
          await expect(searchRaw(controller)).rejects.toBeInstanceOf(ServiceUnavailableException);
          expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
        });

        it('is refused with 401 without an API key (same as @AdminAuth)', async () => {
          const { controller, jobsService } = createController({
            jobs: [makeJob()],
            configValues: allowedConfig,
          });
          await expect(searchRaw(controller, requestWithKey())).rejects.toBeInstanceOf(
            UnauthorizedException,
          );
          // No request object at all is treated as a missing key.
          await expect(searchRaw(controller, null)).rejects.toBeInstanceOf(
            UnauthorizedException,
          );
          expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
        });

        it('is refused with 401 for a key that is not an admin key', async () => {
          const { controller, jobsService } = createController({
            jobs: [makeJob()],
            configValues: allowedConfig,
          });
          await expect(
            searchRaw(controller, requestWithKey('FAKE_OTHER_KEY_654321')),
          ).rejects.toBeInstanceOf(UnauthorizedException);
          expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
        });

        it('reads the key from the configured header name', async () => {
          const { controller, jobsService } = createController({
            jobs: [makeJob()],
            configValues: { ...allowedConfig, 'auth.headerName': 'X-Ever-Key' },
          });
          await searchRaw(controller, { headers: { 'x-ever-key': ADMIN_KEY } });
          expect(jobsService.searchJobsWithDiagnostics).toHaveBeenCalledWith(
            expect.any(ScraperInputDto),
            { captureRaw: true },
          );
        });

        it('leaves the endpoint public without include_raw', async () => {
          const { controller, jobsService } = createController({ jobs: [makeJob()] });
          await controller.searchJobs(
            new ScraperInputDto({ siteType: ['linkedin' as never] }),
            undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined,
            'false',
          );
          expect(jobsService.searchJobsWithDiagnostics).toHaveBeenCalledWith(
            expect.any(ScraperInputDto),
            { captureRaw: false },
          );
        });

        it('gates format=ndjson too, before the stream starts', async () => {
          const { controller, jobsService } = createController({ jobs: [makeJob()] });
          (jobsService as any).assertSearchable = jest.fn();
          await expect(
            searchRaw(controller, requestWithKey(ADMIN_KEY), undefined, 'ndjson'),
          ).rejects.toBeInstanceOf(ForbiddenException);
          expect((jobsService as any).assertSearchable).not.toHaveBeenCalled();
        });
      });

      describe('concurrency limit (fork-sync hardening)', () => {
        /** A service call that stays pending until the test releases it. */
        function pendingSearch(jobsService: ReturnType<typeof createController>['jobsService']) {
          const releases: Array<() => void> = [];
          jobsService.searchJobsWithDiagnostics.mockImplementation(
            () =>
              new Promise((resolve) => {
                releases.push(() => resolve({ jobs: [], perSource: [], rawBySource: {} }));
              }),
          );
          return releases;
        }

        it('answers 429 once rawCapture.maxConcurrent captures are running, and frees the slot after', async () => {
          const { controller, jobsService } = createController({
            jobs: [],
            configValues: { ...allowedConfig, 'rawCapture.maxConcurrent': 2 },
          });
          const releases = pendingSearch(jobsService);

          const first = searchRaw(controller);
          const second = searchRaw(controller);
          await new Promise((resolve) => setImmediate(resolve));
          const refused = await searchRaw(controller).catch((err: unknown) => err);
          expect(refused).toBeInstanceOf(HttpException);
          expect((refused as HttpException).getStatus()).toBe(429);

          releases.forEach((release) => release());
          await Promise.all([first, second]);

          jobsService.searchJobsWithDiagnostics.mockResolvedValue({
            jobs: [],
            perSource: [],
            rawBySource: {},
          });
          await expect(searchRaw(controller)).resolves.toBeDefined();
        });

        it('frees the slot when the search fails', async () => {
          const { controller, jobsService } = createController({
            jobs: [],
            configValues: { ...allowedConfig, 'rawCapture.maxConcurrent': 1 },
          });
          jobsService.searchJobsWithDiagnostics.mockRejectedValueOnce(new Error('boom'));
          await expect(searchRaw(controller)).rejects.toThrow('boom');

          jobsService.searchJobsWithDiagnostics.mockResolvedValue({
            jobs: [],
            perSource: [],
            rawBySource: {},
          });
          await expect(searchRaw(controller)).resolves.toBeDefined();
        });

        it('does not count searches without include_raw', async () => {
          const { controller, jobsService } = createController({
            jobs: [],
            configValues: { ...allowedConfig, 'rawCapture.maxConcurrent': 1 },
          });
          const releases = pendingSearch(jobsService);
          const plain = controller.searchJobs(
            new ScraperInputDto({ siteType: ['linkedin' as never] }),
          );
          await new Promise((resolve) => setImmediate(resolve));
          const raw = searchRaw(controller);
          await new Promise((resolve) => setImmediate(resolve));
          releases.forEach((release) => release());
          await expect(Promise.all([plain, raw])).resolves.toHaveLength(2);
        });
      });
    });

    describe('deadline_ms — Spec 5164', () => {
      const input = () => new ScraperInputDto({ siteType: ['linkedin' as never] });
      // deadline_ms is the 13th positional query param (after include_raw).
      const search = (controller: JobsController, deadline?: unknown, res?: unknown) =>
        controller.searchJobs(
          input(),
          undefined, undefined, undefined, undefined, undefined, undefined, undefined,
          res as any, undefined, undefined, undefined,
          deadline as string,
        );
      const calledWithDeadline = (
        jobsService: ReturnType<typeof createController>['jobsService'],
        deadlineMs: number | undefined,
      ) =>
        expect(jobsService.searchJobsWithDiagnostics).toHaveBeenCalledWith(
          expect.any(ScraperInputDto),
          { captureRaw: false, deadlineMs },
        );

      it('absent → service receives no override', async () => {
        const { controller, jobsService } = createController({ jobs: [makeJob()] });
        await search(controller, undefined);
        calledWithDeadline(jobsService, undefined);
      });

      it('a value below the server deadline is used as given (callers may shorten it)', async () => {
        const { controller, jobsService } = createController({ jobs: [makeJob()] });
        await search(controller, '60000');
        calledWithDeadline(jobsService, 60000);
      });

      it('a value above the server deadline is capped to it when no max is set', async () => {
        const { controller, jobsService } = createController({ jobs: [makeJob()] });
        await search(controller, '300000');
        calledWithDeadline(jobsService, 120_000);
      });

      it('the cap follows the configured server deadline', async () => {
        const { controller, jobsService } = createController({
          jobs: [makeJob()],
          configValues: { 'search.deadlineMs': 45_000 },
        });
        await search(controller, '300000');
        calledWithDeadline(jobsService, 45_000);
      });

      it('deadline_ms=0 without the operator opt-in is capped, never unbounded', async () => {
        const { controller, jobsService } = createController({ jobs: [makeJob()] });
        await search(controller, '0');
        calledWithDeadline(jobsService, 120_000);
      });

      it('deadline_ms=0 disables the deadline only with EVER_JOBS_SEARCH_DEADLINE_ALLOW_UNBOUNDED', async () => {
        const { controller, jobsService } = createController({
          jobs: [makeJob()],
          configValues: { 'search.deadlineAllowUnbounded': true },
        });
        await search(controller, '0');
        calledWithDeadline(jobsService, 0);
      });

      it('the opt-in also lifts the ceiling for positive values', async () => {
        const { controller, jobsService } = createController({
          jobs: [makeJob()],
          configValues: { 'search.deadlineAllowUnbounded': true },
        });
        await search(controller, '300000');
        calledWithDeadline(jobsService, 300000);
      });

      it('deadline_ms=0 stays 0 when the operator runs with no deadline at all', async () => {
        const { controller, jobsService } = createController({
          jobs: [makeJob()],
          configValues: { 'search.deadlineMs': 0 },
        });
        await search(controller, '0');
        calledWithDeadline(jobsService, 0);
      });

      it('an operator max above the deadline lets callers extend up to it', async () => {
        const { controller, jobsService } = createController({
          jobs: [makeJob()],
          configValues: { 'search.deadlineMaxMs': 240_000 },
        });
        await search(controller, '240000');
        calledWithDeadline(jobsService, 240000);
      });

      it('a value above the operator max is capped to the max', async () => {
        const { controller, jobsService } = createController({
          jobs: [makeJob()],
          configValues: { 'search.deadlineMaxMs': 240_000 },
        });
        await search(controller, '300000');
        calledWithDeadline(jobsService, 240_000);
      });

      it('deadline_ms=0 is capped to the operator max', async () => {
        const { controller, jobsService } = createController({
          jobs: [makeJob()],
          configValues: { 'search.deadlineMaxMs': 240_000 },
        });
        await search(controller, '0');
        calledWithDeadline(jobsService, 240_000);
      });

      it('an invalid max read back from config fails closed to the server deadline', async () => {
        for (const bad of [-5, 0, Number.NaN, 'abc']) {
          const { controller, jobsService } = createController({
            jobs: [makeJob()],
            configValues: { 'search.deadlineMaxMs': bad },
          });
          await search(controller, '0');
          calledWithDeadline(jobsService, 120_000);
        }
      });

      it('never passes a value setTimeout cannot hold', async () => {
        const { controller, jobsService } = createController({
          jobs: [makeJob()],
          configValues: { 'search.deadlineAllowUnbounded': true },
        });
        await search(controller, '3000000000');
        calledWithDeadline(jobsService, 2_147_483_647);
      });

      it('reports the deadline actually used in X-Search-Deadline-Ms', async () => {
        const { controller } = createController({ jobs: [makeJob()] });
        const res = { setHeader: jest.fn() };
        await search(controller, '0', res);
        expect(res.setHeader).toHaveBeenCalledWith('X-Search-Deadline-Ms', '120000');
      });

      it('empty or blank values → 400 (no longer read as 0)', async () => {
        const { controller, jobsService } = createController({ jobs: [makeJob()] });
        await expect(search(controller, '')).rejects.toBeInstanceOf(BadRequestException);
        await expect(search(controller, '   ')).rejects.toBeInstanceOf(BadRequestException);
        expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
      });

      it('non-numeric, negative, fractional and repeated values → 400', async () => {
        const { controller } = createController({ jobs: [makeJob()] });
        await expect(search(controller, 'abc')).rejects.toThrow(/non-negative/);
        await expect(search(controller, '-5')).rejects.toThrow(/non-negative/);
        await expect(search(controller, '1.5')).rejects.toThrow(/integer/);
        await expect(search(controller, 'Infinity')).rejects.toThrow(/non-negative/);
        await expect(search(controller, ['1000', '0'])).rejects.toBeInstanceOf(BadRequestException);
      });

      it('does not leak into cacheParams', async () => {
        const { controller, cacheService } = createController({ jobs: [makeJob()] });
        await search(controller, '60000');
        const cacheKey = cacheService.set.mock.calls[0][0];
        expect(cacheKey).not.toHaveProperty('deadline_ms');
        expect(cacheKey).not.toHaveProperty('deadlineMs');
      });

      it('a cached result is still served to a deadline_ms request', async () => {
        const cached = [makeJob()];
        const { controller, jobsService, cacheService } = createController({
          jobs: [makeJob()],
          cachedValue: cached,
        });
        const result = (await search(controller, '60000')) as any;
        expect(cacheService.get).toHaveBeenCalled();
        expect(jobsService.searchJobsWithDiagnostics).not.toHaveBeenCalled();
        expect(result.cached).toBe(true);
      });

      it('a failed single-source result is not written to cache', async () => {
        const { controller, jobsService, cacheService } = createController({ jobs: [] });
        jobsService.searchJobsWithDiagnostics.mockResolvedValue({
          jobs: [],
          perSource: [new SourceDiagnosticDto('adp', 0, 'timeout', 'deadline exceeded')],
          rawBySource: {},
        });
        await search(controller, '60000');
        expect(cacheService.set).not.toHaveBeenCalled();
      });

      it('a partial single-source result is not written to cache either', async () => {
        const jobs = [makeJob()];
        const { controller, jobsService, cacheService } = createController({ jobs });
        jobsService.searchJobsWithDiagnostics.mockResolvedValue({
          jobs,
          perSource: [new SourceDiagnosticDto('adp', 1, 'partial', '30 postings then 403')],
          rawBySource: {},
        });
        await search(controller, '60000');
        expect(cacheService.set).not.toHaveBeenCalled();
      });

      it('an ok single-source result is still cached', async () => {
        const jobs = [makeJob()];
        const { controller, jobsService, cacheService } = createController({ jobs });
        jobsService.searchJobsWithDiagnostics.mockResolvedValue({
          jobs,
          perSource: [new SourceDiagnosticDto('adp', 1, 'ok')],
          rawBySource: {},
        });
        await search(controller, '60000');
        expect(cacheService.set).toHaveBeenCalledWith(expect.any(Object), { jobs });
      });

      it('a multi-source search with a failing source still writes to cache', async () => {
        const jobs = [makeJob()];
        const { controller, jobsService, cacheService } = createController({ jobs });
        jobsService.searchJobsWithDiagnostics.mockResolvedValue({
          jobs,
          perSource: [
            new SourceDiagnosticDto('linkedin', 1, 'ok'),
            new SourceDiagnosticDto('ashby', 0, 'fetch_error', 'boom'),
          ],
          rawBySource: {},
        });
        await search(controller, '60000');
        expect(cacheService.set).toHaveBeenCalledWith(expect.any(Object), { jobs });
      });
    });
   });
});
