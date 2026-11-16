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
import { ADMIN_AUTH_METADATA_KEY } from './admin-auth.decorator';
import { getRequestFromContext } from './context-request';

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
 *  - **Admin routes** (decorated with `@AdminAuth()` — e.g. force-open /
 *    force-reset of a circuit breaker):
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
    const headerName: string = this.config.get<string>(
      'auth.headerName',
      'x-api-key',
    );

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

    // Admin route: refuse when keys are not configured. The operator
    // explicitly opted into admin endpoints (the route exists in the
    // build), but the deploy hasn't set `API_KEYS=...`. 503 is
    // operator-fixable; 401 would mislead the caller into trying again.
    if (isAdmin && apiKeys.length === 0) {
      this.logger.error(
        'Admin route invoked but no API_KEYS configured — refusing',
      );
      throw new ServiceUnavailableException(
        'Admin endpoints require API_KEYS to be configured',
      );
    }

    // REST and GraphQL expose the request differently; a missing request is
    // treated as a missing key.
    const request = getRequestFromContext(context);
    const providedKey = request?.headers?.[headerName.toLowerCase()] as
      | string
      | undefined;

    if (!providedKey) {
      this.logger.warn(
        `Missing API key in request${isAdmin ? ' (admin route)' : ''}`,
      );
      if (isAdmin) {
        throw new UnauthorizedException('Missing API Key');
      }
      throw new ForbiddenException('Missing API Key');
    }

    if (!apiKeys.includes(providedKey)) {
      this.logger.warn(
        `Invalid API key provided${isAdmin ? ' (admin route)' : ''}`,
      );
      if (isAdmin) {
        throw new UnauthorizedException('Invalid API Key');
      }
      throw new ForbiddenException('Invalid API Key');
    }

    this.logger.debug('Valid API key provided');
    return true;
  }
}
