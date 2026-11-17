import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();

jest.mock('@ever-jobs/common', () => ({
  ...(jest.requireActual('@ever-jobs/common') as object),
  createHttpClient: () => ({ get: mockGet, setHeaders: mockSetHeaders }),
}));

import { AuthenticJobsService } from '../src/authenticjobs.service';
import { AUTHENTICJOBS_API_URL } from '../src/authenticjobs.constants';
import { AuthenticJob } from '../src/authenticjobs.types';

/**
 * Regression test for T-2584.
 *
 * Authentic Jobs authenticates with an `api_key` query parameter. The service
 * built the request URL by hand and logged it at info level on every page
 * (`Fetching Authentic Jobs page 1: https://authenticjobs.com/api/?...&api_key=<key>&...`),
 * so the operator's key went to the API log and every log shipper behind it.
 *
 * These tests capture every Nest `Logger` line the scrape writes and check that
 * none of them holds the key, while the request itself still sends it.
 */

const API_KEY = 'test-key-123';
const LOG_METHODS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
/** The API's page maximum; a full page makes the service ask for the next one. */
const FULL_PAGE = 100;

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function listing(id: number): AuthenticJob {
  return {
    id,
    title: `Designer ${id}`,
    description: '<p>Design things.</p>',
    perks: null,
    howto_apply: null,
    post_date: '2026-11-01 10:00:00',
    company: { id: 1, name: 'Acme', url: null, location: 'San Francisco, CA' },
    type: { id: 1, name: 'Full-time' },
    telecommuting: false,
  };
}

/** The query a `client.get(url, config)` call sends: the URL's own query string plus `config.params`. */
function sentQuery(call: unknown[]): URLSearchParams {
  const [url, config] = call as [string, { params?: Record<string, unknown> } | undefined];
  const query = new URL(url).searchParams;
  for (const [key, value] of Object.entries(config?.params ?? {})) query.set(key, String(value));
  return query;
}

/** Scheme, host and path a `client.get(url, config)` call targets, without the query. */
function sentEndpoint(call: unknown[]): string {
  const url = new URL(call[0] as string);
  return `${url.origin}${url.pathname}`;
}

describe('AuthenticJobsService keeps its API key out of the logs (T-2584)', () => {
  const savedKey = process.env.AUTHENTICJOBS_API_KEY;
  let logged: string[];

  const input = () =>
    new ScraperInputDto({
      siteType: [Site.AUTHENTICJOBS],
      searchTerm: 'designer',
      location: 'San Francisco, CA',
      resultsWanted: FULL_PAGE + 1,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    // The service reads the key in its constructor, so it must be set first.
    process.env.AUTHENTICJOBS_API_KEY = API_KEY;
    logged = [];
    for (const method of LOG_METHODS) {
      jest.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(toText).join(' '));
      });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (savedKey === undefined) delete process.env.AUTHENTICJOBS_API_KEY;
    else process.env.AUTHENTICJOBS_API_KEY = savedKey;
  });

  it('logs no line containing the key while it pages, and still sends api_key on every request', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: { listings: { listing: Array.from({ length: FULL_PAGE }, (_, i) => listing(i + 1)) } },
      })
      .mockResolvedValueOnce({ data: { listings: { listing: [] } } });

    const result = await new AuthenticJobsService().scrape(input());

    expect(result.jobs).toHaveLength(FULL_PAGE);
    expect(mockGet).toHaveBeenCalledTimes(2);

    // The page lines are still written, just without the request URL.
    expect(logged).toEqual(expect.arrayContaining([expect.stringContaining('Fetching Authentic Jobs page 1')]));
    expect(logged).toEqual(expect.arrayContaining([expect.stringContaining('Fetching Authentic Jobs page 2')]));
    expect(logged.filter((line) => line.includes(API_KEY))).toEqual([]);

    // The request itself still authenticates.
    mockGet.mock.calls.forEach((call, index) => {
      expect(sentEndpoint(call)).toBe(AUTHENTICJOBS_API_URL);
      const query = sentQuery(call);
      expect(query.get('api_key')).toBe(API_KEY);
      expect(query.get('method')).toBe('aj.jobs.search');
      expect(query.get('format')).toBe('json');
      expect(query.get('page')).toBe(String(index + 1));
      expect(query.get('count')).toBe(String(FULL_PAGE));
      expect(query.get('keyword')).toBe('designer');
    });
  });

  it('logs no line containing the key when the request fails', async () => {
    mockGet.mockRejectedValueOnce(new Error('Request failed with status code 500'));

    const result = await new AuthenticJobsService().scrape(input());

    expect(result.jobs).toEqual([]);
    expect(result.diagnostics?.reason).toBe('fetch_error');
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(logged).toEqual(
      expect.arrayContaining([expect.stringContaining('Authentic Jobs scrape error: Request failed with status code 500')]),
    );
    expect(logged.filter((line) => line.includes(API_KEY))).toEqual([]);
    expect(sentQuery(mockGet.mock.calls[0]).get('api_key')).toBe(API_KEY);
  });
});
