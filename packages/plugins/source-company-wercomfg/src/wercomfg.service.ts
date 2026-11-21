import { Injectable, Logger } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  classifyScrapeError,
  DescriptionFormat,
  IScraper,
  JobPostDto,
  JobResponseDto,
  LocationDto,
  ScraperInputDto,
  ScrapeDiagnostics,
  Site,
} from '@ever-jobs/models';
import {
  createHttpClient,
  describeUrlForLog,
  extractJobType,
  extractLdJsonBlocks,
  firstPublicUrl,
  htmlToPlainText,
  jobPostingLdFromNode,
  jobPostingLdToCompensation,
  markdownConverter,
  pinUrlToHosts,
  toDateOnly,
} from '@ever-jobs/common';
import * as cheerio from 'cheerio';
import {
  WERCOMFG_ALLOWED_HOSTS,
  WERCOMFG_APPLY_MAILTO,
  WERCOMFG_CAREERS_URL,
  WERCOMFG_COMPANY_NAME,
  WERCOMFG_DEFAULT_TIMEOUT_SECONDS,
  WERCOMFG_DETAIL_LINK_RE,
  WERCOMFG_MAX_DETAIL_LINKS,
  WERCOMFG_ORIGIN,
} from './wercomfg.constants';
import { WercoDetailLink, WercoPosting } from './wercomfg.types';

/**
 * Werco Manufacturing careers scraper.
 *
 * The `/careers` index is a server-rendered page that links one detail page
 * (`/careers/{slug}`) per role. Each detail page embeds a complete schema.org
 * `JobPosting` JSON-LD block, so the plugin only needs the index's link list —
 * every field comes from structured data. The index itself carries no
 * `JobPosting`, which is why a single-page JSON-LD scrape cannot reach these
 * roles.
 */
