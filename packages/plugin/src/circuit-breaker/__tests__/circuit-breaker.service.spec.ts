import { Site, ERR_SOURCE_CIRCUIT_OPEN, DEFAULT_CIRCUIT_POLICY } from '@ever-jobs/models';
import { CircuitBreakerService, markCircuitNeutral } from '../circuit-breaker.service';

/**
 * Spec 005 / T02 — state-machine acceptance:
 *   • closed → 5 fail → open
 *   • open → cooldown elapsed → half-open → success → closed
 *   • half-open → fail → open
 *
 * Plus coverage for the public surface
 * (`state`, `health`, `forceOpen`, `forceReset`, `setPolicy`, `list`).
 */
describe('CircuitBreakerService', () => {
  const SITE = Site.LINKEDIN;

  let service: CircuitBreakerService;
  let now: number;

  /** Inject a deterministic, manually-advanceable clock. */
  beforeEach(() => {
    service = new CircuitBreakerService();
    now = 1_000_000; // arbitrary epoch baseline
    service.setClock(() => now);
  });

  /** Advance the test clock by `ms`. */
  const advance = (ms: number) => {
    now += ms;
  };

  const ok = async () => 'ok';
  const fail = async () => {
    const e = new Error('boom') as Error & { code: string };
    e.code = 'ERR_TEST_BOOM';
    throw e;
  };

  describe('default state', () => {
    it('starts closed for an unseen site', () => {
      expect(service.state(SITE)).toBe('closed');
    });

    it('passes calls through when closed', async () => {
      await expect(service.exec(SITE, ok)).resolves.toBe('ok');
      expect(service.state(SITE)).toBe('closed');
    });

    it('idle health snapshot: successRate=1, p95=0', () => {
      const h = service.health(SITE);
      expect(h.successRate).toBe(1);
      expect(h.p95LatencyMs).toBe(0);
      expect(h.state).toBe('closed');
      expect(h.windowMs).toBe(DEFAULT_CIRCUIT_POLICY.rollingWindowMs);
    });
  });

  describe('closed → open transition', () => {
    it('opens after exactly failureThreshold consecutive failures', async () => {
      for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
        await expect(service.exec(SITE, fail)).rejects.toThrow('boom');
      }
      expect(service.state(SITE)).toBe('open');
    });

    it('does NOT open if a success interrupts the failure streak', async () => {
      await expect(service.exec(SITE, fail)).rejects.toThrow();
      await expect(service.exec(SITE, fail)).rejects.toThrow();
      await expect(service.exec(SITE, ok)).resolves.toBe('ok');
      // 3 more failures should not be enough now (counter reset to 0).
      for (let i = 0; i < 3; i++) {
        await expect(service.exec(SITE, fail)).rejects.toThrow();
      }
      expect(service.state(SITE)).toBe('closed');
    });

    it('short-circuits with ERR_SOURCE_CIRCUIT_OPEN when open', async () => {
      for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
        await expect(service.exec(SITE, fail)).rejects.toThrow();
      }
      const fn = jest.fn(ok);
      await expect(service.exec(SITE, fn)).rejects.toMatchObject({
        code: ERR_SOURCE_CIRCUIT_OPEN,
        site: SITE,
      });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('open → half-open → closed', () => {
    beforeEach(async () => {
      for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
        await expect(service.exec(SITE, fail)).rejects.toThrow();
      }
      expect(service.state(SITE)).toBe('open');
    });

    it('stays open before cooldown elapses', async () => {
      advance(DEFAULT_CIRCUIT_POLICY.cooldownMs - 1);
      await expect(service.exec(SITE, ok)).rejects.toMatchObject({
        code: ERR_SOURCE_CIRCUIT_OPEN,
      });
    });

    it('reports half-open after cooldown elapses (lazy reconciliation)', () => {
      advance(DEFAULT_CIRCUIT_POLICY.cooldownMs);
      expect(service.state(SITE)).toBe('half-open');
    });

    it('closes after a successful probe', async () => {
      advance(DEFAULT_CIRCUIT_POLICY.cooldownMs);
      await expect(service.exec(SITE, ok)).resolves.toBe('ok');
      expect(service.state(SITE)).toBe('closed');
    });
  });

  describe('half-open → open on probe failure', () => {
    it('reopens with a fresh cooldown window', async () => {
      for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
        await expect(service.exec(SITE, fail)).rejects.toThrow();
      }
      const reopenedAt = now;
      advance(DEFAULT_CIRCUIT_POLICY.cooldownMs);
      // First half-open probe fails.
      await expect(service.exec(SITE, fail)).rejects.toThrow('boom');
      expect(service.state(SITE)).toBe('open');

      // The cooldown window should be measured from the new openedAt,
      // not from the original opening.
      advance(1);
      expect(service.state(SITE)).toBe('open');
      advance(DEFAULT_CIRCUIT_POLICY.cooldownMs - 1);
      expect(service.state(SITE)).toBe('half-open');
      // Sanity: total elapsed since first open exceeds 2× cooldown.
      expect(now - reopenedAt).toBeGreaterThanOrEqual(2 * DEFAULT_CIRCUIT_POLICY.cooldownMs);
    });
  });

  describe('forceOpen / forceReset', () => {
    it('forceOpen blocks subsequent calls regardless of prior state', async () => {
      service.forceOpen(SITE);
      await expect(service.exec(SITE, ok)).rejects.toMatchObject({
        code: ERR_SOURCE_CIRCUIT_OPEN,
      });
    });

    it('forceReset returns the breaker to closed and clears stats', async () => {
      service.forceOpen(SITE);
      service.forceReset(SITE);
      expect(service.state(SITE)).toBe('closed');
      const h = service.health(SITE);
      expect(h.successRate).toBe(1);
      expect(h.lastError).toBeUndefined();
      await expect(service.exec(SITE, ok)).resolves.toBe('ok');
    });
  });

  describe('per-site policy override', () => {
    it('honours a tighter failureThreshold', async () => {
      service.setPolicy(SITE, {
        ...DEFAULT_CIRCUIT_POLICY,
        failureThreshold: 2,
      });
      await expect(service.exec(SITE, fail)).rejects.toThrow();
      await expect(service.exec(SITE, fail)).rejects.toThrow();
      expect(service.state(SITE)).toBe('open');
    });

    it('honours a custom cooldown', async () => {
      service.setPolicy(SITE, {
        ...DEFAULT_CIRCUIT_POLICY,
        failureThreshold: 1,
        cooldownMs: 1000,
      });
      await expect(service.exec(SITE, fail)).rejects.toThrow();
      expect(service.state(SITE)).toBe('open');
      advance(999);
      expect(service.state(SITE)).toBe('open');
      advance(1);
      expect(service.state(SITE)).toBe('half-open');
    });
  });

  describe('health snapshot', () => {
    it('records successRate over the rolling window', async () => {
      await service.exec(SITE, ok);
      await service.exec(SITE, ok);
      await expect(service.exec(SITE, fail)).rejects.toThrow();
      const h = service.health(SITE);
      expect(h.successRate).toBeCloseTo(2 / 3, 5);
      expect(h.lastError?.code).toBe('ERR_TEST_BOOM');
    });

    it('drops samples that fall out of the rolling window', async () => {
      service.setPolicy(SITE, {
        ...DEFAULT_CIRCUIT_POLICY,
        rollingWindowMs: 1000,
      });
      await service.exec(SITE, ok);
      await expect(service.exec(SITE, fail)).rejects.toThrow();
      advance(1500);
      await service.exec(SITE, ok);
      const h = service.health(SITE);
      // Only the most-recent success remains in the window.
      expect(h.successRate).toBe(1);
    });

    it('list() returns one snapshot per known site', async () => {
      await service.exec(Site.LINKEDIN, ok);
      await service.exec(Site.INDEED, ok);
      const list = service.list();
      const sites = new Set(list.map((h) => h.site));
      expect(sites).toEqual(new Set([Site.LINKEDIN, Site.INDEED]));
    });
  });

  describe('exhausted half-open probes', () => {
    it('re-arms open with a fresh cooldown when probe quota is spent', async () => {
      service.setPolicy(SITE, {
        ...DEFAULT_CIRCUIT_POLICY,
        failureThreshold: 1,
        halfOpenProbes: 1,
      });
      await expect(service.exec(SITE, fail)).rejects.toThrow();
      expect(service.state(SITE)).toBe('open');
      advance(DEFAULT_CIRCUIT_POLICY.cooldownMs);
      // First probe fails → reopen.
      await expect(service.exec(SITE, fail)).rejects.toThrow('boom');
      expect(service.state(SITE)).toBe('open');
    });

    it('re-arms open with a fresh cooldown when no probe is in flight', async () => {
      service.setPolicy(SITE, {
        ...DEFAULT_CIRCUIT_POLICY,
        failureThreshold: 1,
        halfOpenProbes: 0,
      });
      await expect(service.exec(SITE, fail)).rejects.toThrow();
      advance(DEFAULT_CIRCUIT_POLICY.cooldownMs + 1);
      const fn = jest.fn(ok);
      await expect(service.exec(SITE, fn)).rejects.toMatchObject({
        code: ERR_SOURCE_CIRCUIT_OPEN,
      });
      expect(fn).not.toHaveBeenCalled();
      expect(service.state(SITE)).toBe('open');
      advance(DEFAULT_CIRCUIT_POLICY.cooldownMs - 1);
      expect(service.state(SITE)).toBe('open');
      advance(1);
      expect(service.state(SITE)).toBe('half-open');
    });
  });

  /**
   * T-2547 — while the half-open probe is still running, a concurrent call
   * used to pass the gate (it refused only when no probe was in flight), so
   * every concurrent search hit a recovering site at once.
   */
  describe('concurrent calls while a half-open probe is in flight', () => {
    /** A promise the test settles by hand. */
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    /** Trip the breaker with one failure and advance past the cooldown. */
    const tripAndCoolDown = async (halfOpenProbes: number) => {
      service.setPolicy(SITE, {
        ...DEFAULT_CIRCUIT_POLICY,
        failureThreshold: 1,
        halfOpenProbes,
      });
      await expect(service.exec(SITE, fail)).rejects.toThrow('boom');
      expect(service.state(SITE)).toBe('open');
      advance(DEFAULT_CIRCUIT_POLICY.cooldownMs + 1);
      expect(service.state(SITE)).toBe('half-open');
    };

    it('refuses a concurrent call while the only probe is pending', async () => {
      await tripAndCoolDown(1);
      const a = deferred<string>();
      const fnA = jest.fn(() => a.promise);
      const probeA = service.exec(SITE, fnA);
      expect(fnA).toHaveBeenCalledTimes(1);

      const fnB = jest.fn(ok);
      await expect(service.exec(SITE, fnB)).rejects.toMatchObject({
        code: ERR_SOURCE_CIRCUIT_OPEN,
        site: SITE,
      });
      expect(fnB).not.toHaveBeenCalled();
      // Later concurrent callers are refused too, and the refusals leave the
      // state for the probe to settle.
      const fnC = jest.fn(ok);
      await expect(service.exec(SITE, fnC)).rejects.toMatchObject({
        code: ERR_SOURCE_CIRCUIT_OPEN,
      });
      expect(fnC).not.toHaveBeenCalled();
      expect(service.state(SITE)).toBe('half-open');

      a.resolve('a');
      await expect(probeA).resolves.toBe('a');
    });

    it('closes when the pending probe succeeds, and later calls run', async () => {
      await tripAndCoolDown(1);
      const a = deferred<string>();
      const probeA = service.exec(SITE, () => a.promise);
      const fnB = jest.fn(ok);
      await expect(service.exec(SITE, fnB)).rejects.toMatchObject({
        code: ERR_SOURCE_CIRCUIT_OPEN,
      });
      expect(fnB).not.toHaveBeenCalled();

      a.resolve('a');
      await expect(probeA).resolves.toBe('a');
      expect(service.state(SITE)).toBe('closed');
      const fnC = jest.fn(ok);
      await expect(service.exec(SITE, fnC)).resolves.toBe('ok');
      expect(fnC).toHaveBeenCalledTimes(1);
    });

    it('re-opens with a fresh cooldown when the pending probe fails', async () => {
      await tripAndCoolDown(1);
      const a = deferred<string>();
      const probeA = service.exec(SITE, () => a.promise);
      const fnB = jest.fn(ok);
      await expect(service.exec(SITE, fnB)).rejects.toMatchObject({
        code: ERR_SOURCE_CIRCUIT_OPEN,
      });
      expect(fnB).not.toHaveBeenCalled();

      advance(500);
      a.reject(Object.assign(new Error('probe boom'), { code: 'ERR_TEST_BOOM' }));
      await expect(probeA).rejects.toThrow('probe boom');
      expect(service.state(SITE)).toBe('open');
      advance(DEFAULT_CIRCUIT_POLICY.cooldownMs - 1);
      expect(service.state(SITE)).toBe('open');
      advance(1);
      expect(service.state(SITE)).toBe('half-open');
    });

    it('with halfOpenProbes: 2, two concurrent probes run and the third is refused', async () => {
      await tripAndCoolDown(2);
      const a = deferred<string>();
      const b = deferred<string>();
      const fnA = jest.fn(() => a.promise);
      const fnB = jest.fn(() => b.promise);
      const probeA = service.exec(SITE, fnA);
      const probeB = service.exec(SITE, fnB);
      expect(fnA).toHaveBeenCalledTimes(1);
      expect(fnB).toHaveBeenCalledTimes(1);

      const fnC = jest.fn(ok);
      await expect(service.exec(SITE, fnC)).rejects.toMatchObject({
        code: ERR_SOURCE_CIRCUIT_OPEN,
      });
      expect(fnC).not.toHaveBeenCalled();
      expect(service.state(SITE)).toBe('half-open');

      a.resolve('a');
      b.resolve('b');
      await expect(probeA).resolves.toBe('a');
      await expect(probeB).resolves.toBe('b');
      expect(service.state(SITE)).toBe('closed');
    });

    it('a circuit-neutral probe error still hands its slot back', async () => {
      await tripAndCoolDown(1);
      const a = deferred<string>();
      const probeA = service.exec(SITE, () => a.promise);
      const fnB = jest.fn(ok);
      await expect(service.exec(SITE, fnB)).rejects.toMatchObject({
        code: ERR_SOURCE_CIRCUIT_OPEN,
      });
      expect(fnB).not.toHaveBeenCalled();

      const neutral = markCircuitNeutral(new Error('search deadline'));
      a.reject(neutral);
      await expect(probeA).rejects.toBe(neutral);
      // Nothing recorded: still half-open, and the slot is free again.
      expect(service.state(SITE)).toBe('half-open');
      const fnC = jest.fn(ok);
      await expect(service.exec(SITE, fnC)).resolves.toBe('ok');
      expect(fnC).toHaveBeenCalledTimes(1);
      expect(service.state(SITE)).toBe('closed');
    });
  });
});
