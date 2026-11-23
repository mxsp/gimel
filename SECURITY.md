# Security Policy

## Reporting a Vulnerability
Please do **not** open public GitHub issues for security vulnerabilities.
Report security issues privately via GitHub Security Advisories at:
https://github.com/mxsp/gimel/security/advisories/new

Include reproduction steps, affected version/commit, and impact if known.

## Production Deployment Defaults
- **Playground mode** (`--mode playground`) is for local evaluation and testing only. Never expose Playground to the public internet.
- **Production mode** (`--mode production` / `GIMEL_ENV=production`) disables `/docs`, `/redoc`, and `/openapi.json`, enforces a 32+ character `GIMEL_SECRET_KEY` and `GIMEL_PORTAL_TOKEN`, and refuses to start against a demo database.
- Place Gimel behind a TLS-terminating reverse proxy (e.g., Caddy or Nginx) with explicit `GIMEL_ALLOWED_HOSTS` before serving over a network.
