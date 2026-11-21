import 'reflect-metadata';

const mockAxiosRequest = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      request: mockAxiosRequest,
      defaults: { headers: { common: {} } },
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
    })),
  },
}));

import { createRawCaptureSink, drainRawCapture, runWithRawCapture } from '@ever-jobs/common';
import { ScraperInputDto } from '@ever-jobs/models';
import { FranceTravailService } from '../src/francetravail.service';
import { FRANCETRAVAIL_TOKEN_URL } from '../src/francetravail.constants';

/**
 * Fork-sync hardening (security review finding 2): the client_credentials
 * token exchange must not leave the client secret (form body) or the access
 * token (response body) in an `include_raw` capture.
 */
describe('FranceTravailService under include_raw', () => {
  const CLIENT_ID = 'FAKE_FT_CLIENT_ID_0001';
  const CLIENT_SECRET = 'FAKE_SECRET_123456';
  const ACCESS_TOKEN = 'FAKE_FT_ACCESS_TOKEN_77';

  beforeEach(() => {
    process.env.FRANCETRAVAIL_CLIENT_ID = CLIENT_ID;
    process.env.FRANCETRAVAIL_CLIENT_SECRET = CLIENT_SECRET;
    mockAxiosRequest.mockReset();
    mockAxiosRequest.mockImplementation(async (config: { url: string }) =>
      config.url === FRANCETRAVAIL_TOKEN_URL
        ? {
            status: 200,
            data: { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 1499, scope: 'api_offresdemploiv2' },
            headers: { 'content-type': 'application/json' },
          }
        : { status: 200, data: { resultats: [] }, headers: { 'content-type': 'application/json' } },
    );
  });

  afterEach(() => {
    delete process.env.FRANCETRAVAIL_CLIENT_ID;
    delete process.env.FRANCETRAVAIL_CLIENT_SECRET;
  });

  it('records the token call without its bodies, and nothing else leaks the token', async () => {
    const service = new FranceTravailService();
    const sink = createRawCaptureSink();

    await runWithRawCapture(sink, () => service.scrape(new ScraperInputDto({ searchTerm: 'dev' } as never)));
    await drainRawCapture(sink, 100);
    const json = JSON.stringify(sink.entries);

    expect(json).not.toContain(CLIENT_SECRET);
    expect(json).not.toContain(CLIENT_ID);
    expect(json).not.toContain(ACCESS_TOKEN);

    const token = sink.entries[0];
    expect(token.method).toBe('POST');
    expect(token.bodies_withheld).toBe('opt_out');
    expect(token.request_body).toBeUndefined();
    expect(token.body).toBeUndefined();
    expect(sink.entries[1].body).toEqual({ resultats: [] });
  });

  it('a cached token is still scrubbed from a later scrape', async () => {
    const service = new FranceTravailService();
    await service.scrape(new ScraperInputDto({ searchTerm: 'dev' } as never));
    mockAxiosRequest.mockImplementation(async () => ({
      status: 200,
      data: { resultats: [], debug: `token=${ACCESS_TOKEN}` },
      headers: { 'content-type': 'application/json' },
    }));
    const sink = createRawCaptureSink();

    await runWithRawCapture(sink, () => service.scrape(new ScraperInputDto({ searchTerm: 'dev' } as never)));
    await drainRawCapture(sink, 100);

    expect(sink.entries).toHaveLength(1);
    expect(JSON.stringify(sink.entries)).not.toContain(ACCESS_TOKEN);
  });
});
