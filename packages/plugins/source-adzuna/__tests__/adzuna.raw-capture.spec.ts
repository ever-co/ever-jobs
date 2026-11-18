import 'reflect-metadata';

const realAxios = jest.requireActual('axios').default;
const mockAxiosRequest = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      request: mockAxiosRequest,
      defaults: { headers: { common: {} } },
      interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    })),
  },
}));

import { createRawCaptureSink, drainRawCapture, runWithRawCapture } from '@ever-jobs/common';
import { ScraperInputDto } from '@ever-jobs/models';
import { AdzunaService } from '../src/adzuna.service';

/**
 * Fork-sync hardening, second review round (findings 0 and 5): with the
 * operator's ADZUNA_APP_ID / ADZUNA_APP_KEY set, a caller passing only
 * `auth.adzuna.appKey = 'app_id=<guess>'` used to get the env app_id sent next
 * to its own value, and the overlapping scrub turned `final_url` into an
 * oracle for the app id. Caller credentials are now a pair, and caller values
 * are scrubbed after the server's.
 */
describe('AdzunaService under include_raw', () => {
  const ENV_APP_ID = 'a1b2c3d4'; // obviously fake
  const ENV_APP_KEY = 'FAKE_ADZUNA_APP_KEY_0123456789';

  beforeEach(() => {
    process.env.ADZUNA_APP_ID = ENV_APP_ID;
    process.env.ADZUNA_APP_KEY = ENV_APP_KEY;
    mockAxiosRequest.mockReset();
    mockAxiosRequest.mockImplementation(async (config: { url: string; params?: Record<string, unknown> }) => ({
      status: 200,
      data: { results: [], count: 0 },
      headers: { 'content-type': 'application/json' },
      // follow-redirects' responseUrl: the URL axios built, params included.
      request: { res: { responseUrl: realAxios.getUri({ url: config.url, params: config.params }) } },
    }));
  });

  afterEach(() => {
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
  });

  async function scrapeCaptured(auth?: Record<string, string>) {
    const sink = createRawCaptureSink();
    const result = await runWithRawCapture(sink, () =>
      new AdzunaService().scrape(
        new ScraperInputDto({ searchTerm: 'x', country: 'uk', ...(auth ? { auth: { adzuna: auth } } : {}) } as never),
      ),
    );
    await drainRawCapture(sink, 100);
    return { result, sink, json: JSON.stringify(sink.entries) };
  }

  it('keeps the env app id and key out of the capture', async () => {
    const { sink, json } = await scrapeCaptured();

    expect(sink.entries.length).toBeGreaterThanOrEqual(1);
    expect(json).not.toContain(ENV_APP_ID);
    expect(json).not.toContain(ENV_APP_KEY);
  });

  it('never pairs a caller appKey with the env app id (the review repro)', async () => {
    for (const guess of ['0', 'a']) {
      const { result, sink } = await scrapeCaptured({ appKey: `app_id=${guess}` });

      expect(result.diagnostics?.reason).toBe('bad_input');
      expect(result.diagnostics?.detail).toContain('both appId and appKey');
      expect(sink.entries).toEqual([]);
    }
    expect(mockAxiosRequest).not.toHaveBeenCalled();
  });

  it('uses a caller pair alone and scrubs it', async () => {
    const callerId = 'FAKE_CALLER_APP_ID_1';
    const callerKey = `app_id=${ENV_APP_ID[0]}FAKE_KEY`;
    const { json } = await scrapeCaptured({ appId: callerId, appKey: callerKey });

    const params = mockAxiosRequest.mock.calls[0][0].params as Record<string, unknown>;
    expect(params.app_id).toBe(callerId);
    expect(params.app_key).toBe(callerKey);
    expect(json).not.toContain(ENV_APP_ID);
    expect(json).not.toContain(callerId);
    expect(json).not.toContain('FAKE_KEY');
  });
});
