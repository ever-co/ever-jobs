import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { getRequestFromContext } from './context-request';

/**
 * `ThrottlerGuard` that also works for GraphQL resolvers.
 *
 * The stock guard reads the request through `switchToHttp()`, which is
 * undefined inside a resolver, so every GraphQL query would throw a
 * `TypeError` once rate limiting is enabled. For GraphQL we take the request
 * from the GraphQL context instead (client IP is then tracked as for REST) and
 * the response from `req.res`. REST behaviour is unchanged.
 */
@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
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
