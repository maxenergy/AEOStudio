-- Task 17: tenant privacy lifecycle, export evidence, retention metadata and
-- tamper-evident audit evidence. Production S3 Object Lock, AWS Backup and
-- Secrets Manager execution are ports owned by Task 18; this migration owns
-- the transactional source of truth and the immediate freeze boundary.

ALTER TABLE tenants
  ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'ACTIVE'
    CHECK (lifecycle_state IN ('ACTIVE', 'FROZEN', 'ACTIVE_DATA_DELETED', 'TOMBSTONED')),
  ADD COLUMN access_epoch bigint NOT NULL DEFAULT 0 CHECK (access_epoch >= 0),
  ADD COLUMN frozen_at timestamptz,
  ADD COLUMN tombstoned_at timestamptz,
  ADD CONSTRAINT tenants_lifecycle_timeline_check CHECK (
    (lifecycle_state = 'ACTIVE' AND frozen_at IS NULL AND tombstoned_at IS NULL)
    OR (lifecycle_state = 'FROZEN' AND frozen_at IS NOT NULL AND tombstoned_at IS NULL)
    OR (lifecycle_state = 'ACTIVE_DATA_DELETED' AND frozen_at IS NOT NULL)
    OR (lifecycle_state = 'TOMBSTONED' AND frozen_at IS NOT NULL AND tombstoned_at IS NOT NULL)
  );

ALTER TABLE workspaces
  ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'ACTIVE'
    CHECK (lifecycle_state IN ('ACTIVE', 'FROZEN', 'ACTIVE_DATA_DELETED', 'TOMBSTONED')),
  ADD COLUMN access_epoch bigint NOT NULL DEFAULT 0 CHECK (access_epoch >= 0),
  ADD COLUMN frozen_at timestamptz,
  ADD COLUMN tombstoned_at timestamptz,
  ADD CONSTRAINT workspaces_lifecycle_timeline_check CHECK (
    (lifecycle_state = 'ACTIVE' AND frozen_at IS NULL AND tombstoned_at IS NULL)
    OR (lifecycle_state = 'FROZEN' AND frozen_at IS NOT NULL AND tombstoned_at IS NULL)
    OR (lifecycle_state = 'ACTIVE_DATA_DELETED' AND frozen_at IS NOT NULL)
    OR (lifecycle_state = 'TOMBSTONED' AND frozen_at IS NOT NULL AND tombstoned_at IS NOT NULL)
  );

-- Session identities remain encrypted at rest. A one-way subject digest is
-- separately indexed so a tenant freeze can revoke every matching session
-- without decrypting or exporting identity payloads.
ALTER TABLE auth_sessions ADD COLUMN subject_digest text;
UPDATE auth_sessions
SET subject_digest = encode(sha256(convert_to('legacy:' || token_digest, 'UTF8')), 'hex'),
    revoked_at = COALESCE(revoked_at, statement_timestamp())
WHERE subject_digest IS NULL;
ALTER TABLE auth_sessions ALTER COLUMN subject_digest SET NOT NULL;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_subject_digest_check
  CHECK (subject_digest ~ '^[a-f0-9]{64}$');
CREATE INDEX auth_sessions_active_subject_digest_idx
  ON auth_sessions (subject_digest) WHERE revoked_at IS NULL;

ALTER TABLE jobs DROP CONSTRAINT jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check CHECK (job_type IN (
  'PROFILE_READINESS', 'SITE_CRAWL', 'CONTENT_PLAN', 'ARTIFACT_GENERATION',
  'PUBLICATION', 'MEASUREMENT', 'TENANT_EXPORT', 'TENANT_DELETION', 'SECRET_LIFECYCLE'
));
ALTER TABLE jobs
  ADD COLUMN lifecycle_frozen_at timestamptz,
  ADD COLUMN lifecycle_freeze_request_id uuid,
  ADD CONSTRAINT jobs_lifecycle_freeze_pair_check CHECK (
    (lifecycle_frozen_at IS NULL) = (lifecycle_freeze_request_id IS NULL)
  );

ALTER TABLE outbox_messages
  ADD COLUMN suppressed_at timestamptz,
  ADD COLUMN suppression_reason text,
  ADD CONSTRAINT outbox_messages_suppression_pair_check CHECK (
    (suppressed_at IS NULL AND suppression_reason IS NULL)
    OR (suppressed_at IS NOT NULL AND length(suppression_reason) BETWEEN 1 AND 500)
  );

CREATE TABLE tenant_exports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  schema_version text NOT NULL CHECK (schema_version = '1.0.0'),
  status text NOT NULL DEFAULT 'ARCHIVE_PENDING'
    CHECK (status IN ('ARCHIVE_PENDING', 'ARCHIVE_READY', 'FAILED')),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz NOT NULL,
  range_from timestamptz NOT NULL,
  range_to timestamptz NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  object_ref text CHECK (object_ref IS NULL OR length(object_ref) BETWEEN 1 AND 2048),
  object_version_id text,
  object_checksum text CHECK (object_checksum IS NULL OR object_checksum ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz,
  failure_code text,
  CHECK (range_to >= range_from),
  CHECK (completed_at IS NULL OR completed_at >= requested_at),
  CHECK ((status = 'ARCHIVE_READY' AND object_ref IS NOT NULL AND completed_at IS NOT NULL)
    OR (status <> 'ARCHIVE_READY' AND object_ref IS NULL AND completed_at IS NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, request_hash),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id)
);

CREATE TABLE tenant_export_items (
  tenant_id uuid NOT NULL,
  export_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  object_kind text NOT NULL CHECK (length(object_kind) BETWEEN 1 AND 120),
  source_object_id text NOT NULL CHECK (length(source_object_id) BETWEEN 1 AND 2048),
  source_content_hash text NOT NULL CHECK (source_content_hash ~ '^[a-f0-9]{64}$'),
  exported_content_hash text NOT NULL CHECK (exported_content_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id, export_id, ordinal),
  FOREIGN KEY (tenant_id, export_id) REFERENCES tenant_exports(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workspace_id uuid,
  scope_kind text NOT NULL CHECK (scope_kind IN ('TENANT', 'WORKSPACE')),
  state text NOT NULL CHECK (state IN (
    'FROZEN', 'FINALIZING', 'ACTIVE_DATA_DELETED', 'BACKUP_DELETED',
    'TOMBSTONED', 'BLOCKED_BY_LEGAL_HOLD', 'FAILED'
  )),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  requested_membership_id uuid NOT NULL,
  requested_workspace_id uuid NOT NULL,
  requested_subject_digest text NOT NULL
    CHECK (requested_subject_digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz NOT NULL,
  frozen_at timestamptz NOT NULL,
  active_delete_by timestamptz NOT NULL,
  backup_delete_by timestamptz NOT NULL,
  secret_force_delete_by timestamptz NOT NULL,
  active_deleted_at timestamptz,
  backup_deleted_at timestamptz,
  tombstoned_at timestamptz,
  failure_code text,
  finalization_lease_token uuid,
  finalization_lease_expires_at timestamptz,
  finalization_attempt_count integer NOT NULL DEFAULT 0
    CHECK (finalization_attempt_count >= 0),
  finalization_last_claimed_at timestamptz,
  CHECK ((scope_kind = 'TENANT' AND workspace_id IS NULL)
    OR (scope_kind = 'WORKSPACE' AND workspace_id IS NOT NULL)),
  CHECK (frozen_at = requested_at),
  CHECK (secret_force_delete_by = requested_at + interval '24 hours'),
  CHECK (active_delete_by = requested_at + interval '30 days'),
  CHECK (backup_delete_by = requested_at + interval '90 days'),
  CHECK (active_deleted_at IS NULL OR active_deleted_at >= active_delete_by),
  CHECK (backup_deleted_at IS NULL OR backup_deleted_at >= backup_delete_by),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id),
  FOREIGN KEY (tenant_id, requested_workspace_id) REFERENCES workspaces(tenant_id, id)
);

CREATE UNIQUE INDEX deletion_requests_one_open_scope_idx
  ON deletion_requests (tenant_id, scope_kind, COALESCE(
    workspace_id, '00000000-0000-0000-0000-000000000000'::uuid
  ))
  WHERE state IN ('FROZEN', 'FINALIZING', 'BLOCKED_BY_LEGAL_HOLD');

CREATE TABLE deletion_tombstones (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  deletion_request_id uuid NOT NULL,
  plane text NOT NULL CHECK (plane IN ('ACTIVE', 'OBJECT', 'BACKUP', 'SECRET')),
  status text NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'LEGAL_HOLD')),
  due_at timestamptz NOT NULL,
  completed_at timestamptz,
  evidence_hash text CHECK (evidence_hash IS NULL OR evidence_hash ~ '^[a-f0-9]{64}$'),
  failure_code text,
  UNIQUE (tenant_id, deletion_request_id, plane),
  FOREIGN KEY (tenant_id, deletion_request_id)
    REFERENCES deletion_requests(tenant_id, id)
);

CREATE TABLE managed_object_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workspace_id uuid,
  object_class text NOT NULL CHECK (object_class IN (
    'ACTIVE_TENANT_DATA', 'BACKUP_COPY', 'RAW_PROMPT_RESPONSE', 'CRAWL_SNAPSHOT',
    'SCREENSHOT', 'APPLICATION_LOG', 'AUDIT_DIGEST', 'ARTIFACT_PAYLOAD',
    'CHANNEL_PACKAGE', 'EVIDENCE_SNAPSHOT', 'TENANT_EXPORT'
  )),
  object_ref text NOT NULL CHECK (length(object_ref) BETWEEN 1 AND 2048),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
  object_version_id text NOT NULL CHECK (length(object_version_id) BETWEEN 1 AND 1024),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  byte_length bigint NOT NULL DEFAULT 0 CHECK (byte_length >= 0),
  lifecycle_state text NOT NULL DEFAULT 'ACTIVE'
    CHECK (lifecycle_state IN ('ACTIVE', 'DELETE_DUE', 'DELETED', 'LEGAL_HOLD')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  locked_until timestamptz,
  deletion_request_id uuid,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, object_key, object_version_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id),
  FOREIGN KEY (tenant_id, deletion_request_id) REFERENCES deletion_requests(tenant_id, id)
);

