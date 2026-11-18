import {
  extractLdJsonBlocks,
  parseJobPostingLd,
  jobPostingLdFromNode,
  jobPostingLdToCompensation,
} from '../src';
import { CompensationInterval } from '@ever-jobs/models';

/** Wrap an ld+json payload in a script block (optionally several). */
function page(...payloads: unknown[]): string {
  const scripts = payloads
    .map(
      (p) =>
        `<script type="application/ld+json">${JSON.stringify(p)}</script>`,
    )
    .join('\n');
  return `<!doctype html><html><head>${scripts}</head><body>x</body></html>`;
}

const baseJob = {
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Staff Engineer',
  description: '<p>Build things.</p>',
  datePosted: '2026-06-11T21:42:38-05:00',
  hiringOrganization: {
    '@type': 'Organization',
    name: 'Acme Corp',
    sameAs: 'https://acme.example',
  },
};

describe('extractLdJsonBlocks', () => {
  it('parses every ld+json block, skipping malformed ones', () => {
    const html = `
      <script type="application/ld+json">${JSON.stringify({ a: 1 })}</script>
      <script type="application/ld+json">{ not valid json }</script>
      <script type='application/ld+json'>${JSON.stringify({ b: 2 })}</script>`;
    const blocks = extractLdJsonBlocks(html);
    expect(blocks).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns [] for empty or block-free html', () => {
    expect(extractLdJsonBlocks('')).toEqual([]);
    expect(extractLdJsonBlocks('<html><body>no scripts</body></html>')).toEqual(
      [],
    );
  });
});

