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

import type { RawCaptureSink } from '@ever-jobs/models';
import { HttpClient } from '../src/http/http-client';
import {
  captureRequestBody,
  createRawCaptureSink,
  drainRawCapture,
  envSecretValues,
  isCredentialEndpoint,
  isSensitiveKeyName,
  normalizeBody,
  pushRawEntry,
  rawCaptureWithholdReason,
  redactUrl,
  registerRawCaptureSecrets,
  retainBody,
  sanitizeCapturedValue,
  truncateUtf8,
} from '../src/http/raw-capture';
import { attachRawCapture } from '../src/browser/browser-pool';
import { runWithRawCapture } from '../src/context';
import { resetCrawlPolicyEnvCache } from '../src/http/crawl/env';
import { resetHostLimiter } from '../src/http/crawl/host-limiter';
import { resetEffectiveCrawlPolicyCache } from '../src/http/crawl/scrape-context';

/**
 * Fork-sync hardening of Spec 5161 raw capture (security review findings 0, 1,
 * 2 and 5): `raw_by_source` goes back to API callers, so no server credential
 * may survive in a captured entry. Every leak path asserts on
 * `JSON.stringify(entries)` — the exact bytes a caller would receive.
 */

const SECRET = 'FAKE_SECRET_123456';
const APP_ID = 'FAKEAPPID0042';
const ACCESS_TOKEN = 'FAKE_ACCESS_TOKEN_9876';
const REFRESH_TOKEN = 'FAKE_REFRESH_TOKEN_5432';

/** Env vars a test sets; removed again after each test. */
const setEnvNames: string[] = [];
function setEnv(name: string, value: string): void {
  setEnvNames.push(name);
  process.env[name] = value;
}

afterEach(() => {
  for (const name of setEnvNames.splice(0)) delete process.env[name];
  delete process.env.RAW_CAPTURE_MAX_BODY_BYTES;
  delete process.env.RAW_CAPTURE_MAX_SOURCE_BYTES;
});

/** What an `include_raw` caller receives for this sink, after the drain the API runs. */
async function serialized(sink: RawCaptureSink): Promise<string> {
  await drainRawCapture(sink, 50);
  return JSON.stringify(sink.entries);
}

function expectNoSecrets(json: string, ...secrets: string[]): void {
  for (const secret of secrets) {
    expect(json).not.toContain(secret);
    expect(json).not.toContain(encodeURIComponent(secret));
  }
}

const baseEntry = {
  attempt: 0,
  method: 'GET',
  url: 'https://example.com/x',
  status: 200,
  elapsed_ms: 1,
  body_bytes: 0,
  truncated: false,
};

// ---------------------------------------------------------------------------
// HttpClient leak paths
// ---------------------------------------------------------------------------

