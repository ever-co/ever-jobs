import { Injectable } from '@nestjs/common';
import { convertToAnnual, hasSalaryAmount } from '@ever-jobs/common';
import {
  CompensationDto, JobPostDto, JobSummaryDto, CompanyInsightDto,
  SiteComparisonDto, JobAnalysisDto,
} from '@ever-jobs/models';

/** Currency assumed when a compensation does not name one (the `CompensationDto` default). */
const DEFAULT_CURRENCY = 'USD';

/** A bound counts only when it is a finite number above zero, as in `hasSalaryAmount`. */
function isUsableAmount(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Upper-cased ISO code of a compensation, or the default when it names none. */
function currencyOf(compensation: CompensationDto): string {
  return compensation.currency?.trim().toUpperCase() || DEFAULT_CURRENCY;
}

/**
 * T-2522 — the yearly low and high end of a compensation that has a usable
 * amount. A copy is annualised (hourly × 2080, daily × 260, weekly × 52,
 * monthly × 12); the job's own compensation is never changed. A missing
 * (or unusable) bound falls back to the other one; callers pass only
 * compensations for which `hasSalaryAmount` holds, so one bound is present.
 */
function annualRange(compensation: CompensationDto): { low: number; high: number } {
  const annual = {
    interval: compensation.interval,
    minAmount: isUsableAmount(compensation.minAmount) ? compensation.minAmount : null,
    maxAmount: isUsableAmount(compensation.maxAmount) ? compensation.maxAmount : null,
  };
  convertToAnnual(annual);
  return {
    low: (annual.minAmount ?? annual.maxAmount) as number,
    high: (annual.maxAmount ?? annual.minAmount) as number,
  };
}

/** The currency named most often; on a tie, the one that comes first. */
function mostCommonCurrency(compensations: CompensationDto[]): string {
  const counts = new Map<string, number>();
  for (const compensation of compensations) {
    const currency = currencyOf(compensation);
    counts.set(currency, (counts.get(currency) ?? 0) + 1);
  }
  let best = DEFAULT_CURRENCY;
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount) {
      best = currency;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Analytics service providing reusable job analysis functions.
 * Used by both CLI and API for post-scrape intelligence.
 */
@Injectable()
export class AnalyticsService {

  /**
   * Generate a full analysis of scraped jobs:
   * summary stats, company intelligence, and site comparison.
   */
  analyze(jobs: JobPostDto[]): JobAnalysisDto {
    return new JobAnalysisDto({
      summary: this.summarize(jobs),
      companies: this.analyzeCompanies(jobs),
      siteComparison: this.compareSites(jobs),
    });
  }

  /**
   * Compute summary statistics: totals, salary range, breakdowns by site/type/location.
   *
   * T-2522 — salary stats are yearly figures in one currency. A job counts in
   * `withSalaryCount` when its compensation has a usable amount (min or max).
   * Each amount is annualised on a copy, and `minSalary`, `maxSalary` and
   * `avgSalary` (the mean of the low ends) are taken over the jobs in the most
   * common currency only, which `currency` reports. A compensation whose
   * interval is missing or unknown is used as given.
   *
   * Known limit: with `EVER_JOBS_SALARY_GRAMMAR=legacy` and
   * `enforceAnnualSalary`, a salary parsed from the description keeps its
   * source interval on amounts that are already yearly (the legacy rule,
   * pinned in `packages/common/__tests__/salary.spec.ts`), so it is
   * annualised a second time here. The default grammar is not affected.
   */
  summarize(jobs: JobPostDto[]): JobSummaryDto {
    const remoteCount = jobs.filter((j) => j.isRemote).length;
    const withSalary = jobs.filter((j) => hasSalaryAmount(j.compensation));

    // Salary stats
    let salaryStats: JobSummaryDto['salaryStats'] = null;
    if (withSalary.length > 0) {
      const compensations = withSalary.map((j) => j.compensation!);
      const currency = mostCommonCurrency(compensations);
      const ranges = compensations
        .filter((c) => currencyOf(c) === currency)
        .map(annualRange);
      const lows = ranges.map((r) => r.low);
      const highs = ranges.map((r) => r.high);

      salaryStats = {
        minSalary: Math.min(...lows),
        maxSalary: Math.max(...highs),
        avgSalary: Math.round(lows.reduce((a, b) => a + b, 0) / lows.length),
        currency,
      };
    }

    // By-site breakdown
    const bySite: Record<string, number> = {};
    for (const job of jobs) {
      const site = job.site ?? 'unknown';
      bySite[site] = (bySite[site] ?? 0) + 1;
    }

    // By-jobType breakdown
    const byJobType: Record<string, number> = {};
    for (const job of jobs) {
      if (job.jobType) {
        for (const jt of job.jobType) {
          byJobType[jt] = (byJobType[jt] ?? 0) + 1;
        }
      }
    }

    // By-location breakdown (top cities)
    const byLocation: Record<string, number> = {};
    for (const job of jobs) {
      const loc = job.location;
      const key = loc?.city
        ? [loc.city, loc.state].filter(Boolean).join(', ')
        : (loc?.country ?? 'Unknown');
      byLocation[key] = (byLocation[key] ?? 0) + 1;
    }

    return new JobSummaryDto({
      totalJobs: jobs.length,
      remoteCount,
      remotePercentage: jobs.length > 0 ? Math.round((remoteCount / jobs.length) * 100) : 0,
      withSalaryCount: withSalary.length,
      salaryStats,
      bySite,
      byJobType,
      byLocation,
    });
  }

  /**
   * BD intelligence: group jobs by company, rank by hiring volume,
   * extract contact emails and locations.
   */
  analyzeCompanies(jobs: JobPostDto[]): CompanyInsightDto[] {
    const companies = new Map<string, {
      count: number;
      roles: string[];
      locations: Set<string>;
      emails: Set<string>;
      url?: string | null;
    }>();

    for (const job of jobs) {
      const name = job.companyName ?? 'Unknown';
      const existing = companies.get(name) ?? {
        count: 0,
        roles: [],
        locations: new Set<string>(),
        emails: new Set<string>(),
      };

      existing.count++;
      existing.roles.push(job.title);
      if (job.companyUrl) existing.url = job.companyUrl;

      const loc = job.location;
      if (loc?.city) {
        existing.locations.add([loc.city, loc.state].filter(Boolean).join(', '));
      }
      if (job.emails) {
        for (const e of job.emails) existing.emails.add(e);
      }

      companies.set(name, existing);
    }

    // Sort by hiring volume (most first)
    return [...companies.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, data]) => new CompanyInsightDto({
        companyName: name,
        openPositions: data.count,
        locations: [...data.locations],
        roles: data.roles,
        emails: [...data.emails],
        companyUrl: data.url,
      }));
  }

  /**
   * Per-site comparison: jobs, salary coverage, remote ratio, unique companies.
   */
  compareSites(jobs: JobPostDto[]): SiteComparisonDto[] {
    const sites = new Map<string, JobPostDto[]>();
    for (const job of jobs) {
      const site = job.site ?? 'unknown';
      const list = sites.get(site) ?? [];
      list.push(job);
      sites.set(site, list);
    }

    return [...sites.entries()].map(([site, siteJobs]) => new SiteComparisonDto({
      site,
      totalJobs: siteJobs.length,
      withSalary: siteJobs.filter((j) => hasSalaryAmount(j.compensation)).length,
      remoteJobs: siteJobs.filter((j) => j.isRemote).length,
      uniqueCompanies: new Set(siteJobs.map((j) => j.companyName).filter(Boolean)).size,
    }));
  }
}
