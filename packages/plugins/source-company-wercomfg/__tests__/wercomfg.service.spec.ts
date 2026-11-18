import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const indexHtml = readFileSync(join(__dirname, 'fixtures', 'careers.html'), 'utf8');
const tubeLaserHtml = readFileSync(
  join(__dirname, 'fixtures', 'detail-tube-laser-operator.html'),
  'utf8',
);
const pressBrakeHtml = readFileSync(
  join(__dirname, 'fixtures', 'detail-cnc-press-brake-operator.html'),
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

import { WercoMfgService } from '../src/wercomfg.service';
import { WERCOMFG_ALLOWED_HOSTS, WERCOMFG_MAX_DETAIL_LINKS } from '../src/wercomfg.constants';

/** Route the index + detail fetches to their fixtures by URL. */
function respondWithSite(detailHtmlBySlug: Record<string, string>): void {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/careers/')) {
      const slug = url.split('/careers/')[1]?.replace(/\/+$/, '');
      const html = detailHtmlBySlug[slug];
      if (!html) return Promise.reject(new Error(`unstubbed detail ${url}`));
      return Promise.resolve({ data: html });
    }
    return Promise.resolve({ data: indexHtml });
  });
}

const ALL_DETAILS = {
  'tube-laser-operator': tubeLaserHtml,
  'cnc-press-brake-operator': pressBrakeHtml,
  'fitter-welder': tubeLaserHtml,
  'general-shop-assistant': tubeLaserHtml,
  'general-shop-assistant-2nd': tubeLaserHtml,
  'laser-operator-1st': tubeLaserHtml,
  'laser-operator-2nd': tubeLaserHtml,
  'plate-roll-operator': tubeLaserHtml,
  'production-scheduler': tubeLaserHtml,
  'sandblaster': tubeLaserHtml,
  'shipping-receiving': tubeLaserHtml,
};

