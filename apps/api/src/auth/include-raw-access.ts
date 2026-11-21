import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import {
  INCLUDE_RAW_API_KEYS_ENV_VAR,
  INCLUDE_RAW_ENABLED_ENV_VAR,
  includeRawApiKeys,
} from '../config/include-raw-config';
import { assertAdminApiKey, readApiKey } from './api-key.guard';

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
 *  3. a non-empty `EVER_JOBS_INCLUDE_RAW_API_KEYS` → otherwise 503. Every key
 *     in `API_KEYS` passes the admin check, so this list is what keeps raw
 *     capture away from ordinary key holders once the switch is on;
 *  4. a valid admin key, exactly as for an `@AdminAuth()` route
 *     ({@link assertAdminApiKey}): 503 with no `API_KEYS`, 401 for a missing
 *     or unknown key. (With auth on, the global `ApiKeyGuard` already answers
 *     403 to a missing or unknown key before the handler runs.)
 *  5. that key listed in `EVER_JOBS_INCLUDE_RAW_API_KEYS` → otherwise 403.
 *
 * The search endpoint itself stays public; only a request that asks for
 * `include_raw` goes through this check. The entries that come back are
 * still scrubbed of credentials (`jobs/raw-entry-redaction.ts`).
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

  const rawKeys = includeRawApiKeys(config.get<unknown>('rawCapture.apiKeys', []));
  if (rawKeys.length === 0) {
    logger.error(`include_raw refused: no ${INCLUDE_RAW_API_KEYS_ENV_VAR} configured`);
    throw new ServiceUnavailableException(
      `include_raw requires ${INCLUDE_RAW_API_KEYS_ENV_VAR} to name the API keys that may use it`,
    );
  }

  assertAdminApiKey(config, request, logger, 'include_raw');

  // assertAdminApiKey has already refused a missing key.
  const providedKey = readApiKey(config, request) ?? '';
  if (!keyListIncludes(rawKeys, providedKey)) {
    logger.warn(`include_raw refused: API key not in ${INCLUDE_RAW_API_KEYS_ENV_VAR}`);
    throw new ForbiddenException(
      `This API key may not use include_raw (${INCLUDE_RAW_API_KEYS_ENV_VAR})`,
    );
  }
}

/**
 * Membership test that takes the same time wherever (and whether) the key
 * matches: every entry is compared, as fixed-length SHA-256 digests.
 */
export function keyListIncludes(keys: readonly string[], candidate: string): boolean {
  const wanted = createHash('sha256').update(candidate, 'utf8').digest();
  let found = false;
  for (const key of keys) {
    const digest = createHash('sha256').update(key, 'utf8').digest();
    if (timingSafeEqual(digest, wanted)) found = true;
  }
  return found;
}
