import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, OpenAPIObject } from '@nestjs/swagger';

/**
 * Name of the API key security scheme in the OpenAPI document. Swagger UI's
 * "Authorize" dialog stores the key under this name, and it sends the key only
 * on operations whose security requirement names this scheme, so every
 * `@ApiSecurity(...)` must use this constant (T-2675).
 */
export const API_KEY_SECURITY_SCHEME = 'api-key';

/**
 * The OpenAPI document settings that Swagger UI (`/swg`) and the Scalar API
 * reference (`/docs`) are built from. The key goes in the configured header
 * (`auth.headerName`, `x-api-key` by default).
 */
export function buildOpenApiConfig(
  config: ConfigService,
): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
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
      API_KEY_SECURITY_SCHEME,
    )
    // Without a requirement no operation uses the scheme, and Swagger UI
    // never sends the key entered under "Authorize".
    .addSecurityRequirements(API_KEY_SECURITY_SCHEME)
    .addTag('Jobs', 'Job search and analysis endpoints')
    .addTag('Health', 'Health check and monitoring endpoints')
    .build();
}
