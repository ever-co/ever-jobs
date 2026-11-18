import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertIncludeRawAllowed } from '../include-raw-access';

/**
 * `include_raw` access gate (Spec 5161, fork-sync hardening): operator
 * opt-in, API key auth on, and a valid admin key with `@AdminAuth()`
 * semantics. Obvious fake keys only.
 */
describe('assertIncludeRawAllowed', () => {
  const ADMIN_KEY = 'FAKE_ADMIN_KEY_123456';

  const allowed = {
    'rawCapture.enabled': true,
    'auth.enabled': true,
    'auth.apiKeys': [ADMIN_KEY],
    'auth.headerName': 'x-api-key',
  };

  function makeConfig(values: Record<string, unknown>): ConfigService {
    return {
      get: <T>(key: string, fallback?: T): T =>
        (key in values ? values[key] : fallback) as T,
    } as unknown as ConfigService;
  }

  const logger = {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
  } as unknown as Logger;

  const request = (headers: Record<string, string> = { 'x-api-key': ADMIN_KEY }) =>
    ({ headers }) as never;

  it('passes with the flag on, auth on and an admin key', () => {
    expect(() => assertIncludeRawAllowed(makeConfig(allowed), request(), logger)).not.toThrow();
  });

  it('403 while the operator flag is off, whatever the key', () => {
    const config = makeConfig({ ...allowed, 'rawCapture.enabled': false });
    expect(() => assertIncludeRawAllowed(config, request(), logger)).toThrow(ForbiddenException);
  });

  it('403 while the operator flag is unset (default off)', () => {
    const unset = makeConfig({
      'auth.enabled': true,
      'auth.apiKeys': [ADMIN_KEY],
      'auth.headerName': 'x-api-key',
    });
    expect(() => assertIncludeRawAllowed(unset, request(), logger)).toThrow(
      ForbiddenException,
    );
  });

  it('a truthy non-boolean flag does not count as on', () => {
    const config = makeConfig({ ...allowed, 'rawCapture.enabled': 'true' });
    expect(() => assertIncludeRawAllowed(config, request(), logger)).toThrow(ForbiddenException);
  });

  it('503 while API key auth is off, even with a valid key', () => {
    const config = makeConfig({ ...allowed, 'auth.enabled': false });
    expect(() => assertIncludeRawAllowed(config, request(), logger)).toThrow(
      ServiceUnavailableException,
    );
  });

  it('503 when no API keys are configured', () => {
    const config = makeConfig({ ...allowed, 'auth.apiKeys': [] });
    expect(() => assertIncludeRawAllowed(config, request(), logger)).toThrow(
      ServiceUnavailableException,
    );
  });

  it('401 for a missing key or no request', () => {
    const config = makeConfig(allowed);
    expect(() => assertIncludeRawAllowed(config, request({}), logger)).toThrow(
      UnauthorizedException,
    );
    expect(() => assertIncludeRawAllowed(config, undefined, logger)).toThrow(
      UnauthorizedException,
    );
  });

  it('401 for a key that is not an admin key', () => {
    const config = makeConfig(allowed);
    expect(() =>
      assertIncludeRawAllowed(config, request({ 'x-api-key': 'FAKE_OTHER_KEY_654321' }), logger),
    ).toThrow(UnauthorizedException);
  });

  it('honours a custom header name', () => {
    const config = makeConfig({ ...allowed, 'auth.headerName': 'X-Ever-Key' });
    expect(() =>
      assertIncludeRawAllowed(config, request({ 'x-ever-key': ADMIN_KEY }), logger),
    ).not.toThrow();
    expect(() => assertIncludeRawAllowed(config, request(), logger)).toThrow(
      UnauthorizedException,
    );
  });

  it('never logs the key it was given', () => {
    const warn = jest.fn();
    const quiet = { ...logger, warn, error: jest.fn() } as unknown as Logger;
    expect(() =>
      assertIncludeRawAllowed(
        makeConfig(allowed),
        request({ 'x-api-key': 'FAKE_LEAKY_KEY_999999' }),
        quiet,
      ),
    ).toThrow(UnauthorizedException);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('FAKE_LEAKY_KEY_999999');
  });
});
