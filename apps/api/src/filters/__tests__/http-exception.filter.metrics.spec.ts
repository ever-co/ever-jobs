/**
 * Unit tests — HttpExceptionFilter HTTP metrics.
 *
 * Guards (API key, rate limit) reject before any interceptor runs, so the
 * exception filter is the only place those requests can be counted.
 */
import {
  ArgumentsHost,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpExceptionFilter } from '../http-exception.filter';
import { MetricsService } from '../../metrics/metrics.service';

function makeHost(request: Record<string, unknown>) {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('HttpExceptionFilter — HTTP metrics', () => {
  let service: MetricsService;
  let filter: HttpExceptionFilter;

  const counterValues = async () =>
    (await service.httpRequestsTotal.get()).values;

  beforeEach(() => {
    service = new MetricsService();
    filter = new HttpExceptionFilter(service);
  });

  it('counts a guard-rejected 401 under the route template', async () => {
    const { host, response } = makeHost({
      method: 'POST',
      url: '/api/jobs/search?page=7',
      headers: {},
      route: { path: '/api/jobs/search' },
    });

    filter.catch(new UnauthorizedException(), host);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(await counterValues()).toEqual([
      {
        value: 1,
        labels: {
          method: 'POST',
          path: '/api/jobs/search',
          status_code: 401,
        },
      },
    ]);
  });

  it('counts a 429 and a 403 as separate status series', async () => {
    const request = (url: string) => ({
      method: 'GET',
      url,
      headers: {},
      route: { path: '/api/jobs' },
    });
    filter.catch(new HttpException('Too Many Requests', 429), makeHost(request('/api/jobs?a=1')).host);
    filter.catch(new ForbiddenException(), makeHost(request('/api/jobs?a=2')).host);

    const values = await counterValues();
    expect(values.map((v) => v.labels.status_code).sort()).toEqual([403, 429]);
    expect(values.every((v) => v.value === 1)).toBe(true);
  });

  it("counts a router 404 under 'unmatched' and an unknown error as 500", async () => {
    filter.catch(
      new HttpException('Not Found', 404),
      makeHost({ method: 'GET', url: '/does/not/exist/42', headers: {} }).host,
    );
    filter.catch(
      new Error('boom'),
      makeHost({ method: 'GET', url: '/api/x', headers: {}, route: { path: '/api/x' } }).host,
    );

    const values = await counterValues();
    expect(values).toHaveLength(2);
    expect(values).toContainEqual({
      value: 1,
      labels: { method: 'GET', path: 'unmatched', status_code: 404 },
    });
    expect(values).toContainEqual({
      value: 1,
      labels: { method: 'GET', path: '/api/x', status_code: 500 },
    });
  });

  it('counts a request only once if the filter sees it twice', async () => {
    const { host } = makeHost({
      method: 'GET',
      url: '/api/jobs',
      headers: {},
      route: { path: '/api/jobs' },
    });
    filter.catch(new ForbiddenException(), host);
    filter.catch(new ForbiddenException(), host);

    const values = await counterValues();
    expect(values).toHaveLength(1);
    expect(values[0].value).toBe(1);
  });

  it('still responds when no MetricsService is available', () => {
    const bare = new HttpExceptionFilter();
    const { host, response } = makeHost({
      method: 'GET',
      url: '/api/jobs',
      headers: {},
      route: { path: '/api/jobs' },
    });

    expect(() => bare.catch(new ForbiddenException(), host)).not.toThrow();
    expect(response.status).toHaveBeenCalledWith(403);
  });
});
