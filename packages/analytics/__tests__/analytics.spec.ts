import 'reflect-metadata';
import { AnalyticsService } from '@ever-jobs/analytics';
import { JobPostDto, LocationDto, CompensationDto, CompensationInterval, JobType } from '@ever-jobs/models';

function makeJob(overrides: Partial<{
  title: string;
  companyName: string;
  site: string;
  isRemote: boolean;
  compensation: any;
  location: any;
  jobType: JobType[];
  emails: string[];
}> = {}): JobPostDto {
  return new JobPostDto({
    id: `test-${Math.random().toString(36).slice(2)}`,
    title: overrides.title ?? 'Software Engineer',
    companyName: overrides.companyName ?? 'Acme Corp',
    jobUrl: 'https://example.com/job/1',
    site: overrides.site ?? 'linkedin',
    isRemote: overrides.isRemote ?? false,
    compensation: overrides.compensation,
    location: overrides.location,
    jobType: overrides.jobType ?? null,
    emails: overrides.emails ?? null,
  });
}

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  beforeEach(() => {
    service = new AnalyticsService();
  });

  describe('summarize', () => {
    it('should return zero for empty job list', () => {
      const result = service.summarize([]);
      expect(result.totalJobs).toBe(0);
      expect(result.remoteCount).toBe(0);
      expect(result.remotePercentage).toBe(0);
      expect(result.withSalaryCount).toBe(0);
      expect(result.salaryStats).toBeNull();
    });

    it('should count total jobs correctly', () => {
      const jobs = [makeJob(), makeJob(), makeJob()];
      const result = service.summarize(jobs);
      expect(result.totalJobs).toBe(3);
    });

    it('should count remote jobs', () => {
      const jobs = [
        makeJob({ isRemote: true }),
        makeJob({ isRemote: false }),
        makeJob({ isRemote: true }),
      ];
      const result = service.summarize(jobs);
      expect(result.remoteCount).toBe(2);
      expect(result.remotePercentage).toBe(67);
    });

    it('should calculate salary stats', () => {
      const jobs = [
        makeJob({ compensation: new CompensationDto({ interval: CompensationInterval.YEARLY, minAmount: 80000, maxAmount: 120000, currency: 'USD' }) }),
        makeJob({ compensation: new CompensationDto({ interval: CompensationInterval.YEARLY, minAmount: 100000, maxAmount: 150000, currency: 'USD' }) }),
      ];
      const result = service.summarize(jobs);
      expect(result.withSalaryCount).toBe(2);
      expect(result.salaryStats).not.toBeNull();
      expect(result.salaryStats!.minSalary).toBe(80000);
      expect(result.salaryStats!.maxSalary).toBe(150000);
      expect(result.salaryStats!.avgSalary).toBe(90000); // (80000+100000)/2
    });

    // T-2522 — amounts are annualised before they are compared.
    it('annualises an hourly salary before it is compared with a yearly one', () => {
      const hourly = new CompensationDto({ interval: CompensationInterval.HOURLY, minAmount: 25, maxAmount: 35, currency: 'USD' });
      const jobs = [
        makeJob({ compensation: hourly }),
        makeJob({ compensation: new CompensationDto({ interval: CompensationInterval.YEARLY, minAmount: 90000, maxAmount: 120000, currency: 'USD' }) }),
      ];
      const result = service.summarize(jobs);
      expect(result.withSalaryCount).toBe(2);
      expect(result.salaryStats).toEqual({
        minSalary: 52000, // 25 * 2080
        maxSalary: 120000,
        avgSalary: 71000, // (52000 + 90000) / 2
        currency: 'USD',
      });
      // The job itself is not changed.
      expect(jobs[0].compensation).toBe(hourly);
      expect(hourly).toMatchObject({ interval: CompensationInterval.HOURLY, minAmount: 25, maxAmount: 35 });
    });

    // T-2522 — one currency: the most common one among the jobs with a salary.
    it('reports the most common currency and leaves other currencies out of the figures', () => {
      const jobs = [
        makeJob({ compensation: new CompensationDto({ interval: CompensationInterval.YEARLY, minAmount: 10000, maxAmount: 500000, currency: 'EUR' }) }),
        makeJob({ compensation: new CompensationDto({ interval: CompensationInterval.YEARLY, minAmount: 80000, maxAmount: 120000, currency: 'USD' }) }),
        makeJob({ compensation: new CompensationDto({ interval: CompensationInterval.YEARLY, minAmount: 100000, maxAmount: 150000, currency: 'USD' }) }),
      ];
      const result = service.summarize(jobs);
      expect(result.withSalaryCount).toBe(3);
      expect(result.salaryStats).toEqual({
        minSalary: 80000,
        maxSalary: 150000,
        avgSalary: 90000,
        currency: 'USD',
      });
    });

    // T-2522 — a compensation with only an upper bound is a salary too.
    it('counts a compensation that has only a maxAmount', () => {
      const jobs = [
        makeJob({ compensation: new CompensationDto({ interval: CompensationInterval.YEARLY, maxAmount: 100000, currency: 'USD' }) }),
        makeJob(),
      ];
      const result = service.summarize(jobs);
      expect(result.withSalaryCount).toBe(1);
      expect(result.salaryStats).toEqual({
        minSalary: 100000,
        maxSalary: 100000,
        avgSalary: 100000,
        currency: 'USD',
      });
    });

    // T-2522 — a 0 bound is a "not disclosed" placeholder (as in hasSalaryAmount), not the low end.
    it('does not take a 0 minAmount as the low end', () => {
      const jobs = [
        makeJob({ compensation: new CompensationDto({ interval: CompensationInterval.MONTHLY, minAmount: 0, maxAmount: 5000, currency: 'USD' }) }),
        makeJob({ compensation: new CompensationDto({ interval: CompensationInterval.YEARLY, minAmount: 0, maxAmount: 0, currency: 'USD' }) }),
      ];
      const result = service.summarize(jobs);
      expect(result.withSalaryCount).toBe(1);
      expect(result.salaryStats).toEqual({
        minSalary: 60000, // 5000 * 12
        maxSalary: 60000,
        avgSalary: 60000,
        currency: 'USD',
      });
    });

    it('should break down by site', () => {
      const jobs = [
        makeJob({ site: 'linkedin' }),
        makeJob({ site: 'linkedin' }),
        makeJob({ site: 'indeed' }),
      ];
      const result = service.summarize(jobs);
      expect(result.bySite['linkedin']).toBe(2);
      expect(result.bySite['indeed']).toBe(1);
    });
  });

  describe('analyzeCompanies', () => {
    it('should return empty array for no jobs', () => {
      const result = service.analyzeCompanies([]);
      expect(result).toEqual([]);
    });

    it('should group jobs by company', () => {
      const jobs = [
        makeJob({ companyName: 'Google', title: 'SWE' }),
        makeJob({ companyName: 'Google', title: 'PM' }),
        makeJob({ companyName: 'Meta', title: 'SWE' }),
      ];
      const result = service.analyzeCompanies(jobs);
      expect(result.length).toBe(2);
      expect(result[0].companyName).toBe('Google');
      expect(result[0].openPositions).toBe(2);
      expect(result[0].roles).toEqual(['SWE', 'PM']);
      expect(result[1].companyName).toBe('Meta');
      expect(result[1].openPositions).toBe(1);
    });

    it('should sort by hiring volume descending', () => {
      const jobs = [
        makeJob({ companyName: 'Small' }),
        makeJob({ companyName: 'Big' }),
        makeJob({ companyName: 'Big' }),
        makeJob({ companyName: 'Big' }),
      ];
      const result = service.analyzeCompanies(jobs);
      expect(result[0].companyName).toBe('Big');
      expect(result[0].openPositions).toBe(3);
    });

    it('should collect unique locations', () => {
      const jobs = [
        makeJob({ companyName: 'Acme', location: new LocationDto({ city: 'San Francisco', state: 'CA' }) }),
        makeJob({ companyName: 'Acme', location: new LocationDto({ city: 'San Francisco', state: 'CA' }) }),
        makeJob({ companyName: 'Acme', location: new LocationDto({ city: 'New York', state: 'NY' }) }),
      ];
      const result = service.analyzeCompanies(jobs);
      expect(result[0].locations.length).toBe(2);
      expect(result[0].locations).toContain('San Francisco, CA');
      expect(result[0].locations).toContain('New York, NY');
    });

    it('should collect emails', () => {
      const jobs = [
        makeJob({ companyName: 'Acme', emails: ['hr@acme.com'] }),
        makeJob({ companyName: 'Acme', emails: ['job@acme.com', 'hr@acme.com'] }),
      ];
      const result = service.analyzeCompanies(jobs);
      expect(result[0].emails).toContain('hr@acme.com');
      expect(result[0].emails).toContain('job@acme.com');
    });
  });

  describe('compareSites', () => {
    it('should return empty array for no jobs', () => {
      const result = service.compareSites([]);
      expect(result).toEqual([]);
    });

    it('should group and compare by site', () => {
      const jobs = [
        makeJob({ site: 'linkedin', isRemote: true, compensation: new CompensationDto({ interval: CompensationInterval.YEARLY, minAmount: 80000, maxAmount: 120000, currency: 'USD' }) }),
        makeJob({ site: 'linkedin', isRemote: false }),
        makeJob({ site: 'indeed', isRemote: true, compensation: new CompensationDto({ interval: CompensationInterval.YEARLY, minAmount: 90000, maxAmount: 130000, currency: 'USD' }) }),
      ];
      const result = service.compareSites(jobs);
      expect(result.length).toBe(2);
      const linkedin = result.find((s) => s.site === 'linkedin')!;
      const indeed = result.find((s) => s.site === 'indeed')!;
      expect(linkedin.totalJobs).toBe(2);
      expect(linkedin.withSalary).toBe(1);
      expect(linkedin.remoteJobs).toBe(1);
      expect(indeed.totalJobs).toBe(1);
      expect(indeed.withSalary).toBe(1);
      expect(indeed.remoteJobs).toBe(1);
    });

    // T-2522 — same rule as summarize(): a max-only compensation counts.
    it('counts a compensation that has only a maxAmount', () => {
      const jobs = [
        makeJob({ site: 'indeed', compensation: new CompensationDto({ interval: CompensationInterval.MONTHLY, maxAmount: 6000, currency: 'EUR' }) }),
      ];
      const [indeed] = service.compareSites(jobs);
      expect(indeed.withSalary).toBe(1);
    });
  });

  describe('analyze (full pipeline)', () => {
    it('should produce complete analysis', () => {
      const jobs = [
        makeJob({ site: 'linkedin', companyName: 'Google', isRemote: true }),
        makeJob({ site: 'indeed', companyName: 'Meta' }),
      ];
      const result = service.analyze(jobs);
      expect(result.summary.totalJobs).toBe(2);
      expect(result.companies.length).toBe(2);
      expect(result.siteComparison.length).toBe(2);
    });
  });
});
