import axios from 'axios';
import { Site } from '@ever-jobs/models';
import {
  MCP_DEFAULT_SEARCH_LIMIT,
  MCP_LOCATION_FORMAT_ENV_VAR,
  MCP_MAX_SEARCH_LIMIT,
  MCP_RECENT_JOBS_LIMIT,
  MCP_REQUEST_KEYS_ENV_VAR,
  buildSearchRequestBody,
  describeRequestError,
  displayApiUrl,
  formatJobLocation,
  getJobDetails,
  getSalaryInsights,
  normalizeSearchLimit,
  listSources,
  readLocationFormat,
  readSearchRequestKeyStyle,
  recentJobCount,
  searchJobs,
  searchRemoteJobs,
} from '../src/tools';

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn() },
}));

/**
 * Spec 1689 — the MCP ↔ REST contract.
 *
 * Two defects surfaced when the structured location parser landed:
 *  1. `location` was read as `job.location?.city ?? job.location`, which
 *     returned a partial string for multi-part places and the whole
 *     `LocationDto` object for city-less ones.
 *  2. The search body used snake_case keys that `ScraperInputDto` does not
 *     declare, so the API's whitelisting ValidationPipe stripped the search
 *     term, source filter and page size.
 */

const createMock = axios.create as unknown as jest.Mock;

function mockClient(response: { post?: unknown; get?: unknown }) {
  const client = {
    post: jest.fn().mockResolvedValue({ data: response.post ?? { jobs: [] } }),
    get: jest.fn().mockResolvedValue({ data: response.get ?? {} }),
  };
  createMock.mockReturnValue(client);
  return client;
}

function apiJob(location: unknown) {
  return {
    id: 'j1',
    title: 'Engineer',
    companyName: 'Acme',
    jobUrl: 'https://acme.example.com/j1',
    site: 'lever',
    isRemote: location == null,
    location,
  };
}

const ENV_KEYS = [MCP_LOCATION_FORMAT_ENV_VAR, MCP_REQUEST_KEYS_ENV_VAR];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  createMock.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('formatJobLocation', () => {
  it('renders a full city/state/country location as one string', () => {
    expect(
      formatJobLocation({ city: 'San Francisco', state: 'CA', country: 'United States' }),
    ).toBe('San Francisco, CA, United States');
  });

  it('renders a city-less location instead of returning the object', () => {
    expect(formatJobLocation({ state: 'VA', country: 'United States' })).toBe(
      'VA, United States',
    );
  });

  it('renders a country-only location', () => {
    expect(formatJobLocation({ country: 'Germany' })).toBe('Germany');
  });

  it('returns null for a remote-only job with no location', () => {
    expect(formatJobLocation(null)).toBeNull();
    expect(formatJobLocation(undefined)).toBeNull();
  });

  it('returns null for an empty location object', () => {
    expect(formatJobLocation({})).toBeNull();
    expect(formatJobLocation({ city: '  ', state: null })).toBeNull();
  });

  it('falls back to name, then text, when there is no geography', () => {
    expect(formatJobLocation({ name: 'Downtown Office', text: 'HQ building' })).toBe(
      'Downtown Office',
    );
    expect(formatJobLocation({ text: 'Somewhere nice' })).toBe('Somewhere nice');
  });

  it('passes a plain-string location through', () => {
    expect(formatJobLocation('Berlin, Germany')).toBe('Berlin, Germany');
    expect(formatJobLocation('   ')).toBeNull();
  });

  it('never returns a non-string', () => {
    for (const input of [42, true, [], { city: 7 }]) {
      const out = formatJobLocation(input);
      expect(out === null || typeof out === 'string').toBe(true);
    }
  });

  it('legacy "city" format returns the city alone when there is one', () => {
    expect(
      formatJobLocation({ city: 'San Francisco', state: 'CA', country: 'United States' }, 'city'),
    ).toBe('San Francisco');
  });

  it('legacy "city" format still renders a string for city-less locations', () => {
    expect(formatJobLocation({ state: 'VA', country: 'United States' }, 'city')).toBe(
      'VA, United States',
    );
    expect(formatJobLocation(null, 'city')).toBeNull();
  });
});

