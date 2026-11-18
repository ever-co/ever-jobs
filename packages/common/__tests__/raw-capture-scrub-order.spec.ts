import axios from 'axios';
import type { RawCaptureSink } from '@ever-jobs/models';
import {
  captureRequestBody,
  captureUrl,
  createRawCaptureSink,
  drainRawCapture,
  normalizeBody,
  pushRawEntry,
  registerRawCaptureSecrets,
  registerServerRawCaptureSecrets,
  retainBody,
  retainBufferBody,
  sanitizeCapturedValue,
} from '../src/http/raw-capture';

/**
 * Fork-sync hardening, round 3 (final verification of Spec 1761, http lane):
 *
 * 1. The free-text key-name rules ran before the value scrub. They end a value
 *    at `;` `&` `)` `]` `}` `<` `>`, a quote or a space, so a known secret
 *    holding one of those, after a credential-named key, lost only its head
 *    and its tail stayed in clear.
 * 2. JSON text that parsed and needed no key redaction was returned as
 *    received, without the value scrub — but `JSON.parse` drops an earlier
 *    duplicate key and rounds big integers, so a secret in either was kept.
 * 3. CDATA was only redacted right after `>` and without `]` / `<` inside;
 *    `name="access_token" value="…"` attribute pairs were not covered.
 * 4. The value scrub did not know the axios `params` and `URLSearchParams`
 *    serializations of a secret.
 *
 * Every secret below is an obvious fake.
 */

const setEnvNames: string[] = [];
function setEnv(name: string, value: string): void {
  setEnvNames.push(name);
  process.env[name] = value;
}

afterEach(() => {
  for (const name of setEnvNames.splice(0)) delete process.env[name];
});

const baseEntry = {
  attempt: 0,
  method: 'POST',
  url: 'https://example.com/login',
  status: 401,
  elapsed_ms: 1,
  body_bytes: 0,
  truncated: false,
};

async function drainedBody(sink: RawCaptureSink, body: string, contentType = 'text/plain'): Promise<unknown> {
  const entry = pushRawEntry(sink, { ...baseEntry })!;
  retainBody(sink, entry, normalizeBody(body, contentType));
  await drainRawCapture(sink, 50);
  return entry.body;
}

// ---------------------------------------------------------------------------
// 1. Value scrub before the key-name text rules
// ---------------------------------------------------------------------------

describe('a known secret holding a value delimiter is redacted whole (round 3, issue 1)', () => {
  const cases: Array<[string, string, (secret: string) => string]> = [
    ['a semicolon', 'Xy7;Kp9#Qw2!Lm4', (s) => `Login failed: user=bob password=${s} (attempt 1)`],
    ['spaces', 'correct horse battery staple', (s) => `2026-11-18 auth retry client_secret=${s}\n`],
    ['an ampersand', 'Ab12&Cd34Ef56', (s) => `<p>Your api_key=${s} was rejected</p>`],
    ['parentheses', 'Pw(2026)SecretX', (s) => `token=${s} end`],
    ['a bracket', 'K9]zz8888xx', (s) => `var q = "a"; session=${s} more`],
    ['a brace and angle brackets', 'Qz}7<8>9wvut', (s) => `debug: token=${s} done`],
  ];

  it.each(cases)('an env secret with %s', (_label, secret, make) => {
    setEnv('EJ_TEST_UPSTREAM_PASSWORD', secret);
    expect(sanitizeCapturedValue(make(secret), createRawCaptureSink())).toBe(make('REDACTED'));
  });

  it.each(cases)('a server-registered secret with %s, through retainBody and drain', async (_label, secret, make) => {
    const sink = createRawCaptureSink();
    registerServerRawCaptureSecrets(secret, sink);
    expect(await drainedBody(sink, make(secret))).toBe(make('REDACTED'));
  });

  it.each(cases)('a caller-registered secret with %s', (_label, secret, make) => {
    const sink = createRawCaptureSink();
    registerRawCaptureSecrets(secret, sink);
    expect(sanitizeCapturedValue(make(secret), sink)).toBe(make('REDACTED'));
  });

  it('a form request body keeps no tail of a secret holding `&`', () => {
    const sink = createRawCaptureSink();
    registerServerRawCaptureSecrets('Ab12&Cd=34Ef56', sink);
    expect(captureRequestBody('username=bob&password=Ab12&Cd=34Ef56', sink)).toBe('username=bob&password=REDACTED');
  });

  it('a URL keeps no tail of a path secret holding `/`', () => {
    const sink = createRawCaptureSink();
    registerServerRawCaptureSecrets('FAKEKEY/0011aabb', sink);
    expect(captureUrl('https://jooble.org/api/FAKEKEY/0011aabb', sink)).toBe('https://jooble.org/api/REDACTED');
  });
});