describe('parseJobPostingLd', () => {
  it('parses a single JobPosting object', () => {
    const [job] = parseJobPostingLd(page(baseJob));
    expect(job.title).toBe('Staff Engineer');
    expect(job.description).toBe('<p>Build things.</p>');
    expect(job.datePosted).toBe('2026-06-11T21:42:38-05:00');
    expect(job.hiringOrganizationName).toBe('Acme Corp');
    expect(job.hiringOrganizationUrl).toBe('https://acme.example');
  });

  it('ignores non-JobPosting blocks (e.g. WebSite)', () => {
    const jobs = parseJobPostingLd(page({ '@type': 'WebSite' }, baseJob));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Staff Engineer');
  });

  it('unwraps an array of postings in a single block', () => {
    const jobs = parseJobPostingLd(
      page([baseJob, { ...baseJob, title: 'Second Role' }]),
    );
    expect(jobs.map((j) => j.title)).toEqual(['Staff Engineer', 'Second Role']);
  });

  it('unwraps a @graph container', () => {
    const jobs = parseJobPostingLd(
      page({ '@context': 'https://schema.org', '@graph': [baseJob] }),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Staff Engineer');
  });

  it('unwraps an ItemList of ListItem.item postings', () => {
    const jobs = parseJobPostingLd(
      page({
        '@type': 'ItemList',
        itemListElement: [
          { '@type': 'ListItem', item: baseJob },
          { '@type': 'ListItem', item: { ...baseJob, title: 'Listed Role' } },
        ],
      }),
    );
    expect(jobs.map((j) => j.title)).toEqual(['Staff Engineer', 'Listed Role']);
  });

  it('accepts @type given as an array', () => {
    const jobs = parseJobPostingLd(
      page({ ...baseJob, '@type': ['JobPosting', 'Thing'] }),
    );
    expect(jobs).toHaveLength(1);
  });

  it('falls back to name when title is absent', () => {
    const [job] = parseJobPostingLd(
      page({ '@type': 'JobPosting', name: 'Named Role' }),
    );
    expect(job.title).toBe('Named Role');
  });

  it('returns [] when there is no JobPosting', () => {
    expect(parseJobPostingLd(page({ '@type': 'WebSite' }))).toEqual([]);
    expect(parseJobPostingLd('<html></html>')).toEqual([]);
  });

  it('joins an array employmentType and detects remote', () => {
    const [job] = parseJobPostingLd(
      page({
        ...baseJob,
        employmentType: ['FULL_TIME', 'CONTRACTOR'],
        jobLocationType: 'TELECOMMUTE',
      }),
    );
    expect(job.employmentType).toBe('FULL_TIME, CONTRACTOR');
    expect(job.remote).toBe(true);
  });

  it('parses multiple structured locations', () => {
    const [job] = parseJobPostingLd(
      page({
        ...baseJob,
        jobLocation: [
          {
            '@type': 'Place',
            address: {
              '@type': 'PostalAddress',
              addressLocality: 'Austin',
              addressRegion: 'TX',
              addressCountry: 'US',
              postalCode: '78701',
            },
          },
          {
            '@type': 'Place',
            address: {
              addressLocality: 'Berlin',
              addressCountry: { '@type': 'Country', name: 'Germany' },
            },
          },
        ],
      }),
    );
    expect(job.locations).toHaveLength(2);
    expect(job.locations[0]).toMatchObject({
      city: 'Austin',
      region: 'TX',
      country: 'US',
      postalCode: '78701',
      label: 'Austin, TX, US',
    });
    expect(job.locations[1]).toMatchObject({ city: 'Berlin', country: 'Germany' });
  });

  it('parses a min/max baseSalary into a normalised range', () => {
    const [job] = parseJobPostingLd(
      page({
        ...baseJob,
        baseSalary: {
          '@type': 'MonetaryAmount',
          currency: 'USD',
          value: {
            '@type': 'QuantitativeValue',
            minValue: 120000,
            maxValue: 160000,
            unitText: 'YEAR',
          },
        },
      }),
    );
    expect(job.baseSalary).toEqual({
      minAmount: 120000,
      maxAmount: 160000,
      currency: 'USD',
      interval: CompensationInterval.YEARLY,
    });
  });

  it('parses a single-value baseSalary as min=max', () => {
    const [job] = parseJobPostingLd(
      page({
        ...baseJob,
        baseSalary: {
          currency: 'USD',
          value: { value: 50, unitText: 'HOUR' },
        },
      }),
    );
    expect(job.baseSalary).toEqual({
      minAmount: 50,
      maxAmount: 50,
      currency: 'USD',
      interval: CompensationInterval.HOURLY,
    });
  });

  it('extracts an apply URL from potentialAction (ApplyAction)', () => {
    const [job] = parseJobPostingLd(
      page({
        ...baseJob,
        url: 'https://acme.example/jobs/1',
        potentialAction: {
          '@type': 'ApplyAction',
          target: { '@type': 'EntryPoint', url: 'https://apply.example/1' },
        },
      }),
    );
    expect(job.url).toBe('https://acme.example/jobs/1');
    expect(job.applyUrl).toBe('https://apply.example/1');
  });
});

describe('jobPostingLdToCompensation', () => {
  it('maps a salary range to a CompensationDto', () => {
    const comp = jobPostingLdToCompensation({
      minAmount: 100,
      maxAmount: 200,
      currency: 'EUR',
      interval: CompensationInterval.MONTHLY,
    });
    expect(comp).toMatchObject({
      minAmount: 100,
      maxAmount: 200,
      currency: 'EUR',
      interval: CompensationInterval.MONTHLY,
    });
  });

  it('returns null when there is no amount', () => {
    expect(jobPostingLdToCompensation(null)).toBeNull();
    expect(
      jobPostingLdToCompensation({
        minAmount: null,
        maxAmount: null,
        currency: 'USD',
        interval: null,
      }),
    ).toBeNull();
  });
});

describe('jobPostingLdFromNode', () => {
  it('maps a pre-parsed JobPosting object (e.g. Paycom googleJobJson)', () => {
    const node = jobPostingLdFromNode({
      ...baseJob,
      url: 'https://example.com/jobs/42',
      baseSalary: {
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: { '@type': 'QuantitativeValue', minValue: 90000, maxValue: 120000, unitText: 'YEAR' },
      },
    });
    expect(node?.title).toBe('Staff Engineer');
    expect(node?.datePosted).toBe('2026-06-11T21:42:38-05:00');
    expect(node?.url).toBe('https://example.com/jobs/42');
    expect(jobPostingLdToCompensation(node?.baseSalary)).toMatchObject({
      minAmount: 90000,
      maxAmount: 120000,
      currency: 'USD',
      interval: CompensationInterval.YEARLY,
    });
  });

  it('parses a JSON string and unwraps @graph containers', () => {
    const fromString = jobPostingLdFromNode(JSON.stringify(baseJob));
    expect(fromString?.title).toBe('Staff Engineer');

    const fromGraph = jobPostingLdFromNode({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'WebSite' }, baseJob],
    });
    expect(fromGraph?.title).toBe('Staff Engineer');
  });

  it('returns null for empty / malformed / non-JobPosting input', () => {
    expect(jobPostingLdFromNode(null)).toBeNull();
    expect(jobPostingLdFromNode('')).toBeNull();
    expect(jobPostingLdFromNode('{ not json')).toBeNull();
    expect(jobPostingLdFromNode({ '@type': 'Organization', name: 'Acme' })).toBeNull();
  });
});

