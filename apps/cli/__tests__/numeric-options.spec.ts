import 'reflect-metadata';
import * as path from 'path';
import { SearchCommand } from '../src/commands/search.command';
import { CompareCommand } from '../src/commands/compare.command';
import {
  applyNumericCliOptions,
  parseCliDecimal,
  parseCliInteger,
  sanitizeNumericOptions,
} from '../src/commands/numeric-options';

/**
 * Numeric CLI flags (`--results`, `--offset`, `--hours-old`, `--distance`,
 * `--timeout`, `--rate-delay-*`, `--linkedin-company-ids`) are parsed strictly
 * and bounded. Before: `parseInt('abc')` gave `NaN`, which `?? 15` kept, so the
 * search ran with `resultsWanted: NaN` and no message; `5x` read as `5`.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OptionMeta } = require('nest-commander/src/constants');
const commanderPath = require.resolve('commander', {
  paths: [path.dirname(require.resolve('nest-commander'))],
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Command: Program, Option: CommanderOption } = require(commanderPath);

/** Parse argv with the real flag grammar, the way nest-commander registers options. */
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

const warnings = (): string[] =>
  stderr.mock.calls.map((c) => String(c[0])).filter((line) => line.startsWith('Warning:'));

describe('parseCliInteger', () => {
  it('reads plain digits, trimmed', () => {
    expect(parseCliInteger('0')).toBe(0);
    expect(parseCliInteger('15')).toBe(15);
    expect(parseCliInteger(' 200 ')).toBe(200);
    expect(parseCliInteger('007')).toBe(7);
  });

  it.each(['abc', '', '  ', '5x', '1e3', '1.5', '-5', '+5', '0x10', 'NaN', 'Infinity'])(
    'returns NaN for %p',
    (text) => {
      expect(parseCliInteger(text)).toBeNaN();
    },
  );
});

describe('parseCliDecimal', () => {
  it('reads plain decimals', () => {
    expect(parseCliDecimal('2')).toBe(2);
    expect(parseCliDecimal('0.5')).toBe(0.5);
    expect(parseCliDecimal('.5')).toBe(0.5);
    expect(parseCliDecimal('1.')).toBe(1);
    expect(parseCliDecimal(' 1.25 ')).toBe(1.25);
  });

  it.each(['abc', '', '1e3', '-1', '1.2.3', '.', '2s'])('returns NaN for %p', (text) => {
    expect(parseCliDecimal(text)).toBeNaN();
  });
});

describe('sanitizeNumericOptions', () => {
  it('keeps valid values and options that were not given, and does not mutate the input', () => {
    const given = { results: 20, offset: 0, hoursOld: 24, distance: 50, timeout: 60, rateDelayMin: 0.5, rateDelayMax: 2, searchTerm: 'dev' };
    const copy = { ...given };
    const { options, warnings: w } = sanitizeNumericOptions(given);
    expect(options).toEqual(copy);
    expect(w).toEqual([]);
    expect(given).toEqual(copy);
  });

  it('keeps values on the bounds', () => {
    const { options, warnings: w } = sanitizeNumericOptions({
      results: 1, offset: 100_000, hoursOld: 0, distance: 0, timeout: 3_600, rateDelayMin: 0,
    });
    expect(w).toEqual([]);
    expect(options).toEqual({ results: 1, offset: 100_000, hoursOld: 0, distance: 0, timeout: 3_600, rateDelayMin: 0 });
  });

  it('drops NaN, out-of-range and non-integer values with one warning per flag', () => {
    const { options, warnings: w } = sanitizeNumericOptions({
      results: Number.NaN,
      offset: 100_001,
      hoursOld: 87_601,
      distance: 1.5,
      timeout: 3_601,
      rateDelayMin: Number.POSITIVE_INFINITY,
      rateDelayMax: -1,
      searchTerm: 'dev',
    });
    expect(options).toEqual({ searchTerm: 'dev' });
    expect(w).toHaveLength(7);
    expect(w[0]).toBe('--results must be a whole number from 1 to 100000; ignoring it');
    expect(w[5]).toBe('--rate-delay-min must be a number from 0 to 3600; ignoring it');
  });

  it('filters invalid LinkedIn company ids and keeps the valid ones', () => {
    const { options, warnings: w } = sanitizeNumericOptions({ linkedinCompanyIds: [123, Number.NaN, 0, 456] });
    expect(options.linkedinCompanyIds).toEqual([123, 456]);
    expect(w).toHaveLength(1);
  });

  it('drops the LinkedIn company id list when no id is valid, keeps a fully valid list silently', () => {
    expect(sanitizeNumericOptions({ linkedinCompanyIds: [Number.NaN] }).options).toEqual({});
    const ok = sanitizeNumericOptions({ linkedinCompanyIds: [1, 2] });
    expect(ok.options.linkedinCompanyIds).toEqual([1, 2]);
    expect(ok.warnings).toEqual([]);
  });
});

