# postgres-horizontal-stability - Planning Draft

## State

- status: interviewing
- intent: clear
- review_required: false
- classification: architecture
- test_strategy: tests-after, with agent-executed integration tests for PostgreSQL migrations, queue delivery, locking, and graceful shutdown.

## Request

Replace the three SQLite stores with a production-grade PostgreSQL-only design; allow proxy multi-core/horizontal scaling; make login jobs durable and safely multi-worker; improve long-running stability for an internal trusted-network deployment.

## Components

| Component | Outcome | Status | Evidence |
| --- | --- | --- | --- |
| PostgreSQL persistence | Move proxy, SSO, and login durable state from local SQLite to shared PostgreSQL with versioned migrations and a reversible cutover. | discovered | `src/{proxy,sso,login}/src/db/{connection,migrations}.ts` |
| Proxy replicas | Make identity initialization and Copilot-token refresh safe across multiple proxy replicas. | discovered | `src/proxy/src/copilot/tokenManager.ts` |
| Login workers | Replace the in-memory login queue with durable, lease-based PostgreSQL jobs that support controlled worker concurrency and crash recovery. | discovered | `src/login/src/tasks/queue.ts`, `src/login/src/db/tasksRepo.ts` |
| Long-running operations | Add lifecycle draining, retention, structured logging, health/readiness, backups, and deployment topology that supports replicas. | discovered | `docker-compose.yml`, `src/{proxy,sso,login}/src/server.ts` |

## Decisions Recorded

- Database/queue platform: PostgreSQL-only; no Redis.
- Recommended runtime libraries: `pg` + Drizzle + `pg-boss`, requiring PostgreSQL 13 or newer.
- Intended service roles: stateless proxy API replicas, separately deployed login worker replicas, one or more SSO/console API replicas after shared persistence and shared coordination are in place.
- Existing external API DTOs and service HTTP contracts remain stable unless explicitly required for operational status visibility.
- Internal trusted-network deployment lowers public-edge hardening priority; reliability, data integrity, and retention remain in scope.

## Pending Owner Decisions

- Existing SQLite data cutover policy: start PostgreSQL with clean state; do not export, import, dual-write, or preserve SQLite compatibility.
- Deployment/orchestration target: Docker Compose with an internal reverse proxy, PostgreSQL service, replica-aware proxy API service, separately scalable login worker service, backup job, and retention job.

## Evidence Ledger

- Three independent SQLite stores: proxy accounts/stats, SSO users/budget/import plans, and login tasks. See `src/README.md`, `src/*/src/db/migrations.ts`.
- `LoginQueue` retains pending/active/cancelled work only in memory, while restart recovery marks unfinished tasks failed. See `src/login/src/tasks/queue.ts`, `src/login/src/db/tasksRepo.ts`.
- Proxy token initialization and refresh are deduplicated only by per-process Maps. See `src/proxy/src/copilot/tokenManager.ts`.
- Request stats retention is per identity count only, and logs lack rotation. See `src/proxy/src/db/requestStatsRepo.ts`, `src/login/src/tasks/accountLogger.ts`, `src/sso/src/db/eventLog.ts`.

## Approval Gate

- status: review-in-progress
- approach: replace `better-sqlite3` with a shared `pg` pool and Drizzle-managed PostgreSQL schema; use `pg-boss` for durable login jobs; implement PostgreSQL advisory locks/leases for proxy token initialization, refresh, and shared SCIM throttling; deploy stateless proxy replicas behind an internal reverse proxy; split login APIs from worker consumers; add graceful shutdown, readiness/liveness probes, log/DB retention, and PostgreSQL backup/restore verification in Docker Compose.
- scope in: new PostgreSQL schema, repos, migrations, queue/worker orchestration, distributed coordination, Compose topology, lifecycle/observability/retention, tests, and operational documentation.
- scope out: SQLite data migration, Redis, Kubernetes manifests, public internet/TLS edge hardening, and changes to the public compatibility API DTOs.
- next action: deliver `.omo/plans/postgres-horizontal-stability.md`; no product-code implementation occurs in this session.

