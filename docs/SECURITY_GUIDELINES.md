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
- Auth data **is included in cache keys** — this is by design since different credentials may return different results
- Per-request credentials are held in memory only for the duration of the request and are not persisted
- See [Authentication](./AUTHENTICATION.md) for full details on per-request auth

## Network Security

- Deploy behind a reverse proxy (nginx, Caddy) with TLS/HTTPS
- Behind that proxy, set `TRUST_PROXY` to its hop count (`1`) or its addresses, so rate limiting sees each client's IP instead of the proxy's; never `true` on a port clients can reach directly (any client could then spoof `X-Forwarded-For`). With API key auth on, a valid key is limited per key
- Restrict `CORS_ORIGINS` to trusted domains in production
- Use firewall rules to limit access to the API port

## Vulnerability Reporting

See [SECURITY.md](../.github/SECURITY.md) for details on how to report vulnerabilities.
