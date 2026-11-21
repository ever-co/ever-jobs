import { createHash } from 'crypto';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { getRequestFromContext } from './context-request';

/**
 * `ThrottlerGuard` that also works for GraphQL resolvers.
 *
 * The stock guard reads the request through `switchToHttp()`, which is
 * undefined inside a resolver, so every GraphQL query would throw a
 * `TypeError` once rate limiting is enabled. For GraphQL we take the request
 * from the GraphQL context instead and the response from `req.res`. REST
 * behaviour is unchanged.
 *
 * Tracking (T-2521): with API key auth on (`auth.enabled`), a request whose
 * `auth.headerName` header holds a key listed in `auth.apiKeys` is counted per
 * key (`key:<sha256 of the key>`, never the raw key), so callers behind one
 * reverse proxy do not share a bucket. Every other request, including one with
 * a missing or unknown key, is counted per client IP (`req.ip`; see
 * `TRUST_PROXY`), so rotating made-up keys buys no extra budget.
 */
@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: ConfigService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    if (this.config.get<boolean>('auth.enabled', false)) {
      const apiKeys = this.config.get<string[]>('auth.apiKeys', []);
      const headerName = this.config.get<string>('auth.headerName', 'x-api-key');
      const key = req.headers?.[headerName.toLowerCase()];
      if (typeof key === 'string' && apiKeys.includes(key)) {
        return `key:${createHash('sha256').update(key).digest('hex')}`;
      }
    }
    return req.ip;
  }

  protected getRequestResponse(context: ExecutionContext): {
    req: Record<string, any>;
    res: Record<string, any>;
  } {
    if (context.getType<string>() !== 'graphql') {
      return super.getRequestResponse(context);
    }
    const req = (getRequestFromContext(context) ?? {}) as Record<string, any>;
    // The throttler only calls `res.header(...)`; fall back to a no-op if the
    // GraphQL context does not carry a response object.
    const res = (req.res ?? { header: () => undefined }) as Record<string, any>;
    return { req, res };
  }
}
