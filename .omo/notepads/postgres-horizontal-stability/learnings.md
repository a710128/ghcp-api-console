# Learnings — postgres-horizontal-stability

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-07-22] Task 1: @ghcp/database package established
- Used `pg` (not postgres.js) for pool management via `import * as pg from 'pg'` (no default export)
- pg-boss is peerDependency (optional) — not a direct dep of @ghcp/database
- cluster_metadata table holds SHA-256 fingerprints for DATA_ENCRYPTION_KEY and LOGIN_JOB_ENCRYPTION_KEY
- Pool roles: general, coordination (250ms connectionTimeoutMillis, max 4), pgboss
- Coordination pool uses connectionTimeoutMillis=250 for fast-fail behavior
- Migrations tracked in _drizzle_migrations table (manual SQL migration tracking, not drizzle-kit runtime)
- CLI migrate.ts does NOT import dotenv (env vars must be set externally in prod)
- docker-compose.test.yml exposes postgres-test on port 5433 (separate from prod port 5432)
- tsconfig.json path: "../../../tsconfig.base.json" (3 levels up from src/packages/database/)
- npm workspaces glob "src/packages/*" auto-includes @ghcp/database — no need to add explicit entry
- bun is the package manager (npm not available); bun install works for workspace installs
- tsx execution: `node --import /path/to/tsx/dist/esm/index.cjs` works when tsx CLI fails with bun CJS issues
- Key fingerprint mismatch produces clear actionable error message and exit code 1

## [2026-07-22] Task 2: PostgreSQL schemas and migrations
- Three schemas: proxy, sso, login (plus cluster_metadata in public schema from Task 1)
- Encrypted columns use _cipher + _nonce suffix pairs (AES-256-GCM)
- proxy.accounts has credential_version (BIGINT) for login result fencing
- sso.users has credential_source ('generated_default'|'operator_managed') — only generated_default can auto-enqueue
- sso.emu_import_plan_rows: password_for_login column REMOVED (was in SQLite, not in PostgreSQL per plan spec)
- sso.scim_rate_limits: singleton row inserted in migration (idempotent ON CONFLICT DO NOTHING)
- login.tasks: task_generation (BIGINT), current_attempt_token (TEXT), result_pending (BOOLEAN)
- login.task_secrets, job_outbox, result_outbox: FK CASCADE DELETE from login.tasks
- login.job_outbox has UNIQUE constraint on pg_boss_key
- All schema type definitions in src/schema/{proxy,sso,login}.ts for TypeScript type safety
- Migration is idempotent: IF NOT EXISTS + ON CONFLICT clauses

## [2026-07-22] Task 3: Proxy account repositories ported to PostgreSQL
- All accountsRepo functions are now async (return Promise) - required updating all callers
- crypto.ts: AES-256-GCM with canonical AAD (identity + credentialType + version) for both gh_token and copilot_token
- pool.ts: uses getDatabaseConfig/createPool/validateClusterKeys from @ghcp/database — never imports pg directly
- Pool type exported from @ghcp/database as `export type { Pool } from 'pg'`
- requestStatsRepo.ts: all functions are now no-ops (recordRequestStat, pruneAllRequestStats) or return [] (listRequestStats)
- Stats endpoints in adminApi.ts log a 'request-stats-disabled' info message with each call
- server.ts: startServer() is now async (calls await initPool())
- index.ts: wraps startServer() in .catch() to exit(1) on failure
- deleteAccountsBySsoUser returns deletedRequestStats: 0 (stats not persisted)
- Pre-existing TypeScript errors in proxy (express type augmentation) unchanged — not introduced by Task 3
- Task 3 changes: 10 modified files + 2 new files (crypto.ts, pool.ts)

## [2026-07-22] Task 4: Advisory locking for cross-replica coordination
- advisoryLock.ts: uses SHA-256 truncated to int32 for both namespace and key hashing
- pg_try_advisory_lock is non-blocking (tries once, returns false if unavailable)
- Coordination pool client is NEVER reused if unlock fails (released with destroy=true)
- ADVISORY_NAMESPACES: PROXY_INIT, PROXY_REFRESH, SSO_SCIM, LOGIN_WORKER
- tokenManager: same-process Maps are optimization only, not correctness control
- initializeIdentityOnce: re-checks account existence inside advisory lock (race guard)
- operator_managed credential source: skips auto-enqueue, just creates account in 'missing' state
- generated_default credential source: passwordForLogin from SSO ensure → auto-enqueues
- createOrCoalesceLoginTaskTx: atomic transaction creating task+secret+outbox+account binding
- Duplicate request check: status IN ('pending','running') OR result_pending=true
- refreshCopilotWithLock: if lock not acquired, re-reads from DB and returns cached token

