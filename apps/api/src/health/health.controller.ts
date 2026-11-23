import { Controller, Get, Logger, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { ProbeRoute } from '../auth/probe-route.decorator';

/**
 * Liveness probes. They need no API key (`@ProbeRoute()`) and are not rate
 * limited (`@SkipThrottle()`), so a healthcheck polling every 30 s never gets
 * 403 or 429 (T-2672).
 */
@ApiTags('Health')
@SkipThrottle()
@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly startTime = Date.now();

  constructor(private readonly config: ConfigService) {}

  @Get('health')
  @ProbeRoute()
  @ApiOperation({
    summary: 'Health check',
    description:
      'Returns the health status of the API including uptime, version, memory usage.',
  })
  health() {
    const mem = process.memoryUsage();
    return {
      status: 'healthy',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: this.config.get<string>('npm_package_version', '0.1.0'),
      environment: this.config.get<string>('environment', 'development'),
      timestamp: new Date().toISOString(),
      memoryUsage: {
        rss: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
        heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
        heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`,
      },
    };
  }

  @Get('ping')
  @ProbeRoute()
  @ApiOperation({ summary: 'Ping', description: 'Simple ping endpoint for monitoring.' })
  ping() {
    return { status: 'pong', timestamp: new Date().toISOString() };
  }
}
