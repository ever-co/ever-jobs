import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { recordHttpRequest, resolveRoutePath } from './http-metrics';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // GraphQL requests don't have an Express request — skip HTTP metrics
    if (context.getType<string>() === 'graphql') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();

    // Skip metrics endpoint itself to avoid noise (`recordHttpRequest` also
    // ignores it); the path label is the route template, never the raw URL.
    if (resolveRoutePath(request) === '/metrics') {
      return next.handle();
    }

    const start = Date.now();

    // `recordHttpRequest` counts a request only once, so a handler emitting
    // several values, or an error the exception filter also sees, is not
    // double counted.
    const record = (statusCode: number | string): void =>
      recordHttpRequest(
        this.metricsService,
        request,
        statusCode,
        (Date.now() - start) / 1000,
      );

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
