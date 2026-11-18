import * as fs from 'fs';
import * as path from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { MinervaHumanoidsService } from '../src/minervahumanoids.service';
import { MINERVAHUMANOIDS_ALLOWED_HOSTS } from '../src/minervahumanoids.constants';

const PUBLISHED_JS = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'published.js'),
  'utf-8',
);

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return { ...actual, createHttpClient: jest.fn() };
});
const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
  createHttpClient: jest.Mock;
};

function mutatedPayload(mutate: (jobs: Record<string, unknown>[]) => void): string {
  const start = PUBLISHED_JS.indexOf('{');
  const end = PUBLISHED_JS.lastIndexOf('}');
  const payload = JSON.parse(PUBLISHED_JS.slice(start, end + 1)) as {
    content: { jobs: Record<string, unknown>[] };
  };
  mutate(payload.content.jobs);
  return `window.__minervaContent=${JSON.stringify(payload)}`;
}

function mockClient(body: unknown = PUBLISHED_JS, reject = false) {
  const getMock = jest.fn((url: string) => {
    if (reject) return Promise.reject(new Error('ECONNRESET'));
    if (url === 'https://www.minervahumanoids.com/content/published.js') {
      return Promise.resolve({ data: body });
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
  createHttpClient.mockReturnValue({ get: getMock, setHeaders: jest.fn() });
  return getMock;
}

describe('MinervaHumanoidsService', () => {
  const service = new MinervaHumanoidsService();
  const input = new ScraperInputDto({
    siteType: [Site.MINERVAHUMANOIDS],
    resultsWanted: 100,
  });

  beforeEach(() => jest.clearAllMocks());

  it('fetches the published content file and maps all 11 roles', async () => {
    const getMock = mockClient();
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(11);
    expect(getMock).toHaveBeenCalledWith(
      'https://www.minervahumanoids.com/content/published.js',
    );
    expect(res.diagnostics).toBeUndefined();
  });

  it('maps title, id, site, and per-role anchor urls', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.atsId === 'job-1');
    expect(job).toBeDefined();
    expect(job!.id).toBe('minervahumanoids-job-1');
    expect(job!.site).toBe(Site.MINERVAHUMANOIDS);
    expect(job!.atsType).toBe('minervahumanoids');
    expect(job!.companyName).toBe('Minerva Humanoids');
    expect(job!.jobUrl).toBe(
      'https://www.minervahumanoids.com/careers#job-description-job-1',
    );
    expect(job!.applyUrl).toBe('https://www.minervahumanoids.com/careers#apply');
  });

  it('uses the talent apply anchor for program=talent roles', async () => {
    mockClient();
    const res = await service.scrape(input);
    const talent = res.jobs.filter((j) =>
      j.applyUrl?.endsWith('#talent-apply'),
    );
    // 3 intern roles + the open-application bucket
    expect(talent).toHaveLength(4);
    const regular = res.jobs.filter((j) => j.applyUrl?.endsWith('#apply'));
    expect(regular).toHaveLength(7);
  });

  it('parses free-text locations', async () => {
    mockClient();
    const res = await service.scrape(input);
    const sf = res.jobs.find((j) => j.atsId === 'job-1');
    expect(sf!.location?.city).toBe('San Francisco');
    const de = res.jobs.find((j) => j.atsId === 'job-5');
    expect(de!.location?.country).toBeTruthy();
    const openApp = res.jobs.find((j) => j.atsId === 'talent-open-application');
    expect(openApp).toBeDefined();
  });

  it('flattens description blocks with headings and list bullets', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.atsId === 'job-1');
    expect(job!.description).toBeTruthy();
    expect(job!.description).toContain('\n- ');
    expect(job!.description!.length).toBeGreaterThan(200);
  });

  it('uses a non-empty applyUrl verbatim', async () => {
    const mutated = mutatedPayload((jobs) => {
      jobs[0].applyUrl = 'https://boards.greenhouse.io/minerva/jobs/1';
    });
    mockClient(mutated);
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.atsId === 'job-1');
    expect(job!.applyUrl).toBe('https://boards.greenhouse.io/minerva/jobs/1');
    expect(job!.jobUrl).toBe('https://boards.greenhouse.io/minerva/jobs/1');
  });

  it('drops jobs with published=false', async () => {
    const mutated = mutatedPayload((jobs) => {
      jobs[0].published = false;
    });
    mockClient(mutated);
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(10);
    expect(res.jobs.some((j) => j.atsId === 'job-1')).toBe(false);
  });

  it('filters on searchTerm', async () => {
    mockClient();
    const res = await service.scrape(
      new ScraperInputDto({
        siteType: [Site.MINERVAHUMANOIDS],
        searchTerm: 'mechanical',
        resultsWanted: 100,
      }),
    );
    expect(res.jobs.length).toBeGreaterThan(0);
    expect(res.jobs.length).toBeLessThan(11);
    expect(
      res.jobs.every(
        (j) =>
          j.title!.toLowerCase().includes('mechanical') ||
          (j.description ?? '').toLowerCase().includes('mechanical'),
      ),
    ).toBe(true);
  });

  it('reports empty diagnostics when the payload has no jobs', async () => {
    mockClient('window.__minervaContent={"version":1,"content":{"jobs":[]}}');
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('reports empty diagnostics on unparseable content', async () => {
    mockClient('window.__minervaContent=not json');
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns error diagnostics when the fetch fails', async () => {
    mockClient(PUBLISHED_JS, true);
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBeTruthy();
    expect(res.diagnostics?.reason).not.toBe('empty');
  });

  it('ignores a non-http applyUrl and keeps the on-site anchors', async () => {
    const mutated = mutatedPayload((jobs) => {
      jobs[0].applyUrl = 'javascript:alert(document.cookie)';
    });
    mockClient(mutated);
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.atsId === 'job-1');
    expect(job!.jobUrl).toBe('https://www.minervahumanoids.com/careers#job-description-job-1');
    expect(job!.applyUrl).toBe('https://www.minervahumanoids.com/careers#apply');
  });

  describe('URL pinning (Spec 1689)', () => {
    it('reads the origin of an on-domain companyUrl, upgrading http to https', async () => {
      const getMock = jest.fn(() => Promise.resolve({ data: PUBLISHED_JS }));
      createHttpClient.mockReturnValue({ get: getMock, setHeaders: jest.fn() });
      const res = await service.scrape(
        new ScraperInputDto({
          siteType: [Site.MINERVAHUMANOIDS],
          resultsWanted: 100,
          companyUrl: 'http://minervahumanoids.com/careers#apply',
        }),
      );
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith('https://minervahumanoids.com/content/published.js');
      const job = res.jobs.find((j) => j.atsId === 'job-1');
      expect(job!.jobUrl).toBe('https://minervahumanoids.com/careers#job-description-job-1');
    });

    it.each([
      ['off-domain', 'https://evil.example/careers/'],
      ['lookalike', 'https://minervahumanoids.com.evil.example/careers/'],
      ['userinfo', 'https://minervahumanoids.com@evil.example/careers/'],
      ['userinfo on the allowed host', 'https://user:pass@www.minervahumanoids.com/careers/'],
      ['explicit port', 'https://www.minervahumanoids.com:8443/careers/'],
      ['metadata IP over http', 'http://169.254.169.254/latest/meta-data/'],
      ['internal IP', 'http://10.0.0.5:8080/careers/'],
      ['IPv6 ULA', 'http://[fd00::1]/careers/'],
      ['cluster DNS', 'http://argocd-server.argocd.svc.cluster.local/'],
      ['non-http scheme', 'file:///etc/passwd'],
    ])('ignores a %s companyUrl and fetches the default origin', async (_label, companyUrl) => {
      const getMock = mockClient();
      const res = await service.scrape(
        new ScraperInputDto({ siteType: [Site.MINERVAHUMANOIDS], resultsWanted: 100, companyUrl }),
      );
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith(
        'https://www.minervahumanoids.com/content/published.js',
      );
      expect(res.jobs).toHaveLength(11);
      for (const job of res.jobs) {
        expect(job.companyUrl).toBe('https://www.minervahumanoids.com');
      }
    });

    it('logs only the host of a refused companyUrl, never its credentials or query', () => {
      const debug = jest
        .spyOn((service as unknown as { logger: { debug: (m: string) => void } }).logger, 'debug')
        .mockImplementation(() => undefined);
      (service as unknown as { origin(companyUrl?: string): string }).origin(
        'https://user:s3cret@evil.example/x?token=t0k',
      );
      const logged = debug.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('evil.example');
      expect(logged).not.toMatch(/s3cret|t0k|user:/);
      debug.mockRestore();
    });

    it('pins every redirect hop to the plugin allowlist', async () => {
      mockClient();
      await service.scrape(input);
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ allowedRedirectHosts: MINERVAHUMANOIDS_ALLOWED_HOSTS }),
      );
      expect(MINERVAHUMANOIDS_ALLOWED_HOSTS).toEqual(['minervahumanoids.com']);
    });
  });
});
