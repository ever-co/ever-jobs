import 'reflect-metadata';
import * as path from 'path';
import { ExclusionPreset, JobPostDto, ScraperInputDto } from '@ever-jobs/models';
import { SearchCommand, applyCliExclusions } from '../src/commands/search.command';
import { CompareCommand } from '../src/commands/compare.command';

/**
 * Spec 1700 — CLI flags for multi-location search and exclusion filters.
 *
 * Options are parsed with the same commander build nest-commander uses and
 * registered the way it registers them (`new Option(flags).default().preset()
 * .argParser(handler)`), so these cases exercise the real flag grammar.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OptionMeta } = require('nest-commander/src/constants');
const commanderPath = require.resolve('commander', {
  paths: [path.dirname(require.resolve('nest-commander'))],
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Command: Program, Option: CommanderOption } = require(commanderPath);

function parse(instance: object, argv: string[]): Record<string, any> {
  const program = new Program();
  program.exitOverride();
  const proto = Object.getPrototypeOf(instance);
  for (const name of Object.getOwnPropertyNames(proto)) {
    const fn = proto[name];
    if (typeof fn !== 'function') continue;
    const meta = Reflect.getMetadata(OptionMeta, fn);
    if (!meta) continue;
    program.addOption(
      new CommanderOption(meta.flags, meta.description)
        .default(undefined)
        .preset(undefined)
        .argParser(fn.bind(instance)),
    );
  }
  program.parse(argv, { from: 'user' });
  return program.opts();
}

function job(id: string, title: string): JobPostDto {
  return new JobPostDto({ id, title, companyName: 'Acme', jobUrl: `https://example.com/${id}` });
}

function makeSearch(jobs: JobPostDto[] = []) {
  const jobsService = { searchJobs: jest.fn().mockResolvedValue(jobs) };
  const analytics = { analyze: jest.fn(), analyzeCompanies: jest.fn().mockReturnValue([]) };
  return { cmd: new SearchCommand(jobsService as any, analytics as any), jobsService };
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

describe('search command — flag grammar', () => {
  it('--locations takes several values and -l stays a single location', () => {
    const { cmd } = makeSearch();
    const opts = parse(cmd, ['--locations', 'New York, NY', 'Chicago, IL', '-l', 'Austin, TX', '-q', 'engineer']);
    expect(opts.locations).toEqual(['New York, NY', 'Chicago, IL']);
    expect(opts.location).toBe('Austin, TX');
    expect(opts.searchTerm).toBe('engineer');
  });

  it('repeated --locations accumulate', () => {
    const { cmd } = makeSearch();
    expect(parse(cmd, ['--locations', 'A', '--locations', 'B', 'C']).locations).toEqual(['A', 'B', 'C']);
  });

  it('parses the exclusion flags', () => {
    const { cmd } = makeSearch();
    const opts = parse(cmd, [
      '--exclude-title', 'senior', 'lead*',
      '--exclude-keyword', 'ts/sci',
      '--exclude-preset', 'security_clearance',
    ]);
    expect(opts.excludeTitle).toEqual(['senior', 'lead*']);
    expect(opts.excludeKeyword).toEqual(['ts/sci']);
    expect(opts.excludePreset).toEqual(['security_clearance']);
  });

  it('compare accepts the same flags', () => {
    const cmd = new CompareCommand({} as any, {} as any);
    const opts = parse(cmd, ['--locations', 'A', 'B', '--exclude-title', 'senior']);
    expect(opts.locations).toEqual(['A', 'B']);
    expect(opts.excludeTitle).toEqual(['senior']);
  });
});

describe('search command — input and output', () => {
  it('maps the flags onto the DTO', async () => {
    const { cmd, jobsService } = makeSearch();
    await cmd.run([], {
      searchTerm: 'engineer',
      location: 'Austin, TX',
      locations: ['New York, NY', 'Chicago, IL'],
      excludeTitle: ['senior'],
      excludeKeyword: ['polygraph'],
      excludePreset: [ExclusionPreset.SECURITY_CLEARANCE],
    } as any);
    const input = jobsService.searchJobs.mock.calls[0][0] as ScraperInputDto;
    expect(input.location).toBe('Austin, TX');
    expect(input.locations).toEqual(['New York, NY', 'Chicago, IL']);
    expect(input.excludeTitleTerms).toEqual(['senior']);
    expect(input.excludeKeywords).toEqual(['polygraph']);
    expect(input.excludePresets).toEqual(['security_clearance']);
  });

  it('a plain search adds none of the new keys', async () => {
    const { cmd, jobsService } = makeSearch();
    await cmd.run([], { searchTerm: 'engineer' } as any);
    const input = jobsService.searchJobs.mock.calls[0][0];
    for (const key of ['locations', 'excludeTitleTerms', 'excludeKeywords', 'excludePresets']) {
      expect(key in input).toBe(false);
    }
  });

  it('filters, keeps stdout pure JSON and reports the count on stderr', async () => {
    const { cmd } = makeSearch([job('1', 'Senior Engineer'), job('2', 'Engineer')]);
    await cmd.run([], { searchTerm: 'engineer', excludeTitle: ['senior'], format: 'json' } as any);

    const written = stdout.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(written);
    expect(parsed.map((j: JobPostDto) => j.id)).toEqual(['2']);
    const messages = stderr.mock.calls.map((c) => String(c[0]));
    expect(messages).toContain('Excluded 1 jobs (by term: senior=1)');
  });

  it('applies exclusions on the --stdin JSON path too', async () => {
    const { cmd } = makeSearch([job('1', 'Senior Engineer'), job('2', 'Engineer')]);
    jest.spyOn(cmd as any, 'readStdin').mockResolvedValue({ searchTerm: 'x', excludeTitleTerms: ['senior'] });
    await cmd.run([], { stdin: true } as any);
    const parsed = JSON.parse(stdout.mock.calls.map((c) => String(c[0])).join(''));
    expect(parsed).toHaveLength(1);
  });

  it('reports ignored terms on stderr', () => {
    const kept = applyCliExclusions(new ScraperInputDto({ excludePresets: ['nope' as ExclusionPreset] }), [job('1', 'A')]);
    expect(kept).toHaveLength(1);
    expect(stderr.mock.calls.map((c) => String(c[0]))).toContain('Ignored exclusion term "nope" (unknown_preset)');
  });

  it('returns the same array when no exclusion field is set', () => {
    const jobs = [job('1', 'A')];
    expect(applyCliExclusions(new ScraperInputDto({}), jobs)).toBe(jobs);
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe('search command — --no-description', () => {
  const ORIGINAL_CSV_HEADER =
    'id,site,title,companyName,location,jobUrl,datePosted,jobType,isRemote,minAmount,maxAmount,' +
    'currency,interval,description,datePostedAt,datePostedPrecision,datePostedBasis';

  function described(id: string): JobPostDto {
    return new JobPostDto({
      id,
      site: 'remotive',
      title: 'Engineer',
      companyName: 'Acme',
      jobUrl: `https://example.com/${id}`,
      description: 'LONG-DESC',
    });
  }

  const written = (): string => stdout.mock.calls.map((c) => String(c[0])).join('');

  it('parses --no-description as false', () => {
    const { cmd } = makeSearch();
    expect(parse(cmd, ['--no-description']).description).toBe(false);
  });

  it('without the flag, description is not false', () => {
    const { cmd } = makeSearch();
    expect(parse(cmd, ['-q', 'engineer']).description).not.toBe(false);
  });

  it('json: drops the description and keeps every other field', async () => {
    const { cmd } = makeSearch([described('1'), described('2')]);
    await cmd.run([], { searchTerm: 'engineer', format: 'json', description: false } as any);

    const out = written();
    expect(out).not.toContain('LONG-DESC');
    const parsed = JSON.parse(out);
    expect(parsed.map((j: JobPostDto) => j.id)).toEqual(['1', '2']);
    expect(parsed.every((j: JobPostDto) => !('description' in j))).toBe(true);
    expect(parsed[0]).toMatchObject({ site: 'remotive', title: 'Engineer', companyName: 'Acme' });
  });

  it('csv: leaves out the description column', async () => {
    const { cmd } = makeSearch([described('1')]);
    await cmd.run([], { searchTerm: 'engineer', format: 'csv', description: false } as any);

    const out = written();
    expect(out).not.toContain('LONG-DESC');
    const [header, row] = out.trimEnd().split('\n');
    expect(header.split(',')).not.toContain('description');
    expect(header).toBe(ORIGINAL_CSV_HEADER.replace(',description,', ','));
    expect(row.split(',')).toHaveLength(header.split(',').length);
  });

  it('applies on the --stdin JSON path too', async () => {
    const { cmd } = makeSearch([described('1')]);
    jest.spyOn(cmd as any, 'readStdin').mockResolvedValue({ searchTerm: 'engineer' });
    await cmd.run([], { stdin: true, description: false } as any);
    expect(written()).not.toContain('LONG-DESC');
  });

  it('still matches --exclude-keyword against the description it omits', async () => {
    const other = new JobPostDto({ id: '2', title: 'Engineer', jobUrl: 'https://example.com/2', description: 'fine' });
    const { cmd } = makeSearch([described('1'), other]);
    await cmd.run([], { searchTerm: 'engineer', excludeKeyword: ['LONG-DESC'], format: 'json', description: false } as any);
    expect(JSON.parse(written()).map((j: JobPostDto) => j.id)).toEqual(['2']);
  });

  it('json without the flag: output is unchanged and keeps the description', async () => {
    const jobs = [described('1')];
    const { cmd } = makeSearch(jobs);
    await cmd.run([], { searchTerm: 'engineer', format: 'json' } as any);
    expect(written()).toBe(JSON.stringify(jobs, null, 2) + '\n');
    expect(written()).toContain('LONG-DESC');
  });

  it('csv without the flag: the description column stays', async () => {
    const { cmd } = makeSearch([described('1')]);
    await cmd.run([], { searchTerm: 'engineer', format: 'csv', description: true } as any);
    const [header, row] = written().trimEnd().split('\n');
    expect(header).toBe(ORIGINAL_CSV_HEADER);
    expect(row).toContain(',LONG-DESC,');
  });
});
