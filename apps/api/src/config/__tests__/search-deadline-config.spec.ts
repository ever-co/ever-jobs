import {
  MAX_TIMER_DELAY_MS,
  SEARCH_DEADLINE_ALLOW_UNBOUNDED_ENV_VAR,
  SEARCH_DEADLINE_MAX_ENV_VAR,
  clampRequestedDeadline,
  defaultDeadlineCap,
  resolveDeadlineAllowUnbounded,
  resolveSearchDeadlineMaxMs,
  sanitizeDeadlineCap,
} from '../search-deadline-config';

/**
 * Spec 5164 `?deadline_ms`, fork-sync hardening: callers can only shorten the
 * operator's fan-out deadline unless the operator allows more, and a broken
 * ceiling fails closed.
 */
describe('search-deadline-config', () => {
  const FANOUT = 120_000;

  describe('resolveSearchDeadlineMaxMs', () => {
    it.each([
      ['unset', {}],
      ['blank', { [SEARCH_DEADLINE_MAX_ENV_VAR]: '' }],
      ['whitespace', { [SEARCH_DEADLINE_MAX_ENV_VAR]: '   ' }],
    ])('%s → the fan-out deadline, with no warning', (_label, env) => {
      const warn = jest.fn();
      expect(resolveSearchDeadlineMaxMs(env, FANOUT, warn)).toBe(FANOUT);
      expect(warn).not.toHaveBeenCalled();
    });

    it('a positive value is the ceiling', () => {
      const warn = jest.fn();
      expect(
        resolveSearchDeadlineMaxMs({ [SEARCH_DEADLINE_MAX_ENV_VAR]: '600000' }, FANOUT, warn),
      ).toBe(600_000);
      expect(
        resolveSearchDeadlineMaxMs({ [SEARCH_DEADLINE_MAX_ENV_VAR]: ' 30000.9 ' }, FANOUT, warn),
      ).toBe(30_000);
      expect(warn).not.toHaveBeenCalled();
    });

    it('is clamped to what setTimeout can hold', () => {
      expect(
        resolveSearchDeadlineMaxMs(
          { [SEARCH_DEADLINE_MAX_ENV_VAR]: '9999999999999' },
          FANOUT,
          jest.fn(),
        ),
      ).toBe(MAX_TIMER_DELAY_MS);
    });

    it.each([
      ['0', '0'],
      ['negative', '-1'],
      ['non-numeric', 'abc'],
      ['below 1 ms', '0.5'],
      ['Infinity', 'Infinity'],
    ])('%s fails closed to the fan-out deadline with a warning', (_label, raw) => {
      const warn = jest.fn();
      expect(
        resolveSearchDeadlineMaxMs({ [SEARCH_DEADLINE_MAX_ENV_VAR]: raw }, FANOUT, warn),
      ).toBe(FANOUT);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(SEARCH_DEADLINE_MAX_ENV_VAR);
    });

    it('a 0 warning points at the explicit opt-in', () => {
      const warn = jest.fn();
      resolveSearchDeadlineMaxMs({ [SEARCH_DEADLINE_MAX_ENV_VAR]: '0' }, FANOUT, warn);
      expect(warn.mock.calls[0][0]).toContain(SEARCH_DEADLINE_ALLOW_UNBOUNDED_ENV_VAR);
    });

    it('no ceiling (0) only when the operator runs without a fan-out deadline', () => {
      expect(resolveSearchDeadlineMaxMs({}, 0, jest.fn())).toBe(0);
      expect(resolveSearchDeadlineMaxMs({}, -1, jest.fn())).toBe(0);
      expect(
        resolveSearchDeadlineMaxMs({ [SEARCH_DEADLINE_MAX_ENV_VAR]: '-5' }, 0, jest.fn()),
      ).toBe(0);
    });
  });

  describe('resolveDeadlineAllowUnbounded', () => {
    it.each(['true', 'TRUE', '1', 'yes', 'on', ' true '])('%s → true', (raw) => {
      expect(
        resolveDeadlineAllowUnbounded({ [SEARCH_DEADLINE_ALLOW_UNBOUNDED_ENV_VAR]: raw }),
      ).toBe(true);
    });

    it.each([undefined, '', 'false', '0', 'no', 'maybe'])('%p → false (default off)', (raw) => {
      expect(
        resolveDeadlineAllowUnbounded({ [SEARCH_DEADLINE_ALLOW_UNBOUNDED_ENV_VAR]: raw }),
      ).toBe(false);
    });
  });

  describe('defaultDeadlineCap / sanitizeDeadlineCap', () => {
    it('the default cap is the fan-out deadline, or none when it is off', () => {
      expect(defaultDeadlineCap(FANOUT)).toBe(FANOUT);
      expect(defaultDeadlineCap(0)).toBe(0);
      expect(defaultDeadlineCap(-10)).toBe(0);
      expect(defaultDeadlineCap(undefined)).toBe(0);
      expect(defaultDeadlineCap(Number.NaN)).toBe(0);
    });

    it('a positive fan-out deadline below 1 ms still caps, at 1 ms (round 3)', () => {
      expect(defaultDeadlineCap(0.5)).toBe(1);
      expect(defaultDeadlineCap(Number.MIN_VALUE)).toBe(1);
      expect(defaultDeadlineCap(1.9)).toBe(1);
      expect(resolveSearchDeadlineMaxMs({}, 0.5, jest.fn())).toBe(1);
      expect(sanitizeDeadlineCap(undefined, 0.5)).toBe(1);
      // With that ceiling neither "no deadline" nor a huge value gets through.
      const policy = { maxMs: resolveSearchDeadlineMaxMs({}, 0.5, jest.fn()), allowUnbounded: false };
      expect(clampRequestedDeadline(0, policy)).toBe(1);
      expect(clampRequestedDeadline(99_999_999, policy)).toBe(1);
    });

    it('keeps a valid configured ceiling', () => {
      expect(sanitizeDeadlineCap(240_000, FANOUT)).toBe(240_000);
    });

    it.each([undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '240000', 0.5])(
      'falls back to the fan-out deadline for %p',
      (configured) => {
        expect(sanitizeDeadlineCap(configured, FANOUT)).toBe(FANOUT);
      },
    );
  });

  describe('clampRequestedDeadline', () => {
    const capped = { maxMs: FANOUT, allowUnbounded: false };

    it('callers can shorten the deadline', () => {
      expect(clampRequestedDeadline(5_000, capped)).toBe(5_000);
      expect(clampRequestedDeadline(FANOUT, capped)).toBe(FANOUT);
    });

    it('a longer value is capped', () => {
      expect(clampRequestedDeadline(FANOUT + 1, capped)).toBe(FANOUT);
      expect(clampRequestedDeadline(3_000_000_000, capped)).toBe(FANOUT);
    });

    it('0 (no deadline) is capped without the opt-in', () => {
      expect(clampRequestedDeadline(0, capped)).toBe(FANOUT);
    });

    it('the opt-in allows 0 and values above the ceiling, within timer range', () => {
      const open = { maxMs: FANOUT, allowUnbounded: true };
      expect(clampRequestedDeadline(0, open)).toBe(0);
      expect(clampRequestedDeadline(600_000, open)).toBe(600_000);
      expect(clampRequestedDeadline(3_000_000_000, open)).toBe(MAX_TIMER_DELAY_MS);
    });

    it('with no ceiling (fan-out deadline off) every value stands, within timer range', () => {
      const none = { maxMs: 0, allowUnbounded: false };
      expect(clampRequestedDeadline(0, none)).toBe(0);
      expect(clampRequestedDeadline(600_000, none)).toBe(600_000);
      expect(clampRequestedDeadline(3_000_000_000, none)).toBe(MAX_TIMER_DELAY_MS);
    });
  });
});