// ---------------------------------------------------------------------------
// 2. JSON text that parses still gets the value scrub
// ---------------------------------------------------------------------------

describe('JSON text that parses is value-scrubbed as received (round 3, issue 2)', () => {
  const TOKEN = 'FAKE_ISSUED_TOKEN_9876';

  it('an earlier duplicate key does not hide a server-registered token', () => {
    const sink = createRawCaptureSink();
    registerServerRawCaptureSecrets(TOKEN, sink);
    const out = sanitizeCapturedValue(`{"access_token":"${TOKEN}","access_token":null}`, sink);
    expect(out).toBe('{"access_token":"REDACTED","access_token":null}');
  });

  it('an earlier duplicate key does not hide an env secret under an ordinary key', () => {
    setEnv('EJ_TEST_PROVIDER_API_KEY', 'FAKE_SERVER_KEY_abcdef123');
    const out = sanitizeCapturedValue('{"echo":"FAKE_SERVER_KEY_abcdef123","echo":"x"}', createRawCaptureSink());
    expect(out).toBe('{"echo":"REDACTED","echo":"x"}');
  });

  it('an integer past 2^53 that equals an env secret is redacted', () => {
    setEnv('EJ_TEST_PROVIDER_APP_ID', '12345678901234567891');
    const out = sanitizeCapturedValue('{"account":12345678901234567891}', createRawCaptureSink()) as string;
    expect(out).not.toContain('1234567890123456');
    expect(out).toContain('REDACTED');
  });

  it('end to end: a browser text body with a duplicate key', async () => {
    const sink = createRawCaptureSink();
    registerServerRawCaptureSecrets(TOKEN, sink);
    const entry = pushRawEntry(sink, { ...baseEntry })!;
    retainBufferBody(sink, entry, Buffer.from(`{"echo":"${TOKEN}","echo":"x"}`), 'text/plain');
    await drainRawCapture(sink, 50);
    expect(JSON.stringify(sink.entries)).not.toContain(TOKEN);
  });

  it('still returns JSON text with nothing to redact exactly as received', () => {
    const text = '{\n  "id": 12345678901234567890,\n  "title": "Engineer",\n  "a": 1,\n  "a": 2\n}';
    const sink = createRawCaptureSink();
    registerServerRawCaptureSecrets(TOKEN, sink);
    expect(sanitizeCapturedValue(text, sink)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// 3. XML: CDATA anywhere in a credential element, and value attributes
// ---------------------------------------------------------------------------

describe('XML credential values in CDATA and attributes (round 3, issue 3)', () => {
  const V = 'SECRETVAL_123456';

  it.each([
    // The element rule then replaces the whole text, whitespace included.
    ['CDATA with spaces around it', `<token> <![CDATA[${V}]]> </token>`, '<token>REDACTED</token>'],
    ['CDATA holding `]`', `<r><password><![CDATA[ab]cd${V}]]></password></r>`, '<r><password>REDACTED</password></r>'],
    ['CDATA holding `<`', `<r><password><![CDATA[a<b${V}]]></password></r>`, '<r><password>REDACTED</password></r>'],
    [
      'pretty-printed CDATA',
      `<r>\n  <ns:client_secret attr="1">\n    <![CDATA[${V}]]>\n  </ns:client_secret>\n</r>`,
      '<r>\n  <ns:client_secret attr="1">REDACTED</ns:client_secret>\n</r>',
    ],
    [
      'a value split over two CDATA sections',
      `<password><![CDATA[ab]]]]><![CDATA[>${V}]]></password>`,
      '<password>REDACTED</password>',
    ],
    ['an unterminated CDATA value', `<r><password><![CDATA[${V}`, '<r><password>REDACTED'],
    ['a param name/value pair', `<param name="access_token" value="${V}"/>`, '<param name="access_token" value="REDACTED"/>'],
    [
      'a hidden input',
      `<input type="hidden" name="client_secret" value="${V}">`,
      '<input type="hidden" name="client_secret" value="REDACTED">',
    ],
    ['a password input', `<input type="password" name="pw1" value='${V}'>`, `<input type="password" name="pw1" value='REDACTED'>`],
    ['a credential element with a value attribute', `<token value="${V}"/>`, '<token value="REDACTED"/>'],
    ['value before name, unquoted', `<input value=${V} name=api_key>`, '<input value=REDACTED name=api_key>'],
  ])('redacts %s', (_label, text, expected) => {
    expect(sanitizeCapturedValue(text)).toBe(expected);
  });

  it.each([
    '<desc><![CDATA[Great <b>team</b> ]] and more]]></desc>',
    '<input type="text" name="q" value="nurse">',
    '<select><option value="42" selected>x</option></select>',
    '<param name="movie" value="intro.swf"/>',
    '<input name="api_key" value="">',
    '<password/><![CDATA[not a password value]]>',
  ])('leaves %s alone', (text) => {
    expect(sanitizeCapturedValue(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// 4. axios params and URLSearchParams serializations
// ---------------------------------------------------------------------------

describe('serialized forms of a secret (round 3, issue 4)', () => {
  const SECRET = "p@ss:w0rd$x,y/z [q]!'()~*";

  it('the axios params serialization (axios.getUri) is redacted', () => {
    const sink = createRawCaptureSink();
    registerServerRawCaptureSecrets(SECRET, sink);
    const url = axios.getUri({ url: 'https://h.example.com/x', params: { user_ref: SECRET, page: 2 } });
    expect(url).not.toContain(encodeURIComponent(SECRET)); // axios really does differ from encodeURIComponent
    expect(captureUrl(url, sink)).toBe('https://h.example.com/x?user_ref=REDACTED&page=2');
  });

  it('the URLSearchParams serialization is redacted, in a URL and in a text body', async () => {
    const sink = createRawCaptureSink();
    registerServerRawCaptureSecrets(SECRET, sink);
    const query = new URLSearchParams({ user_ref: SECRET, page: '2' }).toString();
    expect(captureUrl(`https://h.example.com/x?${query}`, sink)).toBe('https://h.example.com/x?user_ref=REDACTED&page=2');
    expect(await drainedBody(sink, `<a href="/next?${query}">next</a>`, 'text/html')).toBe(
      '<a href="/next?user_ref=REDACTED&page=2">next</a>',
    );
  });
});

// ---------------------------------------------------------------------------
// The changed and new rules stay linear
// ---------------------------------------------------------------------------

describe('the round-3 rules stay linear on hostile input', () => {
  it('sanitizes 1-2 MB adversarial CDATA, tag and attribute inputs quickly', () => {
    const sink = createRawCaptureSink();
    registerRawCaptureSecrets(['FAKE_ABCDEFGH', 'aaaaaaaa'], sink);
    const inputs = [
      '<token><![CDATA['.repeat(120_000),
      `${'<token><![CDATA['.repeat(60_000)}${'a'.repeat(100_000)}]]>junk`,
      `<token>${' '.repeat(2_000_000)}<![CDATA[x]]>`,
      `<token ${'a'.repeat(1_000)}`.repeat(1_500),
      `<${'a'.repeat(200)} value=x>`.repeat(8_000),
      `<p ${'x '.repeat(2_000)}value=1>`.repeat(250),
      `<input name="token" value="${'a'.repeat(1_500_000)}`,
      `<i ${' name=" name='.repeat(100_000)} value="1">`,
      '<a value='.repeat(200_000),
      ']]>'.repeat(500_000),
      '<![CDATA[]]>'.repeat(150_000),
    ];
    const started = Date.now();
    for (const input of inputs) sanitizeCapturedValue(input, sink);
    // A few linear passes per input (well under 1 s on a laptop); the bound is
    // generous for old CI CPUs but far below quadratic behaviour.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