describe('raw capture never returns credentials — HttpClient (fork-sync hardening)', () => {
  beforeEach(() => {
    mockAxiosRequest.mockReset();
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
    resetHostLimiter();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetHostLimiter();
  });

  async function run<T>(promise: Promise<T>): Promise<T | Error> {
    const settled = promise.catch((err: Error) => err);
    await jest.advanceTimersByTimeAsync(60_000);
    return settled;
  }

  /** An axios answer whose follow-redirects `responseUrl` carries the serialized params, as the real one does. */
  function answerWithResponseUrl(data: unknown, contentType = 'application/json') {
    return async (config: { url: string; params?: Record<string, unknown> }) => {
      const query = config.params
        ? `?${new URLSearchParams(Object.entries(config.params).map(([k, v]) => [k, String(v)])).toString()}`
        : '';
      return {
        status: 200,
        data,
        headers: { 'content-type': contentType },
        request: { res: { responseUrl: `${config.url}${query}` } },
      };
    };
  }

  it('Adzuna: env app_id / app_key sent as params never reach final_url (finding 0)', async () => {
    setEnv('EJ_TEST_ADZUNA_APP_ID', APP_ID);
    setEnv('EJ_TEST_ADZUNA_APP_KEY', SECRET);
    mockAxiosRequest.mockImplementation(answerWithResponseUrl({ results: [], count: 0 }));
    const sink = createRawCaptureSink();

    await run(
      runWithRawCapture(sink, () =>
        new HttpClient().get('https://api.adzuna.com/v1/api/jobs/gb/search/1', {
          params: { app_id: APP_ID, app_key: SECRET, results_per_page: 20, what: 'node' },
        }),
      ),
    );

    const json = await serialized(sink);
    expectNoSecrets(json, APP_ID, SECRET);
    const entry = sink.entries[0];
    expect(entry.url).toBe('https://api.adzuna.com/v1/api/jobs/gb/search/1');
    // Still useful: the non-credential params stay visible.
    expect(entry.final_url).toContain('app_key=REDACTED');
    expect(entry.final_url).toContain('results_per_page=20');
    expect(entry.final_url).toContain('what=node');
  });

  it('Adzuna: caller-supplied keys are redacted by key name and by registration', async () => {
    mockAxiosRequest.mockImplementation(answerWithResponseUrl({ results: [] }));
    const sink = createRawCaptureSink();

    await run(
      runWithRawCapture(sink, async () => {
        // What source-adzuna does with the resolved credentials.
        registerRawCaptureSecrets([APP_ID, SECRET]);
        return new HttpClient().get('https://api.adzuna.com/v1/api/jobs/gb/search/1', {
          params: { app_id: APP_ID, app_key: SECRET },
        });
      }),
    );

    expectNoSecrets(await serialized(sink), APP_ID, SECRET);
  });

  it('Jooble: the API key in the URL path is redacted (finding 0)', async () => {
    mockAxiosRequest.mockResolvedValue({ status: 200, data: { totalCount: 0, jobs: [] }, headers: {} });
    const sink = createRawCaptureSink();

    await run(
      runWithRawCapture(sink, () =>
        new HttpClient().post(`https://jooble.org/api/${SECRET}`, { page: 1, keywords: 'node' }),
      ),
    );

    const json = await serialized(sink);
    expectNoSecrets(json, SECRET);
    expect(sink.entries[0].url).toBe('https://jooble.org/api/REDACTED');
    expect(sink.entries[0].request_body).toEqual({ page: 1, keywords: 'node' });
  });

  it('Jooble: an env key is scrubbed even where no path rule applies', async () => {
    setEnv('EJ_TEST_JOOBLE_API_KEY', SECRET);
    mockAxiosRequest.mockResolvedValue({
      status: 200,
      data: { message: `key ${SECRET} accepted`, jobs: [] },
      headers: { 'content-type': 'application/json' },
    });
    const sink = createRawCaptureSink();

    await run(
      runWithRawCapture(sink, () => new HttpClient().post(`https://mirror.example.net/api/${SECRET}`, { page: 1 })),
    );

    const json = await serialized(sink);
    expectNoSecrets(json, SECRET);
    expect(sink.entries[0].url).toBe('https://mirror.example.net/api/REDACTED');
  });

  it('Personio: client_secret in a JSON request body is never captured (finding 1)', async () => {
    mockAxiosRequest.mockResolvedValue({
      status: 200,
      data: { success: true, data: { token: ACCESS_TOKEN } },
      headers: { 'content-type': 'application/json' },
    });
    const sink = createRawCaptureSink();
    const client = new HttpClient();

    await run(
      runWithRawCapture(sink, async () => {
        // As source-ats-personio sends it: opted out of body capture.
        await client.post(
          'https://api.personio.de/v1/auth',
          { client_id: 'FAKE_CLIENT_ID_777', client_secret: SECRET },
          { headers: { 'Content-Type': 'application/json' }, rawCapture: false },
        );
        // Same call without the opt-out: the auth-endpoint heuristic withholds it.
        await client.post('https://api.personio.de/v1/auth', { client_id: 'FAKE_CLIENT_ID_777', client_secret: SECRET });
      }),
    );

    const json = await serialized(sink);
    expectNoSecrets(json, SECRET, 'FAKE_CLIENT_ID_777', ACCESS_TOKEN);
    expect(sink.entries.map((e) => e.bodies_withheld)).toEqual(['opt_out', 'auth_endpoint']);
    expect(sink.entries[0].status).toBe(200);
    expect(sink.entries[0].request_body).toBeUndefined();
    expect(sink.entries[0].body).toBeUndefined();
  });

  it('redacts credential keys in a JSON request body by normalized substring, nested and in arrays', async () => {
    mockAxiosRequest.mockResolvedValue({ status: 200, data: 'ok', headers: {} });
    const sink = createRawCaptureSink();

    await run(
      runWithRawCapture(sink, () =>
        new HttpClient().post('https://api.example.com/v1/search', {
          query: 'node',
          client_secret: SECRET,
          clientSecret: SECRET,
          nested: { refresh_token: REFRESH_TOKEN, private_key: SECRET, page: 2 },
          list: [{ api_token: SECRET }, { 'x-api-key': SECRET }, { app_key: SECRET }],
          isPrivate: false,
        }),
      ),
    );

    expectNoSecrets(await serialized(sink), SECRET, REFRESH_TOKEN);
    expect(sink.entries[0].request_body).toEqual({
      query: 'node',
      client_secret: 'REDACTED',
      clientSecret: 'REDACTED',
      nested: { refresh_token: 'REDACTED', private_key: 'REDACTED', page: 2 },
      list: [{ api_token: 'REDACTED' }, { 'x-api-key': 'REDACTED' }, { app_key: 'REDACTED' }],
      // A boolean under a credential-looking key carries no secret — kept for debugging.
      isPrivate: false,
    });
  });

  it('redacts a form-encoded request body and keeps it as a string', async () => {
    mockAxiosRequest.mockResolvedValue({ status: 200, data: 'ok', headers: {} });
    const sink = createRawCaptureSink();
    const form = new URLSearchParams({ grant: 'x', client_secret: SECRET, scope: 'jobs' }).toString();

    await run(runWithRawCapture(sink, () => new HttpClient().post('https://api.example.com/v1/search', form)));

    expectNoSecrets(await serialized(sink), SECRET);
    expect(sink.entries[0].request_body).toBe('grant=x&client_secret=REDACTED&scope=jobs');
  });

  it('OAuth: a token response body is never retained (finding 2)', async () => {
    mockAxiosRequest.mockResolvedValue({
      status: 200,
      data: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600 },
      headers: { 'content-type': 'application/json' },
    });
    const sink = createRawCaptureSink();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: 'FAKE_CLIENT_ID_777',
      client_secret: SECRET,
    }).toString();

    await run(
      runWithRawCapture(sink, async () => {
        // Upwork / France Travail shapes, with and without the plugin opt-out.
        await new HttpClient().post('https://www.upwork.com/api/v3/oauth2/token', body, { rawCapture: false });
        await new HttpClient().post(
          'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=/partenaire',
          body,
        );
      }),
    );

    const json = await serialized(sink);
    expectNoSecrets(json, ACCESS_TOKEN, REFRESH_TOKEN, SECRET, 'FAKE_CLIENT_ID_777');
    expect(sink.entries).toHaveLength(2);
    for (const entry of sink.entries) {
      expect(entry.status).toBe(200);
      expect(entry.body).toBeUndefined();
      expect(entry.request_body).toBeUndefined();
      expect(entry.bodies_withheld).toBeDefined();
      expect(entry.body_bytes).toBeGreaterThan(0);
    }
  });

  it('OAuth: token fields in a response body at an ordinary URL are redacted (object, JSON text, form text)', async () => {
    const tokenJson = { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600, scope: 'jobs' };
    mockAxiosRequest
      .mockResolvedValueOnce({ status: 200, data: tokenJson, headers: { 'content-type': 'application/json' } })
      .mockResolvedValueOnce({ status: 200, data: JSON.stringify(tokenJson), headers: { 'content-type': 'text/plain' } })
      .mockResolvedValueOnce({
        status: 200,
        data: `access_token=${ACCESS_TOKEN}&token_type=bearer&expires_in=3600`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    const sink = createRawCaptureSink();
    const client = new HttpClient();

    await run(
      runWithRawCapture(sink, async () => {
        await client.get('https://api.example.com/v2/grant/a');
        await client.get('https://api.example.com/v2/grant/b');
        await client.get('https://api.example.com/v2/grant/c');
      }),
    );

    expectNoSecrets(await serialized(sink), ACCESS_TOKEN, REFRESH_TOKEN);
    expect(sink.entries[0].body).toEqual({ access_token: 'REDACTED', refresh_token: 'REDACTED', expires_in: 3600, scope: 'jobs' });
    expect(JSON.parse(sink.entries[1].body as string)).toEqual({
      access_token: 'REDACTED',
      refresh_token: 'REDACTED',
      expires_in: 3600,
      scope: 'jobs',
    });
    // `token_type` matches the `token` substring rule too: over-redacting a
    // label is the price of never missing a credential.
    expect(sink.entries[2].body).toBe('access_token=REDACTED&token_type=REDACTED&expires_in=3600');
  });

  it('an error body echoing client_secret is redacted, or withheld on a token endpoint (findings 2, 5)', async () => {
    setEnv('EJ_TEST_UPWORK_CLIENT_SECRET', SECRET);
    const httpError = (data: unknown, contentType: string) =>
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data, headers: { 'content-type': contentType } },
      });
    mockAxiosRequest
      .mockRejectedValueOnce(httpError({ error: 'invalid_client', client_secret: SECRET }, 'application/json'))
      .mockRejectedValueOnce(httpError(`invalid client: secret ${SECRET} rejected`, 'text/plain'))
      .mockRejectedValueOnce(httpError({ error: 'invalid_client', echoed: { client_secret: SECRET } }, 'application/json'));
    const sink = createRawCaptureSink();
    const client = new HttpClient({ retries: 0 });

    await run(
      runWithRawCapture(sink, async () => {
        await client.post('https://api.example.com/v1/search', { q: 'x' }).catch(() => undefined);
        await client.post('https://api.example.com/v1/search', { q: 'y' }).catch(() => undefined);
        await client.post('https://www.upwork.com/api/v3/oauth2/token', 'grant_type=client_credentials').catch(() => undefined);
      }),
    );

    expectNoSecrets(await serialized(sink), SECRET);
    expect(sink.entries).toHaveLength(3);
    expect(sink.entries[0].status).toBe(400);
    expect(sink.entries[0].body).toEqual({ error: 'invalid_client', client_secret: 'REDACTED' });
    expect(sink.entries[1].body).toBe('invalid client: secret REDACTED rejected');
    expect(sink.entries[2].body).toBeUndefined();
    expect(sink.entries[2].bodies_withheld).toBe('auth_endpoint');
    expect(sink.entries[2].error).toContain('400');
  });

  it('userinfo (user:pass@) never reaches url or final_url', async () => {
    mockAxiosRequest.mockImplementation(async (config: { url: string }) => ({
      status: 200,
      data: 'ok',
      headers: {},
      // axios `auth` surfaces as userinfo in follow-redirects' responseUrl.
      request: { res: { responseUrl: `https://svc-user:${SECRET}@feed.example.com/v1/basic?page=2` } },
      config,
    }));
    const sink = createRawCaptureSink();

    await run(
      runWithRawCapture(sink, () => new HttpClient().get(`https://svc-user:${SECRET}@feed.example.com/v1/basic`)),
    );

    const json = await serialized(sink);
    expectNoSecrets(json, SECRET);
    expect(json).not.toContain('svc-user');
    expect(sink.entries[0].url).toBe('https://feed.example.com/v1/basic');
    expect(sink.entries[0].final_url).toBe('https://feed.example.com/v1/basic?page=2');
  });

  it('an env secret is scrubbed in its percent-encoded form too', async () => {
    const special = 'FAKE/SECRET+12345=';
    setEnv('EJ_TEST_SPECIAL_TOKEN', special);
    mockAxiosRequest.mockImplementation(answerWithResponseUrl({ echo: special }));
    const sink = createRawCaptureSink();

    await run(
      runWithRawCapture(sink, () =>
        new HttpClient().get('https://api.example.com/v1/search', { params: { q: special } }),
      ),
    );

    const json = await serialized(sink);
    expect(json).not.toContain(special);
    expect(json).not.toContain(encodeURIComponent(special));
    expect(sink.entries[0].final_url).toBe('https://api.example.com/v1/search?q=REDACTED');
    expect(sink.entries[0].body).toEqual({ echo: 'REDACTED' });
  });
});

