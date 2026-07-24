CREATE TABLE signed_webhook_endpoint_verifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  channel_definition_id uuid NOT NULL REFERENCES channel_definitions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('PENDING', 'VERIFIED', 'REVOKED')),
  endpoint_url text NOT NULL CHECK (
    length(endpoint_url) BETWEEN 1 AND 2048
    AND endpoint_url ~ '^https://'
    AND endpoint_url !~ '[?#[:cntrl:]]'
  ),
  receipt_url text NOT NULL CHECK (
    length(receipt_url) BETWEEN 1 AND 2048
    AND receipt_url ~ '^https://'
    AND receipt_url !~ '[?#[:cntrl:]]'
  ),
  algorithm text NOT NULL CHECK (algorithm IN ('HMAC_SHA256', 'ED25519')),
  key_id text NOT NULL CHECK (
    length(key_id) BETWEEN 1 AND 120
    AND key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
  ),
  verification_reference text NOT NULL CHECK (
    length(verification_reference) BETWEEN 1 AND 200
    AND verification_reference !~ '[[:cntrl:]]'
  ),
  challenge text NOT NULL CHECK (
    length(challenge) BETWEEN 32 AND 128
    AND challenge ~ '^[A-Za-z0-9_-]+$'
  ),
  challenge_expires_at timestamptz NOT NULL,
  receipt_challenge text CHECK (
    receipt_challenge IS NULL
    OR (
      length(receipt_challenge) BETWEEN 32 AND 128
      AND receipt_challenge ~ '^[A-Za-z0-9_-]+$'
    )
  ),
  receipt_challenge_expires_at timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  verified_by_user_id uuid REFERENCES users(id),
  verified_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  CHECK (challenge_expires_at > created_at),
  CHECK (
    (
      endpoint_url = receipt_url
      AND receipt_challenge IS NULL
      AND receipt_challenge_expires_at IS NULL
    )
    OR
    (
      endpoint_url <> receipt_url
      AND receipt_challenge IS NOT NULL
      AND receipt_challenge <> challenge
      AND receipt_challenge_expires_at IS NOT NULL
      AND receipt_challenge_expires_at > created_at
    )
  ),
  CHECK (
    (status = 'PENDING' AND verified_by_user_id IS NULL AND verified_at IS NULL
      AND revoked_at IS NULL)
    OR
    (status = 'VERIFIED' AND verified_by_user_id IS NOT NULL AND verified_at IS NOT NULL
      AND revoked_at IS NULL AND verified_at <= challenge_expires_at
      AND (
        receipt_challenge_expires_at IS NULL
        OR verified_at <= receipt_challenge_expires_at
      ))
    OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX signed_webhook_endpoint_verification_lookup
  ON signed_webhook_endpoint_verifications
    (tenant_id, workspace_id, channel_definition_id, id, status);

ALTER TABLE signed_webhook_endpoint_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE signed_webhook_endpoint_verifications FORCE ROW LEVEL SECURITY;

CREATE POLICY signed_webhook_endpoint_verification_isolation
  ON signed_webhook_endpoint_verifications
  USING (
    tenant_id = aeostudio_current_tenant_id()
    AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = aeostudio_current_tenant_id()
    AND workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
  );

CREATE FUNCTION guard_signed_webhook_endpoint_verification_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_DELETE_FORBIDDEN'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'REVOKED'
    OR NOT (
      (OLD.status = 'PENDING' AND NEW.status IN ('VERIFIED', 'REVOKED'))
      OR (OLD.status = 'VERIFIED' AND NEW.status = 'REVOKED')
    )
  THEN
    RAISE EXCEPTION 'SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_TRANSITION_FORBIDDEN'
      USING ERRCODE = 'P0001';
  END IF;
  IF ROW(
    NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.channel_definition_id,
    NEW.endpoint_url, NEW.receipt_url, NEW.algorithm, NEW.key_id,
    NEW.verification_reference, NEW.challenge, NEW.challenge_expires_at,
    NEW.receipt_challenge, NEW.receipt_challenge_expires_at,
    NEW.created_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.channel_definition_id,
    OLD.endpoint_url, OLD.receipt_url, OLD.algorithm, OLD.key_id,
    OLD.verification_reference, OLD.challenge, OLD.challenge_expires_at,
    OLD.receipt_challenge, OLD.receipt_challenge_expires_at,
    OLD.created_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_METADATA_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'VERIFIED'
    AND ROW(NEW.verified_by_user_id, NEW.verified_at)
      IS DISTINCT FROM ROW(OLD.verified_by_user_id, OLD.verified_at)
  THEN
    RAISE EXCEPTION 'SIGNED_WEBHOOK_ENDPOINT_VERIFICATION_PROOF_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER signed_webhook_endpoint_verification_mutation_guard
BEFORE UPDATE OR DELETE ON signed_webhook_endpoint_verifications
FOR EACH ROW EXECUTE FUNCTION guard_signed_webhook_endpoint_verification_mutation();

REVOKE ALL ON signed_webhook_endpoint_verifications FROM PUBLIC;
GRANT SELECT, INSERT ON signed_webhook_endpoint_verifications TO aeostudio_runtime;
GRANT UPDATE (status, verified_by_user_id, verified_at, revoked_at)
  ON signed_webhook_endpoint_verifications TO aeostudio_runtime;
