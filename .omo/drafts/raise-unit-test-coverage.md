---
slug: raise-unit-test-coverage
status: complete
intent: unclearreview_required: true
plan_path: .omo/plans/raise-unit-test-coverage.md
plan_sha256: null
review_round_id: null
pending-action: write and review .omo/plans/raise-unit-test-coverage.md
review:
  momus:
    status: approved-after-revision
    workspace_root: /root/ghcp-api-console
    runtime_home: null
    target: .omo/plans/raise-unit-test-coverage.md
    round_id: 2
    plan_sha256: null
    launch_id: bg_719ef243
    session: ses_0730051c4ffeBeXY9d1e7yd768
    result: "Round 1 REJECT (3 blockers: schema reset, service initPool, test-support path) → fixed. Round 2 REQUEST CHANGES (2: Todo10 order, Todos3-8 coverage script) → fixed."
  independent:
    status: approved-after-revision
    workspace_root: /root/ghcp-api-console
    runtime_home: null
    target: .omo/plans/raise-unit-test-coverage.md
    round_id: 2
    plan_sha256: null
    launch_id: bg_9bf8a76c
    session: ses_07300191effe1ZcCdf597Qsgo9
    result: "Round 1 REQUEST CHANGES (7 issues) → fixed. Round 2 REQUEST CHANGES (2: unit-glob matched integration files, Todo10 order) → fixed by *.unit.test.ts naming + canonical setup sequence."
approach: Introduce a repo-wide test toolchain (node:test + tsx + c8) and add unit tests for all pure-logic units plus real-Postgres integration tests (against docker-compose.test.yml) for SQL-backed repos/queue/migrations, targeting ~80% line coverage on core logic across shared, database, proxy, sso, login (console server helpers included), excluding bootstrap wiring, React UI, and Playwright.
---

# Draft: raise-unit-test-coverage

## Components (topology ledger)
- T0 test-harness | Shared test toolchain (node:test+tsx+c8), per-workspace `test`/`test:unit`/`test:coverage` scripts, root aggregation, integration DB helper | active | package.json files, docker-compose.test.yml
- C1 shared | Unit tests for @ghcp/shared pure logic (redact, api, ids, time, logger, httpClient) | active | src/packages/shared/src/
- C2 database | Unit (config, keyFingerprint fp, advisoryLock hashing) + integration (migrate, validateClusterKeys, advisoryLock, loginTask coalescing) | active | src/packages/database/src/
- C3 proxy | Unit (crypto, config, claudeCodeMode, claudeCodeCompat, anthropicModelProfiles) + integration (accountsRepo) | active | src/proxy/src/
- C4 sso | Unit (bulkImport, password, scim/handle, config) + integration (usersRepo, emuImportPlansRepo) | active | src/sso/src/
- C5 login | Unit (config, internalAuth, accountLogger redaction) + integration (tasksRepo, queue) | active | src/login/src/
- C6 console | Unit (server adminsStore scrypt, config, web/lib/format) | active | src/console/src/server/, src/console/src/web/lib/
- C7 ci-docs | CI-runnable command + README/AGENTS docs for running the suite | active | package.json, README.md

## Open assumptions (announced defaults)
- Runner = node:test + tsx (not vitest) | matches existing legacy-guard.test.ts + database `test:integration` pattern; no new heavy framework | reversible
- Coverage tool = c8, target ~80% line on core logic | standard for node:test; user confirmed | reversible
- Coverage EXCLUDES index.ts/server.ts bootstrap, React UI (App.tsx/main.tsx/components/api clients), Playwright strategy, deviceFlow, worker.ts, debugToken.ts, mock-github | these are IO/wiring/browser; low unit-test ROI | reversible
- Integration tests run against docker-compose.test.yml Postgres (:5433) via TEST_DATABASE_URL; each test provisions its own schema/migrations and truncates between tests | user chose unit+real-Postgres; repo already ships the compose file | reversible
- Test file convention = colocated `*.unit.test.ts` (unit tier, always runs) and `*.integration.test.ts` (real Postgres, serial via --test-concurrency=1), run with `node --test --import tsx/esm`; the two globs are mutually exclusive so the unit tier never triggers DB tests | node has no negative glob and c8 exclude does not affect test discovery, so naming must separate the tiers | reversible
- Encryption keys for tests = fixed 32-byte base64 test keys set via env in a shared test setup module | config.ts requires DATA_ENCRYPTION_KEY/LOGIN_JOB_ENCRYPTION_KEY | reversible

