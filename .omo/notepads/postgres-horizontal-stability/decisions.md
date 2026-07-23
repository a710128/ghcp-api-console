# Decisions — postgres-horizontal-stability

Architectural choices and rationales discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## [2026-07-22] Task 1: Key architectural decisions for @ghcp/database
- pg over postgres.js: required by plan spec, synchronous-free async API
- peerDependency for pg-boss: login worker needs it but @ghcp/database should not force it on proxy/sso
- Manual migration tracking (_drizzle_migrations table) instead of drizzle-kit runtime: drizzle-kit generate creates SQL files; we apply them manually for full control and test isolation
- cluster_metadata singleton: immutable key fingerprints; mismatch = hard fail requiring reprovisioning
- Coordination pool fast-fail: 250ms connectionTimeoutMillis matches plan's "acquire within 250ms" requirement
- No dotenv import in CLI: env vars are expected to be set by the deployment environment
- `import * as pg from 'pg'` not `import pg from 'pg'`: pg module has no default export in TypeScript strict mode