describe('readLocationFormat / readSearchRequestKeyStyle', () => {
  it('default to full / camel', () => {
    expect(readLocationFormat({})).toBe('full');
    expect(readSearchRequestKeyStyle({})).toBe('camel');
  });

  it('accept the documented values case-insensitively', () => {
    expect(readLocationFormat({ [MCP_LOCATION_FORMAT_ENV_VAR]: ' City ' })).toBe('city');
    expect(readSearchRequestKeyStyle({ [MCP_REQUEST_KEYS_ENV_VAR]: 'SNAKE' })).toBe('snake');
    expect(readSearchRequestKeyStyle({ [MCP_REQUEST_KEYS_ENV_VAR]: 'both' })).toBe('both');
  });

  it('fall back to the defaults on unknown values', () => {
    expect(readLocationFormat({ [MCP_LOCATION_FORMAT_ENV_VAR]: 'weird' })).toBe('full');
    expect(readSearchRequestKeyStyle({ [MCP_REQUEST_KEYS_ENV_VAR]: 'kebab' })).toBe('camel');
  });
});

describe('buildSearchRequestBody', () => {
  const params = { query: 'rust engineer', location: 'Berlin', source: 'lever', company: 'acme', limit: 500 };

  it('uses the camelCase keys ScraperInputDto declares by default', () => {
    expect(buildSearchRequestBody(params)).toEqual({
      searchTerm: 'rust engineer',
      location: 'Berlin',
      siteType: ['lever'],
      companySlug: 'acme',
      resultsWanted: 100,
    });
  });

  it('keeps the legacy snake_case shape available', () => {
    expect(buildSearchRequestBody(params, 'snake')).toEqual({
      search_term: 'rust engineer',
      location: 'Berlin',
      site_type: ['lever'],
      company_slug: 'acme',
      results_wanted: 100,
    });
  });

  it('"both" sends both spellings', () => {
    const body = buildSearchRequestBody(params, 'both');
    expect(body).toMatchObject({ searchTerm: 'rust engineer', search_term: 'rust engineer' });
    expect(body).toMatchObject({ resultsWanted: 100, results_wanted: 100 });
  });

  it('adds the Spec 1690 crawl object under the same key in every style', () => {
    const crawl = { maxConcurrentPerHost: 1, discovery: 'sitemap' };
    for (const style of ['camel', 'snake', 'both'] as const) {
      expect(buildSearchRequestBody({ ...params, crawl }, style).crawl).toEqual(crawl);
      expect(buildSearchRequestBody(params, style)).not.toHaveProperty('crawl');
    }
  });

  it('omits an absent source and company in every style instead of sending undefined keys', () => {
    expect(Object.keys(buildSearchRequestBody({ query: 'x' }, 'camel')).sort()).toEqual(
      ['location', 'resultsWanted', 'searchTerm'],
    );
    expect(Object.keys(buildSearchRequestBody({ query: 'x' }, 'snake')).sort()).toEqual(
      ['location', 'results_wanted', 'search_term'],
    );
  });

  // T-2546 — `sources` is a list of boards, sent only when `source` is not set.
  it('sends no siteType key when there is neither a source nor sources', () => {
    for (const style of ['camel', 'snake', 'both'] as const) {
      const body = buildSearchRequestBody({ query: 'x' }, style);
      expect(body).not.toHaveProperty('siteType');
      expect(body).not.toHaveProperty('site_type');
    }
    expect(buildSearchRequestBody({ query: 'x', sources: [] })).not.toHaveProperty('siteType');
  });

  it('sends sources as siteType / site_type when no single source is given', () => {
    const sources = ['remotive', 'remoteok'];
    expect(buildSearchRequestBody({ query: 'x', sources }, 'camel')).toEqual({
      searchTerm: 'x',
      location: '',
      siteType: ['remotive', 'remoteok'],
      resultsWanted: 20,
    });
    expect(buildSearchRequestBody({ query: 'x', sources }, 'snake')).toEqual({
      search_term: 'x',
      location: '',
      site_type: ['remotive', 'remoteok'],
      results_wanted: 20,
    });
  });

  it('lets a single source win over sources', () => {
    expect(
      buildSearchRequestBody({ query: 'x', source: 'lever', sources: ['remotive', 'remoteok'] }).siteType,
    ).toEqual(['lever']);
  });
});

/**
 * T-2546 — search_remote_jobs must search the remote-first boards, not the
 * whole catalogue. Before the fix it sent no siteType unless `source` named a
 * remote board, so the API fanned out over every non-ATS source.
 */
