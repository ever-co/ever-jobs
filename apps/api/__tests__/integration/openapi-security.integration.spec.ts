/**
 * OpenAPI security requirements (T-2675).
 *
 * Swagger UI (`/swg`) sends a key entered under "Authorize" only on
 * operations whose security requirement names the scheme the key was entered
 * for. The document used to register the `api-key` scheme without requiring
 * it anywhere, and the two admin circuit-breaker routes named an `ApiKey`
 * scheme that does not exist, so "Try it out" went out without `x-api-key`
 * (403 on `POST /api/jobs/search` with API key auth on, 401 on the admin
 * routes).
 *
 * This suite boots the real `AppModule` and builds the document exactly as
 * `main.ts` does, with `buildOpenApiConfig`, then checks every operation.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

import { API_KEY_SECURITY_SCHEME, buildOpenApiConfig } from '../../src/openapi';
import { createTestApp } from '../helpers/create-app';

type SecurityRequirements = Array<Record<string, string[]>> | undefined;

interface OperationEntry {
  label: string;
  security: SecurityRequirements;
}

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

function listOperations(document: OpenAPIObject): OperationEntry[] {
  const out: OperationEntry[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      out.push({
        label: `${method.toUpperCase()} ${path}`,
        security: operation.security as SecurityRequirements,
      });
    }
  }
  return out;
}

describe('OpenAPI document security (T-2675)', () => {
  let app: INestApplication;
  let config: ConfigService;
  let document: OpenAPIObject;
  let operations: OperationEntry[];

  beforeAll(async () => {
    app = await createTestApp();
    config = app.get(ConfigService);
    document = SwaggerModule.createDocument(app, buildOpenApiConfig(config));
    operations = listOperations(document);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers the API key scheme for the configured header', () => {
    expect(document.components?.securitySchemes?.[API_KEY_SECURITY_SCHEME]).toEqual(
      expect.objectContaining({
        type: 'apiKey',
        in: 'header',
        name: config.get<string>('auth.headerName', 'x-api-key'),
      }),
    );
  });

  it('requires the API key scheme at document level', () => {
    expect(document.security).toContainEqual({ [API_KEY_SECURITY_SCHEME]: [] });
  });

  it('names only registered schemes in every operation security entry', () => {
    const registered = Object.keys(document.components?.securitySchemes ?? {});
    expect(registered.length).toBeGreaterThan(0);

    const unknown: string[] = [];
    for (const { label, security } of operations) {
      for (const requirement of security ?? []) {
        for (const scheme of Object.keys(requirement)) {
          if (!registered.includes(scheme)) unknown.push(`${label} -> ${scheme}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('makes every operation send the API key that Authorize stores', () => {
    expect(operations.length).toBeGreaterThan(0);

    // An operation without its own `security` inherits the document's.
    const withoutKey = operations
      .filter(({ security }) => {
        const effective = security ?? document.security ?? [];
        return !effective.some((requirement) => API_KEY_SECURITY_SCHEME in requirement);
      })
      .map(({ label }) => label);
    expect(withoutKey).toEqual([]);
  });

  it.each([
    ['POST', '/api/jobs/search'],
    ['POST', '/api/sources/{site}/circuit/open'],
    ['POST', '/api/sources/{site}/circuit/reset'],
  ])('%s %s carries the API key requirement', (method, path) => {
    const entry = operations.find((op) => op.label === `${method} ${path}`);
    expect(entry).toBeDefined();
    const effective = entry?.security ?? document.security ?? [];
    expect(effective).toContainEqual({ [API_KEY_SECURITY_SCHEME]: [] });
  });
});
