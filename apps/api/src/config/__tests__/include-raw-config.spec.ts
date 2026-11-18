import {
  DEFAULT_INCLUDE_RAW_MAX_CONCURRENT,
  INCLUDE_RAW_API_KEYS_ENV_VAR,
  INCLUDE_RAW_ENABLED_ENV_VAR,
  INCLUDE_RAW_MAX_CONCURRENT_ENV_VAR,
  MAX_INCLUDE_RAW_MAX_CONCURRENT,
  includeRawApiKeys,
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
      apiKeys: [],
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

  describe('include_raw key list (separate from API_KEYS)', () => {
    const OPERATOR = 'FAKE_OPERATOR_KEY_111111';
    const CONSUMER = 'FAKE_CONSUMER_KEY_222222';

    it('parses a trimmed, de-duplicated list', () => {
      const warn = jest.fn();
      const config = resolveIncludeRawConfig(
        {
          API_KEYS: `${OPERATOR},${CONSUMER}`,
          [INCLUDE_RAW_API_KEYS_ENV_VAR]: ` ${OPERATOR} ,, ${OPERATOR} `,
        },
        warn,
      );
      expect(config.apiKeys).toEqual([OPERATOR]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns (without the key) when on with an empty list', () => {
      const warn = jest.fn();
      const config = resolveIncludeRawConfig(
        { [INCLUDE_RAW_ENABLED_ENV_VAR]: 'true', API_KEYS: CONSUMER },
        warn,
      );
      expect(config.apiKeys).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(INCLUDE_RAW_API_KEYS_ENV_VAR);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(CONSUMER);
    });

    it('warns with a count, never the key, for a listed key missing from API_KEYS', () => {
      const warn = jest.fn();
      resolveIncludeRawConfig(
        { API_KEYS: CONSUMER, [INCLUDE_RAW_API_KEYS_ENV_VAR]: OPERATOR },
        warn,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^1 key\(s\)/);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(OPERATOR);
    });

    it('re-validates the list read back from config', () => {
      expect(includeRawApiKeys([OPERATOR, '', 7, null])).toEqual([OPERATOR]);
      expect(includeRawApiKeys(undefined)).toEqual([]);
      expect(includeRawApiKeys(OPERATOR)).toEqual([]);
    });
  });

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
      delete process.env[INCLUDE_RAW_API_KEYS_ENV_VAR];
      delete process.env.EVER_JOBS_SEARCH_DEADLINE_MAX_MS;
      delete process.env.EVER_JOBS_SEARCH_DEADLINE_ALLOW_UNBOUNDED;
      delete process.env.EVER_JOBS_FANOUT_DEADLINE_MS;
      delete process.env.EVER_JOBS_SEARCH_DEADLINE_MS;
      const config = configuration();
      expect(config.rawCapture).toEqual({
        enabled: false,
        maxConcurrent: DEFAULT_INCLUDE_RAW_MAX_CONCURRENT,
        apiKeys: [],
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

    it('the include_raw key list reaches rawCapture.apiKeys', () => {
      process.env.API_KEYS = 'FAKE_OPERATOR_KEY_111111,FAKE_CONSUMER_KEY_222222';
      process.env[INCLUDE_RAW_API_KEYS_ENV_VAR] = 'FAKE_OPERATOR_KEY_111111';
      expect(configuration().rawCapture.apiKeys).toEqual(['FAKE_OPERATOR_KEY_111111']);
    });
  });
});