describe('searchRemoteJobs — searches the remote boards', () => {
  const REMOTE_IDS = listSources('remote').sources.map((s) => s.id);

  it('the catalogue lists remote boards', () => {
    expect(REMOTE_IDS.length).toBeGreaterThan(0);
    expect(REMOTE_IDS).toEqual(expect.arrayContaining(['remotive', 'remoteok', 'weworkremotely']));
  });

  // Every remote id is now always sent, and the API checks siteType with
  // `@IsEnum(Site, { each: true })`: one id that is not a `Site` value would
  // turn every search_remote_jobs call into a 400.
  it('every remote board is a Site value the API accepts', () => {
    const sites = new Set<string>(Object.values(Site));
    expect(REMOTE_IDS.filter((id) => !sites.has(id))).toEqual([]);
  });

  it('posts every remote board as siteType when no source is given', async () => {
    const client = mockClient({ post: { jobs: [] } });
    const result = await searchRemoteJobs({ query: 'backend' });

    expect(client.post).toHaveBeenCalledTimes(1);
    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe('/api/jobs/search');
    expect(body.siteType).toEqual(REMOTE_IDS);
    expect(body).toMatchObject({ searchTerm: 'backend', location: 'Remote', resultsWanted: 25 });
    expect(result.sources_searched).toEqual(REMOTE_IDS);
  });

  it('posts the remote boards, not the whole catalogue, when source is not a remote board', async () => {
    const client = mockClient({ post: { jobs: [] } });
    const result = await searchRemoteJobs({ query: 'backend', source: 'linkedin' });

    const body = client.post.mock.calls[0][1];
    expect(body.siteType).toEqual(REMOTE_IDS);
    expect(body.siteType).not.toContain('linkedin');
    expect(result.sources_searched).toEqual(REMOTE_IDS);
  });

  it('posts only the named board when source is a remote board', async () => {
    const client = mockClient({ post: { jobs: [] } });
    const result = await searchRemoteJobs({ query: 'backend', source: 'remotive' });

    expect(client.post.mock.calls[0][1].siteType).toEqual(['remotive']);
    expect(result.sources_searched).toEqual(['remotive']);
  });

  it('sends the remote boards as site_type with EVER_JOBS_MCP_REQUEST_KEYS=snake', async () => {
    process.env[MCP_REQUEST_KEYS_ENV_VAR] = 'snake';
    const client = mockClient({ post: { jobs: [] } });
    await searchRemoteJobs({ query: 'backend' });

    const body = client.post.mock.calls[0][1];
    expect(body.site_type).toEqual(REMOTE_IDS);
    expect(body).not.toHaveProperty('siteType');
  });
});

describe('searchJobs — wire contract', () => {
  it('posts camelCase keys to /api/jobs/search', async () => {
    const client = mockClient({ post: { jobs: [] } });
    await searchJobs({ query: 'data scientist', location: 'Remote', source: 'lever', company: 'acme', limit: 30 });

    expect(client.post).toHaveBeenCalledTimes(1);
    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe('/api/jobs/search');
    expect(Object.keys(body).sort()).toEqual(
      ['companySlug', 'location', 'resultsWanted', 'searchTerm', 'siteType'].sort(),
    );
    expect(body).toEqual({
      searchTerm: 'data scientist',
      location: 'Remote',
      siteType: ['lever'],
      companySlug: 'acme',
      resultsWanted: 30,
    });
    // The JSON that actually goes on the wire carries no snake_case keys.
    expect(JSON.stringify(body)).not.toMatch(/search_term|site_type|company_slug|results_wanted/);
  });

  it('honours EVER_JOBS_MCP_REQUEST_KEYS=snake', async () => {
    process.env[MCP_REQUEST_KEYS_ENV_VAR] = 'snake';
    const client = mockClient({ post: { jobs: [] } });
    await searchJobs({ query: 'x' });
    expect(client.post.mock.calls[0][1]).toHaveProperty('search_term', 'x');
    expect(client.post.mock.calls[0][1]).not.toHaveProperty('searchTerm');
  });

  it('renders every job location as a string or null', async () => {
    mockClient({
      post: {
        jobs: [
          apiJob({ city: 'San Francisco', state: 'CA', country: 'United States' }),
          apiJob({ state: 'VA', country: 'United States' }),
          apiJob({ country: 'United States' }),
          apiJob(null),
        ],
      },
    });
    const result = await searchJobs({ query: 'x' });
    expect(result.jobs.map((j) => j.location)).toEqual([
      'San Francisco, CA, United States',
      'VA, United States',
      'United States',
      null,
    ]);
  });

  it('honours EVER_JOBS_MCP_LOCATION_FORMAT=city', async () => {
    process.env[MCP_LOCATION_FORMAT_ENV_VAR] = 'city';
    mockClient({
      post: {
        jobs: [
          apiJob({ city: 'San Francisco', state: 'CA', country: 'United States' }),
          apiJob({ country: 'United States' }),
        ],
      },
    });
    const result = await searchJobs({ query: 'x' });
    expect(result.jobs.map((j) => j.location)).toEqual(['San Francisco', 'United States']);
  });
});

