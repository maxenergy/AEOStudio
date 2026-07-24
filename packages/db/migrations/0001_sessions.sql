CREATE TABLE IF NOT EXISTS auth_login_attempts (
  token_digest text PRIMARY KEY,
  payload_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_login_attempts_expires_at_idx
  ON auth_login_attempts (expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_digest text PRIMARY KEY,
  identity_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL,
  CONSTRAINT auth_sessions_expiry_order CHECK (expires_at > created_at),
  CONSTRAINT auth_sessions_revoke_order CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX IF NOT EXISTS auth_sessions_active_expiry_idx
  ON auth_sessions (expires_at)
  WHERE revoked_at IS NULL;

