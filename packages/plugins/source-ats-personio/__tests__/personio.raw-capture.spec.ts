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
import { PersonioService } from '../src/personio.service';
import { PERSONIO_API_AUTH_URL } from '../src/personio.constants';

/**
 * Fork-sync hardening (security review finding 1): with the operator's
 * PERSONIO_CLIENT_ID / PERSONIO_CLIENT_SECRET set, an `include_raw` search
 * must not return the client secret (auth request body) or the bearer token
 * (auth response body, or echoed by a later call).
 */
describe('PersonioService under include_raw', () => {
  const CLIENT_ID = 'FAKE_PERSONIO_CLIENT_ID_1';
  const CLIENT_SECRET = 'FAKE_SECRET_123456';
  const TOKEN = 'FAKE_BEARER_TOKEN_424242';

  beforeEach(() => {
    process.env.PERSONIO_CLIENT_ID = CLIENT_ID;
    process.env.PERSONIO_CLIENT_SECRET = CLIENT_SECRET;
    mockAxiosRequest.mockReset();
    mockAxiosRequest.mockImplementation(async (config: { url: string }) =>
      config.url === PERSONIO_API_AUTH_URL
        ? { status: 200, data: { success: true, data: { token: TOKEN } }, headers: { 'content-type': 'application/json' } }
        : {
            status: 200,
            // An upstream that echoes the bearer token back in a debug field.
            data: { success: true, data: [], meta: { note: `authorized as Bearer ${TOKEN}` } },
            headers: { 'content-type': 'application/json' },
          },
    );
  });

  afterEach(() => {
    delete process.env.PERSONIO_CLIENT_ID;
    delete process.env.PERSONIO_CLIENT_SECRET;
  });

  it('captures the auth call without its bodies and scrubs the token everywhere', async () => {
    const sink = createRawCaptureSink();

    await runWithRawCapture(sink, () =>
      new PersonioService().scrape(new ScraperInputDto({ companySlug: 'acme' } as never)),
    );
    await drainRawCapture(sink, 100);
    const json = JSON.stringify(sink.entries);

    expect(sink.entries.length).toBeGreaterThanOrEqual(2);
    expect(json).not.toContain(CLIENT_SECRET);
    expect(json).not.toContain(CLIENT_ID);
    expect(json).not.toContain(TOKEN);

    const auth = sink.entries[0];
    expect(auth.url).toBe(PERSONIO_API_AUTH_URL);
    expect(auth.status).toBe(200);
    expect(auth.bodies_withheld).toBe('opt_out');
    expect(auth.request_body).toBeUndefined();
    expect(auth.body).toBeUndefined();

    // The positions call is still captured, for debugging.
    expect(sink.entries[1].url).toContain('/v1/recruiting/positions');
    expect(sink.entries[1].body).toEqual({ success: true, data: [], meta: { note: 'authorized as Bearer REDACTED' } });
  });
});
