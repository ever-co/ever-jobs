import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { ProbeRoute } from '../auth/probe-route.decorator';
import { ShutdownDrainService } from './shutdown-drain.service';

/** Body of `GET /ready` (Spec 1753 FR-2). */
export interface ReadinessResponse {
  status: 'ready' | 'draining';
  /** Requests being served right now, probes excluded. */
  inFlightRequests: number;
  timestamp: string;
}

/**
 * Readiness probe (Spec 1753). `GET /health` stays the liveness probe and
 * keeps answering 200 while the process drains; `GET /ready` answers 503 from
 * the moment a SIGTERM starts the drain, so a load balancer that probes it
 * stops sending this instance new requests.
 *
 * Declared in the root `AppModule` beside {@link ShutdownDrainService}, which
 * must stay there (see that class).
 *
 * Like `/health`, it needs no API key (`@ProbeRoute()`) and is not rate
 * limited (`@SkipThrottle()`), so a probe every 10 s never gets 403 or 429
 * and drops the pod out of the Service (T-2672).
 */
@ApiTags('Health')
@SkipThrottle()
@Controller()
export class ReadinessController {
  constructor(private readonly drain: ShutdownDrainService) {}

  @Get('ready')
  @ProbeRoute()
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Answers 200 while the instance accepts requests and 503 once it is draining for a shutdown ' +
      '(SIGTERM): in-flight searches finish, new requests are refused. Point a readiness probe here; ' +
      'keep the liveness probe on /health, which answers 200 throughout the drain.',
  })
  @ApiResponse({ status: 200, description: 'Ready: accepting requests' })
  @ApiResponse({ status: 503, description: 'Draining for shutdown: send requests elsewhere' })
  ready(@Res({ passthrough: true }) res: Response): ReadinessResponse {
    const draining = this.drain.isDraining();
    res.status(draining ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK);
    return {
      status: draining ? 'draining' : 'ready',
      inFlightRequests: this.drain.inFlightCount(),
      timestamp: new Date().toISOString(),
    };
  }
}
