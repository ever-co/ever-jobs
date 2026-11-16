import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

/** Path label for requests that matched no route (404s from the router). */
const UNMATCHED_ROUTE = 'unmatched';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // GraphQL requests don't have an Express request — skip HTTP metrics
    if (context.getType<string>() === 'graphql') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const { method } = request;

    // Label by the matched route template (e.g. `/api/jobs/:id`), never the
    // raw URL: the URL carries the query string and path parameters, so each
    // distinct request would create a new, never-released series.
    const routePath: unknown = request.route?.path;
    const path =
      typeof routePath === 'string' && routePath.length > 0
        ? routePath
        : UNMATCHED_ROUTE;

    // Skip metrics endpoint itself to avoid noise
    if (path === '/metrics') {
      return next.handle();
    }

    const start = Date.now();
    let recorded = false;

    const record = (statusCode: number | string): void => {
      // A handler may emit several values; count the request only once.
      if (recorded) return;
      recorded = true;
      const duration = (Date.now() - start) / 1000;

      this.metricsService.httpRequestsTotal.inc({
        method,
        path,
        status_code: statusCode,
      });

      this.metricsService.httpRequestDuration.observe(
        { method, path },
        duration,
      );
    };

    return next.handle().pipe(
      tap({
        complete: () => {
          record(context.switchToHttp().getResponse().statusCode);
        },
        error: (err: unknown) => {
          record(err instanceof HttpException ? err.getStatus() : 500);
        },
      }),
    );
  }
}
