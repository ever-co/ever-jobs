import type { RawHttpEntry } from '@ever-jobs/models';
import {
  createRawCaptureScrubber,
  isSecretEnvName,
  rawCaptureAuthSecrets,
  scrubRawEntry,
  scrubRawErrorText,
  scrubRawUrl,
} from '../src/http/raw-capture';

/**
 * Fork-sync hardening, round 3: the API's last pass over `raw_by_source`
 * (`apps/api/src/jobs/raw-entry-redaction.ts`) now runs the capture layer's
 * own rules through `createRawCaptureScrubber` / `scrubRawEntry`, with the
 * same two tiers as a sink: server-held secrets first, caller-chosen values
 * second. Every value below is an obvious fake.
 */

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

describe('isSecretEnvName', () => {
  it.each([
    ['ADZUNA_APP_ID', true],
    ['TALROO_PUBLISHER_ID', true],
    ['TALROO_PUBLISHER_PASS', true],
    ['CAREERJET_AFFID', true],
    ['EVER_JOBS_INCLUDE_RAW_API_KEYS', true],
    ['API_KEY_HEADER_NAME', false],
    ['EVER_JOBS_API_KEY_HEADER', false],
    ['KEYWORDS_DEFAULT', false],
    ['UPWORK_TOKEN_URL', false],
    ['PASSENGER_LIST', false],
    ['TZ', false],
  ])('%s → %s', (name, expected) => {
    expect(isSecretEnvName(name)).toBe(expected);
  });
});

describe('rawCaptureAuthSecrets', () => {
  it('takes credential fields and account ids of the auth block, not subdomains or emails', () => {
    const values = rawCaptureAuthSecrets({
      adzuna: { appId: 'FAKE_CALLER_ID_1', appKey: 'FAKE_CALLER_KEY_1' },
      careerjet: { affId: 'FAKEAFF01' },
      bamboohr: { apiKey: 'FAKE_BAMBOO_KEY_1', subdomain: 'acmecorp' },
      bullhorn: { corpToken: 'FAKE_CORP_TOKEN_1' },
      greenhouse: { email: 'someone@example.test' },
    });
    expect(values.sort()).toEqual(
      ['FAKEAFF01', 'FAKE_BAMBOO_KEY_1', 'FAKE_CALLER_ID_1', 'FAKE_CALLER_KEY_1', 'FAKE_CORP_TOKEN_1'].sort(),
    );
  });

  it('takes every string of an array under a credential field, and skips short or setting values', () => {
    expect(rawCaptureAuthSecrets({ x: { apiKeys: ['FAKE_KEY_ONE_1', 'FAKE_KEY_TWO_2'], token: 'abc', secret: 'enabled' } }).sort())
      .toEqual(['FAKE_KEY_ONE_1', 'FAKE_KEY_TWO_2']);
    expect(rawCaptureAuthSecrets(undefined)).toEqual([]);
    expect(rawCaptureAuthSecrets('FAKE_TOP_LEVEL_STRING')).toEqual([]);
  });
});