describe('ld+json extraction and mapping: linear time (fork-sync hardening)', () => {
  // The former extraction regex, kept here only as the parity oracle.
  const OLD_SCRIPT_BLOCK_RE =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const oracle = (html: string): unknown[] => {
    const out: unknown[] = [];
    OLD_SCRIPT_BLOCK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = OLD_SCRIPT_BLOCK_RE.exec(html)) !== null) {
      const raw = m[1]?.trim();
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw));
      } catch {
        // malformed: skipped, as in extractLdJsonBlocks
      }
    }
    return out;
  };
  // Generous bound: the old regex took ~4.5-4.9 s on 125-563 KiB of these
  // shapes and grew quadratically; slow CI CPUs must never flake here.
  const BOUND_MS = 1000;

  it.each([
    ['upper-case tags', '<SCRIPT TYPE="APPLICATION/LD+JSON">{"a":1}</SCRIPT>'],
    ['single quotes and extra attrs', `<script id="x" type='application/ld+json' async>[2]</script>`],
    ['mixed quotes', `<script type="application/ld+json'>{"b":3}</script>`],
    ['data-type also matches', '<script data-type="application/ld+json">{"c":4}</script>'],
    ['other script types skipped', '<script type="text/javascript">{"d":5}</script><script type="application/ld+json">{"e":6}</script>'],
    ['spaces around = do not match', '<script type = "application/ld+json">{"f":7}</script>'],
    ['closer with a space does not close', '<script type="application/ld+json">{"g":8}</script ><script type="application/ld+json">{"h":9}</script>'],
    ['opener inside an opener', '<script <script type="application/ld+json">{"i":10}</script>'],
    ['opener without type then a real block', '<script async>x</script><script type="application/ld+json">{"j":11}</script>'],
    ['unclosed last block', '<script type="application/ld+json">{"k":12}</script><script type="application/ld+json">{"l":13}'],
    ['no > after opener', '<script type="application/ld+json"'],
    ['<scripts prefix matches too', '<scripts type="application/ld+json">{"m":14}</script>'],
    ['non-ASCII look-alikes do not fold', '<\u017Fcript type="application/ld+json">{"n":15}</script>'],
    ['empty and malformed bodies', '<script type="application/ld+json">  </script><script type="application/ld+json">{bad</script>'],
  ])('matches the former regex: %s', (_label, html) => {
    expect(extractLdJsonBlocks(html)).toEqual(oracle(html));
  });

  it('extracts blocks before 560 KiB of unclosed ld+json openers in linear time', () => {
    // No `</script>` after the openers: the old regex re-scanned to the end of
    // the page from every one of them.
    const html =
      '<script type="application/ld+json">{"ok":1}</script>' +
      '<script type="application/ld+json">x'.repeat(16_000);
    const started = Date.now();
    const blocks = extractLdJsonBlocks(html);
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
    expect(blocks).toEqual([{ ok: 1 }]);
  });

  it('scans 256 KiB of "<script " without a closing > in linear time', () => {
    // ~18 s with the old regex; a few ms now.
    const html = '<script '.repeat(32_768);
    const started = Date.now();
    expect(extractLdJsonBlocks(html)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
  });

  it('maps a 300 x 300 nested-address JobPosting quickly', () => {
    // Finding 13's shape: jobLocation.address with many junk keys and a large
    // address array. The uncapped mapper took ~94 s on 35 KiB of this.
    const junk: Record<string, string> = {};
    for (let i = 0; i < 300; i++) junk[`junk${i}`] = 'x';
    const address = Array.from({ length: 300 }, (_, i) => ({ addressLocality: `c${i}` }));
    const html = page(
      { ...baseJob, jobLocation: { address: { ...junk, address } } },
      { ...baseJob, jobLocation: { address: { address, ...junk } } },
    );
    const started = Date.now();
    const postings = parseJobPostingLd(html);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(postings).toHaveLength(2);
    // address key first: the first expanded entry fills the location
    expect(postings[1].locations[0]?.city).toBe('c0');
  });
});