// ---------------------------------------------------------------------------
// Browser leak paths
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

function fakePage(): { page: never; emit: (event: string, arg: unknown) => void } {
  const handlers = new Map<string, Handler[]>();
  const page = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return page;
    },
  };
  return { page: page as never, emit: (event, arg) => (handlers.get(event) ?? []).forEach((h) => h(arg)) };
}

function fakeRequest(overrides: Record<string, unknown> = {}) {
  return {
    resourceType: () => 'fetch',
    method: () => 'POST',
    url: () => 'https://board.example.com/api/jobs',
    redirectedFrom: () => null,
    postData: () => null,
    timing: () => ({ responseEnd: 5 }),
    failure: () => null,
    ...overrides,
  } as never;
}

function fakeResponse(request: unknown, body: jest.Mock) {
  return {
    request: () => request,
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    body,
  } as never;
}

describe('raw capture never returns credentials — browser (fork-sync hardening)', () => {
  it('never reads a token endpoint body and never keeps its post data', async () => {
    const sink = createRawCaptureSink();
    const { page, emit } = fakePage();
    await runWithRawCapture(sink, async () => attachRawCapture(page));

    const req = fakeRequest({
      url: () => 'https://login.example.com/oauth2/token',
      postData: () => JSON.stringify({ client_secret: SECRET, grant_type: 'client_credentials' }),
    });
    const body = jest.fn(() => Promise.resolve(Buffer.from(JSON.stringify({ access_token: ACCESS_TOKEN }))));
    emit('request', req);
    emit('response', fakeResponse(req, body));
    emit('requestfinished', req);

    const json = await serialized(sink);
    expectNoSecrets(json, SECRET, ACCESS_TOKEN);
    expect(body).not.toHaveBeenCalled();
    expect(sink.entries[0].bodies_withheld).toBe('auth_endpoint');
  });

  it('redacts post data and response bodies of ordinary requests', async () => {
    const sink = createRawCaptureSink();
    const { page, emit } = fakePage();
    await runWithRawCapture(sink, async () => attachRawCapture(page));

    const req = fakeRequest({ postData: () => JSON.stringify({ limit: 20, session_token: SECRET }) });
    const body = jest.fn(() => Promise.resolve(Buffer.from(JSON.stringify({ jobs: [], sessionId: SECRET }))));
    emit('request', req);
    emit('response', fakeResponse(req, body));
    emit('requestfinished', req);

    expectNoSecrets(await serialized(sink), SECRET);
    expect(sink.entries[0].request_body).toEqual({ limit: 20, session_token: 'REDACTED' });
    expect(sink.entries[0].body).toEqual({ jobs: [], sessionId: 'REDACTED' });
  });

  it('pulls no body out of Chromium once the source budget is spent', async () => {
    process.env.RAW_CAPTURE_MAX_SOURCE_BYTES = '10';
    const sink = createRawCaptureSink();
    sink.retained_bytes = 10;
    const { page, emit } = fakePage();
    await runWithRawCapture(sink, async () => attachRawCapture(page));

    const req = fakeRequest();
    const body = jest.fn(() => Promise.resolve(Buffer.from('{"jobs":[]}')));
    emit('request', req);
    emit('response', fakeResponse(req, body));
    emit('requestfinished', req);
    await drainRawCapture(sink, 50);

    expect(body).not.toHaveBeenCalled();
    expect(sink.entries[0].truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sink-level guarantees
// ---------------------------------------------------------------------------

describe('raw capture sink — final pass and late writes (fork-sync hardening)', () => {
  it('drainRawCapture scrubs fields written outside the helpers', async () => {
    setEnv('EJ_TEST_PERSONIO_CLIENT_SECRET', SECRET);
    const sink = createRawCaptureSink();
    const entry = pushRawEntry(sink, { ...baseEntry })!;
    // A transport (or a future one) writing straight onto the entry.
    entry.body = { note: `echo ${SECRET}`, client_secret: 'abc' };
    entry.error = `failed for https://x.example.com/?token=${SECRET}`;
    (entry as unknown as Record<string, unknown>).headers = { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: 'json' };

    const json = await serialized(sink);
    expectNoSecrets(json, SECRET, ACCESS_TOKEN);
    expect(entry.body).toEqual({ note: 'echo REDACTED', client_secret: 'REDACTED' });
    expect((entry as unknown as Record<string, unknown>).headers).toEqual({ Authorization: 'REDACTED', Accept: 'json' });
  });

  it('drops body writes that land after the sink closed', async () => {
    const sink = createRawCaptureSink();
    const entry = pushRawEntry(sink, { ...baseEntry })!;
    await drainRawCapture(sink, 50);

    retainBody(sink, entry, normalizeBody({ access_token: ACCESS_TOKEN }));
    expect(entry.body).toBeUndefined();
  });

  it('applies secrets registered after a body was stored', async () => {
    const sink = createRawCaptureSink();
    const entry = pushRawEntry(sink, { ...baseEntry })!;
    retainBody(sink, entry, normalizeBody(`token later: ${ACCESS_TOKEN}`));
    registerRawCaptureSecrets(ACCESS_TOKEN, sink);

    expectNoSecrets(await serialized(sink), ACCESS_TOKEN);
  });

  it('registerRawCaptureSecrets takes the string leaves of an auth block and ignores short values', () => {
    const sink = createRawCaptureSink();
    registerRawCaptureSecrets({ personio: { clientId: 'FAKE_CLIENT_ID_777', clientSecret: SECRET }, x: 'short' }, sink);

    expect(sanitizeCapturedValue(`a FAKE_CLIENT_ID_777 b ${SECRET} c short`, sink)).toBe('a REDACTED b REDACTED c short');
  });

  it('redacts credential pairs in JSON text that does not parse (truncated body, JSON inside HTML)', () => {
    const truncated = `{"jobs":[{"id":1}],"client_secret":"${SECRET}","api_key": 12345678,"next":"`;
    const html = `<script>window.__STATE__ = {"page":2, "sessionToken":"${SECRET}"};</script>`;

    const cleanTruncated = sanitizeCapturedValue(truncated) as string;
    const cleanHtml = sanitizeCapturedValue(html) as string;

    expect(cleanTruncated).not.toContain(SECRET);
    expect(cleanTruncated).not.toContain('12345678');
    expect(cleanTruncated).toContain('"jobs":[{"id":1}]');
    expect(cleanHtml).toBe('<script>window.__STATE__ = {"page":2, "sessionToken":"REDACTED"};</script>');
  });

  it('registerRawCaptureSecrets is a no-op outside include_raw', () => {
    expect(() => registerRawCaptureSecrets([SECRET])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('isSensitiveKeyName', () => {
  it.each([
    'client_secret',
    'clientSecret',
    'refresh_token',
    'access_token',
    'id_token',
    'api_token',
    'apiKey',
    'api-key',
    'x-api-key',
    'X-Api-Key',
    'app_key',
    'appKey',
    'key',
    'privateKey',
    'private_key',
    'password',
    'passwd',
    'user_pwd',
    'credentials',
    'Authorization',
    'Proxy-Authorization',
    'authorisation',
    'oauth_signature',
    'sig',
    'session_id',
    'Set-Cookie',
    'cookie',
  ])('treats %s as a credential', (key) => {
    expect(isSensitiveKeyName(key)).toBe(true);
  });

  it.each(['author', 'authored_by', 'authority', 'keywords', 'key_skills', 'jobkey', 'title', 'description', 'page', 'client_id', 'app_id'])(
    'leaves %s alone',
    (key) => {
      expect(isSensitiveKeyName(key)).toBe(false);
    },
  );
});

describe('isCredentialEndpoint / rawCaptureWithholdReason', () => {
  it.each([
    'https://api.personio.de/v1/auth',
    'https://www.upwork.com/api/v3/oauth2/token',
    'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=/partenaire',
    'https://idp.example.com/realms/x/protocol/openid-connect/token',
    'https://idp.example.com/oauth/authorize',
    'https://api.example.com/v1/token.json',
    'https://api.example.com/v1/x?grant_type=client_credentials',
  ])('withholds %s', (url) => {
    expect(isCredentialEndpoint(url)).toBe(true);
    expect(rawCaptureWithholdReason(url)).toBe('auth_endpoint');
  });

  it.each([
    'https://boards-api.greenhouse.io/v1/boards/auth0/jobs',
    'https://boards-api.greenhouse.io/v1/boards/tokenmetrics/jobs',
    'https://api.example.com/v1/authors/42',
    'https://jooble.org/api/somekey',
    'https://acme.example.com/jobs?token=abc',
  ])('keeps the bodies of %s', (url) => {
    expect(isCredentialEndpoint(url)).toBe(false);
  });

  it('an explicit opt-out wins', () => {
    expect(rawCaptureWithholdReason('https://acme.example.com/jobs', false)).toBe('opt_out');
    expect(rawCaptureWithholdReason('https://acme.example.com/jobs', true)).toBeUndefined();
  });
});

describe('redactUrl (fork-sync hardening)', () => {
  it.each([
    [`https://u:${SECRET}@example.com/x`, 'https://example.com/x'],
    [`https://${SECRET}@example.com/x`, 'https://example.com/x'],
    [`https://jooble.org/api/${SECRET}`, 'https://jooble.org/api/REDACTED'],
    [`https://de.jooble.org/api/${SECRET}/`, 'https://de.jooble.org/api/REDACTED/'],
    ['https://jooble.org/jobs-python', 'https://jooble.org/jobs-python'],
    [`https://x.io/?app_id=1&app_key=${SECRET}`, 'https://x.io/?app_id=1&app_key=REDACTED'],
    [`https://x.io/?client_secret=${SECRET}&q=1`, 'https://x.io/?client_secret=REDACTED&q=1'],
    [`https://x.io/cb#access_token=${SECRET}&state=1`, 'https://x.io/cb#access_token=REDACTED&state=1'],
    [`https://x.io/?filter%5Bapi_key%5D=${SECRET}`, 'https://x.io/?filter%5Bapi_key%5D=REDACTED'],
  ])('%s -> %s', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});

describe('envSecretValues', () => {
  it('collects credential-named env values of 8+ characters, items of a list, and skips locations', () => {
    const values = envSecretValues({
      SOME_API_KEY: SECRET,
      SOME_CLIENT_ID: 'FAKE_CLIENT_ID_777',
      API_KEYS: 'FAKE_KEY_AAAAAAAA,FAKE_KEY_BBBBBBBB',
      SHORT_TOKEN: 'abc',
      TOKEN_URL: 'https://idp.example.com/token',
      UNRELATED: 'FAKE_NOT_A_SECRET_1',
    });

    expect(values).toEqual(
      expect.arrayContaining([SECRET, 'FAKE_CLIENT_ID_777', 'FAKE_KEY_AAAAAAAA', 'FAKE_KEY_BBBBBBBB']),
    );
    expect(values).not.toContain('abc');
    expect(values).not.toContain('https://idp.example.com/token');
    expect(values).not.toContain('FAKE_NOT_A_SECRET_1');
  });
});

describe('captureRequestBody (fork-sync hardening)', () => {
  it('drops binary and stream payloads instead of indexing their bytes', () => {
    expect(captureRequestBody(Buffer.from('{"a":1}'))).toBeUndefined();
    expect(captureRequestBody(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(captureRequestBody({ pipe: () => undefined })).toBeUndefined();
  });

  it('keeps URLSearchParams as a redacted string and survives cycles', () => {
    expect(captureRequestBody(new URLSearchParams({ a: '1', password: SECRET }))).toBe('a=1&password=REDACTED');
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(captureRequestBody(cyclic)).toEqual({ a: 1, self: '[Circular]' });
  });
});

describe('body size work is bounded by the cap (review low note)', () => {
  it('decodes only the capped prefix of a huge Buffer', () => {
    process.env.RAW_CAPTURE_MAX_BODY_BYTES = '1024';
    // Invalid UTF-8 throughout: the old path decoded all of it to U+FFFD.
    const huge = Buffer.alloc(8 * 1024 * 1024, 0xff);
    const normalized = normalizeBody(huge, 'text/plain')!;

    expect(normalized.bytes).toBe(huge.byteLength);
    expect((normalized.value as string).length).toBeLessThanOrEqual(1024);
  });

  it('skips binary content types without decoding', () => {
    expect(normalizeBody(Buffer.alloc(16), 'application/pdf')).toBeNull();
    expect(normalizeBody(Buffer.alloc(16), 'image/png')).toBeNull();
  });

  it('truncateUtf8 never splits a character and keeps a real U+FFFD', () => {
    expect(truncateUtf8('abécd', 3)).toBe('ab');
    expect(truncateUtf8('a�b', 4)).toBe('a�');
    expect(truncateUtf8('x\u{1F600}y', 4)).toBe('x');
    expect(truncateUtf8('short', 10)).toBe('short');
  });

  it('sanitizes adversarial text in linear time', () => {
    const sink = createRawCaptureSink();
    registerRawCaptureSecrets(Array.from({ length: 40 }, (_, i) => `FAKE_SECRET_VALUE_${i}_ABCDEFG`), sink);
    // Unterminated quotes, endless key-like runs and `=` without `&`: inputs a
    // backtracking pattern would choke on.
    const inputs = [
      `{"${'a'.repeat(2_000_000)}`,
      `{"token":"${'a'.repeat(2_000_000)}`,
      `"${'\\"'.repeat(500_000)}`,
      '"k":'.repeat(400_000),
      ',"token":'.repeat(200_000),
      `${'a='.repeat(30_000)}`,
    ];
    const started = Date.now();
    for (const input of inputs) sanitizeCapturedValue(input, sink);
    // The work is a few linear passes (well under 1 s on a laptop); the bound
    // is generous for slow CI machines but far below quadratic behaviour.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
