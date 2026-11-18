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
 * Fork-sync hardening, second review round (adversarial review of the raw
 * capture fixes for findings 0 and 5, plus two low notes):
 *
 * 1. Server secrets and caller-chosen registered values were scrubbed in one
 *    left-to-right pass, so a caller value overlapping a server secret's first
 *    character consumed it and left the rest in clear — an oracle that
 *    recovered ADZUNA_APP_ID one character at a time.
 * 2. Key-name redaction of text bodies missed form text with whitespace, XML
 *    elements and JS literals.
 * 3. A body over the size cap was cut before it was sanitized, so a secret or
 *    a `"token": "…"` value straddling the cut kept its first characters.
 */

const ENV_APP_ID = 'a1b2c3d4'; // an obviously fake 8-hex Adzuna-style app id
const SECRET = 'FAKE_SECRET_123456';

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

const baseEntry = {
  attempt: 0,
  method: 'GET',
  url: 'https://example.com/x',
  status: 200,
  elapsed_ms: 1,
  body_bytes: 0,
  truncated: false,
};

async function serialized(sink: RawCaptureSink): Promise<string> {
  await drainRawCapture(sink, 50);
  return JSON.stringify(sink.entries);
}

// ---------------------------------------------------------------------------
// 1. Scrub order: server-held secrets first, caller-chosen values second
// ---------------------------------------------------------------------------

describe('a caller-registered value cannot probe a server secret (review issue 1)', () => {
  /** The Adzuna final_url shape from the review, for a caller appKey of `app_id=<guess>`. */
  const adzunaUrl = (guess: string): string =>
    `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${ENV_APP_ID}` +
    `&app_key=${encodeURIComponent(`app_id=${guess}`)}&results_per_page=15&sort_by=date&what=x`;

  it('gives the same final_url for every guess of the env app id first character', () => {
    setEnv('EJ_TEST_OVERLAP_APP_ID', ENV_APP_ID);
    const outputs = new Set<string>();
    for (const guess of '0123456789abcdef') {
      const sink = createRawCaptureSink();
      registerRawCaptureSecrets(`app_id=${guess}`, sink);
      const out = captureUrl(adzunaUrl(guess), sink);
      expect(out).not.toContain(ENV_APP_ID.slice(1));
      outputs.add(out);
    }
    // One output for all 16 guesses: nothing tells a right guess from a wrong one.
    expect([...outputs]).toEqual([
      'https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=REDACTED&app_key=REDACTED&results_per_page=15&sort_by=date&what=x',
    ]);
  });

  it('scrubs a provider-issued token before an overlapping caller value', () => {
    const sink = createRawCaptureSink();
    registerServerRawCaptureSecrets('FAKE_ISSUED_TOKEN_42', sink);
    registerRawCaptureSecrets('Bearer F', sink);

    expect(sanitizeCapturedValue('authorized as Bearer FAKE_ISSUED_TOKEN_42', sink)).toBe('authorized as Bearer REDACTED');
  });

  it('redacts overlapping server secrets as one span instead of leaving the tail of the second', () => {
    setEnv('EJ_TEST_OVERLAP_KEY', 'abcd1234');
    const sink = createRawCaptureSink();
    registerServerRawCaptureSecrets('cd1234wxyz', sink);

    expect(sanitizeCapturedValue('id=abcd1234wxyz end', sink)).toBe('id=REDACTED end');
  });

  it('still scrubs caller-registered values (after the server pass)', () => {
    const sink = createRawCaptureSink();
    registerRawCaptureSecrets(['FAKE_CALLER_KEY_77', SECRET], sink);

    expect(captureUrl(`https://x.io/a/FAKE_CALLER_KEY_77?q=${SECRET}`, sink)).toBe('https://x.io/a/REDACTED?q=REDACTED');
  });

  it('withholds a string with an absurd number of occurrences instead of splicing each', () => {
    const sink = createRawCaptureSink();
    registerRawCaptureSecrets('FAKE_ABAB', sink);
    const huge = 'FAKE_ABAB '.repeat(70_000);

    expect(sanitizeCapturedValue(huge, sink)).toBe('REDACTED');
  });
});