describe('applyNumericCliOptions', () => {
  it('prints each warning to stderr and returns the cleaned options', () => {
    const out = applyNumericCliOptions({ results: Number.NaN, offset: 5 });
    expect(out).toEqual({ offset: 5 });
    expect(warnings()).toEqual(['Warning: --results must be a whole number from 1 to 100000; ignoring it']);
  });

  it('prints nothing for valid options', () => {
    applyNumericCliOptions({ results: 10 });
    expect(warnings()).toEqual([]);
  });
});

describe('search command — numeric flags end to end', () => {
  function makeSearch() {
    const jobsService = { searchJobs: jest.fn().mockResolvedValue([]) };
    const analytics = { analyze: jest.fn(), analyzeCompanies: jest.fn().mockReturnValue([]) };
    return { cmd: new SearchCommand(jobsService as any, analytics as any), jobsService };
  }

  it('a non-numeric --results falls back to the default of 15 and warns', async () => {
    const { cmd, jobsService } = makeSearch();
    await cmd.run([], parse(cmd, ['-q', 'engineer', '--results', 'abc']) as any);
    const input = jobsService.searchJobs.mock.calls[0][0];
    expect(input.resultsWanted).toBe(15);
    expect(Number.isNaN(input.resultsWanted)).toBe(false);
    expect(warnings()).toEqual(['Warning: --results must be a whole number from 1 to 100000; ignoring it']);
  });

  it('a trailing-garbage value such as 5x is no longer read as 5', async () => {
    const { cmd, jobsService } = makeSearch();
    await cmd.run([], parse(cmd, ['-q', 'engineer', '-n', '5x']) as any);
    expect(jobsService.searchJobs.mock.calls[0][0].resultsWanted).toBe(15);
    expect(warnings()).toHaveLength(1);
  });

  it('keeps the result of valid numeric flags', async () => {
    const { cmd, jobsService } = makeSearch();
    await cmd.run(
      [],
      parse(cmd, [
        '-q', 'engineer', '-n', '25', '--offset', '10', '--hours-old', '72', '--distance', '30',
        '--timeout', '90', '--rate-delay-min', '0.5', '--rate-delay-max', '2',
        '--linkedin-company-ids', '1234',
      ]) as any,
    );
    const input = jobsService.searchJobs.mock.calls[0][0];
    expect(input.resultsWanted).toBe(25);
    expect(input.offset).toBe(10);
    expect(input.hoursOld).toBe(72);
    expect(input.distance).toBe(30);
    expect(input.requestTimeout).toBe(90);
    expect(input.rateDelayMin).toBe(0.5);
    expect(input.rateDelayMax).toBe(2);
    expect(input.linkedinCompanyIds).toEqual([1234]);
    expect(warnings()).toEqual([]);
  });

  it('an unset optional flag stays unset and the defaults still apply', async () => {
    const { cmd, jobsService } = makeSearch();
    await cmd.run([], parse(cmd, ['-q', 'engineer']) as any);
    const input = jobsService.searchJobs.mock.calls[0][0];
    expect(input.resultsWanted).toBe(15);
    expect(input.offset).toBe(0);
    expect(input.requestTimeout).toBe(60);
    expect(input.hoursOld).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it('--timeout 0 still reaches the input as 0 (no request timeout), without a warning', async () => {
    const { cmd, jobsService } = makeSearch();
    await cmd.run([], parse(cmd, ['-q', 'engineer', '--timeout', '0']) as any);
    expect(jobsService.searchJobs.mock.calls[0][0].requestTimeout).toBe(0);
    expect(warnings()).toEqual([]);
  });

  it('an invalid --hours-old is dropped (no age filter) with a warning, not sent as NaN', async () => {
    const { cmd, jobsService } = makeSearch();
    await cmd.run([], parse(cmd, ['-q', 'engineer', '--hours-old', 'yesterday']) as any);
    expect(jobsService.searchJobs.mock.calls[0][0].hoursOld).toBeUndefined();
    expect(warnings()).toHaveLength(1);
  });
});

describe('compare command — numeric flags', () => {
  it('an invalid --results falls back to 15 and warns before the first site is searched', async () => {
    const jobsService = { searchJobs: jest.fn().mockResolvedValue([]) };
    const analytics = { compareSites: jest.fn().mockReturnValue([]), summarize: jest.fn().mockReturnValue({}) };
    const cmd = new CompareCommand(jobsService as any, analytics as any);
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await cmd.run([], parse(cmd, ['-q', 'engineer', '--results', '-3']) as any);
    } finally {
      stderrWrite.mockRestore();
    }
    const first = jobsService.searchJobs.mock.calls[0][0];
    expect(first.resultsWanted).toBe(15);
    expect(warnings()).toEqual(['Warning: --results must be a whole number from 1 to 100000; ignoring it']);
  });
});
