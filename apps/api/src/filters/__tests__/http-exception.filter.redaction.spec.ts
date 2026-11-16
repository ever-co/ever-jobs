/**
 * Unit tests — HttpExceptionFilter never logs request credentials (T-2520).
 *
 * On a 400 with validation errors the filter logs the request body to help
 * debugging. A search body can carry per-request source credentials (`auth`)
 * and proxy URLs with `user:password@`, so the logged body must be a redacted
 * copy, while the validation messages are still logged.
 */
import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { HttpExceptionFilter } from '../http-exception.filter';

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

describe('HttpExceptionFilter — request body redaction', () => {
  let filter: HttpExceptionFilter;
  let spies: jest.SpyInstance[];

  /** Every string any Logger method was called with, across all spies. */
  const logged = (): string[] =>
    spies.flatMap((spy) =>
      spy.mock.calls.flatMap((args: unknown[]) =>
        args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg))),
      ),
    );

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const searchRequest = (body: unknown) => ({
    method: 'POST',
    url: '/api/jobs/search',
    headers: { 'x-request-id': 'req-1' },
    route: { path: '/api/jobs/search' },
    body,
  });

  it('does not log per-request auth credentials or proxy passwords on a validation error', () => {
    const { host, response } = makeHost(
      searchRequest({
        searchTerm: 'typescript engineer',
        resultsWanted: 'x',
        auth: { greenhouse: { apiKey: 'sk-secret' } },
        proxies: ['http://u:p@h:1'],
      }),
    );

    filter.catch(new BadRequestException(['resultsWanted must be a number']), host);

    expect(response.status).toHaveBeenCalledWith(400);
    const lines = logged();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain('sk-secret');
      expect(line).not.toContain('u:p@');
    }
    // The validation messages are still logged.
    expect(lines.some((line) => line.includes('resultsWanted must be a number'))).toBe(true);
  });

  it('still logs the non-secret shape of the body for debugging', () => {
    const { host } = makeHost(
      searchRequest({
        searchTerm: 'typescript engineer',
        resultsWanted: 'x',
        auth: { greenhouse: { apiKey: 'sk-secret' } },
        proxies: ['http://u:p@h:1'],
      }),
    );

    filter.catch(new BadRequestException(['resultsWanted must be a number']), host);

    const bodyLine = logged().find((line) => line.startsWith('Request body: '));
    expect(bodyLine).toBeDefined();
    expect(bodyLine).toContain('typescript engineer');
    expect(bodyLine).toContain('"resultsWanted":"x"');
    expect(bodyLine).toContain('"greenhouse":{"apiKey":"[REDACTED]"}');
    expect(bodyLine).toContain('h:1');
  });

  it('redacts secret-looking keys at any depth, outside `auth` too', () => {
    const { host } = makeHost(
      searchRequest({
        resultsWanted: 'x',
        crawl: { nested: { clientSecret: 'cs-hidden', accessToken: 'at-hidden', password: 'pw-hidden' } },
        upwork: { refreshToken: 'rt-hidden' },
      }),
    );

    filter.catch(new BadRequestException(['resultsWanted must be a number']), host);

    for (const line of logged()) {
      for (const secret of ['cs-hidden', 'at-hidden', 'pw-hidden', 'rt-hidden']) {
        expect(line).not.toContain(secret);
      }
    }
  });

  it('caps the logged body and survives a circular body', () => {
    const big: Record<string, unknown> = { resultsWanted: 'x', searchTerm: 'a'.repeat(50_000) };
    big.self = big;
    const { host, response } = makeHost(searchRequest(big));

    expect(() =>
      filter.catch(new BadRequestException(['resultsWanted must be a number']), host),
    ).not.toThrow();

    expect(response.status).toHaveBeenCalledWith(400);
    const bodyLine = logged().find((line) => line.startsWith('Request body: '));
    expect(bodyLine).toBeDefined();
    expect(bodyLine!.length).toBeLessThan(2_200);
  });
});