describe('createRawCaptureScrubber + scrubRawEntry', () => {
  const env = { TALROO_PUBLISHER_ID: 'pubFAKE8842', TALROO_PUBLISHER_PASS: 'FAKEPASS_99887766' };
  const talrooUrl = 'https://api.jobs2careers.com/api/search.php?id=pubFAKE8842&pass=FAKEPASS_99887766&format=json';

  it('a caller value overlapping a server secret neither hides nor exposes it (server tier first)', () => {
    const urls = new Set<string>();
    for (const guess of ['p', 'Q', 'pubF']) {
      const scrubber = createRawCaptureScrubber({
        env,
        caller: rawCaptureAuthSecrets({ jooble: { apiKey: `search.php?id=${guess}` } }),
      });
      urls.add(scrubRawEntry(entry({ url: talrooUrl }), scrubber).url);
    }
    expect([...urls]).toEqual(['https://api.jobs2careers.com/api/search.php?id=REDACTED&pass=REDACTED&format=json']);
  });

  it('still scrubs caller values, after the server pass', () => {
    const scrubber = createRawCaptureScrubber({ env: {}, caller: ['FAKE_CALLER_KEY_5555'] });
    expect(scrubRawEntry(entry({ body: '<echo>FAKE_CALLER_KEY_5555</echo>' }), scrubber).body).toBe(
      '<echo>REDACTED</echo>',
    );
  });

  it('keeps a JSON text body with nothing to redact exactly as received', () => {
    const text = '{\n  "id": 12345678901234567890,\n  "title": "Engineer",\n  "a": 1,\n  "a": 2\n}';
    const scrubber = createRawCaptureScrubber({ env });
    expect(scrubRawEntry(entry({ body: text }), scrubber).body).toBe(text);
  });

  it('removes credentials from every field by value, key name and URL shape, and returns a copy', () => {
    const scrubber = createRawCaptureScrubber({ env: { ...env, PERSONIO_CLIENT_SECRET: 'FAKE_PERSONIO_SECRET_1' } });
    const original = entry({
      method: 'POST',
      url: 'https://jooble.org/api/FAKE-JOOBLE-KEY-0000',
      final_url: 'https://api.careeronestop.org/v2/jobsearch/FAKEUSER42/nurse',
      error: `GET ${talrooUrl} failed`,
      request_body: { client_secret: 'FAKE_PERSONIO_SECRET_1', note: 'id pubFAKE8842' },
      body: '{"access_token":"FAKE_ISSUED_1","jobs":[]}',
      content_type: 'application/json',
    });
    const out = scrubRawEntry(original, scrubber);
    expect(out).not.toBe(original);
    expect(out.url).toBe('https://jooble.org/api/REDACTED');
    expect(out.final_url).toBe('https://api.careeronestop.org/v2/jobsearch/REDACTED/nurse');
    expect(out.error).toBe('GET https://api.jobs2careers.com/api/search.php?id=REDACTED&pass=REDACTED&format=json failed');
    expect(out.request_body).toEqual({ client_secret: 'REDACTED', note: 'id REDACTED' });
    expect(out.body).toBe('{"access_token":"REDACTED","jobs":[]}');
    expect(original.request_body).toEqual({ client_secret: 'FAKE_PERSONIO_SECRET_1', note: 'id pubFAKE8842' });
  });

  it('drops the bodies of an entry with bodies_withheld', () => {
    const out = scrubRawEntry(entry({ bodies_withheld: 'auth_endpoint', body: 'x', request_body: { a: 1 } }));
    expect(out).not.toHaveProperty('body');
    expect(out).not.toHaveProperty('request_body');
    expect(out.bodies_withheld).toBe('auth_endpoint');
  });

  it('scrubRawUrl / scrubRawErrorText apply the same rules; without a scrubber only structure and key names', () => {
    const scrubber = createRawCaptureScrubber({ env });
    expect(scrubRawUrl(talrooUrl, scrubber)).toBe(
      'https://api.jobs2careers.com/api/search.php?id=REDACTED&pass=REDACTED&format=json',
    );
    expect(scrubRawErrorText(`timeout calling ${talrooUrl}`, scrubber)).toBe(
      'timeout calling https://api.jobs2careers.com/api/search.php?id=REDACTED&pass=REDACTED&format=json',
    );
    expect(scrubRawUrl(talrooUrl)).toBe(
      'https://api.jobs2careers.com/api/search.php?id=pubFAKE8842&pass=REDACTED&format=json',
    );
  });

  it('handles deep and cyclic bodies without throwing', () => {
    let deep: Record<string, unknown> = { token: 'FAKE_DEEP_TOKEN' };
    for (let i = 0; i < 50_000; i++) deep = { child: deep };
    expect(() => scrubRawEntry(entry({ body: deep }))).not.toThrow();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(scrubRawEntry(entry({ body: cyclic })).body).toEqual({ a: 1, self: '[Circular]' });
  });
});
