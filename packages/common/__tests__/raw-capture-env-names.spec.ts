import {
  captureUrl,
  createRawCaptureSink,
  envSecretValues,
  redactUrl,
  sanitizeCapturedValue,
} from '../src/http/raw-capture';

/**
 * Fork-sync hardening, round 3 (final verification of Spec 1761, http, api and
 * combined lanes): one environment-variable classifier for every raw-capture
 * pass, with what only the API layer knew moved into the capture layer:
 *
 * - `*_PUBLISHER_ID`, `*_USER_ID`, `*_ACCOUNT_ID`, `*_AFFID`, `*_PASS`, `*_PWD`
 *   are credentials, and a named credential counts from 6 characters (a short
 *   publisher id), so the sink scrubs them, not only the API's last pass;
 * - names that describe a credential setting (`API_KEY_HEADER_NAME=x-api-key`,
 *   `*_HEADER`, `*_URL`, `*_TYPE`) and `KEYWORD(S)` lists are not credentials,
 *   so their values are no longer scrubbed out of every capture;
 * - the CareerOneStop user id in the URL path is a credential for `redactUrl`
 *   too, so HttpClient log lines lose it as well;
 * - a `__proto__` key of JSON text stays an own field of the redacted copy.
 *
 * Every value below is an obvious fake.
 */

const setEnvNames: string[] = [];
function setEnv(name: string, value: string): void {
  setEnvNames.push(name);
  process.env[name] = value;
}

afterEach(() => {
  for (const name of setEnvNames.splice(0)) delete process.env[name];
});

const FAKE = 'FAKE_VALUE_123456';

describe('which env names hold credentials (one classifier)', () => {
  it.each([
    'JOOBLE_API_KEY',
    'ADZUNA_APP_KEY',
    'ADZUNA_APP_ID',
    'PERSONIO_CLIENT_SECRET',
    'PERSONIO_CLIENT_ID',
    'UPWORK_REFRESH_TOKEN',
    'CAREERONESTOP_USER_ID',
    'TALROO_PUBLISHER_PASS',
    'TALROO_PUBLISHER_ID',
    'SOME_PARTNER_ACCOUNT_ID',
    'CAREERJET_AFFID',
    'BULLHORN_CORP_TOKEN',
    'LEGACY_DB_PWD',
    'API_KEYS',
    'npm_config_authtoken',
    'SEARCH_KEYWORDS_API_KEY',
  ])('%s is a credential', (name) => {
    expect(envSecretValues({ [name]: FAKE })).toEqual([FAKE]);
  });

  it.each([
    'API_KEY_HEADER_NAME',
    'EVER_JOBS_API_KEY_HEADER',
    'API_KEY_HEADER',
    'KEYWORDS_DEFAULT',
    'EVER_JOBS_SEARCH_KEYWORDS',
    'SOME_TOKEN_URL',
    'UPWORK_GRANT_TYPE',
    'SESSION_COOKIE_TTL',
    'SESSIONNAME',
    'JOBSBYLEVEL_MAX_PAGES',
    'EVER_JOBS_STORE',
  ])('%s is not', (name) => {
    expect(envSecretValues({ [name]: FAKE })).toEqual([]);
  });

  it('takes named credentials from 6 characters, never plain setting values', () => {
    expect(envSecretValues({ TALROO_PUBLISHER_ID: '123456', SHORT_TOKEN: 'abcde' })).toEqual(['123456']);
    expect(envSecretValues({ ENABLE_API_KEY_AUTH: 'enabled', SOME_TOKEN: 'disabled' })).toEqual([]);
  });
});

describe('the sink scrubs what only the API pass used to', () => {
  it('a Talroo publisher id and pass never reach a captured URL', () => {
    setEnv('TALROO_PUBLISHER_ID', 'pubFAKE8842');
    setEnv('TALROO_PUBLISHER_PASS', 'FAKEPASS_99887766');
    const url = 'https://api.jobs2careers.com/api/search.php?id=pubFAKE8842&pass=FAKEPASS_99887766&format=json&q=x';
    expect(captureUrl(url, createRawCaptureSink())).toBe(
      'https://api.jobs2careers.com/api/search.php?id=REDACTED&pass=REDACTED&format=json&q=x',
    );
  });

  it('a 6-digit publisher id is scrubbed as text and as a JSON number', () => {
    setEnv('TALROO_PUBLISHER_ID', '123456');
    const sink = createRawCaptureSink();
    expect(sanitizeCapturedValue({ publisher: 123456, page: 2 }, sink)).toEqual({ publisher: 'REDACTED', page: 2 });
    expect(sanitizeCapturedValue('<p>publisher 123456</p>', sink)).toBe('<p>publisher REDACTED</p>');
  });

  it('an ACCOUNT_ID / USER_ID / AFFID value is scrubbed from a body', () => {
    setEnv('SOME_PARTNER_ACCOUNT_ID', 'FAKE_ACCOUNT_77');
    setEnv('CAREERONESTOP_USER_ID', 'FAKEUSER42');
    setEnv('CAREERJET_AFFID', 'FAKEAFF0099');
    const out = sanitizeCapturedValue(
      '<p>FAKE_ACCOUNT_77 FAKEUSER42 FAKEAFF0099</p>',
      createRawCaptureSink(),
    );
    expect(out).toBe('<p>REDACTED REDACTED REDACTED</p>');
  });
});

describe('settings about credentials are not scrubbed (no over-redaction)', () => {
  it('API_KEY_HEADER_NAME=x-api-key leaves the header name in captures', () => {
    setEnv('API_KEY_HEADER_NAME', 'x-api-key');
    const text = '<p>Send your key in the x-api-key header.</p>';
    expect(sanitizeCapturedValue(text, createRawCaptureSink())).toBe(text);
    expect(sanitizeCapturedValue({ header: 'x-api-key' }, createRawCaptureSink())).toEqual({ header: 'x-api-key' });
  });

  it('a keyword list leaves its words in captures', () => {
    setEnv('EVER_JOBS_SEARCH_KEYWORDS', 'engineer,designer');
    const text = 'Senior engineer and designer roles';
    expect(sanitizeCapturedValue(text, createRawCaptureSink())).toBe(text);
  });
});

describe('CareerOneStop path credential', () => {
  it.each([
    [
      'https://api.careeronestop.org/v2/jobsearch/FAKEUSER42/nurse/NY/25/0/0/0/10/30',
      'https://api.careeronestop.org/v2/jobsearch/REDACTED/nurse/NY/25/0/0/0/10/30',
    ],
    ['https://api.careeronestop.org/v2/jobsearch/FAKEUSER42', 'https://api.careeronestop.org/v2/jobsearch/REDACTED'],
    ['https://www.careeronestop.org/Developers/WebAPI/registration.aspx', 'https://www.careeronestop.org/Developers/WebAPI/registration.aspx'],
  ])('redactUrl(%s) (HttpClient log lines use it)', (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });
});

describe('a __proto__ key of JSON text', () => {
  it('stays an own field of the redacted copy and changes no prototype', () => {
    const out = sanitizeCapturedValue('{"__proto__":{"polluted":true},"token":"FAKE_TOKEN_1"}') as string;
    expect(out).toBe('{"__proto__":{"polluted":true},"token":"REDACTED"}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
