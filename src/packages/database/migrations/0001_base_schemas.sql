-- Migration 0001: Base schemas for proxy, sso, login
-- Creates all Drizzle-owned tables across three PostgreSQL schemas.
-- pg-boss will self-migrate its own schema; do NOT create pgboss.* tables here.

-- ============================================================
-- PROXY SCHEMA
-- ============================================================
CREATE SCHEMA IF NOT EXISTS proxy;

-- Proxy accounts: one row per identity.
-- github/copilot credentials are encrypted at rest with DATA_ENCRYPTION_KEY.
-- credential_version increments each time a new GitHub token is imported or
-- a login task completes successfully, used to fence stale writes.
CREATE TABLE IF NOT EXISTS proxy.accounts (
  identity               TEXT        PRIMARY KEY,
  sso_user               TEXT        NOT NULL,
  gh_login               TEXT,
  -- Encrypted GitHub token (AES-256-GCM, random 96-bit nonce, base64-encoded payload)
  gh_token_cipher        TEXT,
  -- nonce for gh_token_cipher (hex)
  gh_token_nonce         TEXT,
  gh_token_status        TEXT        NOT NULL DEFAULT 'missing'
                           CHECK (gh_token_status IN ('valid','expired','missing','refreshing','failed')),
  gh_token_updated_at    TIMESTAMPTZ,
  -- Encrypted Copilot token (AES-256-GCM)
  copilot_token_cipher   TEXT,
  copilot_token_nonce    TEXT,
  copilot_api            TEXT,
  copilot_token_expires_at TIMESTAMPTZ,
  copilot_token_status   TEXT        NOT NULL DEFAULT 'missing'
                           CHECK (copilot_token_status IN ('valid','expired','missing','refreshing','failed')),
  -- Monotonically increasing version: incremented on every new GitHub token write.
  -- Used as generation fence for Copilot token saves from login workers.
  credential_version     BIGINT      NOT NULL DEFAULT 0,
  -- Active login task binding for this account when in refreshing state.
  -- Cleared when refreshing completes or is abandoned.
  active_login_task_id   TEXT,
  active_task_generation BIGINT,
  active_attempt_token   TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proxy_accounts_sso_user
  ON proxy.accounts (lower(sso_user));

-- ============================================================
-- SSO SCHEMA
-- ============================================================
CREATE SCHEMA IF NOT EXISTS sso;

-- SSO users: local identity store.
-- password_hash is scrypt; salt is random hex.
-- credential_source tracks whether password was auto-generated or operator-managed.
CREATE TABLE IF NOT EXISTS sso.users (
  sso_user                     TEXT        PRIMARY KEY,
  password_hash                TEXT        NOT NULL,
  salt                         TEXT        NOT NULL,
  email                        TEXT        NOT NULL,
  role                         TEXT        NOT NULL DEFAULT 'user'
                                 CHECK (role IN ('user', 'admin')),
  gh_login                     TEXT,
  gh_scim_id                   TEXT,
  emu_status                   TEXT        NOT NULL DEFAULT 'not_synced'
                                 CHECK (emu_status IN ('active','suspended','deleted','not_synced')),
  copilot_seat_status          TEXT        NOT NULL DEFAULT 'unknown'
                                 CHECK (copilot_seat_status IN ('unknown','assigned','unassigned','assign_failed','remove_failed')),
  copilot_seat_last_operation  TEXT
                                 CHECK (copilot_seat_last_operation IN ('assign','remove') OR copilot_seat_last_operation IS NULL),
  copilot_seat_last_error      TEXT,
  copilot_seat_updated_at      TIMESTAMPTZ,
  -- 'generated_default': auto-generated initial password (ssoUser value used as initial plaintext).
  -- 'operator_managed': password was explicitly set by an operator.
  -- Only 'generated_default' accounts may be auto-enqueued for browser login.
  credential_source            TEXT        NOT NULL DEFAULT 'generated_default'
                                 CHECK (credential_source IN ('generated_default','operator_managed')),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sso_users_gh_login
  ON sso.users (lower(gh_login)) WHERE gh_login IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sso_users_email
  ON sso.users (lower(email));

-- SSO SCIM rate-limit singleton row.
-- One row with id='singleton'. Replicas SELECT FOR UPDATE to serialize SCIM calls.
CREATE TABLE IF NOT EXISTS sso.scim_rate_limits (
  id              TEXT        PRIMARY KEY DEFAULT 'singleton',
  next_allowed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insert singleton if not present (idempotent)
INSERT INTO sso.scim_rate_limits (id, next_allowed_at)
VALUES ('singleton', now())
ON CONFLICT (id) DO NOTHING;

-- Compact AI credits usage cache: current and previous UTC month.
-- raw_json removed per plan spec (only store consumed DTO fields).
CREATE TABLE IF NOT EXISTS sso.budget_cache (
  period_key  TEXT        PRIMARY KEY,  -- 'YYYY-MM'
  year        INTEGER     NOT NULL,
  month       INTEGER     NOT NULL,
  quantity    DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit_type   TEXT,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- EMU import plans
CREATE TABLE IF NOT EXISTS sso.emu_import_plans (
  id              TEXT        PRIMARY KEY,
  sso_user        TEXT,
  status          TEXT        NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned','applied')),
  -- Internal lease fields for apply operations (never exposed in API)
  apply_lease_owner      TEXT,
  apply_lease_expires_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sso_emu_import_plans_status
  ON sso.emu_import_plans (status, created_at DESC);

-- EMU import plan rows (detail per SCIM user)
-- password_for_login column is REMOVED per plan spec.
CREATE TABLE IF NOT EXISTS sso.emu_import_plan_rows (
  plan_id     TEXT        NOT NULL REFERENCES sso.emu_import_plans(id) ON DELETE CASCADE,
  row_index   INTEGER     NOT NULL,
  sso_user    TEXT        NOT NULL,
  email       TEXT,
  gh_login    TEXT,
  gh_scim_id  TEXT,
  emu_status  TEXT,
  status      TEXT        NOT NULL
                CHECK (status IN ('pending_create','pending_update','created','updated','skipped','conflict','failed')),
  detail      TEXT        NOT NULL,
  action      TEXT        CHECK (action IN ('create','update','skip') OR action IS NULL),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_sso_emu_import_plan_rows_status
  ON sso.emu_import_plan_rows (plan_id, status, row_index);

-- ============================================================
-- LOGIN SCHEMA
-- ============================================================
CREATE SCHEMA IF NOT EXISTS login;

-- Login tasks: operator-facing lifecycle record.
-- One row per distinct identity+generation lifecycle.
-- task_generation is monotonically increasing per identity.
-- current_attempt_token must match for any state transition.
CREATE TABLE IF NOT EXISTS login.tasks (
  id                    TEXT        PRIMARY KEY,
  identity              TEXT        NOT NULL,
  sso_user              TEXT        NOT NULL,
  gh_login              TEXT,
  sso_type              TEXT        NOT NULL
                          CHECK (sso_type IN ('azure','custom')),
  status                TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','running','success','failed','cancelled')),
  attempts              INTEGER     NOT NULL DEFAULT 0,
  failure_reason        TEXT,
  -- Monotonically increasing generation counter per identity (starts at 1).
  -- Each new task for the same identity increments this.
  task_generation       BIGINT      NOT NULL DEFAULT 1,
  -- Per-claim fencing token (UUID, set atomically when worker claims the job).
  current_attempt_token TEXT,
  -- Marks that a successful result is pending write-back to proxy.
  -- Set when login succeeds but proxy callback has not yet been confirmed.
  result_pending        BOOLEAN     NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_login_tasks_identity_status
  ON login.tasks (identity, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_login_tasks_status_created_at
  ON login.tasks (status, created_at DESC);

-- Login task secrets: encrypted runtime SSO credentials.
-- One row per task. Deleted when task reaches terminal state (success/failed/cancelled).
CREATE TABLE IF NOT EXISTS login.task_secrets (
  task_id          TEXT        PRIMARY KEY REFERENCES login.tasks(id) ON DELETE CASCADE,
  -- Encrypted payload: JSON containing ssoPassword + selectorOverrides
  -- AES-256-GCM with LOGIN_JOB_ENCRYPTION_KEY, random nonce
  secret_cipher    TEXT        NOT NULL,
  secret_nonce     TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Job outbox: tracks pg-boss job publish status per (task, generation).
-- Dispatcher uses explicit lease to guarantee at-least-once publish.
-- After confirmed delivery, row is retained briefly then cleaned up.
CREATE TABLE IF NOT EXISTS login.job_outbox (
  task_id          TEXT        NOT NULL REFERENCES login.tasks(id) ON DELETE CASCADE,
  task_generation  BIGINT      NOT NULL,
  -- Unique pg-boss singleton key for this generation
  pg_boss_key      TEXT        NOT NULL UNIQUE,
  -- Delivery state
  state            TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','delivered','failed')),
  -- Dispatcher lease fields (60s TTL)
  locked_at        TIMESTAMPTZ,
  locked_by        TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_token      TEXT,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, task_generation)
);

CREATE INDEX IF NOT EXISTS idx_login_job_outbox_state
  ON login.job_outbox (state, created_at) WHERE state = 'pending';

-- Result outbox: tracks proxy write-back status for successful login results.
-- Created when a login worker writes a token; deleted after confirmed proxy callback.
CREATE TABLE IF NOT EXISTS login.result_outbox (
  task_id          TEXT        NOT NULL REFERENCES login.tasks(id) ON DELETE CASCADE,
  task_generation  BIGINT      NOT NULL,
  attempt_token    TEXT        NOT NULL,
  -- Encrypted GitHub token payload (AES-256-GCM, DATA_ENCRYPTION_KEY)
  gh_token_cipher  TEXT        NOT NULL,
  gh_token_nonce   TEXT        NOT NULL,
  gh_login         TEXT,
  state            TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','delivered','failed')),
  locked_at        TIMESTAMPTZ,
  locked_by        TEXT,
  lease_expires_at TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  retry_count      INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, task_generation)
);

CREATE INDEX IF NOT EXISTS idx_login_result_outbox_state
  ON login.result_outbox (state, created_at) WHERE state = 'pending';
