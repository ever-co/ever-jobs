import { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';

/**
 * Returns the underlying Express request for either transport.
 *
 * REST handlers expose it through `switchToHttp()`. GraphQL resolvers do not:
 * there `switchToHttp().getRequest()` yields the resolver root (undefined), so
 * the request has to come from the GraphQL context (`{ req }` with the default
 * `@nestjs/apollo` context factory).
 *
 * Returns `undefined` when no request is available so callers can treat it as
 * "no credentials" rather than crashing.
 */
export function getRequestFromContext(
  context: ExecutionContext,
): Request | undefined {
  if (context.getType<string>() === 'graphql') {
    return GqlExecutionContext.create(context).getContext<{ req?: Request }>()
      ?.req;
  }
  return context.switchToHttp().getRequest<Request | undefined>();
}
