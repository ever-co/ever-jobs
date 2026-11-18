import * as fs from 'fs';
import * as path from 'path';
import { JobType, ScraperInputDto, Site } from '@ever-jobs/models';
import { BuildnebulaService } from '../src/buildnebula.service';
import { BuildnebulaListingsResponse } from '../src/buildnebula.types';
import { BUILDNEBULA_ALLOWED_HOSTS } from '../src/buildnebula.constants';

const LISTINGS: BuildnebulaListingsResponse = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'listings.json'), 'utf-8'),
);

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return { ...actual, createHttpClient: jest.fn() };
});
const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
  createHttpClient: jest.Mock;
};

function mockClient(payload: unknown = LISTINGS, reject = false) {
  const getMock = jest.fn((url: string) => {
    if (reject) return Promise.reject(new Error('ECONNRESET'));
    if (url === 'https://buildnebula.com/api/careers/listings') {
      return Promise.resolve({ data: payload });
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
  createHttpClient.mockReturnValue({ get: getMock, setHeaders: jest.fn() });
  return getMock;
}

describe('BuildnebulaService', () => {
  const service = new BuildnebulaService();
  const input = new ScraperInputDto({
    siteType: [Site.BUILDNEBULA],
    resultsWanted: 100, // default cap is 15 — the board carries 16
  });

  beforeEach(() => jest.clearAllMocks());

  it('fetches the listings endpoint and maps all 16 roles', async () => {
    const getMock = mockClient();
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(16);
    expect(getMock).toHaveBeenCalledWith(
      'https://buildnebula.com/api/careers/listings',
    );
    expect(res.diagnostics).toBeUndefined();
  });

  it('maps title, id, site, and url fields from the slug', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.title === 'Data Platform Engineer');
    expect(job).toBeDefined();
    expect(job!.id).toBe('buildnebula-data-platform-engineer');
    expect(job!.atsId).toBe('data-platform-engineer');
    expect(job!.site).toBe(Site.BUILDNEBULA);
    expect(job!.atsType).toBe('buildnebula');
    expect(job!.companyName).toBe('Nebula');
    expect(job!.jobUrl).toBe(
      'https://buildnebula.com/careers/data-platform-engineer',
    );
    expect(job!.applyUrl).toBe(job!.jobUrl);
  });

  it('maps department, team label, location, and employment type', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.title === 'Data Platform Engineer');
    expect(job!.department).toBe('Engineering & Information Technology');
    expect(job!.team).toBe('Cybernetics');
    expect(job!.location?.city).toBe('El Segundo');
    expect(job!.location?.state).toBe('California');
    expect(job!.employmentType).toBe('full_time');
    expect(job!.jobType).toContain(JobType.FULL_TIME);
    expect(job!.isRemote).toBeFalsy();
    expect(job!.datePosted).toBe('2026-09-26T19:37:32.848000+00:00');
  });

  it('maps every team token to its display label', async () => {
    mockClient();
    const res = await service.scrape(input);
    const teams = new Map(res.jobs.map((j) => [j.title, j.team]));
    expect(teams.get('Applications Physicist, Materials')).toBe('Materials');
    expect(teams.get('Operations Coordinator')).toBe('Business & Operations');
    expect(teams.get('Electronics Engineer')).toBe('Production');
  });

  it('maps structured compensation', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.title === 'Data Platform Engineer');
    expect(job!.compensation?.minAmount).toBe(100000);
    expect(job!.compensation?.maxAmount).toBe(250000);
    expect(job!.compensation?.currency).toBe('USD');
    expect(job!.compensation?.interval).toBe('yearly');
  });

  it('flattens description sections with the site headings and comp line', async () => {
    mockClient();
    const res = await service.scrape(input);
    const job = res.jobs.find((j) => j.title === 'Data Platform Engineer');
    const d = job!.description!;
    expect(d).toContain('What to Expect');
    expect(d).toContain('Cyberdeck');
    expect(d).toContain("What You'll Do");
    expect(d).toContain("What You'll Bring");
    expect(d).toContain('Benefits');
    expect(d).toContain('$100k to $250k base salary, plus equity');
    expect(d).toContain('Equity may be offered');
  });

  it('drops non-published, takedown, and non-public rows', async () => {
    const payload = {
      items: [
        { ...LISTINGS.items![0], status: 'draft' },
        { ...LISTINGS.items![1], takedown: true },
        { ...LISTINGS.items![2], visibility: 'internal' },
        LISTINGS.items![3],
      ],
    };
    mockClient(payload);
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].atsId).toBe(LISTINGS.items![3].slug);
  });

  it('filters by searchTerm and location', async () => {
    mockClient();
    const res = await service.scrape(
      new ScraperInputDto({
        siteType: [Site.BUILDNEBULA],
        searchTerm: 'operations coordinator',
        location: 'El Segundo',
      }),
    );
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Operations Coordinator');
  });

  it('returns empty diagnostics when items is empty or missing', async () => {
    mockClient({ items: [] });
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');

    mockClient({});
    const res2 = await service.scrape(input);
    expect(res2.jobs).toHaveLength(0);
    expect(res2.diagnostics?.reason).toBe('empty');
  });

  it('returns classified diagnostics on transport failure', async () => {
    mockClient(LISTINGS, true);
    const res = await service.scrape(input);
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeDefined();
  });

  describe('URL pinning (Spec 1689)', () => {
    it('reads the origin of an on-domain companyUrl, upgrading http to https', async () => {
      const getMock = jest.fn(() => Promise.resolve({ data: LISTINGS }));
      createHttpClient.mockReturnValue({ get: getMock, setHeaders: jest.fn() });
      const res = await service.scrape(
        new ScraperInputDto({
          siteType: [Site.BUILDNEBULA],
          resultsWanted: 100,
          companyUrl: 'http://www.buildnebula.com/careers?ref=x#top',
        }),
      );
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith('https://www.buildnebula.com/api/careers/listings');
      expect(res.jobs[0].jobUrl.startsWith('https://www.buildnebula.com/careers/')).toBe(true);
    });

    it.each([
      ['off-domain', 'https://evil.example/careers/'],
      ['lookalike', 'https://buildnebula.com.evil.example/careers/'],
      ['userinfo', 'https://buildnebula.com@evil.example/careers/'],
      ['userinfo on the allowed host', 'https://user:pass@www.buildnebula.com/careers/'],
      ['explicit port', 'https://www.buildnebula.com:8443/careers/'],
      ['metadata IP over http', 'http://169.254.169.254/latest/meta-data/'],
      ['internal IP', 'http://10.0.0.5:8080/careers/'],
      ['IPv6 ULA', 'http://[fd00::1]/careers/'],
      ['cluster DNS', 'http://argocd-server.argocd.svc.cluster.local/'],
      ['non-http scheme', 'file:///etc/passwd'],
    ])('ignores a %s companyUrl and fetches the default origin', async (_label, companyUrl) => {
      const getMock = mockClient();
      const res = await service.scrape(
        new ScraperInputDto({ siteType: [Site.BUILDNEBULA], resultsWanted: 100, companyUrl }),
      );
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith('https://buildnebula.com/api/careers/listings');
      expect(res.jobs).toHaveLength(16);
      for (const job of res.jobs) {
        expect(job.companyUrl).toBe('https://buildnebula.com');
        expect(job.jobUrl.startsWith('https://buildnebula.com/careers/')).toBe(true);
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
        expect.objectContaining({ allowedRedirectHosts: BUILDNEBULA_ALLOWED_HOSTS }),
      );
      expect(BUILDNEBULA_ALLOWED_HOSTS).toEqual(['buildnebula.com']);
    });
  });
});
