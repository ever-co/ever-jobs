import 'reflect-metadata';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: jest.fn(),
    })),
  };
});

import { JibeService } from '../src/jibe.service';

const HOST = 'careers-acme.com';

interface JobOpts {
  id: string;
  title?: string;
  city?: string;
  state?: string;
  country?: string;
  category?: string | string[];
  applyUrl?: string;
  locationType?: string;
  org?: string;
  posted?: string;
}

function apiJob(o: JobOpts): { data: Record<string, unknown> } {
  return {
    data: {
      slug: o.id,
      req_id: o.id,
      title: o.title ?? `Engineer ${o.id}`,
      description: 'About Acme…',
      apply_url: o.applyUrl ?? `https://careers-acme.icims.com/jobs/${o.id}/login`,
      city: o.city ?? 'Santa Cruz',
      state: o.state ?? 'California',
      country: o.country ?? 'United States',
      full_location: `${o.city ?? 'Santa Cruz'}, ${o.state ?? 'California'}`,
      category: o.category,
      employment_type: 'FULL_TIME',
      posted_date: o.posted ?? '2026-09-22T13:25:00+0000',
      create_date: '2026-09-22T13:25:27+0000',
      hiring_organization: o.org ?? 'Acme',
      location_type: o.locationType ?? 'LAT_LNG',
    },
  };
}

function apiPage(jobs: Array<{ data: Record<string, unknown> }>, totalCount: number) {
  return { jobs, totalCount, count: totalCount };
}

function pageJobs(ids: string[]): Array<{ data: Record<string, unknown> }> {
  return ids.map((id) => apiJob({ id }));
}

