/**
 * T-2673 — `ENABLE_GRAPHQL=false` turns GraphQL off instead of crashing the API at boot.
 *
 * Before the fix `AppModule` always imported `GraphQLModule`; the flag only switched
 * `autoSchemaFile` off. With no schema file, no `typeDefs` and no `schema`, the Apollo driver
 * called `new ApolloServer(...)` with no schema, which throws "Query root type must be
 * provided." from `GraphQLModule.onModuleInit`. `app.init()` rejected, so the REST routes
 * never came up either.
 *
 * Now `AppModule` imports `GraphQLModule` only when the flag is on. This suite boots the REAL
 * `AppModule` with the flag off through the shared `createTestApp()` helper (the one the e2e
 * suites use). `graphql-enabled.integration.spec.ts` boots it with the flag unset. They are two
 * files because `AppModule` makes the decision when its module graph is loaded, and
 * `@nestjs/graphql` keeps its type metadata on `global`; Jest gives each file a fresh module
 * registry and fresh globals.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

// The flag must be set BEFORE `AppModule` is loaded, so the helper is required here, not imported.
const savedFlag = process.env.ENABLE_GRAPHQL;
process.env.ENABLE_GRAPHQL = 'false';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTestApp } = require('../helpers/create-app') as typeof import('../helpers/create-app');

describe('ENABLE_GRAPHQL=false turns GraphQL off (T-2673)', () => {
  let app: INestApplication | undefined;
  let bootError: unknown;

  beforeAll(async () => {
    try {
      app = await createTestApp();
    } catch (err) {
      bootError = err;
    }
  });

  afterAll(async () => {
    await app?.close();
    if (savedFlag === undefined) delete process.env.ENABLE_GRAPHQL;
    else process.env.ENABLE_GRAPHQL = savedFlag;
  });

  it('boots: createTestApp() resolves', () => {
    // develop: rejects with "Query root type must be provided." (GraphQLModule.onModuleInit).
    expect(bootError).toBeUndefined();
    expect(app).toBeDefined();
  });

  it('serves the REST routes: GET /health is 200', async () => {
    expect(app).toBeDefined();
    const res = await request(app!.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('healthy');
  });

  it('does not serve GraphQL: POST /graphql is 404', async () => {
    expect(app).toBeDefined();
    await request(app!.getHttpServer())
      .post('/graphql')
      .send({ query: '{ __typename }' })
      .expect(404);
  });
});