/**
 * T-2585 — `limit` is the most jobs a search tool returns. The API applies
 * `resultsWanted` per source (and per location when `locations` is set), so an
 * unfiltered search can answer with far more jobs than were asked for.
 */
describe('search tools — limit caps the jobs returned (T-2585)', () => {
  function apiJobs(count: number, isRemote: boolean, idPrefix: string) {
    return Array.from({ length: count }, (_, i) => ({
      id: `${idPrefix}${i}`,
      title: 'Engineer',
      companyName: 'Acme',
      jobUrl: `https://acme.example.com/${idPrefix}${i}`,
      site: 'lever',
      isRemote,
      location: null,
      compensation: { minAmount: 90_000 + i, maxAmount: 120_000 + i, currency: 'USD' },
    }));
  }

  it('returns at most `limit` jobs, in API order, and reports how many were found', async () => {
    mockClient({ post: { jobs: apiJobs(150, false, 'j') } });
    const result = await searchJobs({ query: 'x', limit: 20 });

    expect(result.jobs).toHaveLength(20);
    expect(result.jobs.map((j) => j.id)).toEqual(Array.from({ length: 20 }, (_, i) => `j${i}`));
    expect(result.total).toBe(20);
    expect(result.total_found).toBe(150);
  });

  it('applies remote_only before the cut, so remote jobs listed after the others are kept', async () => {
    mockClient({ post: { jobs: [...apiJobs(100, false, 'onsite'), ...apiJobs(50, true, 'remote')] } });
    const result = await searchJobs({ query: 'x', limit: 20, remoteOnly: true });

    expect(result.jobs).toHaveLength(20);
    expect(result.jobs.every((j) => j.is_remote)).toBe(true);
    expect(result.jobs.map((j) => j.id)).toEqual(Array.from({ length: 20 }, (_, i) => `remote${i}`));
    expect(result.total).toBe(20);
    expect(result.total_found).toBe(50);
  });

  it('treats a limit that is not a number as the default 20 (sent and returned)', async () => {
    const client = mockClient({ post: { jobs: apiJobs(150, false, 'j') } });
    const result = await searchJobs({ query: 'x', limit: 'abc' as unknown as number });

    expect(client.post.mock.calls[0][1]).toHaveProperty('resultsWanted', 20);
    expect(result.jobs).toHaveLength(20);
    expect(result.total_found).toBe(150);
  });

  it('leaves a response within the limit as it was, with no total_found', async () => {
    mockClient({ post: { jobs: apiJobs(5, false, 'j') } });
    const result = await searchJobs({ query: 'x', limit: 20 });

    expect(result.jobs).toHaveLength(5);
    expect(result.total).toBe(5);
    expect(result).not.toHaveProperty('total_found');
  });

  it('search_remote_jobs returns at most its default of 25 jobs', async () => {
    mockClient({ post: { jobs: apiJobs(150, true, 'r') } });
    const result = await searchRemoteJobs({ query: 'x' });

    expect(result.jobs).toHaveLength(25);
    expect(result.total_found).toBe(150);
  });

  it('get_salary_insights samples at most `limit` jobs', async () => {
    mockClient({ post: { jobs: apiJobs(150, false, 'j') } });
    const insights = await getSalaryInsights({ query: 'x', limit: 30 });

    expect(insights.totalJobsSearched).toBe(30);
    expect(insights.jobsWithSalary).toBe(30);
  });

  /** The API sorts by site name, then newest first (`JobsService.searchJobs`). */
  function sortedBySite(perSite: Record<string, number>, isRemote = false) {
    return Object.keys(perSite)
      .sort()
      .flatMap((site) => apiJobs(perSite[site], isRemote, `${site}-`).map((job) => ({ ...job, site })));
  }

  it('shares the cut across sources instead of keeping only the first site in alphabetical order', async () => {
    mockClient({ post: { jobs: sortedBySite({ lever: 30, adzuna: 30, indeed: 30 }) } });
    const result = await searchJobs({ query: 'x', limit: 20 });

    expect(result.jobs).toHaveLength(20);
    expect(result.total_found).toBe(90);
    const perSource = result.jobs.reduce<Record<string, number>>((acc, j) => {
      acc[j.source] = (acc[j.source] ?? 0) + 1;
      return acc;
    }, {});
    expect(perSource).toEqual({ adzuna: 7, indeed: 7, lever: 6 });
    // Each source keeps its newest jobs, and the list keeps the API's order.
    expect(result.jobs.map((j) => j.id)).toEqual([
      ...Array.from({ length: 7 }, (_, i) => `adzuna-${i}`),
      ...Array.from({ length: 7 }, (_, i) => `indeed-${i}`),
      ...Array.from({ length: 6 }, (_, i) => `lever-${i}`),
    ]);
  });

  it('gives a source with few jobs all of them and fills the rest from the others', async () => {
    mockClient({ post: { jobs: sortedBySite({ adzuna: 2, indeed: 50 }) } });
    const result = await searchJobs({ query: 'x', limit: 10 });

    expect(result.jobs.map((j) => j.id)).toEqual([
      'adzuna-0',
      'adzuna-1',
      ...Array.from({ length: 8 }, (_, i) => `indeed-${i}`),
    ]);
  });

  it('search_remote_jobs keeps jobs from every remote board that answered', async () => {
    const boards = { arbeitnow: 25, himalayas: 25, jobicy: 25, remoteok: 25, remotive: 25 };
    mockClient({ post: { jobs: sortedBySite(boards, true) } });
    const result = await searchRemoteJobs({ query: 'x' });

    expect(result.jobs).toHaveLength(25);
    expect(new Set(result.jobs.map((j) => j.source))).toEqual(new Set(Object.keys(boards)));
  });
});