## Plan Review Notes

- Mandatory Metis gap review completed after approval.
- Resolved review findings: Console keeps its existing `ADMINS_FILE` JSON volume; duplicate pending/running login-task submissions coalesce to the existing `202 LoginTaskDto`; pg-boss exclusively owns its self-migrated `pgboss` tables; proxy coordination uses an isolated, bounded advisory-lock pool; encryption-key rotation is explicitly out of scope and requires a drained queue; fixed retention defaults were added.
- User requested high-accuracy review after plan creation. Dual review target: `.omo/plans/postgres-horizontal-stability.md`.
- High-accuracy review round 1 requested changes: transactional outbox, complete plaintext-password removal, worker fencing/token write-back authorization, migration ownership/capacity budget, SAML/Traefik routing, and recurring encrypted backup/retention. All have been incorporated; review round 2 is required.
- User changed scope: backups are out of scope and durable state must be minimized. Pending approval of the minimal-state policy before revising/re-reviewing the plan.
- User approved the minimal-state policy. The plan now removes request-stat persistence, durable task events, backup/restore services, and all long-retention operational data; it retains only encrypted credentials, required SSO state, active task/outbox/queue state, and short-lived plans/cache. High-accuracy review is required again because the plan changed.
- Minimal-state high-accuracy review requested changes: correct no-backup pool budget, add concrete runbook and executable F1/F4 checks, add durable terminal result outbox, make proxy initialization use the shared DB task primitive, isolate tests per database, fix queue timing/capacity limits, clarify Traefik internal routing, and preserve empty stats API contracts. All are incorporated; another dual review is required.
- Final independent review requested changes: generation-specific enqueue identity, durable result/dead-letter dispatch, proxy account credential fencing, custom-password manual recovery, full connection-pool accounting, exact TTL predicates, SSO origin allowlisting, and documentation/search corrections. All are incorporated; final dual review is required.
- Last independent audit requested result-pending suppression, active-task uniqueness, encryption-key fingerprint consistency, credential-source provenance, Azure-specific origin validation, import-lease preservation, and explicit failure-window QA. All are incorporated; final dual review is required.
- User reaffirmed four mandatory internal-production invariants: random SSO credentials, one browser login per identity, account-version/task-generation fencing against stale token overwrite, and durable login-result write-back. They are now explicitly recorded in the plan Scope as release blockers.
- User selected a simplified login topology: exactly one `login-worker` with `LOGIN_WORKER_CONCURRENCY=1`; multi-worker login coordination is out of scope, while durable queue/restart recovery, generation fencing, and result write-back remain required.
- Detailed plan reconciliation: single-worker topology now explicitly overrides older Task 1/6/8/F3/F4 multi-worker capacity, Compose scale, QA, and coordination wording.

## Proposed Minimal-State Policy

- Persist only proxy account identity and encrypted GitHub/Copilot tokens; SSO users/password hashes/EMU state; active login task, encrypted active secret, job outbox, and queue state; pending EMU import plans; and current/previous-month AI-credit cache.
- Do not persist request statistics: preserve existing admin endpoints but return empty results, while exposing only process metrics/logs with bounded Docker rotation.
- Delete login secrets immediately on terminal state; delete terminal task rows, queue archive/dead letters, and applied import plans after 24 hours; delete pending import plans after one hour; delete budget cache older than 35 days.
- Do not deploy backup, restore, backup encryption, or backup retention services. PostgreSQL volume loss requires reprovisioning accounts/tokens; document this accepted consequence.
- Retain required PostgreSQL/data correctness mechanisms: transactional proxy-to-login outbox, fenced worker attempts/callbacks, encrypted durable credentials/tokens, migration ownership, bounded pool capacity, and SAML/Traefik reachability.
