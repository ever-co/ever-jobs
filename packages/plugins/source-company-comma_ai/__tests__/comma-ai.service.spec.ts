import * as fs from 'fs';
import * as path from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { CommaAiService } from '../src/comma-ai.service';
import { COMMA_AI_ALLOWED_HOSTS } from '../src/comma-ai.constants';

/** Wall-clock ms of one synchronous call. */
function elapsedMs(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

const JOBS_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'jobs.html'), 'utf-8');
const CHUNK_JS = fs.readFileSync(path.join(__dirname, 'fixtures', 'node-chunk.js'), 'utf-8');
const CHUNK_PATH = '/_app/immutable/nodes/4.CaK98CBr.js';

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return { ...actual, createHttpClient: jest.fn() };
});
const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
  createHttpClient: jest.Mock;
};

function mockClient(html = JOBS_HTML, chunk: string | null = CHUNK_JS) {
  const getMock = jest.fn((url: string) => {
    if (url === 'https://comma.ai/jobs') return Promise.resolve({ data: html });
    // only the jobs node chunk carries the array; other node chunks are dead ends
    if (url === `https://comma.ai${CHUNK_PATH}`) {
      return chunk !== null ? Promise.resolve({ data: chunk }) : Promise.reject(new Error('404'));
    }
    if (url.endsWith('.js')) return Promise.resolve({ data: 'const x = 1;' });
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
  createHttpClient.mockReturnValue({ get: getMock, setHeaders: jest.fn() });
  return getMock;
}

describe('CommaAiService', () => {
  const service = new CommaAiService();
  const input = new ScraperInputDto({ siteType: [Site.COMMA_AI] });

  beforeEach(() => jest.clearAllMocks());

  it('discovers the node chunk from the page and parses 10 jobs', async () => {
    const getMock = mockClient();
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(10);
    const urls = getMock.mock.calls.map((c) => c[0]);
    expect(urls[0]).toBe('https://comma.ai/jobs');
    expect(urls).toContain(`https://comma.ai${CHUNK_PATH}`);
    expect(res.diagnostics).toBeUndefined();
  });

  it('maps title, slug, site, and company fields', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.title === 'Software Engineer');
    expect(job).toBeDefined();
    expect(job!.id).toBe('comma_ai-software-engineer');
    expect(job!.atsId).toBe('software-engineer');
    expect(job!.site).toBe(Site.COMMA_AI);
    expect(job!.atsType).toBe('comma_ai');
    expect(job!.companyName).toBe('comma');
    expect(job!.jobUrl).toBe('https://comma.ai/jobs#software-engineer');
    expect(job!.applyUrl).toBe('https://comma.ai/jobs#software-engineer');
  });

  it('derives kebab slugs from titles with slashes and capitals', async () => {
    mockClient();
    const res = await service.scrape(input);
    const byAts = res.jobs.map((j) => j.atsId);
    expect(byAts).toContain('video-content-creator');
    expect(byAts).toContain('internships-co-op');
    expect(byAts).toContain('cnc-machinist-head-of-prototyping');
  });

  it('maps team to department and omits it when absent', async () => {
    mockClient();
    const res = await service.scrape(input);
    const eng = res.jobs.find((j) => j.atsId === 'software-engineer');
    expect(eng!.department).toBe('openpilot');
    const intern = res.jobs.find((j) => j.atsId === 'internships-co-op');
    expect(intern).toBeDefined();
    expect(intern!.department).toBeUndefined();
  });

  it('parses the on-site San Diego location to city and state', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.atsId === 'software-engineer');
    expect(job!.location?.city).toBe('San Diego');
    expect(job!.location?.state).toBe('CA');
  });

  it('composes description from the bundle fields', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.atsId === 'software-engineer');
    expect(job!.description).toContain('openpilot team');
    expect(job!.description).toContain('Qualifications:');
    expect(job!.description).toContain('Fluent in Python');
  });

  it('returns empty diagnostics when no chunk carries the jobs array', async () => {
    mockClient(JOBS_HTML, 'const x = 1;');
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  describe('URL pinning (Spec 1689)', () => {
    it('fetches an on-domain companyUrl, upgrading http to https', async () => {
      const getMock = mockClient();
      const res = await service.scrape(
        new ScraperInputDto({ siteType: [Site.COMMA_AI], companyUrl: 'http://comma.ai/jobs' }),
      );
      expect(getMock.mock.calls[0][0]).toBe('https://comma.ai/jobs');
      expect(res.jobs).toHaveLength(10);
    });

    it.each([
      ['off-domain', 'https://evil.example/careers/'],
      ['lookalike', 'https://comma.ai.evil.example/careers/'],
      ['userinfo', 'https://comma.ai@evil.example/careers/'],
      ['userinfo on the allowed host', 'https://user:pass@www.comma.ai/careers/'],
      ['explicit port', 'https://www.comma.ai:8443/careers/'],
      ['metadata IP over http', 'http://169.254.169.254/latest/meta-data/'],
      ['internal IP', 'http://10.0.0.5:8080/careers/'],
      ['IPv6 ULA', 'http://[fd00::1]/careers/'],
      ['cluster DNS', 'http://argocd-server.argocd.svc.cluster.local/'],
      ['non-http scheme', 'file:///etc/passwd'],
    ])('ignores a %s companyUrl and fetches the default page', async (_label, companyUrl) => {
      const getMock = mockClient();
      const res = await service.scrape(
        new ScraperInputDto({ siteType: [Site.COMMA_AI], companyUrl }),
      );
      const urls = getMock.mock.calls.map((c) => c[0] as string);
      expect(urls[0]).toBe('https://comma.ai/jobs');
      for (const url of urls) expect(url.startsWith('https://comma.ai/')).toBe(true);
      expect(res.jobs).toHaveLength(10);
      for (const job of res.jobs) expect(job.jobUrl.startsWith('https://comma.ai/jobs#')).toBe(true);
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
      debug.mockRestore();
    });

    it('only fetches node chunks that are plain paths on comma.ai', async () => {
      const hostile =
        '<script>import("/_app/immutable/nodes/../../api/echo?q=.js");' +
        'import("/_app/immutable/nodes/%2e%2e/%2e%2e/x.js");' +
        'import("/_app/immutable/nodes/a\\..\\..\\x.js");' +
        'import("/_app/immutable/nodes/x.js#frag.js");' +
        'import("//evil.example/_app/immutable/nodes/1.js");' +
        'import("https://evil.example/_app/immutable/nodes/2.js")</script>';
      const getMock = mockClient(hostile + JOBS_HTML);
      const res = await service.scrape(input);
      const urls = getMock.mock.calls.map((c) => c[0] as string);
      expect(urls[0]).toBe('https://comma.ai/jobs');
      for (const url of urls.slice(1)) {
        expect(url).toMatch(/^https:\/\/comma\.ai\/_app\/immutable\/nodes\/[^/?#\\]+\.js$/);
        expect(url).not.toContain('..');
      }
      expect(urls).toContain(`https://comma.ai${CHUNK_PATH}`);
      expect(res.jobs).toHaveLength(10);
    });

    it('pins every redirect hop to the plugin allowlist', async () => {
      mockClient();
      await service.scrape(input);
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ allowedRedirectHosts: COMMA_AI_ALLOWED_HOSTS }),
      );
      expect(COMMA_AI_ALLOWED_HOSTS).toEqual(['comma.ai']);
    });
  });

  describe('ReDoS hardening (Spec 1689)', () => {
    type Parser = {
      scalarField(objText: string, key: string): string | null;
      templateField(objText: string, key: string): string | null;
    };
    const backslashes = '\\'.repeat(60);

    it('scalarField stays linear on 60 backslashes with no closing quote', () => {
      const parser = service as unknown as Parser;
      const text = `{title:"x",description:\`hello team:"${backslashes}a\nmore\`,qualifications:[]}`;
      let value: string | null = 'unset';
      expect(elapsedMs(() => (value = parser.scalarField(text, 'team')))).toBeLessThan(1000);
      expect(value).toBeNull();
    });

    it('templateField stays linear on 60 backslashes with no closing backtick', () => {
      const parser = service as unknown as Parser;
      const text = `{title:"x",howToApply:'description:\`${backslashes}a'}`;
      let value: string | null = 'unset';
      expect(elapsedMs(() => (value = parser.templateField(text, 'description')))).toBeLessThan(1000);
      expect(value).toBeNull();
    });

    it('scalarField and templateField still unescape quotes, backslashes and line breaks', () => {
      const parser = service as unknown as Parser;
      expect(parser.scalarField(`{team:"a \\"b\\" c\\\\",x:1}`, 'team')).toBe('a "b" c\\');
      expect(parser.scalarField(`{team:'it\\'s "fine"'}`, 'team')).toBe(`it's "fine"`);
      expect(parser.scalarField(`{team:"broken\nline"}`, 'team')).toBeNull();
      expect(parser.templateField('{description:`a\\`b\\\\ c\nd`}', 'description')).toBe('a`b\\ c\nd');
      expect(parser.templateField('{description:`x\\\ny`}', 'description')).toBe('x\ny');
    });

    it('scrapes past a pathological entry end-to-end', async () => {
      const chunk =
        `const J=[{title:"Hostile",team:"t",location:"l",` +
        `description:\`intro howToApply:"${backslashes}a\nmore\`,qualifications:["q"],howToApply:'ok'},` +
        `{title:"Real Role",description:\`d\`,qualifications:[]}];`;
      mockClient(JOBS_HTML, chunk);
      const started = performance.now();
      const res = await service.scrape(input);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(res.jobs.map((j) => j.title)).toEqual(['Hostile', 'Real Role']);
      expect(res.jobs[0].description).toContain('ok');
    });
  });
});
