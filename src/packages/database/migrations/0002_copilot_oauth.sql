-- Migration 0002: Copilot OAuth (OpenCode OAuth) credential path.
--
-- Adds a direct Copilot OAuth access token (gho_...) credential to proxy.accounts.
-- The OAuth token is used directly as the Copilot Bearer token (no exchange step),
-- replacing the GitHub-token + copilot_internal/v2/token exchange flow at runtime.
--
-- Legacy columns (gh_token_*, copilot_token_*) are RETAINED, untouched, for one
-- rollback window. The new runtime only reads/writes the OAuth columns.
-- Existing accounts are backfilled to copilot_oauth_status='missing' and require a
-- one-time re-login or OAuth token import (see guidance/newGHToken-upgrade-process.md).
--
-- The OAuth token is encrypted at rest with AES-256-GCM (DATA_ENCRYPTION_KEY),
-- AAD label "copilot_oauth_token", mirroring the existing credential encryption.

-- ============================================================
-- proxy.accounts: add OAuth credential columns
-- ============================================================

-- Encrypted OAuth access token (AES-256-GCM, random 96-bit nonce, base64 payload).
ALTER TABLE proxy.accounts
  ADD COLUMN IF NOT EXISTS copilot_oauth_token_cipher TEXT,
  ADD COLUMN IF NOT EXISTS copilot_oauth_token_nonce  TEXT,
  ADD COLUMN IF NOT EXISTS copilot_oauth_status       TEXT,
  ADD COLUMN IF NOT EXISTS copilot_oauth_updated_at   TIMESTAMPTZ;

-- Backfill existing accounts: OAuth credential is not present until re-login/import.
UPDATE proxy.accounts
  SET copilot_oauth_status = 'missing'
  WHERE copilot_oauth_status IS NULL;

-- Enforce default + NOT NULL now that every row has a value.
ALTER TABLE proxy.accounts
  ALTER COLUMN copilot_oauth_status SET DEFAULT 'missing',
  ALTER COLUMN copilot_oauth_status SET NOT NULL;

-- Status domain check.
ALTER TABLE proxy.accounts
  ADD CONSTRAINT proxy_accounts_copilot_oauth_status_check
  CHECK (copilot_oauth_status IN ('valid','expired','missing','refreshing','failed'));

-- cipher/nonce must be present together or absent together.
ALTER TABLE proxy.accounts
  ADD CONSTRAINT proxy_accounts_copilot_oauth_cipher_nonce_check
  CHECK (
    (copilot_oauth_token_cipher IS NULL) = (copilot_oauth_token_nonce IS NULL)
  );

-- A 'valid' OAuth status requires an encrypted token to be present.
ALTER TABLE proxy.accounts
  ADD CONSTRAINT proxy_accounts_copilot_oauth_valid_requires_token_check
  CHECK (
    copilot_oauth_status <> 'valid'
    OR (copilot_oauth_token_cipher IS NOT NULL AND copilot_oauth_token_nonce IS NOT NULL)
  );

-- ============================================================
-- login.result_outbox: carry OAuth token results
-- ============================================================
-- The result outbox delivers a login worker's result back to proxy. For the OAuth
-- path the payload is the encrypted OAuth access token instead of a GitHub token.
-- We add OAuth columns and relax the legacy gh_token columns to nullable so OAuth
-- result rows do not need to populate them. Legacy columns remain for rollback.

ALTER TABLE login.result_outbox
  ADD COLUMN IF NOT EXISTS outcome                        TEXT,
  ADD COLUMN IF NOT EXISTS copilot_oauth_token_cipher     TEXT,
  ADD COLUMN IF NOT EXISTS copilot_oauth_token_nonce      TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason                 TEXT;

-- Existing rows (if any) were GitHub-token successes.
UPDATE login.result_outbox
  SET outcome = 'success'
  WHERE outcome IS NULL;

ALTER TABLE login.result_outbox
  ALTER COLUMN outcome SET DEFAULT 'success',
  ALTER COLUMN outcome SET NOT NULL;

ALTER TABLE login.result_outbox
  ADD CONSTRAINT login_result_outbox_outcome_check
  CHECK (outcome IN ('success','failed'));

-- OAuth results do not populate the legacy gh_token columns.
ALTER TABLE login.result_outbox
  ALTER COLUMN gh_token_cipher DROP NOT NULL,
  ALTER COLUMN gh_token_nonce  DROP NOT NULL;
