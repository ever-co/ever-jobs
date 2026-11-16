import axios from 'axios';
import {
  MCP_LOCATION_FORMAT_ENV_VAR,
  MCP_REQUEST_KEYS_ENV_VAR,
  buildSearchRequestBody,
  describeRequestError,
  displayApiUrl,
  formatJobLocation,
  getJobDetails,
  readLocationFormat,
  readSearchRequestKeyStyle,
  searchJobs,
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

  it('sends the key on the details client too', async () => {
    process.env.EVER_JOBS_API_KEY = 'k';
    mockClient({});
    await getJobDetails({ jobId: 'j1' });
    expect(sentHeaders()).toMatchObject({ 'x-api-key': 'k' });
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

  it('reports a refused connection the same way from get_job_details', async () => {
    const client = mockClient({});
    client.get.mockRejectedValue({ code: 'ECONNREFUSED', message: '' });
    await expect(getJobDetails({ jobId: 'j1' })).rejects.toThrow(UNREACHABLE);
  });

  it('falls back to the error code when the error has no message', async () => {
    const client = mockClient({});
    client.get.mockRejectedValue({ code: 'ETIMEDOUT', message: '' });
    await expect(getJobDetails({ jobId: 'j1' })).rejects.toThrow('Failed to get job details: ETIMEDOUT');
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
    mockClient({ get: apiJob({ state: 'VA', country: 'United States' }) });
    const details = await getJobDetails({ jobId: 'j1' });
    expect(details.location).toBe('VA, United States');
  });

  it('renders a remote-only job location as null', async () => {
    mockClient({ get: apiJob(null) });
    const details = await getJobDetails({ jobId: 'j1' });
    expect(details.location).toBeNull();
  });
});
