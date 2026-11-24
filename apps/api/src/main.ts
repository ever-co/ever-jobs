import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { buildOpenApiConfig } from './openapi';
import { requestContextMiddleware } from './middleware/request-context.middleware';
import { createGlobalValidationPipe } from './pipes/global-validation.pipe';
import { installGracefulShutdown } from './shutdown/graceful-shutdown';
import { TrustProxySetting } from './config/trust-proxy-config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // ── Trusted reverse proxy (T-2521) ─────
  // Opt-in via TRUST_PROXY. Unset, Express ignores X-Forwarded-For and req.ip
  // is the socket peer (behind a proxy: the proxy, for every caller).
  const trustProxy = config.get<TrustProxySetting>('trustProxy');
  if (trustProxy !== undefined) {
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
    logger.log(`Trust proxy: ${JSON.stringify(trustProxy)}`);
    if (trustProxy === true) {
      logger.warn(
        'TRUST_PROXY=true trusts every X-Forwarded-For hop: any client can spoof its IP. Prefer the proxy addresses (a hop count only if clients cannot reach this port directly).',
      );
    }
  }

  // ── Request correlation id ─────────────
  app.use(requestContextMiddleware);

  // ── Global validation pipe ─────────────
  app.useGlobalPipes(createGlobalValidationPipe());

  // ── CORS ───────────────────────────────
  const corsOrigins = config.get<string[]>('cors.origins', ['*']);
  app.enableCors({
    origin: corsOrigins.includes('*') ? '*' : corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      config.get<string>('auth.headerName', 'x-api-key'),
    ],
  });
  logger.log(`CORS enabled for origins: ${corsOrigins.join(', ')}`);

  // ── Graceful shutdown (Spec 1753) ──────
  // SIGTERM fails GET /ready, refuses new requests, waits for in-flight
  // searches (EVER_JOBS_SHUTDOWN_DRAIN_TIMEOUT_MS), then runs the shutdown
  // hooks and exits. After CORS, so a browser can read a refusal (and CORS
  // answers preflights before they reach the drain); before the docs and
  // every route, so a refusal costs nothing more.
  const drain = installGracefulShutdown(app);
  logger.log(
    `Graceful shutdown: SIGTERM drains in-flight requests for up to ${Math.round(drain.drainTimeoutMs / 1000)}s`,
  );

  // ── API Documentation ──────────────────
  const swaggerEnabled = config.get<boolean>('swagger.enabled', true);
  const swaggerPath = config.get<string>('swagger.path', 'swg');
  const scalarEnabled = config.get<boolean>('scalar.enabled', true);
  const scalarPath = config.get<string>('scalar.path', 'docs');

  if (swaggerEnabled || scalarEnabled) {
    const openApiConfig = buildOpenApiConfig(config);

    const document = SwaggerModule.createDocument(app, openApiConfig);

    // ── Swagger UI ───────────────────────
    if (swaggerEnabled) {
      SwaggerModule.setup(swaggerPath, app, document);
      logger.log(`Swagger UI docs: http://localhost:${config.get('port', 3001)}/${swaggerPath}`);
    }

    // ── Scalar API Reference ─────────────
    if (scalarEnabled) {
      app.use(
        `/${scalarPath}`,
        apiReference({ content: document }),
      );
      logger.log(`Scalar API docs: http://localhost:${config.get('port', 3001)}/${scalarPath}`);
    }
  }

  // ── Start ──────────────────────────────
  const port = config.get<number>('port', 3001);
  await app.listen(port);

  const authEnabled = config.get<boolean>('auth.enabled', false);
  const rateLimitEnabled = config.get<boolean>('rateLimit.enabled', false);
  const cacheEnabled = config.get<boolean>('cache.enabled', false);
  const redisUrl = config.get<string>('cache.redisUrl');
  const graphqlEnabled = config.get<boolean>('graphql.enabled', true);
  const graphqlPath = config.get<string>('graphql.path', 'graphql');

  logger.log(`🚀 Ever Jobs API is running on: http://localhost:${port}`);
  logger.log(`🔑 API key auth: ${authEnabled ? 'ENABLED' : 'disabled'}`);
  logger.log(`⏱️  Rate limiting: ${rateLimitEnabled ? 'ENABLED' : 'disabled'}`);
  logger.log(`📦 Caching: ${cacheEnabled ? `ENABLED (${redisUrl ? 'Redis' : 'in-memory'})` : 'disabled'}`);
  logger.log(`🔮 GraphQL: ${graphqlEnabled ? `ENABLED → http://localhost:${port}/${graphqlPath}` : 'disabled'}`);
}

bootstrap();
