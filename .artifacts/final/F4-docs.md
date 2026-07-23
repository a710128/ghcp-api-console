# F4: Scope Fidelity and Operational Documentation

## New Environment Variables Added

### PostgreSQL Configuration
| Variable | Required | Description |
|---|---|---|
| DATABASE_URL | Yes | PostgreSQL connection string (postgres://...) |
| POSTGRES_DB | No | Database name (default: ghcp) |
| POSTGRES_USER | No | Database user (default: ghcp) |
| POSTGRES_PASSWORD | Yes | Database password |
| DB_APPLICATION_NAME | No | Connection application name prefix |
| DB_POOL_SIZE | No | Connection pool size per role |
| DB_STATEMENT_TIMEOUT_MS | No | Statement timeout (ms, default 30000) |
| DB_LOCK_TIMEOUT_MS | No | Lock timeout (ms, default 5000) |
| DATA_ENCRYPTION_KEY | Yes | 32-byte base64 AES key for account credentials |
| LOGIN_JOB_ENCRYPTION_KEY | Yes | 32-byte base64 AES key for login task secrets |

### Service Routing (Traefik)
| Variable | Required | Description |
|---|---|---|
| PROXY_HOST | Yes | Hostname for proxy service routing |
| SSO_HOST | Yes | Hostname for SSO service routing |
| CONSOLE_HOST | Yes | Hostname for console service routing |

## Removed Environment Variables (SQLite era)
- DB_PATH (proxy, sso, login) — removed; use DATABASE_URL instead
- SSO_USER_EVENTS_LOG — removed; events now go to structured stdout
- LOGIN_LOG_DIR — removed; worker logs go to structured stdout
- PROXY_PORT, SSO_PORT, LOGIN_PORT — removed from compose (not published externally)

## Service Roles
| Service | Scale | Description |
|---|---|---|
| postgres | 1 | PostgreSQL 16 shared state backend |
| db-migrate | 1 (one-shot) | Runs Drizzle migrations before services start |
| sso | 1 | SSO/SAML identity service |
| login | 1 | Login task API (accepts requests) |
| login-worker | 1 (FIXED) | Browser automation worker (LOGIN_WORKER_CONCURRENCY=1) |
| proxy | 1-2 | Copilot API proxy (scalable to 2 replicas) |
| console | 1 | Admin console |
| traefik | 1 | Reverse proxy (ports 80/443 only) |
| socket-proxy | 1 | Read-only Docker socket for Traefik |

## Port Exposures
| Port | Service | Description |
|---|---|---|
| 80 | Traefik | HTTP entrypoint |
| 443 | Traefik | HTTPS entrypoint |

All other ports are internal Docker network only (no host publishing).

## Scale Commands
```bash
# Start with 2 proxy replicas (maximum supported)
docker compose up -d --scale proxy=2

# Exactly one login-worker (REQUIRED - do not scale)
docker compose up -d login-worker  # always 1 replica
```

## Volume Loss Acceptance
Volume loss of `postgres-data` is accepted and requires account/token reprovisioning:
- Proxy accounts and credentials must be re-imported or re-initialized
- SSO users, SCIM sync state, and Copilot seat assignments must be recreated
- Login tasks and credentials are lost (workers will re-run when new tasks are created)
- The `console-data` volume (admins.json) is separate and not affected by PostgreSQL volume loss

## TTL Retention
- Budget cache: periods older than previous UTC month are eligible for cleanup
- Login job outbox: delivered rows cleaned up after confirmation
- Apply lease: stale leases (>5 min) can be recovered by another process

## Key Immutability
DATA_ENCRYPTION_KEY and LOGIN_JOB_ENCRYPTION_KEY are IMMUTABLE for a PostgreSQL volume lifecycle.
Changing either key requires reprovisioning from empty state (create new empty DB, run db-migrate).

## No Backup/Restore
No backup or restore subsystem is implemented or deployed. Volume loss requires reprovisioning.

## F4 VERDICT: APPROVE
