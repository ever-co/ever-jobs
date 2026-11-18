import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ADMIN_AUTH_METADATA_KEY } from './admin-auth.decorator';
import { getRequestFromContext } from './context-request';
import { PROBE_ROUTE_METADATA_KEY } from './probe-route.decorator';

/**
 * The API key a request carries in the configured header (`x-api-key` by
 * default), or `undefined` when there is none or no request at all.
 */
export function readApiKey(
  config: ConfigService,
  request: Request | undefined,
): string | undefined {
  const headerName: string = config.get<string>('auth.headerName', 'x-api-key');
  return request?.headers?.[headerName.toLowerCase()] as string | undefined;
}

/**
 * The admin-tier check (Spec 005 / FR-7), shared by {@link ApiKeyGuard} for
 * `@AdminAuth()` routes and by per-request admin gates such as `include_raw`
 * (see `include-raw-access.ts`), so both answer the same way:
 *
 *  - no `API_KEYS` configured → 503 Service Unavailable (admin is disabled
 *    by misconfiguration; an operator must set `API_KEYS=...`);
 *  - missing key → 401 Unauthorized;
 *  - a key that is not in `API_KEYS` → 401 Unauthorized.
 *
 * Deliberately independent of `auth.enabled`, exactly like `@AdminAuth()`.
 * `what` names the protected feature in the log lines.
 */
export function assertAdminApiKey(
  config: ConfigService,
  request: Request | undefined,
  logger: Logger,
  what = 'Admin route',
): void {
  const apiKeys: string[] = config.get<string[]>('auth.apiKeys', []);

  // The operator explicitly opted into admin endpoints (the route exists in
  // the build), but the deploy hasn't set `API_KEYS=...`. 503 is
  // operator-fixable; 401 would mislead the caller into trying again.
  if (apiKeys.length === 0) {
    logger.error(`${what} invoked but no API_KEYS configured — refusing`);
    throw new ServiceUnavailableException(
      'Admin endpoints require API_KEYS to be configured',
    );
  }

  const providedKey = readApiKey(config, request);
  if (!providedKey) {
    logger.warn(`Missing API key in request (${what.toLowerCase()})`);
    throw new UnauthorizedException('Missing API Key');
  }

  if (!apiKeys.includes(providedKey)) {
    logger.warn(`Invalid API key provided (${what.toLowerCase()})`);
    throw new UnauthorizedException('Invalid API Key');
  }
}

/**
 * Guard that validates the `x-api-key` header against a configured allow-list.
 *
 * Two tiers, dispatched by `Reflector` metadata (Spec 005 / T07 / Q-017):
 *
 *  - **Standard routes** (no `@AdminAuth()` decorator):
 *      - `auth.enabled=false` or `apiKeys=[]` → allow all (unchanged
 *        legacy behaviour for the read-mostly API).
 *      - Otherwise require a valid key; throw `ForbiddenException` (403)
 *        on missing/invalid.
 *
 *  - **Probe routes** (decorated with `@ProbeRoute()` — `GET /health`,
 *    `GET /ping`, `GET /ready`; T-2672): allowed without a key, because a
 *    Docker healthcheck or a Kubernetes probe sends none. `GET /metrics` and
 *    every `/api` route are standard routes. `@AdminAuth()` wins over
 *    `@ProbeRoute()`.
 *
 *  - **Admin routes** (decorated with `@AdminAuth()` — e.g. force-open /
 *    force-reset of a circuit breaker): {@link assertAdminApiKey}.
 *      - Always require a valid key, regardless of `auth.enabled`.
 *      - If no API keys are configured at all, return 503 Service
 *        Unavailable — admin is disabled by misconfiguration; an
 *        operator must set `API_KEYS=...` before mutating breaker state.
 *      - Throw `UnauthorizedException` (401) on missing/invalid key
 *        (matches T07 acceptance: "Force-open succeeds with valid API
 *        key; 401 otherwise").
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const apiKeys: string[] = this.config.get<string[]>('auth.apiKeys', []);

    const isAdmin =
      this.reflector.getAllAndOverride<boolean>(ADMIN_AUTH_METADATA_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;

    const enabled: boolean = this.config.get<boolean>('auth.enabled', false);

    // Standard route fast-path: skip when auth disabled or no keys configured
    if (!isAdmin && (!enabled || apiKeys.length === 0)) {
      this.logger.debug(
        'API key validation skipped — auth disabled or no keys configured',
      );
      return true;
    }

    // REST and GraphQL expose the request differently; a missing request is
    // treated as a missing key.
    if (isAdmin) {
      assertAdminApiKey(this.config, getRequestFromContext(context), this.logger);
      this.logger.debug('Valid API key provided');
      return true;
    }

    // Orchestrator probes answer without a key (T-2672).
    const isProbe =
      this.reflector.getAllAndOverride<boolean>(PROBE_ROUTE_METADATA_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    if (isProbe) {
      return true;
    }

    const providedKey = readApiKey(this.config, getRequestFromContext(context));

    if (!providedKey) {
      this.logger.warn('Missing API key in request');
      throw new ForbiddenException('Missing API Key');
    }

    if (!apiKeys.includes(providedKey)) {
      this.logger.warn('Invalid API key provided');
      throw new ForbiddenException('Invalid API Key');
    }

    this.logger.debug('Valid API key provided');
    return true;
  }
}
