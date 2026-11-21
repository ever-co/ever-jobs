import 'reflect-metadata';
import { AnalyticsService } from '@ever-jobs/analytics';
import { CompensationDto, CompensationInterval, JobPostDto, SalarySource } from '@ever-jobs/models';
import { SearchCommand } from '../src/commands/search.command';

/**
 * T-2522 — `search --analyze` prints the salary range in the currency the
 * analysis reports, not a fixed `$`.
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

function euroJob(id: string, minAmount: number, maxAmount: number): JobPostDto {
  return new JobPostDto({
    id,
    site: 'linkedin',
    title: 'Engineer',
    companyName: 'Acme',
    jobUrl: `https://example.com/${id}`,
    compensation: new CompensationDto({ interval: CompensationInterval.YEARLY, minAmount, maxAmount, currency: 'EUR' }),
  });
}

describe('search --analyze: salary range', () => {
  it('labels the range with the reported currency', async () => {
    const jobs = [euroJob('e-1', 50000, 60000), euroJob('e-2', 70000, 80000)];
    const jobsService = { searchJobs: jest.fn().mockResolvedValue(jobs) };
    const cmd = new SearchCommand(jobsService as any, new AnalyticsService());

    await cmd.run([], { searchTerm: 'engineer', analyze: true } as any);

    const lines = stderr.mock.calls.map((c) => String(c[0]));
    const salaryLine = lines.find((l) => l.startsWith('Salary range'));
    expect(salaryLine).toBeDefined();
    expect(salaryLine).toContain('EUR');
    expect(salaryLine).not.toContain('$');
  });
});

/**
 * T-2605 — under `EVER_JOBS_SALARY_GRAMMAR=legacy`, `--enforce-annual-salary`
 * leaves a description salary yearly but labelled with its source interval
 * (`Pay: $20 - $25/hr` → hourly 41600-52000); `--analyze` must not annualise
 * it a second time.
 */
describe('search --analyze --enforce-annual-salary: legacy description salary', () => {
  const GRAMMAR_ENV = 'EVER_JOBS_SALARY_GRAMMAR';
  const shellGrammar = process.env[GRAMMAR_ENV];

  afterEach(() => {
    if (shellGrammar === undefined) delete process.env[GRAMMAR_ENV];
    else process.env[GRAMMAR_ENV] = shellGrammar;
  });

  it('prints the yearly amounts as they are', async () => {
    process.env[GRAMMAR_ENV] = 'legacy';
    const job = new JobPostDto({
      id: 'd-1',
      site: 'linkedin',
      title: 'Engineer',
      companyName: 'Acme',
      jobUrl: 'https://example.com/d-1',
      compensation: new CompensationDto({ interval: CompensationInterval.HOURLY, minAmount: 41600, maxAmount: 52000, currency: 'USD' }),
      salarySource: SalarySource.DESCRIPTION,
    });
    const jobsService = { searchJobs: jest.fn().mockResolvedValue([job]) };
    const cmd = new SearchCommand(jobsService as any, new AnalyticsService());

    await cmd.run([], { searchTerm: 'engineer', analyze: true, enforceAnnualSalary: true } as any);

    expect(jobsService.searchJobs.mock.calls[0][0].enforceAnnualSalary).toBe(true);
    const lines = stderr.mock.calls.map((c) => String(c[0]));
    const salaryLine = lines.find((l) => l.startsWith('Salary range'));
    expect(salaryLine).toBe(`Salary range (USD): ${(41600).toLocaleString()} - ${(52000).toLocaleString()} (avg ${(41600).toLocaleString()})`);
  });
});