// ---------------------------------------------------------------------------
// 2. Key-name redaction of text bodies
// ---------------------------------------------------------------------------

describe('key-name redaction of text bodies (review issue 2)', () => {
  it.each([
    ['form text with a trailing newline', 'access_token=AT_SECRET_1234&token_type=bearer\n'],
    ['form text with a leading space', ' access_token=AT_SECRET_1234&x=1'],
    ['form pairs inside HTML', '<a href="https://x.io/cb?state=1&amp;access_token=AT_SECRET_1234">go</a>'],
    ['an XML element', '<r><access_token>AT_SECRET_1234</access_token></r>'],
    ['a namespaced XML element', '<r><ns:client_secret>AT_SECRET_1234</ns:client_secret></r>'],
    ['an XML CDATA value', '<r><password><![CDATA[AT_SECRET_1234]]></password></r>'],
    ['an XML attribute', '<creds token="AT_SECRET_1234" kind="x"/>'],
    ['a JS literal with a bare key', "<script>var c={access_token:'AT_SECRET_1234'}</script>"],
    ['a JS assignment', '<script>window.apiKey = "AT_SECRET_1234";</script>'],
    ['single-quoted pairs', "{'refresh_token': 'AT_SECRET_1234'}"],
  ])('redacts %s', (_label, text) => {
    const clean = sanitizeCapturedValue(text) as string;
    expect(clean).not.toContain('AT_SECRET_1234');
    expect(clean).toContain('REDACTED');
  });

  it('keeps the structure around the redacted value', () => {
    expect(sanitizeCapturedValue('<r><access_token>AT_SECRET_1234</access_token><n>2</n></r>')).toBe(
      '<r><access_token>REDACTED</access_token><n>2</n></r>',
    );
    expect(sanitizeCapturedValue("<script>var c={access_token:'AT_SECRET_1234'}</script>")).toBe(
      "<script>var c={access_token:'REDACTED'}</script>",
    );
    expect(sanitizeCapturedValue('access_token=AT_SECRET_1234&token_type=bearer\n')).toBe(
      'access_token=REDACTED&token_type=REDACTED\n',
    );
  });

  it('leaves ordinary text alone', () => {
    const page =
      '<html><title>Senior Engineer</title><p class="author">Jane</p>' +
      '<a href="/jobs?page=2&amp;q=node">next</a><script>var c={author:\'Jane\',page:"2"}</script></html>';
    expect(sanitizeCapturedValue(page)).toBe(page);
    expect(sanitizeCapturedValue('page=2&q=node\n')).toBe('page=2&q=node\n');
  });

  it('keeps a form request body with surrounding whitespace, redacted', () => {
    expect(captureRequestBody('grant_type=client_credentials&client_id=x&client_secret=AT_SECRET_1234\n')).toBe(
      'grant_type=client_credentials&client_id=x&client_secret=REDACTED\n',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Bodies over the size cap are sanitized before they are cut
// ---------------------------------------------------------------------------

describe('a body cut by the size cap never keeps half a secret (review issue 3)', () => {
  const TOKEN = 'TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  it('redacts a registered secret straddling the cap (the review repro)', async () => {
    process.env.RAW_CAPTURE_MAX_BODY_BYTES = '64';
    const sink = createRawCaptureSink();
    registerRawCaptureSecrets(TOKEN, sink);
    const entry = pushRawEntry(sink, { ...baseEntry })!;
    retainBody(sink, entry, normalizeBody(`${'x'.repeat(50)} ${TOKEN} tail`, 'text/plain'));

    expect(entry.truncated).toBe(true);
    expect(entry.body).toBe(`${'x'.repeat(50)} REDACTED tail`);
    expect(await serialized(sink)).not.toContain('TOKEN_A');
  });

  it('redacts a credential pair straddling the cap even when no value is registered', () => {
    process.env.RAW_CAPTURE_MAX_BODY_BYTES = '40';
    const sink = createRawCaptureSink();
    const entry = pushRawEntry(sink, { ...baseEntry })!;
    retainBody(sink, entry, normalizeBody('{"jobs":[1,2,3],"access_token":"AT_SECRET_1234567890"}'));

    expect(entry.truncated).toBe(true);
    expect(entry.body).not.toContain('AT_SECRET');
    expect((entry.body as string).startsWith('{"jobs":[1,2,3],"access_token":"')).toBe(true);
  });

  it('redacts a value cut off by the end of truncated JSON text', () => {
    expect(sanitizeCapturedValue('{"a":1,"access_token":"AT_SECRET_12')).toBe('{"a":1,"access_token":"REDACTED"');
    expect(sanitizeCapturedValue('<r><access_token>AT_SECRET_12')).toBe('<r><access_token>REDACTED');
  });

  it('applies to browser buffers too', async () => {
    process.env.RAW_CAPTURE_MAX_BODY_BYTES = '64';
    const sink = createRawCaptureSink();
    registerRawCaptureSecrets(TOKEN, sink);
    const entry = pushRawEntry(sink, { ...baseEntry })!;
    retainBufferBody(sink, entry, Buffer.from(`${'x'.repeat(50)} ${TOKEN} tail`), 'text/html');

    expect(entry.body).toBe(`${'x'.repeat(50)} REDACTED tail`);
    expect(await serialized(sink)).not.toContain('TOKEN_A');
  });

  it('drops the tail when the sanitized window itself ends inside a secret', async () => {
    process.env.RAW_CAPTURE_MAX_BODY_BYTES = '64';
    const longSecret = `FAKE_LONG_SECRET_${'A'.repeat(20_000)}`;
    const sink = createRawCaptureSink();
    registerRawCaptureSecrets(longSecret, sink);
    const entry = pushRawEntry(sink, { ...baseEntry })!;
    retainBody(sink, entry, normalizeBody(`head ${longSecret} tail`, 'text/plain'));

    expect(entry.truncated).toBe(true);
    expect(await serialized(sink)).not.toContain('FAKE_LONG_SECRET');
  });

  it('drops the tail of a cut body again when a secret is registered after it was stored', async () => {
    process.env.RAW_CAPTURE_MAX_BODY_BYTES = '64';
    const late = 'LATE_SECRET_ABCDEFGHIJKLMNOP';
    const sink = createRawCaptureSink();
    const entry = pushRawEntry(sink, { ...baseEntry })!;
    retainBody(sink, entry, normalizeBody(`${'x'.repeat(50)} ${late} tail`, 'text/plain'));
    expect(entry.body).toContain('LATE_SECRET_A'); // cut at the cap, not yet known
    registerRawCaptureSecrets(late, sink);

    expect(await serialized(sink)).not.toContain('LATE_SECRET');
  });
});

// ---------------------------------------------------------------------------
// Hostile input stays linear
// ---------------------------------------------------------------------------

describe('the new rules stay linear on hostile input', () => {
  it('sanitizes adversarial text quickly', () => {
    const sink = createRawCaptureSink();
    registerRawCaptureSecrets(['aaaaaaaa', 'FAKE_ABCDEFGH'], sink);
    registerServerRawCaptureSecrets(['aaaaaaab', 'FAKE_ABCDEFGHI'], sink);
    const inputs = [
      'a'.repeat(2_000_000), // every position starts an occurrence of a registered value
      `${'FAKE_ABCDEFG'.repeat(150_000)}`, // near-miss prefixes
      '<'.repeat(1_000_000),
      '<a '.repeat(400_000),
      `<token>${'x'.repeat(2_000_000)}`,
      '<token>x'.repeat(250_000),
      `<p><![CDATA[${'x'.repeat(1_000_000)}`,
      "k:'".repeat(400_000),
      `token:"${'a'.repeat(1_000_000)}\n`.repeat(2),
      ' a'.repeat(1_000_000),
      `${`&${'k'.repeat(200)}`.repeat(10_000)}=x`,
      `${'['.repeat(500_000)}=x`,
      '?token=x'.repeat(200_000),
    ];
    const started = Date.now();
    for (const input of inputs) sanitizeCapturedValue(input, sink);
    // A few linear passes per input (well under 1 s on a laptop); the bound is
    // generous for old CI CPUs but far below quadratic behaviour.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
