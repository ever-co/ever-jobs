import { Controller, Get, Logger, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * The Prometheus scrape is not rate limited (`@SkipThrottle()`), so a 15 s
 * scrape interval never gets 429 (T-2672). It still needs the API key when
 * API key auth is on.
 */
@ApiTags('Health')
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);

  constructor(private readonly metricsService: MetricsService) {}

  /**
   * Returns the Prometheus exposition for `/metrics`.
   *
   * **Why `passthrough: true`** (Spec 005 / T06): the previous
   * implementation called `res.end()` directly, which closed the
   * response *before* the global `LoggingInterceptor` ran its
   * `tap.next` callback (which calls `response.setHeader('X-Process-Time', ...)`).
   * Setting headers on a closed response throws "Cannot set headers
   * after they are sent" and turns every `/metrics` scrape into a
   * 500. Switching to `passthrough` lets us still set the dynamic
   * `Content-Type` (prom-client supports both Prometheus text and
   * OpenMetrics formats — the registry knows which) while the
   * framework sends the body after interceptors finish.
   */
  @Get()
  @ApiOperation({
    summary: 'Get Prometheus metrics',
    description:
      'Returns application metrics in Prometheus text format. ' +
      'The exposition includes `ever_jobs_source_circuit_state{site}` ' +
      'when the circuit-breaker bridge is bound (Spec 005 / T06).',
  })
  @ApiResponse({ status: 200, description: 'Prometheus metrics' })
  async getMetrics(
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    res.setHeader('Content-Type', this.metricsService.contentType);
    return this.metricsService.getMetrics();
  }
}
