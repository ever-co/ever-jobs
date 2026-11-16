import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
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
        'TRUST_PROXY=true trusts every X-Forwarded-For hop: any client can spoof its IP. Prefer a hop count or the proxy addresses.',
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
    const openApiConfig = new DocumentBuilder()
      .setTitle('Ever Jobs API')
      .setDescription(
        `# Ever Jobs API

Multi-source job scraping API. Aggregates job listings from 160+ sources including LinkedIn, Indeed, Glassdoor, ZipRecruiter, and 150+ more job boards, ATS platforms, and company career pages.\n\n## GraphQL\n\nA GraphQL API is available at \`/graphql\` alongside this REST API.

## Authentication

When API key authentication is enabled, include your key in the \`x-api-key\` header.

## Rate Limiting

Requests are limited per API key when API key authentication is enabled and the key is valid, otherwise per client IP address. Default: 100 requests per hour.

## Caching

Results are cached (when enabled) to improve performance and reduce load on job board sites.`,
      )
      .setVersion('0.1.0')
      .addApiKey(
        {
          type: 'apiKey',
          name: config.get<string>('auth.headerName', 'x-api-key'),
          in: 'header',
          description: 'API key for authentication',
        },
        'api-key',
      )
      .addTag('Jobs', 'Job search and analysis endpoints')
      .addTag('Health', 'Health check and monitoring endpoints')
      .build();

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