describe('JibeService', () => {
  let service: JibeService;

  beforeEach(() => {
    service = new JibeService();
    mockGet.mockReset();
  });

  it('returns an empty result when neither slug nor URL resolves a host', async () => {
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('paginates /api/jobs until totalCount is covered', async () => {
    mockGet
      .mockResolvedValueOnce({ data: apiPage(pageJobs(Array.from({ length: 10 }, (_, i) => `${i + 1}`)), 15) })
      .mockResolvedValueOnce({ data: apiPage(pageJobs(['11', '12', '13', '14', '15']), 15) });

    const res = await service.scrape(new ScraperInputDto({ companySlug: HOST, resultsWanted: 30 }));

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls[0][0]).toBe(`https://${HOST}/api/jobs?page=1`);
    expect(mockGet.mock.calls[1][0]).toBe(`https://${HOST}/api/jobs?page=2`);
    expect(res.jobs).toHaveLength(15);
    expect(res.jobs[0].site).toBe(Site.JIBE);
    expect(res.jobs[0].atsType).toBe('jibe');
    expect(res.jobs[0].atsId).toBe('1');
  });

  it('stops on an empty page even before totalCount is covered', async () => {
    mockGet
      .mockResolvedValueOnce({ data: apiPage(pageJobs(Array.from({ length: 10 }, (_, i) => `${i + 1}`)), 50) })
      .mockResolvedValueOnce({ data: apiPage([], 50) });
    const res = await service.scrape(new ScraperInputDto({ companySlug: HOST, resultsWanted: 50 }));
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(res.jobs).toHaveLength(10);
  });

  it('honours resultsWanted', async () => {
    mockGet.mockResolvedValue({
      data: apiPage(pageJobs(Array.from({ length: 10 }, (_, i) => `${i + 1}`)), 100),
    });
    const res = await service.scrape(new ScraperInputDto({ companySlug: HOST, resultsWanted: 5 }));
    expect(res.jobs).toHaveLength(5);
  });

  it('derives the detail base from the companyUrl mount path', async () => {
    mockGet.mockResolvedValueOnce({ data: apiPage(pageJobs(['33835']), 1) });
    const res = await service.scrape(
      new ScraperInputDto({ companyUrl: 'https://careers.rivian.com/careers-home/jobs' }),
    );
    expect(res.jobs[0].jobUrl).toBe('https://careers.rivian.com/careers-home/jobs/33835');
    expect(res.jobs[0].jobUrlDirect).toBe('https://careers-acme.icims.com/jobs/33835/login');
    expect(res.jobs[0].applyUrl).toBe('https://careers-acme.icims.com/jobs/33835/login');
    expect(mockGet.mock.calls[0][0]).toBe('https://careers.rivian.com/api/jobs?page=1');
  });

  it('derives the detail base from a job-detail companyUrl', async () => {
    mockGet.mockResolvedValueOnce({ data: apiPage(pageJobs(['42']), 1) });
    const res = await service.scrape(
      new ScraperInputDto({ companyUrl: 'https://careers.rivian.com/careers-home/jobs/33835' }),
    );
    expect(res.jobs[0].jobUrl).toBe('https://careers.rivian.com/careers-home/jobs/42');
  });

  it('falls back to {origin}/jobs/{slug} for a bare host slug', async () => {
    mockGet.mockResolvedValueOnce({ data: apiPage(pageJobs(['7']), 1) });
    const res = await service.scrape(new ScraperInputDto({ companySlug: 'careers.rivian.com' }));
    expect(res.jobs[0].jobUrl).toBe('https://careers.rivian.com/jobs/7');
  });

  it('maps location, department, remote, and company name', async () => {
    mockGet.mockResolvedValueOnce({
      data: apiPage([
        apiJob({ id: '9', category: [' Engineering'], locationType: 'TELECOMMUTE', org: 'Rivian', city: '', state: '', country: '' }),
      ], 1),
    });
    const res = await service.scrape(new ScraperInputDto({ companySlug: HOST }));
    const job = res.jobs[0];
    expect(job.department).toBe('Engineering');
    expect(job.isRemote).toBe(true);
    expect(job.companyName).toBe('Rivian');
    expect(job.datePosted).toBe('2026-09-22T13:25:00+0000');
    expect(job.employmentType).toBe('FULL_TIME');
    expect(job.location).toBeNull();
  });

  it('derives a company name from the host when hiring_organization is absent', async () => {
    const noOrg = apiJob({ id: '3' });
    delete (noOrg.data as Record<string, unknown>).hiring_organization;
    mockGet.mockResolvedValueOnce({ data: apiPage([noOrg], 1) });
    const res = await service.scrape(new ScraperInputDto({ companySlug: 'careers.acme.com' }));
    expect(res.jobs[0].companyName).toBe('Acme');
  });

  it('dedupes repeated req_ids across pages', async () => {
    mockGet
      .mockResolvedValueOnce({ data: apiPage(pageJobs(Array.from({ length: 10 }, (_, i) => `${i + 1}`)), 20) })
      .mockResolvedValueOnce({ data: apiPage(pageJobs(['10', '11', '12', '13', '14', '15', '16', '17', '18', '19']), 20) });
    const res = await service.scrape(new ScraperInputDto({ companySlug: HOST, resultsWanted: 25 }));
    expect(res.jobs).toHaveLength(19);
  });

  it('returns empty when the endpoint serves a frame-buster/HTML page', async () => {
    mockGet.mockResolvedValueOnce({ data: '<html><script>window.top.location.href="/x"</script></html>' });
    const res = await service.scrape(new ScraperInputDto({ companySlug: HOST }));
    expect(res.jobs).toEqual([]);
  });

  it('returns empty on a 404 tenant', async () => {
    mockGet.mockRejectedValueOnce({ response: { status: 404 } });
    const res = await service.scrape(new ScraperInputDto({ companySlug: 'nope.example.com' }));
    expect(res.jobs).toEqual([]);
  });

  it('drops a non-http apply_url', async () => {
    mockGet.mockResolvedValueOnce({
      data: apiPage([apiJob({ id: '5', applyUrl: 'javascript:alert(document.cookie)' })], 1),
    });
    const res = await service.scrape(new ScraperInputDto({ companySlug: HOST }));
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].applyUrl).toBeNull();
    expect(res.jobs[0].jobUrlDirect).toBeNull();
    expect(res.jobs[0].jobUrl).toBe(`https://${HOST}/jobs/5`);
  });

  describe('tenant host guard (Spec 1689)', () => {
    it.each([
      ['private IP over http', 'http://10.0.0.5:8080'],
      ['metadata IP', 'https://169.254.169.254/latest/meta-data/'],
      ['public IP literal', 'https://8.8.8.8/careers/jobs'],
      ['hex IPv4 spelling', 'https://0x7f.1/'],
      ['IPv6 literal', 'http://[fd00::1]/'],
      ['loopback name', 'https://localhost.localdomain/'],
      ['internal suffix', 'metadata.internal'],
      ['cluster service', 'https://valkey.valkey.svc.cluster.local/'],
      ['kubernetes namespace TLD', 'kubernetes.default'],
      ['userinfo', 'https://user:pw@careers.acme.com/careers-home/jobs'],
      ['host smuggled through userinfo', 'https://careers.acme.com@10.0.0.5/'],
      ['explicit port', 'https://careers.acme.com:8443/'],
    ])('refuses a %s tenant without fetching', async (_label, companyUrl) => {
      const res = await service.scrape(new ScraperInputDto({ companyUrl }));
      expect(res.jobs).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('refuses the same hosts given as companySlug', async () => {
      for (const companySlug of ['10.0.0.5', '169.254.169.254', 'localhost', 'svc.cluster.local']) {
        await service.scrape(new ScraperInputDto({ companySlug }));
      }
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('upgrades an http tenant URL to https', async () => {
      mockGet.mockResolvedValueOnce({ data: apiPage(pageJobs(['1']), 1) });
      const res = await service.scrape(
        new ScraperInputDto({ companyUrl: 'http://careers.rivian.com/careers-home/jobs' }),
      );
      expect(mockGet.mock.calls[0][0]).toBe('https://careers.rivian.com/api/jobs?page=1');
      expect(res.jobs[0].jobUrl).toBe('https://careers.rivian.com/careers-home/jobs/1');
      expect(res.jobs[0].companyUrl).toBe('https://careers.rivian.com');
    });

    it('falls back to companySlug when companyUrl is refused', async () => {
      mockGet.mockResolvedValueOnce({ data: apiPage(pageJobs(['1']), 1) });
      await service.scrape(
        new ScraperInputDto({ companyUrl: 'http://10.0.0.5:8080', companySlug: HOST }),
      );
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockGet.mock.calls[0][0]).toBe(`https://${HOST}/api/jobs?page=1`);
    });

    it('pins every redirect hop to the tenant host', async () => {
      const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
        createHttpClient: jest.Mock;
      };
      createHttpClient.mockClear();
      mockGet.mockResolvedValueOnce({ data: apiPage(pageJobs(['1']), 1) });
      await service.scrape(new ScraperInputDto({ companySlug: 'Careers.Rivian.com' }));
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ allowedRedirectHosts: ['careers.rivian.com'] }),
      );
    });

    it('logs only the host of a refused tenant, never its credentials or query', async () => {
      const warn = jest
        .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      await service.scrape(
        new ScraperInputDto({ companyUrl: 'https://user:s3cret@10.0.0.5/x?token=t0k' }),
      );
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('10.0.0.5');
      expect(logged).not.toMatch(/s3cret|t0k|user:/);
    });
  });
});
