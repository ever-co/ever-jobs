import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const careersHtml = readFileSync(join(__dirname, 'fixtures', 'careers.html'), 'utf8');
const bundleJs = readFileSync(join(__dirname, 'fixtures', 'index.js'), 'utf8');

const getMock = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: getMock })),
  };
});

import { ThoronUsService } from '../src/thoron-us.service';
import { THORON_US_ALLOWED_HOSTS } from '../src/thoron-us.constants';

/** Wall-clock ms of one synchronous call. */
function elapsedMs(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

function respond(): void {
  getMock
    .mockResolvedValueOnce({ data: careersHtml })
    .mockResolvedValueOnce({ data: bundleJs });
}

describe('ThoronUsService', () => {
  let service: ThoronUsService;

  beforeEach(() => {
    getMock.mockReset();
    service = new ThoronUsService();
  });

  it('maps every entry in the embedded jobs array', async () => {
    respond();
    const res = await service.scrape(new ScraperInputDto({ resultsWanted: 9999 }));
    expect(res.jobs).toHaveLength(3);
    expect(res.diagnostics).toBeUndefined();
    const titles = res.jobs.map((j) => j.title).sort();
    expect(titles).toEqual([
      'Full-Stack Hardware Engineer',
      'PCB Designer',
      'Senior Mechanical Engineer - Electronics Packaging',
    ]);
    for (const job of res.jobs) {
      expect(job.site).toBe(Site.THORON_US);
      expect(job.atsType).toBe('thoron_us');
      expect(job.companyName).toBe('Thoron');
      expect(job.department).toBe('Engineering');
      expect(job.location?.city).toBe('Seattle');
      expect(job.location?.state).toBe('WA');
      expect(job.jobUrl).toBe('https://www.thoron.us/careers');
      expect(job.jobUrlDirect).toBe('https://www.thoron.us/careers');
      expect(job.applyUrl).toBe('https://www.thoron.us/careers');
    }
  });

  it('keys roles by their native numeric id', async () => {
    respond();
    const res = await service.scrape(new ScraperInputDto({}));
    const pcb = res.jobs.find((j) => j.title === 'PCB Designer');
    expect(pcb!.id).toBe('thoron_us-1');
    expect(pcb!.atsId).toBe('1');
  });

  it('maps type and composes descriptions from the three sections', async () => {
    respond();
    const res = await service.scrape(new ScraperInputDto({}));
    const pcb = res.jobs.find((j) => j.title === 'PCB Designer');
    expect(pcb!.employmentType).toBe('Full or Part Time');
    expect(pcb!.description).toContain('Perform detailed layout for PCBs');
    expect(pcb!.description).toContain('What you bring:');
    expect(pcb!.description).toContain('- You thrive in fast paced environments');
    expect(pcb!.description).toContain('Nice to have:');
    const mech = res.jobs.find((j) => j.title === 'Senior Mechanical Engineer - Electronics Packaging');
    expect(mech!.employmentType).toBe('Full Time');
  });

  it('fetches the shell then the referenced bundle', async () => {
    respond();
    await service.scrape(new ScraperInputDto({}));
    expect(getMock).toHaveBeenNthCalledWith(1, 'https://www.thoron.us/careers');
    expect(getMock).toHaveBeenNthCalledWith(
      2,
      'https://www.thoron.us/assets/index-CQn35CTl.js',
    );
  });

  it('ignores bundle arrays that lack the job-entry field run', async () => {
    const fake = `const x=[{id:1,title:"Not a job",name:"distractor"}];`;
    getMock
      .mockResolvedValueOnce({ data: careersHtml })
      .mockResolvedValueOnce({ data: fake });
    const res = await service.scrape(new ScraperInputDto({}));
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
  });

  it('returns empty diagnostics when the shell has no bundle link', async () => {
    getMock.mockResolvedValueOnce({ data: '<html><body></body></html>' });
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

  it('applies searchTerm / location / resultsWanted filters', async () => {
    respond();
    const res = await service.scrape(
      new ScraperInputDto({ searchTerm: 'full-stack', resultsWanted: 9999 }),
    );
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Full-Stack Hardware Engineer');

    respond();
    const located = await service.scrape(
      new ScraperInputDto({ location: 'seattle', resultsWanted: 9999 }),
    );
    expect(located.jobs).toHaveLength(3);

    respond();
    const paged = await service.scrape(
      new ScraperInputDto({ resultsWanted: 1, offset: 1 }),
    );
    expect(paged.jobs).toHaveLength(1);
  });

  describe('URL pinning (Spec 1689)', () => {
    it('fetches an on-domain companyUrl, upgrading http to https', async () => {
      respond();
      const res = await service.scrape(
        new ScraperInputDto({ companyUrl: 'http://thoron.us/careers' }),
      );
      expect(getMock).toHaveBeenNthCalledWith(1, 'https://thoron.us/careers');
      expect(getMock).toHaveBeenNthCalledWith(2, 'https://www.thoron.us/assets/index-CQn35CTl.js');
      expect(res.jobs).toHaveLength(3);
    });

    it.each([
      ['off-domain', 'https://evil.example/careers/'],
      ['lookalike', 'https://thoron.us.evil.example/careers/'],
      ['userinfo', 'https://thoron.us@evil.example/careers/'],
      ['userinfo on the allowed host', 'https://user:pass@www.thoron.us/careers/'],
      ['explicit port', 'https://www.thoron.us:8443/careers/'],
      ['metadata IP over http', 'http://169.254.169.254/latest/meta-data/'],
      ['internal IP', 'http://10.0.0.5:8080/careers/'],
      ['IPv6 ULA', 'http://[fd00::1]/careers/'],
      ['cluster DNS', 'http://argocd-server.argocd.svc.cluster.local/'],
      ['non-http scheme', 'file:///etc/passwd'],
    ])('ignores a %s companyUrl and fetches the default shell', async (_label, companyUrl) => {
      respond();
      const res = await service.scrape(new ScraperInputDto({ companyUrl }));
      expect(getMock).toHaveBeenCalledTimes(2);
      expect(getMock).toHaveBeenNthCalledWith(1, 'https://www.thoron.us/careers');
      expect(getMock).toHaveBeenNthCalledWith(2, 'https://www.thoron.us/assets/index-CQn35CTl.js');
      expect(res.jobs).toHaveLength(3);
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

    it('pins every redirect hop to the plugin allowlist', async () => {
      const { createHttpClient } = jest.requireMock('@ever-jobs/common') as {
        createHttpClient: jest.Mock;
      };
      createHttpClient.mockClear();
      respond();
      await service.scrape(new ScraperInputDto({}));
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ allowedRedirectHosts: THORON_US_ALLOWED_HOSTS }),
      );
      expect(THORON_US_ALLOWED_HOSTS).toEqual(['thoron.us']);
    });
  });

  describe('ReDoS hardening (Spec 1689)', () => {
    type Parser = { scalarField(objText: string, key: string): string | null };
    const backslashes = '\\'.repeat(60);

    it('scalarField stays linear on 60 backslashes with no closing quote', () => {
      const parser = service as unknown as Parser;
      const text = `{id:2,title:"x",whatYoullDo:['department:"${backslashes}a']}`;
      let value: string | null = 'unset';
      expect(elapsedMs(() => (value = parser.scalarField(text, 'department')))).toBeLessThan(1000);
      expect(value).toBeNull();
    });

    it('scalarField still unescapes quotes and backslashes', () => {
      const parser = service as unknown as Parser;
      expect(parser.scalarField(`{title:"a \\"b\\" c\\\\",x:1}`, 'title')).toBe('a "b" c\\');
      expect(parser.scalarField(`{title:'it\\'s "fine"'}`, 'title')).toBe(`it's "fine"`);
      expect(parser.scalarField(`{title:"broken\nline"}`, 'title')).toBeNull();
    });

    it('scrapes past a pathological entry end-to-end', async () => {
      const bundle =
        `const J=[{id:1,title:"Real Role",department:"Engineering",location:"Seattle, WA",type:"Full Time"},` +
        `{id:2,title:"No Department",whatYoullDo:['department:"${backslashes}a']}];`;
      getMock
        .mockResolvedValueOnce({ data: careersHtml })
        .mockResolvedValueOnce({ data: bundle });
      const started = performance.now();
      const res = await service.scrape(new ScraperInputDto({}));
      expect(performance.now() - started).toBeLessThan(2000);
      expect(res.jobs.map((j) => j.title)).toEqual(['Real Role', 'No Department']);
      expect(res.jobs[1].department).toBeUndefined();
    });
  });
});
