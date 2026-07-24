-- Task 18: private Tenant Data Broker authority, replay fence, and durable
-- cloud-effect journal. Tenant payload bytes and secret plaintext are never
-- persisted in these tables.
DO $roles$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'aeostudio_tenant_data_broker'
  ) THEN
    CREATE ROLE aeostudio_tenant_data_broker NOLOGIN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'aeostudio_tenant_data_broker'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
        OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_ROLE_PRIVILEGE_INVALID'
      USING ERRCODE = '42501';
  END IF;
END
$roles$;

ALTER TABLE memberships
  ADD COLUMN tenant_data_access_revision bigint NOT NULL DEFAULT 0
    CHECK (tenant_data_access_revision >= 0);
ALTER TABLE role_bindings
  ADD COLUMN tenant_data_access_revision bigint NOT NULL DEFAULT 0
    CHECK (tenant_data_access_revision >= 0);

CREATE TABLE tenant_data_broker_nonces (
  nonce uuid PRIMARY KEY,
  nonce_hash text NOT NULL UNIQUE CHECK (nonce_hash ~ '^[a-f0-9]{64}$'),
  signed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL,
  UNIQUE (nonce, nonce_hash),
  CHECK (expires_at = signed_at + interval '30 seconds')
);

CREATE INDEX tenant_data_broker_nonces_prune_idx
  ON tenant_data_broker_nonces (expires_at, nonce);

CREATE TABLE tenant_data_broker_resource_authority (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  workload_bucket text NOT NULL CHECK (
    workload_bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
    AND workload_bucket !~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
    AND position('..' IN workload_bucket) = 0
    AND position('.-' IN workload_bucket) = 0
    AND position('-.' IN workload_bucket) = 0
  ),
  tenant_export_bucket text NOT NULL CHECK (
    tenant_export_bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
    AND tenant_export_bucket !~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
    AND position('..' IN tenant_export_bucket) = 0
    AND position('.-' IN tenant_export_bucket) = 0
    AND position('-.' IN tenant_export_bucket) = 0
  ),
  audit_evidence_bucket text NOT NULL CHECK (
    audit_evidence_bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
    AND audit_evidence_bucket !~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
    AND position('..' IN audit_evidence_bucket) = 0
    AND position('.-' IN audit_evidence_bucket) = 0
    AND position('-.' IN audit_evidence_bucket) = 0
  ),
  aws_account_id text NOT NULL CHECK (aws_account_id ~ '^[0-9]{12}$'),
  kms_key_arn text NOT NULL CHECK (
    kms_key_arn ~ '^arn:aws:kms:ap-southeast-1:[0-9]{12}:key/[0-9a-f-]{36}$'
  ),
  configured_at timestamptz NOT NULL,
  CHECK (workload_bucket = tenant_export_bucket)
);

CREATE TABLE tenant_data_capabilities (
  capability_id uuid PRIMARY KEY,
  source_kind text NOT NULL CHECK (source_kind IN (
    'ACTIVE_PUBLICATION_JOB', 'CONNECTOR_DELETION_INTENT',
    'WORKLOAD_WRITE_INTENT', 'PRIVACY_WRITE_INTENT',
    'ACTIVE_JOB_OBJECT_READ', 'AUTHENTICATED_OBJECT_READ',
    'DELETION_INVENTORY_INTENT', 'DELETION_OBJECT_INTENT',
    'LEGAL_HOLD_RECONCILIATION_INTENT'
  )),
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 2048),
  source_revision bigint NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  lease_token_sha256 text NOT NULL CHECK (lease_token_sha256 ~ '^[a-f0-9]{64}$'),
  effect_identity text NOT NULL CHECK (length(effect_identity) BETWEEN 1 AND 2048),
  authority_kind text NOT NULL,
  authority_reference text NOT NULL CHECK (length(authority_reference) BETWEEN 1 AND 2048),
  scope_kind text NOT NULL CHECK (scope_kind IN ('TENANT', 'WORKSPACE')),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workspace_id uuid,
  operation text NOT NULL CHECK (operation IN (
    'READ_CONNECTOR_SECRET', 'DESCRIBE_CONNECTOR_SECRET',
    'VERIFY_CONNECTOR_SECRET_UNREADABLE', 'DELETE_CONNECTOR_SECRET',
    'PUT_WORKLOAD_OBJECT', 'READ_WORKLOAD_OBJECT', 'HEAD_WORKLOAD_OBJECT',
    'DELETE_WORKLOAD_OBJECT_VERSION', 'PUT_PRIVACY_OBJECT',
    'READ_PRIVACY_OBJECT', 'HEAD_PRIVACY_OBJECT',
    'LIST_TENANT_OBJECT_VERSIONS', 'DELETE_PRIVACY_OBJECT_VERSION',
    'GET_OBJECT_LEGAL_HOLD', 'SET_OBJECT_LEGAL_HOLD'
  )),
  resource jsonb NOT NULL CHECK (jsonb_typeof(resource) = 'object'),
  resource_hash text NOT NULL CHECK (resource_hash ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (source_kind, source_reference, operation, source_revision, effect_identity),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id),
  CHECK ((scope_kind = 'TENANT' AND workspace_id IS NULL)
    OR (scope_kind = 'WORKSPACE' AND workspace_id IS NOT NULL)),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes')
);

CREATE INDEX tenant_data_capabilities_expiry_idx
  ON tenant_data_capabilities (expires_at, capability_id);

-- A user-facing object read must remain joined to the live browser session,
-- membership, role binding, access epochs, and one exact managed version.
-- The raw session token is verified by the issuer and is never persisted.
CREATE TABLE tenant_data_authenticated_object_read_sources (
  source_id uuid PRIMARY KEY,
  session_token_digest text NOT NULL
    REFERENCES auth_sessions(token_digest) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_binding_id uuid NOT NULL REFERENCES role_bindings(id) ON DELETE CASCADE,
  role_at_issue text NOT NULL CHECK (role_at_issue IN (
    'OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'PUBLISHER', 'ANALYST', 'VIEWER'
  )),
  membership_revision bigint NOT NULL CHECK (membership_revision >= 0),
  role_binding_revision bigint NOT NULL CHECK (role_binding_revision >= 0),
  tenant_access_epoch bigint NOT NULL CHECK (tenant_access_epoch >= 0),
  workspace_access_epoch bigint NOT NULL CHECK (workspace_access_epoch >= 0),
  managed_object_id uuid NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, workspace_id)
    REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, membership_id)
    REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, managed_object_id)
    REFERENCES managed_object_versions(tenant_id, id) ON DELETE CASCADE,
  CHECK (
    expires_at > issued_at
    AND expires_at <= issued_at + interval '5 minutes'
  )
);

CREATE INDEX tenant_data_authenticated_object_read_sources_expiry_idx
  ON tenant_data_authenticated_object_read_sources (expires_at, source_id);

CREATE TABLE tenant_data_broker_attempts (
  attempt_id uuid PRIMARY KEY,
  capability_id uuid NOT NULL REFERENCES tenant_data_capabilities(capability_id),
  effect_identity text NOT NULL,
  nonce uuid NOT NULL,
  nonce_hash text NOT NULL CHECK (nonce_hash ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL,
  resource_hash text NOT NULL CHECK (resource_hash ~ '^[a-f0-9]{64}$'),
  effectful boolean NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('STARTED', 'SUCCESS', 'FAILED', 'UNKNOWN')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  CHECK ((outcome = 'STARTED' AND finished_at IS NULL)
    OR (outcome <> 'STARTED' AND finished_at IS NOT NULL)),
  FOREIGN KEY (nonce, nonce_hash)
    REFERENCES tenant_data_broker_nonces(nonce, nonce_hash)
);

CREATE INDEX tenant_data_broker_attempts_capability_idx
  ON tenant_data_broker_attempts (capability_id, started_at DESC);

CREATE TABLE tenant_data_broker_effects (
  effect_identity text PRIMARY KEY,
  operation text NOT NULL,
  state text NOT NULL CHECK (state IN ('STARTED', 'SUCCESS', 'FAILED', 'UNKNOWN')),
  active_attempt_id uuid NOT NULL
    REFERENCES tenant_data_broker_attempts(attempt_id),
  success_receipt jsonb,
  updated_at timestamptz NOT NULL,
  CHECK ((state = 'SUCCESS' AND success_receipt IS NOT NULL
      AND jsonb_typeof(success_receipt) = 'object'
      AND octet_length(success_receipt::text) <= 8192)
    OR (state <> 'SUCCESS' AND success_receipt IS NULL))
);

REVOKE ALL ON tenant_data_broker_nonces FROM PUBLIC;
REVOKE ALL ON tenant_data_broker_resource_authority FROM PUBLIC;
REVOKE ALL ON tenant_data_capabilities FROM PUBLIC;
REVOKE ALL ON tenant_data_authenticated_object_read_sources FROM PUBLIC;
REVOKE ALL ON tenant_data_broker_attempts FROM PUBLIC;
REVOKE ALL ON tenant_data_broker_effects FROM PUBLIC;
REVOKE ALL ON tenant_data_broker_nonces FROM aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;
REVOKE ALL ON tenant_data_broker_resource_authority
  FROM aeostudio_runtime, aeostudio_lifecycle_worker, aeostudio_tenant_data_broker;
REVOKE ALL ON tenant_data_capabilities FROM aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;
REVOKE ALL ON tenant_data_authenticated_object_read_sources
  FROM aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON tenant_data_broker_attempts FROM aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;
REVOKE ALL ON tenant_data_broker_effects FROM aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;

-- Lifecycle access_epoch remains owned by the privacy lifecycle guard. These
-- two narrow row revisions provide the equivalent monotonic fence for access
-- control changes, so a role/status restored later cannot revive an old read.
CREATE FUNCTION tenant_data_bump_role_binding_revision_private()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.role IS NOT DISTINCT FROM OLD.role THEN
    IF NEW.tenant_data_access_revision IS DISTINCT FROM
       OLD.tenant_data_access_revision THEN
      RAISE EXCEPTION 'ROLE_BINDING_ACCESS_REVISION_FORBIDDEN'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  NEW.tenant_data_access_revision := OLD.tenant_data_access_revision + 1;
  RETURN NEW;
END
$function$;

CREATE FUNCTION tenant_data_bump_membership_revision_private()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    IF NEW.tenant_data_access_revision IS DISTINCT FROM
       OLD.tenant_data_access_revision THEN
      RAISE EXCEPTION 'MEMBERSHIP_ACCESS_REVISION_FORBIDDEN'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  NEW.tenant_data_access_revision := OLD.tenant_data_access_revision + 1;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION
  tenant_data_bump_role_binding_revision_private()
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION
  tenant_data_bump_membership_revision_private()
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;

CREATE TRIGGER tenant_data_role_binding_revision
BEFORE UPDATE OF role, tenant_data_access_revision ON role_bindings
FOR EACH ROW
EXECUTE FUNCTION
  tenant_data_bump_role_binding_revision_private();

CREATE TRIGGER tenant_data_membership_revision
BEFORE UPDATE OF status, tenant_data_access_revision ON memberships
FOR EACH ROW
EXECUTE FUNCTION
  tenant_data_bump_membership_revision_private();

ALTER TABLE channel_packages
  ADD CONSTRAINT channel_packages_tenant_data_object_binding_unique
  UNIQUE (
    tenant_id, workspace_id, id, package_checksum, payload_object_ref
  );

CREATE TABLE tenant_data_channel_package_object_bindings (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  channel_package_id uuid NOT NULL,
  package_checksum text NOT NULL CHECK (package_checksum ~ '^[a-f0-9]{64}$'),
  payload_object_ref text NOT NULL CHECK (
    length(payload_object_ref) BETWEEN 1 AND 2048
  ),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
  object_version_id text NOT NULL CHECK (
    length(object_version_id) BETWEEN 1 AND 1024
  ),
  bound_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, channel_package_id),
  UNIQUE (tenant_id, object_key, object_version_id),
  FOREIGN KEY (
    tenant_id, workspace_id, channel_package_id, package_checksum,
    payload_object_ref
  ) REFERENCES channel_packages (
    tenant_id, workspace_id, id, package_checksum, payload_object_ref
  ),
  FOREIGN KEY (tenant_id, object_key, object_version_id)
    REFERENCES managed_object_versions(
      tenant_id, object_key, object_version_id
    )
);

REVOKE ALL ON tenant_data_channel_package_object_bindings FROM PUBLIC;
REVOKE ALL ON tenant_data_channel_package_object_bindings
  FROM aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;