## Findings (cited - path:lines)
- Only ONE test exists repo-wide: src/packages/database/src/tests/legacy-guard.test.ts uses `node:test` + `node:assert/strict`; package script runs it via `bun test`, and defines `test:integration` = `node --test --import tsx/esm 'src/**/*.test.ts'` (src/packages/database/package.json:19-20).
- Data layer is PostgreSQL + Drizzle (pg, drizzle-orm), NOT SQLite — READMEs are stale (src/packages/database/package.json:22-24). Test DB already provisioned: docker-compose.test.yml (Postgres 16, :5433) and TEST_DATABASE_URL reserved in .env.example:89.
- Root package.json test scripts fan out to workspaces `--if-present`: `test` and `test:integration` (package.json:33-34) — but no workspace except database defines them.
- All workspaces are ESM (`"type":"module"`), NodeNext, strict TS, built with tsc, dev-run with tsx (tsconfig.base.json:1-15).
- Proxy pure-logic wins: src/proxy/src/db/crypto.ts (buildAad/encryptCredential/decryptCredential, AES-256-GCM, verified 1-67), routes/claudeCodeMode.ts (resolveClaudeCodeOptimized, 1-28), routes/claudeCodeCompat.ts (prepareClaudeCodeMessagesRequest/estimateInputTokens/shouldTranslateWebSearchError/webSearchUnsupportedMessage), routes/anthropicModelProfiles.ts (normalizeAnthropicModelId/getAnthropicModelProfile), config.ts.
- Proxy integration: src/proxy/src/db/accountsRepo.ts (create/get/list/import/save/mark/deleteBySsoUser/toAccountDto).
- SSO cheap unit wins: src/sso/src/users/bulkImport.ts (parseBulkImportText), auth/password.ts (hashPassword/verifyPassword), scim/handle.ts (normalizeHandle), config.ts.
- SSO integration: src/sso/src/db/usersRepo.ts (CRUD/toDto), db/emuImportPlansRepo.ts (plan lifecycle + apply lease).
- Login: pure logic thin; unit = config.ts, auth/internalAuth.ts (requireInternalToken), tasks/accountLogger.ts (AccountLogger redaction). Integration = db/tasksRepo.ts (state machine: createTask/claimTask/markRunning/markSuccess/markFailed/markCancelled/getActiveTaskForIdentity/recoverResultPendingTasks), db/queue.ts (enqueue/cancel/retry). EXCLUDE: HeadlessPlaywrightAuthStrategy.ts, deviceFlow.ts, runner.ts, worker.ts, debugToken.ts.
- Shared pure logic: src/packages/shared/src/redact.ts (maskSecret/redactFields/shouldRedact, verified 1-20), api.ts (apiError/pageResponse/HttpApiError, verified 1-54), ids.ts, time.ts, logger.ts, httpClient.ts (JsonHttpClient — mock fetch).
- Database unit+integration: config.ts (getDatabaseConfig/sha256Fingerprint — pure, verified 1-82), keyFingerprint.ts (validateClusterKeys — DB, verified 1-76), advisoryLock.ts (withPostgresAdvisoryLock + ADVISORY_NAMESPACES hashing — hash helpers pure, lock is DB, verified 1-104), migrate.ts (runMigrations/getMigrationVersion — DB, verified 1-80), loginTask.ts (createOrCoalesceLoginTaskTx — DB transactional coalescing). Migrations dir has 0001_base_schemas.sql.
- Console server units: src/console/src/server/adminsStore.ts (isInitialized/setupAdmin/verifyAdmin — scrypt), config.ts; web/lib/format.ts (formatDate/formatNumber/tokenTotal/statusTone/summarizeJson) pure.

## Decisions (with rationale)
- Standardize on node:test+tsx+c8 across ALL workspaces (add `test`, `test:unit`, `test:coverage` scripts; keep database's `test:integration`). Rationale: zero new heavy framework, matches existing convention, root fan-out already wired.
- Two test tiers per module: `*.test.ts` (pure unit, no DB, run everywhere) and `*.integration.test.ts` (real Postgres, run when TEST_DATABASE_URL present). Rationale: user chose unit+real-Postgres; keeps unit tier fast and always-green.
- Shared test-support package: a small `test-support` helper (fixed 32-byte keys, DB connect/migrate/truncate helpers, fetch mock) reused across workspaces. Rationale: DRY, avoids per-test env boilerplate; config.ts mandates encryption keys.
- Coverage measured with c8 per workspace + a root aggregate script; ~80% line on core-logic files, wiring/UI/Playwright excluded via c8 config. Rationale: "good level" without chasing untestable IO/browser code.
- TDD not required for tests-of-existing-code; write tests-after against current behavior, and treat any discovered real bug as a documented finding (NOT a silent code change — this plan is test-only). Rationale: goal is "ensure functionality is correct" by locking current behavior + flagging defects.

## Scope IN
- Add test toolchain + scripts to every workspace (shared, database, proxy, sso, login, console) and root aggregation.
- Unit tests for every pure-logic unit listed in Findings.
- Integration tests (real Postgres) for accountsRepo, usersRepo, emuImportPlansRepo, tasksRepo, queue, migrate, validateClusterKeys, advisoryLock, loginTask coalescing.
- c8 coverage config + a documented single command to run the whole suite (unit always; integration when DB up).
- Short README/AGENTS section documenting how to run tests + the Docker DB tier.
- Final verification wave: run full suite + coverage and confirm ~80% on core logic.

## Scope OUT (Must NOT have)
- NO production/source code behavior changes. Test-only. If a test reveals a bug, record it as a finding; do NOT fix source in this plan.
- NO tests for: React UI (App.tsx, main.tsx, web/components/*, web/api/* clients), Playwright HeadlessPlaywrightAuthStrategy, deviceFlow, runner.ts, worker.ts, debugToken.ts, mock-github server.
- NO switch to vitest/jest.
- NO CI provider config files (GitHub Actions etc.) unless the user later asks — only a documented runnable command.
- NO new coverage target beyond ~80% line on core logic; no 100% chase.
- NO edits to stale READMEs beyond adding the test-running section (SQLite doc cleanup is out of scope).

## Open questions
(none — both owner-decisions resolved via the approval questions: DB strategy = unit+real-Postgres integration; runner/target = node:test+tsx+c8 @ ~80% core logic.)

## Approval gate
status: awaiting-approval
approach: node:test+tsx+c8; two tiers (unit always-green + real-Postgres integration); ~80% line coverage on core logic; test-only, no source changes; excludes wiring/UI/Playwright.
next action after approval: rerun scaffold without --draft-only to create .omo/plans/raise-unit-test-coverage.md, APPEND the todo batches, then run the mandatory dual high-accuracy review (momus + independent Oracle) before handoff.
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