@SourcePlugin({
  site: Site.WERCOMFG,
  name: WERCOMFG_COMPANY_NAME,
  category: 'company',
  companyDomains: ['wercomfg.com'],
})
@Injectable()
export class WercoMfgService implements IScraper {
  private readonly logger = new Logger(WercoMfgService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const jobs = await this.fetchJobs(input);
      if (jobs.length === 0) {
        return new JobResponseDto(
          [],
          new ScrapeDiagnostics('empty', 'no job postings found on the Werco careers pages'),
        );
      }
      const out = this.applyInput(jobs, input);
      this.logger.log(`Werco Manufacturing: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `Werco Manufacturing scrape failed [${diagnostics.reason}]: ${diagnostics.detail}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  private async fetchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const client = createHttpClient({
      proxies: input.proxies,
      caCert: input.caCert,
      requestTimeout: input.requestTimeout ?? WERCOMFG_DEFAULT_TIMEOUT_SECONDS,
      // Spec 1689 — re-pin every redirect hop, not just the first URL
      allowedRedirectHosts: WERCOMFG_ALLOWED_HOSTS,
    });

    const careersUrl = this.careersUrl(input);
    const indexRes = await client.get<string>(careersUrl);
    const links = this.collectDetailLinks(cheerio.load(String(indexRes.data ?? '')), careersUrl);
    if (!links.length) return [];

    // One detail page at a time (CLAUDE.md §6, Spec 1690): a small company
    // site, and a cap above, so no fan-out. A failed page skips that role only.
    const jobs: JobPostDto[] = [];
    for (const link of links) {
      const res = await client.get<string>(link.url).catch(() => null);
      if (!res) {
        this.logger.warn(`Werco detail fetch failed for ${link.url}`);
        continue;
      }
      const posting = this.parseDetail(String(res.data ?? ''));
      if (!posting) continue;
      const job = this.toJobPost(posting, link, input.descriptionFormat);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  /**
   * The careers index to fetch: the caller's `companyUrl` when it is on
   * wercomfg.com (or a subdomain), otherwise this plugin's board.
   *
   * Pin-or-ignore (Spec 1689), as `source-company-soundryx` does: a company
   * plugin scrapes one company, so an off-domain, internal or malformed
   * `companyUrl` is a mistake or an attempt to aim our HTTP client elsewhere.
   * Neither deserves a failed scrape — ignore it and say so. `http:` is
   * upgraded.
   */
  private careersUrl(input: ScraperInputDto): string {
    const requested = this.normalize(input.companyUrl);
    if (!requested) return WERCOMFG_CAREERS_URL;
    const pinned = pinUrlToHosts(requested, WERCOMFG_ALLOWED_HOSTS, { upgradeHttp: true });
    if (!pinned) {
      this.logger.debug(
        `Werco Manufacturing: ignoring companyUrl on host \`${describeUrlForLog(requested)}\` - not an https URL on ${WERCOMFG_ALLOWED_HOSTS.join(', ')}`,
      );
      return WERCOMFG_CAREERS_URL;
    }
    return pinned;
  }

  /**
   * `/careers/{slug}` links on the index, each pinned to the Werco hosts
   * (Spec 1689 — links read off a fetched page are untrusted): a link to
   * another host, an IP literal, a non-default port or with credentials is
   * dropped, an `http:` one is upgraded. At most
   * {@link WERCOMFG_MAX_DETAIL_LINKS} distinct links are kept.
   */
  private collectDetailLinks($: cheerio.CheerioAPI, baseUrl: string): WercoDetailLink[] {
    const seen = new Set<string>();
    const links: WercoDetailLink[] = [];
    let dropped = 0;
    $('a[href]').each((_i, el) => {
      if (links.length >= WERCOMFG_MAX_DETAIL_LINKS) return false;
      const href = ($(el).attr('href') ?? '').trim();
      const absolute = this.absoluteUrl(href, baseUrl);
      if (!absolute || !WERCOMFG_DETAIL_LINK_RE.test(new URL(absolute).pathname)) return undefined;
      const pinned = pinUrlToHosts(absolute, WERCOMFG_ALLOWED_HOSTS, { upgradeHttp: true });
      if (!pinned) {
        dropped++;
        return undefined;
      }
      const parsed = new URL(pinned);
      parsed.hash = '';
      const url = parsed.href;
      if (seen.has(url)) return undefined;
      seen.add(url);
      links.push({
        url,
        slug: parsed.pathname.replace(/^\/careers\//, '').replace(/\/+$/, ''),
      });
      return undefined;
    });
    if (dropped) this.logger.debug(`Werco Manufacturing: dropped ${dropped} off-site detail link(s)`);
    return links;
  }

  /** Extract the page's `JobPosting` node plus the raw extras it carries. */
  private parseDetail(html: string): WercoPosting | null {
    const node = this.findJobPostingNode(extractLdJsonBlocks(html));
    if (!node) return null;
    const posting = jobPostingLdFromNode(node);
    if (!posting) return null;
    return {
      posting,
      identifier: this.propertyValue(node.identifier),
      industry: this.asString(node.industry),
      occupationalCategory: this.asString(node.occupationalCategory),
      workHours: this.asString(node.workHours),
    };
  }

  private toJobPost(
    { posting, identifier, industry, occupationalCategory, workHours }: WercoPosting,
    link: WercoDetailLink,
    format: DescriptionFormat | undefined,
  ): JobPostDto | null {
    const title = this.normalize(posting.title);
    if (!title) return null;
    const atsId = this.normalize(identifier) || link.slug;
    if (!atsId) return null;
    // only an http(s) page may become a link (Spec 1751) — never `javascript:`
    const jobUrl = firstPublicUrl(this.normalize(posting.url)) ?? link.url;
    const description = this.composeDescription(
      this.formatDescription(posting.description, format),
      industry,
      occupationalCategory,
      workHours,
    );
    const loc = posting.locations[0] ?? null;
    const location = loc && (loc.city || loc.region || loc.country)
      ? new LocationDto({ city: loc.city ?? undefined, state: loc.region ?? undefined, country: loc.country ?? undefined })
      : null;
    const employmentType = this.normalize(posting.employmentType);

    return new JobPostDto({
      id: `wercomfg-${atsId}`,
      atsId,
      site: Site.WERCOMFG,
      atsType: 'wercomfg',
      title,
      companyName: this.normalize(posting.hiringOrganizationName) || WERCOMFG_COMPANY_NAME,
      companyUrl: WERCOMFG_ORIGIN,
      jobUrl,
      jobUrlDirect: jobUrl,
      applyUrl: firstPublicUrl(this.normalize(posting.applyUrl)) ?? WERCOMFG_APPLY_MAILTO,
      jobType: employmentType ? extractJobType(employmentType.replace(/[_-]/g, ' ')) ?? null : null,
      location,
      ...(location ? { locations: [location] } : {}),
      ...(description ? { description } : {}),
      datePosted: posting.datePosted ? toDateOnly(posting.datePosted) : null,
      isRemote: posting.remote,
      employmentType: employmentType || null,
      compensation: jobPostingLdToCompensation(posting.baseSalary),
    });
  }

  /** Walk parsed ld+json blocks for the first `JobPosting` node (handles `@graph`/`ItemList` containers). */
  private findJobPostingNode(value: unknown): Record<string, unknown> | null {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findJobPostingNode(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    const node = value as Record<string, unknown>;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting')) {
      return node;
    }
    for (const key of ['@graph', 'itemListElement', 'item']) {
      if (node[key] !== undefined) {
        const found = this.findJobPostingNode(node[key]);
        if (found) return found;
      }
    }
    return null;
  }

  /** A schema `PropertyValue` (or bare string) → its `value`. */
  private propertyValue(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null) {
      const v = (value as Record<string, unknown>).value;
      return typeof v === 'string' ? v : null;
    }
    return null;
  }

  /** Schema values arrive as string, `{name}` object, or arrays of either. */
  private asString(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const parts = value.map((v) => this.asString(v)).filter((v): v is string => !!v);
      return parts.length ? parts.join(', ') : null;
    }
    if (typeof value === 'object' && value !== null) {
      return this.asString((value as Record<string, unknown>).name);
    }
    return null;
  }

  private composeDescription(
    body: string | null,
    industry: string | null,
    occupationalCategory: string | null,
    workHours: string | null,
  ): string | null {
    const meta: string[] = [];
    if (industry) meta.push(`Industry: ${industry}`);
    if (occupationalCategory) meta.push(`Category: ${occupationalCategory}`);
    if (workHours) meta.push(`Shift: ${workHours}`);
    const parts = [body, meta.length ? meta.join('\n') : null].filter(
      (p): p is string => !!p,
    );
    return parts.length ? parts.join('\n\n') : null;
  }

  private formatDescription(html: string | null, format?: DescriptionFormat): string | null {
    if (!html) return null;
    if (format === DescriptionFormat.HTML) return html;
    if (format === DescriptionFormat.MARKDOWN) return markdownConverter(html) ?? html;
    return htmlToPlainText(html) ?? html;
  }

  private absoluteUrl(href: string, baseUrl: string): string | null {
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) {
      return null;
    }
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return null;
    }
  }

  private applyInput(jobs: JobPostDto[], input: ScraperInputDto): JobPostDto[] {
    let filtered = jobs;

    const searchTerm = this.normalize(input.searchTerm).toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((job) =>
        [job.title, job.description, job.location?.city, job.location?.state].some((value) =>
          this.normalize(value).toLowerCase().includes(searchTerm),
        ),
      );
    }

    const offset = this.nonNegativeInt(input.offset, 0);
    const requested = this.nonNegativeInt(input.resultsWanted, 100);
    return filtered.slice(offset, offset + requested);
  }

  private nonNegativeInt(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  private normalize(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.split(String.fromCharCode(160)).join(' ').replace(/\s+/g, ' ').trim();
  }
}
