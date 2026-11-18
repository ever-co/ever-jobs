import {
  DEFAULT_INCLUDE_RAW_MAX_CONCURRENT,
  INCLUDE_RAW_ENABLED_ENV_VAR,
  INCLUDE_RAW_MAX_CONCURRENT_ENV_VAR,
  MAX_INCLUDE_RAW_MAX_CONCURRENT,
  includeRawMaxConcurrent,
  resolveIncludeRawConfig,
} from '../include-raw-config';
import configuration from '../configuration';

/** `include_raw` operator switch and capture concurrency (fork-sync hardening). */
describe('include-raw-config', () => {
  it('is off by default, with the default concurrency', () => {
    expect(resolveIncludeRawConfig({}, jest.fn())).toEqual({
      enabled: false,
      maxConcurrent: DEFAULT_INCLUDE_RAW_MAX_CONCURRENT,
    });
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on', ' true '])('%s turns it on', (raw) => {
    expect(
      resolveIncludeRawConfig({ [INCLUDE_RAW_ENABLED_ENV_VAR]: raw }, jest.fn()).enabled,
    ).toBe(true);
  });

  it.each(['', 'false', '0', 'no', 'off', 'enabled'])('%p keeps it off', (raw) => {
    expect(
      resolveIncludeRawConfig({ [INCLUDE_RAW_ENABLED_ENV_VAR]: raw }, jest.fn()).enabled,
    ).toBe(false);
  });

  it('reads the concurrency limit, capped at the maximum', () => {
    const warn = jest.fn();
    expect(
      resolveIncludeRawConfig({ [INCLUDE_RAW_MAX_CONCURRENT_ENV_VAR]: '4' }, warn).maxConcurrent,
    ).toBe(4);
    expect(
      resolveIncludeRawConfig({ [INCLUDE_RAW_MAX_CONCURRENT_ENV_VAR]: '1000' }, warn)
        .maxConcurrent,
    ).toBe(MAX_INCLUDE_RAW_MAX_CONCURRENT);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', 'abc'])(
    'an invalid limit %p falls back to the default with a warning',
    (raw) => {
      const warn = jest.fn();
      expect(
        resolveIncludeRawConfig({ [INCLUDE_RAW_MAX_CONCURRENT_ENV_VAR]: raw }, warn).maxConcurrent,
      ).toBe(DEFAULT_INCLUDE_RAW_MAX_CONCURRENT);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it('re-validates the limit read back from config', () => {
    expect(includeRawMaxConcurrent(3)).toBe(3);
    expect(includeRawMaxConcurrent(undefined)).toBe(DEFAULT_INCLUDE_RAW_MAX_CONCURRENT);
    expect(includeRawMaxConcurrent(0)).toBe(DEFAULT_INCLUDE_RAW_MAX_CONCURRENT);
    expect(includeRawMaxConcurrent('2')).toBe(DEFAULT_INCLUDE_RAW_MAX_CONCURRENT);
  });

  describe('configuration()', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    it('exposes rawCapture off and the deadline ceiling at the fan-out deadline by default', () => {
      delete process.env[INCLUDE_RAW_ENABLED_ENV_VAR];
      delete process.env[INCLUDE_RAW_MAX_CONCURRENT_ENV_VAR];
      delete process.env.EVER_JOBS_SEARCH_DEADLINE_MAX_MS;
      delete process.env.EVER_JOBS_SEARCH_DEADLINE_ALLOW_UNBOUNDED;
      delete process.env.EVER_JOBS_FANOUT_DEADLINE_MS;
      delete process.env.EVER_JOBS_SEARCH_DEADLINE_MS;
      const config = configuration();
      expect(config.rawCapture).toEqual({
        enabled: false,
        maxConcurrent: DEFAULT_INCLUDE_RAW_MAX_CONCURRENT,
      });
      expect(config.search.deadlineMs).toBe(120_000);
      expect(config.search.deadlineMaxMs).toBe(120_000);
      expect(config.search.deadlineAllowUnbounded).toBe(false);
    });

    it('a negative deadline max fails closed to the fan-out deadline', () => {
      process.env.EVER_JOBS_FANOUT_DEADLINE_MS = '90000';
      process.env.EVER_JOBS_SEARCH_DEADLINE_MAX_MS = '-1';
      expect(configuration().search.deadlineMaxMs).toBe(90_000);
    });

    it('the operator switch reaches rawCapture.enabled', () => {
      process.env[INCLUDE_RAW_ENABLED_ENV_VAR] = 'true';
      expect(configuration().rawCapture.enabled).toBe(true);
    });
  });
});
