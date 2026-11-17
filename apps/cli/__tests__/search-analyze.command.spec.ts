import 'reflect-metadata';
import { AnalyticsService } from '@ever-jobs/analytics';
import { CompensationDto, CompensationInterval, JobPostDto } from '@ever-jobs/models';
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
