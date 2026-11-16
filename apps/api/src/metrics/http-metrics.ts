import type { MetricsService } from './metrics.service';

/** Path label for requests that matched no route (404s from the router). */
export const UNMATCHED_ROUTE = 'unmatched';

/** Route template of the metrics endpoint, which is never recorded. */
const METRICS_ROUTE = '/metrics';

/**
 * Requests already counted. Two places can see the same request: the
 * `MetricsInterceptor` (handler success or failure) and the global exception
 * filter (everything that ends in an error response, including guard
 * rejections such as 401 / 429, which never reach an interceptor). Whichever
 * runs first records it; the other is a no-op.
 */
const recordedRequests = new WeakSet<object>();

/**
 * The label for the matched route template (e.g. `/api/jobs/:id`), or
 * {@link UNMATCHED_ROUTE}. Never the raw URL: that carries the query string
 * and path parameters, so each distinct request would create a new series
 * that lives as long as the process.
 */
export function resolveRoutePath(request: {
  route?: { path?: unknown };
}): string {
  const routePath = request?.route?.path;
  return typeof routePath === 'string' && routePath.length > 0
    ? routePath
    : UNMATCHED_ROUTE;
}

/**
 * Count one HTTP request, once. `durationSeconds` is omitted when the start
 * time is unknown (a request rejected before the interceptor ran); the
 * counter is still incremented.
 */
export function recordHttpRequest(
  metrics: MetricsService,
  request: { method?: string; route?: { path?: unknown } },
  statusCode: number | string,
  durationSeconds?: number,
): void {
  if (!request || recordedRequests.has(request)) return;

  const path = resolveRoutePath(request);
  if (path === METRICS_ROUTE) return;

  recordedRequests.add(request);
  const method = request.method ?? 'UNKNOWN';

  metrics.httpRequestsTotal.inc({ method, path, status_code: statusCode });
  if (durationSeconds !== undefined) {
    metrics.httpRequestDuration.observe({ method, path }, durationSeconds);
  }
}
