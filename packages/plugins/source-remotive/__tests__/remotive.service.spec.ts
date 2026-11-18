import 'reflect-metadata';

const mockGet = jest.fn();

jest.mock('@ever-jobs/common', () => ({
  ...(jest.requireActual('@ever-jobs/common') as object),
  createHttpClient: () => ({ get: mockGet }),
}));

import { CompensationInterval, ScraperInputDto } from '@ever-jobs/models';
import { RemotiveService } from '../src/remotive.service';

/**
 * T-2587 — Remotive salary parsing.
 *
 * The plugin used its own regex (`\$?([\d,]+)\s*[-–]\s*\$?([\d,]+)`) and
 * always labelled the result yearly USD: a `k` suffix broke the match, so
 * `$170k - $200k` gave no compensation, and `$14 - $20/hour` became a yearly
 * salary of 14-20 USD. It now uses the shared `extractSalary`.
 */
describe('RemotiveService salary parsing', () => {
  const job = (id: number, salary: string) => ({
    id,
    url: `https://remotive.com/remote-jobs/software-dev/job-${id}`,
    title: `Engineer ${id}`,
    company_name: 'Acme',
    company_logo: '',
    company_logo_url: '',
    category: 'Software Development',
    tags: [],
    job_type: 'full_time',
    publication_date: '2026-11-17T10:00:00',
    candidate_required_location: 'Worldwide',
    salary,
    description: '<p>Build things.</p>',
  });

  const compensationOf = async (salary: string) => {
    mockGet.mockResolvedValue({ data: { jobs: [job(1, salary)] } });
    const result = await new RemotiveService().scrape(
      new ScraperInputDto({ searchTerm: 'engineer' }),
    );
    expect(result.jobs).toHaveLength(1);
    return result.jobs[0].compensation;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads a 'k' range as a yearly USD salary", async () => {
    const compensation = await compensationOf('$170k - $200k');

    expect(compensation).not.toBeNull();
    expect(compensation).toMatchObject({
      interval: CompensationInterval.YEARLY,
      minAmount: 170000,
      maxAmount: 200000,
      currency: 'USD',
    });
  });

  // T-2633 — 25k sits under the monthly threshold and 35k does not; the
  // shared parser dropped the whole range, so the job had no compensation.
  it("reads a 'k' range that crosses the monthly threshold as yearly USD", async () => {
    const compensation = await compensationOf('$25k - $35k');

    expect(compensation).not.toBeNull();
    expect(compensation).toMatchObject({
      interval: CompensationInterval.YEARLY,
      minAmount: 25000,
      maxAmount: 35000,
      currency: 'USD',
    });
  });

  it('labels an hourly range as hourly, not yearly', async () => {
    const compensation = await compensationOf('$14 - $20/hour');

    expect(compensation).not.toBeNull();
    expect(compensation).toMatchObject({
      interval: CompensationInterval.HOURLY,
      minAmount: 14,
      maxAmount: 20,
      currency: 'USD',
    });
  });

  it('keeps reading a plain comma-grouped range as yearly USD', async () => {
    const compensation = await compensationOf('$60,000 - $80,000');

    expect(compensation).toMatchObject({
      interval: CompensationInterval.YEARLY,
      minAmount: 60000,
      maxAmount: 80000,
      currency: 'USD',
    });
  });

  it('gives no compensation for an empty salary', async () => {
    const compensation = await compensationOf('');

    expect(compensation).toBeNull();
  });

  it('keeps the currency of a non-USD salary', async () => {
    expect(await compensationOf('£60,000 - £80,000')).toMatchObject({
      interval: CompensationInterval.YEARLY,
      minAmount: 60000,
      maxAmount: 80000,
      currency: 'GBP',
    });
    expect(await compensationOf('€50k - €70k')).toMatchObject({
      interval: CompensationInterval.YEARLY,
      minAmount: 50000,
      maxAmount: 70000,
      currency: 'EUR',
    });
  });

  it('still reads a range written with no currency as USD', async () => {
    expect(await compensationOf('60,000 - 80,000')).toMatchObject({
      interval: CompensationInterval.YEARLY,
      minAmount: 60000,
      maxAmount: 80000,
      currency: 'USD',
    });
    expect(await compensationOf('70K-80K')).toMatchObject({
      interval: CompensationInterval.YEARLY,
      minAmount: 70000,
      maxAmount: 80000,
      currency: 'USD',
    });
  });

  it('does not read prose numbers as a salary', async () => {
    expect(await compensationOf('5 - 7 years experience')).toBeNull();
  });

  it('maps every job of a mixed feed with the right compensation', async () => {
    mockGet.mockResolvedValue({
      data: {
        jobs: [
          job(1, '$170k - $200k'),
          job(2, '$14 - $20/hour'),
          job(3, '$60,000 - $80,000'),
          job(4, ''),
        ],
      },
    });

    const result = await new RemotiveService().scrape(
      new ScraperInputDto({ searchTerm: 'engineer' }),
    );

    expect(result.jobs.map((j) => j.compensation)).toEqual([
      expect.objectContaining({ interval: 'yearly', minAmount: 170000, maxAmount: 200000, currency: 'USD' }),
      expect.objectContaining({ interval: 'hourly', minAmount: 14, maxAmount: 20, currency: 'USD' }),
      expect.objectContaining({ interval: 'yearly', minAmount: 60000, maxAmount: 80000, currency: 'USD' }),
      null,
    ]);
  });
});