describe('parseJobPostingLd: address caps (fork-sync hardening)', () => {
  const addresses = (n: number, prefix = 'c') =>
    Array.from({ length: n }, (_, i) => ({ addressLocality: `${prefix}${i}` }));
  // Generous bound: these pages took 2-8 s when every address was its own
  // uncapped mapping call; slow CI CPUs must never flake here.
  const BOUND_MS = 1000;

  it('maps at most 100 addresses per posting, skipping non-objects without counting them', () => {
    const [posting] = parseJobPostingLd(
      page({
        ...baseJob,
        jobLocation: [
          'not a place',
          { address: ['skip', null, ...addresses(60, 'a')] },
          { address: addresses(60, 'b') },
        ],
      }),
    );
    expect(posting.title).toBe('Staff Engineer');
    expect(posting.locations).toHaveLength(100);
    expect(posting.locations[59].city).toBe('a59');
    expect(posting.locations[99].city).toBe('b39');
    const node = jobPostingLdFromNode({ ...baseJob, jobLocation: { address: addresses(150) } });
    expect(node?.locations).toHaveLength(100);
  });

  it('maps at most 2000 addresses per page across its postings', () => {
    const postings = parseJobPostingLd(
      page(Array.from({ length: 25 }, () => ({ ...baseJob, jobLocation: { address: addresses(100) } }))),
    );
    expect(postings).toHaveLength(25);
    expect(postings.map((p) => p.locations.length)).toEqual([
      ...Array.from({ length: 20 }, () => 100),
      ...Array.from({ length: 5 }, () => 0),
    ]);
    // every posting keeps its other fields
    expect(postings.every((p) => p.title === 'Staff Engineer')).toBe(true);
    // one address per posting: the page budget still stops at 2000
    const many = parseJobPostingLd(
      page(Array.from({ length: 2100 }, (_, i) => ({ '@type': 'JobPosting', jobLocation: { address: { addressLocality: `p${i}` } } }))),
    );
    expect(many.filter((p) => p.locations.length === 1)).toHaveLength(2000);
    expect(many[1999].locations[0]?.city).toBe('p1999');
    expect(many[2000].locations).toEqual([]);
  });

  it.each([
    ['100k empty addresses (293 KiB)', { ...baseJob, jobLocation: { address: Array.from({ length: 100_000 }, () => ({})) } }],
    ['33k places with an empty address', { ...baseJob, jobLocation: Array.from({ length: 33_000 }, () => ({ address: {} })) }],
  ])('maps a page of %s in linear time', (_label, payload) => {
    const html = page(payload);
    const started = Date.now();
    const postings = parseJobPostingLd(html);
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
    expect(postings.length).toBeGreaterThan(0);
    expect(postings.every((p) => p.locations.length === 0)).toBe(true);
  });
});
