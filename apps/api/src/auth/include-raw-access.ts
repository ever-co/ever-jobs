import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { INCLUDE_RAW_ENABLED_ENV_VAR } from '../config/include-raw-config';
import { assertAdminApiKey } from './api-key.guard';

/**
 * Access rule for `POST /api/jobs/search?include_raw=true` (Spec 5161),
 * added during the MakeDeeply fork-sync hardening.
 *
 * Raw capture returns upstream request and response data that the server
 * fetched with ITS identity and, for keyed sources, ITS credentials. So it is
 * an operator tool, not an API-consumer feature. A request needs ALL of:
 *
 *  1. the operator opt-in `EVER_JOBS_INCLUDE_RAW_ENABLED=true` (default off)
 *     → otherwise 403;
 *  2. API key auth switched on (`ENABLE_API_KEY_AUTH=true`) → otherwise 503,
 *     the same operator-fixable answer as an admin route with no `API_KEYS`;
 *  3. a valid admin key, exactly as for an `@AdminAuth()` route
 *     ({@link assertAdminApiKey}): 503 with no `API_KEYS`, 401 for a missing
 *     or unknown key. (With auth on, the global `ApiKeyGuard` already answers
 *     403 to a missing or unknown key before the handler runs.)
 *
 * The search endpoint itself stays public; only a request that asks for
 * `include_raw` goes through this check.
 */
export function assertIncludeRawAllowed(
  config: ConfigService,
  request: Request | undefined,
  logger: Logger,
): void {
  if (config.get<boolean>('rawCapture.enabled', false) !== true) {
    logger.warn(`include_raw refused: disabled on this server (${INCLUDE_RAW_ENABLED_ENV_VAR})`);
    throw new ForbiddenException(
      `include_raw is disabled on this server (${INCLUDE_RAW_ENABLED_ENV_VAR})`,
    );
  }

  if (config.get<boolean>('auth.enabled', false) !== true) {
    logger.error('include_raw refused: API key auth is off (ENABLE_API_KEY_AUTH=false)');
    throw new ServiceUnavailableException(
      'include_raw requires API key auth: set ENABLE_API_KEY_AUTH=true and API_KEYS',
    );
  }

  assertAdminApiKey(config, request, logger, 'include_raw');
}
