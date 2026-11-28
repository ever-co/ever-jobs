# Security Guidelines

## API Authentication

- Store API keys in environment variables, never in source code
- Use unique keys per client or application
- Rotate keys periodically and revoke compromised keys
- Use `ENABLE_API_KEY_AUTH=true` in production

## Secrets Management

- Use `.env` files for local development (never commit them)
- Use Docker secrets or a vault (HashiCorp Vault, AWS Secrets Manager) in production
- Never log API keys or sensitive parameters

## Dependency Security

- Run `npm audit` regularly to check for vulnerabilities
- Keep dependencies up to date with `npm update`
- Review changelogs before major upgrades

## Per-Request Source Credentials

The API supports passing source-specific credentials (e.g., Upwork OAuth2 tokens) per-request via the `auth` field in `ScraperInputDto`. Keep these guidelines in mind:

- **Always use HTTPS** when sending credentials in request bodies to prevent interception
- **Prefer environment variables** for server deployments to avoid credentials appearing in request logs or network traces
- The API controller does **not** log auth credentials (only search term, sites, and location are logged)
- When a request fails validation (HTTP 400), the global exception filter logs a **redacted** copy of the body, never the raw body: every value under `auth` and under a secret-looking key (`apiKey`, `clientSecret`, `accessToken`, `password`, …) at any depth becomes `[REDACTED]`, everything before the last `@` of a proxy URL (under `proxies`) becomes `***`, `user:password@` in any other string becomes `***@`, and the logged body is cut to about 2 KB (`apps/api/src/filters/log-safe-body.ts`)
- Auth data **is included in cache keys** — this is by design since different credentials may return different results
- Per-request credentials are held in memory only for the duration of the request and are not persisted
- See [Authentication](./AUTHENTICATION.md) for full details on per-request auth

## Network Security

- Deploy behind a reverse proxy (nginx, Caddy) with TLS/HTTPS
- Behind that proxy, set `TRUST_PROXY` to its addresses or CIDRs, so rate limiting sees each client's IP instead of the proxy's. Use a hop count (`1`) only when clients cannot reach the API port except through the proxy, and never `true` on a port clients can reach: with either, a client that connects directly can spoof `X-Forwarded-For` and pick its own rate limit bucket. With API key auth on, a valid key is limited per key
- Leave `EVER_JOBS_ALLOW_CALLER_INSECURE_TLS` unset (T-2880). A request's `caCert` loads no CA: any value turns off upstream TLS certificate checks for that search, including sources that send this server's API keys, so the REST API ignores it and logs a warning. Set it to `true` only on a private deployment whose callers you trust with that choice. The CLI `--ca-cert` flag is not affected
- Restrict `CORS_ORIGINS` to trusted domains in production
- Use firewall rules to limit access to the API port

## Vulnerability Reporting

See [SECURITY.md](../.github/SECURITY.md) for details on how to report vulnerabilities.