CREATE TABLE legal_holds (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  visible_to_tenant boolean NOT NULL DEFAULT true CHECK (visible_to_tenant),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED')),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  released_at timestamptz,
  audit_event_id uuid NOT NULL,
  release_audit_event_id uuid,
  CHECK ((status = 'ACTIVE' AND released_at IS NULL)
    OR (status = 'RELEASED' AND released_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id)
);

CREATE TABLE legal_hold_object_versions (
  tenant_id uuid NOT NULL,
  hold_id uuid NOT NULL,
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
  object_version_id text NOT NULL CHECK (length(object_version_id) BETWEEN 1 AND 1024),
  PRIMARY KEY (tenant_id, hold_id, object_key, object_version_id),
  FOREIGN KEY (tenant_id, hold_id) REFERENCES legal_holds(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE connector_secret_deletions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workspace_id uuid NOT NULL,
  channel_authorization_id uuid NOT NULL,
  secret_reference text CHECK (
    secret_reference IS NULL OR length(secret_reference) BETWEEN 1 AND 2048
  ),
  secret_reference_hash text CHECK (
    secret_reference_hash IS NULL OR secret_reference_hash ~ '^[a-f0-9]{64}$'
  ),
  state text NOT NULL CHECK (state IN (
    'REVOKED_PENDING_FORCE_DELETE', 'FORCE_DELETE_REQUESTED',
    'VERIFIED_UNREADABLE', 'FAILED'
  )),
  deletion_request_id uuid NOT NULL,
  revoked_at timestamptz NOT NULL,
  force_delete_at timestamptz NOT NULL,
  force_delete_requested_at timestamptz,
  verified_unreadable_at timestamptz,
  failure_code text,
  work_lease_token uuid,
  work_lease_expires_at timestamptz,
  work_attempt_count integer NOT NULL DEFAULT 0 CHECK (work_attempt_count >= 0),
  work_last_claimed_at timestamptz,
  PRIMARY KEY (tenant_id, channel_authorization_id),
  CHECK ((secret_reference IS NULL) <> (secret_reference_hash IS NULL)),
  CHECK (force_delete_at = revoked_at + interval '24 hours'),
  FOREIGN KEY (tenant_id, deletion_request_id) REFERENCES deletion_requests(tenant_id, id)
);

-- The live authorization row no longer retains a recoverable secret reference
-- after deletion is requested. The deletion work ledger keeps the original ARN
-- only until the provider proves it unreadable.
ALTER TABLE channel_authorizations
  ALTER COLUMN secret_arn DROP NOT NULL,
  ADD COLUMN secret_arn_hash text CHECK (
    secret_arn_hash IS NULL OR secret_arn_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT channel_authorizations_secret_reference_exclusive
    CHECK ((secret_arn IS NULL) <> (secret_arn_hash IS NULL));

CREATE OR REPLACE FUNCTION guard_channel_authorization_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_DELETE_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;

  IF current_setting('app.secret_deletion_transition', true) = 'authorized' THEN
    IF NEW.status <> 'REVOKED'
       OR NEW.secret_arn IS NOT NULL
       OR NEW.secret_arn_hash IS DISTINCT FROM COALESCE(
         OLD.secret_arn_hash,
         encode(sha256(convert_to(OLD.secret_arn, 'UTF8')), 'hex')
       )
       OR to_jsonb(NEW) - ARRAY[
         'status', 'secret_arn', 'secret_arn_hash', 'updated_at'
       ]::text[] IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY[
         'status', 'secret_arn', 'secret_arn_hash', 'updated_at'
       ]::text[]
       OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_SECRET_REDACTION_INVALID'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_TRANSITION_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
  IF ROW(
    NEW.id, NEW.tenant_id, NEW.workspace_id, NEW.adapter_version_id, NEW.secret_arn,
    NEW.secret_arn_hash, NEW.granted_scopes, NEW.accepted_terms_version, NEW.target,
    NEW.expires_at, NEW.created_by_user_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.tenant_id, OLD.workspace_id, OLD.adapter_version_id, OLD.secret_arn,
    OLD.secret_arn_hash, OLD.granted_scopes, OLD.accepted_terms_version, OLD.target,
    OLD.expires_at, OLD.created_by_user_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_METADATA_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'CHANNEL_AUTHORIZATION_TIME_REGRESSION' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TABLE break_glass_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workspace_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  operator_name text NOT NULL CHECK (length(btrim(operator_name)) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  requested_action text NOT NULL CHECK (length(btrim(requested_action)) BETWEEN 1 AND 160),
  resource_type text NOT NULL CHECK (length(btrim(resource_type)) BETWEEN 1 AND 160),
  resource_id text NOT NULL CHECK (length(btrim(resource_id)) BETWEEN 1 AND 500),
  granted_by_principal_id text NOT NULL
    CHECK (length(btrim(granted_by_principal_id)) BETWEEN 1 AND 240),
  audit_event_id uuid NOT NULL,
  granted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_audit_event_id uuid,
  CHECK (expires_at > granted_at),
  CHECK (expires_at <= granted_at + interval '24 hours'),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id)
);

CREATE TABLE audit_chain_heads (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
  last_hash text NOT NULL CHECK (last_hash ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL
);

CREATE TABLE audit_digests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workspace_id uuid NOT NULL,
  schema_version text NOT NULL CHECK (schema_version = 'audit-digest.v1'),
  range_from timestamptz NOT NULL,
  range_to timestamptz NOT NULL,
  event_count bigint NOT NULL CHECK (event_count >= 0),
  last_sequence bigint NOT NULL CHECK (last_sequence >= 0),
  head_hash text CHECK (head_hash IS NULL OR head_hash ~ '^[a-f0-9]{64}$'),
  digest_hash text NOT NULL CHECK (digest_hash ~ '^[a-f0-9]{64}$'),
  object_ref text NOT NULL CHECK (length(object_ref) BETWEEN 1 AND 2048),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
  object_version_id text NOT NULL CHECK (length(object_version_id) BETWEEN 1 AND 1024),
  locked_until timestamptz NOT NULL,
  sealed_at timestamptz NOT NULL,
  audit_event_id uuid NOT NULL,
  CHECK (range_to >= range_from),
  CHECK (locked_until >= sealed_at + interval '365 days'),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, range_from, range_to),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id)
);

-- Every tenant-owned Task 17 relation uses the same forced-RLS boundary as the
-- rest of the product. SECURITY DEFINER functions below expose only narrowly
-- scoped lifecycle operations.
ALTER TABLE tenant_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_exports FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_export_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_export_items FORCE ROW LEVEL SECURITY;
ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE deletion_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_object_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_object_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE legal_hold_object_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_hold_object_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE connector_secret_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_secret_deletions FORCE ROW LEVEL SECURITY;
ALTER TABLE break_glass_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE break_glass_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_digests FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_export_isolation ON tenant_exports
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY tenant_export_item_isolation ON tenant_export_items
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY deletion_request_isolation ON deletion_requests
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY deletion_tombstone_isolation ON deletion_tombstones
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY managed_object_version_isolation ON managed_object_versions
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY legal_hold_isolation ON legal_holds
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY legal_hold_object_version_isolation ON legal_hold_object_versions
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY connector_secret_deletion_isolation ON connector_secret_deletions
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY break_glass_grant_isolation ON break_glass_grants
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY audit_chain_head_isolation ON audit_chain_heads
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
CREATE POLICY audit_digest_isolation ON audit_digests
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

-- Audit actor attribution is explicit for human users, autonomous agents,
-- system work and named support operators. actor_principal_id is textual so a
-- platform principal need not be forged into a product User UUID.
DROP TRIGGER audit_actor_normalization ON audit_events;
DROP FUNCTION normalize_audit_actor();
ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_kind_check;
ALTER TABLE audit_events ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE audit_events ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_actor_kind_check
    CHECK (actor_kind IN ('USER', 'AGENT', 'SYSTEM', 'SUPPORT', 'PLATFORM_OPERATOR')),
  ADD COLUMN actor_principal_kind text,
  ADD COLUMN actor_principal_id text,
  ADD COLUMN schema_version text NOT NULL DEFAULT 'audit-event.v1',
  ADD COLUMN chain_sequence bigint,
  ADD COLUMN previous_hash text,
  ADD COLUMN event_hash text;

UPDATE audit_events
SET actor_principal_kind = actor_kind,
    actor_principal_id = COALESCE(actor_id::text, actor_user_id::text)
WHERE actor_principal_id IS NULL;
ALTER TABLE audit_events ALTER COLUMN actor_principal_kind SET NOT NULL;
ALTER TABLE audit_events ALTER COLUMN actor_principal_id SET NOT NULL;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_principal_kind_check
  CHECK (actor_principal_kind IN ('USER', 'AGENT', 'SYSTEM', 'SUPPORT', 'PLATFORM_OPERATOR'));
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_principal_id_check
  CHECK (length(btrim(actor_principal_id)) BETWEEN 1 AND 240);

CREATE FUNCTION aeostudio_audit_hash(p_event jsonb, p_previous_hash text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $function$
  SELECT encode(
    sha256(convert_to(
      jsonb_build_object(
        'event', p_event - ARRAY['chain_sequence', 'previous_hash', 'event_hash']::text[],
        'previousHash', p_previous_hash
      )::text,
      'UTF8'
    )),
    'hex'
  )
$function$;

-- Backfill the historical stream deterministically before enforcing NOT NULL.
DO $migration$
DECLARE
  event_row audit_events%ROWTYPE;
  current_tenant uuid;
  next_sequence bigint := 0;
  previous_digest text := repeat('0', 64);
  calculated_digest text;
BEGIN
  FOR event_row IN
    SELECT * FROM audit_events ORDER BY tenant_id, occurred_at, id
  LOOP
    IF current_tenant IS DISTINCT FROM event_row.tenant_id THEN
      IF current_tenant IS NOT NULL THEN
        INSERT INTO audit_chain_heads (tenant_id, last_sequence, last_hash, updated_at)
        VALUES (current_tenant, next_sequence, previous_digest, statement_timestamp());
      END IF;
      current_tenant := event_row.tenant_id;
      next_sequence := 0;
      previous_digest := repeat('0', 64);
    END IF;
    next_sequence := next_sequence + 1;
    event_row.chain_sequence := next_sequence;
    event_row.previous_hash := previous_digest;
    calculated_digest := aeostudio_audit_hash(to_jsonb(event_row), previous_digest);
    UPDATE audit_events
      SET chain_sequence = next_sequence,
          previous_hash = previous_digest,
          event_hash = calculated_digest
      WHERE id = event_row.id;
    previous_digest := calculated_digest;
  END LOOP;
  IF current_tenant IS NOT NULL THEN
    INSERT INTO audit_chain_heads (tenant_id, last_sequence, last_hash, updated_at)
    VALUES (current_tenant, next_sequence, previous_digest, statement_timestamp());
  END IF;
  INSERT INTO audit_chain_heads (tenant_id, last_sequence, last_hash, updated_at)
  SELECT tenant.id, 0, repeat('0', 64), statement_timestamp()
  FROM tenants tenant
  WHERE NOT EXISTS (
    SELECT 1 FROM audit_chain_heads head WHERE head.tenant_id = tenant.id
  );
END
$migration$;

ALTER TABLE audit_events ALTER COLUMN chain_sequence SET NOT NULL;
ALTER TABLE audit_events ALTER COLUMN previous_hash SET NOT NULL;
ALTER TABLE audit_events ALTER COLUMN event_hash SET NOT NULL;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_previous_hash_check
  CHECK (previous_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_hash_check
  CHECK (event_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE audit_events ADD CONSTRAINT audit_events_chain_sequence_unique
  UNIQUE (tenant_id, chain_sequence);

CREATE FUNCTION append_audit_chain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  chain_head public.audit_chain_heads%ROWTYPE;
BEGIN
  IF NEW.actor_kind = 'USER' THEN
    IF NEW.actor_user_id IS NULL THEN
      RAISE EXCEPTION 'AUDIT_USER_ACTOR_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    NEW.actor_id := NEW.actor_user_id;
    NEW.actor_principal_kind := 'USER';
    NEW.actor_principal_id := NEW.actor_user_id::text;
  ELSIF NEW.actor_kind = 'AGENT' THEN
    IF NEW.actor_id IS NULL THEN
      RAISE EXCEPTION 'AUDIT_AGENT_ACTOR_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    NEW.actor_principal_kind := 'AGENT';
    NEW.actor_principal_id := NEW.actor_id::text;
  ELSE
    NEW.actor_principal_kind := NEW.actor_kind;
    IF NEW.actor_principal_id IS NULL OR btrim(NEW.actor_principal_id) = '' THEN
      RAISE EXCEPTION 'AUDIT_NAMED_PRINCIPAL_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.audit_chain_heads (tenant_id, last_sequence, last_hash, updated_at)
  VALUES (NEW.tenant_id, 0, repeat('0', 64), NEW.occurred_at)
  ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO chain_head
  FROM public.audit_chain_heads
  WHERE tenant_id = NEW.tenant_id
  FOR UPDATE;

  NEW.schema_version := 'audit-event.v1';
  NEW.chain_sequence := chain_head.last_sequence + 1;
  NEW.previous_hash := chain_head.last_hash;
  NEW.event_hash := public.aeostudio_audit_hash(to_jsonb(NEW), NEW.previous_hash);

  UPDATE public.audit_chain_heads
  SET last_sequence = NEW.chain_sequence,
      last_hash = NEW.event_hash,
      updated_at = NEW.occurred_at
  WHERE tenant_id = NEW.tenant_id;
  RETURN NEW;
END
$function$;

CREATE FUNCTION reject_audit_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'AUDIT_EVIDENCE_APPEND_ONLY' USING ERRCODE = 'P0001';
END
$function$;

CREATE TRIGGER audit_chain_append
BEFORE INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION append_audit_chain();
CREATE TRIGGER audit_evidence_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_evidence_mutation();

CREATE FUNCTION append_tenant_auth_session_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  event_action text;
  event_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    event_action := 'AUTH_SESSION_STARTED';
    event_at := LEAST(NEW.created_at, clock_timestamp());
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    event_action := 'AUTH_SESSION_REVOKED';
    event_at := LEAST(NEW.revoked_at, clock_timestamp());
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_events (
    id, tenant_id, workspace_id, actor_user_id, actor_kind, action,
    resource_type, resource_id, outcome, metadata, occurred_at
  )
  SELECT (
      overlay(overlay(md5(
        NEW.token_digest || ':' || candidate.tenant_id::text || ':' ||
        candidate.workspace_id::text || ':' || event_action
      ) placing '4' from 13 for 1) placing '8' from 17 for 1)
    )::uuid,
    candidate.tenant_id, candidate.workspace_id, candidate.user_id, 'USER',
    event_action, 'AUTH_SESSION', NULL, 'SUCCEEDED', '{}'::jsonb, event_at
  FROM (
    SELECT membership.tenant_id, binding.workspace_id, identity.user_id
    FROM public.external_identities identity
    JOIN public.memberships membership
      ON membership.user_id = identity.user_id AND membership.status = 'ACTIVE'
    JOIN public.role_bindings binding
      ON binding.tenant_id = membership.tenant_id
     AND binding.membership_id = membership.id
    JOIN public.tenants tenant
      ON tenant.id = membership.tenant_id
     AND tenant.lifecycle_state IN ('ACTIVE', 'FROZEN')
    JOIN public.workspaces workspace
      ON workspace.tenant_id = binding.tenant_id
     AND workspace.id = binding.workspace_id
     AND workspace.lifecycle_state IN ('ACTIVE', 'FROZEN')
    WHERE encode(sha256(convert_to(identity.subject, 'UTF8')), 'hex') = NEW.subject_digest

    UNION

    -- Active data deletion removes memberships, but the deleting Owner remains
    -- a named privacy steward. The retained one-way digest maps login evidence
    -- without restoring product access or retaining plaintext identity data.
    SELECT request.tenant_id, request.requested_workspace_id,
      request.requested_by_user_id
    FROM public.deletion_requests request
    WHERE request.requested_subject_digest = NEW.subject_digest
      AND request.state IN (
        'FROZEN', 'FINALIZING', 'ACTIVE_DATA_DELETED', 'BACKUP_DELETED',
        'BLOCKED_BY_LEGAL_HOLD'
      )
  ) candidate
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END
$function$;

CREATE TRIGGER auth_session_started_audit
AFTER INSERT ON auth_sessions
FOR EACH ROW EXECUTE FUNCTION append_tenant_auth_session_audit();
CREATE TRIGGER auth_session_revoked_audit
AFTER UPDATE OF revoked_at ON auth_sessions
FOR EACH ROW
WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION append_tenant_auth_session_audit();

CREATE FUNCTION backfill_tenant_auth_session_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  INSERT INTO public.audit_events (
    id, tenant_id, workspace_id, actor_user_id, actor_kind, action,
    resource_type, resource_id, outcome, metadata, occurred_at
  )
  SELECT (
      overlay(overlay(md5(
        session.token_digest || ':' || NEW.tenant_id::text || ':' ||
        NEW.workspace_id::text || ':AUTH_SESSION_STARTED'
      ) placing '4' from 13 for 1) placing '8' from 17 for 1)
    )::uuid,
    NEW.tenant_id, NEW.workspace_id, membership.user_id, 'USER',
    'AUTH_SESSION_STARTED', 'AUTH_SESSION', NULL, 'SUCCEEDED', '{}'::jsonb,
    LEAST(session.created_at, clock_timestamp())
  FROM public.memberships membership
  JOIN public.external_identities identity ON identity.user_id = membership.user_id
  JOIN public.auth_sessions session
    ON session.subject_digest = encode(
      sha256(convert_to(identity.subject, 'UTF8')), 'hex'
    )
   AND session.revoked_at IS NULL
   AND session.expires_at > clock_timestamp()
  JOIN public.tenants tenant
    ON tenant.id = NEW.tenant_id AND tenant.lifecycle_state = 'ACTIVE'
  JOIN public.workspaces workspace
    ON workspace.tenant_id = NEW.tenant_id
   AND workspace.id = NEW.workspace_id
   AND workspace.lifecycle_state = 'ACTIVE'
  WHERE membership.tenant_id = NEW.tenant_id
    AND membership.id = NEW.membership_id
    AND membership.status = 'ACTIVE'
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END
$function$;

CREATE TRIGGER role_binding_auth_session_audit
AFTER INSERT ON role_bindings
FOR EACH ROW EXECUTE FUNCTION backfill_tenant_auth_session_audit();

CREATE OR REPLACE FUNCTION verify_audit_chain(p_tenant_id uuid)
RETURNS TABLE (
  valid boolean,
  event_count bigint,
  last_sequence bigint,
  head_hash text,
  failure_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  event_row public.audit_events%ROWTYPE;
  chain_head public.audit_chain_heads%ROWTYPE;
  expected_sequence bigint := 0;
  expected_previous text := repeat('0', 64);
  expected_hash text;
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid
       IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'AUDIT_TENANT_CONTEXT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO chain_head FROM public.audit_chain_heads WHERE tenant_id = p_tenant_id;
  FOR event_row IN
    SELECT * FROM public.audit_events
    WHERE tenant_id = p_tenant_id
    ORDER BY chain_sequence
  LOOP
    expected_sequence := expected_sequence + 1;
    expected_hash := public.aeostudio_audit_hash(to_jsonb(event_row), expected_previous);
    IF event_row.chain_sequence <> expected_sequence
       OR event_row.previous_hash IS DISTINCT FROM expected_previous
       OR event_row.event_hash IS DISTINCT FROM expected_hash THEN
      RETURN QUERY SELECT false, expected_sequence, event_row.chain_sequence,
        event_row.event_hash, 'audit chain digest mismatch or tamper detected'::text;
      RETURN;
    END IF;
    expected_previous := expected_hash;
  END LOOP;
  IF chain_head.tenant_id IS NULL
     OR chain_head.last_sequence IS DISTINCT FROM expected_sequence
     OR chain_head.last_hash IS DISTINCT FROM expected_previous THEN
    RETURN QUERY SELECT false, expected_sequence, chain_head.last_sequence,
      chain_head.last_hash, 'audit chain head digest mismatch or tamper detected'::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, expected_sequence, expected_sequence,
    expected_previous, NULL::text;
END
$function$;

CREATE OR REPLACE FUNCTION verify_audit_range(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  valid boolean,
  event_count bigint,
  last_sequence bigint,
  head_hash text,
  failure_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  chain_verification record;
  range_event_count bigint;
  range_last_sequence bigint;
  range_head_hash text;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'AUDIT_RANGE_INVALID' USING ERRCODE = '22007';
  END IF;
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid
       IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'AUDIT_TENANT_CONTEXT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO chain_verification
  FROM public.verify_audit_chain(p_tenant_id);
  IF chain_verification.valid IS DISTINCT FROM true THEN
    -- A range summary is not trustworthy when any link in its Tenant chain
    -- has failed validation, including links before the selected interval.
    RETURN QUERY SELECT false, 0::bigint, 0::bigint, NULL::text,
      COALESCE(
        chain_verification.failure_reason,
        'audit chain verification failed before range summarization'
      )::text;
    RETURN;
  END IF;

  SELECT count(*), COALESCE(max(event.chain_sequence), 0)
  INTO range_event_count, range_last_sequence
  FROM public.audit_events event
  WHERE event.tenant_id = p_tenant_id
    AND event.occurred_at >= p_from
    AND event.occurred_at <= p_to;

  IF range_event_count = 0 THEN
    -- Empty ranges have no selected chain prefix head.
    RETURN QUERY SELECT true, 0::bigint, 0::bigint, NULL::text, NULL::text;
    RETURN;
  END IF;
  SELECT event.event_hash INTO range_head_hash
  FROM public.audit_events event
  WHERE event.tenant_id = p_tenant_id
    AND event.chain_sequence = range_last_sequence;
  RETURN QUERY SELECT true, range_event_count, range_last_sequence,
    range_head_hash, NULL::text;
END
$function$;

-- Hold the Tenant chain head for the caller's transaction while deriving the
-- exact range snapshot and retention timestamps from the database clock. Audit
-- appends take the same row lock, so no event can interleave between this
-- verification and the digest/audit inserts performed by the store.
CREATE FUNCTION prepare_audit_digest_seal(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  status text,
  event_count bigint,
  last_sequence bigint,
  head_hash text,
  failure_reason text,
  sealed_at timestamptz,
  locked_until timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  verification record;
  database_now timestamptz;
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid
       IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'AUDIT_TENANT_CONTEXT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RETURN QUERY SELECT 'INVALID_TIME_RANGE'::text, 0::bigint, 0::bigint,
      NULL::text, 'audit range is invalid'::text, NULL::timestamptz,
      NULL::timestamptz;
    RETURN;
  END IF;

  PERFORM 1
  FROM public.audit_chain_heads chain_head
  WHERE chain_head.tenant_id = p_tenant_id
  FOR UPDATE;
  database_now := clock_timestamp();
  IF p_to >= database_now THEN
    RETURN QUERY SELECT 'INVALID_TIME_RANGE'::text, 0::bigint, 0::bigint,
      NULL::text, 'audit range must end before the database seal time'::text,
      NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO verification
  FROM public.verify_audit_range(p_tenant_id, p_from, p_to);
  IF verification.valid IS DISTINCT FROM true THEN
    RETURN QUERY SELECT 'TAMPERED'::text,
      COALESCE(verification.event_count, 0)::bigint,
      COALESCE(verification.last_sequence, 0)::bigint,
      verification.head_hash,
      COALESCE(
        verification.failure_reason,
        'audit chain verification failed before digest sealing'
      )::text,
      NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'READY'::text, verification.event_count::bigint,
    verification.last_sequence::bigint, verification.head_hash, NULL::text,
    database_now, database_now + interval '365 days';
END
$function$;

CREATE FUNCTION lifecycle_mutation_is_authorized(
  p_tenant_id uuid,
  p_workspace_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT current_user <> 'aeostudio_runtime'
    AND EXISTS (
      SELECT 1
      FROM public.deletion_requests request
      WHERE request.id = NULLIF(current_setting('app.lifecycle_request_id', true), '')::uuid
        AND request.tenant_id = p_tenant_id
        AND request.state IN (
          'FROZEN', 'FINALIZING', 'ACTIVE_DATA_DELETED', 'BACKUP_DELETED',
          'BLOCKED_BY_LEGAL_HOLD'
        )
        AND (
          request.scope_kind = 'TENANT'
          OR p_workspace_id IS NULL
          OR request.workspace_id = p_workspace_id
        )
    )
$function$;

CREATE FUNCTION guard_lifecycle_state_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  row_tenant_id uuid;
  row_workspace_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'tenants' THEN
    row_tenant_id := OLD.id;
    row_workspace_id := NULL;
  ELSE
    row_tenant_id := OLD.tenant_id;
    row_workspace_id := OLD.id;
  END IF;
  IF ROW(NEW.lifecycle_state, NEW.access_epoch, NEW.frozen_at, NEW.tombstoned_at)
     IS DISTINCT FROM
     ROW(OLD.lifecycle_state, OLD.access_epoch, OLD.frozen_at, OLD.tombstoned_at) THEN
    IF NOT public.lifecycle_mutation_is_authorized(row_tenant_id, row_workspace_id) THEN
      RAISE EXCEPTION 'LIFECYCLE_STATE_MUTATION_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER tenant_lifecycle_mutation_guard
BEFORE UPDATE ON tenants
FOR EACH ROW EXECUTE FUNCTION guard_lifecycle_state_mutation();
CREATE TRIGGER workspace_lifecycle_mutation_guard
BEFORE UPDATE ON workspaces
FOR EACH ROW EXECUTE FUNCTION guard_lifecycle_state_mutation();

CREATE FUNCTION guard_frozen_job_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.lifecycle_frozen_at IS NOT NULL THEN
    RAISE EXCEPTION 'JOB_LIFECYCLE_FROZEN' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.lifecycle_frozen_at IS NOT NULL THEN
    IF NOT public.lifecycle_mutation_is_authorized(NEW.tenant_id, NEW.workspace_id) THEN
      RAISE EXCEPTION 'JOB_LIFECYCLE_FREEZE_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER frozen_job_mutation_guard
BEFORE UPDATE ON jobs
FOR EACH ROW EXECUTE FUNCTION guard_frozen_job_mutation();

CREATE FUNCTION guard_suppressed_outbox_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.suppressed_at IS NOT NULL THEN
    RAISE EXCEPTION 'OUTBOX_LIFECYCLE_SUPPRESSED' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.suppressed_at IS NOT NULL THEN
    IF NOT public.lifecycle_mutation_is_authorized(NEW.tenant_id, NEW.workspace_id) THEN
      RAISE EXCEPTION 'OUTBOX_LIFECYCLE_SUPPRESSION_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER suppressed_outbox_mutation_guard
BEFORE UPDATE ON outbox_messages
FOR EACH ROW EXECUTE FUNCTION guard_suppressed_outbox_mutation();

CREATE OR REPLACE FUNCTION list_pending_job_outbox(p_limit integer)
RETURNS TABLE (
  message_id uuid,
  tenant_id uuid,
  workspace_id uuid,
  payload jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT message.id, message.tenant_id, message.workspace_id, message.payload
  FROM public.outbox_messages message
  JOIN public.jobs job
    ON job.id = message.aggregate_id
   AND job.tenant_id = message.tenant_id
   AND job.workspace_id = message.workspace_id
  JOIN public.tenants tenant ON tenant.id = message.tenant_id
  JOIN public.workspaces workspace
    ON workspace.tenant_id = message.tenant_id AND workspace.id = message.workspace_id
  WHERE message.published_at IS NULL
    AND message.suppressed_at IS NULL
    AND message.message_type = 'JOB_QUEUED'
    AND job.lifecycle_frozen_at IS NULL
    AND tenant.lifecycle_state = 'ACTIVE'
    AND workspace.lifecycle_state = 'ACTIVE'
  ORDER BY message.created_at, message.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$function$;

-- A relay can read an outbox row just before a deletion transaction commits.
-- Its later acknowledgement must become a no-op once that row, Job, or scope
-- is frozen; it must never mutate lifecycle-suppressed evidence.
CREATE OR REPLACE FUNCTION mark_job_outbox_published(
  p_message_id uuid,
  p_tenant_id uuid,
  p_published_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  UPDATE public.outbox_messages message
    SET published_at = p_published_at
    FROM public.jobs job, public.tenants tenant, public.workspaces workspace
    WHERE message.id = p_message_id
      AND message.tenant_id = p_tenant_id
      AND message.published_at IS NULL
      AND message.suppressed_at IS NULL
      AND job.id = message.aggregate_id
      AND job.tenant_id = message.tenant_id
      AND job.workspace_id = message.workspace_id
      AND job.lifecycle_frozen_at IS NULL
      AND tenant.id = message.tenant_id
      AND tenant.lifecycle_state = 'ACTIVE'
      AND workspace.tenant_id = message.tenant_id
      AND workspace.id = message.workspace_id
      AND workspace.lifecycle_state = 'ACTIVE';
END
$function$;

CREATE OR REPLACE FUNCTION list_pending_measurement_job_outbox(p_limit integer)
RETURNS TABLE (
  message_id uuid,
  tenant_id uuid,
  workspace_id uuid,
  payload jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT message.id, message.tenant_id, message.workspace_id, message.payload
  FROM public.outbox_messages message
  JOIN public.jobs job
    ON job.id = message.aggregate_id
   AND job.tenant_id = message.tenant_id
   AND job.workspace_id = message.workspace_id
  JOIN public.tenants tenant ON tenant.id = message.tenant_id
  JOIN public.workspaces workspace
    ON workspace.tenant_id = message.tenant_id AND workspace.id = message.workspace_id
  WHERE message.published_at IS NULL
    AND message.suppressed_at IS NULL
    AND message.message_type = 'JOB_QUEUED'
    AND job.job_type = 'MEASUREMENT'
    AND job.lifecycle_frozen_at IS NULL
    AND tenant.lifecycle_state = 'ACTIVE'
    AND workspace.lifecycle_state = 'ACTIVE'
    AND (
      job.status IN ('SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED')
      OR (
        (
          job.status = 'QUEUED'
          OR (job.status = 'RUNNING'
            AND (job.lease_expires_at IS NULL
              OR job.lease_expires_at < statement_timestamp()))
          OR (job.status = 'RETRY_WAIT'
            AND (job.next_attempt_at IS NULL
              OR job.next_attempt_at <= statement_timestamp()))
        )
        AND (
          SELECT count(*)
          FROM public.jobs active_job
          WHERE active_job.tenant_id = job.tenant_id
            AND active_job.status = 'RUNNING'
            AND active_job.lifecycle_frozen_at IS NULL
            AND active_job.lease_expires_at >= statement_timestamp()
            AND active_job.id <> job.id
        ) < 5
      )
    )
  ORDER BY
    CASE job.status
      WHEN 'RUNNING' THEN COALESCE(job.lease_expires_at, message.created_at)
      WHEN 'RETRY_WAIT' THEN COALESCE(job.next_attempt_at, message.created_at)
      ELSE message.created_at
    END,
    message.created_at,
    message.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$function$;

DROP INDEX measurement_outbox_pending_order_idx;
CREATE INDEX measurement_outbox_pending_order_idx
  ON outbox_messages (created_at, id, aggregate_id)
  WHERE published_at IS NULL AND suppressed_at IS NULL AND message_type = 'JOB_QUEUED';

CREATE OR REPLACE FUNCTION resolve_active_workspace_membership(
  p_subject text,
  p_tenant_id uuid,
  p_workspace_id uuid
)
RETURNS TABLE (user_id uuid, membership_id uuid, role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  RETURN QUERY
    SELECT identity.user_id, membership.id, binding.role
    FROM public.external_identities identity
    JOIN public.memberships membership
      ON membership.user_id = identity.user_id
     AND membership.tenant_id = p_tenant_id
     AND membership.status = 'ACTIVE'
    JOIN public.role_bindings binding
      ON binding.tenant_id = membership.tenant_id
     AND binding.membership_id = membership.id
     AND binding.workspace_id = p_workspace_id
    JOIN public.tenants tenant ON tenant.id = membership.tenant_id
    JOIN public.workspaces workspace
      ON workspace.tenant_id = binding.tenant_id AND workspace.id = binding.workspace_id
    WHERE identity.subject = p_subject
      AND tenant.lifecycle_state = 'ACTIVE'
      AND workspace.lifecycle_state = 'ACTIVE';
END
$function$;

CREATE OR REPLACE FUNCTION list_actor_workspaces(p_subject text)
RETURNS TABLE (
  tenant_id uuid,
  tenant_name text,
  workspace_id uuid,
  workspace_name text,
  membership_id uuid,
  role text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT tenant.id, tenant.name, workspace.id, workspace.name, membership.id, binding.role
  FROM public.external_identities identity
  JOIN public.memberships membership
    ON membership.user_id = identity.user_id AND membership.status = 'ACTIVE'
  JOIN public.tenants tenant
    ON tenant.id = membership.tenant_id AND tenant.lifecycle_state = 'ACTIVE'
  JOIN public.role_bindings binding
    ON binding.tenant_id = membership.tenant_id
   AND binding.membership_id = membership.id
  JOIN public.workspaces workspace
    ON workspace.tenant_id = binding.tenant_id
   AND workspace.id = binding.workspace_id
   AND workspace.lifecycle_state = 'ACTIVE'
  WHERE identity.subject = p_subject
  ORDER BY workspace.created_at DESC, workspace.id
$function$;

CREATE FUNCTION resolve_privacy_tenant_owner(
  p_subject text,
  p_tenant_id uuid,
  p_workspace_id uuid DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid,
  membership_id uuid,
  workspace_id uuid,
  tenant_lifecycle_state text,
  workspace_lifecycle_state text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT identity.user_id, membership.id, workspace.id,
    tenant.lifecycle_state, workspace.lifecycle_state
  FROM public.external_identities identity
  JOIN public.memberships membership
    ON membership.user_id = identity.user_id
   AND membership.tenant_id = p_tenant_id
   AND membership.status = 'ACTIVE'
  JOIN public.role_bindings binding
    ON binding.tenant_id = membership.tenant_id
   AND binding.membership_id = membership.id
   AND binding.role = 'OWNER'
  JOIN public.tenants tenant ON tenant.id = membership.tenant_id
  JOIN public.workspaces workspace
    ON workspace.tenant_id = binding.tenant_id AND workspace.id = binding.workspace_id
  WHERE identity.subject = p_subject
    AND (p_workspace_id IS NULL OR workspace.id = p_workspace_id)
  ORDER BY workspace.created_at, workspace.id
  LIMIT 1
$function$;

-- Privacy governance deliberately remains separate from the ordinary active-only
-- TenantContext resolver. The original deleting Owner remains the named steward
-- for visible holds and audit evidence after active memberships are purged.
CREATE FUNCTION resolve_privacy_governance_owner(
  p_subject text,
  p_tenant_id uuid,
  p_workspace_id uuid
)
RETURNS TABLE (user_id uuid, membership_id uuid, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT candidate.user_id, candidate.membership_id, 'OWNER'::text
  FROM (
    SELECT owner.user_id, owner.membership_id, 0 AS priority
    FROM public.resolve_privacy_tenant_owner(p_subject, p_tenant_id, p_workspace_id) owner
    UNION ALL
    SELECT request.requested_by_user_id, request.requested_membership_id, 1 AS priority
    FROM public.deletion_requests request
    JOIN public.workspaces workspace
      ON workspace.tenant_id = request.tenant_id AND workspace.id = p_workspace_id
    WHERE request.requested_subject_digest = encode(
        sha256(convert_to(p_subject, 'UTF8')), 'hex'
      )
      AND request.tenant_id = p_tenant_id
      AND request.state IN (
        'FROZEN', 'FINALIZING', 'ACTIVE_DATA_DELETED', 'BACKUP_DELETED',
        'BLOCKED_BY_LEGAL_HOLD'
      )
      AND (request.scope_kind = 'TENANT' OR request.workspace_id = p_workspace_id)
  ) candidate
  ORDER BY candidate.priority
  LIMIT 1
$function$;

CREATE FUNCTION grant_break_glass(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_grant_id uuid,
  p_operator_id uuid,
  p_operator_name text,
  p_reason text,
  p_expires_at timestamptz,
  p_requested_action text,
  p_resource_type text,
  p_resource_id text,
  p_audit_event_id uuid
)
RETURNS SETOF break_glass_grants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  existing_grant public.break_glass_grants%ROWTYPE;
BEGIN
  IF length(btrim(p_operator_name)) NOT BETWEEN 1 AND 200
     OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000
     OR length(btrim(p_requested_action)) NOT BETWEEN 1 AND 160
     OR length(btrim(p_resource_type)) NOT BETWEEN 1 AND 160
     OR length(btrim(p_resource_id)) NOT BETWEEN 1 AND 500
     OR p_expires_at <= database_now
     OR p_expires_at > database_now + interval '24 hours' THEN
    RAISE EXCEPTION 'BREAK_GLASS_GRANT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.tenants tenant
  JOIN public.workspaces workspace
    ON workspace.tenant_id = tenant.id AND workspace.id = p_workspace_id
  WHERE tenant.id = p_tenant_id
    AND tenant.lifecycle_state = 'ACTIVE'
    AND workspace.lifecycle_state = 'ACTIVE'
  FOR KEY SHARE OF tenant, workspace;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BREAK_GLASS_SCOPE_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO existing_grant
  FROM public.break_glass_grants grant_row
  WHERE grant_row.id = p_grant_id;
  IF existing_grant.id IS NOT NULL THEN
    IF existing_grant.tenant_id IS DISTINCT FROM p_tenant_id
       OR existing_grant.workspace_id IS DISTINCT FROM p_workspace_id
       OR existing_grant.operator_id IS DISTINCT FROM p_operator_id
       OR existing_grant.operator_name IS DISTINCT FROM btrim(p_operator_name)
       OR existing_grant.reason IS DISTINCT FROM btrim(p_reason)
       OR existing_grant.expires_at IS DISTINCT FROM p_expires_at
       OR existing_grant.requested_action IS DISTINCT FROM btrim(p_requested_action)
       OR existing_grant.resource_type IS DISTINCT FROM btrim(p_resource_type)
       OR existing_grant.resource_id IS DISTINCT FROM btrim(p_resource_id)
       OR existing_grant.audit_event_id IS DISTINCT FROM p_audit_event_id THEN
      RAISE EXCEPTION 'BREAK_GLASS_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN NEXT existing_grant;
    RETURN;
  END IF;

  INSERT INTO public.break_glass_grants (
    id, tenant_id, workspace_id, operator_id, operator_name, reason,
    requested_action, resource_type, resource_id, granted_by_principal_id,
    audit_event_id, granted_at, expires_at, revoked_at
  ) VALUES (
    p_grant_id, p_tenant_id, p_workspace_id, p_operator_id, btrim(p_operator_name),
    btrim(p_reason), btrim(p_requested_action), btrim(p_resource_type),
    btrim(p_resource_id), p_operator_id::text, p_audit_event_id, database_now,
    p_expires_at, NULL
  ) RETURNING * INTO existing_grant;

  INSERT INTO public.audit_events (
    id, tenant_id, workspace_id, actor_user_id, actor_kind, actor_principal_id,
    action, resource_type, resource_id, outcome, metadata, occurred_at
  ) VALUES (
    p_audit_event_id, p_tenant_id, p_workspace_id, NULL, 'PLATFORM_OPERATOR',
    p_operator_id::text, 'BREAK_GLASS_GRANTED', 'BREAK_GLASS_GRANT', p_grant_id,
    'SUCCEEDED', jsonb_build_object(
      'operatorId', p_operator_id,
      'requestedAction', btrim(p_requested_action),
      'resourceType', btrim(p_resource_type),
      'resourceId', btrim(p_resource_id),
      'expiresAt', p_expires_at
    ), database_now
  );
  RETURN NEXT existing_grant;
END
$function$;

CREATE FUNCTION evaluate_break_glass_access(
  p_actor_subject text,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_grant_id uuid,
  p_operator_id uuid,
  p_operator_name text,
  p_requested_action text,
  p_resource_type text,
  p_resource_id text,
  p_audit_event_id uuid
)
RETURNS TABLE (
  decision text,
  state text,
  grant_id uuid,
  operator_name text,
  reason text,
  audit_event_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  candidate public.break_glass_grants%ROWTYPE;
  actor_kind text;
  actor_principal_id text;
  scope_active boolean := false;
BEGIN
  SELECT true INTO scope_active
  FROM public.tenants tenant
  JOIN public.workspaces workspace
    ON workspace.tenant_id = tenant.id AND workspace.id = p_workspace_id
  WHERE tenant.id = p_tenant_id
    AND tenant.lifecycle_state = 'ACTIVE'
    AND workspace.lifecycle_state = 'ACTIVE'
  FOR KEY SHARE OF tenant, workspace;
  SELECT * INTO candidate
  FROM public.break_glass_grants grant_row
  WHERE grant_row.tenant_id = p_tenant_id AND grant_row.id = p_grant_id;

  decision := 'DENY';
  state := 'INVALID_GRANT';
  grant_id := NULL;
  operator_name := NULL;
  reason := NULL;
  audit_event_id := p_audit_event_id;
  IF scope_active IS TRUE
     AND p_operator_id IS NOT NULL
     AND length(btrim(COALESCE(p_operator_name, ''))) BETWEEN 1 AND 200
     AND candidate.id IS NOT NULL
     AND candidate.workspace_id = p_workspace_id
     AND candidate.operator_id = p_operator_id
     AND candidate.operator_name = btrim(p_operator_name)
     AND candidate.requested_action = btrim(p_requested_action)
     AND candidate.resource_type = btrim(p_resource_type)
     AND candidate.resource_id = btrim(p_resource_id) THEN
    grant_id := candidate.id;
    operator_name := candidate.operator_name;
    reason := candidate.reason;
    IF candidate.revoked_at IS NOT NULL THEN
      state := 'REVOKED';
    ELSIF database_now < candidate.granted_at THEN
      state := 'NOT_YET_ACTIVE';
    ELSIF database_now >= candidate.expires_at THEN
      state := 'EXPIRED';
    ELSE
      decision := 'ALLOW';
      state := 'ACTIVE';
    END IF;
  END IF;

  actor_kind := CASE WHEN p_operator_id IS NULL THEN 'SUPPORT' ELSE 'PLATFORM_OPERATOR' END;
  actor_principal_id := CASE
    WHEN p_operator_id IS NOT NULL THEN p_operator_id::text
    WHEN length(btrim(COALESCE(p_actor_subject, ''))) BETWEEN 1 AND 240
      THEN btrim(p_actor_subject)
    ELSE 'unknown-break-glass-principal'
  END;
  INSERT INTO public.audit_events (
    id, tenant_id, workspace_id, actor_user_id, actor_kind, actor_principal_id,
    action, resource_type, resource_id, outcome, metadata, occurred_at
  ) VALUES (
    p_audit_event_id, p_tenant_id, p_workspace_id, NULL, actor_kind,
    actor_principal_id,
    CASE WHEN decision = 'ALLOW'
      THEN 'BREAK_GLASS_ACCESS_ALLOWED' ELSE 'BREAK_GLASS_ACCESS_DENIED' END,
    'BREAK_GLASS_GRANT', p_grant_id,
    CASE WHEN decision = 'ALLOW' THEN 'SUCCEEDED' ELSE 'DENIED' END,
    jsonb_build_object(
      'workspaceId', p_workspace_id,
      'requestedAction', btrim(COALESCE(p_requested_action, '')),
      'resourceType', btrim(COALESCE(p_resource_type, '')),
      'resourceId', btrim(COALESCE(p_resource_id, '')),
      'state', state
    ), database_now
  );
  RETURN NEXT;
END
$function$;

CREATE FUNCTION revoke_break_glass(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_grant_id uuid,
  p_operator_id uuid,
  p_operator_name text,
  p_audit_event_id uuid
)
RETURNS SETOF break_glass_grants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  changed public.break_glass_grants%ROWTYPE;
BEGIN
  PERFORM set_config('app.break_glass_revoke_id', p_grant_id::text, true);
  IF length(btrim(p_operator_name)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'BREAK_GLASS_PRINCIPAL_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE public.break_glass_grants grant_row
  SET revoked_at = database_now, revoke_audit_event_id = p_audit_event_id
  WHERE grant_row.tenant_id = p_tenant_id
    AND grant_row.workspace_id = p_workspace_id
    AND grant_row.id = p_grant_id
    AND grant_row.revoked_at IS NULL
  RETURNING * INTO changed;
  IF changed.id IS NULL THEN
    RETURN QUERY SELECT * FROM public.break_glass_grants grant_row
      WHERE grant_row.tenant_id = p_tenant_id
        AND grant_row.workspace_id = p_workspace_id
        AND grant_row.id = p_grant_id;
    RETURN;
  END IF;
  INSERT INTO public.audit_events (
    id, tenant_id, workspace_id, actor_user_id, actor_kind, actor_principal_id,
    action, resource_type, resource_id, outcome, metadata, occurred_at
  ) VALUES (
    p_audit_event_id, p_tenant_id, p_workspace_id, NULL, 'PLATFORM_OPERATOR',
    p_operator_id::text, 'BREAK_GLASS_REVOKED', 'BREAK_GLASS_GRANT', p_grant_id,
    'SUCCEEDED', '{}'::jsonb, database_now
  );
  RETURN NEXT changed;
END
$function$;

CREATE FUNCTION aeostudio_request_deletion(
  p_scope_kind text,
  p_actor_subject text,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_request_id uuid,
  p_reason text,
  p_request_hash text,
  p_requested_at timestamptz,
  p_audit_event_id uuid
)
RETURNS SETOF deletion_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor_user_id uuid;
  actor_membership_id uuid;
  existing_request public.deletion_requests%ROWTYPE;
  stored_workspace_id uuid;
  database_now timestamptz := clock_timestamp();
BEGIN
  IF p_scope_kind NOT IN ('TENANT', 'WORKSPACE')
     OR p_requested_at IS NULL
     OR p_request_hash !~ '^[a-f0-9]{64}$'
     OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'DELETION_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_requested_at > database_now + interval '5 minutes' THEN
    RAISE EXCEPTION 'DELETION_REQUEST_TIME_IN_FUTURE' USING ERRCODE = '22023';
  END IF;
  -- The caller timestamp is only a fail-closed future-skew assertion. The
  -- persisted request, audit evidence and every deadline use one DB clock so a
  -- stale or forged caller clock can never accelerate deletion.
  p_requested_at := database_now;
  PERFORM 1 FROM public.tenants tenant WHERE tenant.id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Authorization is checked before idempotency so an identifier is never an
  -- oracle for another tenant's deletion request.
  SELECT owner.user_id, owner.membership_id INTO actor_user_id, actor_membership_id
  FROM public.resolve_privacy_tenant_owner(
    p_actor_subject,
    p_tenant_id,
    p_workspace_id
  ) owner;
  IF actor_user_id IS NULL THEN
    RAISE EXCEPTION 'DELETION_REQUEST_OWNER_REQUIRED' USING ERRCODE = '42501';
  END IF;
  stored_workspace_id := CASE WHEN p_scope_kind = 'WORKSPACE' THEN p_workspace_id ELSE NULL END;

  SELECT * INTO existing_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id;
  IF existing_request.id IS NOT NULL THEN
    IF existing_request.tenant_id IS DISTINCT FROM p_tenant_id
       OR existing_request.workspace_id IS DISTINCT FROM stored_workspace_id
       OR existing_request.scope_kind IS DISTINCT FROM p_scope_kind
       OR existing_request.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'DELETION_REQUEST_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN NEXT existing_request;
    RETURN;
  END IF;

  SELECT * INTO existing_request
  FROM public.deletion_requests request
  WHERE request.tenant_id = p_tenant_id
    AND request.scope_kind = p_scope_kind
    AND request.workspace_id IS NOT DISTINCT FROM stored_workspace_id
    AND request.state IN ('FROZEN', 'FINALIZING', 'BLOCKED_BY_LEGAL_HOLD')
  FOR UPDATE;
  IF existing_request.id IS NOT NULL THEN
    IF existing_request.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'DELETION_REQUEST_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN NEXT existing_request;
    RETURN;
  END IF;

  INSERT INTO public.deletion_requests (
    id, tenant_id, workspace_id, scope_kind, state, requested_by_user_id,
    requested_membership_id, requested_workspace_id, requested_subject_digest,
    reason, request_hash, requested_at, frozen_at, active_delete_by,
    backup_delete_by, secret_force_delete_by
  ) VALUES (
    p_request_id, p_tenant_id, stored_workspace_id, p_scope_kind, 'FROZEN', actor_user_id,
    actor_membership_id, p_workspace_id,
    encode(sha256(convert_to(p_actor_subject, 'UTF8')), 'hex'),
    btrim(p_reason), p_request_hash, p_requested_at, p_requested_at,
    p_requested_at + interval '30 days', p_requested_at + interval '90 days',
    p_requested_at + interval '24 hours'
  );

  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  PERFORM set_config('app.workspace_id', p_workspace_id::text, true);
  PERFORM set_config('app.actor_id', actor_user_id::text, true);
  PERFORM set_config('app.lifecycle_request_id', p_request_id::text, true);
  PERFORM set_config('app.secret_deletion_transition', 'authorized', true);

  IF p_scope_kind = 'TENANT' THEN
    UPDATE public.tenants
      SET lifecycle_state = 'FROZEN', access_epoch = access_epoch + 1,
          frozen_at = p_requested_at
      WHERE id = p_tenant_id AND lifecycle_state = 'ACTIVE';
    UPDATE public.workspaces
      SET lifecycle_state = 'FROZEN', access_epoch = access_epoch + 1,
          frozen_at = p_requested_at
      WHERE tenant_id = p_tenant_id AND lifecycle_state = 'ACTIVE';
  ELSE
    UPDATE public.workspaces
      SET lifecycle_state = 'FROZEN', access_epoch = access_epoch + 1,
          frozen_at = p_requested_at
      WHERE tenant_id = p_tenant_id AND id = p_workspace_id
        AND lifecycle_state = 'ACTIVE';
  END IF;

  UPDATE public.auth_sessions session
  SET revoked_at = COALESCE(session.revoked_at, p_requested_at)
  WHERE session.revoked_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.external_identities identity
      JOIN public.memberships membership ON membership.user_id = identity.user_id
      WHERE membership.tenant_id = p_tenant_id
        AND session.subject_digest = encode(
          sha256(convert_to(identity.subject, 'UTF8')), 'hex'
        )
        AND (
          p_scope_kind = 'TENANT'
          OR EXISTS (
            SELECT 1 FROM public.role_bindings binding
            WHERE binding.tenant_id = membership.tenant_id
              AND binding.membership_id = membership.id
              AND binding.workspace_id = p_workspace_id
          )
        )
    );

  INSERT INTO public.connector_secret_deletions (
    tenant_id, workspace_id, channel_authorization_id, secret_reference,
    state, deletion_request_id, revoked_at, force_delete_at
  )
  SELECT channel_auth.tenant_id, channel_auth.workspace_id, channel_auth.id,
    channel_auth.secret_arn, 'REVOKED_PENDING_FORCE_DELETE', p_request_id,
    CASE WHEN channel_auth.status = 'REVOKED'
      THEN LEAST(channel_auth.updated_at, p_requested_at) ELSE p_requested_at END,
    CASE WHEN channel_auth.status = 'REVOKED'
      THEN LEAST(channel_auth.updated_at, p_requested_at) ELSE p_requested_at END
      + interval '24 hours'
  FROM public.channel_authorizations channel_auth
  WHERE channel_auth.tenant_id = p_tenant_id
    AND (p_scope_kind = 'TENANT' OR channel_auth.workspace_id = p_workspace_id)
    AND channel_auth.secret_arn IS NOT NULL
  -- One authorization has one monotonic deletion record. A later wider-scope
  -- request must not rewind REQUESTED/FAILED work, rebind it, or postpone its
  -- original 24-hour deadline.
  ON CONFLICT (tenant_id, channel_authorization_id) DO NOTHING;

  UPDATE public.channel_authorizations channel_auth
  SET status = 'REVOKED',
      secret_arn_hash = encode(sha256(convert_to(channel_auth.secret_arn, 'UTF8')), 'hex'),
      secret_arn = NULL,
      updated_at = GREATEST(channel_auth.updated_at, p_requested_at)
  WHERE channel_auth.tenant_id = p_tenant_id
    AND (p_scope_kind = 'TENANT' OR channel_auth.workspace_id = p_workspace_id)
    AND channel_auth.secret_arn IS NOT NULL;

  UPDATE public.jobs job
  SET lifecycle_frozen_at = p_requested_at,
      lifecycle_freeze_request_id = p_request_id,
      status = CASE
        WHEN job.status IN ('SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED') THEN job.status
        ELSE 'CANCELLED'
      END,
      lease_token = NULL,
      lease_expires_at = NULL,
      heartbeat_at = NULL,
      next_attempt_at = NULL,
      error_code = CASE
        WHEN job.status IN ('SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED') THEN job.error_code
        ELSE 'TENANT_LIFECYCLE_FROZEN'
      END,
      updated_at = GREATEST(job.updated_at, p_requested_at)
  WHERE job.tenant_id = p_tenant_id
    AND job.lifecycle_frozen_at IS NULL
    AND (p_scope_kind = 'TENANT' OR job.workspace_id = p_workspace_id);

  UPDATE public.budget_reservations reservation
  SET status = 'RELEASED', settled_at = p_requested_at
  WHERE reservation.tenant_id = p_tenant_id
    AND reservation.status = 'RESERVED'
    AND (p_scope_kind = 'TENANT' OR reservation.workspace_id = p_workspace_id);

  UPDATE public.outbox_messages message
  SET suppressed_at = p_requested_at,
      suppression_reason = 'TENANT_LIFECYCLE_FROZEN'
  WHERE message.tenant_id = p_tenant_id
    AND message.published_at IS NULL
    AND message.suppressed_at IS NULL
    AND (p_scope_kind = 'TENANT' OR message.workspace_id = p_workspace_id);

  UPDATE public.measurement_provider_policies policy
  SET authorization_approved = false
  WHERE policy.tenant_id = p_tenant_id
    AND policy.authorization_approved
    AND (p_scope_kind = 'TENANT' OR policy.workspace_id = p_workspace_id);

  UPDATE public.break_glass_grants grant_row
  SET revoked_at = p_requested_at
  WHERE grant_row.tenant_id = p_tenant_id
    AND grant_row.revoked_at IS NULL
    AND (p_scope_kind = 'TENANT' OR grant_row.workspace_id = p_workspace_id);

  INSERT INTO public.audit_events (
    id, tenant_id, workspace_id, actor_user_id, actor_kind, action,
    resource_type, resource_id, outcome, metadata, occurred_at
  ) VALUES (
    p_audit_event_id, p_tenant_id, p_workspace_id, actor_user_id, 'USER',
    CASE WHEN p_scope_kind = 'TENANT'
      THEN 'TENANT_DELETION_REQUESTED' ELSE 'WORKSPACE_DELETION_REQUESTED' END,
    'DELETION_REQUEST', p_request_id, 'SUCCEEDED',
    jsonb_build_object(
      'scopeKind', p_scope_kind,
      'activeDeleteBy', p_requested_at + interval '30 days',
      'backupDeleteBy', p_requested_at + interval '90 days',
      'secretForceDeleteBy', p_requested_at + interval '24 hours'
    ),
    p_requested_at
  );

  RETURN QUERY SELECT * FROM public.deletion_requests request WHERE request.id = p_request_id;
END
$function$;

CREATE FUNCTION request_tenant_deletion(
  p_actor_subject text,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_request_id uuid,
  p_reason text,
  p_request_hash text,
  p_requested_at timestamptz,
  p_audit_event_id uuid
)
RETURNS SETOF deletion_requests
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT * FROM public.aeostudio_request_deletion(
    'TENANT', p_actor_subject, p_tenant_id, p_workspace_id, p_request_id,
    p_reason, p_request_hash, p_requested_at, p_audit_event_id
  )
$function$;

CREATE FUNCTION request_workspace_deletion(
  p_actor_subject text,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_request_id uuid,
  p_reason text,
  p_request_hash text,
  p_requested_at timestamptz,
  p_audit_event_id uuid
)
RETURNS SETOF deletion_requests
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT * FROM public.aeostudio_request_deletion(
    'WORKSPACE', p_actor_subject, p_tenant_id, p_workspace_id, p_request_id,
    p_reason, p_request_hash, p_requested_at, p_audit_event_id
  )
$function$;

CREATE FUNCTION create_legal_hold(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_hold_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_reason text,
  p_object_key text,
  p_object_version_id text,
  p_audit_event_id uuid
)
RETURNS TABLE (
  id uuid, tenant_id uuid, workspace_id uuid, name text, reason text,
  visible_to_tenant boolean, status text, created_by_user_id uuid,
  created_at timestamptz, released_at timestamptz,
  object_key text, object_version_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  existing_id uuid;
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant_id
     OR NULLIF(current_setting('app.workspace_id', true), '')::uuid
        IS DISTINCT FROM p_workspace_id
     OR NULLIF(current_setting('app.actor_id', true), '')::uuid
        IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'LEGAL_HOLD_CONTEXT_MISMATCH' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.memberships membership
  JOIN public.role_bindings binding
    ON binding.tenant_id = membership.tenant_id
   AND binding.membership_id = membership.id
   AND binding.workspace_id = p_workspace_id
   AND binding.role = 'OWNER'
  JOIN public.tenants tenant
    ON tenant.id = membership.tenant_id AND tenant.lifecycle_state = 'ACTIVE'
  JOIN public.workspaces workspace
    ON workspace.tenant_id = binding.tenant_id
   AND workspace.id = binding.workspace_id
   AND workspace.lifecycle_state = 'ACTIVE'
  WHERE membership.tenant_id = p_tenant_id
    AND membership.user_id = p_actor_user_id
    AND membership.status = 'ACTIVE'
  FOR SHARE OF membership, binding, tenant, workspace;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEGAL_HOLD_OWNER_REQUIRED' USING ERRCODE = '42501';
  END IF;

  IF length(btrim(p_name)) NOT BETWEEN 1 AND 200
     OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000
     OR length(btrim(p_object_key)) NOT BETWEEN 1 AND 1024
     OR position('..' in p_object_key) > 0
     OR left(p_object_key, 1) = '/'
     OR length(btrim(p_object_version_id)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'LEGAL_HOLD_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM 1
  FROM public.tenants tenant
  JOIN public.workspaces workspace
    ON workspace.tenant_id = tenant.id AND workspace.id = p_workspace_id
  WHERE tenant.id = p_tenant_id
    AND tenant.lifecycle_state = 'ACTIVE'
    AND workspace.lifecycle_state = 'ACTIVE'
  FOR KEY SHARE OF tenant, workspace;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEGAL_HOLD_SCOPE_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM public.managed_object_versions object_version
  WHERE object_version.tenant_id = p_tenant_id
    AND object_version.workspace_id = p_workspace_id
    AND object_version.object_key = btrim(p_object_key)
    AND object_version.object_version_id = btrim(p_object_version_id)
    AND object_version.lifecycle_state IN ('ACTIVE', 'DELETE_DUE', 'LEGAL_HOLD')
    AND object_version.deleted_at IS NULL
  -- Serialize create with last-release and lifecycle finalization for this
  -- exact object version. Task 18's durable reconciliation trigger uses the
  -- same object lock before advancing its desired S3 Legal Hold revision.
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEGAL_HOLD_OBJECT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT hold.id INTO existing_id
  FROM public.legal_holds hold
  WHERE hold.id = p_hold_id;
  IF existing_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.legal_holds hold
      JOIN public.legal_hold_object_versions target
        ON target.tenant_id = hold.tenant_id AND target.hold_id = hold.id
      WHERE hold.id = p_hold_id
        AND hold.tenant_id = p_tenant_id
        AND hold.workspace_id = p_workspace_id
        AND hold.name = btrim(p_name)
        AND hold.reason = btrim(p_reason)
        AND target.object_key = btrim(p_object_key)
        AND target.object_version_id = btrim(p_object_version_id)
    ) THEN
      RAISE EXCEPTION 'LEGAL_HOLD_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY
      SELECT hold.id, hold.tenant_id, hold.workspace_id, hold.name, hold.reason,
        hold.visible_to_tenant, hold.status, hold.created_by_user_id, hold.created_at,
        hold.released_at, target.object_key, target.object_version_id
      FROM public.legal_holds hold
      JOIN public.legal_hold_object_versions target
        ON target.tenant_id = hold.tenant_id AND target.hold_id = hold.id
      WHERE hold.id = p_hold_id;
    RETURN;
  END IF;

  INSERT INTO public.legal_holds (
    id, tenant_id, workspace_id, name, reason, visible_to_tenant, status,
    created_by_user_id, created_at, released_at, audit_event_id, release_audit_event_id
  ) VALUES (
    p_hold_id, p_tenant_id, p_workspace_id, btrim(p_name), btrim(p_reason), true,
    'ACTIVE', p_actor_user_id, database_now, NULL, p_audit_event_id, NULL
  );
  INSERT INTO public.legal_hold_object_versions (
    tenant_id, hold_id, object_key, object_version_id
  ) VALUES (
    p_tenant_id, p_hold_id, btrim(p_object_key), btrim(p_object_version_id)
  );
  INSERT INTO public.audit_events (
    id, tenant_id, workspace_id, actor_user_id, actor_kind, action,
    resource_type, resource_id, outcome, metadata, occurred_at
  ) VALUES (
    p_audit_event_id, p_tenant_id, p_workspace_id, p_actor_user_id, 'USER',
    'LEGAL_HOLD_CREATED', 'LEGAL_HOLD', p_hold_id, 'SUCCEEDED',
    jsonb_build_object(
      'objectKey', btrim(p_object_key),
      'objectVersionId', btrim(p_object_version_id)
    ), database_now
  );
  RETURN QUERY
    SELECT hold.id, hold.tenant_id, hold.workspace_id, hold.name, hold.reason,
      hold.visible_to_tenant, hold.status, hold.created_by_user_id, hold.created_at,
      hold.released_at, target.object_key, target.object_version_id
    FROM public.legal_holds hold
    JOIN public.legal_hold_object_versions target
      ON target.tenant_id = hold.tenant_id AND target.hold_id = hold.id
    WHERE hold.id = p_hold_id;
END
$function$;

CREATE FUNCTION release_legal_hold(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_hold_id uuid,
  p_actor_user_id uuid,
  p_audit_event_id uuid
)
RETURNS TABLE (
  id uuid, tenant_id uuid, workspace_id uuid, name text, reason text,
  visible_to_tenant boolean, status text, created_by_user_id uuid,
  created_at timestamptz, released_at timestamptz,
  object_key text, object_version_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  current_status text;
  target_key text;
  target_version text;
  target_deletion_request_id uuid;
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant_id
     OR NULLIF(current_setting('app.workspace_id', true), '')::uuid
        IS DISTINCT FROM p_workspace_id
     OR NULLIF(current_setting('app.actor_id', true), '')::uuid
        IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'LEGAL_HOLD_CONTEXT_MISMATCH' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.memberships membership
  JOIN public.role_bindings binding
    ON binding.tenant_id = membership.tenant_id
   AND binding.membership_id = membership.id
   AND binding.workspace_id = p_workspace_id
   AND binding.role = 'OWNER'
  JOIN public.tenants tenant
    ON tenant.id = membership.tenant_id AND tenant.lifecycle_state = 'ACTIVE'
  JOIN public.workspaces workspace
    ON workspace.tenant_id = binding.tenant_id
   AND workspace.id = binding.workspace_id
   AND workspace.lifecycle_state = 'ACTIVE'
  WHERE membership.tenant_id = p_tenant_id
    AND membership.user_id = p_actor_user_id
    AND membership.status = 'ACTIVE'
  FOR SHARE OF membership, binding, tenant, workspace;
  IF NOT FOUND THEN
    PERFORM 1
    FROM public.deletion_requests request
    WHERE request.tenant_id = p_tenant_id
      AND request.requested_workspace_id = p_workspace_id
      AND request.requested_by_user_id = p_actor_user_id
      AND request.state IN (
        'FROZEN', 'FINALIZING', 'ACTIVE_DATA_DELETED', 'BACKUP_DELETED',
        'BLOCKED_BY_LEGAL_HOLD'
      )
      AND (request.scope_kind = 'TENANT' OR request.workspace_id = p_workspace_id)
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEGAL_HOLD_OWNER_REQUIRED' USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM set_config('app.legal_hold_release_id', p_hold_id::text, true);
  SELECT hold.status, target.object_key, target.object_version_id
    INTO current_status, target_key, target_version
  FROM public.legal_holds hold
  JOIN public.legal_hold_object_versions target
    ON target.tenant_id = hold.tenant_id AND target.hold_id = hold.id
  WHERE hold.tenant_id = p_tenant_id
    AND hold.workspace_id = p_workspace_id
    AND hold.id = p_hold_id
  FOR UPDATE OF hold;
  IF current_status IS NULL THEN
    RETURN;
  END IF;
  -- Serialize every release for one exact object with deletion finalization.
  -- finalize_deletion locks the request first, so take the same lock order
  -- before changing LEGAL_HOLD to DELETE_DUE.
  SELECT object_version.deletion_request_id INTO target_deletion_request_id
  FROM public.managed_object_versions object_version
  WHERE object_version.tenant_id = p_tenant_id
    AND object_version.object_key = target_key
    AND object_version.object_version_id = target_version;
  IF target_deletion_request_id IS NOT NULL THEN
    PERFORM 1
    FROM public.deletion_requests request
    WHERE request.id = target_deletion_request_id
    FOR UPDATE;
  END IF;
  PERFORM 1
  FROM public.managed_object_versions object_version
  WHERE object_version.tenant_id = p_tenant_id
    AND object_version.object_key = target_key
    AND object_version.object_version_id = target_version
  FOR UPDATE;
  IF current_status = 'ACTIVE' THEN
    UPDATE public.legal_holds hold
    SET status = 'RELEASED', released_at = database_now,
        release_audit_event_id = p_audit_event_id
    WHERE hold.tenant_id = p_tenant_id AND hold.id = p_hold_id;
    UPDATE public.managed_object_versions object_version
    SET lifecycle_state = 'DELETE_DUE'
    WHERE object_version.tenant_id = p_tenant_id
      AND object_version.workspace_id = p_workspace_id
      AND object_version.object_key = target_key
      AND object_version.object_version_id = target_version
      AND object_version.lifecycle_state = 'LEGAL_HOLD'
      AND object_version.deletion_request_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.legal_hold_object_versions other_target
        JOIN public.legal_holds other_hold
          ON other_hold.tenant_id = other_target.tenant_id
         AND other_hold.id = other_target.hold_id
        WHERE other_target.tenant_id = object_version.tenant_id
          AND other_target.object_key = object_version.object_key
          AND other_target.object_version_id = object_version.object_version_id
          AND other_hold.status = 'ACTIVE'
      );
    INSERT INTO public.audit_events (
      id, tenant_id, workspace_id, actor_user_id, actor_kind, action,
      resource_type, resource_id, outcome, metadata, occurred_at
    ) VALUES (
      p_audit_event_id, p_tenant_id, p_workspace_id, p_actor_user_id, 'USER',
      'LEGAL_HOLD_RELEASED', 'LEGAL_HOLD', p_hold_id, 'SUCCEEDED',
      '{}'::jsonb, database_now
    );
  END IF;
  RETURN QUERY
    SELECT hold.id, hold.tenant_id, hold.workspace_id, hold.name, hold.reason,
      hold.visible_to_tenant, hold.status, hold.created_by_user_id, hold.created_at,
      hold.released_at, target.object_key, target.object_version_id
    FROM public.legal_holds hold
    JOIN public.legal_hold_object_versions target
      ON target.tenant_id = hold.tenant_id AND target.hold_id = hold.id
    WHERE hold.tenant_id = p_tenant_id AND hold.id = p_hold_id;
END
$function$;

CREATE FUNCTION guard_managed_object_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF COALESCE(current_setting('app.lifecycle_request_id', true), '') = ''
     AND COALESCE(current_setting('app.legal_hold_release_id', true), '') = '' THEN
    RAISE EXCEPTION 'MANAGED_OBJECT_LIFECYCLE_TRANSITION_DENIED' USING ERRCODE = '42501';
  END IF;
  IF to_jsonb(NEW) - ARRAY['lifecycle_state', 'deletion_request_id', 'deleted_at']::text[]
       IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['lifecycle_state', 'deletion_request_id', 'deleted_at']::text[]
     OR NOT (
       (OLD.lifecycle_state = 'ACTIVE'
         AND NEW.lifecycle_state IN ('DELETE_DUE', 'DELETED', 'LEGAL_HOLD'))
       OR (OLD.lifecycle_state = 'DELETE_DUE' AND NEW.lifecycle_state IN ('LEGAL_HOLD', 'DELETED'))
       OR (OLD.lifecycle_state = 'LEGAL_HOLD' AND NEW.lifecycle_state = 'DELETE_DUE')
     ) THEN
    RAISE EXCEPTION 'MANAGED_OBJECT_LIFECYCLE_TRANSITION_INVALID' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER managed_object_lifecycle_transition_guard
BEFORE UPDATE ON managed_object_versions
FOR EACH ROW EXECUTE FUNCTION guard_managed_object_lifecycle_transition();

CREATE FUNCTION guard_connector_secret_deletion_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('app.secret_deletion_lease', true) = 'authorized' THEN
    IF NEW.state IS DISTINCT FROM OLD.state
       OR to_jsonb(NEW) - ARRAY[
         'work_lease_token', 'work_lease_expires_at', 'work_attempt_count',
         'work_last_claimed_at'
       ]::text[] IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY[
         'work_lease_token', 'work_lease_expires_at', 'work_attempt_count',
         'work_last_claimed_at'
       ]::text[] THEN
      RAISE EXCEPTION 'CONNECTOR_SECRET_DELETION_LEASE_INVALID' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF current_setting('app.secret_deletion_transition', true) IS DISTINCT FROM 'authorized' THEN
    RAISE EXCEPTION 'CONNECTOR_SECRET_DELETION_TRANSITION_DENIED' USING ERRCODE = '42501';
  END IF;
  IF to_jsonb(NEW) - ARRAY[
       'state', 'force_delete_requested_at', 'verified_unreadable_at', 'failure_code',
       'work_lease_token', 'work_lease_expires_at', 'secret_reference',
       'secret_reference_hash'
     ]::text[] IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY[
       'state', 'force_delete_requested_at', 'verified_unreadable_at', 'failure_code',
       'work_lease_token', 'work_lease_expires_at', 'secret_reference',
       'secret_reference_hash'
     ]::text[]
     OR (
       NEW.state = 'VERIFIED_UNREADABLE'
       AND (
         NEW.secret_reference IS NOT NULL
         OR NEW.secret_reference_hash IS DISTINCT FROM COALESCE(
           OLD.secret_reference_hash,
           encode(sha256(convert_to(OLD.secret_reference, 'UTF8')), 'hex')
         )
       )
     )
     OR (
       NEW.state <> 'VERIFIED_UNREADABLE'
       AND ROW(NEW.secret_reference, NEW.secret_reference_hash)
         IS DISTINCT FROM ROW(OLD.secret_reference, OLD.secret_reference_hash)
     )
     OR NOT (
       (OLD.state = 'REVOKED_PENDING_FORCE_DELETE'
         AND NEW.state IN ('FORCE_DELETE_REQUESTED', 'VERIFIED_UNREADABLE', 'FAILED'))
       OR (OLD.state = 'FORCE_DELETE_REQUESTED'
         AND NEW.state IN ('VERIFIED_UNREADABLE', 'FAILED'))
       OR (OLD.state = 'FAILED'
         AND NEW.state IN ('FORCE_DELETE_REQUESTED', 'VERIFIED_UNREADABLE'))
     ) THEN
    RAISE EXCEPTION 'CONNECTOR_SECRET_DELETION_TRANSITION_INVALID' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER connector_secret_deletion_transition_guard
BEFORE UPDATE ON connector_secret_deletions
FOR EACH ROW EXECUTE FUNCTION guard_connector_secret_deletion_transition();

CREATE FUNCTION guard_legal_hold_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('app.legal_hold_release_id', true) IS DISTINCT FROM OLD.id::text
     OR OLD.status <> 'ACTIVE' OR NEW.status <> 'RELEASED'
     OR to_jsonb(NEW) - ARRAY['status', 'released_at', 'release_audit_event_id']::text[]
       IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['status', 'released_at', 'release_audit_event_id']::text[] THEN
    RAISE EXCEPTION 'LEGAL_HOLD_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER legal_hold_transition_guard
BEFORE UPDATE ON legal_holds
FOR EACH ROW EXECUTE FUNCTION guard_legal_hold_transition();

CREATE FUNCTION reject_legal_hold_target_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'LEGAL_HOLD_TARGET_IMMUTABLE' USING ERRCODE = '42501';
END
$function$;

CREATE TRIGGER legal_hold_target_update_guard
BEFORE UPDATE ON legal_hold_object_versions
FOR EACH ROW EXECUTE FUNCTION reject_legal_hold_target_update();

CREATE FUNCTION guard_break_glass_grant_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF COALESCE(current_setting('app.lifecycle_request_id', true), '') = ''
     AND current_setting('app.break_glass_revoke_id', true) IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'BREAK_GLASS_GRANT_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR to_jsonb(NEW) - ARRAY['revoked_at', 'revoke_audit_event_id']::text[]
       IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['revoked_at', 'revoke_audit_event_id']::text[] THEN
    RAISE EXCEPTION 'BREAK_GLASS_GRANT_TRANSITION_INVALID' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER break_glass_grant_transition_guard
BEFORE UPDATE ON break_glass_grants
FOR EACH ROW EXECUTE FUNCTION guard_break_glass_grant_transition();

REVOKE ALL ON tenant_exports, tenant_export_items, deletion_requests,
  deletion_tombstones, managed_object_versions, legal_holds,
  legal_hold_object_versions, connector_secret_deletions, break_glass_grants,
  audit_chain_heads, audit_digests FROM PUBLIC;

GRANT SELECT, INSERT ON tenant_exports, tenant_export_items, audit_digests
  TO aeostudio_runtime;
GRANT SELECT, INSERT ON managed_object_versions TO aeostudio_runtime;
GRANT SELECT ON connector_secret_deletions TO aeostudio_runtime;
GRANT SELECT ON legal_holds, legal_hold_object_versions, break_glass_grants
  TO aeostudio_runtime;
GRANT SELECT ON deletion_requests, deletion_tombstones, audit_chain_heads
  TO aeostudio_runtime;

-- Audit evidence is append-only even if an older migration granted broad DML.
REVOKE UPDATE, DELETE ON audit_events FROM aeostudio_runtime;
GRANT SELECT, INSERT ON audit_events TO aeostudio_runtime;

REVOKE ALL ON FUNCTION aeostudio_audit_hash(jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION append_audit_chain() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_audit_evidence_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION append_tenant_auth_session_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION backfill_tenant_auth_session_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION lifecycle_mutation_is_authorized(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_lifecycle_state_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_frozen_job_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_suppressed_outbox_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION aeostudio_request_deletion(
  text, text, uuid, uuid, uuid, text, text, timestamptz, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_privacy_tenant_owner(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_privacy_governance_owner(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION grant_break_glass(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION evaluate_break_glass_access(
  text, uuid, uuid, uuid, uuid, text, text, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_break_glass(uuid, uuid, uuid, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION grant_break_glass(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, text, uuid
) FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION evaluate_break_glass_access(
  text, uuid, uuid, uuid, uuid, text, text, text, text, uuid
) FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION revoke_break_glass(uuid, uuid, uuid, uuid, text, uuid)
  FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION verify_audit_chain(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION verify_audit_range(uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION prepare_audit_digest_seal(uuid, timestamptz, timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION request_tenant_deletion(
  text, uuid, uuid, uuid, text, text, timestamptz, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION request_workspace_deletion(
  text, uuid, uuid, uuid, text, text, timestamptz, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_legal_hold(
  uuid, uuid, uuid, uuid, text, text, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_legal_hold(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION resolve_privacy_tenant_owner(text, uuid, uuid)
  TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION resolve_privacy_governance_owner(text, uuid, uuid)
  TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION verify_audit_chain(uuid) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION verify_audit_range(uuid, timestamptz, timestamptz)
  TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION prepare_audit_digest_seal(uuid, timestamptz, timestamptz)
  TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION request_tenant_deletion(
  text, uuid, uuid, uuid, text, text, timestamptz, uuid
) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION request_workspace_deletion(
  text, uuid, uuid, uuid, text, text, timestamptz, uuid
) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION create_legal_hold(
  uuid, uuid, uuid, uuid, text, text, text, text, uuid
) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION release_legal_hold(uuid, uuid, uuid, uuid, uuid)
  TO aeostudio_runtime;

-- Immutable product evidence remains immutable during normal operation. A
-- narrowly checked DELETE trigger makes the Owner deletion finalizer the only
-- exception; UPDATE remains governed by the original evidence functions.
CREATE FUNCTION guard_lifecycle_scoped_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  deletion_request public.deletion_requests%ROWTYPE;
  old_document jsonb := to_jsonb(OLD);
  row_workspace_id uuid;
  effective_at timestamptz;
BEGIN
  IF current_user = 'aeostudio_runtime' THEN
    RAISE EXCEPTION 'LIFECYCLE_DELETE_RUNTIME_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = NULLIF(current_setting('app.lifecycle_request_id', true), '')::uuid
    AND request.tenant_id = (old_document ->> 'tenant_id')::uuid
    AND request.state = 'FINALIZING';
  effective_at := NULLIF(current_setting('app.lifecycle_effective_at', true), '')::timestamptz;
  IF deletion_request.id IS NULL OR effective_at IS NULL
     OR effective_at < deletion_request.active_delete_by THEN
    RAISE EXCEPTION 'LIFECYCLE_DELETE_CONTEXT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF old_document ? 'workspace_id' AND old_document ->> 'workspace_id' IS NOT NULL THEN
    row_workspace_id := (old_document ->> 'workspace_id')::uuid;
  END IF;
  IF deletion_request.scope_kind = 'WORKSPACE'
     AND row_workspace_id IS DISTINCT FROM deletion_request.workspace_id THEN
    RAISE EXCEPTION 'LIFECYCLE_DELETE_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$function$;

DROP TRIGGER channel_package_immutable_guard ON channel_packages;
CREATE TRIGGER channel_package_immutable_guard
BEFORE UPDATE ON channel_packages
FOR EACH ROW EXECUTE FUNCTION reject_channel_package_mutation();
CREATE TRIGGER channel_package_lifecycle_delete_guard
BEFORE DELETE ON channel_packages
FOR EACH ROW EXECUTE FUNCTION guard_lifecycle_scoped_delete();

DROP TRIGGER channel_authorization_mutation_guard ON channel_authorizations;
CREATE TRIGGER channel_authorization_mutation_guard
BEFORE UPDATE ON channel_authorizations
FOR EACH ROW EXECUTE FUNCTION guard_channel_authorization_mutation();
CREATE TRIGGER channel_authorization_lifecycle_delete_guard
BEFORE DELETE ON channel_authorizations
FOR EACH ROW EXECUTE FUNCTION guard_lifecycle_scoped_delete();

DROP TRIGGER publication_record_mutation_guard ON publication_records;
CREATE TRIGGER publication_record_mutation_guard
BEFORE UPDATE ON publication_records
FOR EACH ROW EXECUTE FUNCTION guard_publication_record_mutation();
CREATE TRIGGER publication_record_lifecycle_delete_guard
BEFORE DELETE ON publication_records
FOR EACH ROW EXECUTE FUNCTION guard_lifecycle_scoped_delete();

DROP TRIGGER publication_attempt_mutation_guard ON publication_attempts;
CREATE TRIGGER publication_attempt_mutation_guard
BEFORE UPDATE ON publication_attempts
FOR EACH ROW EXECUTE FUNCTION guard_publication_attempt_mutation();
CREATE TRIGGER publication_attempt_lifecycle_delete_guard
BEFORE DELETE ON publication_attempts
FOR EACH ROW EXECUTE FUNCTION guard_lifecycle_scoped_delete();

DROP TRIGGER experiment_mutation_guard ON experiments;
CREATE TRIGGER experiment_mutation_guard
BEFORE UPDATE ON experiments
FOR EACH ROW EXECUTE FUNCTION enforce_experiment_mutation();
CREATE TRIGGER experiment_lifecycle_delete_guard
BEFORE DELETE ON experiments
FOR EACH ROW EXECUTE FUNCTION guard_lifecycle_scoped_delete();

DROP TRIGGER experiment_snapshot_link_mutation_guard ON experiment_snapshot_links;
CREATE TRIGGER experiment_snapshot_link_mutation_guard
BEFORE UPDATE ON experiment_snapshot_links
FOR EACH ROW EXECUTE FUNCTION reject_experiment_snapshot_link_mutation();
CREATE TRIGGER experiment_snapshot_link_lifecycle_delete_guard
BEFORE DELETE ON experiment_snapshot_links
FOR EACH ROW EXECUTE FUNCTION guard_lifecycle_scoped_delete();

CREATE FUNCTION claim_due_deletion_requests(p_lease_token uuid, p_limit integer)
RETURNS TABLE (
  request_id uuid,
  stage text,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'DELETION_WORK_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT request.id
    FROM public.deletion_requests request
    WHERE (request.finalization_lease_expires_at IS NULL
        OR request.finalization_lease_expires_at <= database_now)
      AND (
        (request.state = 'FROZEN'
          AND request.active_delete_by <= database_now
          AND NOT EXISTS (
            SELECT 1 FROM public.connector_secret_deletions secret
            WHERE secret.deletion_request_id = request.id
              AND secret.state <> 'VERIFIED_UNREADABLE'
          ))
        OR (request.state = 'ACTIVE_DATA_DELETED'
          AND request.active_deleted_at IS NOT NULL
          AND (
            request.backup_delete_by <= database_now
            OR EXISTS (
              SELECT 1
              FROM public.managed_object_versions object_version
              WHERE object_version.tenant_id = request.tenant_id
                AND object_version.deletion_request_id = request.id
                AND object_version.lifecycle_state = 'DELETE_DUE'
            )
          ))
        OR (request.state = 'BLOCKED_BY_LEGAL_HOLD'
          AND request.active_deleted_at IS NOT NULL
          AND request.backup_delete_by <= database_now
          AND NOT EXISTS (
            SELECT 1
            FROM public.managed_object_versions object_version
            JOIN public.legal_hold_object_versions target
              ON target.tenant_id = object_version.tenant_id
             AND target.object_key = object_version.object_key
             AND target.object_version_id = object_version.object_version_id
            JOIN public.legal_holds hold_row
              ON hold_row.tenant_id = target.tenant_id
             AND hold_row.id = target.hold_id
            WHERE object_version.tenant_id = request.tenant_id
              AND object_version.lifecycle_state = 'LEGAL_HOLD'
              AND hold_row.status = 'ACTIVE'
              AND (request.scope_kind = 'TENANT'
                OR object_version.workspace_id = request.workspace_id
                OR object_version.object_class = 'TENANT_EXPORT')
          ))
        OR request.state = 'BACKUP_DELETED'
      )
    ORDER BY
      CASE
        WHEN request.state = 'FROZEN' THEN request.active_delete_by
        WHEN request.state = 'BACKUP_DELETED' THEN request.backup_deleted_at
        WHEN request.state = 'ACTIVE_DATA_DELETED'
          AND EXISTS (
            SELECT 1 FROM public.managed_object_versions object_version
            WHERE object_version.tenant_id = request.tenant_id
              AND object_version.deletion_request_id = request.id
              AND object_version.lifecycle_state = 'DELETE_DUE'
          ) THEN database_now
        ELSE request.backup_delete_by
      END,
      request.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.deletion_requests request
    SET finalization_lease_token = p_lease_token,
        finalization_lease_expires_at = database_now + interval '5 minutes',
        finalization_attempt_count = request.finalization_attempt_count + 1,
        finalization_last_claimed_at = database_now
    FROM due
    WHERE request.id = due.id
    RETURNING request.id, request.state, request.backup_delete_by,
      request.finalization_lease_token, request.finalization_lease_expires_at
  )
  SELECT claimed.id,
    CASE
      WHEN claimed.state = 'FROZEN' THEN 'ACTIVE'
      WHEN claimed.state = 'BACKUP_DELETED' THEN 'TOMBSTONE'
      WHEN claimed.state = 'ACTIVE_DATA_DELETED'
        AND claimed.backup_delete_by > database_now THEN 'OBJECT'
      ELSE 'BACKUP'
    END,
    claimed.finalization_lease_token,
    claimed.finalization_lease_expires_at
  FROM claimed
  ORDER BY claimed.id;
END
$function$;

CREATE FUNCTION claim_due_secret_deletions(p_lease_token uuid, p_limit integer)
RETURNS TABLE (
  tenant_id uuid,
  workspace_id uuid,
  channel_authorization_id uuid,
  deletion_request_id uuid,
  secret_reference text,
  force_delete_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'SECRET_DELETION_WORK_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.secret_deletion_lease', 'authorized', true);
  RETURN QUERY
  WITH due AS (
    SELECT secret.tenant_id, secret.channel_authorization_id
    FROM public.connector_secret_deletions secret
    WHERE secret.state IN ('REVOKED_PENDING_FORCE_DELETE', 'FORCE_DELETE_REQUESTED', 'FAILED')
      AND secret.revoked_at <= database_now
      AND (secret.work_lease_expires_at IS NULL OR secret.work_lease_expires_at <= database_now)
    ORDER BY secret.force_delete_at, secret.tenant_id, secret.channel_authorization_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.connector_secret_deletions secret
    SET work_lease_token = p_lease_token,
        work_lease_expires_at = database_now + interval '5 minutes',
        work_attempt_count = secret.work_attempt_count + 1,
        work_last_claimed_at = database_now
    FROM due
    WHERE secret.tenant_id = due.tenant_id
      AND secret.channel_authorization_id = due.channel_authorization_id
    RETURNING secret.*
  )
  SELECT claimed.tenant_id, claimed.workspace_id, claimed.channel_authorization_id,
    claimed.deletion_request_id, claimed.secret_reference, claimed.force_delete_at,
    claimed.work_lease_token, claimed.work_lease_expires_at
  FROM claimed
  ORDER BY claimed.force_delete_at, claimed.tenant_id, claimed.channel_authorization_id;
END
$function$;

CREATE FUNCTION worker_mark_secret_deletion_requested(
  p_tenant_id uuid,
  p_channel_authorization_id uuid,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
BEGIN
  PERFORM set_config('app.secret_deletion_transition', 'authorized', true);
  IF EXISTS (
    SELECT 1
    FROM public.connector_secret_deletions secret
    WHERE secret.tenant_id = p_tenant_id
      AND secret.channel_authorization_id = p_channel_authorization_id
      AND secret.work_lease_token = p_lease_token
      AND secret.work_lease_expires_at >= database_now
      AND secret.state = 'FORCE_DELETE_REQUESTED'
  ) THEN
    -- A provider delete may have succeeded before the worker crashed. The
    -- retry must preserve the original evidence timestamp and continue to the
    -- unreadability probe under the newly claimed lease.
    RETURN true;
  END IF;
  UPDATE public.connector_secret_deletions secret
  SET state = 'FORCE_DELETE_REQUESTED', force_delete_requested_at = database_now,
      failure_code = NULL
  WHERE secret.tenant_id = p_tenant_id
    AND secret.channel_authorization_id = p_channel_authorization_id
    AND secret.work_lease_token = p_lease_token
    AND secret.work_lease_expires_at >= database_now
    AND secret.state IN ('REVOKED_PENDING_FORCE_DELETE', 'FAILED');
  RETURN FOUND;
END
$function$;

CREATE FUNCTION worker_mark_secret_unreadable(
  p_tenant_id uuid,
  p_channel_authorization_id uuid,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
BEGIN
  PERFORM set_config('app.secret_deletion_transition', 'authorized', true);
  UPDATE public.connector_secret_deletions secret
  SET state = 'VERIFIED_UNREADABLE', verified_unreadable_at = database_now,
      failure_code = NULL, work_lease_token = NULL, work_lease_expires_at = NULL,
      secret_reference_hash = encode(
        sha256(convert_to(secret.secret_reference, 'UTF8')), 'hex'
      ),
      secret_reference = NULL
  WHERE secret.tenant_id = p_tenant_id
    AND secret.channel_authorization_id = p_channel_authorization_id
    AND secret.work_lease_token = p_lease_token
    AND secret.work_lease_expires_at >= database_now
    AND secret.state IN ('REVOKED_PENDING_FORCE_DELETE', 'FORCE_DELETE_REQUESTED', 'FAILED');
  RETURN FOUND;
END
$function$;

CREATE FUNCTION mark_connector_secret_deletion_requested(
  p_tenant_id uuid,
  p_channel_authorization_id uuid,
  p_requested_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM set_config('app.secret_deletion_transition', 'authorized', true);
  UPDATE public.connector_secret_deletions secret
  SET state = 'FORCE_DELETE_REQUESTED',
      force_delete_requested_at = p_requested_at,
      failure_code = NULL
  WHERE secret.tenant_id = p_tenant_id
    AND secret.channel_authorization_id = p_channel_authorization_id
    AND secret.state = 'REVOKED_PENDING_FORCE_DELETE'
    AND p_requested_at >= secret.revoked_at;
  RETURN FOUND;
END
$function$;

CREATE FUNCTION mark_connector_secret_unreadable(
  p_tenant_id uuid,
  p_channel_authorization_id uuid,
  p_verified_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM set_config('app.secret_deletion_transition', 'authorized', true);
  UPDATE public.connector_secret_deletions secret
  SET state = 'VERIFIED_UNREADABLE',
      verified_unreadable_at = p_verified_at,
      failure_code = NULL,
      secret_reference_hash = encode(
        sha256(convert_to(secret.secret_reference, 'UTF8')), 'hex'
      ),
      secret_reference = NULL
  WHERE secret.tenant_id = p_tenant_id
    AND secret.channel_authorization_id = p_channel_authorization_id
    AND secret.state IN ('REVOKED_PENDING_FORCE_DELETE', 'FORCE_DELETE_REQUESTED')
    AND p_verified_at >= secret.revoked_at;
  RETURN FOUND;
END
$function$;

CREATE FUNCTION finalize_deletion(
  p_request_id uuid,
  p_lease_token uuid,
  p_effective_at timestamptz,
  p_tombstone_id uuid,
  p_audit_event_id uuid
)
RETURNS TABLE (
  request_id uuid,
  state text,
  effective_at timestamptz,
  tombstone_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  deletion_request public.deletion_requests%ROWTYPE;
  target_table record;
  pass_number integer;
  affected_rows bigint;
  made_progress boolean;
  target_sql text;
  audit_workspace_id uuid;
  active_holds bigint;
  database_effective_at timestamptz;
BEGIN
  IF p_effective_at IS NULL THEN
    RAISE EXCEPTION 'DELETION_EFFECTIVE_TIME_REQUIRED' USING ERRCODE = '22023';
  END IF;
  database_effective_at := clock_timestamp();
  SELECT * INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id
  FOR UPDATE;
  IF deletion_request.id IS NULL THEN
    RETURN;
  END IF;
  IF deletion_request.finalization_lease_token IS DISTINCT FROM p_lease_token
     OR deletion_request.finalization_lease_expires_at IS NULL
     OR deletion_request.finalization_lease_expires_at < database_effective_at THEN
    RAISE EXCEPTION 'DELETION_FINALIZATION_LEASE_INVALID' USING ERRCODE = '42501';
  END IF;
  IF p_effective_at > database_effective_at THEN
    RAISE EXCEPTION 'DELETION_EFFECTIVE_TIME_NOT_DUE' USING ERRCODE = 'P0001';
  END IF;
  -- Retention deadlines and persisted evidence always use the database clock;
  -- the caller timestamp is only a fail-closed freshness assertion.
  p_effective_at := database_effective_at;
  -- Every lifecycle branch runs in a fresh transaction. Establish the narrow
  -- trigger capability after validating the exact unexpired worker lease so
  -- backup and tombstone passes cannot depend on a prior call's local GUCs.
  PERFORM set_config('app.tenant_id', deletion_request.tenant_id::text, true);
  PERFORM set_config('app.lifecycle_request_id', deletion_request.id::text, true);
  PERFORM set_config('app.lifecycle_effective_at', p_effective_at::text, true);

  SELECT workspace.id INTO audit_workspace_id
  FROM public.workspaces workspace
  WHERE workspace.tenant_id = deletion_request.tenant_id
    AND (deletion_request.workspace_id IS NULL
      OR workspace.id = deletion_request.workspace_id)
  ORDER BY workspace.created_at, workspace.id
  LIMIT 1;

  IF deletion_request.state = 'TOMBSTONED' THEN
    RETURN QUERY SELECT deletion_request.id, deletion_request.state,
      p_effective_at, p_tombstone_id;
    RETURN;
  END IF;

  IF deletion_request.state IN ('FROZEN', 'FINALIZING', 'BLOCKED_BY_LEGAL_HOLD')
     AND deletion_request.active_deleted_at IS NULL THEN
    IF p_effective_at < deletion_request.active_delete_by THEN
      RAISE EXCEPTION 'DELETION_ACTIVE_DATA_NOT_DUE' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.connector_secret_deletions secret
      WHERE secret.tenant_id = deletion_request.tenant_id
        AND (deletion_request.scope_kind = 'TENANT'
          OR secret.workspace_id = deletion_request.workspace_id)
        AND secret.state <> 'VERIFIED_UNREADABLE'
    ) THEN
      RAISE EXCEPTION 'DELETION_SECRET_UNREADABLE_PROOF_REQUIRED' USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.deletion_requests
    SET state = 'FINALIZING', failure_code = NULL
    WHERE id = deletion_request.id;
    deletion_request.state := 'FINALIZING';
    PERFORM set_config('app.tenant_id', deletion_request.tenant_id::text, true);
    PERFORM set_config('app.lifecycle_request_id', deletion_request.id::text, true);
    PERFORM set_config('app.lifecycle_effective_at', p_effective_at::text, true);

    -- Freeze the exact object set while proving S3 deletion and reconciling
    -- named holds. release_legal_hold takes the same object lock.
    PERFORM object_version.id
    FROM public.managed_object_versions object_version
    WHERE object_version.tenant_id = deletion_request.tenant_id
      AND object_version.lifecycle_state = 'ACTIVE'
      AND object_version.object_class <> 'AUDIT_DIGEST'
      AND (deletion_request.scope_kind = 'TENANT'
        OR object_version.workspace_id = deletion_request.workspace_id
        OR object_version.object_class = 'TENANT_EXPORT')
    FOR UPDATE;

    IF EXISTS (
      SELECT 1
      FROM public.managed_object_versions object_version
      WHERE object_version.tenant_id = deletion_request.tenant_id
        AND object_version.lifecycle_state = 'ACTIVE'
        AND object_version.object_class <> 'AUDIT_DIGEST'
        AND (deletion_request.scope_kind = 'TENANT'
          OR object_version.workspace_id = deletion_request.workspace_id
          OR object_version.object_class = 'TENANT_EXPORT')
        AND NOT EXISTS (
          SELECT 1
          FROM public.legal_hold_object_versions target
          JOIN public.legal_holds hold_row
            ON hold_row.tenant_id = target.tenant_id AND hold_row.id = target.hold_id
          WHERE target.tenant_id = object_version.tenant_id
            AND target.object_key = object_version.object_key
            AND target.object_version_id = object_version.object_version_id
            AND hold_row.status = 'ACTIVE'
        )
    ) THEN
      RAISE EXCEPTION 'PHYSICAL_OBJECT_DELETE_PROOF_REQUIRED' USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.managed_object_versions object_version
    SET lifecycle_state = 'LEGAL_HOLD',
        deletion_request_id = deletion_request.id,
        deleted_at = NULL
    WHERE object_version.tenant_id = deletion_request.tenant_id
      AND object_version.lifecycle_state = 'ACTIVE'
      AND object_version.object_class <> 'AUDIT_DIGEST'
      AND (deletion_request.scope_kind = 'TENANT'
        OR object_version.workspace_id = deletion_request.workspace_id
        OR object_version.object_class = 'TENANT_EXPORT')
      AND EXISTS (
        SELECT 1
        FROM public.legal_hold_object_versions target
        JOIN public.legal_holds hold_row
          ON hold_row.tenant_id = target.tenant_id AND hold_row.id = target.hold_id
        WHERE target.tenant_id = object_version.tenant_id
          AND target.object_key = object_version.object_key
          AND target.object_version_id = object_version.object_version_id
          AND hold_row.status = 'ACTIVE'
      );

    -- Tenant exports are tenant-wide derived artifacts even though workspace_id
    -- records the creating Workspace. Any Workspace deletion invalidates the
    -- indivisible archive, so remove every parent row and cascade its items.
    DELETE FROM public.tenant_exports export_row
    WHERE export_row.tenant_id = deletion_request.tenant_id;

    -- Sessions have no tenant foreign key, so remove the exact subject digests
    -- before tenant memberships are purged.
    DELETE FROM public.auth_sessions session
    WHERE EXISTS (
      SELECT 1
      FROM public.external_identities identity
      JOIN public.memberships membership ON membership.user_id = identity.user_id
      WHERE membership.tenant_id = deletion_request.tenant_id
        AND session.subject_digest = encode(
          sha256(convert_to(identity.subject, 'UTF8')), 'hex'
        )
        AND (
          deletion_request.scope_kind = 'TENANT'
          OR EXISTS (
            SELECT 1 FROM public.role_bindings binding
            WHERE binding.tenant_id = membership.tenant_id
              AND binding.membership_id = membership.id
              AND binding.workspace_id = deletion_request.workspace_id
          )
        )
    );

    -- Delete dependency leaves first. Retrying blocked parents in later passes
    -- avoids a brittle hand-maintained FK ordering while still failing closed
    -- if any active tenant table cannot be purged.
    FOR pass_number IN 1..100 LOOP
      made_progress := false;
      FOR target_table IN
        SELECT class.relname,
          EXISTS (
            SELECT 1 FROM pg_attribute workspace_attribute
            WHERE workspace_attribute.attrelid = class.oid
              AND workspace_attribute.attname = 'workspace_id'
              AND NOT workspace_attribute.attisdropped
          ) AS has_workspace_id
        FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
        WHERE namespace.nspname = 'public'
          AND class.relkind IN ('r', 'p')
          AND EXISTS (
            SELECT 1 FROM pg_attribute tenant_attribute
            WHERE tenant_attribute.attrelid = class.oid
              AND tenant_attribute.attname = 'tenant_id'
              AND NOT tenant_attribute.attisdropped
          )
          AND class.relname <> ALL (ARRAY[
            'tenants', 'workspaces', 'audit_events',
            'deletion_requests', 'deletion_tombstones',
            'managed_object_versions', 'legal_holds', 'legal_hold_object_versions',
            'legal_hold_object_reconciliations',
            'connector_secret_deletions', 'break_glass_grants',
            'audit_chain_heads', 'audit_digests'
          ]::text[])
        ORDER BY class.relname
      LOOP
        IF deletion_request.scope_kind = 'WORKSPACE' AND NOT target_table.has_workspace_id THEN
          CONTINUE;
        END IF;
        target_sql := format(
          'DELETE FROM public.%I WHERE tenant_id = $1%s',
          target_table.relname,
          CASE WHEN deletion_request.scope_kind = 'WORKSPACE'
            THEN ' AND workspace_id = $2' ELSE '' END
        );
        BEGIN
          IF deletion_request.scope_kind = 'WORKSPACE' THEN
            EXECUTE target_sql USING deletion_request.tenant_id, deletion_request.workspace_id;
          ELSE
            EXECUTE target_sql USING deletion_request.tenant_id;
          END IF;
          GET DIAGNOSTICS affected_rows = ROW_COUNT;
          made_progress := made_progress OR affected_rows > 0;
        EXCEPTION WHEN foreign_key_violation THEN
          NULL;
        END;
      END LOOP;
      EXIT WHEN NOT made_progress;
    END LOOP;

    -- Any residual row indicates an unhandled dependency or a new table that
    -- has not declared its deletion semantics. Keep the tenant frozen.
    FOR target_table IN
      SELECT class.relname,
        EXISTS (
          SELECT 1 FROM pg_attribute workspace_attribute
          WHERE workspace_attribute.attrelid = class.oid
            AND workspace_attribute.attname = 'workspace_id'
            AND NOT workspace_attribute.attisdropped
        ) AS has_workspace_id
      FROM pg_class class
      JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = 'public'
        AND class.relkind IN ('r', 'p')
        AND EXISTS (
          SELECT 1 FROM pg_attribute tenant_attribute
          WHERE tenant_attribute.attrelid = class.oid
            AND tenant_attribute.attname = 'tenant_id'
            AND NOT tenant_attribute.attisdropped
        )
        AND class.relname <> ALL (ARRAY[
          'tenants', 'workspaces', 'audit_events',
          'deletion_requests', 'deletion_tombstones',
          'managed_object_versions', 'legal_holds', 'legal_hold_object_versions',
          'legal_hold_object_reconciliations',
          'connector_secret_deletions', 'break_glass_grants',
          'audit_chain_heads', 'audit_digests'
        ]::text[])
    LOOP
      IF deletion_request.scope_kind = 'WORKSPACE' AND NOT target_table.has_workspace_id THEN
        CONTINUE;
      END IF;
      target_sql := format(
        'SELECT count(*) FROM public.%I WHERE tenant_id = $1%s',
        target_table.relname,
        CASE WHEN deletion_request.scope_kind = 'WORKSPACE'
          THEN ' AND workspace_id = $2' ELSE '' END
      );
      IF deletion_request.scope_kind = 'WORKSPACE' THEN
        EXECUTE target_sql INTO affected_rows
          USING deletion_request.tenant_id, deletion_request.workspace_id;
      ELSE
        EXECUTE target_sql INTO affected_rows USING deletion_request.tenant_id;
      END IF;
      IF affected_rows > 0 THEN
        RAISE EXCEPTION 'DELETION_ACTIVE_DATA_PURGE_BLOCKED:%', target_table.relname
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;

    IF deletion_request.scope_kind = 'TENANT' THEN
      UPDATE public.tenants
      SET name = 'Deleted tenant', lifecycle_state = 'ACTIVE_DATA_DELETED',
          access_epoch = access_epoch + 1
      WHERE id = deletion_request.tenant_id;
      UPDATE public.workspaces
      SET name = 'Deleted workspace', lifecycle_state = 'ACTIVE_DATA_DELETED',
          access_epoch = access_epoch + 1
      WHERE tenant_id = deletion_request.tenant_id;
    ELSE
      UPDATE public.workspaces
      SET name = 'Deleted workspace', lifecycle_state = 'ACTIVE_DATA_DELETED',
          access_epoch = access_epoch + 1
      WHERE tenant_id = deletion_request.tenant_id
        AND id = deletion_request.workspace_id;
    END IF;
    UPDATE public.deletion_requests
    SET state = 'ACTIVE_DATA_DELETED', active_deleted_at = p_effective_at,
        failure_code = NULL, finalization_lease_token = NULL,
        finalization_lease_expires_at = NULL
    WHERE id = deletion_request.id;
    INSERT INTO public.deletion_tombstones (
      id, tenant_id, deletion_request_id, plane, status, due_at,
      completed_at, evidence_hash
    ) VALUES (
      p_tombstone_id, deletion_request.tenant_id, deletion_request.id,
      'ACTIVE', 'COMPLETED', deletion_request.active_delete_by, p_effective_at,
      encode(sha256(convert_to(
        deletion_request.id::text || ':ACTIVE:' || p_effective_at::text, 'UTF8'
      )), 'hex')
    );
    INSERT INTO public.audit_events (
      id, tenant_id, workspace_id, actor_user_id, actor_kind, actor_principal_id, action,
      resource_type, resource_id, outcome, metadata, occurred_at
    ) VALUES (
      p_audit_event_id, deletion_request.tenant_id, audit_workspace_id,
      NULL, 'SYSTEM', 'privacy-lifecycle-worker', 'DELETION_ACTIVE_DATA_COMPLETED',
      'DELETION_REQUEST', deletion_request.id, 'SUCCEEDED',
      jsonb_build_object('tombstoneId', p_tombstone_id), p_effective_at
    );
    RETURN QUERY SELECT deletion_request.id, 'ACTIVE_DATA_DELETED'::text,
      p_effective_at, p_tombstone_id;
    RETURN;
  END IF;

  IF deletion_request.state IN ('ACTIVE_DATA_DELETED', 'BLOCKED_BY_LEGAL_HOLD')
     AND deletion_request.active_deleted_at IS NOT NULL THEN
    IF p_effective_at < deletion_request.backup_delete_by THEN
      RAISE EXCEPTION 'DELETION_BACKUP_NOT_DUE' USING ERRCODE = 'P0001';
    END IF;
    -- Reconcile the cached lifecycle marker against active exact-version holds on
    -- every pass. A released hold can never keep an object retained forever.
    UPDATE public.managed_object_versions object_version
    SET lifecycle_state = 'LEGAL_HOLD', deleted_at = NULL
    WHERE object_version.tenant_id = deletion_request.tenant_id
      AND object_version.lifecycle_state = 'DELETE_DUE'
      AND object_version.deletion_request_id = deletion_request.id
      AND (deletion_request.scope_kind = 'TENANT'
        OR object_version.workspace_id = deletion_request.workspace_id
        OR object_version.object_class = 'TENANT_EXPORT')
      AND EXISTS (
        SELECT 1
        FROM public.legal_hold_object_versions target
        JOIN public.legal_holds hold_row
          ON hold_row.tenant_id = target.tenant_id AND hold_row.id = target.hold_id
        WHERE target.tenant_id = object_version.tenant_id
          AND target.object_key = object_version.object_key
          AND target.object_version_id = object_version.object_version_id
          AND hold_row.status = 'ACTIVE'
      );
    UPDATE public.managed_object_versions object_version
    SET lifecycle_state = 'DELETE_DUE', deleted_at = NULL
    WHERE object_version.tenant_id = deletion_request.tenant_id
      AND object_version.lifecycle_state = 'LEGAL_HOLD'
      AND object_version.deletion_request_id = deletion_request.id
      AND (deletion_request.scope_kind = 'TENANT'
        OR object_version.workspace_id = deletion_request.workspace_id
        OR object_version.object_class = 'TENANT_EXPORT')
      AND NOT EXISTS (
        SELECT 1
        FROM public.legal_hold_object_versions target
        JOIN public.legal_holds hold_row
          ON hold_row.tenant_id = target.tenant_id AND hold_row.id = target.hold_id
        WHERE target.tenant_id = object_version.tenant_id
          AND target.object_key = object_version.object_key
          AND target.object_version_id = object_version.object_version_id
          AND hold_row.status = 'ACTIVE'
      );

    IF EXISTS (
      SELECT 1
      FROM public.managed_object_versions object_version
      WHERE object_version.tenant_id = deletion_request.tenant_id
        AND object_version.lifecycle_state = 'DELETE_DUE'
        AND object_version.deletion_request_id = deletion_request.id
        AND (deletion_request.scope_kind = 'TENANT'
          OR object_version.workspace_id = deletion_request.workspace_id
          OR object_version.object_class = 'TENANT_EXPORT')
    ) THEN
      RAISE EXCEPTION 'PHYSICAL_OBJECT_DELETE_PROOF_REQUIRED' USING ERRCODE = 'P0001';
    END IF;

    SELECT count(*) INTO active_holds
    FROM public.managed_object_versions object_version
    WHERE object_version.tenant_id = deletion_request.tenant_id
      AND object_version.lifecycle_state = 'LEGAL_HOLD'
      AND object_version.deletion_request_id = deletion_request.id
      AND (deletion_request.scope_kind = 'TENANT'
        OR object_version.workspace_id = deletion_request.workspace_id
        OR object_version.object_class = 'TENANT_EXPORT');
    IF active_holds > 0 THEN
      UPDATE public.deletion_requests
      SET state = 'BLOCKED_BY_LEGAL_HOLD', failure_code = 'LEGAL_HOLD',
          finalization_lease_token = NULL, finalization_lease_expires_at = NULL
      WHERE id = deletion_request.id;
      INSERT INTO public.deletion_tombstones (
        id, tenant_id, deletion_request_id, plane, status, due_at,
        completed_at, evidence_hash
      ) VALUES (
        p_tombstone_id, deletion_request.tenant_id, deletion_request.id,
        'OBJECT', 'LEGAL_HOLD', deletion_request.backup_delete_by, NULL,
        encode(sha256(convert_to(
          deletion_request.id::text || ':OBJECT:LEGAL_HOLD:' || active_holds::text,
          'UTF8'
        )), 'hex')
      ) ON CONFLICT (tenant_id, deletion_request_id, plane) DO NOTHING;
      GET DIAGNOSTICS affected_rows = ROW_COUNT;
      IF affected_rows > 0 THEN
        INSERT INTO public.audit_events (
          id, tenant_id, workspace_id, actor_user_id, actor_kind, actor_principal_id, action,
          resource_type, resource_id, outcome, metadata, occurred_at
        ) VALUES (
          p_audit_event_id, deletion_request.tenant_id, audit_workspace_id,
          NULL, 'SYSTEM', 'privacy-lifecycle-worker',
          'DELETION_BACKUP_BLOCKED_BY_LEGAL_HOLD', 'DELETION_REQUEST',
          deletion_request.id, 'FAILED',
          jsonb_build_object('heldObjectCount', active_holds, 'tombstoneId', p_tombstone_id),
          p_effective_at
        );
      END IF;
      RETURN QUERY SELECT deletion_request.id, 'BLOCKED_BY_LEGAL_HOLD'::text,
        p_effective_at, NULL::uuid;
      RETURN;
    END IF;
    UPDATE public.deletion_requests
    SET state = 'BACKUP_DELETED', backup_deleted_at = p_effective_at,
        failure_code = NULL, finalization_lease_token = NULL,
        finalization_lease_expires_at = NULL
    WHERE id = deletion_request.id;
    INSERT INTO public.deletion_tombstones (
      id, tenant_id, deletion_request_id, plane, status, due_at,
      completed_at, evidence_hash
    ) VALUES (
      p_tombstone_id, deletion_request.tenant_id, deletion_request.id,
      'BACKUP', 'COMPLETED', deletion_request.backup_delete_by, p_effective_at,
      encode(sha256(convert_to(
        deletion_request.id::text || ':BACKUP:' || p_effective_at::text, 'UTF8'
      )), 'hex')
    );
    INSERT INTO public.audit_events (
      id, tenant_id, workspace_id, actor_user_id, actor_kind, actor_principal_id, action,
      resource_type, resource_id, outcome, metadata, occurred_at
    ) VALUES (
      p_audit_event_id, deletion_request.tenant_id, audit_workspace_id,
      NULL, 'SYSTEM', 'privacy-lifecycle-worker', 'DELETION_BACKUP_COMPLETED',
      'DELETION_REQUEST', deletion_request.id, 'SUCCEEDED',
      jsonb_build_object('tombstoneId', p_tombstone_id), p_effective_at
    );
    RETURN QUERY SELECT deletion_request.id, 'BACKUP_DELETED'::text,
      p_effective_at, p_tombstone_id;
    RETURN;
  END IF;

  IF deletion_request.state = 'BACKUP_DELETED' THEN
    PERFORM set_config('app.tenant_id', deletion_request.tenant_id::text, true);
    PERFORM set_config('app.lifecycle_request_id', deletion_request.id::text, true);
    PERFORM set_config('app.lifecycle_effective_at', p_effective_at::text, true);
    IF deletion_request.scope_kind = 'TENANT' THEN
      UPDATE public.workspaces
      SET name = 'Deleted workspace', lifecycle_state = 'TOMBSTONED',
          access_epoch = access_epoch + 1, tombstoned_at = p_effective_at
      WHERE tenant_id = deletion_request.tenant_id;
      UPDATE public.tenants
      SET name = 'Deleted tenant', lifecycle_state = 'TOMBSTONED',
          access_epoch = access_epoch + 1, tombstoned_at = p_effective_at
      WHERE id = deletion_request.tenant_id;
    ELSE
      UPDATE public.workspaces
      SET name = 'Deleted workspace', lifecycle_state = 'TOMBSTONED',
          access_epoch = access_epoch + 1, tombstoned_at = p_effective_at
      WHERE tenant_id = deletion_request.tenant_id
        AND id = deletion_request.workspace_id;
    END IF;
    UPDATE public.deletion_requests
    SET state = 'TOMBSTONED', tombstoned_at = p_effective_at, failure_code = NULL,
        finalization_lease_token = NULL, finalization_lease_expires_at = NULL
    WHERE id = deletion_request.id;
    INSERT INTO public.audit_events (
      id, tenant_id, workspace_id, actor_user_id, actor_kind, actor_principal_id, action,
      resource_type, resource_id, outcome, metadata, occurred_at
    ) VALUES (
      p_audit_event_id, deletion_request.tenant_id, audit_workspace_id,
      NULL, 'SYSTEM', 'privacy-lifecycle-worker', 'DELETION_TOMBSTONED',
      'DELETION_REQUEST', deletion_request.id, 'SUCCEEDED',
      jsonb_build_object('tombstoneId', p_tombstone_id), p_effective_at
    );
    RETURN QUERY SELECT deletion_request.id, 'TOMBSTONED'::text,
      p_effective_at, p_tombstone_id;
    RETURN;
  END IF;

  RAISE EXCEPTION 'DELETION_STATE_TRANSITION_INVALID:%', deletion_request.state
    USING ERRCODE = 'P0001';
END
$function$;

REVOKE ALL ON FUNCTION guard_lifecycle_scoped_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_connector_secret_deletion_requested(
  uuid, uuid, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_connector_secret_unreadable(uuid, uuid, timestamptz)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_connector_secret_deletion_requested(
  uuid, uuid, timestamptz
) FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION mark_connector_secret_unreadable(uuid, uuid, timestamptz)
  FROM aeostudio_runtime;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aeostudio_lifecycle_worker') THEN
    RAISE EXCEPTION 'LIFECYCLE_WORKER_ROLE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'aeostudio_lifecycle_worker'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
        OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_WORKER_ROLE_PRIVILEGE_INVALID' USING ERRCODE = '42501';
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO aeostudio_lifecycle_worker;
REVOKE ALL ON FUNCTION finalize_deletion(uuid, uuid, timestamptz, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_due_deletion_requests(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_due_secret_deletions(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION worker_mark_secret_deletion_requested(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION worker_mark_secret_unreadable(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_deletion(uuid, uuid, timestamptz, uuid, uuid)
  FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION claim_due_deletion_requests(uuid, integer)
  FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION claim_due_secret_deletions(uuid, integer)
  FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION worker_mark_secret_deletion_requested(uuid, uuid, uuid)
  FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION worker_mark_secret_unreadable(uuid, uuid, uuid)
  FROM aeostudio_runtime;
GRANT EXECUTE ON FUNCTION finalize_deletion(uuid, uuid, timestamptz, uuid, uuid)
  TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION claim_due_deletion_requests(uuid, integer)
  TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION claim_due_secret_deletions(uuid, integer)
  TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION worker_mark_secret_deletion_requested(uuid, uuid, uuid)
  TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION worker_mark_secret_unreadable(uuid, uuid, uuid)
  TO aeostudio_lifecycle_worker;
