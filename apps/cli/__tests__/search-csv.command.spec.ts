import 'reflect-metadata';
import { JobPostDto, LocationDto } from '@ever-jobs/models';
import { SearchCommand } from '../src/commands/search.command';

/**
 * CSV injection guard on the CLI export (`search --format csv`). Job fields
 * are scraped from third-party boards, so a title such as `=HYPERLINK(...)`
 * must not run as a formula when the file is opened in a spreadsheet.
 */

async function renderCsv(jobs: JobPostDto[]): Promise<string> {
  const jobsService = { searchJobs: jest.fn().mockResolvedValue(jobs) };
  const analytics = { analyze: jest.fn(), analyzeCompanies: jest.fn().mockReturnValue([]) };
  const cmd = new SearchCommand(jobsService as any, analytics as any);
  await cmd.run([], { searchTerm: 'engineer', format: 'csv' } as any);
  return stdout.mock.calls.map((c) => String(c[0])).join('');
}

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

describe('search --format csv: formula cells', () => {
  it('prefixes formula-leading cells and quotes a carriage return', async () => {
    const job = new JobPostDto({
      id: 'x-1',
      site: 'linkedin',
      title: '=HYPERLINK("http://example.com","x")',
      companyName: '@SUM(1)',
      jobUrl: 'https://example.com/x-1',
      location: new LocationDto({ city: '-Paris' }),
      description: 'line one\rline two',
    });

    const csv = await renderCsv([job]);

    expect(csv).toContain(',"\'=HYPERLINK(""http://example.com"",""x"")",');
    expect(csv).toContain(",'@SUM(1),");
    expect(csv).toContain(",'-Paris,");
    expect(csv).toContain(',"line one\rline two",');
  });
});
