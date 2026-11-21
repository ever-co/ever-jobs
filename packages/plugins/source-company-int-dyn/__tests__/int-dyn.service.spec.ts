import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const careersHtml = readFileSync(
  join(__dirname, 'fixtures', 'index.html'),
  'utf8',
);

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { IntDynService } from '../src/int-dyn.service';
import { INT_DYN_ALLOWED_HOSTS } from '../src/int-dyn.constants';

function respondWith(payload: unknown): void {
  getMock.mockResolvedValue({ data: payload });
}

describe('IntDynService', () => {
  let service: IntDynService;

  beforeEach(() => {
    getMock.mockReset();
    service = new IntDynService();
  });

  it('maps every card in the careers section', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(2);
    expect(res.diagnostics).toBeUndefined();
    const titles = res.jobs.map((j) => j.title).sort();
    expect(titles).toEqual(['Fermentation Specialist', 'Synthetic Biologist']);
    for (const job of res.jobs) {
      expect(job.site).toBe(Site.INT_DYN);
      expect(job.atsType).toBe('int-dyn');
      expect(job.companyName).toBe('Integrated Dynamics');
      expect(job.jobUrl).toBe('https://www.int-dyn.com/#Careers');
      expect(job.jobUrlDirect).toBe('https://www.int-dyn.com/#Careers');
      expect(job.applyUrl).toContain('mailto:hmarkarian@int-dyn.com');
    }
  });

  it('composes the description from tagline + bullets', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(new ScraperInputDto({}));
    const bio = res.jobs.find((j) => j.title === 'Synthetic Biologist');
    expect(bio!.description).toContain('Make microbes do what we want.');
    expect(bio!.description).toContain('- Work hands-on with non-model, hyperthermophilic microbes');
    expect(bio!.description).toContain('- Design de-novo thermostable enzymes and plasmids');
  });

  it('keys roles by title slug', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(new ScraperInputDto({}));
    const bio = res.jobs.find((j) => j.title === 'Synthetic Biologist');
    expect(bio!.id).toBe('int-dyn-synthetic-biologist');
    expect(bio!.atsId).toBe('synthetic-biologist');
  });

  it('fetches the page root when companyUrl carries the #Careers fragment', async () => {
    respondWith(careersHtml);
    await service.scrape(
      new ScraperInputDto({ companyUrl: 'https://www.int-dyn.com/#Careers' }),
    );
    expect(getMock).toHaveBeenCalledWith('https://www.int-dyn.com/');
  });

  it('leaves unpublished fields unset', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(new ScraperInputDto({}));
    for (const job of res.jobs) {
      expect(job.location).toBeFalsy();
      expect(job.department).toBeUndefined();
      expect(job.datePosted).toBeUndefined();
      expect(job.compensation).toBeUndefined();
    }
  });

  it('returns empty diagnostics when the careers section has no cards', async () => {
    respondWith('<html><body><div id="Careers"></div></body></html>');
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('maps a fetch failure to classified diagnostics', async () => {
    getMock.mockRejectedValue(new Error('socket hangup'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeDefined();
  });

  it('applies searchTerm / resultsWanted filters', async () => {
    respondWith(careersHtml);
    const res = await service.scrape(
      new ScraperInputDto({ searchTerm: 'fermentation', resultsWanted: 9999 }),
    );
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Fermentation Specialist');

    const paged = await service.scrape(
      new ScraperInputDto({ resultsWanted: 1, offset: 1 }),
    );
    expect(paged.jobs).toHaveLength(1);
  });

  describe('URL pinning (Spec 1689)', () => {
    it('fetches an on-domain http companyUrl over https, without the fragment', async () => {
      respondWith(careersHtml);
      await service.scrape(new ScraperInputDto({ companyUrl: 'http://int-dyn.com/#Careers' }));
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith('https://int-dyn.com/');
    });

    it('fetches the site root when no companyUrl is given', async () => {
      respondWith(careersHtml);
      await service.scrape(new ScraperInputDto({}));
      expect(getMock).toHaveBeenCalledWith('https://www.int-dyn.com');
    });

    it.each([
      ['off-domain', 'https://evil.example/careers/'],
      ['lookalike', 'https://int-dyn.com.evil.example/careers/'],
      ['userinfo', 'https://int-dyn.com@evil.example/careers/'],
      ['userinfo on the allowed host', 'https://user:pass@www.int-dyn.com/careers/'],
      ['explicit port', 'https://www.int-dyn.com:8443/careers/'],
      ['metadata IP over http', 'http://169.254.169.254/latest/meta-data/'],
      ['internal IP', 'http://10.0.0.5:8080/careers/'],
      ['IPv6 ULA', 'http://[fd00::1]/careers/'],
      ['cluster DNS', 'http://argocd-server.argocd.svc.cluster.local/'],
      ['non-http scheme', 'file:///etc/passwd'],
    ])('ignores a %s companyUrl and fetches the site root', async (_label, companyUrl) => {
      respondWith(careersHtml);
      const res = await service.scrape(new ScraperInputDto({ companyUrl }));
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith('https://www.int-dyn.com');
      expect(res.jobs).toHaveLength(2);
    });

    it('logs only the host of a refused companyUrl, never its credentials or query', () => {
      const debug = jest
        .spyOn((service as unknown as { logger: { debug: (m: string) => void } }).logger, 'debug')
        .mockImplementation(() => undefined);
      (service as unknown as { pageUrl(input: ScraperInputDto): string }).pageUrl(
        new ScraperInputDto({ companyUrl: 'https://user:s3cret@evil.example/x?token=t0k' }),
      );
      const logged = debug.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('evil.example');
      expect(logged).not.toMatch(/s3cret|t0k|user:/);
    });

    it('pins every redirect hop to the plugin allowlist', async () => {
      const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
        createHttpClient: jest.Mock;
      };
      createHttpClient.mockClear();
      respondWith(careersHtml);
      await service.scrape(new ScraperInputDto({}));
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ allowedRedirectHosts: INT_DYN_ALLOWED_HOSTS }),
      );
      expect(INT_DYN_ALLOWED_HOSTS).toEqual(['int-dyn.com']);
    });
  });
});
