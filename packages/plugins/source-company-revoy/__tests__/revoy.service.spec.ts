import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const indexHtml = readFileSync(join(__dirname, 'fixtures', 'join-the-team.html'), 'utf8');
const financeTxt = readFileSync(join(__dirname, 'fixtures', 'doc-finance.txt'), 'utf8');
const supplyTxt = readFileSync(join(__dirname, 'fixtures', 'doc-supplychain.txt'), 'utf8');

const FINANCE_DOC = '1WC76MafLD0dZtyIr6yDS9jnhpkFbTHoM';
const SUPPLY_DOC = '15bZxb5kd1M9Ptu9qIDa6YTbvx9EBLv6W';

const pages: Record<string, string> = {
  'https://www.revoy.com/join-the-team': indexHtml,
  [`https://docs.google.com/document/d/${FINANCE_DOC}/export?format=txt`]: financeTxt,
  [`https://docs.google.com/document/d/${SUPPLY_DOC}/export?format=txt`]: supplyTxt,
};

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { RevoyService } from '../src/revoy.service';
import {
  REVOY_ALLOWED_HOSTS,
  REVOY_DOC_ALLOWED_HOSTS,
  REVOY_DOC_DEPARTMENT_BLOCK_RE,
  REVOY_DOC_DEPARTMENT_RE,
  REVOY_DOC_LOCATION_BLOCK_RE,
  REVOY_DOC_LOCATION_RE,
  REVOY_DOC_TYPE_RE,
  REVOY_MAX_DOC_BYTES,
  REVOY_MAX_DOC_CHARS,
  REVOY_MAX_DOCS,
} from '../src/revoy.constants';

const exportUrl = (docId: string): string =>
  `https://docs.google.com/document/d/${docId}/export?format=txt`;

