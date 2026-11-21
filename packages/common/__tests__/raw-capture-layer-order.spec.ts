import { Logger } from '@nestjs/common';
import type { RawCaptureSink, RawHttpEntry } from '@ever-jobs/models';
import {
  RAW_CAPTURE_MAX_CALLER_SECRET_LENGTH,
  RAW_CAPTURE_MAX_CALLER_SECRETS,
  captureErrorText,
  captureRequestBody,
  captureUrl,
  createRawCaptureScrubber,
  createRawCaptureSink,
  drainRawCapture,
  pushRawEntry,
  registerRawCaptureSecrets,
  retainBufferBody,
  sanitizeCapturedValue,
  scrubRawEntry,
  scrubRawUrl,
} from '../src/http/raw-capture';

/**
 * Fork-sync hardening, round 4 (verification of round 3):
 *
 * 1. Round 3 ran the whole value scrub before the key-name rules, so a
 *    caller-registered value covering a credential key name (`access_token`,
 *    `token":"`, `access_token=`) erased the key and the value under it,
 *    known only to the key-name layer, stayed in clear. The order is now
 *    server tier, key-name rules, caller tier — and the caller tier is
 *    redacted together with what the rules hide, so a caller value holding a
 *    delimiter is still not cut in half.
 * 2. JSON text was parsed AFTER the value scrub, so a numeric secret inside a
 *    bare JSON number broke the parse and the body dropped to the weaker
 *    free-text rules (an object under a credential key stayed in clear). The
 *    text is now parsed as received.
 * 3. An earlier duplicate of a credential key, dropped by `JSON.parse`, kept
 *    a value no secret list knew.
 * 4. The caller tier compiled every caller value into one regular expression:
 *    a long value cost value length × text length, and a 38k value threw
 *    `Regular expression too large`. Caller values are now capped, matched in
 *    linear time, and a scrub that cannot be built fails closed.
 *
 * Plus two HTML attribute shapes (optional review notes): the first of two
 * duplicate `value` attributes, and an attribute written right after a
 * quoted value with no space.
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
  jest.restoreAllMocks();
});

const baseEntry = {
  attempt: 0,
  method: 'GET',
  url: 'https://example.com/x',
  status: 200,
  elapsed_ms: 1,
  body_bytes: 0,
  truncated: false,
};

const entry = (fields: Partial<RawHttpEntry>): RawHttpEntry => ({ seq: 0, ...baseEntry, ...fields });

async function drainedTextBody(sink: RawCaptureSink, body: string): Promise<unknown> {
  const pushed = pushRawEntry(sink, { ...baseEntry })!;
  retainBufferBody(sink, pushed, Buffer.from(body), 'text/plain');
  await drainRawCapture(sink, 50);
  return pushed.body;
}

function sinkWithCaller(value: string): RawCaptureSink {
  const sink = createRawCaptureSink();
  registerRawCaptureSecrets(value, sink);
  return sink;
}

// ---------------------------------------------------------------------------
// 1. Server tier, key-name rules, caller tier
// ---------------------------------------------------------------------------

describe('a caller value covering a credential key name does not unmask its value (round 4, issue 1)', () => {
  // A value only the key-name layer can catch: neither an env value nor registered.
  const U = 'UNREGISTERED_TOKEN_ab12cd34';

  it.each([
    ['JSON text that parses', 'access_token', `{"access_token":"${U}","x":1}`, '{"REDACTED":"REDACTED","x":1}'],
    ['truncated JSON text', 'access_token', `{"a":1,"access_token":"${U}"`, '{"a":1,"REDACTED":"REDACTED"'],
    ['a form body', 'client_secret', `grant=x&client_secret=${U}&a=1`, 'grant=x&REDACTED=REDACTED&a=1'],
    ['form text in HTML', 'password=', `<p>retry with password=${U} now</p>`, '<p>retry with REDACTED now</p>'],
    ['an XML element', 'access_token', `<r><access_token>${U}</access_token></r>`, '<r><REDACTED>REDACTED</REDACTED></r>'],
    ['a CDATA section', 'password', `<r><password><![CDATA[${U}]]></password></r>`, '<r><REDACTED>REDACTED</REDACTED></r>'],
    [
      'a value attribute',
      'client_secret',
      `<input type="hidden" name="client_secret" value="${U}">`,
      '<input type="hidden" name="REDACTED" value="REDACTED">',
    ],
  ])('in %s', (_label, callerValue, text, expected) => {
    expect(sanitizeCapturedValue(text, sinkWithCaller(callerValue))).toBe(expected);
  });

  it('a generic caller value (token":") does not disable every *_token key', () => {
    const out = sanitizeCapturedValue(`{"refresh_token":"${U}","id_token":"${U}"}`, sinkWithCaller('token":"'));
    expect(out).not.toContain(U);
  });

  it.each([
    ['a query value', 'access_token=', `https://h/cb?access_token=${U}&a=1`, 'https://h/cb?REDACTED&a=1'],
    ['an 8-character key and separator', 'app_key=', `https://h/x?app_id=1&app_key=${U}&what=x`, 'https://h/x?app_id=1&REDACTED&what=x'],
    ['a fragment value', 'access_token', `https://h/cb#access_token=${U}&state=1`, 'https://h/cb#REDACTED=REDACTED&state=1'],
  ])('in a URL: %s', (_label, callerValue, url, expected) => {
    expect(captureUrl(url, sinkWithCaller(callerValue))).toBe(expected);
  });

  it('in error text', () => {
    const out = captureErrorText(`GET https://h/cb?access_token=${U} failed`, sinkWithCaller('access_token='));
    expect(out).toBe('GET https://h/cb?REDACTED failed');
  });

  it('in a form request body and URLSearchParams', () => {
    const sink = sinkWithCaller('client_secret');
    expect(captureRequestBody(`client_id=x&client_secret=${U}`, sink)).toBe('client_id=x&REDACTED=REDACTED');
    expect(captureRequestBody(new URLSearchParams({ client_id: 'x', client_secret: U }), sink)).toBe(
      'client_id=x&REDACTED=REDACTED',
    );
  });

  it('in the API pass (createRawCaptureScrubber + scrubRawEntry)', () => {
    const scrubber = createRawCaptureScrubber({ env: {}, caller: ['access_token'] });
    const out = scrubRawEntry(
      entry({ url: `https://h/cb?access_token=${U}`, body: `{"a":1,"access_token":"${U}"`, error: `GET https://h/cb?access_token=${U}` }),
      scrubber,
    );
    expect(JSON.stringify(out)).not.toContain(U);
  });

  it('end to end: a browser text body through retainBufferBody and drain', async () => {
    const sink = sinkWithCaller('access_token');
    expect(await drainedTextBody(sink, `{"a":1,"access_token":"${U}"`)).toBe('{"a":1,"REDACTED":"REDACTED"');
  });

  it('still never cuts a caller value that holds a delimiter, and joins it with what the rules redact', () => {
    const secret = 'Xy7;Kp9#Qw2!Lm4';
    expect(sanitizeCapturedValue(`password=${secret} (attempt 1)`, sinkWithCaller(secret))).toBe('password=REDACTED (attempt 1)');
    expect(captureUrl(`https://h/x?token=Ab12&Cd34Ef56&a=1`, sinkWithCaller('Ab12&Cd34Ef56'))).toBe('https://h/x?token=REDACTED&a=1');
    // A caller value that covers the key, the separator and the value at once.
    expect(sanitizeCapturedValue('<p>api_key=Ab12;Cd34 x</p>', sinkWithCaller('api_key=Ab12;Cd34'))).toBe('<p>REDACTED x</p>');
  });

  it('a caller value next to a server secret neither hides nor exposes it', () => {
    setEnv('EJ_TEST_PROVIDER_APP_ID', 'a1b2c3d4');
    const outputs = new Set<string>();
    for (const guess of '0123456789abcdef') {
      outputs.add(captureUrl('https://api.example.com/x?app_id=a1b2c3d4&page=2', sinkWithCaller(`?app_id=${guess}`)));
    }
    expect([...outputs]).toEqual(['https://api.example.com/x?app_id=REDACTED&page=2']);
  });
});

// ---------------------------------------------------------------------------
// 2. JSON text is parsed as received
// ---------------------------------------------------------------------------

describe('JSON text is parsed as received, before the value scrub (round 4, issue 2)', () => {
  const BS = '\\';

  it('a numeric secret inside a longer number does not drop the body to the free-text rules', () => {
    setEnv('EJ_TEST_PROVIDER_APP_ID', '12345678');
    const out = sanitizeCapturedValue(
      '{"job_id":9912345678001,"credentials":{"user":"bob","pw":"UNKNOWN_PW_4"}}',
      createRawCaptureSink(),
    );
    expect(out).toBe('{"job_id":"REDACTED","credentials":"REDACTED"}');
  });

  it('a bare-number secret does not unmask objects, arrays and escaped keys under credential keys', () => {
    setEnv('EJ_TEST_PROVIDER_APP_ID', '12345678');
    const text = `{"app":12345678,"session":{"id":"UNKNOWN_1"},"tokens":["UNKNOWN_2"],"${BS}u0074oken":"UNKNOWN_3"}`;
    expect(sanitizeCapturedValue(text, createRawCaptureSink())).toBe(
      '{"app":"REDACTED","session":"REDACTED","tokens":"REDACTED","token":"REDACTED"}',
    );
  });

  it('end to end: a browser text body through retainBufferBody and drain', async () => {
    setEnv('EJ_TEST_PROVIDER_APP_ID', '12345678');
    const body = await drainedTextBody(
      createRawCaptureSink(),
      '{"job_id":9912345678001,"credentials":{"user":"bob","pw":"UNKNOWN_PW_4"}}',
    );
    expect(body).toBe('{"job_id":"REDACTED","credentials":"REDACTED"}');
  });

  it('a body that is re-serialized never writes out the rounded digits of a big numeric secret', () => {
    setEnv('EJ_TEST_PROVIDER_APP_ID', '12345678901234567891');
    const out = sanitizeCapturedValue(
      '{"account":12345678901234567891,"access_token":"UNKNOWN_TOKEN_5"}',
      createRawCaptureSink(),
    ) as string;
    expect(out).toBe('{"account":"REDACTED","access_token":"REDACTED"}');
  });

  it('a big number that is not a secret is kept (rounded, as JSON.parse reads it) when the body is re-serialized', () => {
    setEnv('EJ_TEST_PROVIDER_APP_ID', '12345678901234567891');
    const out = sanitizeCapturedValue('{"id":98765432109876543210,"access_token":"x1"}', createRawCaptureSink());
    expect(out).toBe('{"id":98765432109876540000,"access_token":"REDACTED"}');
  });
});

// ---------------------------------------------------------------------------
// 3. An earlier duplicate of a credential key
// ---------------------------------------------------------------------------

describe('an earlier duplicate of a credential key is redacted (round 4, issue 3)', () => {
  it.each([
    ['{"access_token":"UNKNOWN_TOKEN_123","access_token":null}', '{"access_token":"REDACTED","access_token":null}'],
    ['{"client_secret":"UNKNOWN_SECRET_456","client_secret":""}', '{"client_secret":"REDACTED","client_secret":""}'],
    ['{"data":{"api_key":"UNKNOWN_KEY_000"},"data":{}}', '{"data":{"api_key":"REDACTED"},"data":{}}'],
    ['[{"password":"UNKNOWN_PW_111","password":null}]', '[{"password":"REDACTED","password":null}]'],
    ['{"session":{"id":"UNKNOWN_SID_222"},"session":null}', '{"session":"REDACTED","session":null}'],
    ['{"\\u0074oken":"UNKNOWN_TOKEN_333","token":false}', '{"\\u0074oken":"REDACTED","token":false}'],
    [
      '{\n  "access_token": "UNKNOWN_TOKEN_444",\n  "id": 12345678901234567890,\n  "access_token": null\n}',
      '{\n  "access_token": "REDACTED",\n  "id": 12345678901234567890,\n  "access_token": null\n}',
    ],
  ])('%s', (text, expected) => {
    expect(sanitizeCapturedValue(text, createRawCaptureSink())).toBe(expected);
  });

  it('end to end: a browser text body through retainBufferBody and drain', async () => {
    expect(await drainedTextBody(createRawCaptureSink(), '{"access_token":"UNKNOWN_TOKEN_123","access_token":null}')).toBe(
      '{"access_token":"REDACTED","access_token":null}',
    );
  });

  it('together with a caller value that covers the key', () => {
    const out = sanitizeCapturedValue(
      '{"access_token":"UNKNOWN_TOKEN_123","access_token":null}',
      sinkWithCaller('access_token'),
    ) as string;
    expect(out).not.toContain('UNKNOWN_TOKEN_123');
  });

  it('leaves JSON text alone when only ordinary keys are duplicated', () => {
    const text = '{"a":"token=abc","a":2,"note":"password: x","items":[{"k":1,"k":2}]}';
    expect(sanitizeCapturedValue(text, createRawCaptureSink())).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// 4. Caller values: bounded, linear, never throwing
// ---------------------------------------------------------------------------

describe('caller values are bounded, matched in linear time, and never throw (round 4, issue 4)', () => {
  it('a 38k caller value neither throws nor slows the sink', () => {
    const sink = sinkWithCaller(`${'a'.repeat(38_000)} z`);
    const html = `<html>${'<p>ordinary job listing</p>'.repeat(2_000)}</html>`;
    expect(() => sanitizeCapturedValue(html, sink)).not.toThrow();
    expect(sanitizeCapturedValue(html, sink)).toBe(html);
  });

  it('a 38k caller value neither throws in the API pass', () => {
    const scrubber = createRawCaptureScrubber({ env: {}, caller: [`${'a'.repeat(38_000)} z`] });
    const html = `<html>${'<p>ordinary job listing</p>'.repeat(2_000)}</html>`;
    const out = scrubRawEntry(entry({ body: html }), scrubber);
    expect(out.body).toBe(html);
  });

  it('a caller value longer than the cap is ignored, logged by its length only', () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const long = `FAKE_LONG_${'b'.repeat(RAW_CAPTURE_MAX_CALLER_SECRET_LENGTH)}`;
    const atCap = `FAKE_CAP_${'c'.repeat(RAW_CAPTURE_MAX_CALLER_SECRET_LENGTH - 9)}`;
    const sink = createRawCaptureSink();
    registerRawCaptureSecrets([long, atCap], sink);
    expect(sanitizeCapturedValue(`<p>${atCap}</p>`, sink)).toBe('<p>REDACTED</p>');
    expect(sanitizeCapturedValue(`<p>${long}</p>`, sink)).toBe(`<p>${long}</p>`);
    const messages = debug.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes(String(long.length)))).toBe(true);
    expect(messages.some((m) => m.includes('FAKE_LONG_'))).toBe(false);
  });

  it(`at most ${RAW_CAPTURE_MAX_CALLER_SECRETS} caller values are taken`, () => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const values = Array.from({ length: RAW_CAPTURE_MAX_CALLER_SECRETS + 6 }, (_, i) => `FAKE_CALLER_${String(i).padStart(3, '0')}`);
    const sink = createRawCaptureSink();
    registerRawCaptureSecrets(values, sink);
    expect(sanitizeCapturedValue(`<p>${values[0]}</p>`, sink)).toBe('<p>REDACTED</p>');
    expect(sanitizeCapturedValue(`<p>${values[values.length - 1]}</p>`, sink)).toBe(`<p>${values[values.length - 1]}</p>`);
  });

  it('a 4,096-character caller value made of near misses costs linear time', () => {
    // A mismatch in the middle defeats both a regular-expression alternation
    // and `indexOf` (each costs about value length × text length here).
    const value = `${'a'.repeat(2_000)}z${'a'.repeat(2_095)}`; // 4,096 chars: the cap
    const sink = sinkWithCaller(value);
    const text = 'a'.repeat(3_000_000);
    const started = Date.now();
    sanitizeCapturedValue(text, sink);
    captureUrl(`https://h/x?q=${'a'.repeat(200_000)}`, sink);
    // ~0.1 s here; quadratic behaviour took several seconds.
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(value).toHaveLength(RAW_CAPTURE_MAX_CALLER_SECRET_LENGTH);
  });

  it('a long caller value is still found when present, by the linear matcher', () => {
    const value = `FAKE_${'xy'.repeat(100)}_KEY`;
    const sink = sinkWithCaller(value);
    expect(sanitizeCapturedValue(`<p>${value} ${value}x${'xy'.repeat(50)}</p>`, sink)).toBe(
      `<p>REDACTED REDACTEDx${'xy'.repeat(50)}</p>`,
    );
    expect(captureUrl(`https://h/x?q=${encodeURIComponent(value)}`, sink)).toBe('https://h/x?q=REDACTED');
  });

  it('a scrubber whose caller tier cannot be built keeps the server tier and withholds bodies', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const caller: Iterable<string> = {
      [Symbol.iterator](): Iterator<string> {
        throw new Error('cannot iterate FAKE_CALLER_VALUE');
      },
    };
    const scrubber = createRawCaptureScrubber({ env: { EJ_TEST_PROVIDER_API_KEY: 'FAKE_SERVER_KEY_4242' }, caller });
    const out = scrubRawEntry(
      entry({ url: 'https://h/x?ref=FAKE_SERVER_KEY_4242', body: 'secret body', request_body: { a: 1 } }),
      scrubber,
    );
    expect(out).not.toHaveProperty('body');
    expect(out).not.toHaveProperty('request_body');
    expect(out.truncated).toBe(true);
    expect(out.url).toBe('https://h/x?ref=REDACTED');
    expect(out.status).toBe(200);
    expect(scrubRawUrl('https://h/x?ref=FAKE_SERVER_KEY_4242', scrubber)).toBe('https://h/x?ref=REDACTED');
  });

  it('an entry that cannot be scrubbed keeps its metadata only instead of throwing', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const broken = entry({ url: 'https://h/x?access_token=UNKNOWN_TOKEN_9' });
    Object.defineProperty(broken, 'body', {
      enumerable: true,
      get(): never {
        throw new Error('body read failed');
      },
    });
    const out = scrubRawEntry(broken, createRawCaptureScrubber({ env: {} }));
    expect(out).not.toHaveProperty('body');
    expect(out.truncated).toBe(true);
    expect(out.url).toBe('https://h/x?access_token=REDACTED');
  });

  it('withholdBodies keeps every entry to its metadata', () => {
    const out = scrubRawEntry(entry({ body: '{"a":1}' }), createRawCaptureScrubber({ env: {}, withholdBodies: true }));
    expect(out).not.toHaveProperty('body');
    expect(out.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTML value attributes (optional review notes)
// ---------------------------------------------------------------------------

describe('HTML value attributes of a credential input', () => {
  const U = 'UNKNOWNVAL_123456';

  it.each([
    ['the first of two duplicate value attributes', `<input name="client_secret" value="${U}" value="">`, '<input name="client_secret" value="REDACTED" value="">'],
    ['both of two duplicates', `<input name="client_secret" value="${U}" value="${U}2">`, '<input name="client_secret" value="REDACTED" value="REDACTED">'],
    ['an attribute right after a quoted value', `<input name="client_secret"value="${U}">`, '<input name="client_secret"value="REDACTED">'],
    ['type=password with no space before value', `<input type='password'value=${U}>`, "<input type='password'value=REDACTED>"],
  ])('redacts %s', (_label, text, expected) => {
    expect(sanitizeCapturedValue(text)).toBe(expected);
  });

  it.each([
    '<input name="q"value="nurse">',
    '<option title="value=1" value="2">',
  ])('leaves %s alone', (text) => {
    expect(sanitizeCapturedValue(text)).toBe(text);
  });
});
