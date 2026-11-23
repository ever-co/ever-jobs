import { SetMetadata } from '@nestjs/common';

/**
 * Reflector key consumed by {@link ApiKeyGuard} to identify orchestrator
 * probes, which answer without an API key (T-2672).
 *
 * Exported so unit tests can stub `Reflector.getAllAndOverride(...)` against
 * it, as they do for `ADMIN_AUTH_METADATA_KEY`.
 */
export const PROBE_ROUTE_METADATA_KEY = 'ever-jobs:probe-route';

/**
 * Marks a route handler (or controller class) as an orchestrator probe: the
 * liveness `GET /health` and `GET /ping`, and the readiness `GET /ready`.
 * A Docker healthcheck or a Kubernetes probe sends no header, so with
 * `ENABLE_API_KEY_AUTH=true` the global `ApiKeyGuard` lets these through
 * without a key instead of answering 403 to every probe.
 *
 * Only the probes carry it: `GET /metrics` and every `/api` route stay
 * behind the key. An `@AdminAuth()` route always needs its key, with or
 * without this decorator.
 *
 * The decorator does not register a guard — `ApiKeyGuard` is the global
 * `APP_GUARD` and reads this metadata via `Reflector.getAllAndOverride()`.
 */
export const ProbeRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PROBE_ROUTE_METADATA_KEY, true);