## [2026-07-22] Task 5: SSO persistence ported to PostgreSQL
- sso.scim_rate_limits singleton row uses SELECT FOR UPDATE for cross-replica coordination
- rateLimiter.ts: reserveScimSlot() returns waitMs; caller then sleeps before SCIM request
- usersRepo.ts: all functions async; credential_source field added
- budgetRepo.ts: rawJson removed from AiCreditsUsageCacheRecord and schema
- emuImportPlansRepo.ts: password_for_login removed; apply uses FOR UPDATE SKIP LOCKED lease
- eventLog.ts: replaced appendFileSync with console.log structured JSON output
- service.ts: all functions now async (671 lines → async throughout)
- service.ts: ensureUser creates with credentialSource='generated_default' (passwordForLogin returned)
- service.ts: createSsoUser sets credentialSource based on whether password was supplied
- service.ts: patchSsoUser marks 'operator_managed' when password is changed
- service.ts: applyEmuImportPlan uses acquireApplyLease/releaseApplyLease
- service.ts: buildEmuImportPlan now takes local users maps as params (avoids N+1)
- service.ts: passwordForLogin intentionally omitted from applyEmuImportRow return (plan spec)
- samlRoutes.ts: getUser calls now await
- budgetService.ts: readAiCreditsUsage is now async; toUsageDto is async
- SSO package.json: added @ghcp/database dependency
- Zero TypeScript errors in @ghcp/sso typecheck

## [2026-07-22] Task 6: Login worker with pg-boss and durable task queue
- login/pool.ts: general pool (max 5), coordination pool (max 1 for advisory locks)
- login/connection.ts: re-exports from pool.ts (replaces SQLite connection)
- login/db/tasksRepo.ts: all functions async; task_generation/current_attempt_token/result_pending added
- login/db/queue.ts: NEW - durable queue using createOrCoalesceLoginTaskTx from @ghcp/database
- login/tasks/queue.ts: stub that re-exports loginQueue from db/queue.ts
- login/routes/tasksApi.ts: all routes now async; imports loginQueue from db/queue.ts
- login/src/worker.ts: NEW - standalone login-worker entrypoint with polling loop
- login/src/server.ts: startServer() now async (awaits initPool())
- login/package.json: added @ghcp/database dependency; added start:worker script
- worker.ts uses SELECT FOR UPDATE SKIP LOCKED for task claiming (prevents duplicate processing)
- Duplicate task detection: getActiveTaskForIdentity() checks pending/running status
- task_secrets deleted after terminal success or failure (no orphan secrets)
- 202 status with existing task DTO returned for duplicate requests
- LoginTaskRecord now includes taskGeneration, currentAttemptToken, resultPending fields
- logPath field removed from PostgreSQL schema (used structured stdout logging instead)
- Zero TypeScript errors across all four packages

## [2026-07-22] Task 7: Graceful lifecycle and readiness probes
- All services have /healthz (liveness, always 200) and /readyz (readiness, requires DB connectivity)
- isReady flag: false during startup, true after initPool(), false on shutdown
- activeRequests: tracked via express middleware using res.on('finish')/res.on('close')
- Shutdown: closes server, waits 30s for drain, exits 0 if clean or 1 if timed out
- shared/lifecycle.ts: added LifecycleContext and createLifecycleContext() types
- Structured JSON logging: console.log(JSON.stringify({time, event, service, ...}))
- /readyz does NOT check GitHub/Copilot reachability (per plan spec)
- All three services use same shutdown pattern
- Zero TypeScript errors across all packages including @ghcp/shared

## [2026-07-22] Task 8: Docker Compose topology
- PostgreSQL 16 service: postgres-data volume only; no SQLite volumes
- db-migrate: one-shot service that runs migrations before any API starts
- Login worker: separate service with same image as login API, different entrypoint
- Traefik: exposes port 80/443 only; routes by SSO_HOST, PROXY_HOST, CONSOLE_HOST
- socket-proxy: read-only Docker socket access for Traefik discovery
- No published PostgreSQL ports, no published login ports
- All services use json-file log driver with max-size limits
- x-database-env anchor: shared DATABASE_URL, DATA_ENCRYPTION_KEY, LOGIN_JOB_ENCRYPTION_KEY
- login-worker and login use same ghcp-login:local image, different entrypoints
- console-data volume preserved for ADMINS_FILE (not migrated to PostgreSQL per plan spec)
- .env.example updated with all new variables and removed DB_PATH/SQLite refs

## [2026-07-22] Task 9: SQLite removal and cleanup
- Deleted: src/{proxy,sso,login}/src/db/migrations.ts (SQLite migration files)
- Removed: better-sqlite3 and @types/better-sqlite3 from root package.json
- Removed: dbPath property from proxy, sso, login config interfaces and values
- Removed: eventLogPath from SSO config (event log converted to structured stdout)
- Guard test: src/packages/database/src/tests/legacy-guard.test.ts
  - Scans all non-test .ts source files for SQLite/DB_PATH references
  - Runs with: bun test src/tests/legacy-guard.test.ts
  - Pattern uses split strings to avoid triggering itself
- docker-compose.yml: no DB_PATH, no SQLite volumes, no backup/restore services
- .env.example: completely rewritten for PostgreSQL topology
- requestStatsRepo.ts kept (still returns [] - empty stat persistence is disabled)
