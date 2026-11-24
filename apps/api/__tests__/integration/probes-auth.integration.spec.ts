/**
 * Integration — T-2672: the orchestrator probes and the Prometheus scrape
 * under API key auth and rate limiting.
 *
 * Boots the real `AppModule` (both global guards: `ApiKeyGuard` and
 * `GqlThrottlerGuard`) with `ENABLE_API_KEY_AUTH=true`, `API_KEYS=k`,
 * `RATE_LIMIT_ENABLED=true` and `RATE_LIMIT_REQUESTS=2`, and sends real HTTP
 * requests:
 *
 *  - `GET /health`, `/ping` and `/ready` answer 200 every time without a key:
 *    a Docker healthcheck or a Kubernetes probe sends no header and polls
 *    every 10-30 s, so it must neither need the key nor use up the limit.
 *  - `GET /metrics` with the key is never rate limited (a 15 s scrape), and
 *    still needs the key.
 *  - Every `/api` route still needs the key and is still rate limited.
 *
 * The variables are set before `createTestApp()` and restored afterwards, so
 * the rest of the worker's suites see the environment they started with.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../helpers/create-app';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

const KEY = 'k';
const LIMIT = 2;
const TIMES = 5;

const ENV: Readonly<Record<string, string>> = {
  ENABLE_API_KEY_AUTH: 'true',
  API_KEYS: KEY,
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_REQUESTS: String(LIMIT),
};

describe('Probes under API key auth and rate limiting (T-2672)', () => {
  let app: INestApplication;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [name, value] of Object.entries(ENV)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** Status codes of `times` sequential GETs of `path`, with `headers`. */
  async function statusesOf(
    path: string,
    headers: Record<string, string> = {},
    times = TIMES,
  ): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i < times; i++) {
      const res = await request(app.getHttpServer()).get(path).set(headers);
      statuses.push(res.status);
    }
    return statuses;
  }

  it.each(['/health', '/ping', '/ready'])(
    `GET %s answers 200 ${TIMES} times in a row without a key`,
    async (path) => {
      expect(await statusesOf(path)).toEqual(Array(TIMES).fill(200));
    },
  );

  // With the key the API key guard lets the probe through on every build, so
  // this isolates the rate limit: the probe must not use up the limit either.
  it.each(['/health', '/ping', '/ready'])(
    `GET %s with the key answers 200 ${TIMES} times in a row (no 429)`,
    async (path) => {
      expect(await statusesOf(path, { 'x-api-key': KEY })).toEqual(
        Array(TIMES).fill(200),
      );
    },
  );

  it(`GET /metrics with the key answers 200 ${TIMES} times in a row (no 429)`, async () => {
    expect(await statusesOf('/metrics', { 'x-api-key': KEY })).toEqual(
      Array(TIMES).fill(200),
    );
  });

  it('GET /metrics without a key still answers 403', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(403);
  });

  it('POST /api/jobs/search without a key still answers 403', async () => {
    await request(app.getHttpServer())
      .post('/api/jobs/search')
      .send({ searchTerm: 'engineer' })
      .expect(403);
  });

  // Control: the limiter is live in this app, so the /metrics and probe
  // results above are not passing only because rate limiting is off.
  it(`an /api route with the key is still rate limited after ${LIMIT} requests`, async () => {
    expect(
      await statusesOf('/api/sources/health', { 'x-api-key': KEY }, LIMIT + 1),
    ).toEqual([...Array(LIMIT).fill(200), 429]);
  });
});
