import 'reflect-metadata';
import { AnalyticsService } from '@ever-jobs/analytics';
import { CompensationDto, CompensationInterval, JobPostDto } from '@ever-jobs/models';
import { SearchCommand } from '../src/commands/search.command';

/**
 * T-2606 — `search --format summary` counts "With salary data" the way
 * `--analyze` counts `withSalaryCount`: a job counts when its compensation has
 * a finite amount above zero, min or max (`hasSalaryAmount`).
 */

let stdout: jest.SpyInstance;
let stderr: jest.SpyInstance;

beforeEach(() => {
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
});

function job(id: string, compensation?: Partial<CompensationDto>): JobPostDto {
  return new JobPostDto({
    id,
    site: 'linkedin',
    title: 'Engineer',
    companyName: 'Acme',
    jobUrl: `https://example.com/${id}`,
    ...(compensation
      ? { compensation: new CompensationDto({ interval: CompensationInterval.YEARLY, ...compensation }) }
      : {}),
  });
}

async function salaryCount(jobs: JobPostDto[]): Promise<number> {
  const jobsService = { searchJobs: jest.fn().mockResolvedValue(jobs) };
  const cmd = new SearchCommand(jobsService as any, new AnalyticsService());
  await cmd.run([], { searchTerm: 'engineer', format: 'summary' } as any);
  const out = stdout.mock.calls.map((c) => String(c[0])).join('');
  const match = /^With salary data: (\d+)$/m.exec(out);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

describe('search --format summary: With salary data', () => {
  it('counts a salary with only a maximum ("up to $90,000")', async () => {
    expect(await salaryCount([job('max-only', { maxAmount: 90000 })])).toBe(1);
  });

  it('counts a 0 minimum with a real maximum', async () => {
    expect(await salaryCount([job('zero-min', { minAmount: 0, maxAmount: 90000 })])).toBe(1);
  });

  it('does not count a 0 / 0 placeholder', async () => {
    expect(await salaryCount([job('zero-zero', { minAmount: 0, maxAmount: 0 })])).toBe(0);
  });

  it('does not count a negative amount', async () => {
    expect(await salaryCount([job('negative', { minAmount: -50000 })])).toBe(0);
  });

  it('does not count a job without compensation', async () => {
    expect(await salaryCount([job('none')])).toBe(0);
  });

  it('still counts a plain yearly min-max salary', async () => {
    expect(await salaryCount([job('range', { minAmount: 80000, maxAmount: 100000 })])).toBe(1);
  });

  it('matches withSalaryCount of --analyze on the same jobs', async () => {
    const jobs = [
      job('max-only', { maxAmount: 90000 }),
      job('zero-min', { minAmount: 0, maxAmount: 90000 }),
      job('zero-zero', { minAmount: 0, maxAmount: 0 }),
      job('negative', { minAmount: -50000 }),
      job('none'),
      job('range', { minAmount: 80000, maxAmount: 100000 }),
    ];

    const count = await salaryCount(jobs);

    expect(count).toBe(3);
    expect(count).toBe(new AnalyticsService().analyze(jobs).summary.withSalaryCount);
  });
});
