/**
 * T-2673 — with `ENABLE_GRAPHQL` unset (the default) GraphQL stays on.
 *
 * The counterpart of `graphql-disabled.integration.spec.ts`. Since the fix `AppModule` imports
 * `GraphQLModule` only when the flag is on, so this suite boots the REAL `AppModule` with the
 * flag unset and checks that GraphQL is still served at `/graphql`. It is a separate file
 * because `AppModule` makes the decision when its module graph is loaded (see the other file).
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

// The flag must be cleared BEFORE `AppModule` is loaded, so the helper is required here.
const savedFlag = process.env.ENABLE_GRAPHQL;
delete process.env.ENABLE_GRAPHQL;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTestApp } = require('../helpers/create-app') as typeof import('../helpers/create-app');

describe('ENABLE_GRAPHQL unset keeps GraphQL on (T-2673)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    if (savedFlag !== undefined) process.env.ENABLE_GRAPHQL = savedFlag;
  });

  it('serves GraphQL: POST /graphql answers { __typename }', async () => {
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .send({ query: '{ __typename }' })
      .expect(200);
    expect(res.body).toEqual({ data: { __typename: 'Query' } });
  });

  it('serves the REST routes: GET /health is 200', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
