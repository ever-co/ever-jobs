import 'reflect-metadata';
import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TRUST_PROXY_ENV_VAR, resolveTrustProxy } from '../trust-proxy-config';
import configuration from '../configuration';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');

/**
 * T-2521 — `TRUST_PROXY`: opt-in Express `trust proxy`, so `req.ip` (the rate
 * limit tracker for requests without a valid API key) is the client behind a
 * reverse proxy instead of the proxy itself. Unset keeps today's behaviour.
 */
describe('resolveTrustProxy (T-2521)', () => {
  it('names the env var TRUST_PROXY', () => {
    expect(TRUST_PROXY_ENV_VAR).toBe('TRUST_PROXY');
  });

  it('is undefined when unset or blank (today: X-Forwarded-For is ignored)', () => {
    expect(resolveTrustProxy({})).toBeUndefined();
    expect(resolveTrustProxy({ TRUST_PROXY: '' })).toBeUndefined();
    expect(resolveTrustProxy({ TRUST_PROXY: '   ' })).toBeUndefined();
  });

  it('reads true / false in any case', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: 'true' })).toBe(true);
    expect(resolveTrustProxy({ TRUST_PROXY: ' TRUE ' })).toBe(true);
    expect(resolveTrustProxy({ TRUST_PROXY: 'false' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: 'False' })).toBe(false);
  });

  it('reads a whole number as a hop count', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '1' })).toBe(1);
    expect(resolveTrustProxy({ TRUST_PROXY: ' 2 ' })).toBe(2);
    expect(resolveTrustProxy({ TRUST_PROXY: '0' })).toBe(0);
  });

  it('reads anything else as a comma-separated list of addresses, CIDRs or range names', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '10.0.0.1' })).toEqual(['10.0.0.1']);
    expect(
      resolveTrustProxy({ TRUST_PROXY: '10.0.0.0/8, 192.168.1.5 ,fd00::/8' }),
    ).toEqual(['10.0.0.0/8', '192.168.1.5', 'fd00::/8']);
    expect(resolveTrustProxy({ TRUST_PROXY: 'loopback,uniquelocal' })).toEqual([
      'loopback',
      'uniquelocal',
    ]);
  });

  it('is undefined for a list with no entries', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: ' , ,' })).toBeUndefined();
  });
});

describe('configuration() → trustProxy (T-2521)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is undefined when TRUST_PROXY is unset and the parsed value when set', () => {
    delete process.env.TRUST_PROXY;
    expect(configuration().trustProxy).toBeUndefined();

    process.env.TRUST_PROXY = '1';
    expect(configuration().trustProxy).toBe(1);

    process.env.TRUST_PROXY = '10.0.0.0/8,loopback';
    expect(configuration().trustProxy).toEqual(['10.0.0.0/8', 'loopback']);
  });
});

@Controller('ip')
class IpController {
  @Get()
  ip(@Req() req: { ip?: string }): { ip?: string } {
    return { ip: req.ip };
  }
}

/**
 * The parsed value goes to Express exactly as `main.ts` passes it
 * (`app.getHttpAdapter().getInstance().set('trust proxy', value)`). The test
 * client connects over loopback, so loopback is the "proxy" here.
 */
describe('TRUST_PROXY applied to Express: req.ip (T-2521)', () => {
  const CLIENT = '203.0.113.7';

  async function ipSeen(
    trustProxyEnv: string | undefined,
    forwardedFor: string,
  ): Promise<string> {
    const moduleRef = await Test.createTestingModule({
      controllers: [IpController],
    }).compile();
    const app: INestApplication = moduleRef.createNestApplication({
      logger: false,
    });
    const value = resolveTrustProxy({ TRUST_PROXY: trustProxyEnv });
    if (value !== undefined) {
      app.getHttpAdapter().getInstance().set('trust proxy', value);
    }
    await app.init();
    try {
      const res = await request(app.getHttpServer())
        .get('/ip')
        .set('X-Forwarded-For', forwardedFor)
        .expect(200);
      return res.body.ip;
    } finally {
      await app.close();
    }
  }

  it('unset: X-Forwarded-For is ignored, req.ip is the peer', async () => {
    const ip = await ipSeen(undefined, CLIENT);
    expect(ip).not.toBe(CLIENT);
    expect(ip).toMatch(/127\.0\.0\.1|::1/);
  });

  it('a list naming the peer (loopback): req.ip is the forwarded client', async () => {
    await expect(ipSeen('loopback', CLIENT)).resolves.toBe(CLIENT);
  });

  it('a list that does not name the peer: X-Forwarded-For is ignored', async () => {
    await expect(ipSeen('10.0.0.1', CLIENT)).resolves.not.toBe(CLIENT);
  });

  it('hop count 1: req.ip is the entry the trusted proxy appended, not a spoofed one before it', async () => {
    await expect(ipSeen('1', `198.51.100.1, ${CLIENT}`)).resolves.toBe(CLIENT);
  });

  it('true: req.ip is the left-most entry, which any client can spoof', async () => {
    await expect(ipSeen('true', `198.51.100.1, ${CLIENT}`)).resolves.toBe(
      '198.51.100.1',
    );
  });
});
