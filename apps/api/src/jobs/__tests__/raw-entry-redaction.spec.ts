import { Logger } from '@nestjs/common';
import type { RawHttpEntry } from '@ever-jobs/models';
import { collectRawCaptureSecrets, redactRawEntry } from '../raw-entry-redaction';

/**
 * Credential scrub for `include_raw` entries (Spec 5161, fork-sync hardening,
 * finding 5), now a thin last pass over the capture layer's own rules
 * (round 3). The name classifiers, URL and body rules it used to carry are
 * tested where they live, in `packages/common/__tests__/raw-capture-*.spec.ts`.
 * Every value below is an obvious fake.
 */
describe('raw-entry-redaction', () => {
  const REDACTED = 'REDACTED';
  const JOOBLE_KEY = 'FAKE-JOOBLE-KEY-0000-1111';
  const ADZUNA_ID = 'FAKEID01';
  const ADZUNA_KEY = 'FAKE_ADZUNA_KEY_123456';
  const PERSONIO_ID = 'FAKE_PERSONIO_CLIENT_ID';
  const PERSONIO_SECRET = 'FAKE_PERSONIO_SECRET_123456';
  const UPWORK_SECRET = 'FAKE_UPWORK_SECRET_654321';
  const CAREERONESTOP_USER = 'FAKEUSER42';
  const ISSUED_TOKEN = 'FAKE_ISSUED_ACCESS_TOKEN_999';

  const env = {
    JOOBLE_API_KEY: JOOBLE_KEY,
    ADZUNA_APP_ID: ADZUNA_ID,
    ADZUNA_APP_KEY: ADZUNA_KEY,
    PERSONIO_CLIENT_ID: PERSONIO_ID,
    PERSONIO_CLIENT_SECRET: PERSONIO_SECRET,
    UPWORK_CLIENT_SECRET: UPWORK_SECRET,
    CAREERONESTOP_USER_ID: CAREERONESTOP_USER,
    // Settings that are not credentials must not be scrubbed.
    ENABLE_API_KEY_AUTH: 'true',
    API_KEY_HEADER_NAME: 'x-api-key',
    JOBSBYLEVEL_MAX_PAGES: '123456',
    EVER_JOBS_STORE: 'postgres-main',
  };
  const secrets = collectRawCaptureSecrets(env);
  const noSecrets = collectRawCaptureSecrets({});
  const ALL_FAKES = [
    JOOBLE_KEY, ADZUNA_ID, ADZUNA_KEY, PERSONIO_ID, PERSONIO_SECRET, UPWORK_SECRET,
    CAREERONESTOP_USER, ISSUED_TOKEN,
  ];

  const entry = (fields: Partial<RawHttpEntry>): RawHttpEntry => ({
    seq: 0,
    attempt: 0,
    method: 'GET',
    url: 'https://example.test/',
    status: 200,
    elapsed_ms: 5,
    body_bytes: 10,
    truncated: false,
    ...fields,
  });

  describe('the reviewer reproductions', () => {
    it('Jooble: the key in the URL path is gone, by the host rule alone too', () => {
      const url = `https://jooble.org/api/${JOOBLE_KEY}`;
      expect(redactRawEntry(entry({ method: 'POST', url }), secrets).url).toBe(`https://jooble.org/api/${REDACTED}`);
      expect(redactRawEntry(entry({ url }), noSecrets).url).toBe(`https://jooble.org/api/${REDACTED}`);
    });

    it('Adzuna: app_id and app_key are gone from final_url', () => {
      const finalUrl =
        `https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=${ADZUNA_ID}` +
        `&app_key=${ADZUNA_KEY}&what=engineer`;
      expect(redactRawEntry(entry({ final_url: finalUrl }), secrets).final_url).toBe(
        'https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=REDACTED&app_key=REDACTED&what=engineer',
      );
      // The key-name rule alone removes the key.
      expect(redactRawEntry(entry({ final_url: finalUrl }), noSecrets).final_url).not.toContain(ADZUNA_KEY);
    });

    it('Personio: client_secret in request_body and the issued token in body are gone', () => {
      const out = redactRawEntry(
        entry({
          method: 'POST',
          url: 'https://api.personio.de/v1/auth',
          request_body: { client_id: PERSONIO_ID, client_secret: PERSONIO_SECRET },
          body: { success: true, data: { token: ISSUED_TOKEN } },
        }),
        secrets,
      );
      expect(out.request_body).toEqual({ client_id: REDACTED, client_secret: REDACTED });
      expect(out.body).toEqual({ success: true, data: { token: REDACTED } });
    });

    it('OAuth token responses: access and refresh tokens are gone, key order kept', () => {
      const body = {
        access_token: ISSUED_TOKEN,
        refresh_token: 'FAKE_REFRESH_TOKEN_777',
        token_type: 'bearer',
        expires_in: 3600,
      };
      const out = redactRawEntry(entry({ body }), secrets).body as Record<string, unknown>;
      expect(out.access_token).toBe(REDACTED);
      expect(out.refresh_token).toBe(REDACTED);
      expect(out.expires_in).toBe(3600);
      expect(Object.keys(out)).toEqual(['access_token', 'refresh_token', 'token_type', 'expires_in']);
    });

    it('a token response served as text is parsed and scrubbed', () => {
      const text = JSON.stringify({ access_token: ISSUED_TOKEN, scope: 'api' });
      const out = redactRawEntry(entry({ body: text }), secrets).body as string;
      expect(out).not.toContain(ISSUED_TOKEN);
      expect(JSON.parse(out)).toEqual({ access_token: REDACTED, scope: 'api' });
    });

    it('an error body that echoes the submitted secret loses it (value scrub)', () => {
      const body = `<error>invalid_client: ${UPWORK_SECRET} rejected</error>`;
      expect(redactRawEntry(entry({ body }), secrets).body).toBe(`<error>invalid_client: ${REDACTED} rejected</error>`);
    });

    it('a form-encoded body loses its credential params', () => {
      const form = `grant_type=client_credentials&client_id=SOMEID&client_secret=${encodeURIComponent('a b+c')}`;
      expect(redactRawEntry(entry({ request_body: form }), noSecrets).request_body).toBe(
        'grant_type=client_credentials&client_id=SOMEID&client_secret=REDACTED',
      );
    });

    it('CareerOneStop: the user id in the path is gone', () => {
      const url = `https://api.careeronestop.org/v2/jobsearch/${CAREERONESTOP_USER}/nurse/NY/25/0/0/0/10/30`;
      expect(redactRawEntry(entry({ url }), noSecrets).url).toBe(
        'https://api.careeronestop.org/v2/jobsearch/REDACTED/nurse/NY/25/0/0/0/10/30',
      );
    });

    it('no fake credential survives anywhere in a serialized entry', () => {
      const full = entry({
        method: 'POST',
        url: `https://jooble.org/api/${JOOBLE_KEY}`,
        final_url: `https://api.adzuna.com/v1/x?app_id=${ADZUNA_ID}&app_key=${ADZUNA_KEY}`,
        error: `Request to https://api.adzuna.com/v1/x?app_key=${ADZUNA_KEY} failed`,
        request_body: { nested: [{ note: `secret is ${PERSONIO_SECRET}` }], client_id: PERSONIO_ID },
        body: {
          data: { token: ISSUED_TOKEN },
          echo: `${UPWORK_SECRET}`,
          link: `https://api.careeronestop.org/v2/jobsearch/${CAREERONESTOP_USER}/a`,
        },
      });
      const serialized = JSON.stringify(redactRawEntry(full, secrets));
      for (const fake of ALL_FAKES) expect(serialized).not.toContain(fake);
    });
  });

  describe('round 3: the API pass uses the capture layer tiers and rules', () => {
    const talrooUrl = (id: string) =>
      `https://api.jobs2careers.com/api/search.php?id=${id}&pass=FAKEPASS_99887766&format=json&q=x`;

    it('a caller auth value overlapping a server publisher id cannot expose its tail', () => {
      const talrooEnv = { TALROO_PUBLISHER_ID: 'pubFAKE8842', TALROO_PUBLISHER_PASS: 'FAKEPASS_99887766' };
      const urls = new Set<string>();
      for (const guess of ['p', 'Q']) {
        const scrubber = collectRawCaptureSecrets(talrooEnv, { jooble: { apiKey: `search.php?id=${guess}` } });
        urls.add(redactRawEntry(entry({ url: talrooUrl('pubFAKE8842') }), scrubber).url);
      }
      // One answer for a right and a wrong first character: nothing to learn.
      expect([...urls]).toEqual([
        'https://api.jobs2careers.com/api/search.php?id=REDACTED&pass=REDACTED&format=json&q=x',
      ]);
    });

    it('a 6-digit publisher id is not exposed by an overlapping caller value either', () => {
      const scrubber = collectRawCaptureSecrets(
        { TALROO_PUBLISHER_ID: '123456', TALROO_PUBLISHER_PASS: 'FAKEPASS_99887766' },
        { jooble: { apiKey: 'php?id=1' } },
      );
      expect(redactRawEntry(entry({ url: talrooUrl('123456') }), scrubber).url).toBe(
        'https://api.jobs2careers.com/api/search.php?id=REDACTED&pass=REDACTED&format=json&q=x',
      );
    });

    it('a publisher id serialized by URLSearchParams is matched', () => {
      const scrubber = collectRawCaptureSecrets({ TALROO_PUBLISHER_ID: 'pub~1234!x' });
      const query = new URLSearchParams({ id: 'pub~1234!x', q: 'x' }).toString();
      expect(redactRawEntry(entry({ url: `https://api.jobs2careers.com/api/search.php?${query}` }), scrubber).url).toBe(
        'https://api.jobs2careers.com/api/search.php?id=REDACTED&q=x',
      );
    });

    it('keeps a JSON text body with nothing to redact exactly as received', () => {
      const text = '{\n  "id": 12345678901234567890,\n  "title": "Engineer",\n  "a": 1,\n  "a": 2\n}';
      expect(redactRawEntry(entry({ body: text, body_bytes: text.length }), secrets).body).toBe(text);
    });

    it('keeps an empty value under a credential key empty, as the capture layer does', () => {
      expect(redactRawEntry(entry({ body: '{"access_token":""}' }), secrets).body).toBe('{"access_token":""}');
      expect(redactRawEntry(entry({ body: { access_token: '' } }), secrets).body).toEqual({ access_token: '' });
    });

    it('leaves setting values such as the API key header name in place', () => {
      const body = '<p>Send your key in the x-api-key header.</p>';
      expect(redactRawEntry(entry({ body }), secrets).body).toBe(body);
    });
  });

  it('redactRawEntry returns a copy and leaves the captured entry untouched', () => {
    const original = entry({ request_body: { client_secret: PERSONIO_SECRET } });
    const out = redactRawEntry(original, secrets);
    expect(out).not.toBe(original);
    expect(original.request_body).toEqual({ client_secret: PERSONIO_SECRET });
  });

  it('scrubs a multi-MiB body in linear time (generous bound for slow CI)', () => {
    const many = collectRawCaptureSecrets(
      Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`SOURCE_${i}_API_KEY`, `FAKE_KEY_${i}_ABCDEFGH`])),
    );
    const html = '<div class="job">Engineer at Acme, apply today.</div>\n'.repeat(100_000); // ~5 MiB
    const json = { jobs: Array.from({ length: 50_000 }, (_, i) => ({ id: i, title: 'Engineer', key: 'x', city: 'Paris' })) };
    const started = Date.now();
    redactRawEntry(entry({ body: html }), many);
    redactRawEntry(entry({ body: json }), many);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  describe('round 4: the caller tier stays linear and never fails the search', () => {
    afterEach(() => jest.restoreAllMocks());

    // The round-3 verifier's reproduction: a long `auth` value and a search
    // term the URLs and the body echo, i.e. long near misses.
    const term = 'a'.repeat(60_000);
    const echoing = () =>
      entry({
        url: `https://api.jobs2careers.com/api/search.php?id=x&q=${term}`,
        final_url: `https://api.jobs2careers.com/api/search.php?id=x&q=${term}&p=2`,
        body: `<html><h1>Results for ${term}</h1>${'<p>job</p>'.repeat(1_000)}<input name=q value="${term}"></html>`,
      });

    it('a 30k auth value costs milliseconds, not seconds, and is ignored (logged by length only)', () => {
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const apiKey = `${'a'.repeat(30_000)} z`;
      const started = Date.now();
      const scrubber = collectRawCaptureSecrets({}, { jooble: { apiKey } });
      const outs = [echoing(), echoing(), echoing()].map((e) => redactRawEntry(e, scrubber));
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(outs[0].url).toBe(`https://api.jobs2careers.com/api/search.php?id=x&q=${term}`);
      const messages = debug.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes(String(apiKey.length)))).toBe(true);
      expect(messages.every((m) => !m.includes('a'.repeat(100)))).toBe(true);
    });

    it('a 38k auth value does not throw (it compiled into a regular expression too large)', () => {
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const scrubber = collectRawCaptureSecrets({}, { jooble: { apiKey: `${'a'.repeat(38_000)} z` } });
      const body = `<html>${'<p>ordinary job listing</p>'.repeat(2_000)}</html>`;
      expect(redactRawEntry(entry({ body }), scrubber).body).toBe(body);
    });

    it('a 4,096-character auth value of near misses (the cap) is matched in linear time', () => {
      const apiKey = `${'a'.repeat(2_000)}z${'a'.repeat(2_095)}`;
      const started = Date.now();
      const scrubber = collectRawCaptureSecrets({}, { jooble: { apiKey } });
      for (let i = 0; i < 3; i++) redactRawEntry(echoing(), scrubber);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(redactRawEntry(entry({ body: `<p>${apiKey}</p>` }), scrubber).body).toBe(`<p>${REDACTED}</p>`);
    });

    it('an auth block that cannot be read keeps the server tier and withholds bodies', () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const auth = {
        get jooble(): never {
          throw new Error('auth read failed');
        },
      };
      const scrubber = collectRawCaptureSecrets(env, auth);
      const out = redactRawEntry(
        entry({ url: `https://api.adzuna.com/v1/x?ref=${ADZUNA_KEY}`, body: 'body', request_body: { a: 1 } }),
        scrubber,
      );
      expect(out).not.toHaveProperty('body');
      expect(out).not.toHaveProperty('request_body');
      expect(out.truncated).toBe(true);
      expect(out.status).toBe(200);
      expect(out.url).toBe(`https://api.adzuna.com/v1/x?ref=${REDACTED}`);
    });

    it('an entry that cannot be scrubbed keeps its metadata only', () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const broken = entry({ url: `https://jooble.org/api/${JOOBLE_KEY}` });
      Object.defineProperty(broken, 'request_body', {
        enumerable: true,
        get(): never {
          throw new Error('request body read failed');
        },
      });
      const out = redactRawEntry(broken, secrets);
      expect(out).not.toHaveProperty('request_body');
      expect(out.truncated).toBe(true);
      expect(out.url).toBe(`https://jooble.org/api/${REDACTED}`);
    });
  });
});
