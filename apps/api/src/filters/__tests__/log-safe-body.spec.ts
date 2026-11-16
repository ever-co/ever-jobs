/**
 * Unit tests — log-safe request bodies (T-2520).
 */
import {
  LOG_SAFE_BODY_MAX_CHARS,
  REDACTED,
  serializeBodyForLog,
  toLogSafeBody,
} from '../log-safe-body';

describe('toLogSafeBody', () => {
  it('replaces every value under `auth` and keeps the keys', () => {
    const safe = toLogSafeBody({
      searchTerm: 'nurse',
      auth: {
        greenhouse: { apiKey: 'sk-secret', boardToken: 'acme' },
        upwork: { clientId: 'cid', clientSecret: 'cs', accessToken: 'at', refreshToken: 'rt' },
        bullhorn: { corpToken: 'ct' },
        list: ['a', 1, true, null],
      },
    });

    expect(JSON.parse(JSON.stringify(safe))).toEqual({
      searchTerm: 'nurse',
      auth: {
        greenhouse: { apiKey: REDACTED, boardToken: REDACTED },
        upwork: { clientId: REDACTED, clientSecret: REDACTED, accessToken: REDACTED, refreshToken: REDACTED },
        bullhorn: { corpToken: REDACTED },
        list: [REDACTED, REDACTED, REDACTED, REDACTED],
      },
    });
  });

  it('redacts `auth` in any letter case and nested under another key', () => {
    const text = JSON.stringify(toLogSafeBody({ input: { Auth: { lever: { apiKey: 'k-1' } } } }));
    expect(text).not.toContain('k-1');
    expect(text).toContain('"lever":{"apiKey":"[REDACTED]"}');
  });

  it.each([
    'apiKey',
    'api_key',
    'X-API-KEY',
    'appKey',
    'apiToken',
    'token',
    'clientSecret',
    'client_secret',
    'apiSecret',
    'accessToken',
    'refresh_token',
    'password',
    'passwd',
    'pwd',
    'passphrase',
    'Authorization',
    'cookie',
    'credentials',
    'privateKey',
    'signature',
    'sessionId',
  ])('redacts a value under the secret-looking key %s at any depth', (key) => {
    const text = JSON.stringify(toLogSafeBody({ crawl: { deep: [{ [key]: 'hidden-value' }] } }));
    expect(text).not.toContain('hidden-value');
    expect(text).toContain(`"${key}":"${REDACTED}"`);
  });

  it('redacts a whole object under a secret-looking key', () => {
    const text = JSON.stringify(toLogSafeBody({ credentials: { user: 'u-1', pass: 'p-1' } }));
    expect(text).toBe('{"credentials":{"user":"[REDACTED]","pass":"[REDACTED]"}}');
  });

  it('leaves ordinary search fields alone', () => {
    const body = {
      searchTerm: 'data engineer',
      location: 'Berlin',
      resultsWanted: 20,
      isRemote: true,
      siteType: ['indeed'],
      companyDomain: 'acme.example',
      crawl: { proxyRotation: 'per-host', userAgent: 'EverJobs/1.0' },
    };
    expect(JSON.parse(JSON.stringify(toLogSafeBody(body)))).toEqual(body);
  });

  it('hides user:password@ in proxy URLs and in any other string', () => {
    const text = JSON.stringify(
      toLogSafeBody({
        proxies: ['http://u:p@h:1', 'user:pa55@proxy.example:8080', 'http://open.example:3128'],
        note: 'via socks5://alice:s3cr3t@10.0.0.1:1080',
      }),
    );
    expect(text).not.toContain('u:p@');
    expect(text).not.toContain('pa55');
    expect(text).not.toContain('s3cr3t');
    expect(text).toContain('http://***@h:1');
    expect(text).toContain('***@proxy.example:8080');
    expect(text).toContain('http://open.example:3128');
  });

  it('copies a `__proto__` key as data without touching any prototype', () => {
    const body = JSON.parse('{"__proto__":{"apiKey":"pp-1"},"a":1}');
    const text = JSON.stringify(toLogSafeBody(body));
    expect(text).not.toContain('pp-1');
    expect(({} as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it('handles odd input without throwing', () => {
    expect(toLogSafeBody(undefined)).toBeUndefined();
    expect(toLogSafeBody(null)).toBeNull();
    expect(toLogSafeBody(42)).toBe(42);
    expect(toLogSafeBody('http://u:p@h:1')).toBe('http://***@h:1');
    expect(toLogSafeBody(Buffer.from('apiKey=sk-secret'))).toBe('[Binary 16 bytes]');
    expect(toLogSafeBody(new Date('2026-11-16T00:00:00Z'))).toBe('2026-11-16T00:00:00.000Z');
    expect(toLogSafeBody(10n)).toBe('10n');
    expect(toLogSafeBody(() => 1)).toBe('[function]');
  });

  it('marks a cycle instead of recursing', () => {
    const body: Record<string, unknown> = { a: 1 };
    body.self = body;
    body.list = [body];
    expect(JSON.stringify(toLogSafeBody(body))).toBe('{"a":1,"self":"[Circular]","list":["[Circular]"]}');
  });

  it('logs a shared (non-circular) object at each place it appears', () => {
    const shared = { x: 1 };
    expect(JSON.stringify(toLogSafeBody({ a: shared, b: shared }))).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('stops at a depth limit', () => {
    let deep: Record<string, unknown> = { leaf: 'end' };
    for (let i = 0; i < 50; i++) deep = { next: deep };
    const text = JSON.stringify(toLogSafeBody(deep));
    expect(text).toContain('[Truncated]');
    expect(text).not.toContain('end');
  });

  it('bounds the work on a huge array', () => {
    const safe = toLogSafeBody({ ids: Array.from({ length: 100_000 }, (_, i) => i) }) as { ids: unknown[] };
    expect(safe.ids.length).toBeLessThan(1_100);
    expect(String(safe.ids[safe.ids.length - 1])).toMatch(/^\[Truncated\] \d+ more$/);
  });

  it('returns a placeholder when the body cannot be read', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('nope');
        },
      },
    );
    expect(toLogSafeBody(hostile)).toBe('[Unserializable body]');
  });
});

describe('serializeBodyForLog', () => {
  it('serialises the redacted copy', () => {
    expect(serializeBodyForLog({ auth: { reed: { apiKey: 'r-1' } }, resultsWanted: 'x' })).toBe(
      '{"auth":{"reed":{"apiKey":"[REDACTED]"}},"resultsWanted":"x"}',
    );
  });

  it('caps the result and says how long it was', () => {
    const text = serializeBodyForLog({ searchTerm: 'a'.repeat(10_000) });
    expect(text.startsWith('{"searchTerm":"aaa')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(LOG_SAFE_BODY_MAX_CHARS + 60);
    expect(text).toMatch(/… \[truncated, 10017 chars in all\]$/);
  });

  it('redacts before cutting, so a cut cannot expose part of a secret', () => {
    const prefix = 'x'.repeat(LOG_SAFE_BODY_MAX_CHARS - 40);
    const text = serializeBodyForLog({ pad: prefix, proxies: ['http://user:longpassword@proxy.example:8080'] });
    expect(text).not.toContain('longpass');
    expect(text).not.toContain('user:');
  });

  it('accepts a custom cap', () => {
    expect(serializeBodyForLog({ a: 'bcdef' }, 5)).toBe('{"a":… [truncated, 13 chars in all]');
  });

  it('gives a string for undefined, primitives and a circular body', () => {
    expect(serializeBodyForLog(undefined)).toBe('undefined');
    expect(serializeBodyForLog('plain')).toBe('"plain"');
    const body: Record<string, unknown> = {};
    body.me = body;
    expect(serializeBodyForLog(body)).toBe('{"me":"[Circular]"}');
  });
});