describe('WercoMfgService', () => {
  let service: WercoMfgService;

  beforeEach(() => {
    getMock.mockReset();
    service = new WercoMfgService();
  });

  it('scrapes every detail link on the careers index', async () => {
    respondWithSite(ALL_DETAILS);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(11);
    expect(res.diagnostics).toBeUndefined();
    for (const job of res.jobs) {
      expect(job.site).toBe(Site.WERCOMFG);
      expect(job.atsType).toBe('wercomfg');
      expect(job.companyName).toBe('Werco Manufacturing');
      expect(job.applyUrl).toBe('mailto:info@wercomfg.com');
      expect(job.jobUrl).toContain('https://www.wercomfg.com/careers/');
    }
  });

  it('maps JSON-LD fields: title, datePosted, type, location', async () => {
    respondWithSite(ALL_DETAILS);
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    const job = res.jobs.find((j) => j.atsId === 'cnc-press-brake-operator');
    expect(job).toBeDefined();
    expect(job!.title).toBe('CNC Press Brake Operator');
    expect(job!.id).toBe('wercomfg-cnc-press-brake-operator');
    expect(String(job!.datePosted)).toContain('2026-03-15');
    expect(job!.employmentType).toBe('FULL_TIME');
    expect(job!.location?.city).toBe('Broken Arrow');
    expect(job!.location?.state).toBe('OK');
  });

  it('emits the JSON-LD description plus published extras', async () => {
    respondWithSite(ALL_DETAILS);
    const res = await service.scrape(new ScraperInputDto({}));
    const job = res.jobs.find((j) => j.atsId === 'tube-laser-operator');
    expect(job!.description).toContain('tube laser cutting equipment');
    expect(job!.description).toContain('Industry: Manufacturing');
    expect(job!.description).toContain('Shift: 1st Shift');
  });

  it('tolerates a detail fetch failure', async () => {
    const details = { ...ALL_DETAILS };
    delete (details as Record<string, string>)['sandblaster'];
    getMock.mockImplementation((url: string) => {
      if (url.includes('sandblaster')) return Promise.reject(new Error('socket hangup'));
      if (url.includes('/careers/')) {
        const slug = url.split('/careers/')[1]?.replace(/\/+$/, '');
        return Promise.resolve({ data: (details as Record<string, string>)[slug] });
      }
      return Promise.resolve({ data: indexHtml });
    });
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(10);
    expect(res.diagnostics).toBeUndefined();
  });

  it('returns empty diagnostics when the index has no detail links', async () => {
    getMock.mockResolvedValue({ data: '<html><body><p>nothing here</p></body></html>' });
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('maps an index fetch failure to classified diagnostics', async () => {
    getMock.mockRejectedValue(new Error('socket hangup'));
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeDefined();
  });

  it('applies searchTerm / offset / resultsWanted', async () => {
    respondWithSite(ALL_DETAILS);
    const res = await service.scrape(
      new ScraperInputDto({ searchTerm: 'press brake', resultsWanted: 9999 }),
    );
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].atsId).toBe('cnc-press-brake-operator');

    const paged = await service.scrape(
      new ScraperInputDto({ resultsWanted: 2, offset: 1 }),
    );
    expect(paged.jobs).toHaveLength(2);
  });

  it('honours a companyUrl override for the index fetch', async () => {
    respondWithSite(ALL_DETAILS);
    await service.scrape(
      new ScraperInputDto({ companyUrl: 'https://wercomfg.com/careers' }),
    );
    expect(getMock).toHaveBeenCalledWith('https://wercomfg.com/careers');
  });

  it('fetches detail pages one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    getMock.mockImplementation(async (url: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return { data: url.includes('/careers/') ? tubeLaserHtml : indexHtml };
    });
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(11);
    expect(getMock).toHaveBeenCalledTimes(12);
    expect(maxInFlight).toBe(1);
  });

  it('ignores a scraped non-http jobUrl / applyUrl', async () => {
    const hostile = tubeLaserHtml
      .replace(
        '"url":"https://www.wercomfg.com/careers/tube-laser-operator"',
        '"url":"javascript:alert(1)"',
      );
    expect(hostile).not.toBe(tubeLaserHtml);
    getMock.mockImplementation((url: string) =>
      Promise.resolve({ data: url.includes('/careers/') ? hostile : indexHtml }),
    );
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs.length).toBeGreaterThan(0);
    for (const job of res.jobs) {
      expect(job.jobUrl).toMatch(/^https:\/\/www\.wercomfg\.com\/careers\/[^/]+$/);
      expect(job.applyUrl).toBe('mailto:info@wercomfg.com');
    }
  });

  describe('URL pinning (Spec 1689)', () => {
    it.each([
      ['off-domain', 'https://evil.example/careers/'],
      ['lookalike', 'https://wercomfg.com.evil.example/careers/'],
      ['userinfo', 'https://wercomfg.com@evil.example/careers/'],
      ['userinfo on the allowed host', 'https://user:pass@www.wercomfg.com/careers/'],
      ['explicit port', 'https://www.wercomfg.com:8443/careers/'],
      ['metadata IP over http', 'http://169.254.169.254/latest/meta-data/'],
      ['internal IP', 'http://10.0.0.5:8080/careers/'],
      ['IPv6 ULA', 'http://[fd00::1]/careers/'],
      ['cluster DNS', 'http://argocd-server.argocd.svc.cluster.local/'],
      ['non-http scheme', 'file:///etc/passwd'],
    ])('ignores a %s companyUrl and fetches the default index', async (_label, companyUrl) => {
      respondWithSite(ALL_DETAILS);
      const res = await service.scrape(new ScraperInputDto({ companyUrl, resultsWanted: 9999 }));
      const urls = getMock.mock.calls.map((c) => c[0] as string);
      expect(urls[0]).toBe('https://www.wercomfg.com/careers');
      for (const url of urls) expect(url.startsWith('https://www.wercomfg.com/careers')).toBe(true);
      expect(res.jobs).toHaveLength(11);
    });

    it('fetches an on-domain companyUrl, upgrading http to https', async () => {
      respondWithSite(ALL_DETAILS);
      await service.scrape(new ScraperInputDto({ companyUrl: 'http://wercomfg.com/careers' }));
      const urls = getMock.mock.calls.map((c) => c[0] as string);
      expect(urls[0]).toBe('https://wercomfg.com/careers');
      expect(urls).toContain('https://wercomfg.com/careers/tube-laser-operator');
    });

    it('drops detail links that leave the Werco hosts', async () => {
      const index = [
        'http://10.0.0.5:9200/careers/internal',
        'https://attacker.example/careers/a',
        '//169.254.169.254/careers/metadata',
        'https://wercomfg.com.evil.example/careers/lookalike',
        'https://user:pw@www.wercomfg.com/careers/userinfo',
        'https://www.wercomfg.com:8443/careers/port',
        'http://www.wercomfg.com/careers/tube-laser-operator',
        '/careers/cnc-press-brake-operator#apply',
      ]
        .map((href) => `<a href="${href}">role</a>`)
        .join('');
      getMock.mockImplementation((url: string) => {
        if (url === 'https://www.wercomfg.com/careers') return Promise.resolve({ data: index });
        if (url.endsWith('/careers/tube-laser-operator')) return Promise.resolve({ data: tubeLaserHtml });
        if (url.endsWith('/careers/cnc-press-brake-operator')) {
          return Promise.resolve({ data: pressBrakeHtml });
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });
      const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
      expect(getMock.mock.calls.map((c) => c[0])).toEqual([
        'https://www.wercomfg.com/careers',
        'https://www.wercomfg.com/careers/tube-laser-operator',
        'https://www.wercomfg.com/careers/cnc-press-brake-operator',
      ]);
      expect(res.jobs.map((j) => j.atsId).sort()).toEqual([
        'cnc-press-brake-operator',
        'tube-laser-operator',
      ]);
    });

    it(`fetches at most ${WERCOMFG_MAX_DETAIL_LINKS} detail pages`, async () => {
      const index = Array.from({ length: 500 }, (_, i) => `<a href="/careers/role-${i}">r</a>`).join('');
      getMock.mockImplementation((url: string) =>
        Promise.resolve({ data: url === 'https://www.wercomfg.com/careers' ? index : tubeLaserHtml }),
      );
      await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
      expect(WERCOMFG_MAX_DETAIL_LINKS).toBe(50);
      expect(getMock).toHaveBeenCalledTimes(1 + WERCOMFG_MAX_DETAIL_LINKS);
      expect(getMock.mock.calls[WERCOMFG_MAX_DETAIL_LINKS][0]).toBe(
        `https://www.wercomfg.com/careers/role-${WERCOMFG_MAX_DETAIL_LINKS - 1}`,
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

    it('pins every redirect hop to the plugin allowlist', async () => {
      const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
        createHttpClient: jest.Mock;
      };
      createHttpClient.mockClear();
      respondWithSite(ALL_DETAILS);
      await service.scrape(new ScraperInputDto({}));
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ allowedRedirectHosts: WERCOMFG_ALLOWED_HOSTS }),
      );
      expect(WERCOMFG_ALLOWED_HOSTS).toEqual(['wercomfg.com']);
    });
  });
});