describe('normalizeSearchLimit (T-2585)', () => {
  it('gives the default 20 for a missing, non-numeric or below-1 limit', () => {
    for (const input of [undefined, null, 'abc', '', '  ', NaN, -Infinity, 0, -5, 0.5, true, [5], {}]) {
      expect(normalizeSearchLimit(input)).toBe(MCP_DEFAULT_SEARCH_LIMIT);
    }
    expect(MCP_DEFAULT_SEARCH_LIMIT).toBe(20);
  });

  it('rounds down to a whole number and caps it at 100', () => {
    expect(normalizeSearchLimit(1)).toBe(1);
    expect(normalizeSearchLimit(30)).toBe(30);
    expect(normalizeSearchLimit(2.7)).toBe(2);
    expect(normalizeSearchLimit('30')).toBe(30);
    expect(normalizeSearchLimit(100)).toBe(100);
    expect(normalizeSearchLimit(500)).toBe(MCP_MAX_SEARCH_LIMIT);
    expect(normalizeSearchLimit(Infinity)).toBe(MCP_MAX_SEARCH_LIMIT);
    expect(MCP_MAX_SEARCH_LIMIT).toBe(100);
  });
});

describe('API key and unreachable API', () => {
  const API_ENV = ['EVER_JOBS_API_KEY', 'EVER_JOBS_API_KEY_HEADER', 'EVER_JOBS_API_URL'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(API_ENV.map((k) => [k, process.env[k]]));
    for (const k of API_ENV) delete process.env[k];
  });

  afterEach(() => {
    for (const k of API_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function sentHeaders(): Record<string, string> {
    return createMock.mock.calls[0][0].headers;
  }

  it('sends EVER_JOBS_API_KEY under x-api-key by default', async () => {
    process.env.EVER_JOBS_API_KEY = 'k';
    mockClient({});
    await searchJobs({ query: 'x' });
    expect(sentHeaders()).toMatchObject({ 'x-api-key': 'k' });
  });

  it('uses EVER_JOBS_API_KEY_HEADER as the header name when set', async () => {
    process.env.EVER_JOBS_API_KEY = 'k';
    process.env.EVER_JOBS_API_KEY_HEADER = 'x-custom-key';
    mockClient({});
    await searchJobs({ query: 'x' });
    expect(sentHeaders()).toMatchObject({ 'x-custom-key': 'k' });
    expect(sentHeaders()).not.toHaveProperty('x-api-key');
  });

  it('sends no key header when EVER_JOBS_API_KEY is unset or blank', async () => {
    mockClient({});
    await searchJobs({ query: 'x' });
    expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json' });

    createMock.mockReset();
    process.env.EVER_JOBS_API_KEY = '   ';
    mockClient({});
    await searchJobs({ query: 'x' });
    expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json' });
  });

  it('rejects with an error naming the API URL when the connection is refused', async () => {
    process.env.EVER_JOBS_API_URL = 'http://api.test:4000';
    const client = mockClient({});
    client.post.mockRejectedValue({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
    await expect(searchJobs({ query: 'x' })).rejects.toThrow(
      /http:\/\/api\.test:4000 is unreachable/,
    );
    expect(createMock.mock.calls[0][0].baseURL).toBe('http://api.test:4000');
  });

  it('names the default API URL when EVER_JOBS_API_URL is unset', async () => {
    const client = mockClient({});
    client.post.mockRejectedValue({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
    await expect(searchJobs({ query: 'x' })).rejects.toThrow(
      /http:\/\/localhost:3001 is unreachable/,
    );
  });

  const UNREACHABLE = /the Ever Jobs API at \S+ is unreachable \(connection refused\)/;

  it('rejects with an "unreachable" error when the connection is refused', async () => {
    const client = mockClient({});
    client.post.mockRejectedValue({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
    await expect(searchJobs({ query: 'x' })).rejects.toThrow(UNREACHABLE);
    await expect(searchJobs({ query: 'x' })).rejects.toThrow(/^Search failed: /);
  });

  it('falls back to the error code when the error has no message', async () => {
    const client = mockClient({});
    client.post.mockRejectedValue({ code: 'ETIMEDOUT', message: '' });
    await expect(searchJobs({ query: 'x' })).rejects.toThrow('Search failed: ETIMEDOUT');
  });

  it('names the API URL in the unreachable error', () => {
    expect(describeRequestError({ code: 'ECONNREFUSED' }, 'http://localhost:3001')).toContain(
      'the Ever Jobs API at http://localhost:3001 is unreachable',
    );
  });

  it('never echoes credentials from EVER_JOBS_API_URL', () => {
    const text = describeRequestError({ code: 'ECONNREFUSED' }, 'https://user:s3cr@t@api.example.com:8443/base');
    expect(text).toContain('https://api.example.com:8443/base');
    expect(text).not.toContain('s3cr');
    expect(text).not.toContain('user');
    expect(displayApiUrl('http://api.example.com/a@b')).toBe('http://api.example.com/a@b');
    expect(displayApiUrl('http://localhost:3001')).toBe('http://localhost:3001');
  });

  it('still reports other failures as "Search failed"', async () => {
    const client = mockClient({});
    client.post.mockRejectedValue({ code: 'ERR_BAD_REQUEST', message: 'Request failed with status code 403' });
    await expect(searchJobs({ query: 'x' })).rejects.toThrow('Search failed: Request failed with status code 403');
  });
});

describe('getJobDetails — location contract', () => {
  it('renders a city-less location as a string', async () => {
    mockClient({ post: { jobs: [apiJob({ state: 'VA', country: 'United States' })] } });
    await searchJobs({ query: 'x' });
    const details = await getJobDetails({ jobId: 'j1' });
    expect(details.location).toBe('VA, United States');
  });

  it('renders a remote-only job location as null', async () => {
    mockClient({ post: { jobs: [apiJob(null)] } });
    await searchJobs({ query: 'x' });
    const details = await getJobDetails({ jobId: 'j1' });
    expect(details.location).toBeNull();
  });
});

/**
 * T-2586 — the API has no route that returns one job (only `POST
 * /api/jobs/search` and `POST /api/jobs/analyze`), so `get_job_details` called
 * a `GET /api/jobs/details` that always failed. It now answers from the raw API
 * jobs that this process's searches received, and makes no API request.
 */
describe('getJobDetails — answers from recent search results (T-2586)', () => {
  const NOT_FOUND = 'job not found in recent search results; call search_jobs first';
  const FULL = 'Full description. '.repeat(112).slice(0, 2000);

  it('returns the full description by job_id and by job_url without calling the API', async () => {
    expect(FULL).toHaveLength(2000);
    const job = {
      ...apiJob({ city: 'Berlin', country: 'Germany' }),
      description: FULL,
      datePosted: '2026-11-10',
      department: 'Platform',
      compensation: { minAmount: 90000, maxAmount: 120000, currency: 'EUR' },
      // The API's field (`JobPostDto.applyUrl`), set apart from `jobUrl` by many sources.
      applyUrl: 'https://acme.example.com/j1/apply',
    };
    const client = mockClient({ post: { jobs: [job] } });
    const search = await searchJobs({ query: 'engineer' });
    expect(search.jobs[0].description).toBe(`${FULL.slice(0, 500)}...`);

    const byId = await getJobDetails({ jobId: 'j1' });
    const byUrl = await getJobDetails({ jobUrl: 'https://acme.example.com/j1' });

    for (const details of [byId, byUrl]) {
      expect(details.full_description).toBe(FULL);
      expect(details).toEqual({
        ...search.jobs[0],
        full_description: FULL,
        application_url: 'https://acme.example.com/j1/apply',
      });
    }
    expect(byId.location).toBe('Berlin, Germany');
    expect(byId.salary).not.toBeNull();
    expect(client.get).not.toHaveBeenCalled();
    // Only the search built an API client.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('still answers after the API has gone away', async () => {
    const job = { ...apiJob(null), id: 'down-1', jobUrl: 'https://acme.example.com/down-1' };
    const client = mockClient({ post: { jobs: [job] } });
    await searchJobs({ query: 'x' });
    client.post.mockRejectedValue({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
    client.get.mockRejectedValue({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });

    await expect(getJobDetails({ jobId: 'down-1' })).resolves.toMatchObject({ id: 'down-1', title: 'Engineer' });
  });

  it('rejects an id or URL no search returned, asking for search_jobs first', async () => {
    const client = mockClient({ get: apiJob(null) });
    await expect(getJobDetails({ jobId: 'never-searched' })).rejects.toThrow(NOT_FOUND);
    await expect(getJobDetails({ jobUrl: 'https://acme.example.com/never-searched' })).rejects.toThrow(NOT_FOUND);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('answers a job URL shared by two jobs with the newer one; both stay reachable by id', async () => {
    const shared = 'https://acme.example.com/careers';
    mockClient({
      post: {
        jobs: [
          { ...apiJob(null), id: 'shared-a', title: 'First', jobUrl: shared },
          { ...apiJob(null), id: 'shared-b', title: 'Second', jobUrl: shared },
        ],
      },
    });
    await searchJobs({ query: 'x' });

    await expect(getJobDetails({ jobUrl: shared })).resolves.toMatchObject({ id: 'shared-b' });
    await expect(getJobDetails({ jobId: 'shared-a' })).resolves.toMatchObject({ title: 'First' });
    await expect(getJobDetails({ jobId: 'shared-b' })).resolves.toMatchObject({ title: 'Second' });
  });

  it('never remembers more than MCP_RECENT_JOBS_LIMIT (1000) jobs, dropping the oldest first', async () => {
    expect(MCP_RECENT_JOBS_LIMIT).toBe(1000);
    const total = MCP_RECENT_JOBS_LIMIT + 250;
    const jobs = Array.from({ length: total }, (_, i) => ({
      id: `bulk-${i}`,
      title: `Job ${i}`,
      jobUrl: `https://acme.example.com/bulk-${i}`,
      site: 'lever',
    }));

    for (let i = 0; i < total; i += 100) {
      mockClient({ post: { jobs: jobs.slice(i, i + 100) } });
      await searchJobs({ query: 'x' });
      expect(recentJobCount()).toBeLessThanOrEqual(MCP_RECENT_JOBS_LIMIT);
    }
    expect(recentJobCount()).toBe(MCP_RECENT_JOBS_LIMIT);

    await expect(getJobDetails({ jobId: 'bulk-0' })).rejects.toThrow(NOT_FOUND);
    await expect(getJobDetails({ jobUrl: 'https://acme.example.com/bulk-249' })).rejects.toThrow(NOT_FOUND);
    await expect(getJobDetails({ jobId: 'bulk-250' })).resolves.toMatchObject({ title: 'Job 250' });
    await expect(getJobDetails({ jobUrl: `https://acme.example.com/bulk-${total - 1}` })).resolves.toMatchObject({
      title: `Job ${total - 1}`,
    });

    // Searching a remembered job again makes it the newest, so it outlives the rest.
    mockClient({ post: { jobs: [jobs[250]] } });
    await searchJobs({ query: 'x' });
    const newer = jobs
      .slice(0, MCP_RECENT_JOBS_LIMIT - 1)
      .map((j) => ({ ...j, id: `${j.id}-again`, jobUrl: `${j.jobUrl}-again` }));
    mockClient({ post: { jobs: newer } });
    await searchJobs({ query: 'x' });
    expect(recentJobCount()).toBe(MCP_RECENT_JOBS_LIMIT);
    await expect(getJobDetails({ jobId: 'bulk-250' })).resolves.toMatchObject({ title: 'Job 250' });
    await expect(getJobDetails({ jobId: 'bulk-251' })).rejects.toThrow(NOT_FOUND);
  });

  it('keeps the first MCP_RECENT_JOBS_LIMIT jobs of one search that returns more', async () => {
    const total = MCP_RECENT_JOBS_LIMIT + 500;
    const jobs = Array.from({ length: total }, (_, i) => ({
      id: `one-${i}`,
      title: `One ${i}`,
      jobUrl: `https://acme.example.com/one-${i}`,
      site: 'lever',
    }));
    mockClient({ post: { jobs } });
    const search = await searchJobs({ query: 'x' });
    // searchJobs returns at most `limit` jobs (T-2585); the memory still takes
    // the first MCP_RECENT_JOBS_LIMIT of the API's answer.
    expect(search.jobs).toHaveLength(MCP_DEFAULT_SEARCH_LIMIT);
    expect(search.total_found).toBe(total);
    expect(recentJobCount()).toBe(MCP_RECENT_JOBS_LIMIT);

    await expect(getJobDetails({ jobId: search.jobs[0].id })).resolves.toMatchObject({ title: 'One 0' });
    await expect(getJobDetails({ jobId: `one-${MCP_RECENT_JOBS_LIMIT - 1}` })).resolves.toMatchObject({
      title: `One ${MCP_RECENT_JOBS_LIMIT - 1}`,
    });
    await expect(getJobDetails({ jobId: `one-${MCP_RECENT_JOBS_LIMIT}` })).rejects.toThrow(NOT_FOUND);
  });

  it('remembers every job a wide search returns, even ones listed past the first MCP_RECENT_JOBS_LIMIT', async () => {
    // 20 sources x 100 jobs, sorted by site name as the API does: the cut to
    // `limit` takes 5 jobs from each source, so half of them sit past index 1000.
    const sites = Array.from({ length: 20 }, (_, s) => `site${String(s).padStart(2, '0')}`);
    const jobs = sites.flatMap((site) =>
      Array.from({ length: 100 }, (_, i) => ({
        id: `wide-${site}-${i}`,
        title: `Wide ${site} ${i}`,
        jobUrl: `https://acme.example.com/wide-${site}-${i}`,
        site,
      })),
    );
    mockClient({ post: { jobs } });
    const search = await searchJobs({ query: 'x', limit: 100 });

    expect(search.jobs).toHaveLength(100);
    expect(search.total_found).toBe(2000);
    expect(new Set(search.jobs.map((j) => j.source))).toEqual(new Set(sites));
    expect(recentJobCount()).toBeLessThanOrEqual(MCP_RECENT_JOBS_LIMIT);

    const missing: string[] = [];
    for (const job of search.jobs) {
      const byId = await getJobDetails({ jobId: job.id }).catch(() => null);
      const byUrl = await getJobDetails({ jobUrl: job.url }).catch(() => null);
      if (byId?.id !== job.id || byUrl?.id !== job.id) missing.push(job.id);
    }
    expect(missing).toEqual([]);
  });

  it('given job_id and job_url, answers the job that has both when a later search reused the id', async () => {
    // Working Nomads numbers its jobs per search (`workingnomads-<index>`).
    const roleA = { id: 'workingnomads-0', title: 'Role A', jobUrl: 'https://wn.example.com/a', site: 'workingnomads' };
    const roleB = { id: 'workingnomads-0', title: 'Role B', jobUrl: 'https://wn.example.com/b', site: 'workingnomads' };
    mockClient({ post: { jobs: [roleA] } });
    await searchJobs({ query: 'a' });
    mockClient({ post: { jobs: [roleB] } });
    await searchJobs({ query: 'b' });

    await expect(getJobDetails({ jobId: roleA.id, jobUrl: roleA.jobUrl })).resolves.toMatchObject({ title: 'Role A' });
    await expect(getJobDetails({ jobId: roleB.id, jobUrl: roleB.jobUrl })).resolves.toMatchObject({ title: 'Role B' });
    // The id alone answers with the newest job that has it.
    await expect(getJobDetails({ jobId: roleA.id })).resolves.toMatchObject({ title: 'Role B' });
  });
});