CREATE FUNCTION bind_tenant_data_channel_package_object_private(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_channel_package_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  package public.channel_packages%ROWTYPE;
  object_version public.managed_object_versions%ROWTYPE;
  existing public.tenant_data_channel_package_object_bindings%ROWTYPE;
  candidate_count integer;
  canonical_key text;
BEGIN
  IF p_tenant_id IS NULL OR p_workspace_id IS NULL
     OR p_channel_package_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT stored.* INTO package
  FROM public.channel_packages stored
  WHERE stored.tenant_id = p_tenant_id
    AND stored.workspace_id = p_workspace_id
    AND stored.id = p_channel_package_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  canonical_key :=
    'tenants/' || package.tenant_id::text || '/workspaces/' ||
    package.workspace_id::text || '/channel-packages/' ||
    package.package_checksum || '.json';
  SELECT count(*) INTO candidate_count
  FROM public.managed_object_versions stored
  WHERE stored.tenant_id = package.tenant_id
    AND stored.workspace_id = package.workspace_id
    AND stored.object_class = 'CHANNEL_PACKAGE'
    AND stored.object_ref = package.payload_object_ref
    AND stored.object_key = canonical_key
    AND stored.checksum = package.package_checksum
    AND stored.lifecycle_state = 'ACTIVE'
    AND NOT stored.is_delete_marker
    AND stored.byte_length BETWEEN 1 AND 2147483648;
  IF candidate_count = 0 THEN RETURN false; END IF;
  IF candidate_count <> 1 THEN
    RAISE EXCEPTION 'CHANNEL_PACKAGE_OBJECT_BINDING_AMBIGUOUS'
      USING ERRCODE = '23505';
  END IF;

  SELECT stored.* INTO object_version
  FROM public.managed_object_versions stored
  WHERE stored.tenant_id = package.tenant_id
    AND stored.workspace_id = package.workspace_id
    AND stored.object_class = 'CHANNEL_PACKAGE'
    AND stored.object_ref = package.payload_object_ref
    AND stored.object_key = canonical_key
    AND stored.checksum = package.package_checksum
    AND stored.lifecycle_state = 'ACTIVE'
    AND NOT stored.is_delete_marker
    AND stored.byte_length BETWEEN 1 AND 2147483648
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT stored.* INTO existing
  FROM public.tenant_data_channel_package_object_bindings stored
  WHERE stored.tenant_id = package.tenant_id
    AND stored.workspace_id = package.workspace_id
    AND stored.channel_package_id = package.id
  FOR UPDATE;
  IF FOUND THEN
    IF existing.package_checksum IS DISTINCT FROM package.package_checksum
       OR existing.payload_object_ref IS DISTINCT FROM package.payload_object_ref
       OR existing.object_key IS DISTINCT FROM object_version.object_key
       OR existing.object_version_id IS DISTINCT FROM
         object_version.object_version_id THEN
      RAISE EXCEPTION 'CHANNEL_PACKAGE_OBJECT_BINDING_AMBIGUOUS'
        USING ERRCODE = '23505';
    END IF;
    RETURN true;
  END IF;

  INSERT INTO public.tenant_data_channel_package_object_bindings (
    tenant_id, workspace_id, channel_package_id, package_checksum,
    payload_object_ref, object_key, object_version_id, bound_at
  ) VALUES (
    package.tenant_id, package.workspace_id, package.id,
    package.package_checksum, package.payload_object_ref,
    object_version.object_key, object_version.object_version_id,
    clock_timestamp()
  );
  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION bind_tenant_data_channel_package_object_private(
  uuid, uuid, uuid
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;

CREATE FUNCTION bind_tenant_data_channel_package_after_insert_private()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM public.bind_tenant_data_channel_package_object_private(
    NEW.tenant_id, NEW.workspace_id, NEW.id
  );
  RETURN NEW;
END
$function$;

CREATE FUNCTION bind_tenant_data_managed_package_after_insert_private()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  package record;
BEGIN
  FOR package IN
    SELECT stored.tenant_id, stored.workspace_id, stored.id
    FROM public.channel_packages stored
    WHERE stored.tenant_id = NEW.tenant_id
      AND stored.workspace_id = NEW.workspace_id
      AND stored.package_checksum = NEW.checksum
      AND stored.payload_object_ref = NEW.object_ref
  LOOP
    PERFORM public.bind_tenant_data_channel_package_object_private(
      package.tenant_id, package.workspace_id, package.id
    );
  END LOOP;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION bind_tenant_data_channel_package_after_insert_private()
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION bind_tenant_data_managed_package_after_insert_private()
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;

CREATE TRIGGER tenant_data_channel_package_object_binding
AFTER INSERT ON channel_packages
FOR EACH ROW
EXECUTE FUNCTION bind_tenant_data_channel_package_after_insert_private();

CREATE TRIGGER tenant_data_managed_package_object_binding
AFTER INSERT ON managed_object_versions
FOR EACH ROW
WHEN (NEW.object_class = 'CHANNEL_PACKAGE')
EXECUTE FUNCTION bind_tenant_data_managed_package_after_insert_private();

DO $block$
DECLARE
  package record;
BEGIN
  FOR package IN
    SELECT stored.tenant_id, stored.workspace_id, stored.id
    FROM public.channel_packages stored
  LOOP
    PERFORM public.bind_tenant_data_channel_package_object_private(
      package.tenant_id, package.workspace_id, package.id
    );
  END LOOP;
END
$block$;

CREATE FUNCTION configure_tenant_data_broker_resource_authority(
  p_workload_bucket text,
  p_tenant_export_bucket text,
  p_audit_evidence_bucket text,
  p_aws_account_id text,
  p_kms_key_arn text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  configured public.tenant_data_broker_resource_authority%ROWTYPE;
  configured_count integer;
BEGIN
  IF p_workload_bucket IS NULL
     OR p_tenant_export_bucket IS NULL
     OR p_audit_evidence_bucket IS NULL
     OR p_aws_account_id IS NULL
     OR p_kms_key_arn IS NULL
     OR p_workload_bucket IS DISTINCT FROM p_tenant_export_bucket
     OR p_workload_bucket !~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
     OR p_audit_evidence_bucket !~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
     OR p_workload_bucket ~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
     OR p_audit_evidence_bucket ~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
     OR position('..' IN p_workload_bucket) > 0
     OR position('.-' IN p_workload_bucket) > 0
     OR position('-.' IN p_workload_bucket) > 0
     OR position('..' IN p_audit_evidence_bucket) > 0
     OR position('.-' IN p_audit_evidence_bucket) > 0
     OR position('-.' IN p_audit_evidence_bucket) > 0
     OR p_aws_account_id !~ '^[0-9]{12}$'
     OR p_kms_key_arn !~
       '^arn:aws:kms:ap-southeast-1:[0-9]{12}:key/[0-9a-f-]{36}$'
     OR split_part(p_kms_key_arn, ':', 5) IS DISTINCT FROM p_aws_account_id THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_RESOURCE_AUTHORITY_INVALID'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('tenant-data-broker-resource-authority', 0)
  );
  SELECT count(*) INTO configured_count
  FROM public.tenant_data_broker_resource_authority;
  IF configured_count = 0 THEN
    INSERT INTO public.tenant_data_broker_resource_authority (
      singleton, workload_bucket, tenant_export_bucket, audit_evidence_bucket,
      aws_account_id, kms_key_arn, configured_at
    ) VALUES (
      true, p_workload_bucket, p_tenant_export_bucket, p_audit_evidence_bucket,
      p_aws_account_id, p_kms_key_arn, clock_timestamp()
    );
    RETURN true;
  END IF;
  IF configured_count <> 1 THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_RESOURCE_AUTHORITY_CARDINALITY_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO STRICT configured
  FROM public.tenant_data_broker_resource_authority
  WHERE singleton;
  IF configured.workload_bucket IS DISTINCT FROM p_workload_bucket
     OR configured.tenant_export_bucket IS DISTINCT FROM p_tenant_export_bucket
     OR configured.audit_evidence_bucket IS DISTINCT FROM p_audit_evidence_bucket
     OR configured.aws_account_id IS DISTINCT FROM p_aws_account_id
     OR configured.kms_key_arn IS DISTINCT FROM p_kms_key_arn THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_RESOURCE_AUTHORITY_DRIFT'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION configure_tenant_data_broker_resource_authority(
  text, text, text, text, text
) FROM PUBLIC;

CREATE FUNCTION consume_tenant_data_broker_nonce(
  p_nonce uuid,
  p_signed_at timestamptz,
  p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  inserted integer;
BEGIN
  IF p_nonce IS NULL OR p_signed_at IS NULL OR p_expires_at IS NULL
     OR abs(extract(epoch from (p_signed_at - database_now))) > 30
     OR p_expires_at <> p_signed_at + interval '30 seconds'
     OR p_expires_at <= database_now THEN
    RETURN false;
  END IF;

  -- A nonce remains globally unique well beyond its acceptance window. Prune
  -- only a bounded batch older than the rotation/skew retention floor.
  WITH prune AS (
    SELECT stored.nonce
    FROM public.tenant_data_broker_nonces stored
    WHERE stored.expires_at < database_now - interval '10 minutes'
      AND NOT EXISTS (
        SELECT 1
        FROM public.tenant_data_broker_attempts attempt
        WHERE attempt.nonce = stored.nonce
      )
    ORDER BY stored.expires_at, stored.nonce
    LIMIT 1000
  )
  DELETE FROM public.tenant_data_broker_nonces stored
  USING prune
  WHERE stored.nonce = prune.nonce;

  INSERT INTO public.tenant_data_broker_nonces (
    nonce, nonce_hash, signed_at, expires_at, first_seen_at
  ) VALUES (
    p_nonce, encode(sha256(convert_to(p_nonce::text, 'UTF8')), 'hex'),
    p_signed_at, p_expires_at, database_now
  )
  -- Both columns encode the same replay identity. With concurrent inserts,
  -- PostgreSQL may discover either unique index first, so handle either
  -- conflict as the same idempotent replay rejection.
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted = 1;
END
$function$;

CREATE FUNCTION tenant_data_canonical_utc_instant_private(
  p_value timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT to_char(
    p_value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  )
$function$;

REVOKE ALL ON FUNCTION tenant_data_canonical_utc_instant_private(
  timestamptz
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;

CREATE FUNCTION issue_workload_object_put_capability(
  p_operation_id uuid,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  intent public.workload_object_write_intents%ROWTYPE;
  derived_resource jsonb;
  derived_resource_hash text;
  derived_effect_identity text;
  derived_lease_hash text;
  issued_id uuid;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL OR p_capability_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO intent
  FROM public.workload_object_write_intents source
  WHERE source.operation_id = p_operation_id
    AND source.status = 'PENDING'
    AND source.work_lease_token = p_lease_token
    AND source.work_lease_expires_at > database_now
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  derived_resource := jsonb_build_object(
    'kind', 'WORKLOAD_OBJECT_PUT',
    'objectClass', 'WORKLOAD_OBJECTS',
    'bucket', authority.workload_bucket,
    'key', intent.object_key,
    'checksumSha256', intent.checksum,
    'contentType', intent.content_type,
    'byteLength', intent.byte_length,
    'lockedUntil', NULL,
    'sealedAt', NULL
  );
  derived_effect_identity := 'WORKLOAD_OBJECT_WRITE:' || intent.operation_id::text;
  derived_resource_hash := encode(
    sha256(
      convert_to(
        public.aeostudio_backup_evidence_canonical_json(derived_resource),
        'UTF8'
      )
    ),
    'hex'
  );
  derived_lease_hash := encode(
    sha256(convert_to(p_lease_token::text, 'UTF8')), 'hex'
  );
  INSERT INTO public.tenant_data_capabilities (
    capability_id, source_kind, source_reference, source_revision,
    lease_token_sha256, effect_identity, authority_kind, authority_reference,
    scope_kind, tenant_id, workspace_id, operation, resource, resource_hash,
    issued_at, expires_at
  ) VALUES (
    p_capability_id, 'WORKLOAD_WRITE_INTENT', intent.operation_id::text,
    intent.work_attempt_count, derived_lease_hash, derived_effect_identity,
     'WORKLOAD_WRITE_INTENT', intent.operation_id::text, 'WORKSPACE',
     intent.tenant_id, intent.workspace_id, 'PUT_WORKLOAD_OBJECT',
     derived_resource, derived_resource_hash, database_now,
    LEAST(intent.work_lease_expires_at, database_now + interval '5 minutes')
  )
  ON CONFLICT (
    source_kind, source_reference, operation, source_revision, effect_identity
  ) DO NOTHING;

  SELECT capability.capability_id INTO issued_id
  FROM public.tenant_data_capabilities capability
  WHERE capability.source_kind = 'WORKLOAD_WRITE_INTENT'
    AND capability.source_reference = intent.operation_id::text
    AND capability.operation = 'PUT_WORKLOAD_OBJECT'
    AND capability.source_revision = intent.work_attempt_count
    AND capability.effect_identity = derived_effect_identity
    AND capability.lease_token_sha256 = derived_lease_hash
    AND capability.resource = derived_resource
    AND capability.resource_hash = derived_resource_hash
    AND capability.expires_at > database_now;
  RETURN issued_id;
END
$function$;

REVOKE ALL ON FUNCTION issue_workload_object_put_capability(
  uuid, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION tenant_data_issue_capability_private(
  p_capability_id uuid,
  p_source_kind text,
  p_source_reference text,
  p_source_revision bigint,
  p_lease_token uuid,
  p_effect_identity text,
  p_authority_kind text,
  p_authority_reference text,
  p_scope_kind text,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_operation text,
  p_resource jsonb,
  p_expires_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  derived_lease_hash text;
  derived_resource_hash text;
  issued_id uuid;
BEGIN
  IF p_capability_id IS NULL OR p_source_kind IS NULL
     OR p_source_reference IS NULL OR p_source_revision IS NULL
     OR p_source_revision < 0 OR p_lease_token IS NULL
     OR p_effect_identity IS NULL OR p_authority_kind IS NULL
     OR p_authority_reference IS NULL OR p_scope_kind IS NULL
     OR p_tenant_id IS NULL OR p_operation IS NULL OR p_resource IS NULL
     OR jsonb_typeof(p_resource) <> 'object'
     OR p_expires_at IS NULL OR p_expires_at <= database_now THEN
    RETURN NULL;
  END IF;
  derived_lease_hash := encode(
    sha256(convert_to(p_lease_token::text, 'UTF8')), 'hex'
  );
  derived_resource_hash := encode(
    sha256(convert_to(
      public.aeostudio_backup_evidence_canonical_json(p_resource), 'UTF8'
    )),
    'hex'
  );
  INSERT INTO public.tenant_data_capabilities (
    capability_id, source_kind, source_reference, source_revision,
    lease_token_sha256, effect_identity, authority_kind, authority_reference,
    scope_kind, tenant_id, workspace_id, operation, resource, resource_hash,
    issued_at, expires_at
  ) VALUES (
    p_capability_id, p_source_kind, p_source_reference, p_source_revision,
    derived_lease_hash, p_effect_identity, p_authority_kind,
    p_authority_reference, p_scope_kind, p_tenant_id, p_workspace_id,
    p_operation, p_resource, derived_resource_hash, database_now,
    LEAST(p_expires_at, database_now + interval '5 minutes')
  )
  ON CONFLICT (
    source_kind, source_reference, operation, source_revision, effect_identity
  ) DO NOTHING;

  SELECT capability.capability_id INTO issued_id
  FROM public.tenant_data_capabilities capability
  WHERE capability.source_kind = p_source_kind
    AND capability.source_reference = p_source_reference
    AND capability.source_revision = p_source_revision
    AND capability.lease_token_sha256 = derived_lease_hash
    AND capability.effect_identity = p_effect_identity
    AND capability.authority_kind = p_authority_kind
    AND capability.authority_reference = p_authority_reference
    AND capability.scope_kind = p_scope_kind
    AND capability.tenant_id = p_tenant_id
    AND capability.workspace_id IS NOT DISTINCT FROM p_workspace_id
    AND capability.operation = p_operation
    AND capability.resource = p_resource
    AND capability.resource_hash = derived_resource_hash
    AND capability.expires_at > database_now;
  RETURN issued_id;
END
$function$;

REVOKE ALL ON FUNCTION tenant_data_issue_capability_private(
  uuid, text, text, bigint, uuid, text, text, text, text, uuid, uuid,
  text, jsonb, timestamptz
) FROM PUBLIC;

CREATE FUNCTION issue_publication_package_read_capability(
  p_publication_id uuid,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  source record;
  derived_resource jsonb;
BEGIN
  IF p_publication_id IS NULL OR p_lease_token IS NULL
     OR p_capability_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT publication.id AS publication_id, publication.tenant_id,
    publication.workspace_id, job.attempt, job.lease_expires_at,
    object_version.object_key, object_version.object_version_id,
    object_version.checksum, object_version.content_type,
    object_version.byte_length
    INTO source
  FROM public.publication_records publication
  JOIN public.jobs job
    ON job.tenant_id = publication.tenant_id
   AND job.workspace_id = publication.workspace_id
   AND job.id = publication.job_id
  JOIN public.channel_packages package
    ON package.tenant_id = publication.tenant_id
   AND package.workspace_id = publication.workspace_id
   AND package.id = publication.channel_package_id
   AND package.package_checksum = publication.package_checksum
   AND package.artifact_revision_id = publication.artifact_revision_id
   AND package.artifact_content_hash = publication.artifact_content_hash
  JOIN public.tenant_data_channel_package_object_bindings binding
    ON binding.tenant_id = package.tenant_id
   AND binding.workspace_id = package.workspace_id
   AND binding.channel_package_id = package.id
   AND binding.package_checksum = package.package_checksum
   AND binding.payload_object_ref = package.payload_object_ref
  JOIN public.managed_object_versions object_version
    ON object_version.tenant_id = binding.tenant_id
   AND object_version.workspace_id = binding.workspace_id
   AND object_version.object_key = binding.object_key
   AND object_version.object_version_id = binding.object_version_id
   AND object_version.object_ref = binding.payload_object_ref
   AND object_version.object_class = 'CHANNEL_PACKAGE'
   AND object_version.checksum = binding.package_checksum
   AND object_version.lifecycle_state = 'ACTIVE'
   AND NOT object_version.is_delete_marker
   AND object_version.object_key =
     'tenants/' || package.tenant_id::text || '/workspaces/' ||
     package.workspace_id::text || '/channel-packages/' ||
     package.package_checksum || '.json'
  JOIN public.tenants tenant
    ON tenant.id = publication.tenant_id AND tenant.lifecycle_state = 'ACTIVE'
  JOIN public.workspaces workspace
    ON workspace.tenant_id = publication.tenant_id
   AND workspace.id = publication.workspace_id
   AND workspace.lifecycle_state = 'ACTIVE'
  WHERE publication.id = p_publication_id
    AND publication.status IN (
      'RUNNING', 'RECONCILING', 'ROLLBACK_QUEUED'
    )
    AND job.job_type = 'PUBLICATION'
    AND job.status = 'RUNNING'
    AND job.lease_token = p_lease_token
    AND job.lease_expires_at > database_now;
  IF NOT FOUND OR source.checksum IS NULL OR source.byte_length < 1 THEN
    RETURN NULL;
  END IF;

  derived_resource := jsonb_build_object(
    'kind', 'OBJECT_VERSION',
    'objectClass', 'WORKLOAD_OBJECTS',
    'bucket', authority.workload_bucket,
    'key', source.object_key,
    'versionId', source.object_version_id,
    'checksumSha256', source.checksum,
    'contentType', source.content_type,
    'byteLength', source.byte_length
  );
  RETURN public.tenant_data_issue_capability_private(
    p_capability_id, 'ACTIVE_JOB_OBJECT_READ', source.publication_id::text,
    source.attempt, p_lease_token,
    'PUBLICATION_PACKAGE_READ:' || source.publication_id::text || ':' ||
      source.object_version_id,
    'ACTIVE_JOB_OBJECT_READ', source.publication_id::text, 'WORKSPACE',
    source.tenant_id, source.workspace_id, 'READ_WORKLOAD_OBJECT',
    derived_resource, source.lease_expires_at
  );
END
$function$;

REVOKE ALL ON FUNCTION issue_publication_package_read_capability(
  uuid, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION issue_publication_secret_read_capability(
  p_publication_id uuid,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  source record;
  derived_resource jsonb;
BEGIN
  IF p_publication_id IS NULL OR p_lease_token IS NULL
     OR p_capability_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT publication.id AS publication_id, publication.tenant_id,
    publication.workspace_id, job.attempt, job.lease_expires_at,
    channel_auth.secret_arn,
    LEAST(
      job.lease_expires_at,
      COALESCE(channel_auth.expires_at, job.lease_expires_at)
    ) AS authority_expires_at
    INTO source
  FROM public.publication_records publication
  JOIN public.jobs job
    ON job.tenant_id = publication.tenant_id
   AND job.workspace_id = publication.workspace_id
   AND job.id = publication.job_id
  JOIN public.channel_packages package
    ON package.tenant_id = publication.tenant_id
   AND package.workspace_id = publication.workspace_id
   AND package.id = publication.channel_package_id
   AND package.package_checksum = publication.package_checksum
   AND package.artifact_revision_id = publication.artifact_revision_id
   AND package.artifact_content_hash = publication.artifact_content_hash
  JOIN public.adapter_versions adapter
    ON adapter.id = publication.adapter_version_id
   AND adapter.channel_definition_id = package.channel_definition_id
   AND adapter.enabled
   AND adapter.terms_status = 'ALLOWED'
   AND 'PUBLISH' = ANY(adapter.capabilities)
   AND 'RECONCILE' = ANY(adapter.capabilities)
   AND (
     adapter.provider_api_supported_until IS NULL
     OR adapter.provider_api_supported_until > database_now
   )
  JOIN public.channel_definitions channel
    ON channel.id = adapter.channel_definition_id
   AND channel.status = 'AVAILABLE'
  JOIN public.channel_authorizations channel_auth
    ON channel_auth.tenant_id = publication.tenant_id
   AND channel_auth.workspace_id = publication.workspace_id
   AND channel_auth.id = publication.channel_authorization_id
   AND channel_auth.adapter_version_id = adapter.id
   AND channel_auth.target = publication.authorization_target
   AND channel_auth.status = 'ACTIVE'
   AND channel_auth.accepted_terms_version = adapter.terms_version
   AND adapter.required_scopes <@ channel_auth.granted_scopes
   AND (
     channel_auth.expires_at IS NULL
     OR channel_auth.expires_at > database_now
   )
  JOIN public.tenants tenant
    ON tenant.id = publication.tenant_id AND tenant.lifecycle_state = 'ACTIVE'
  JOIN public.workspaces workspace
    ON workspace.tenant_id = publication.tenant_id
   AND workspace.id = publication.workspace_id
   AND workspace.lifecycle_state = 'ACTIVE'
  WHERE publication.id = p_publication_id
    AND publication.status IN (
      'RUNNING', 'RECONCILING', 'ROLLBACK_QUEUED'
    )
    AND job.job_type = 'PUBLICATION'
    AND job.status = 'RUNNING'
    AND job.lease_token = p_lease_token
    AND job.lease_expires_at > database_now
    AND channel_auth.secret_arn IS NOT NULL
    AND split_part(channel_auth.secret_arn, ':', 5) = authority.aws_account_id
    AND channel_auth.secret_arn LIKE
      'arn:aws:secretsmanager:ap-southeast-1:' || authority.aws_account_id ||
      ':secret:tenant-' || publication.tenant_id::text || '/workspace-' ||
      publication.workspace_id::text || '/_%';
  IF NOT FOUND THEN RETURN NULL; END IF;

  derived_resource := jsonb_build_object(
    'kind', 'CONNECTOR_SECRET',
    'secretArn', source.secret_arn
  );
  RETURN public.tenant_data_issue_capability_private(
    p_capability_id, 'ACTIVE_PUBLICATION_JOB', source.publication_id::text,
    source.attempt, p_lease_token,
    'PUBLICATION_SECRET_READ:' || source.publication_id::text,
    'ACTIVE_PUBLICATION_JOB', source.publication_id::text, 'WORKSPACE',
    source.tenant_id, source.workspace_id, 'READ_CONNECTOR_SECRET',
    derived_resource, source.authority_expires_at
  );
END
$function$;

REVOKE ALL ON FUNCTION issue_publication_secret_read_capability(
  uuid, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION issue_privacy_object_put_capability(
  p_operation_id uuid,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  intent public.privacy_object_write_intents%ROWTYPE;
  derived_resource jsonb;
  derived_object_class text;
  derived_bucket text;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL
     OR p_capability_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO intent
  FROM public.privacy_object_write_intents source
  WHERE source.operation_id = p_operation_id
    AND source.status = 'PENDING'
    AND source.work_lease_token = p_lease_token
    AND source.work_lease_expires_at > database_now
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  derived_object_class := CASE intent.kind
    WHEN 'TENANT_EXPORT' THEN 'TENANT_EXPORTS'
    WHEN 'AUDIT_DIGEST' THEN 'AUDIT_EVIDENCE'
    ELSE NULL
  END;
  derived_bucket := CASE intent.kind
    WHEN 'TENANT_EXPORT' THEN authority.tenant_export_bucket
    WHEN 'AUDIT_DIGEST' THEN authority.audit_evidence_bucket
    ELSE NULL
  END;
  IF derived_object_class IS NULL OR derived_bucket IS NULL THEN RETURN NULL; END IF;
  derived_resource := jsonb_build_object(
    'kind', 'PRIVACY_OBJECT_PUT',
    'objectClass', derived_object_class,
    'bucket', derived_bucket,
    'key', intent.object_key,
    'checksumSha256', intent.checksum,
    'contentType', intent.content_type,
    'byteLength', intent.byte_length,
    'lockedUntil',
      public.tenant_data_canonical_utc_instant_private(intent.locked_until),
    'sealedAt',
      public.tenant_data_canonical_utc_instant_private(intent.sealed_at)
  );
  RETURN public.tenant_data_issue_capability_private(
    p_capability_id, 'PRIVACY_WRITE_INTENT', intent.operation_id::text,
    intent.work_attempt_count, p_lease_token,
    'PRIVACY_OBJECT_WRITE:' || intent.operation_id::text,
    'PRIVACY_WRITE_INTENT', intent.operation_id::text, 'TENANT',
    intent.tenant_id, NULL, 'PUT_PRIVACY_OBJECT', derived_resource,
    intent.work_lease_expires_at
  );
END
$function$;

REVOKE ALL ON FUNCTION issue_privacy_object_put_capability(
  uuid, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION issue_workload_object_recovery_head_capability(
  p_operation_id uuid,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  intent public.workload_object_write_intents%ROWTYPE;
  derived_resource jsonb;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL
     OR p_capability_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO intent
  FROM public.workload_object_write_intents source
  WHERE source.operation_id = p_operation_id
    AND source.status = 'PENDING'
    AND source.work_lease_token = p_lease_token
    AND source.work_lease_expires_at > database_now
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1
  FROM public.tenant_data_broker_effects effect
  WHERE effect.effect_identity =
      'WORKLOAD_OBJECT_WRITE:' || intent.operation_id::text
    AND effect.operation = 'PUT_WORKLOAD_OBJECT'
    AND effect.state = 'UNKNOWN';
  IF NOT FOUND THEN RETURN NULL; END IF;

  derived_resource := jsonb_build_object(
    'kind', 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD',
    'objectClass', 'WORKLOAD_OBJECTS',
    'bucket', authority.workload_bucket,
    'key', intent.object_key,
    'expectedChecksumSha256', intent.checksum,
    'expectedContentType', intent.content_type,
    'expectedByteLength', intent.byte_length,
    'lockedUntil', NULL,
    'sealedAt', NULL
  );
  RETURN public.tenant_data_issue_capability_private(
    p_capability_id, 'WORKLOAD_WRITE_INTENT', intent.operation_id::text,
    intent.work_attempt_count, p_lease_token,
    'WORKLOAD_OBJECT_RECOVERY_HEAD:' || intent.operation_id::text || ':' ||
      intent.work_attempt_count::text,
    'WORKLOAD_WRITE_INTENT', intent.operation_id::text, 'WORKSPACE',
    intent.tenant_id, intent.workspace_id, 'HEAD_WORKLOAD_OBJECT',
    derived_resource, intent.work_lease_expires_at
  );
END
$function$;

REVOKE ALL ON FUNCTION issue_workload_object_recovery_head_capability(
  uuid, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION issue_privacy_object_recovery_head_capability(
  p_operation_id uuid,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  intent public.privacy_object_write_intents%ROWTYPE;
  derived_resource jsonb;
  derived_object_class text;
  derived_bucket text;
BEGIN
  IF p_operation_id IS NULL OR p_lease_token IS NULL
     OR p_capability_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO intent
  FROM public.privacy_object_write_intents source
  WHERE source.operation_id = p_operation_id
    AND source.status = 'PENDING'
    AND source.work_lease_token = p_lease_token
    AND source.work_lease_expires_at > database_now
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1
  FROM public.tenant_data_broker_effects effect
  WHERE effect.effect_identity =
      'PRIVACY_OBJECT_WRITE:' || intent.operation_id::text
    AND effect.operation = 'PUT_PRIVACY_OBJECT'
    AND effect.state = 'UNKNOWN';
  IF NOT FOUND THEN RETURN NULL; END IF;

  derived_object_class := CASE intent.kind
    WHEN 'TENANT_EXPORT' THEN 'TENANT_EXPORTS'
    WHEN 'AUDIT_DIGEST' THEN 'AUDIT_EVIDENCE'
    ELSE NULL
  END;
  derived_bucket := CASE intent.kind
    WHEN 'TENANT_EXPORT' THEN authority.tenant_export_bucket
    WHEN 'AUDIT_DIGEST' THEN authority.audit_evidence_bucket
    ELSE NULL
  END;
  IF derived_object_class IS NULL OR derived_bucket IS NULL THEN RETURN NULL; END IF;
  derived_resource := jsonb_build_object(
    'kind', 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD',
    'objectClass', derived_object_class,
    'bucket', derived_bucket,
    'key', intent.object_key,
    'expectedChecksumSha256', intent.checksum,
    'expectedContentType', intent.content_type,
    'expectedByteLength', intent.byte_length,
    'lockedUntil',
      public.tenant_data_canonical_utc_instant_private(intent.locked_until),
    'sealedAt',
      public.tenant_data_canonical_utc_instant_private(intent.sealed_at)
  );
  RETURN public.tenant_data_issue_capability_private(
    p_capability_id, 'PRIVACY_WRITE_INTENT', intent.operation_id::text,
    intent.work_attempt_count, p_lease_token,
    'PRIVACY_OBJECT_RECOVERY_HEAD:' || intent.operation_id::text || ':' ||
      intent.work_attempt_count::text,
    'PRIVACY_WRITE_INTENT', intent.operation_id::text, 'TENANT',
    intent.tenant_id, NULL, 'HEAD_PRIVACY_OBJECT', derived_resource,
    intent.work_lease_expires_at
  );
END
$function$;

REVOKE ALL ON FUNCTION issue_privacy_object_recovery_head_capability(
  uuid, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION issue_connector_secret_deletion_capability_private(
  p_channel_authorization_id uuid,
  p_lease_token uuid,
  p_capability_id uuid,
  p_operation text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  source public.connector_secret_deletions%ROWTYPE;
  derived_resource jsonb;
BEGIN
  IF p_channel_authorization_id IS NULL OR p_lease_token IS NULL
     OR p_capability_id IS NULL OR p_operation NOT IN (
       'DESCRIBE_CONNECTOR_SECRET', 'DELETE_CONNECTOR_SECRET',
       'VERIFY_CONNECTOR_SECRET_UNREADABLE'
     ) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT deletion.* INTO source
  FROM public.connector_secret_deletions deletion
  WHERE deletion.channel_authorization_id = p_channel_authorization_id
    AND deletion.work_lease_token = p_lease_token
    AND deletion.work_lease_expires_at > database_now
    AND deletion.secret_reference IS NOT NULL
    AND deletion.secret_reference LIKE
      'arn:aws:secretsmanager:ap-southeast-1:' || authority.aws_account_id ||
      ':secret:tenant-' || deletion.tenant_id::text || '/workspace-' ||
      deletion.workspace_id::text || '/_%'
    AND (
      (p_operation = 'DESCRIBE_CONNECTOR_SECRET'
        AND deletion.state IN (
          'REVOKED_PENDING_FORCE_DELETE', 'FORCE_DELETE_REQUESTED', 'FAILED'
        ))
      OR (p_operation = 'DELETE_CONNECTOR_SECRET'
        AND deletion.state IN ('REVOKED_PENDING_FORCE_DELETE', 'FAILED')
        AND deletion.force_delete_at <= database_now)
      OR (p_operation = 'VERIFY_CONNECTOR_SECRET_UNREADABLE'
        AND deletion.state IN ('FORCE_DELETE_REQUESTED', 'FAILED'))
    );
  IF NOT FOUND
     OR split_part(source.secret_reference, ':', 5)
       IS DISTINCT FROM authority.aws_account_id THEN
    RETURN NULL;
  END IF;

  derived_resource := CASE p_operation
    WHEN 'VERIFY_CONNECTOR_SECRET_UNREADABLE' THEN jsonb_build_object(
      'kind', 'CONNECTOR_SECRET_UNREADABLE_VERIFICATION',
      'secretArn', source.secret_reference,
      'resultKind', 'BOOLEAN_ONLY'
    )
    ELSE jsonb_build_object(
      'kind', 'CONNECTOR_SECRET',
      'secretArn', source.secret_reference
    )
  END;
  RETURN public.tenant_data_issue_capability_private(
    p_capability_id, 'CONNECTOR_DELETION_INTENT',
    source.channel_authorization_id::text, source.work_attempt_count,
    p_lease_token,
    CASE p_operation
      WHEN 'DELETE_CONNECTOR_SECRET'
        THEN 'CONNECTOR_SECRET_DELETE:' || source.channel_authorization_id::text
      ELSE 'CONNECTOR_SECRET_PROBE:' || source.channel_authorization_id::text ||
        ':' || source.work_attempt_count::text || ':' || p_operation
    END,
    'CONNECTOR_DELETION_INTENT', source.channel_authorization_id::text,
    'WORKSPACE', source.tenant_id, source.workspace_id, p_operation,
    derived_resource, source.work_lease_expires_at
  );
END
$function$;

REVOKE ALL ON FUNCTION issue_connector_secret_deletion_capability_private(
  uuid, uuid, uuid, text
) FROM PUBLIC;

CREATE FUNCTION issue_connector_secret_describe_capability(
  p_channel_authorization_id uuid,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT public.issue_connector_secret_deletion_capability_private(
    p_channel_authorization_id, p_lease_token, p_capability_id,
    'DESCRIBE_CONNECTOR_SECRET'
  )
$function$;

REVOKE ALL ON FUNCTION issue_connector_secret_describe_capability(
  uuid, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION issue_connector_secret_delete_capability(
  p_channel_authorization_id uuid,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT public.issue_connector_secret_deletion_capability_private(
    p_channel_authorization_id, p_lease_token, p_capability_id,
    'DELETE_CONNECTOR_SECRET'
  )
$function$;

REVOKE ALL ON FUNCTION issue_connector_secret_delete_capability(
  uuid, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION issue_connector_secret_verify_unreadable_capability(
  p_channel_authorization_id uuid,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT public.issue_connector_secret_deletion_capability_private(
    p_channel_authorization_id, p_lease_token, p_capability_id,
    'VERIFY_CONNECTOR_SECRET_UNREADABLE'
  )
$function$;

REVOKE ALL ON FUNCTION issue_connector_secret_verify_unreadable_capability(
  uuid, uuid, uuid
) FROM PUBLIC;

-- Inventory cursors are opaque outside the Broker, but their wire form is a
-- canonical base64url-encoded JSON pair. Decode it only inside SECURITY
-- DEFINER functions and reject non-canonical, oversized, or widened objects.
CREATE FUNCTION tenant_data_decode_inventory_cursor_private(p_cursor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  padded text;
  decoded_bytes bytea;
  decoded_text text;
  decoded_cursor jsonb;
  reencoded text;
BEGIN
  IF p_cursor IS NULL THEN RETURN NULL; END IF;
  IF length(p_cursor) NOT BETWEEN 1 AND 4096
     OR p_cursor !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN NULL;
  END IF;
  padded := translate(p_cursor, '-_', '+/') ||
    repeat('=', (4 - length(p_cursor) % 4) % 4);
  decoded_bytes := decode(padded, 'base64');
  decoded_text := convert_from(decoded_bytes, 'UTF8');
  reencoded := rtrim(
    replace(translate(encode(decoded_bytes, 'base64'), '+/', '-_'), E'\n', ''),
    '='
  );
  IF reencoded IS DISTINCT FROM p_cursor THEN RETURN NULL; END IF;
  decoded_cursor := decoded_text::jsonb;
  IF jsonb_typeof(decoded_cursor) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(decoded_cursor)) <> 2
     OR jsonb_typeof(decoded_cursor->'keyMarker') <> 'string'
     OR jsonb_typeof(decoded_cursor->'versionIdMarker') <> 'string'
     OR length(decoded_cursor->>'keyMarker') NOT BETWEEN 1 AND 1024
     OR length(decoded_cursor->>'versionIdMarker') NOT BETWEEN 1 AND 1024
     OR left(decoded_cursor->>'keyMarker', 1) = '/'
     OR (decoded_cursor->>'keyMarker') ~ '[[:cntrl:]]'
     OR (decoded_cursor->>'versionIdMarker') ~ '[[:cntrl:]]' THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'keyMarker', decoded_cursor->>'keyMarker',
    'versionIdMarker', decoded_cursor->>'versionIdMarker'
  );
EXCEPTION
  WHEN invalid_text_representation
    OR character_not_in_repertoire
    OR invalid_parameter_value THEN
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION tenant_data_decode_inventory_cursor_private(text)
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;

-- Map only object classes whose physical S3 placement is authoritative in the
-- managed-object ledger. Other logical classes may be database or backup
-- records and must never acquire cloud coordinates by inference.
CREATE FUNCTION tenant_data_managed_object_storage_class_private(
  p_object public.managed_object_versions
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN p_object.object_class IN (
      'CRAWL_SNAPSHOT', 'ARTIFACT_PAYLOAD', 'CHANNEL_PACKAGE'
    )
      AND p_object.workspace_id IS NOT NULL
      AND p_object.object_key LIKE
        'tenants/' || p_object.tenant_id::text || '/workspaces/' ||
        p_object.workspace_id::text || '/%'
      THEN 'WORKLOAD_OBJECTS'
    WHEN p_object.object_class = 'ACTIVE_TENANT_DATA'
      AND p_object.object_ref LIKE 's3-inventory://%'
      AND p_object.workspace_id IS NOT NULL
      AND p_object.object_key LIKE
        'tenants/' || p_object.tenant_id::text || '/workspaces/' ||
        p_object.workspace_id::text || '/%'
      THEN 'WORKLOAD_OBJECTS'
    WHEN p_object.object_class = 'TENANT_EXPORT'
      AND p_object.object_key LIKE
        'tenants/' || p_object.tenant_id::text || '/exports/%'
      THEN 'TENANT_EXPORTS'
    WHEN p_object.object_class = 'AUDIT_DIGEST'
      AND p_object.object_key LIKE
        'tenants/' || p_object.tenant_id::text || '/audit-digests/%'
      THEN 'AUDIT_EVIDENCE'
    ELSE NULL
  END
$function$;

REVOKE ALL ON FUNCTION tenant_data_managed_object_storage_class_private(
  public.managed_object_versions
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;

-- Runtime proves possession of the raw server-session token. Only its digest
-- is retained. Tenant, Workspace, role, epochs, operation, bucket, and object
-- coordinates are all re-derived from live PostgreSQL rows.
CREATE FUNCTION issue_authenticated_object_read_capability(
  p_session_token text,
  p_membership_id uuid,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_object_key text,
  p_object_version_id text,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  object_version public.managed_object_versions%ROWTYPE;
  authenticated_source record;
  derived_session_token_digest text;
  derived_storage_class text;
  derived_bucket text;
  derived_operation text;
  derived_scope_kind text;
  derived_workspace_id uuid;
  derived_resource jsonb;
  source_expires_at timestamptz;
  inserted integer;
  issued_id uuid;
BEGIN
  IF p_session_token IS NULL
     OR p_session_token !~ '^[A-Za-z0-9_-]{43}$'
     OR p_membership_id IS NULL
     OR p_tenant_id IS NULL
     OR p_workspace_id IS NULL
     OR p_object_key IS NULL
     OR p_object_version_id IS NULL
     OR p_lease_token IS NULL
     OR p_capability_id IS NULL THEN
    RETURN NULL;
  END IF;
  derived_session_token_digest := translate(
    rtrim(
      encode(sha256(convert_to(p_session_token, 'UTF8')), 'base64'),
      '='
    ),
    '+/',
    '-_'
  );

  SELECT session_row.token_digest AS session_token_digest,
         session_row.expires_at AS session_expires_at,
         binding.id AS role_binding_id,
         binding.role AS role_at_issue,
         membership.tenant_data_access_revision AS membership_revision,
         binding.tenant_data_access_revision AS role_binding_revision,
         tenant_row.access_epoch AS tenant_access_epoch,
         workspace_row.access_epoch AS workspace_access_epoch
    INTO authenticated_source
  FROM public.auth_sessions session_row
  JOIN public.external_identities identity_row
    ON encode(
      sha256(convert_to(identity_row.subject, 'UTF8')), 'hex'
    ) = session_row.subject_digest
  JOIN public.memberships membership
    ON membership.tenant_id = p_tenant_id
   AND membership.id = p_membership_id
   AND membership.user_id = identity_row.user_id
   AND membership.status = 'ACTIVE'
  JOIN public.role_bindings binding
    ON binding.tenant_id = membership.tenant_id
   AND binding.membership_id = membership.id
   AND binding.workspace_id = p_workspace_id
  JOIN public.tenants tenant_row
    ON tenant_row.id = membership.tenant_id
   AND tenant_row.lifecycle_state = 'ACTIVE'
  JOIN public.workspaces workspace_row
    ON workspace_row.tenant_id = tenant_row.id
   AND workspace_row.id = binding.workspace_id
   AND workspace_row.lifecycle_state = 'ACTIVE'
  WHERE session_row.token_digest = derived_session_token_digest
    AND session_row.revoked_at IS NULL
    AND session_row.expires_at > database_now
  FOR SHARE OF session_row, identity_row, membership, binding,
    tenant_row, workspace_row;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT stored.* INTO object_version
  FROM public.managed_object_versions stored
  WHERE stored.tenant_id = p_tenant_id
    AND stored.workspace_id = p_workspace_id
    AND stored.object_key = p_object_key
    AND stored.object_version_id = p_object_version_id
    AND stored.lifecycle_state = 'ACTIVE'
    AND NOT stored.is_delete_marker
    AND length(stored.object_key) BETWEEN 1 AND 1024
    AND left(stored.object_key, 1) <> '/'
    AND stored.object_key !~ '[[:cntrl:]]'
    AND stored.object_version_id !~ '[[:cntrl:]]'
    AND length(stored.content_type) BETWEEN 3 AND 255
    AND stored.content_type ~
      '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(;[ -~]+)?$'
    AND stored.byte_length BETWEEN 1 AND 2147483648
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  derived_storage_class :=
    public.tenant_data_managed_object_storage_class_private(object_version);
  IF derived_storage_class IS NULL THEN RETURN NULL; END IF;
  IF derived_storage_class = 'WORKLOAD_OBJECTS' THEN
    derived_operation := 'READ_WORKLOAD_OBJECT';
    derived_scope_kind := 'WORKSPACE';
    derived_workspace_id := p_workspace_id;
  ELSE
    -- Tenant exports and sealed audit evidence are governance data. A generic
    -- Workspace reader cannot use this issuer for those classes.
    IF authenticated_source.role_at_issue <> 'OWNER' THEN RETURN NULL; END IF;
    derived_operation := 'READ_PRIVACY_OBJECT';
    derived_scope_kind := 'TENANT';
    derived_workspace_id := NULL;
  END IF;

  SELECT configured.* INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;
  derived_bucket := CASE derived_storage_class
    WHEN 'WORKLOAD_OBJECTS' THEN authority.workload_bucket
    WHEN 'TENANT_EXPORTS' THEN authority.tenant_export_bucket
    WHEN 'AUDIT_EVIDENCE' THEN authority.audit_evidence_bucket
    ELSE NULL
  END;
  IF derived_bucket IS NULL THEN RETURN NULL; END IF;

  derived_resource := jsonb_build_object(
    'kind', 'OBJECT_VERSION',
    'objectClass', derived_storage_class,
    'bucket', derived_bucket,
    'key', object_version.object_key,
    'versionId', object_version.object_version_id,
    'checksumSha256', object_version.checksum,
    'contentType', object_version.content_type,
    'byteLength', object_version.byte_length
  );
  source_expires_at := LEAST(
    authenticated_source.session_expires_at,
    database_now + interval '5 minutes'
  );
  INSERT INTO public.tenant_data_authenticated_object_read_sources (
    source_id, session_token_digest, tenant_id, workspace_id,
    membership_id, role_binding_id, role_at_issue,
    membership_revision, role_binding_revision,
    tenant_access_epoch, workspace_access_epoch, managed_object_id,
    issued_at, expires_at
  ) VALUES (
    p_capability_id, authenticated_source.session_token_digest,
    p_tenant_id, p_workspace_id, p_membership_id,
    authenticated_source.role_binding_id,
    authenticated_source.role_at_issue,
    authenticated_source.membership_revision,
    authenticated_source.role_binding_revision,
    authenticated_source.tenant_access_epoch,
    authenticated_source.workspace_access_epoch,
    object_version.id, database_now, source_expires_at
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> 1 THEN RETURN NULL; END IF;

  issued_id := public.tenant_data_issue_capability_private(
    p_capability_id,
    'AUTHENTICATED_OBJECT_READ',
    p_capability_id::text,
    1,
    p_lease_token,
    'AUTHENTICATED_OBJECT_READ:' || p_capability_id::text,
    'AUTHENTICATED_OBJECT_READ',
    p_capability_id::text,
    derived_scope_kind,
    p_tenant_id,
    derived_workspace_id,
    derived_operation,
    derived_resource,
    source_expires_at
  );
  IF issued_id IS DISTINCT FROM p_capability_id THEN
    DELETE FROM public.tenant_data_authenticated_object_read_sources source
    WHERE source.source_id = p_capability_id;
    RETURN NULL;
  END IF;
  RETURN issued_id;
END
$function$;

REVOKE ALL ON FUNCTION issue_authenticated_object_read_capability(
  text, uuid, uuid, uuid, text, text, uuid, uuid
) FROM PUBLIC, aeostudio_lifecycle_worker, aeostudio_tenant_data_broker;

CREATE FUNCTION tenant_data_live_legal_hold_status_private(
  p_tenant_id uuid,
  p_object_key text,
  p_object_version_id text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM public.legal_hold_object_versions target
    JOIN public.legal_holds hold_row
      ON hold_row.tenant_id = target.tenant_id
     AND hold_row.id = target.hold_id
    WHERE target.tenant_id = p_tenant_id
      AND target.object_key = p_object_key
      AND target.object_version_id = p_object_version_id
      AND hold_row.status = 'ACTIVE'
  ) THEN 'ON' ELSE 'OFF' END
$function$;

REVOKE ALL ON FUNCTION tenant_data_live_legal_hold_status_private(
  uuid, text, text
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;

-- Return one exact managed version only while it remains due under the current
-- deletion request lease. The caller-supplied key/version are selectors, never
-- authority: every scope, class, bucket, and lifecycle fact is re-derived.
CREATE FUNCTION tenant_data_load_due_deletion_object_private(
  p_request_id uuid,
  p_lease_token uuid,
  p_object_key text,
  p_object_version_id text,
  p_database_now timestamptz
)
RETURNS TABLE (
  tenant_id uuid,
  source_revision bigint,
  lease_expires_at timestamptz,
  storage_class text,
  bucket text,
  scope_kind text,
  workspace_id uuid,
  object_key text,
  object_version_id text,
  checksum text,
  content_type text,
  byte_length bigint,
  is_delete_marker boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  deletion_request public.deletion_requests%ROWTYPE;
  object_version public.managed_object_versions%ROWTYPE;
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  derived_storage_class text;
  object_is_due boolean := false;
BEGIN
  IF p_request_id IS NULL OR p_lease_token IS NULL
     OR p_object_key IS NULL OR p_object_version_id IS NULL
     OR p_database_now IS NULL THEN
    RETURN;
  END IF;
  SELECT request.* INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id
    AND request.finalization_lease_token = p_lease_token
    AND request.finalization_lease_expires_at > p_database_now
  FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT stored.* INTO object_version
  FROM public.managed_object_versions stored
  WHERE stored.tenant_id = deletion_request.tenant_id
    AND stored.object_key = p_object_key
    AND stored.object_version_id = p_object_version_id
  FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;

  IF deletion_request.state = 'FROZEN'
     AND deletion_request.active_delete_by <= p_database_now
     AND object_version.lifecycle_state = 'ACTIVE'
     AND object_version.object_class <> 'AUDIT_DIGEST'
     AND (
       deletion_request.scope_kind = 'TENANT'
       OR object_version.workspace_id = deletion_request.workspace_id
       OR object_version.object_class = 'TENANT_EXPORT'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.legal_hold_object_versions target
       JOIN public.legal_holds hold_row
         ON hold_row.tenant_id = target.tenant_id
        AND hold_row.id = target.hold_id
       WHERE target.tenant_id = object_version.tenant_id
         AND target.object_key = object_version.object_key
         AND target.object_version_id = object_version.object_version_id
         AND hold_row.status = 'ACTIVE'
     ) THEN
    object_is_due := true;
  ELSIF deletion_request.state IN (
      'ACTIVE_DATA_DELETED', 'BLOCKED_BY_LEGAL_HOLD'
    )
    AND deletion_request.active_deleted_at IS NOT NULL
    AND object_version.deletion_request_id = deletion_request.id
    AND object_version.lifecycle_state = 'DELETE_DUE' THEN
    object_is_due := true;
  END IF;
  IF NOT object_is_due THEN RETURN; END IF;

  derived_storage_class :=
    public.tenant_data_managed_object_storage_class_private(object_version);
  IF derived_storage_class IS NULL THEN RETURN; END IF;
  SELECT configured.* INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY SELECT
    deletion_request.tenant_id,
    deletion_request.finalization_attempt_count::bigint,
    deletion_request.finalization_lease_expires_at,
    derived_storage_class,
    CASE derived_storage_class
      WHEN 'WORKLOAD_OBJECTS' THEN authority.workload_bucket
      WHEN 'TENANT_EXPORTS' THEN authority.tenant_export_bucket
      WHEN 'AUDIT_EVIDENCE' THEN authority.audit_evidence_bucket
    END,
    CASE
      WHEN derived_storage_class = 'WORKLOAD_OBJECTS'
        THEN deletion_request.scope_kind
      ELSE 'TENANT'
    END,
    CASE
      WHEN derived_storage_class = 'WORKLOAD_OBJECTS'
        AND deletion_request.scope_kind = 'WORKSPACE'
        THEN deletion_request.workspace_id
      ELSE NULL
    END,
    object_version.object_key,
    object_version.object_version_id,
    object_version.checksum,
    object_version.content_type,
    object_version.byte_length,
    object_version.is_delete_marker;
END
$function$;

REVOKE ALL ON FUNCTION tenant_data_load_due_deletion_object_private(
  uuid, uuid, text, text, timestamptz
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;

CREATE FUNCTION issue_deletion_inventory_capability(
  p_request_id uuid,
  p_lease_token uuid,
  p_capability_id uuid,
  p_limit integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  deletion_request public.deletion_requests%ROWTYPE;
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  target record;
  decoded_cursor jsonb;
  derived_resource jsonb;
  derived_bucket text;
  derived_prefix text;
  derived_scope_kind text;
  derived_workspace_id uuid;
  identity_hash text;
BEGIN
  IF p_request_id IS NULL OR p_lease_token IS NULL
     OR p_capability_id IS NULL OR p_limit IS NULL
     OR p_limit <> 1000 THEN
    RETURN NULL;
  END IF;
  SELECT request.* INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id
    AND request.state IN ('FROZEN', 'FINALIZING')
    AND request.finalization_lease_token = p_lease_token
    AND request.finalization_lease_expires_at > database_now
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT configured.* INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT current_target.* INTO target
  FROM public.get_deletion_object_inventory_page_target(
    p_request_id, p_lease_token
  ) current_target;
  IF NOT FOUND OR target.status IS DISTINCT FROM 'REQUIRED' THEN RETURN NULL; END IF;
  decoded_cursor :=
    public.tenant_data_decode_inventory_cursor_private(target.inventory_cursor);
  IF target.inventory_cursor IS NOT NULL AND decoded_cursor IS NULL THEN
    RETURN NULL;
  END IF;

  derived_bucket := CASE target.bucket_kind
    WHEN 'TENANT_EXPORTS' THEN authority.tenant_export_bucket
    WHEN 'AUDIT_EVIDENCE' THEN authority.audit_evidence_bucket
    WHEN 'WORKLOAD_OBJECTS' THEN authority.workload_bucket
    ELSE NULL
  END;
  derived_prefix := CASE target.bucket_kind
    WHEN 'TENANT_EXPORTS'
      THEN 'tenants/' || target.tenant_id::text || '/exports/'
    WHEN 'AUDIT_EVIDENCE'
      THEN 'tenants/' || target.tenant_id::text || '/audit-digests/'
    WHEN 'WORKLOAD_OBJECTS'
      THEN 'tenants/' || target.tenant_id::text || '/workspaces/' ||
        CASE WHEN target.scope_kind = 'WORKSPACE'
          THEN target.workspace_id::text || '/' ELSE '' END
    ELSE NULL
  END;
  derived_scope_kind := CASE
    WHEN target.bucket_kind = 'WORKLOAD_OBJECTS' THEN target.scope_kind
    ELSE 'TENANT'
  END;
  derived_workspace_id := CASE
    WHEN target.bucket_kind = 'WORKLOAD_OBJECTS'
      AND target.scope_kind = 'WORKSPACE' THEN target.workspace_id
    ELSE NULL
  END;
  IF derived_bucket IS NULL OR derived_prefix IS NULL THEN RETURN NULL; END IF;

  derived_resource := jsonb_build_object(
    'kind', 'OBJECT_VERSION_INVENTORY',
    'objectClass', target.bucket_kind,
    'bucket', derived_bucket,
    'prefix', derived_prefix,
    'cursor', decoded_cursor,
    'limit', p_limit
  );
  identity_hash := encode(sha256(convert_to(
    target.bucket_kind || ':' || COALESCE(target.inventory_cursor, '<null>') ||
    ':' || p_limit::text, 'UTF8'
  )), 'hex');
  RETURN public.tenant_data_issue_capability_private(
    p_capability_id, 'DELETION_INVENTORY_INTENT',
    deletion_request.id::text,
    deletion_request.finalization_attempt_count, p_lease_token,
    'DELETION_INVENTORY:' || deletion_request.id::text || ':' || identity_hash,
    'DELETION_INVENTORY_INTENT', deletion_request.id::text,
    derived_scope_kind, deletion_request.tenant_id, derived_workspace_id,
    'LIST_TENANT_OBJECT_VERSIONS', derived_resource,
    deletion_request.finalization_lease_expires_at
  );
END
$function$;

REVOKE ALL ON FUNCTION issue_deletion_inventory_capability(
  uuid, uuid, uuid, integer
) FROM PUBLIC;

CREATE FUNCTION issue_deletion_object_capability_private(
  p_request_id uuid,
  p_lease_token uuid,
  p_capability_id uuid,
  p_object_key text,
  p_object_version_id text,
  p_requested_operation text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  source record;
  derived_operation text;
  derived_resource jsonb;
  object_identity_hash text;
  effect_identity text;
BEGIN
  IF p_request_id IS NULL OR p_lease_token IS NULL
     OR p_capability_id IS NULL OR p_object_key IS NULL
     OR p_object_version_id IS NULL OR p_requested_operation NOT IN (
       'HEAD', 'GET_LEGAL_HOLD', 'DELETE'
     ) THEN
    RETURN NULL;
  END IF;
  SELECT due.* INTO source
  FROM public.tenant_data_load_due_deletion_object_private(
    p_request_id, p_lease_token, p_object_key, p_object_version_id,
    database_now
  ) due;
  IF NOT FOUND THEN RETURN NULL; END IF;

  object_identity_hash := encode(sha256(convert_to(
    public.aeostudio_backup_evidence_canonical_json(jsonb_build_object(
      'requestId', p_request_id,
      'key', source.object_key,
      'versionId', source.object_version_id
    )), 'UTF8'
  )), 'hex');
  IF p_requested_operation = 'HEAD' THEN
    IF source.is_delete_marker OR source.checksum IS NULL
       OR source.byte_length NOT BETWEEN 1 AND 2147483648
       OR source.content_type IS NULL
       OR length(source.content_type) NOT BETWEEN 3 AND 255
       OR source.content_type !~
         '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(;[ -~]+)?$' THEN
      RETURN NULL;
    END IF;
    derived_operation := CASE source.storage_class
      WHEN 'WORKLOAD_OBJECTS' THEN 'HEAD_WORKLOAD_OBJECT'
      ELSE 'HEAD_PRIVACY_OBJECT'
    END;
    derived_resource := jsonb_build_object(
      'kind', 'OBJECT_VERSION',
      'objectClass', source.storage_class,
      'bucket', source.bucket,
      'key', source.object_key,
      'versionId', source.object_version_id,
      'checksumSha256', source.checksum,
      'contentType', source.content_type,
      'byteLength', source.byte_length
    );
    effect_identity := 'DELETION_OBJECT_HEAD:' || object_identity_hash || ':' ||
      source.source_revision::text;
  ELSIF p_requested_operation = 'GET_LEGAL_HOLD' THEN
    derived_operation := 'GET_OBJECT_LEGAL_HOLD';
    derived_resource := jsonb_build_object(
      'kind', 'OBJECT_LEGAL_HOLD_READ',
      'objectClass', source.storage_class,
      'bucket', source.bucket,
      'key', source.object_key,
      'versionId', source.object_version_id
    );
    effect_identity := 'DELETION_OBJECT_LEGAL_HOLD:' ||
      object_identity_hash || ':' || source.source_revision::text;
  ELSE
    derived_operation := CASE source.storage_class
      WHEN 'WORKLOAD_OBJECTS' THEN 'DELETE_WORKLOAD_OBJECT_VERSION'
      ELSE 'DELETE_PRIVACY_OBJECT_VERSION'
    END;
    derived_resource := jsonb_build_object(
      'kind', 'OBJECT_VERSION_DELETE',
      'objectClass', source.storage_class,
      'bucket', source.bucket,
      'key', source.object_key,
      'versionId', source.object_version_id,
      'isDeleteMarker', source.is_delete_marker
    );
    -- The same exact-version delete remains one cloud effect across lease
    -- retries and capability rotation.
    effect_identity := 'DELETION_OBJECT_DELETE:' || object_identity_hash;
  END IF;

  RETURN public.tenant_data_issue_capability_private(
    p_capability_id, 'DELETION_OBJECT_INTENT', p_request_id::text,
    source.source_revision, p_lease_token, effect_identity,
    'DELETION_OBJECT_INTENT', p_request_id::text, source.scope_kind,
    source.tenant_id, source.workspace_id, derived_operation,
    derived_resource, source.lease_expires_at
  );
END
$function$;

REVOKE ALL ON FUNCTION issue_deletion_object_capability_private(
  uuid, uuid, uuid, text, text, text
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;

CREATE FUNCTION issue_deletion_object_head_capability(
  p_request_id uuid, p_lease_token uuid, p_capability_id uuid,
  p_object_key text, p_object_version_id text
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT public.issue_deletion_object_capability_private(
    p_request_id, p_lease_token, p_capability_id, p_object_key,
    p_object_version_id, 'HEAD'
  )
$function$;

CREATE FUNCTION issue_deletion_object_get_legal_hold_capability(
  p_request_id uuid, p_lease_token uuid, p_capability_id uuid,
  p_object_key text, p_object_version_id text
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT public.issue_deletion_object_capability_private(
    p_request_id, p_lease_token, p_capability_id, p_object_key,
    p_object_version_id, 'GET_LEGAL_HOLD'
  )
$function$;

CREATE FUNCTION issue_deletion_object_delete_capability(
  p_request_id uuid, p_lease_token uuid, p_capability_id uuid,
  p_object_key text, p_object_version_id text
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT public.issue_deletion_object_capability_private(
    p_request_id, p_lease_token, p_capability_id, p_object_key,
    p_object_version_id, 'DELETE'
  )
$function$;

REVOKE ALL ON FUNCTION issue_deletion_object_head_capability(
  uuid, uuid, uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION issue_deletion_object_get_legal_hold_capability(
  uuid, uuid, uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION issue_deletion_object_delete_capability(
  uuid, uuid, uuid, text, text
) FROM PUBLIC;

CREATE FUNCTION issue_legal_hold_set_capability(
  p_tenant_id uuid,
  p_object_key text,
  p_object_version_id text,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  state public.legal_hold_object_reconciliations%ROWTYPE;
  object_version public.managed_object_versions%ROWTYPE;
  derived_storage_class text;
  derived_bucket text;
  derived_scope_kind text;
  derived_workspace_id uuid;
  derived_resource jsonb;
  source_identity text;
BEGIN
  IF p_tenant_id IS NULL OR p_object_key IS NULL
     OR p_object_version_id IS NULL OR p_lease_token IS NULL
     OR p_capability_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT reconciliation.* INTO state
  FROM public.legal_hold_object_reconciliations reconciliation
  WHERE reconciliation.tenant_id = p_tenant_id
    AND reconciliation.object_key = p_object_key
    AND reconciliation.object_version_id = p_object_version_id
    AND reconciliation.work_lease_token = p_lease_token
    AND reconciliation.work_lease_expires_at > database_now
    AND reconciliation.desired_status =
      public.tenant_data_live_legal_hold_status_private(
        reconciliation.tenant_id,
        reconciliation.object_key,
        reconciliation.object_version_id
      )
    AND (
      reconciliation.applied_revision < reconciliation.desired_revision
      OR reconciliation.applied_status <> reconciliation.desired_status
    )
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT stored.* INTO object_version
  FROM public.managed_object_versions stored
  WHERE stored.tenant_id = state.tenant_id
    AND stored.object_key = state.object_key
    AND stored.object_version_id = state.object_version_id
    AND stored.object_class = state.object_class
    AND stored.lifecycle_state <> 'DELETED'
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  derived_storage_class :=
    public.tenant_data_managed_object_storage_class_private(object_version);
  IF derived_storage_class IS NULL THEN RETURN NULL; END IF;
  SELECT configured.* INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;

  derived_bucket := CASE derived_storage_class
    WHEN 'WORKLOAD_OBJECTS' THEN authority.workload_bucket
    WHEN 'TENANT_EXPORTS' THEN authority.tenant_export_bucket
    WHEN 'AUDIT_EVIDENCE' THEN authority.audit_evidence_bucket
  END;
  derived_scope_kind := CASE derived_storage_class
    WHEN 'WORKLOAD_OBJECTS' THEN 'WORKSPACE'
    ELSE 'TENANT'
  END;
  derived_workspace_id := CASE derived_storage_class
    WHEN 'WORKLOAD_OBJECTS' THEN object_version.workspace_id
    ELSE NULL
  END;
  IF derived_bucket IS NULL OR (
    derived_scope_kind = 'WORKSPACE' AND derived_workspace_id IS NULL
  ) THEN
    RETURN NULL;
  END IF;
  derived_resource := jsonb_build_object(
    'kind', 'OBJECT_LEGAL_HOLD_WRITE',
    'objectClass', derived_storage_class,
    'bucket', derived_bucket,
    'key', object_version.object_key,
    'versionId', object_version.object_version_id,
    'desiredStatus', state.desired_status,
    'revision', state.desired_revision
  );
  source_identity := encode(sha256(convert_to(
    public.aeostudio_backup_evidence_canonical_json(jsonb_build_object(
      'tenantId', state.tenant_id,
      'key', state.object_key,
      'versionId', state.object_version_id
    )), 'UTF8'
  )), 'hex');
  RETURN public.tenant_data_issue_capability_private(
    p_capability_id, 'LEGAL_HOLD_RECONCILIATION_INTENT', source_identity,
    state.work_attempt_count, p_lease_token,
    'LEGAL_HOLD_SET:' || source_identity || ':' || state.desired_revision::text,
    'LEGAL_HOLD_RECONCILIATION_INTENT', source_identity,
    derived_scope_kind, state.tenant_id, derived_workspace_id,
    'SET_OBJECT_LEGAL_HOLD', derived_resource, state.work_lease_expires_at
  );
END
$function$;

REVOKE ALL ON FUNCTION issue_legal_hold_set_capability(
  uuid, text, text, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION issue_legal_hold_get_recovery_capability(
  p_tenant_id uuid,
  p_object_key text,
  p_object_version_id text,
  p_lease_token uuid,
  p_capability_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  state public.legal_hold_object_reconciliations%ROWTYPE;
  object_version public.managed_object_versions%ROWTYPE;
  derived_storage_class text;
  derived_bucket text;
  derived_scope_kind text;
  derived_workspace_id uuid;
  derived_resource jsonb;
  source_identity text;
  set_effect_identity text;
BEGIN
  IF p_tenant_id IS NULL OR p_object_key IS NULL
     OR p_object_version_id IS NULL OR p_lease_token IS NULL
     OR p_capability_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT reconciliation.* INTO state
  FROM public.legal_hold_object_reconciliations reconciliation
  WHERE reconciliation.tenant_id = p_tenant_id
    AND reconciliation.object_key = p_object_key
    AND reconciliation.object_version_id = p_object_version_id
    AND reconciliation.work_lease_token = p_lease_token
    AND reconciliation.work_lease_expires_at > database_now
    AND reconciliation.desired_status =
      public.tenant_data_live_legal_hold_status_private(
        reconciliation.tenant_id,
        reconciliation.object_key,
        reconciliation.object_version_id
      )
    AND (
      reconciliation.applied_revision < reconciliation.desired_revision
      OR reconciliation.applied_status <> reconciliation.desired_status
    )
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT stored.* INTO object_version
  FROM public.managed_object_versions stored
  WHERE stored.tenant_id = state.tenant_id
    AND stored.object_key = state.object_key
    AND stored.object_version_id = state.object_version_id
    AND stored.object_class = state.object_class
    AND stored.lifecycle_state <> 'DELETED'
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  derived_storage_class :=
    public.tenant_data_managed_object_storage_class_private(object_version);
  IF derived_storage_class IS NULL THEN RETURN NULL; END IF;
  SELECT configured.* INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;

  derived_bucket := CASE derived_storage_class
    WHEN 'WORKLOAD_OBJECTS' THEN authority.workload_bucket
    WHEN 'TENANT_EXPORTS' THEN authority.tenant_export_bucket
    WHEN 'AUDIT_EVIDENCE' THEN authority.audit_evidence_bucket
  END;
  derived_scope_kind := CASE derived_storage_class
    WHEN 'WORKLOAD_OBJECTS' THEN 'WORKSPACE'
    ELSE 'TENANT'
  END;
  derived_workspace_id := CASE derived_storage_class
    WHEN 'WORKLOAD_OBJECTS' THEN object_version.workspace_id
    ELSE NULL
  END;
  IF derived_bucket IS NULL OR (
    derived_scope_kind = 'WORKSPACE' AND derived_workspace_id IS NULL
  ) THEN
    RETURN NULL;
  END IF;
  source_identity := encode(sha256(convert_to(
    public.aeostudio_backup_evidence_canonical_json(jsonb_build_object(
      'tenantId', state.tenant_id,
      'key', state.object_key,
      'versionId', state.object_version_id
    )), 'UTF8'
  )), 'hex');
  set_effect_identity :=
    'LEGAL_HOLD_SET:' || source_identity || ':' || state.desired_revision::text;
  PERFORM 1
  FROM public.tenant_data_broker_effects effect
  WHERE effect.effect_identity = set_effect_identity
    AND effect.operation = 'SET_OBJECT_LEGAL_HOLD'
    AND effect.state = 'UNKNOWN';
  IF NOT FOUND THEN RETURN NULL; END IF;

  derived_resource := jsonb_build_object(
    'kind', 'OBJECT_LEGAL_HOLD_READ',
    'objectClass', derived_storage_class,
    'bucket', derived_bucket,
    'key', object_version.object_key,
    'versionId', object_version.object_version_id
  );
  RETURN public.tenant_data_issue_capability_private(
    p_capability_id, 'LEGAL_HOLD_RECONCILIATION_INTENT', source_identity,
    state.work_attempt_count, p_lease_token,
    'LEGAL_HOLD_GET_RECOVERY:' || source_identity || ':' ||
      state.desired_revision::text || ':' || state.work_attempt_count::text,
    'LEGAL_HOLD_RECONCILIATION_INTENT', source_identity,
    derived_scope_kind, state.tenant_id, derived_workspace_id,
    'GET_OBJECT_LEGAL_HOLD', derived_resource, state.work_lease_expires_at
  );
END
$function$;

REVOKE ALL ON FUNCTION issue_legal_hold_get_recovery_capability(
  uuid, text, text, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION tenant_data_validate_deletion_inventory_capability_private(
  p_capability public.tenant_data_capabilities,
  p_lease_token uuid,
  p_database_now timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  deletion_request public.deletion_requests%ROWTYPE;
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  target record;
  decoded_cursor jsonb;
  expected_resource jsonb;
  expected_bucket text;
  expected_prefix text;
  expected_scope_kind text;
  expected_workspace_id uuid;
  requested_limit integer;
BEGIN
  IF p_capability.source_reference !~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  SELECT request.* INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_capability.source_reference::uuid
    AND request.tenant_id = p_capability.tenant_id
    AND request.state IN ('FROZEN', 'FINALIZING')
    AND request.finalization_attempt_count = p_capability.source_revision
    AND request.finalization_lease_token = p_lease_token
    AND request.finalization_lease_expires_at > p_database_now
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT configured.* INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT current_target.* INTO target
  FROM public.get_deletion_object_inventory_page_target(
    deletion_request.id, p_lease_token
  ) current_target;
  IF NOT FOUND OR target.status IS DISTINCT FROM 'REQUIRED' THEN RETURN NULL; END IF;
  decoded_cursor :=
    public.tenant_data_decode_inventory_cursor_private(target.inventory_cursor);
  IF target.inventory_cursor IS NOT NULL AND decoded_cursor IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_capability.resource->'limit') <> 'number'
     OR (p_capability.resource->>'limit') !~ '^[0-9]+$'
     OR length(p_capability.resource->>'limit') > 4 THEN
    RETURN NULL;
  END IF;
  requested_limit := (p_capability.resource->>'limit')::integer;
  IF requested_limit <> 1000 THEN RETURN NULL; END IF;

  expected_bucket := CASE target.bucket_kind
    WHEN 'TENANT_EXPORTS' THEN authority.tenant_export_bucket
    WHEN 'AUDIT_EVIDENCE' THEN authority.audit_evidence_bucket
    WHEN 'WORKLOAD_OBJECTS' THEN authority.workload_bucket
    ELSE NULL
  END;
  expected_prefix := CASE target.bucket_kind
    WHEN 'TENANT_EXPORTS'
      THEN 'tenants/' || target.tenant_id::text || '/exports/'
    WHEN 'AUDIT_EVIDENCE'
      THEN 'tenants/' || target.tenant_id::text || '/audit-digests/'
    WHEN 'WORKLOAD_OBJECTS'
      THEN 'tenants/' || target.tenant_id::text || '/workspaces/' ||
        CASE WHEN target.scope_kind = 'WORKSPACE'
          THEN target.workspace_id::text || '/' ELSE '' END
    ELSE NULL
  END;
  expected_scope_kind := CASE
    WHEN target.bucket_kind = 'WORKLOAD_OBJECTS' THEN target.scope_kind
    ELSE 'TENANT'
  END;
  expected_workspace_id := CASE
    WHEN target.bucket_kind = 'WORKLOAD_OBJECTS'
      AND target.scope_kind = 'WORKSPACE' THEN target.workspace_id
    ELSE NULL
  END;
  expected_resource := jsonb_build_object(
    'kind', 'OBJECT_VERSION_INVENTORY',
    'objectClass', target.bucket_kind,
    'bucket', expected_bucket,
    'prefix', expected_prefix,
    'cursor', decoded_cursor,
    'limit', requested_limit
  );
  IF expected_bucket IS NULL OR expected_prefix IS NULL
     OR target.request_id IS DISTINCT FROM deletion_request.id
     OR target.tenant_id IS DISTINCT FROM deletion_request.tenant_id
     OR target.scope_kind IS DISTINCT FROM deletion_request.scope_kind
     OR target.workspace_id IS DISTINCT FROM deletion_request.workspace_id
     OR p_capability.authority_kind IS DISTINCT FROM
       'DELETION_INVENTORY_INTENT'
     OR p_capability.authority_reference IS DISTINCT FROM
       deletion_request.id::text
     OR p_capability.operation IS DISTINCT FROM
       'LIST_TENANT_OBJECT_VERSIONS'
     OR p_capability.scope_kind IS DISTINCT FROM expected_scope_kind
     OR p_capability.workspace_id IS DISTINCT FROM expected_workspace_id
     OR p_capability.resource IS DISTINCT FROM expected_resource THEN
    RETURN NULL;
  END IF;
  RETURN deletion_request.finalization_lease_expires_at;
END
$function$;

REVOKE ALL ON FUNCTION tenant_data_validate_deletion_inventory_capability_private(
  public.tenant_data_capabilities, uuid, timestamptz
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;

CREATE FUNCTION tenant_data_validate_deletion_object_capability_private(
  p_capability public.tenant_data_capabilities,
  p_lease_token uuid,
  p_database_now timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  source record;
  expected_resource jsonb;
  expected_operation text;
BEGIN
  IF p_capability.source_reference !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_capability.resource->>'key' IS NULL
     OR p_capability.resource->>'versionId' IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT due.* INTO source
  FROM public.tenant_data_load_due_deletion_object_private(
    p_capability.source_reference::uuid, p_lease_token,
    p_capability.resource->>'key', p_capability.resource->>'versionId',
    p_database_now
  ) due;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_capability.operation IN (
    'HEAD_WORKLOAD_OBJECT', 'HEAD_PRIVACY_OBJECT'
  ) THEN
    IF source.is_delete_marker OR source.checksum IS NULL
       OR source.byte_length NOT BETWEEN 1 AND 2147483648
       OR source.content_type IS NULL
       OR length(source.content_type) NOT BETWEEN 3 AND 255
       OR source.content_type !~
         '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(;[ -~]+)?$' THEN
      RETURN NULL;
    END IF;
    expected_operation := CASE source.storage_class
      WHEN 'WORKLOAD_OBJECTS' THEN 'HEAD_WORKLOAD_OBJECT'
      ELSE 'HEAD_PRIVACY_OBJECT'
    END;
    expected_resource := jsonb_build_object(
      'kind', 'OBJECT_VERSION',
      'objectClass', source.storage_class,
      'bucket', source.bucket,
      'key', source.object_key,
      'versionId', source.object_version_id,
      'checksumSha256', source.checksum,
      'contentType', source.content_type,
      'byteLength', source.byte_length
    );
  ELSIF p_capability.operation = 'GET_OBJECT_LEGAL_HOLD' THEN
    expected_operation := 'GET_OBJECT_LEGAL_HOLD';
    expected_resource := jsonb_build_object(
      'kind', 'OBJECT_LEGAL_HOLD_READ',
      'objectClass', source.storage_class,
      'bucket', source.bucket,
      'key', source.object_key,
      'versionId', source.object_version_id
    );
  ELSIF p_capability.operation IN (
    'DELETE_WORKLOAD_OBJECT_VERSION', 'DELETE_PRIVACY_OBJECT_VERSION'
  ) THEN
    expected_operation := CASE source.storage_class
      WHEN 'WORKLOAD_OBJECTS' THEN 'DELETE_WORKLOAD_OBJECT_VERSION'
      ELSE 'DELETE_PRIVACY_OBJECT_VERSION'
    END;
    expected_resource := jsonb_build_object(
      'kind', 'OBJECT_VERSION_DELETE',
      'objectClass', source.storage_class,
      'bucket', source.bucket,
      'key', source.object_key,
      'versionId', source.object_version_id,
      'isDeleteMarker', source.is_delete_marker
    );
  ELSE
    RETURN NULL;
  END IF;
  IF p_capability.source_revision IS DISTINCT FROM source.source_revision
     OR p_capability.authority_kind IS DISTINCT FROM 'DELETION_OBJECT_INTENT'
     OR p_capability.authority_reference IS DISTINCT FROM
       p_capability.source_reference
     OR p_capability.tenant_id IS DISTINCT FROM source.tenant_id
     OR p_capability.scope_kind IS DISTINCT FROM source.scope_kind
     OR p_capability.workspace_id IS DISTINCT FROM source.workspace_id
     OR p_capability.operation IS DISTINCT FROM expected_operation
     OR p_capability.resource IS DISTINCT FROM expected_resource THEN
    RETURN NULL;
  END IF;
  RETURN source.lease_expires_at;
END
$function$;

REVOKE ALL ON FUNCTION tenant_data_validate_deletion_object_capability_private(
  public.tenant_data_capabilities, uuid, timestamptz
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;

CREATE FUNCTION tenant_data_validate_legal_hold_capability_private(
  p_capability public.tenant_data_capabilities,
  p_lease_token uuid,
  p_database_now timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  state public.legal_hold_object_reconciliations%ROWTYPE;
  object_version public.managed_object_versions%ROWTYPE;
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  expected_storage_class text;
  expected_bucket text;
  expected_scope_kind text;
  expected_workspace_id uuid;
  expected_resource jsonb;
  expected_source_identity text;
  expected_effect_identity text;
BEGIN
  SELECT reconciliation.* INTO state
  FROM public.legal_hold_object_reconciliations reconciliation
  WHERE reconciliation.tenant_id = p_capability.tenant_id
    AND reconciliation.object_key = p_capability.resource->>'key'
    AND reconciliation.object_version_id =
      p_capability.resource->>'versionId'
    AND reconciliation.work_attempt_count = p_capability.source_revision
    AND reconciliation.work_lease_token = p_lease_token
    AND reconciliation.work_lease_expires_at > p_database_now
    AND reconciliation.desired_status =
      public.tenant_data_live_legal_hold_status_private(
        reconciliation.tenant_id,
        reconciliation.object_key,
        reconciliation.object_version_id
      )
    AND (
      reconciliation.applied_revision < reconciliation.desired_revision
      OR reconciliation.applied_status <> reconciliation.desired_status
    )
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT stored.* INTO object_version
  FROM public.managed_object_versions stored
  WHERE stored.tenant_id = state.tenant_id
    AND stored.object_key = state.object_key
    AND stored.object_version_id = state.object_version_id
    AND stored.object_class = state.object_class
    AND stored.lifecycle_state <> 'DELETED'
  FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  expected_storage_class :=
    public.tenant_data_managed_object_storage_class_private(object_version);
  IF expected_storage_class IS NULL THEN RETURN NULL; END IF;
  SELECT configured.* INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN NULL; END IF;
  expected_bucket := CASE expected_storage_class
    WHEN 'WORKLOAD_OBJECTS' THEN authority.workload_bucket
    WHEN 'TENANT_EXPORTS' THEN authority.tenant_export_bucket
    WHEN 'AUDIT_EVIDENCE' THEN authority.audit_evidence_bucket
  END;
  expected_scope_kind := CASE expected_storage_class
    WHEN 'WORKLOAD_OBJECTS' THEN 'WORKSPACE'
    ELSE 'TENANT'
  END;
  expected_workspace_id := CASE expected_storage_class
    WHEN 'WORKLOAD_OBJECTS' THEN object_version.workspace_id
    ELSE NULL
  END;
  expected_source_identity := encode(sha256(convert_to(
    public.aeostudio_backup_evidence_canonical_json(jsonb_build_object(
      'tenantId', state.tenant_id,
      'key', state.object_key,
      'versionId', state.object_version_id
    )), 'UTF8'
  )), 'hex');
  IF p_capability.operation = 'SET_OBJECT_LEGAL_HOLD' THEN
    expected_resource := jsonb_build_object(
      'kind', 'OBJECT_LEGAL_HOLD_WRITE',
      'objectClass', expected_storage_class,
      'bucket', expected_bucket,
      'key', state.object_key,
      'versionId', state.object_version_id,
      'desiredStatus', state.desired_status,
      'revision', state.desired_revision
    );
    expected_effect_identity :=
      'LEGAL_HOLD_SET:' || expected_source_identity || ':' ||
      state.desired_revision::text;
  ELSIF p_capability.operation = 'GET_OBJECT_LEGAL_HOLD' THEN
    expected_resource := jsonb_build_object(
      'kind', 'OBJECT_LEGAL_HOLD_READ',
      'objectClass', expected_storage_class,
      'bucket', expected_bucket,
      'key', state.object_key,
      'versionId', state.object_version_id
    );
    expected_effect_identity :=
      'LEGAL_HOLD_GET_RECOVERY:' || expected_source_identity || ':' ||
      state.desired_revision::text || ':' || state.work_attempt_count::text;
    PERFORM 1
    FROM public.tenant_data_broker_effects effect
    WHERE effect.effect_identity =
        'LEGAL_HOLD_SET:' || expected_source_identity || ':' ||
        state.desired_revision::text
      AND effect.operation = 'SET_OBJECT_LEGAL_HOLD'
      AND effect.state = 'UNKNOWN';
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSE
    RETURN NULL;
  END IF;
  IF expected_bucket IS NULL
     OR p_capability.source_reference IS DISTINCT FROM expected_source_identity
     OR p_capability.authority_kind IS DISTINCT FROM
       'LEGAL_HOLD_RECONCILIATION_INTENT'
     OR p_capability.authority_reference IS DISTINCT FROM
       expected_source_identity
     OR p_capability.scope_kind IS DISTINCT FROM expected_scope_kind
     OR p_capability.workspace_id IS DISTINCT FROM expected_workspace_id
     OR p_capability.effect_identity IS DISTINCT FROM expected_effect_identity
     OR p_capability.resource IS DISTINCT FROM expected_resource THEN
    RETURN NULL;
  END IF;
  RETURN state.work_lease_expires_at;
END
$function$;

REVOKE ALL ON FUNCTION tenant_data_validate_legal_hold_capability_private(
  public.tenant_data_capabilities, uuid, timestamptz
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;

-- Revalidate the live source lease/state at every Broker execution. This
-- function is deliberately private; callers cannot supply Tenant or resource
-- coordinates to it.
CREATE FUNCTION tenant_data_capability_source_lease_expires_at(
  p_capability public.tenant_data_capabilities,
  p_lease_token uuid,
  p_database_now timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  source_lease_expires_at timestamptz;
BEGIN
  IF p_lease_token IS NULL
     OR p_capability.lease_token_sha256 IS DISTINCT FROM encode(
       sha256(convert_to(p_lease_token::text, 'UTF8')), 'hex'
     ) THEN
    RETURN NULL;
  END IF;

  CASE p_capability.source_kind
    WHEN 'WORKLOAD_WRITE_INTENT' THEN
      SELECT intent.work_lease_expires_at INTO source_lease_expires_at
      FROM public.workload_object_write_intents intent
      WHERE intent.operation_id::text = p_capability.source_reference
        AND intent.tenant_id = p_capability.tenant_id
        AND intent.workspace_id = p_capability.workspace_id
        AND intent.work_attempt_count = p_capability.source_revision
        AND intent.status = 'PENDING'
        AND intent.work_lease_token = p_lease_token
        AND intent.work_lease_expires_at > p_database_now
        AND p_capability.resource->>'key' = intent.object_key
        AND COALESCE(
          p_capability.resource->>'checksumSha256',
          p_capability.resource->>'expectedChecksumSha256'
        ) = intent.checksum
        AND COALESCE(
          p_capability.resource->>'contentType',
          p_capability.resource->>'expectedContentType'
        ) = intent.content_type
        AND COALESCE(
          p_capability.resource->>'byteLength',
          p_capability.resource->>'expectedByteLength'
        ) = intent.byte_length::text
        AND (
          (p_capability.operation = 'PUT_WORKLOAD_OBJECT'
            AND p_capability.resource->>'kind' = 'WORKLOAD_OBJECT_PUT')
          OR (p_capability.operation = 'HEAD_WORKLOAD_OBJECT'
            AND p_capability.resource->>'kind' =
              'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD'
            AND EXISTS (
              SELECT 1
              FROM public.tenant_data_broker_effects effect
              WHERE effect.effect_identity =
                  'WORKLOAD_OBJECT_WRITE:' || intent.operation_id::text
                AND effect.operation = 'PUT_WORKLOAD_OBJECT'
                AND effect.state = 'UNKNOWN'
            ))
        );
    WHEN 'PRIVACY_WRITE_INTENT' THEN
      SELECT intent.work_lease_expires_at INTO source_lease_expires_at
      FROM public.privacy_object_write_intents intent
      WHERE intent.operation_id::text = p_capability.source_reference
        AND intent.tenant_id = p_capability.tenant_id
        AND intent.work_attempt_count = p_capability.source_revision
        AND intent.status = 'PENDING'
        AND intent.work_lease_token = p_lease_token
        AND intent.work_lease_expires_at > p_database_now
        AND p_capability.resource->>'key' = intent.object_key
        AND COALESCE(
          p_capability.resource->>'checksumSha256',
          p_capability.resource->>'expectedChecksumSha256'
        ) = intent.checksum
        AND COALESCE(
          p_capability.resource->>'contentType',
          p_capability.resource->>'expectedContentType'
        ) = intent.content_type
        AND COALESCE(
          p_capability.resource->>'byteLength',
          p_capability.resource->>'expectedByteLength'
        ) = intent.byte_length::text
        AND (
          (p_capability.operation = 'PUT_PRIVACY_OBJECT'
            AND p_capability.resource->>'kind' = 'PRIVACY_OBJECT_PUT')
          OR (p_capability.operation = 'HEAD_PRIVACY_OBJECT'
            AND p_capability.resource->>'kind' =
              'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD'
            AND EXISTS (
              SELECT 1
              FROM public.tenant_data_broker_effects effect
              WHERE effect.effect_identity =
                  'PRIVACY_OBJECT_WRITE:' || intent.operation_id::text
                AND effect.operation = 'PUT_PRIVACY_OBJECT'
                AND effect.state = 'UNKNOWN'
            ))
        );
    WHEN 'ACTIVE_PUBLICATION_JOB' THEN
      SELECT job.lease_expires_at INTO source_lease_expires_at
      FROM public.publication_records publication
      JOIN public.jobs job
        ON job.tenant_id = publication.tenant_id
        AND job.workspace_id = publication.workspace_id
        AND job.id = publication.job_id
      JOIN public.channel_packages package
        ON package.tenant_id = publication.tenant_id
       AND package.workspace_id = publication.workspace_id
       AND package.id = publication.channel_package_id
       AND package.package_checksum = publication.package_checksum
       AND package.artifact_revision_id = publication.artifact_revision_id
       AND package.artifact_content_hash = publication.artifact_content_hash
      JOIN public.adapter_versions adapter
        ON adapter.id = publication.adapter_version_id
       AND adapter.channel_definition_id = package.channel_definition_id
       AND adapter.enabled
       AND adapter.terms_status = 'ALLOWED'
       AND 'PUBLISH' = ANY(adapter.capabilities)
       AND 'RECONCILE' = ANY(adapter.capabilities)
       AND (
         adapter.provider_api_supported_until IS NULL
         OR adapter.provider_api_supported_until > p_database_now
       )
      JOIN public.channel_definitions channel
        ON channel.id = adapter.channel_definition_id
       AND channel.status = 'AVAILABLE'
      JOIN public.tenant_data_broker_resource_authority authority
        ON authority.singleton
      JOIN public.channel_authorizations channel_auth
        ON channel_auth.tenant_id = publication.tenant_id
       AND channel_auth.workspace_id = publication.workspace_id
       AND channel_auth.id = publication.channel_authorization_id
       AND channel_auth.adapter_version_id = adapter.id
       AND channel_auth.target = publication.authorization_target
       AND channel_auth.status = 'ACTIVE'
       AND channel_auth.secret_arn = p_capability.resource->>'secretArn'
       AND channel_auth.secret_arn LIKE
         'arn:aws:secretsmanager:ap-southeast-1:' ||
         authority.aws_account_id || ':secret:tenant-' ||
         publication.tenant_id::text || '/workspace-' ||
         publication.workspace_id::text || '/_%'
       AND channel_auth.accepted_terms_version = adapter.terms_version
       AND adapter.required_scopes <@ channel_auth.granted_scopes
       AND (
         channel_auth.expires_at IS NULL
         OR channel_auth.expires_at > p_database_now
       )
      JOIN public.tenants tenant
        ON tenant.id = publication.tenant_id
       AND tenant.lifecycle_state = 'ACTIVE'
      JOIN public.workspaces workspace
        ON workspace.tenant_id = publication.tenant_id
       AND workspace.id = publication.workspace_id
       AND workspace.lifecycle_state = 'ACTIVE'
      WHERE publication.id::text = p_capability.source_reference
        AND publication.tenant_id = p_capability.tenant_id
        AND publication.workspace_id = p_capability.workspace_id
        AND publication.status IN (
          'RUNNING', 'RECONCILING', 'ROLLBACK_QUEUED'
        )
        AND job.job_type = 'PUBLICATION'
        AND job.status = 'RUNNING'
        AND job.attempt = p_capability.source_revision
        AND job.lease_token = p_lease_token
        AND job.lease_expires_at > p_database_now
        AND p_capability.authority_kind = 'ACTIVE_PUBLICATION_JOB'
        AND p_capability.authority_reference = publication.id::text
        AND p_capability.scope_kind = 'WORKSPACE'
        AND p_capability.operation = 'READ_CONNECTOR_SECRET'
        AND p_capability.resource = jsonb_build_object(
          'kind', 'CONNECTOR_SECRET',
          'secretArn', channel_auth.secret_arn
        );
    WHEN 'ACTIVE_JOB_OBJECT_READ' THEN
      SELECT job.lease_expires_at INTO source_lease_expires_at
      FROM public.publication_records publication
      JOIN public.jobs job
        ON job.tenant_id = publication.tenant_id
       AND job.workspace_id = publication.workspace_id
       AND job.id = publication.job_id
      JOIN public.channel_packages package
        ON package.tenant_id = publication.tenant_id
       AND package.workspace_id = publication.workspace_id
       AND package.id = publication.channel_package_id
       AND package.package_checksum = publication.package_checksum
       AND package.artifact_revision_id = publication.artifact_revision_id
       AND package.artifact_content_hash = publication.artifact_content_hash
      JOIN public.tenant_data_channel_package_object_bindings binding
        ON binding.tenant_id = package.tenant_id
       AND binding.workspace_id = package.workspace_id
       AND binding.channel_package_id = package.id
       AND binding.package_checksum = package.package_checksum
       AND binding.payload_object_ref = package.payload_object_ref
      JOIN public.managed_object_versions object_version
        ON object_version.tenant_id = binding.tenant_id
       AND object_version.workspace_id = binding.workspace_id
       AND object_version.object_key = binding.object_key
       AND object_version.object_version_id = binding.object_version_id
       AND object_version.object_ref = binding.payload_object_ref
       AND object_version.object_class = 'CHANNEL_PACKAGE'
       AND object_version.checksum = binding.package_checksum
       AND object_version.lifecycle_state = 'ACTIVE'
       AND NOT object_version.is_delete_marker
       AND object_version.object_key =
         'tenants/' || package.tenant_id::text || '/workspaces/' ||
         package.workspace_id::text || '/channel-packages/' ||
         package.package_checksum || '.json'
       AND object_version.object_key = p_capability.resource->>'key'
       AND object_version.object_version_id = p_capability.resource->>'versionId'
       AND object_version.checksum = p_capability.resource->>'checksumSha256'
       AND object_version.content_type = p_capability.resource->>'contentType'
       AND object_version.byte_length::text = p_capability.resource->>'byteLength'
      JOIN public.tenants tenant
        ON tenant.id = publication.tenant_id
       AND tenant.lifecycle_state = 'ACTIVE'
      JOIN public.workspaces workspace
        ON workspace.tenant_id = publication.tenant_id
       AND workspace.id = publication.workspace_id
       AND workspace.lifecycle_state = 'ACTIVE'
      WHERE publication.id::text = p_capability.source_reference
        AND publication.tenant_id = p_capability.tenant_id
        AND publication.workspace_id = p_capability.workspace_id
        AND publication.status IN (
          'RUNNING', 'RECONCILING', 'ROLLBACK_QUEUED'
        )
        AND job.job_type = 'PUBLICATION'
        AND job.status = 'RUNNING'
        AND job.attempt = p_capability.source_revision
        AND job.lease_token = p_lease_token
        AND job.lease_expires_at > p_database_now;
    WHEN 'CONNECTOR_DELETION_INTENT' THEN
      SELECT deletion.work_lease_expires_at INTO source_lease_expires_at
      FROM public.connector_secret_deletions deletion
      JOIN public.tenant_data_broker_resource_authority authority
        ON authority.singleton
      WHERE deletion.channel_authorization_id::text = p_capability.source_reference
        AND deletion.tenant_id = p_capability.tenant_id
        AND deletion.workspace_id = p_capability.workspace_id
        AND deletion.work_attempt_count = p_capability.source_revision
        AND deletion.secret_reference = p_capability.resource->>'secretArn'
        AND deletion.secret_reference LIKE
          'arn:aws:secretsmanager:ap-southeast-1:' ||
          authority.aws_account_id || ':secret:tenant-' ||
          deletion.tenant_id::text || '/workspace-' ||
          deletion.workspace_id::text || '/_%'
        AND p_capability.authority_kind = 'CONNECTOR_DELETION_INTENT'
        AND p_capability.authority_reference =
          deletion.channel_authorization_id::text
        AND p_capability.scope_kind = 'WORKSPACE'
        AND (
          (p_capability.operation = 'DESCRIBE_CONNECTOR_SECRET'
            AND deletion.state IN (
              'REVOKED_PENDING_FORCE_DELETE', 'FORCE_DELETE_REQUESTED', 'FAILED'
            )
            AND p_capability.resource = jsonb_build_object(
              'kind', 'CONNECTOR_SECRET',
              'secretArn', deletion.secret_reference
            ))
          OR (p_capability.operation = 'DELETE_CONNECTOR_SECRET'
            AND deletion.state IN ('REVOKED_PENDING_FORCE_DELETE', 'FAILED')
            AND deletion.force_delete_at <= p_database_now
            AND p_capability.resource = jsonb_build_object(
              'kind', 'CONNECTOR_SECRET',
              'secretArn', deletion.secret_reference
            ))
          OR (p_capability.operation = 'VERIFY_CONNECTOR_SECRET_UNREADABLE'
            AND deletion.state IN ('FORCE_DELETE_REQUESTED', 'FAILED')
            AND p_capability.resource = jsonb_build_object(
              'kind', 'CONNECTOR_SECRET_UNREADABLE_VERIFICATION',
              'secretArn', deletion.secret_reference,
              'resultKind', 'BOOLEAN_ONLY'
            ))
        )
        AND deletion.work_lease_token = p_lease_token
        AND deletion.work_lease_expires_at > p_database_now;
    WHEN 'DELETION_INVENTORY_INTENT' THEN
      source_lease_expires_at :=
        public.tenant_data_validate_deletion_inventory_capability_private(
          p_capability, p_lease_token, p_database_now
        );
    WHEN 'DELETION_OBJECT_INTENT' THEN
      source_lease_expires_at :=
        public.tenant_data_validate_deletion_object_capability_private(
          p_capability, p_lease_token, p_database_now
        );
    WHEN 'LEGAL_HOLD_RECONCILIATION_INTENT' THEN
      source_lease_expires_at :=
        public.tenant_data_validate_legal_hold_capability_private(
          p_capability, p_lease_token, p_database_now
        );
    WHEN 'AUTHENTICATED_OBJECT_READ' THEN
      IF p_capability.source_reference !~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR p_capability.source_reference IS DISTINCT FROM
           p_capability.capability_id::text
         OR p_capability.source_revision <> 1
         OR p_capability.authority_kind IS DISTINCT FROM
           'AUTHENTICATED_OBJECT_READ'
         OR p_capability.authority_reference IS DISTINCT FROM
           p_capability.capability_id::text
         OR p_capability.effect_identity IS DISTINCT FROM
           'AUTHENTICATED_OBJECT_READ:' || p_capability.capability_id::text THEN
        RETURN NULL;
      END IF;
      SELECT LEAST(session_row.expires_at, source.expires_at)
        INTO source_lease_expires_at
      FROM public.tenant_data_authenticated_object_read_sources source
      JOIN public.auth_sessions session_row
        ON session_row.token_digest = source.session_token_digest
       AND session_row.revoked_at IS NULL
       AND session_row.expires_at > p_database_now
      JOIN public.external_identities identity_row
        ON encode(
          sha256(convert_to(identity_row.subject, 'UTF8')), 'hex'
        ) = session_row.subject_digest
      JOIN public.memberships membership
        ON membership.tenant_id = source.tenant_id
       AND membership.id = source.membership_id
       AND membership.user_id = identity_row.user_id
       AND membership.status = 'ACTIVE'
       AND membership.tenant_data_access_revision =
         source.membership_revision
      JOIN public.role_bindings binding
        ON binding.id = source.role_binding_id
       AND binding.tenant_id = source.tenant_id
       AND binding.workspace_id = source.workspace_id
       AND binding.membership_id = source.membership_id
       AND binding.role = source.role_at_issue
       AND binding.tenant_data_access_revision =
         source.role_binding_revision
      JOIN public.tenants tenant_row
        ON tenant_row.id = source.tenant_id
       AND tenant_row.lifecycle_state = 'ACTIVE'
       AND tenant_row.access_epoch = source.tenant_access_epoch
      JOIN public.workspaces workspace_row
        ON workspace_row.tenant_id = source.tenant_id
       AND workspace_row.id = source.workspace_id
       AND workspace_row.lifecycle_state = 'ACTIVE'
       AND workspace_row.access_epoch = source.workspace_access_epoch
      JOIN public.managed_object_versions object_version
        ON object_version.tenant_id = source.tenant_id
       AND object_version.workspace_id = source.workspace_id
       AND object_version.id = source.managed_object_id
       AND object_version.lifecycle_state = 'ACTIVE'
       AND NOT object_version.is_delete_marker
       AND length(object_version.object_key) BETWEEN 1 AND 1024
       AND left(object_version.object_key, 1) <> '/'
       AND object_version.object_key !~ '[[:cntrl:]]'
       AND object_version.object_version_id !~ '[[:cntrl:]]'
       AND length(object_version.content_type) BETWEEN 3 AND 255
       AND object_version.content_type ~
         '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(;[ -~]+)?$'
       AND object_version.byte_length BETWEEN 1 AND 2147483648
      JOIN public.tenant_data_broker_resource_authority authority
        ON authority.singleton
      WHERE source.source_id = p_capability.capability_id
        AND source.tenant_id = p_capability.tenant_id
        AND source.expires_at > p_database_now
        AND (
          (
            public.tenant_data_managed_object_storage_class_private(
              object_version
            ) = 'WORKLOAD_OBJECTS'
            AND p_capability.scope_kind = 'WORKSPACE'
            AND p_capability.workspace_id = source.workspace_id
            AND p_capability.operation = 'READ_WORKLOAD_OBJECT'
          )
          OR (
            public.tenant_data_managed_object_storage_class_private(
              object_version
            ) IN ('TENANT_EXPORTS', 'AUDIT_EVIDENCE')
            AND source.role_at_issue = 'OWNER'
            AND p_capability.scope_kind = 'TENANT'
            AND p_capability.workspace_id IS NULL
            AND p_capability.operation = 'READ_PRIVACY_OBJECT'
          )
        )
        AND p_capability.resource = jsonb_build_object(
          'kind', 'OBJECT_VERSION',
          'objectClass',
            public.tenant_data_managed_object_storage_class_private(
              object_version
            ),
          'bucket', CASE
            public.tenant_data_managed_object_storage_class_private(
              object_version
            )
            WHEN 'WORKLOAD_OBJECTS' THEN authority.workload_bucket
            WHEN 'TENANT_EXPORTS' THEN authority.tenant_export_bucket
            WHEN 'AUDIT_EVIDENCE' THEN authority.audit_evidence_bucket
          END,
          'key', object_version.object_key,
          'versionId', object_version.object_version_id,
          'checksumSha256', object_version.checksum,
          'contentType', object_version.content_type,
          'byteLength', object_version.byte_length
        );
    ELSE
      RETURN NULL;
  END CASE;
  RETURN source_lease_expires_at;
END
$function$;

CREATE FUNCTION load_active_tenant_data_capability(
  p_capability_id uuid,
  p_lease_token uuid
)
RETURNS TABLE (
  capability_id uuid,
  lease_token_sha256 text,
  authority_kind text,
  authority_reference text,
  scope_kind text,
  tenant_id uuid,
  workspace_id uuid,
  operation text,
  resource jsonb,
  resource_hash text,
  effect_identity text,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  candidate public.tenant_data_capabilities%ROWTYPE;
  candidate_count integer;
  source_lease_expires_at timestamptz;
BEGIN
  SELECT count(*)
    INTO candidate_count
  FROM public.tenant_data_capabilities capability
  WHERE capability.capability_id = p_capability_id;
  IF candidate_count <> 1 THEN RETURN; END IF;

  SELECT * INTO candidate
  FROM public.tenant_data_capabilities capability
  WHERE capability.capability_id = p_capability_id;
  source_lease_expires_at :=
    public.tenant_data_capability_source_lease_expires_at(
      candidate, p_lease_token, database_now
    );
  IF source_lease_expires_at IS NULL
     OR candidate.expires_at <= database_now THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT candidate.capability_id, candidate.lease_token_sha256,
    candidate.authority_kind, candidate.authority_reference,
    candidate.scope_kind, candidate.tenant_id, candidate.workspace_id,
    candidate.operation, candidate.resource, candidate.resource_hash,
    candidate.effect_identity,
    LEAST(candidate.expires_at, source_lease_expires_at);
END
$function$;

CREATE FUNCTION begin_tenant_data_broker_effect(
  p_capability_id uuid,
  p_lease_token uuid,
  p_nonce uuid,
  p_operation text,
  p_resource_hash text
)
RETURNS TABLE (outcome text, attempt_id uuid, success_receipt jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  capability public.tenant_data_capabilities%ROWTYPE;
  prior public.tenant_data_broker_effects%ROWTYPE;
  next_attempt_id uuid := gen_random_uuid();
  is_effectful boolean;
  source_lease_expires_at timestamptz;
  nonce_hash text;
BEGIN
  IF p_capability_id IS NULL OR p_lease_token IS NULL
     OR p_nonce IS NULL OR p_resource_hash IS NULL
     OR p_operation IS NULL
     OR p_resource_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN;
  END IF;
  SELECT stored.nonce_hash INTO nonce_hash
  FROM public.tenant_data_broker_nonces stored
  WHERE stored.nonce = p_nonce
    AND stored.expires_at > database_now
  FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO capability
  FROM public.tenant_data_capabilities stored
  WHERE stored.capability_id = p_capability_id
  FOR SHARE;
  IF NOT FOUND
     OR capability.operation IS DISTINCT FROM p_operation
     OR capability.resource_hash IS DISTINCT FROM p_resource_hash
     OR capability.expires_at <= database_now THEN
    RETURN;
  END IF;
  source_lease_expires_at :=
    public.tenant_data_capability_source_lease_expires_at(
      capability, p_lease_token, database_now
    );
  IF source_lease_expires_at IS NULL THEN RETURN; END IF;

  is_effectful := p_operation IN (
    'DELETE_CONNECTOR_SECRET', 'PUT_WORKLOAD_OBJECT',
    'DELETE_WORKLOAD_OBJECT_VERSION', 'PUT_PRIVACY_OBJECT',
    'DELETE_PRIVACY_OBJECT_VERSION', 'SET_OBJECT_LEGAL_HOLD'
  );

  IF is_effectful THEN
    -- This lock survives through the statement transaction. It closes the
    -- SELECT-before-INSERT race even when no effect row exists yet.
    PERFORM pg_advisory_xact_lock(hashtextextended(capability.effect_identity, 0));
    SELECT * INTO prior
    FROM public.tenant_data_broker_effects effect
    WHERE effect.effect_identity = capability.effect_identity
    FOR UPDATE;
    IF FOUND AND prior.state = 'SUCCESS' THEN
      INSERT INTO public.tenant_data_broker_attempts (
        attempt_id, capability_id, effect_identity, nonce, nonce_hash, operation,
        resource_hash, effectful, outcome, started_at, finished_at
      ) VALUES (
        next_attempt_id, capability.capability_id, capability.effect_identity,
        p_nonce, nonce_hash, p_operation, p_resource_hash, true, 'SUCCESS',
        database_now, database_now
      );
      RETURN QUERY SELECT 'ALREADY_SUCCEEDED'::text, next_attempt_id,
        prior.success_receipt;
      RETURN;
    ELSIF FOUND AND prior.state = 'UNKNOWN'
        AND p_operation IN (
          'DELETE_WORKLOAD_OBJECT_VERSION',
          'DELETE_PRIVACY_OBJECT_VERSION'
        )
        AND capability.resource->>'kind' = 'OBJECT_VERSION_DELETE'
        AND length(capability.resource->>'versionId') BETWEEN 1 AND 1024 THEN
      -- S3 deletion of one immutable, explicit VersionId is idempotent in
      -- effect: repeating it can only leave that same version absent. This is
      -- the recovery path for ordinary orphan versions and delete markers,
      -- which cannot be probed with the checksum-bearing HEAD contract.
      NULL;
    ELSIF FOUND AND prior.state IN ('STARTED', 'UNKNOWN') THEN
      INSERT INTO public.tenant_data_broker_attempts (
        attempt_id, capability_id, effect_identity, nonce, nonce_hash, operation,
        resource_hash, effectful, outcome, started_at, finished_at
      ) VALUES (
        next_attempt_id, capability.capability_id, capability.effect_identity,
        p_nonce, nonce_hash, p_operation, p_resource_hash, true, 'UNKNOWN',
        database_now, database_now
      );
      RETURN QUERY SELECT 'AMBIGUOUS'::text, next_attempt_id, NULL::jsonb;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.tenant_data_broker_attempts (
    attempt_id, capability_id, effect_identity, nonce, nonce_hash, operation,
    resource_hash, effectful, outcome, started_at
  ) VALUES (
    next_attempt_id, capability.capability_id, capability.effect_identity,
    p_nonce, nonce_hash, p_operation, p_resource_hash, is_effectful, 'STARTED',
    database_now
  );
  IF is_effectful THEN
    INSERT INTO public.tenant_data_broker_effects (
      effect_identity, operation, state, active_attempt_id, updated_at
    ) VALUES (
      capability.effect_identity, p_operation, 'STARTED', next_attempt_id,
      database_now
    )
    ON CONFLICT (effect_identity) DO UPDATE
    SET operation = EXCLUDED.operation, state = 'STARTED',
        active_attempt_id = EXCLUDED.active_attempt_id,
        success_receipt = NULL, updated_at = database_now;
  END IF;
  RETURN QUERY SELECT 'STARTED'::text, next_attempt_id, NULL::jsonb;
END
$function$;

CREATE FUNCTION begin_authenticated_tenant_data_broker_effect(
  p_nonce uuid,
  p_signed_at timestamptz,
  p_expires_at timestamptz,
  p_capability_id uuid,
  p_lease_token uuid,
  p_operation text,
  p_resource_hash text
)
RETURNS TABLE (outcome text, attempt_id uuid, success_receipt jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  begun_count integer;
BEGIN
  IF NOT public.consume_tenant_data_broker_nonce(
    p_nonce, p_signed_at, p_expires_at
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT begun.outcome, begun.attempt_id, begun.success_receipt
  FROM public.begin_tenant_data_broker_effect(
    p_capability_id, p_lease_token, p_nonce, p_operation, p_resource_hash
  ) begun;
  GET DIAGNOSTICS begun_count = ROW_COUNT;
  IF begun_count = 0 THEN
    DELETE FROM public.tenant_data_broker_nonces stored
    WHERE stored.nonce = p_nonce
      AND NOT EXISTS (
        SELECT 1
        FROM public.tenant_data_broker_attempts attempt
        WHERE attempt.nonce = stored.nonce
      );
  END IF;
END
$function$;

CREATE FUNCTION finish_tenant_data_broker_effect(
  p_attempt_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_success_receipt jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  attempt public.tenant_data_broker_attempts%ROWTYPE;
  capability public.tenant_data_capabilities%ROWTYPE;
  effect_row public.tenant_data_broker_effects%ROWTYPE;
  source_lease_expires_at timestamptz;
  effective_outcome text;
  effective_receipt jsonb;
  affected integer;
  receipt_key_count integer;
BEGIN
  IF p_attempt_id IS NULL OR p_lease_token IS NULL OR p_outcome IS NULL
     OR p_outcome NOT IN ('SUCCESS', 'FAILED', 'UNKNOWN') THEN
    RETURN false;
  END IF;
  SELECT * INTO attempt
  FROM public.tenant_data_broker_attempts stored
  WHERE stored.attempt_id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT * INTO capability
  FROM public.tenant_data_capabilities stored
  WHERE stored.capability_id = attempt.capability_id
  FOR SHARE;
  IF NOT FOUND
     OR capability.lease_token_sha256 IS DISTINCT FROM encode(
       sha256(convert_to(p_lease_token::text, 'UTF8')), 'hex'
     ) THEN
    RETURN false;
  END IF;

  IF attempt.outcome <> 'STARTED' THEN
    IF attempt.outcome IS DISTINCT FROM p_outcome THEN RETURN false; END IF;
    IF p_outcome <> 'SUCCESS' THEN RETURN p_success_receipt IS NULL; END IF;
    IF NOT attempt.effectful THEN RETURN p_success_receipt IS NULL; END IF;
    SELECT * INTO effect_row
    FROM public.tenant_data_broker_effects stored
    WHERE stored.effect_identity = attempt.effect_identity
      AND stored.state = 'SUCCESS';
    RETURN FOUND
      AND effect_row.success_receipt IS NOT DISTINCT FROM p_success_receipt;
  END IF;

  IF attempt.effectful THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(attempt.effect_identity, 0));
    SELECT * INTO effect_row
    FROM public.tenant_data_broker_effects stored
    WHERE stored.effect_identity = attempt.effect_identity
      AND stored.active_attempt_id = p_attempt_id
      AND stored.state = 'STARTED'
    FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
  END IF;

  effective_outcome := p_outcome;
  effective_receipt := p_success_receipt;
  IF p_outcome = 'SUCCESS' THEN
    source_lease_expires_at :=
      public.tenant_data_capability_source_lease_expires_at(
        capability, p_lease_token, database_now
      );
    IF capability.expires_at <= database_now
       OR source_lease_expires_at IS NULL
       OR source_lease_expires_at <= database_now THEN
      -- The remote result can no longer be acknowledged against the same
      -- dispatch authority. Persist UNKNOWN so no later capability retries the
      -- stable cloud effect.
      effective_outcome := 'UNKNOWN';
      effective_receipt := NULL;
    END IF;
  END IF;

  IF effective_outcome <> 'SUCCESS' AND effective_receipt IS NOT NULL THEN
    RETURN false;
  END IF;

  IF effective_outcome = 'SUCCESS' AND attempt.effectful
     AND attempt.operation IN ('PUT_WORKLOAD_OBJECT', 'PUT_PRIVACY_OBJECT') THEN
    IF effective_receipt IS NULL
       OR jsonb_typeof(effective_receipt) <> 'object'
       OR octet_length(effective_receipt::text) > 8192 THEN
      RETURN false;
    END IF;
    SELECT count(*) INTO receipt_key_count
    FROM jsonb_object_keys(effective_receipt);
    IF receipt_key_count <> 6
       OR NOT effective_receipt ?& ARRAY[
         'bucket', 'key', 'versionId', 'checksum', 'contentType', 'byteLength'
       ]
       OR jsonb_typeof(effective_receipt->'bucket') <> 'string'
       OR jsonb_typeof(effective_receipt->'key') <> 'string'
       OR jsonb_typeof(effective_receipt->'versionId') <> 'string'
       OR jsonb_typeof(effective_receipt->'checksum') <> 'string'
       OR jsonb_typeof(effective_receipt->'contentType') <> 'string'
       OR jsonb_typeof(effective_receipt->'byteLength') <> 'number'
       OR effective_receipt->>'bucket' IS DISTINCT FROM capability.resource->>'bucket'
       OR effective_receipt->>'key' IS DISTINCT FROM capability.resource->>'key'
       OR effective_receipt->>'checksum'
         IS DISTINCT FROM capability.resource->>'checksumSha256'
       OR effective_receipt->>'contentType'
         IS DISTINCT FROM capability.resource->>'contentType'
       OR effective_receipt->>'byteLength'
         IS DISTINCT FROM capability.resource->>'byteLength'
       OR length(effective_receipt->>'versionId') NOT BETWEEN 1 AND 1024 THEN
      RETURN false;
    END IF;
  ELSIF effective_outcome = 'SUCCESS' AND attempt.effectful THEN
    -- Mutations without object bytes may acknowledge only an empty receipt;
    -- this prevents secret plaintext or arbitrary remote response bodies from
    -- entering the durable journal.
    IF effective_receipt IS DISTINCT FROM '{}'::jsonb THEN RETURN false; END IF;
  ELSIF effective_outcome = 'SUCCESS' AND effective_receipt IS NOT NULL THEN
    RETURN false;
  END IF;

  IF attempt.effectful THEN
    UPDATE public.tenant_data_broker_effects stored_effect
    SET state = effective_outcome, success_receipt = effective_receipt,
        updated_at = database_now
    WHERE stored_effect.effect_identity = attempt.effect_identity
      AND stored_effect.active_attempt_id = p_attempt_id
      AND stored_effect.state = 'STARTED';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'TENANT_DATA_BROKER_EFFECT_FENCE_LOST'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  UPDATE public.tenant_data_broker_attempts stored
  SET outcome = effective_outcome, finished_at = database_now
  WHERE stored.attempt_id = p_attempt_id
    AND stored.outcome = 'STARTED';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_ATTEMPT_FENCE_LOST'
      USING ERRCODE = '40001';
  END IF;
  RETURN effective_outcome = p_outcome;
END
$function$;

CREATE FUNCTION resolve_tenant_data_broker_object_put_effect(
  p_probe_attempt_id uuid,
  p_lease_token uuid,
  p_observation text,
  p_observed_version_id text,
  p_observed_checksum text,
  p_observed_content_type text,
  p_observed_byte_length bigint
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  probe_attempt public.tenant_data_broker_attempts%ROWTYPE;
  probe_capability public.tenant_data_capabilities%ROWTYPE;
  authority public.tenant_data_broker_resource_authority%ROWTYPE;
  workload_intent public.workload_object_write_intents%ROWTYPE;
  privacy_intent public.privacy_object_write_intents%ROWTYPE;
  put_effect public.tenant_data_broker_effects%ROWTYPE;
  expected_probe_resource jsonb;
  expected_probe_effect_identity text;
  put_effect_identity text;
  put_operation text;
  expected_bucket text;
  expected_key text;
  expected_checksum text;
  expected_content_type text;
  expected_byte_length bigint;
  expected_scope_kind text;
  expected_workspace_id uuid;
  resolved_state text;
  resolved_receipt jsonb;
  affected integer;
BEGIN
  IF p_probe_attempt_id IS NULL OR p_lease_token IS NULL
     OR p_observation IS NULL
     OR p_observation NOT IN ('FOUND', 'MISSING', 'MISMATCH') THEN
    RETURN 'NOT_RESOLVED';
  END IF;
  IF p_observation = 'FOUND' THEN
    IF p_observed_version_id IS NULL
       OR length(p_observed_version_id) NOT BETWEEN 1 AND 1024
       OR p_observed_version_id ~ '[[:cntrl:]]'
       OR p_observed_checksum !~ '^[a-f0-9]{64}$'
       OR p_observed_content_type IS NULL
       OR length(p_observed_content_type) NOT BETWEEN 3 AND 255
       OR p_observed_byte_length NOT BETWEEN 1 AND 2147483648 THEN
      RETURN 'NOT_RESOLVED';
    END IF;
  ELSIF p_observed_version_id IS NOT NULL
     OR p_observed_checksum IS NOT NULL
     OR p_observed_content_type IS NOT NULL
     OR p_observed_byte_length IS NOT NULL THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  SELECT stored.* INTO probe_attempt
  FROM public.tenant_data_broker_attempts stored
  WHERE stored.attempt_id = p_probe_attempt_id
  FOR UPDATE;
  IF NOT FOUND
     OR probe_attempt.operation NOT IN (
       'HEAD_WORKLOAD_OBJECT', 'HEAD_PRIVACY_OBJECT'
     )
     OR probe_attempt.effectful
     OR probe_attempt.outcome IS DISTINCT FROM 'STARTED' THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  SELECT stored.* INTO probe_capability
  FROM public.tenant_data_capabilities stored
  WHERE stored.capability_id = probe_attempt.capability_id
  FOR SHARE;
  IF NOT FOUND
     OR probe_capability.expires_at <= database_now
     OR probe_capability.lease_token_sha256 IS DISTINCT FROM encode(
       sha256(convert_to(p_lease_token::text, 'UTF8')), 'hex'
     )
     OR probe_capability.operation IS DISTINCT FROM probe_attempt.operation
     OR probe_capability.resource_hash IS DISTINCT FROM
       probe_attempt.resource_hash
     OR probe_capability.source_reference !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  SELECT configured.* INTO authority
  FROM public.tenant_data_broker_resource_authority configured
  WHERE configured.singleton;
  IF NOT FOUND THEN RETURN 'NOT_RESOLVED'; END IF;

  IF probe_capability.source_kind = 'WORKLOAD_WRITE_INTENT'
     AND probe_capability.authority_kind = 'WORKLOAD_WRITE_INTENT'
     AND probe_capability.operation = 'HEAD_WORKLOAD_OBJECT' THEN
    SELECT intent.* INTO workload_intent
    FROM public.workload_object_write_intents intent
    WHERE intent.operation_id = probe_capability.source_reference::uuid
      AND intent.tenant_id = probe_capability.tenant_id
      AND intent.workspace_id = probe_capability.workspace_id
      AND intent.work_attempt_count = probe_capability.source_revision
      AND intent.status = 'PENDING'
      AND intent.work_lease_token = p_lease_token
      AND intent.work_lease_expires_at > database_now
    FOR SHARE;
    IF NOT FOUND THEN RETURN 'NOT_RESOLVED'; END IF;
    expected_bucket := authority.workload_bucket;
    expected_key := workload_intent.object_key;
    expected_checksum := workload_intent.checksum;
    expected_content_type := workload_intent.content_type;
    expected_byte_length := workload_intent.byte_length;
    expected_scope_kind := 'WORKSPACE';
    expected_workspace_id := workload_intent.workspace_id;
    expected_probe_resource := jsonb_build_object(
      'kind', 'WORKLOAD_OBJECT_WRITE_RECOVERY_HEAD',
      'objectClass', 'WORKLOAD_OBJECTS',
      'bucket', expected_bucket,
      'key', expected_key,
      'expectedChecksumSha256', expected_checksum,
      'expectedContentType', expected_content_type,
      'expectedByteLength', expected_byte_length,
      'lockedUntil', NULL,
      'sealedAt', NULL
    );
    expected_probe_effect_identity :=
      'WORKLOAD_OBJECT_RECOVERY_HEAD:' ||
      workload_intent.operation_id::text || ':' ||
      workload_intent.work_attempt_count::text;
    put_effect_identity :=
      'WORKLOAD_OBJECT_WRITE:' || workload_intent.operation_id::text;
    put_operation := 'PUT_WORKLOAD_OBJECT';
  ELSIF probe_capability.source_kind = 'PRIVACY_WRITE_INTENT'
     AND probe_capability.authority_kind = 'PRIVACY_WRITE_INTENT'
     AND probe_capability.operation = 'HEAD_PRIVACY_OBJECT' THEN
    SELECT intent.* INTO privacy_intent
    FROM public.privacy_object_write_intents intent
    WHERE intent.operation_id = probe_capability.source_reference::uuid
      AND intent.tenant_id = probe_capability.tenant_id
      AND probe_capability.scope_kind = 'TENANT'
      AND probe_capability.workspace_id IS NULL
      AND intent.work_attempt_count = probe_capability.source_revision
      AND intent.status = 'PENDING'
      AND intent.work_lease_token = p_lease_token
      AND intent.work_lease_expires_at > database_now
    FOR SHARE;
    IF NOT FOUND THEN RETURN 'NOT_RESOLVED'; END IF;
    expected_bucket := CASE privacy_intent.kind
      WHEN 'TENANT_EXPORT' THEN authority.tenant_export_bucket
      WHEN 'AUDIT_DIGEST' THEN authority.audit_evidence_bucket
      ELSE NULL
    END;
    expected_key := privacy_intent.object_key;
    expected_checksum := privacy_intent.checksum;
    expected_content_type := privacy_intent.content_type;
    expected_byte_length := privacy_intent.byte_length;
    expected_scope_kind := 'TENANT';
    expected_workspace_id := NULL;
    expected_probe_resource := jsonb_build_object(
      'kind', 'PRIVACY_OBJECT_WRITE_RECOVERY_HEAD',
      'objectClass', CASE privacy_intent.kind
        WHEN 'TENANT_EXPORT' THEN 'TENANT_EXPORTS'
        WHEN 'AUDIT_DIGEST' THEN 'AUDIT_EVIDENCE'
      END,
      'bucket', expected_bucket,
      'key', expected_key,
      'expectedChecksumSha256', expected_checksum,
      'expectedContentType', expected_content_type,
      'expectedByteLength', expected_byte_length,
      'lockedUntil',
        public.tenant_data_canonical_utc_instant_private(
          privacy_intent.locked_until
        ),
      'sealedAt',
        public.tenant_data_canonical_utc_instant_private(
          privacy_intent.sealed_at
        )
    );
    expected_probe_effect_identity :=
      'PRIVACY_OBJECT_RECOVERY_HEAD:' ||
      privacy_intent.operation_id::text || ':' ||
      privacy_intent.work_attempt_count::text;
    put_effect_identity :=
      'PRIVACY_OBJECT_WRITE:' || privacy_intent.operation_id::text;
    put_operation := 'PUT_PRIVACY_OBJECT';
  ELSE
    RETURN 'NOT_RESOLVED';
  END IF;

  IF expected_bucket IS NULL
     OR probe_capability.authority_reference IS DISTINCT FROM
       probe_capability.source_reference
     OR probe_capability.scope_kind IS DISTINCT FROM expected_scope_kind
     OR probe_capability.workspace_id IS DISTINCT FROM expected_workspace_id
     OR probe_capability.effect_identity IS DISTINCT FROM
       expected_probe_effect_identity
     OR probe_capability.resource IS DISTINCT FROM expected_probe_resource THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(put_effect_identity, 0));
  SELECT stored.* INTO put_effect
  FROM public.tenant_data_broker_effects stored
  WHERE stored.effect_identity = put_effect_identity
    AND stored.operation = put_operation
  FOR UPDATE;
  IF NOT FOUND OR put_effect.state IS DISTINCT FROM 'UNKNOWN' THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  IF p_observation = 'FOUND'
     AND p_observed_checksum = expected_checksum
     AND p_observed_content_type = expected_content_type
     AND p_observed_byte_length = expected_byte_length THEN
    resolved_state := 'SUCCESS';
    resolved_receipt := jsonb_build_object(
      'bucket', expected_bucket,
      'key', expected_key,
      'versionId', p_observed_version_id,
      'checksum', expected_checksum,
      'contentType', expected_content_type,
      'byteLength', expected_byte_length
    );
  ELSE
    resolved_state := 'FAILED';
    resolved_receipt := NULL;
  END IF;

  UPDATE public.tenant_data_broker_effects stored
  SET state = resolved_state, success_receipt = resolved_receipt,
      updated_at = database_now
  WHERE stored.effect_identity = put_effect_identity
    AND stored.state = 'UNKNOWN';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_EFFECT_FENCE_LOST'
      USING ERRCODE = '40001';
  END IF;
  UPDATE public.tenant_data_broker_attempts stored
  SET outcome = 'SUCCESS', finished_at = database_now
  WHERE stored.attempt_id = p_probe_attempt_id
    AND stored.outcome = 'STARTED';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_ATTEMPT_FENCE_LOST'
      USING ERRCODE = '40001';
  END IF;
  IF resolved_state = 'SUCCESS' THEN RETURN 'RESOLVED_SUCCESS'; END IF;
  RETURN 'RESOLVED_FAILED';
END
$function$;

CREATE FUNCTION resolve_tenant_data_broker_legal_hold_effect(
  p_probe_attempt_id uuid,
  p_lease_token uuid,
  p_observed_status text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  probe_attempt public.tenant_data_broker_attempts%ROWTYPE;
  probe_capability public.tenant_data_capabilities%ROWTYPE;
  state public.legal_hold_object_reconciliations%ROWTYPE;
  set_effect public.tenant_data_broker_effects%ROWTYPE;
  source_lease_expires_at timestamptz;
  source_identity text;
  set_effect_identity text;
  resolved_state text;
  resolved_receipt jsonb;
  affected integer;
BEGIN
  IF p_probe_attempt_id IS NULL OR p_lease_token IS NULL
     OR p_observed_status IS NULL
     OR p_observed_status NOT IN ('ON', 'OFF') THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  SELECT stored.* INTO probe_attempt
  FROM public.tenant_data_broker_attempts stored
  WHERE stored.attempt_id = p_probe_attempt_id
  FOR UPDATE;
  IF NOT FOUND
     OR probe_attempt.operation IS DISTINCT FROM 'GET_OBJECT_LEGAL_HOLD'
     OR probe_attempt.effectful
     OR probe_attempt.outcome IS DISTINCT FROM 'STARTED' THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  SELECT stored.* INTO probe_capability
  FROM public.tenant_data_capabilities stored
  WHERE stored.capability_id = probe_attempt.capability_id
  FOR SHARE;
  IF NOT FOUND
     OR probe_capability.source_kind IS DISTINCT FROM
       'LEGAL_HOLD_RECONCILIATION_INTENT'
     OR probe_capability.authority_kind IS DISTINCT FROM
       'LEGAL_HOLD_RECONCILIATION_INTENT'
     OR probe_capability.operation IS DISTINCT FROM 'GET_OBJECT_LEGAL_HOLD'
     OR probe_capability.expires_at <= database_now
     OR probe_capability.lease_token_sha256 IS DISTINCT FROM encode(
       sha256(convert_to(p_lease_token::text, 'UTF8')), 'hex'
     ) THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  source_lease_expires_at :=
    public.tenant_data_capability_source_lease_expires_at(
      probe_capability, p_lease_token, database_now
    );
  IF source_lease_expires_at IS NULL
     OR source_lease_expires_at <= database_now THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  SELECT reconciliation.* INTO state
  FROM public.legal_hold_object_reconciliations reconciliation
  WHERE reconciliation.tenant_id = probe_capability.tenant_id
    AND reconciliation.object_key = probe_capability.resource->>'key'
    AND reconciliation.object_version_id =
      probe_capability.resource->>'versionId'
    AND reconciliation.work_attempt_count =
      probe_capability.source_revision
    AND reconciliation.work_lease_token = p_lease_token
    AND reconciliation.work_lease_expires_at > database_now
    AND (
      reconciliation.applied_revision < reconciliation.desired_revision
      OR reconciliation.applied_status <> reconciliation.desired_status
    )
  FOR SHARE;
  IF NOT FOUND THEN RETURN 'NOT_RESOLVED'; END IF;

  source_identity := encode(sha256(convert_to(
    public.aeostudio_backup_evidence_canonical_json(jsonb_build_object(
      'tenantId', state.tenant_id,
      'key', state.object_key,
      'versionId', state.object_version_id
    )), 'UTF8'
  )), 'hex');
  IF probe_capability.source_reference IS DISTINCT FROM source_identity
     OR probe_capability.authority_reference IS DISTINCT FROM source_identity
     OR probe_capability.effect_identity IS DISTINCT FROM
       'LEGAL_HOLD_GET_RECOVERY:' || source_identity || ':' ||
       state.desired_revision::text || ':' || state.work_attempt_count::text THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  set_effect_identity :=
    'LEGAL_HOLD_SET:' || source_identity || ':' ||
    state.desired_revision::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(set_effect_identity, 0));
  SELECT stored.* INTO set_effect
  FROM public.tenant_data_broker_effects stored
  WHERE stored.effect_identity = set_effect_identity
    AND stored.operation = 'SET_OBJECT_LEGAL_HOLD'
  FOR UPDATE;
  IF NOT FOUND OR set_effect.state IS DISTINCT FROM 'UNKNOWN' THEN
    RETURN 'NOT_RESOLVED';
  END IF;

  IF p_observed_status = state.desired_status THEN
    resolved_state := 'SUCCESS';
    resolved_receipt := '{}'::jsonb;
  ELSE
    resolved_state := 'FAILED';
    resolved_receipt := NULL;
  END IF;
  UPDATE public.tenant_data_broker_effects stored
  SET state = resolved_state, success_receipt = resolved_receipt,
      updated_at = database_now
  WHERE stored.effect_identity = set_effect_identity
    AND stored.state = 'UNKNOWN';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_EFFECT_FENCE_LOST'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.tenant_data_broker_attempts stored
  SET outcome = 'SUCCESS', finished_at = database_now
  WHERE stored.attempt_id = p_probe_attempt_id
    AND stored.outcome = 'STARTED';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'TENANT_DATA_BROKER_ATTEMPT_FENCE_LOST'
      USING ERRCODE = '40001';
  END IF;
  IF resolved_state = 'SUCCESS' THEN
    RETURN 'RESOLVED_SUCCESS';
  END IF;
  RETURN 'RESOLVED_FAILED';
END
$function$;

REVOKE ALL ON FUNCTION tenant_data_capability_source_lease_expires_at(
  public.tenant_data_capabilities, uuid, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_tenant_data_broker_nonce(
  uuid, timestamptz, timestamptz
) FROM PUBLIC, aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION load_active_tenant_data_capability(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION begin_tenant_data_broker_effect(
  uuid, uuid, uuid, text, text
) FROM PUBLIC, aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION begin_authenticated_tenant_data_broker_effect(
  uuid, timestamptz, timestamptz, uuid, uuid, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION finish_tenant_data_broker_effect(
  uuid, uuid, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_tenant_data_broker_legal_hold_effect(
  uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_tenant_data_broker_object_put_effect(
  uuid, uuid, text, text, text, text, bigint
) FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION load_active_tenant_data_capability(uuid, uuid)
  TO aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION begin_authenticated_tenant_data_broker_effect(
  uuid, timestamptz, timestamptz, uuid, uuid, text, text
) TO aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION finish_tenant_data_broker_effect(uuid, uuid, text, jsonb)
  TO aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION resolve_tenant_data_broker_legal_hold_effect(
  uuid, uuid, text
) TO aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION resolve_tenant_data_broker_object_put_effect(
  uuid, uuid, text, text, text, text, bigint
) TO aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION issue_authenticated_object_read_capability(
  text, uuid, uuid, uuid, text, text, uuid, uuid
) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION issue_workload_object_put_capability(uuid, uuid, uuid)
  TO aeostudio_lifecycle_worker, aeostudio_runtime;
GRANT EXECUTE ON FUNCTION issue_publication_package_read_capability(uuid, uuid, uuid)
  TO aeostudio_lifecycle_worker, aeostudio_runtime;
GRANT EXECUTE ON FUNCTION issue_publication_secret_read_capability(uuid, uuid, uuid)
  TO aeostudio_lifecycle_worker, aeostudio_runtime;
GRANT EXECUTE ON FUNCTION issue_privacy_object_put_capability(uuid, uuid, uuid)
  TO aeostudio_lifecycle_worker, aeostudio_runtime;
GRANT EXECUTE ON FUNCTION issue_workload_object_recovery_head_capability(uuid, uuid, uuid)
  TO aeostudio_lifecycle_worker, aeostudio_runtime;
GRANT EXECUTE ON FUNCTION issue_privacy_object_recovery_head_capability(uuid, uuid, uuid)
  TO aeostudio_lifecycle_worker, aeostudio_runtime;
GRANT EXECUTE ON FUNCTION issue_connector_secret_describe_capability(uuid, uuid, uuid)
  TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION issue_connector_secret_delete_capability(uuid, uuid, uuid)
  TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION issue_connector_secret_verify_unreadable_capability(uuid, uuid, uuid)
  TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION issue_deletion_inventory_capability(
  uuid, uuid, uuid, integer
) TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION issue_deletion_object_head_capability(
  uuid, uuid, uuid, text, text
) TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION issue_deletion_object_get_legal_hold_capability(
  uuid, uuid, uuid, text, text
) TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION issue_deletion_object_delete_capability(
  uuid, uuid, uuid, text, text
) TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION issue_legal_hold_set_capability(
  uuid, text, text, uuid, uuid
) TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION issue_legal_hold_get_recovery_capability(
  uuid, text, text, uuid, uuid
) TO aeostudio_lifecycle_worker;