/** Wall-clock ms of one synchronous call. */
function elapsedMs(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

type DocParser = {
  parseDoc(text: string): {
    locationText: string | null;
    department: string | null;
    typeText: string | null;
    description: string;
  };
};

function respondWith(p: Record<string, string>): void {
  getMock.mockReset();
  getMock.mockImplementation((url: string) => {
    const data = p[url];
    if (data === undefined) return Promise.reject(new Error(`unexpected fetch: ${url}`));
    return Promise.resolve({ data });
  });
}

function live(): void {
  respondWith(pages);
}

describe('RevoyService', () => {
  let service: RevoyService;

  beforeEach(() => {
    getMock.mockReset();
    service = new RevoyService();
  });

  it('maps every docs link to a job keyed by doc id', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(2);
    expect(res.diagnostics).toBeUndefined();

    const fin = res.jobs.find((j) => j.title === 'Head of Finance');
    expect(fin).toBeDefined();
    expect(fin!.id).toBe(`revoy-${FINANCE_DOC}`);
    expect(fin!.atsId).toBe(FINANCE_DOC);
    expect(fin!.site).toBe(Site.REVOY);
    expect(fin!.atsType).toBe('revoy');
    expect(fin!.companyName).toBe('Revoy');
    expect(fin!.jobUrl).toBe(
      `https://docs.google.com/document/d/${FINANCE_DOC}/edit`,
    );
    expect(fin!.jobUrlDirect).toBe(fin!.jobUrl);
    expect(fin!.applyUrl).toBe(fin!.jobUrl);
  });

  it('fetches the index then one txt export per doc', async () => {
    live();
    await service.scrape(new ScraperInputDto({}));
    expect(getMock).toHaveBeenCalledTimes(3);
    const urls = getMock.mock.calls.map((c) => c[0]);
    expect(urls[0]).toBe('https://www.revoy.com/join-the-team');
    expect(urls).toContain(
      `https://docs.google.com/document/d/${FINANCE_DOC}/export?format=txt`,
    );
    expect(urls).toContain(
      `https://docs.google.com/document/d/${SUPPLY_DOC}/export?format=txt`,
    );
  });

  it('uses the doc Location when labeled, else the link location', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));

    const supply = res.jobs.find((j) => j.title === 'Lead Supply chain Engineer');
    expect(supply).toBeDefined();
    // doc says "Troutdale, OR (on-site)"; the link says "Portland, OR"
    expect(supply!.location?.city).toBe('Troutdale');
    expect(supply!.location?.state).toBe('OR');
    expect(supply!.workFromHomeType).toBe('On Site');

    const fin = res.jobs.find((j) => j.title === 'Head of Finance');
    expect(fin!.location?.city).toBe('Portland');
    expect(fin!.location?.state).toBe('OR');
  });

  it('extracts labeled doc headers into fields', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));
    const supply = res.jobs.find((j) => j.title === 'Lead Supply chain Engineer')!;
    expect(supply.department).toBe('Operations / Engineering');
    expect(supply.employmentType).toBe('Full-time');
    expect(supply.jobType).toBeDefined();
  });

  it('carries the full doc body as description', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({}));
    const fin = res.jobs.find((j) => j.title === 'Head of Finance')!;
    expect(fin.description).toContain('Why Revoy');
    expect(fin.description).toContain('REPORTS TO');
    expect(fin.description!.length).toBeGreaterThan(1000);
  });

  it('degrades to link-only fields when a doc fetch fails', async () => {
    respondWith({
      'https://www.revoy.com/join-the-team': indexHtml,
      // both doc exports missing → 404
    });
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(2);
    const fin = res.jobs.find((j) => j.title === 'Head of Finance')!;
    expect(fin.location?.city).toBe('Portland');
    expect(fin.location?.state).toBe('OR');
    expect(fin.description).toBeUndefined();
    expect(fin.applyUrl).toBe(`https://docs.google.com/document/d/${FINANCE_DOC}/edit`);
  });

  it('returns an empty diagnostic when no doc links exist', async () => {
    respondWith({ 'https://www.revoy.com/join-the-team': '<html><body>empty</body></html>' });
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns a classified diagnostic when the index fetch throws', async () => {
    getMock.mockRejectedValue(new Error('ECONNRESET'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toEqual([]);
    expect(res.diagnostics?.reason).toBeDefined();
  });

  it('honours searchTerm, location, and resultsWanted filters', async () => {
    live();
    const res = await service.scrape(new ScraperInputDto({ searchTerm: 'Finance' }));
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Head of Finance');

    live();
    const loc = await service.scrape(new ScraperInputDto({ location: 'troutdale' }));
    expect(loc.jobs).toHaveLength(1);
    expect(loc.jobs[0].title).toBe('Lead Supply chain Engineer');

    live();
    const limited = await service.scrape(
      new ScraperInputDto({ resultsWanted: 1, offset: 1 }),
    );
    expect(limited.jobs).toHaveLength(1);
    expect(limited.jobs[0].title).toBe('Lead Supply chain Engineer');
  });

  it('reads the caps-block headers of the CRLF txt export', () => {
    const doc = (service as unknown as DocParser).parseDoc(financeTxt);
    expect(doc.locationText).toBe('Portland, OR');
    expect(doc.department).toBe('Finance');
    expect(doc.typeText).toBeNull();
    const supply = (service as unknown as DocParser).parseDoc(supplyTxt);
    expect(supply.locationText).toBe('Troutdale, OR (on-site)');
    expect(supply.department).toBe('Operations / Engineering');
    expect(supply.typeText).toBe('Full-time');
  });

  it('reads tab-separated blocks and labels whose value sits on a later line', () => {
    const parser = service as unknown as DocParser;
    const blocks = parser.parseDoc('X\nLOCATION\tPortland, OR\tFUNCTION\tFinance \tSTAGE\n');
    expect(blocks.locationText).toBe('Portland, OR');
    expect(blocks.department).toBe('Finance');
    const labels = parser.parseDoc('Location:\r\n\r\n  Troutdale, OR (on-site)  \r\nType:Full-time\n');
    expect(labels.locationText).toBe('Troutdale, OR (on-site)');
    expect(labels.typeText).toBe('Full-time');
  });

  describe('URL pinning (Spec 1689)', () => {
    it('fetches an on-domain companyUrl, upgrading http to https', async () => {
      respondWith({ ...pages, 'https://revoy.com/join-the-team': indexHtml });
      const res = await service.scrape(
        new ScraperInputDto({ companyUrl: 'http://revoy.com/join-the-team' }),
      );
      expect(getMock.mock.calls[0][0]).toBe('https://revoy.com/join-the-team');
      expect(res.jobs).toHaveLength(2);
    });

    it.each([
      ['off-domain', 'https://evil.example/careers/'],
      ['lookalike', 'https://revoy.com.evil.example/careers/'],
      ['userinfo', 'https://revoy.com@evil.example/careers/'],
      ['userinfo on the allowed host', 'https://user:pass@www.revoy.com/careers/'],
      ['explicit port', 'https://www.revoy.com:8443/careers/'],
      ['metadata IP over http', 'http://169.254.169.254/latest/meta-data/'],
      ['internal IP', 'http://10.0.0.5:8080/careers/'],
      ['IPv6 ULA', 'http://[fd00::1]/careers/'],
      ['cluster DNS', 'http://argocd-server.argocd.svc.cluster.local/'],
      ['non-http scheme', 'file:///etc/passwd'],
    ])('ignores a %s companyUrl and fetches the default index', async (_label, companyUrl) => {
      live();
      const res = await service.scrape(new ScraperInputDto({ companyUrl }));
      const urls = getMock.mock.calls.map((c) => c[0] as string);
      expect(urls).toEqual([
        'https://www.revoy.com/join-the-team',
        exportUrl(FINANCE_DOC),
        exportUrl(SUPPLY_DOC),
      ]);
      expect(res.jobs).toHaveLength(2);
    });

    it('only follows docs.google.com doc links on the pinned index', async () => {
      const index = [
        'https://docs.google.com/document/d/AAA/edit',
        'http://docs.google.com/document/d/BBB/edit',
        'https://evil.example/document/d/CCC/edit',
        'https://docs.google.com.evil.example/document/d/DDD/edit',
        'https://drive.docs.google.com/document/d/EEE/edit',
        'javascript:alert(1)//docs.google.com/document/d/FFF/edit',
        '/document/d/GGG/edit',
      ]
        .map((href) => `<p><a href="${href}">Role</a> — Portland, OR</p>`)
        .join('');
      respondWith({
        'https://www.revoy.com/join-the-team': index,
        [exportUrl('AAA')]: 'Location: Portland, OR',
        [exportUrl('BBB')]: 'Location: Portland, OR',
      });
      const res = await service.scrape(new ScraperInputDto({}));
      expect(getMock.mock.calls.map((c) => c[0])).toEqual([
        'https://www.revoy.com/join-the-team',
        exportUrl('AAA'),
        exportUrl('BBB'),
      ]);
      expect(res.jobs.map((j) => j.jobUrl)).toEqual([
        'https://docs.google.com/document/d/AAA/edit',
        'https://docs.google.com/document/d/BBB/edit',
      ]);
    });

    it(`fetches at most ${REVOY_MAX_DOCS} docs`, async () => {
      const index = Array.from(
        { length: 300 },
        (_, i) => `<p><a href="https://docs.google.com/document/d/doc${i}/edit">Role ${i}</a></p>`,
      ).join('');
      getMock.mockReset();
      getMock.mockImplementation((url: string) =>
        Promise.resolve({ data: url.endsWith('/join-the-team') ? index : 'Type: Full-time' }),
      );
      const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
      expect(REVOY_MAX_DOCS).toBe(50);
      expect(getMock).toHaveBeenCalledTimes(1 + REVOY_MAX_DOCS);
      expect(res.jobs).toHaveLength(REVOY_MAX_DOCS);
    });

    it('caps the doc download size', async () => {
      live();
      await service.scrape(new ScraperInputDto({}));
      expect(getMock).toHaveBeenCalledWith(
        exportUrl(FINANCE_DOC),
        expect.objectContaining({ maxContentLength: REVOY_MAX_DOC_BYTES }),
      );
    });

    it('logs only the host of a refused companyUrl, never its credentials or query', () => {
      const debug = jest
        .spyOn((service as unknown as { logger: { debug: (m: string) => void } }).logger, 'debug')
        .mockImplementation(() => undefined);
      (service as unknown as { careersUrl(input: ScraperInputDto): string }).careersUrl(
        new ScraperInputDto({ companyUrl: 'https://user:s3cret@evil.example/x?token=t0k' }),
      );
      const logged = debug.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('evil.example');
      expect(logged).not.toMatch(/s3cret|t0k|user:/);
    });

    it('pins the index to revoy.com and the doc export to Google doc hosts', async () => {
      const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
        createHttpClient: jest.Mock;
      };
      createHttpClient.mockClear();
      live();
      await service.scrape(new ScraperInputDto({}));
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ allowedRedirectHosts: REVOY_ALLOWED_HOSTS }),
      );
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ allowedRedirectHosts: REVOY_DOC_ALLOWED_HOSTS }),
      );
      expect(REVOY_ALLOWED_HOSTS).toEqual(['revoy.com']);
    });

    it("lets the export's googleusercontent.com redirect through the doc pin, nothing else", () => {
      const { redirectPinGuard } = jest.requireActual('@ever-jobs/common') as {
        redirectPinGuard: (hosts: readonly string[]) => (opts: Record<string, unknown>) => void;
      };
      const guard = redirectPinGuard(REVOY_DOC_ALLOWED_HOSTS);
      expect(() =>
        guard({ href: 'https://doc-0s-1c-docs.googleusercontent.com/docs/securesc/abc/def?e=download' }),
      ).not.toThrow();
      expect(() => guard({ href: 'https://docs.google.com/document/d/x/export?format=txt' })).not.toThrow();
      expect(() => guard({ href: 'https://evil.example/doc.txt' })).toThrow();
      expect(() => guard({ href: 'https://googleusercontent.com.evil.example/x' })).toThrow();
      expect(() => guard({ href: 'http://169.254.169.254/latest/meta-data/' })).toThrow();
    });
  });

  describe('doc parsing stays linear (Spec 1689)', () => {
    const N = 100_000;
    const paddings: Array<[string, string]> = [
      ['blank LF lines', '\n'.repeat(N)],
      ['blank CRLF lines', '\r\n'.repeat(N / 2)],
      ['whitespace-only lines', ' \t \n'.repeat(N / 4)],
      ['a padded Location line', `Location: a${' '.repeat(N)}b`],
      ['a Location label without colon', `Location${' '.repeat(N)}b`],
      ['a padded LOCATION block', `LOCATION A${' '.repeat(N)}b\n`],
      ['a LOCATION block with a lowercase value', `LOCATION${' '.repeat(N)}b`],
      ['a LOCATION block over blank lines', `LOCATION${'\r\n'.repeat(N / 2)}b`],
      ['a padded FUNCTION block', `FUNCTION a${' '.repeat(N)}b\n`],
      ['many empty LOCATION blocks', 'LOCATION  \n'.repeat(N / 11)],
      ['a padded Type line', `Type:${' '.repeat(N)}`],
    ];
    const patterns: Array<[string, RegExp]> = [
      ['LOCATION_RE', REVOY_DOC_LOCATION_RE],
      ['LOCATION_BLOCK_RE', REVOY_DOC_LOCATION_BLOCK_RE],
      ['DEPARTMENT_RE', REVOY_DOC_DEPARTMENT_RE],
      ['DEPARTMENT_BLOCK_RE', REVOY_DOC_DEPARTMENT_BLOCK_RE],
      ['TYPE_RE', REVOY_DOC_TYPE_RE],
    ];

    it.each(paddings)('every header pattern finishes fast on 100 KB of %s', (_label, text) => {
      for (const [, re] of patterns) {
        expect(elapsedMs(() => re.exec(text))).toBeLessThan(1000);
      }
    });

    it('parses only the first REVOY_MAX_DOC_CHARS characters of a doc', () => {
      const parser = service as unknown as DocParser;
      const text = `${'\r\n'.repeat(REVOY_MAX_DOC_CHARS)}Location: Far Away\r\n`;
      const started = performance.now();
      const doc = parser.parseDoc(text);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(doc.locationText).toBeNull();
      expect(doc.description.length).toBeLessThanOrEqual(REVOY_MAX_DOC_CHARS);
    });

    it('scrapes past a hostile doc end-to-end', async () => {
      respondWith({
        ...pages,
        [exportUrl(FINANCE_DOC)]: `Location: a${' '.repeat(N)}b\n${'\r\n'.repeat(N)}`,
      });
      const started = performance.now();
      const res = await service.scrape(new ScraperInputDto({}));
      expect(performance.now() - started).toBeLessThan(2000);
      expect(res.jobs).toHaveLength(2);
    });
  });
});
