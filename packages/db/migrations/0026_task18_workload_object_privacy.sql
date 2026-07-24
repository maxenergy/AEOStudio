-- Task 18: database-first metadata intents for versioned workload objects.
-- Payload bytes are intentionally never persisted here: crawl snapshots can be
-- 2 GiB. The stable scope/key/hash/length commits before S3, while exact-version
-- completion is protected by a short database lease and CAS.
CREATE TABLE workload_object_write_intents (
  operation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'CRAWL_SNAPSHOT', 'ARTIFACT_PAYLOAD', 'CHANNEL_PACKAGE'
  )),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 2048),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  content_type text NOT NULL CHECK (length(btrim(content_type)) BETWEEN 1 AND 255),
  byte_length bigint NOT NULL CHECK (byte_length BETWEEN 1 AND 2147483648),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'READY', 'CANCELLED')),
  object_ref text,
  object_version_id text,
  object_created_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  work_lease_token uuid,
  work_lease_expires_at timestamptz,
  work_attempt_count integer NOT NULL DEFAULT 0 CHECK (work_attempt_count >= 0),
  last_error text,
  CONSTRAINT workload_write_intent_tenant_key_unique UNIQUE (tenant_id, object_key),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id),
  CHECK ((status = 'READY' AND object_ref IS NOT NULL AND object_version_id IS NOT NULL
      AND object_created_at IS NOT NULL AND completed_at IS NOT NULL)
    OR (status <> 'READY' AND object_ref IS NULL AND object_version_id IS NULL
      AND object_created_at IS NULL AND completed_at IS NULL)),
  CHECK ((work_lease_token IS NULL) = (work_lease_expires_at IS NULL))
);

CREATE TABLE workload_object_write_outbox (
  operation_id uuid PRIMARY KEY
    REFERENCES workload_object_write_intents(operation_id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  available_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  UNIQUE (tenant_id, operation_id)
);

ALTER TABLE workload_object_write_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workload_object_write_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY workload_object_write_intent_isolation ON workload_object_write_intents
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

ALTER TABLE workload_object_write_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE workload_object_write_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY workload_object_write_outbox_isolation ON workload_object_write_outbox
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());

-- FORCE RLS also applies to the table/function owner. Keep the migration login
-- NOBYPASSRLS and grant only its exact owner policy, matching migration 0025.
DO $owner_policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON public.workload_object_write_intents TO %I USING (true) WITH CHECK (true)',
    current_user
  );
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON public.workload_object_write_outbox TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$owner_policy$;

CREATE FUNCTION validate_and_enroll_workload_object_write_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  scope_root text := 'tenants/' || NEW.tenant_id::text || '/workspaces/' ||
    NEW.workspace_id::text || '/';
BEGIN
  -- Serialize against deletion freeze. A committed freeze rejects the writer;
  -- a committed intent makes the deletion side wait for its lease/inventory.
  PERFORM 1 FROM public.tenants tenant
  WHERE tenant.id = NEW.tenant_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_TENANT_NOT_FOUND' USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM public.workspaces workspace
  WHERE workspace.tenant_id = NEW.tenant_id AND workspace.id = NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_WORKSPACE_NOT_FOUND' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.deletion_requests request
    WHERE request.tenant_id = NEW.tenant_id
      AND request.state IN (
        'FROZEN', 'FINALIZING', 'ACTIVE_DATA_DELETED', 'BACKUP_DELETED',
        'BLOCKED_BY_LEGAL_HOLD', 'TOMBSTONED'
      )
      AND (request.scope_kind = 'TENANT' OR request.workspace_id = NEW.workspace_id)
  ) THEN
    RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_SCOPE_FROZEN' USING ERRCODE = '42501';
  END IF;
  IF NEW.kind = 'CRAWL_SNAPSHOT' THEN
    IF NEW.object_key !~ ('^' || scope_root ||
      'sites/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/snapshots/[a-f0-9]{64}$') THEN
      RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_PREFIX_INVALID' USING ERRCODE = '22023';
    END IF;
  ELSIF NEW.kind = 'ARTIFACT_PAYLOAD' THEN
    IF NEW.object_key !~ ('^' || scope_root ||
      'artifacts/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/revisions/[1-9][0-9]*/[a-f0-9]{64}\.json$') THEN
      RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_PREFIX_INVALID' USING ERRCODE = '22023';
    END IF;
  ELSIF NEW.kind = 'CHANNEL_PACKAGE' THEN
    IF NEW.object_key !~ ('^' || scope_root || 'channel-packages/[a-f0-9]{64}\.json$') THEN
      RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_PREFIX_INVALID' USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_KIND_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.privacy_object_inventory_requirements (scope_tenant_id, required_at)
  VALUES (NEW.tenant_id, NEW.created_at)
  ON CONFLICT (scope_tenant_id) DO NOTHING;
  RETURN NEW;
END
$function$;

CREATE TRIGGER workload_object_write_intent_guard
BEFORE INSERT ON workload_object_write_intents
FOR EACH ROW EXECUTE FUNCTION validate_and_enroll_workload_object_write_intent();

CREATE FUNCTION reserve_workload_object_write_intent(
  p_operation_id uuid,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_kind text,
  p_object_key text,
  p_checksum text,
  p_content_type text,
  p_byte_length bigint
)
RETURNS TABLE (
  status text, operation_id uuid, kind text, tenant_id uuid, workspace_id uuid,
  object_key text, checksum text, content_type text, byte_length bigint,
  object_ref text, object_version_id text, object_created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  intent public.workload_object_write_intents%ROWTYPE;
  database_now timestamptz := clock_timestamp();
BEGIN
  INSERT INTO public.workload_object_write_intents (
    operation_id, tenant_id, workspace_id, kind, object_key, checksum,
    content_type, byte_length, created_at, updated_at
  ) VALUES (
    p_operation_id, p_tenant_id, p_workspace_id, p_kind, p_object_key,
    p_checksum, p_content_type, p_byte_length, database_now, database_now
  ) ON CONFLICT ON CONSTRAINT workload_write_intent_tenant_key_unique DO NOTHING;

  SELECT write_intent.* INTO intent
  FROM public.workload_object_write_intents write_intent
  WHERE write_intent.tenant_id = p_tenant_id AND write_intent.object_key = p_object_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_RESERVATION_FAILED' USING ERRCODE = 'P0001';
  END IF;
  IF intent.workspace_id IS DISTINCT FROM p_workspace_id
     OR intent.kind IS DISTINCT FROM p_kind
     OR intent.checksum IS DISTINCT FROM p_checksum
     OR intent.content_type IS DISTINCT FROM p_content_type
     OR intent.byte_length IS DISTINCT FROM p_byte_length
     OR intent.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.workload_object_write_outbox (
    operation_id, tenant_id, available_at
  ) VALUES (intent.operation_id, intent.tenant_id, database_now)
  ON CONFLICT ON CONSTRAINT workload_object_write_outbox_pkey DO NOTHING;
  RETURN QUERY SELECT intent.status, intent.operation_id, intent.kind,
    intent.tenant_id, intent.workspace_id, intent.object_key, intent.checksum,
    intent.content_type, intent.byte_length, intent.object_ref,
    intent.object_version_id, intent.object_created_at;
END
$function$;

CREATE FUNCTION claim_workload_object_write_intent(
  p_operation_id uuid,
  p_tenant_id uuid,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE affected integer;
BEGIN
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_LEASE_TOKEN_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Match aeostudio_request_deletion's Tenant lock. A freeze that started
  -- first commits before this claim is evaluated; a claim that started first
  -- remains visible to every later deletion-inventory pass.
  PERFORM 1 FROM public.tenants tenant
  WHERE tenant.id = p_tenant_id
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.workload_object_write_intents intent
  SET work_lease_token = p_lease_token,
      work_lease_expires_at = clock_timestamp() + interval '2 minutes',
      work_attempt_count = intent.work_attempt_count + 1,
      updated_at = clock_timestamp(), last_error = NULL
  WHERE intent.operation_id = p_operation_id
    AND intent.tenant_id = p_tenant_id
    AND intent.status = 'PENDING'
    AND (intent.work_lease_expires_at IS NULL
      OR intent.work_lease_expires_at <= clock_timestamp());
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END
$function$;

CREATE FUNCTION claim_pending_workload_object_write_intents(
  p_lease_token uuid,
  p_limit integer
)
RETURNS TABLE (
  operation_id uuid, kind text, tenant_id uuid, workspace_id uuid,
  object_key text, checksum text, content_type text, byte_length bigint,
  lease_token uuid, lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  candidate_ids uuid[];
BEGIN
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_LEASE_TOKEN_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Choose a bounded candidate set without changing it, then acquire every
  -- involved Tenant row in UUID order. This matches deletion freeze while
  -- avoiding cross-Tenant batch deadlocks. Eligibility is rechecked after the
  -- locks because another worker or a freeze may have won in between.
  SELECT COALESCE(array_agg(candidate.operation_id ORDER BY candidate.available_at,
    candidate.operation_id), ARRAY[]::uuid[])
  INTO candidate_ids
  FROM (
    SELECT intent.operation_id, outbox.available_at
    FROM public.workload_object_write_intents intent
    JOIN public.workload_object_write_outbox outbox
      ON outbox.operation_id = intent.operation_id
    WHERE intent.status = 'PENDING'
      AND outbox.dispatched_at IS NULL
      AND outbox.available_at <= clock_timestamp()
      AND (intent.work_lease_expires_at IS NULL
        OR intent.work_lease_expires_at <= clock_timestamp())
      AND NOT EXISTS (
        SELECT 1 FROM public.deletion_requests request
        WHERE request.tenant_id = intent.tenant_id
          AND request.state IN (
            'FROZEN', 'FINALIZING', 'ACTIVE_DATA_DELETED', 'BACKUP_DELETED',
            'BLOCKED_BY_LEGAL_HOLD', 'TOMBSTONED'
          )
          AND (request.scope_kind = 'TENANT'
            OR request.workspace_id = intent.workspace_id)
      )
    ORDER BY outbox.available_at, intent.operation_id
    LIMIT p_limit
  ) candidate;
  IF cardinality(candidate_ids) = 0 THEN RETURN; END IF;

  PERFORM tenant.id
  FROM public.tenants tenant
  WHERE tenant.id IN (
    SELECT DISTINCT intent.tenant_id
    FROM public.workload_object_write_intents intent
    WHERE intent.operation_id = ANY(candidate_ids)
  )
  ORDER BY tenant.id
  FOR SHARE OF tenant;

  RETURN QUERY
  WITH candidates AS (
    SELECT intent.operation_id
    FROM public.workload_object_write_intents intent
    JOIN public.workload_object_write_outbox outbox
      ON outbox.operation_id = intent.operation_id
    WHERE intent.status = 'PENDING'
      AND outbox.dispatched_at IS NULL
      AND outbox.available_at <= clock_timestamp()
      AND (intent.work_lease_expires_at IS NULL
        OR intent.work_lease_expires_at <= clock_timestamp())
      AND intent.operation_id = ANY(candidate_ids)
      AND NOT EXISTS (
        SELECT 1 FROM public.deletion_requests request
        WHERE request.tenant_id = intent.tenant_id
          AND request.state IN (
            'FROZEN', 'FINALIZING', 'ACTIVE_DATA_DELETED', 'BACKUP_DELETED',
            'BLOCKED_BY_LEGAL_HOLD', 'TOMBSTONED'
          )
          AND (request.scope_kind = 'TENANT'
            OR request.workspace_id = intent.workspace_id)
      )
    ORDER BY outbox.available_at, intent.operation_id
    FOR UPDATE OF intent SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.workload_object_write_intents intent
    SET work_lease_token = p_lease_token,
        work_lease_expires_at = clock_timestamp() + interval '2 minutes',
        work_attempt_count = intent.work_attempt_count + 1,
        updated_at = clock_timestamp(), last_error = NULL
    FROM candidates
    WHERE intent.operation_id = candidates.operation_id
    RETURNING intent.*
  )
  SELECT claimed.operation_id, claimed.kind, claimed.tenant_id,
    claimed.workspace_id, claimed.object_key, claimed.checksum,
    claimed.content_type, claimed.byte_length, claimed.work_lease_token,
    claimed.work_lease_expires_at
  FROM claimed ORDER BY claimed.created_at, claimed.operation_id;
END
$function$;

CREATE FUNCTION complete_workload_object_write_intent(
  p_operation_id uuid,
  p_lease_token uuid,
  p_kind text,
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_object_ref text,
  p_object_key text,
  p_object_version_id text,
  p_checksum text,
  p_content_type text,
  p_byte_length bigint,
  p_object_created_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  intent public.workload_object_write_intents%ROWTYPE;
  database_now timestamptz := clock_timestamp();
  retention interval;
BEGIN
  SELECT write_intent.* INTO intent
  FROM public.workload_object_write_intents write_intent
  WHERE write_intent.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF intent.status = 'READY' THEN
    RETURN intent.object_ref = p_object_ref
      AND intent.object_version_id = p_object_version_id
      AND intent.object_key = p_object_key
      AND intent.checksum = p_checksum;
  END IF;
  IF p_lease_token IS NULL
     OR intent.status <> 'PENDING'
     OR intent.work_lease_token IS DISTINCT FROM p_lease_token
     OR intent.work_lease_expires_at IS NULL
     OR intent.work_lease_expires_at <= database_now THEN
    RETURN false;
  END IF;
  IF p_kind IS DISTINCT FROM intent.kind
     OR p_tenant_id IS DISTINCT FROM intent.tenant_id
     OR p_workspace_id IS DISTINCT FROM intent.workspace_id
     OR p_object_key IS DISTINCT FROM intent.object_key
     OR p_checksum IS DISTINCT FROM intent.checksum
     OR p_content_type IS DISTINCT FROM intent.content_type
     OR p_byte_length IS DISTINCT FROM intent.byte_length
     OR p_object_ref IS NULL OR length(p_object_ref) NOT BETWEEN 1 AND 2048
     OR p_object_version_id IS NULL OR length(p_object_version_id) NOT BETWEEN 1 AND 1024
     OR p_object_created_at IS NULL THEN
    RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_COMPLETION_MISMATCH' USING ERRCODE = '22023';
  END IF;
  retention := CASE intent.kind WHEN 'CRAWL_SNAPSHOT' THEN interval '180 days'
    ELSE interval '30 days' END;
  INSERT INTO public.managed_object_versions (
    id, tenant_id, workspace_id, object_class, object_ref, object_key,
    object_version_id, checksum, content_type, byte_length, lifecycle_state,
    created_at, expires_at, locked_until, deletion_request_id, deleted_at
  ) VALUES (
    intent.operation_id, intent.tenant_id, intent.workspace_id, intent.kind,
    p_object_ref, p_object_key, p_object_version_id, p_checksum, p_content_type,
    p_byte_length, 'ACTIVE', p_object_created_at,
    p_object_created_at + retention, NULL, NULL, NULL
  );
  UPDATE public.workload_object_write_intents write_intent
  SET status = 'READY', object_ref = p_object_ref,
      object_version_id = p_object_version_id,
      object_created_at = p_object_created_at,
      completed_at = database_now, updated_at = database_now,
      work_lease_token = NULL, work_lease_expires_at = NULL, last_error = NULL
  WHERE write_intent.operation_id = intent.operation_id;
  UPDATE public.workload_object_write_outbox outbox
  SET dispatched_at = database_now WHERE outbox.operation_id = intent.operation_id;
  RETURN true;
END
$function$;

CREATE FUNCTION release_workload_object_write_intent_lease(
  p_operation_id uuid,
  p_lease_token uuid,
  p_error text DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 0
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  affected integer;
  database_now timestamptz := clock_timestamp();
BEGIN
  IF p_retry_delay_seconds NOT BETWEEN 0 AND 300 THEN
    RAISE EXCEPTION 'WORKLOAD_OBJECT_WRITE_RETRY_DELAY_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE public.workload_object_write_intents intent
  SET work_lease_token = NULL, work_lease_expires_at = NULL,
      updated_at = database_now,
      last_error = CASE WHEN p_error IS NULL THEN intent.last_error ELSE left(p_error, 500) END
  WHERE intent.operation_id = p_operation_id
    AND intent.status = 'PENDING' AND intent.work_lease_token = p_lease_token;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 1 AND p_retry_delay_seconds > 0 THEN
    UPDATE public.workload_object_write_outbox outbox
    SET available_at = GREATEST(outbox.available_at,
          database_now + make_interval(secs => p_retry_delay_seconds))
    WHERE outbox.operation_id = p_operation_id
      AND outbox.dispatched_at IS NULL;
  END IF;
  RETURN affected = 1;
END
$function$;

REVOKE ALL ON workload_object_write_intents, workload_object_write_outbox FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_and_enroll_workload_object_write_intent() FROM PUBLIC;
REVOKE ALL ON FUNCTION reserve_workload_object_write_intent(
  uuid, uuid, uuid, text, text, text, text, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_workload_object_write_intent(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_pending_workload_object_write_intents(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_workload_object_write_intent(
  uuid, uuid, text, uuid, uuid, text, text, text, text, text, bigint, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_workload_object_write_intent_lease(
  uuid, uuid, text, integer
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION reserve_workload_object_write_intent(
  uuid, uuid, uuid, text, text, text, text, bigint
) TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION claim_workload_object_write_intent(uuid, uuid, uuid)
  TO aeostudio_runtime;
GRANT EXECUTE ON FUNCTION complete_workload_object_write_intent(
  uuid, uuid, text, uuid, uuid, text, text, text, text, text, bigint, timestamptz
) TO aeostudio_runtime, aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION release_workload_object_write_intent_lease(uuid, uuid, text, integer)
  TO aeostudio_runtime, aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION claim_pending_workload_object_write_intents(uuid, integer)
  TO aeostudio_lifecycle_worker;

-- One bounded page is committed at a time. Cursors are opaque S3 markers, so
-- an inventory with more than 100,000 versions makes forward progress without
-- accumulating all keys in Worker memory or one PostgreSQL JSON value.
CREATE TABLE privacy_object_inventory_page_progress (
  deletion_request_id uuid PRIMARY KEY REFERENCES deletion_requests(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scope_kind text NOT NULL CHECK (scope_kind IN ('TENANT', 'WORKSPACE')),
  workspace_id uuid,
  export_cursor text,
  audit_cursor text,
  workload_cursor text,
  export_complete boolean NOT NULL DEFAULT false,
  audit_complete boolean NOT NULL DEFAULT false,
  workload_complete boolean NOT NULL DEFAULT false,
  export_version_count bigint NOT NULL DEFAULT 0 CHECK (export_version_count >= 0),
  audit_version_count bigint NOT NULL DEFAULT 0 CHECK (audit_version_count >= 0),
  workload_version_count bigint NOT NULL DEFAULT 0 CHECK (workload_version_count >= 0),
  workload_fenced_at timestamptz,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id),
  CHECK ((scope_kind = 'TENANT' AND workspace_id IS NULL)
    OR (scope_kind = 'WORKSPACE' AND workspace_id IS NOT NULL)),
  CHECK (completed_at IS NULL OR
    (export_complete AND audit_complete AND workload_complete))
);

-- Opaque S3 cursors are not ordered, so monotonic string comparisons cannot
-- prove progress. Persist every non-null successor and reject any revisit.
CREATE TABLE privacy_object_inventory_seen_cursors (
  deletion_request_id uuid NOT NULL REFERENCES deletion_requests(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  bucket_kind text NOT NULL
    CHECK (bucket_kind IN ('TENANT_EXPORTS', 'AUDIT_EVIDENCE', 'WORKLOAD_OBJECTS')),
  cursor text NOT NULL CHECK (length(cursor) BETWEEN 1 AND 4096),
  first_seen_at timestamptz NOT NULL,
  PRIMARY KEY (deletion_request_id, bucket_kind, cursor)
);

ALTER TABLE privacy_object_inventory_page_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_object_inventory_page_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_object_inventory_page_isolation
  ON privacy_object_inventory_page_progress
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
ALTER TABLE privacy_object_inventory_seen_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_object_inventory_seen_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_object_inventory_seen_cursor_isolation
  ON privacy_object_inventory_seen_cursors
  USING (tenant_id = aeostudio_current_tenant_id())
  WITH CHECK (tenant_id = aeostudio_current_tenant_id());
DO $inventory_owner_policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON public.privacy_object_inventory_page_progress TO %I USING (true) WITH CHECK (true)',
    current_user
  );
  EXECUTE format(
    'CREATE POLICY aeostudio_migration_owner_all_tenants ON public.privacy_object_inventory_seen_cursors TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$inventory_owner_policy$;

ALTER TABLE privacy_orphan_object_versions
  DROP CONSTRAINT privacy_orphan_object_versions_bucket_kind_check;
ALTER TABLE privacy_orphan_object_versions
  ADD CONSTRAINT privacy_orphan_object_versions_bucket_kind_check
  CHECK (bucket_kind IN ('TENANT_EXPORTS', 'AUDIT_EVIDENCE', 'WORKLOAD_OBJECTS'));

ALTER TABLE privacy_object_inventory_checkpoints
  ALTER COLUMN export_version_count TYPE bigint,
  ALTER COLUMN audit_version_count TYPE bigint;

-- An inventory-only unknown object has no trustworthy SHA-256. Preserve that
-- fact instead of manufacturing a checksum; only ACTIVE_TENANT_DATA inventory
-- orphans may carry NULL.
ALTER TABLE managed_object_versions ALTER COLUMN checksum DROP NOT NULL;
ALTER TABLE managed_object_versions
  ADD COLUMN is_delete_marker boolean NOT NULL DEFAULT false;
ALTER TABLE managed_object_versions
  ADD CONSTRAINT managed_object_delete_marker_inventory_check
  CHECK (NOT is_delete_marker OR object_ref LIKE 's3-inventory://%');
ALTER TABLE managed_object_versions
  DROP CONSTRAINT managed_object_versions_checksum_check;
ALTER TABLE managed_object_versions
  ADD CONSTRAINT managed_object_versions_checksum_check
  CHECK (checksum ~ '^[a-f0-9]{64}$'
    OR (checksum IS NULL AND object_class = 'ACTIVE_TENANT_DATA'
      AND object_ref LIKE 's3-inventory://%'));

CREATE FUNCTION reject_workload_object_claim_after_freeze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
BEGIN
  -- A lease activation includes reusing the same token after expiry and any
  -- extension of its expiry. Freeze must fence all of those transitions, not
  -- only a token change.
  IF NEW.work_lease_token IS NOT NULL
     AND NEW.work_lease_expires_at IS NOT NULL
     AND (
       OLD.work_lease_token IS NULL
       OR OLD.work_lease_expires_at IS NULL
       OR OLD.work_lease_expires_at <= database_now
       OR NEW.work_lease_expires_at > OLD.work_lease_expires_at
     ) THEN
    PERFORM 1 FROM public.tenants tenant
    WHERE tenant.id = NEW.tenant_id
    FOR SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF EXISTS (
       SELECT 1 FROM public.deletion_requests request
       WHERE request.tenant_id = NEW.tenant_id
         AND request.state IN (
           'FROZEN', 'FINALIZING', 'ACTIVE_DATA_DELETED', 'BACKUP_DELETED',
           'BLOCKED_BY_LEGAL_HOLD', 'TOMBSTONED'
         )
         AND (request.scope_kind = 'TENANT' OR request.workspace_id = NEW.workspace_id)
     ) THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER workload_object_claim_freeze_guard
BEFORE UPDATE OF work_lease_token, work_lease_expires_at ON workload_object_write_intents
FOR EACH ROW EXECUTE FUNCTION reject_workload_object_claim_after_freeze();

CREATE FUNCTION get_deletion_object_inventory_page_target(
  p_request_id uuid,
  p_lease_token uuid
)
RETURNS TABLE (
  status text, request_id uuid, tenant_id uuid, scope_kind text,
  workspace_id uuid, bucket_kind text, inventory_cursor text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  deletion_request public.deletion_requests%ROWTYPE;
  progress public.privacy_object_inventory_page_progress%ROWTYPE;
  database_now timestamptz := clock_timestamp();
BEGIN
  SELECT request.* INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id
    AND request.finalization_lease_token = p_lease_token
    AND request.finalization_lease_expires_at > database_now;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'INVALID_LEASE'::text, NULL::uuid, NULL::uuid,
      NULL::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Serialize every inventory decision with both single and batch workload
  -- claims. The deletion request already froze the scope; this row lock closes
  -- any uncommitted pre-freeze claim before inspecting its lease.
  PERFORM 1 FROM public.tenants tenant
  WHERE tenant.id = deletion_request.tenant_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.privacy_object_write_intents intent
    WHERE intent.tenant_id = deletion_request.tenant_id
      AND intent.status = 'PENDING'
      AND (deletion_request.scope_kind = 'TENANT'
        OR intent.kind = 'TENANT_EXPORT'
        OR intent.workspace_id = deletion_request.workspace_id)
  ) OR EXISTS (
    SELECT 1 FROM public.workload_object_write_intents intent
    WHERE intent.tenant_id = deletion_request.tenant_id
      AND intent.status = 'PENDING'
      AND intent.work_lease_expires_at > database_now
      AND (deletion_request.scope_kind = 'TENANT'
        OR intent.workspace_id = deletion_request.workspace_id)
  ) THEN
    RETURN QUERY SELECT 'PENDING_WRITES'::text, deletion_request.id,
      deletion_request.tenant_id, deletion_request.scope_kind,
      deletion_request.workspace_id, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.privacy_object_inventory_requirements requirement
    WHERE requirement.scope_tenant_id = deletion_request.tenant_id
  ) THEN
    RETURN QUERY SELECT 'NOT_REQUIRED'::text, deletion_request.id,
      deletion_request.tenant_id, deletion_request.scope_kind,
      deletion_request.workspace_id, NULL::text, NULL::text;
    RETURN;
  END IF;

  INSERT INTO public.privacy_object_inventory_page_progress (
    deletion_request_id, tenant_id, scope_kind, workspace_id, updated_at
  ) VALUES (
    deletion_request.id, deletion_request.tenant_id, deletion_request.scope_kind,
    deletion_request.workspace_id, database_now
  ) ON CONFLICT (deletion_request_id) DO NOTHING;

  SELECT page.* INTO progress
  FROM public.privacy_object_inventory_page_progress page
  WHERE page.deletion_request_id = deletion_request.id
  FOR UPDATE;
  IF progress.tenant_id IS DISTINCT FROM deletion_request.tenant_id
     OR progress.scope_kind IS DISTINCT FROM deletion_request.scope_kind
     OR progress.workspace_id IS DISTINCT FROM deletion_request.workspace_id THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF progress.export_complete AND progress.audit_complete AND progress.workload_complete THEN
    RETURN QUERY SELECT 'COMPLETE'::text, deletion_request.id,
      deletion_request.tenant_id, deletion_request.scope_kind,
      deletion_request.workspace_id, NULL::text, NULL::text;
  ELSIF NOT progress.export_complete THEN
    RETURN QUERY SELECT 'REQUIRED'::text, deletion_request.id,
      deletion_request.tenant_id, deletion_request.scope_kind,
      deletion_request.workspace_id, 'TENANT_EXPORTS'::text, progress.export_cursor;
  ELSIF NOT progress.audit_complete THEN
    RETURN QUERY SELECT 'REQUIRED'::text, deletion_request.id,
      deletion_request.tenant_id, deletion_request.scope_kind,
      deletion_request.workspace_id, 'AUDIT_EVIDENCE'::text, progress.audit_cursor;
  ELSE
    -- Once the privacy buckets are checkpointed, fence every expired or
    -- unleased workload intent before scanning S3. A Put already in flight may
    -- finish after its database lease expires, so persist a full remote-call
    -- drain interval and scan only after it has elapsed.
    UPDATE public.workload_object_write_intents write_intent
    SET status = 'CANCELLED', updated_at = database_now,
        work_lease_token = NULL, work_lease_expires_at = NULL,
        last_error = 'DELETION_INVENTORY_FENCED'
    WHERE write_intent.tenant_id = deletion_request.tenant_id
      AND write_intent.status = 'PENDING'
      AND (write_intent.work_lease_expires_at IS NULL
        OR write_intent.work_lease_expires_at <= database_now)
      AND (deletion_request.scope_kind = 'TENANT'
        OR write_intent.workspace_id = deletion_request.workspace_id);
    UPDATE public.workload_object_write_outbox outbox
    SET dispatched_at = database_now
    WHERE outbox.operation_id IN (
      SELECT write_intent.operation_id
      FROM public.workload_object_write_intents write_intent
      WHERE write_intent.tenant_id = deletion_request.tenant_id
        AND write_intent.status = 'CANCELLED'
        AND (deletion_request.scope_kind = 'TENANT'
          OR write_intent.workspace_id = deletion_request.workspace_id)
    );
    IF EXISTS (
      SELECT 1 FROM public.workload_object_write_intents write_intent
      WHERE write_intent.tenant_id = deletion_request.tenant_id
        AND write_intent.status = 'PENDING'
        AND (deletion_request.scope_kind = 'TENANT'
          OR write_intent.workspace_id = deletion_request.workspace_id)
    ) THEN
      RETURN QUERY SELECT 'PENDING_WRITES'::text, deletion_request.id,
        deletion_request.tenant_id, deletion_request.scope_kind,
        deletion_request.workspace_id, NULL::text, NULL::text;
      RETURN;
    END IF;
    UPDATE public.privacy_object_inventory_page_progress page
    SET workload_fenced_at = COALESCE(page.workload_fenced_at, database_now),
        updated_at = database_now
    WHERE page.deletion_request_id = deletion_request.id
    RETURNING page.* INTO progress;
    IF progress.workload_fenced_at + interval '30 seconds' > database_now THEN
      RETURN QUERY SELECT 'DRAINING_WRITES'::text, deletion_request.id,
        deletion_request.tenant_id, deletion_request.scope_kind,
        deletion_request.workspace_id, NULL::text, NULL::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'REQUIRED'::text, deletion_request.id,
      deletion_request.tenant_id, deletion_request.scope_kind,
      deletion_request.workspace_id, 'WORKLOAD_OBJECTS'::text, progress.workload_cursor;
  END IF;
END
$function$;

CREATE FUNCTION record_deletion_object_inventory_page(
  p_request_id uuid,
  p_lease_token uuid,
  p_bucket_kind text,
  p_cursor text,
  p_next_cursor text,
  p_versions jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  deletion_request public.deletion_requests%ROWTYPE;
  progress public.privacy_object_inventory_page_progress%ROWTYPE;
  database_now timestamptz := clock_timestamp();
  entry jsonb;
  inventory_object_key text;
  inventory_object_version_id text;
  inventory_workspace_id uuid;
  inventory_checksum text;
  inventory_content_type text;
  inventory_byte_length bigint;
  inventory_created_at timestamptz;
  inventory_class text;
  inventory_is_delete_marker boolean;
  intent public.workload_object_write_intents%ROWTYPE;
  page_count bigint;
  all_complete boolean;
  cursor_inserted integer;
BEGIN
  IF p_bucket_kind IS NULL
     OR p_bucket_kind NOT IN ('TENANT_EXPORTS', 'AUDIT_EVIDENCE', 'WORKLOAD_OBJECTS')
     OR p_versions IS NULL
     OR jsonb_typeof(p_versions) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_versions) > 1000
     OR (p_cursor IS NOT NULL AND length(p_cursor) NOT BETWEEN 1 AND 4096)
     OR (p_next_cursor IS NOT NULL AND length(p_next_cursor) NOT BETWEEN 1 AND 4096)
     OR (p_next_cursor IS NOT NULL AND p_next_cursor IS NOT DISTINCT FROM p_cursor) THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_PAGE_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT request.* INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id
    AND request.finalization_lease_token = p_lease_token
    AND request.finalization_lease_expires_at > database_now
    AND request.state IN ('FROZEN', 'FINALIZING');
  IF NOT FOUND THEN RETURN 'INVALID_LEASE'; END IF;

  -- Hold the same Tenant row through the page CAS and final COMPLETE decision.
  -- A workload claim can neither commit behind this check nor activate after it.
  PERFORM 1 FROM public.tenants tenant
  WHERE tenant.id = deletion_request.tenant_id
  FOR UPDATE;

  SELECT page.* INTO progress
  FROM public.privacy_object_inventory_page_progress page
  WHERE page.deletion_request_id = deletion_request.id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'INVALID_LEASE'; END IF;
  IF (p_bucket_kind = 'TENANT_EXPORTS' AND
        (progress.export_complete OR progress.export_cursor IS DISTINCT FROM p_cursor))
     OR (p_bucket_kind = 'AUDIT_EVIDENCE' AND
        (progress.audit_complete OR progress.audit_cursor IS DISTINCT FROM p_cursor))
     OR (p_bucket_kind = 'WORKLOAD_OBJECTS' AND
        (progress.workload_complete OR progress.workload_cursor IS DISTINCT FROM p_cursor)) THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_CURSOR_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF p_next_cursor IS NOT NULL THEN
    INSERT INTO public.privacy_object_inventory_seen_cursors (
      deletion_request_id, tenant_id, bucket_kind, cursor, first_seen_at
    ) VALUES (
      deletion_request.id, deletion_request.tenant_id, p_bucket_kind,
      p_next_cursor, database_now
    ) ON CONFLICT (deletion_request_id, bucket_kind, cursor) DO NOTHING;
    GET DIAGNOSTICS cursor_inserted = ROW_COUNT;
    IF cursor_inserted <> 1 THEN
      RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_CURSOR_CYCLE' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_bucket_kind = 'WORKLOAD_OBJECTS' THEN
    -- Recheck every related PENDING row inside the exact page transaction. An
    -- active lease clears the fence because its remote Put may still be running;
    -- an expired/unleased row is cancelled and starts a fresh drain interval.
    IF EXISTS (
    SELECT 1 FROM public.workload_object_write_intents write_intent
    WHERE write_intent.tenant_id = deletion_request.tenant_id
      AND write_intent.status = 'PENDING'
      AND write_intent.work_lease_expires_at > database_now
      AND (deletion_request.scope_kind = 'TENANT'
        OR write_intent.workspace_id = deletion_request.workspace_id)
    ) THEN
      UPDATE public.privacy_object_inventory_page_progress page
      SET workload_cursor = NULL, workload_complete = false,
          workload_version_count = 0, workload_fenced_at = NULL,
          completed_at = NULL, updated_at = database_now
      WHERE page.deletion_request_id = deletion_request.id;
      RETURN 'DRAINING_WRITES';
    END IF;
    IF EXISTS (
    SELECT 1 FROM public.workload_object_write_intents write_intent
    WHERE write_intent.tenant_id = deletion_request.tenant_id
      AND write_intent.status = 'PENDING'
      AND (deletion_request.scope_kind = 'TENANT'
        OR write_intent.workspace_id = deletion_request.workspace_id)
    ) THEN
      UPDATE public.workload_object_write_intents write_intent
      SET status = 'CANCELLED', updated_at = database_now,
          work_lease_token = NULL, work_lease_expires_at = NULL,
          last_error = 'DELETION_INVENTORY_FINAL_FENCE'
      WHERE write_intent.tenant_id = deletion_request.tenant_id
        AND write_intent.status = 'PENDING'
        AND (write_intent.work_lease_expires_at IS NULL
          OR write_intent.work_lease_expires_at <= database_now)
        AND (deletion_request.scope_kind = 'TENANT'
          OR write_intent.workspace_id = deletion_request.workspace_id);
      UPDATE public.workload_object_write_outbox outbox
      SET dispatched_at = database_now
      WHERE outbox.operation_id IN (
        SELECT write_intent.operation_id
        FROM public.workload_object_write_intents write_intent
        WHERE write_intent.tenant_id = deletion_request.tenant_id
          AND write_intent.status = 'CANCELLED'
          AND (deletion_request.scope_kind = 'TENANT'
            OR write_intent.workspace_id = deletion_request.workspace_id)
      );
      UPDATE public.privacy_object_inventory_page_progress page
      SET workload_cursor = NULL, workload_complete = false,
          workload_version_count = 0, workload_fenced_at = database_now,
          completed_at = NULL, updated_at = database_now
      WHERE page.deletion_request_id = deletion_request.id;
      RETURN 'DRAINING_WRITES';
    END IF;
    IF progress.workload_fenced_at IS NULL
       OR progress.workload_fenced_at + interval '30 seconds' > database_now THEN
      RETURN 'DRAINING_WRITES';
    END IF;
  END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_versions) LOOP
    inventory_object_key := entry->>'objectKey';
    inventory_object_version_id := entry->>'objectVersionId';
    inventory_is_delete_marker := COALESCE((entry->>'isDeleteMarker')::boolean, false);
    IF inventory_object_key IS NULL OR length(inventory_object_key) NOT BETWEEN 1 AND 1024
       OR inventory_object_key ~ '[[:cntrl:]]'
       OR position('..' in inventory_object_key) > 0
       OR position(chr(92) in inventory_object_key) > 0
       OR inventory_object_version_id IS NULL
       OR length(inventory_object_version_id) NOT BETWEEN 1 AND 1024 THEN
      RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH' USING ERRCODE = '22023';
    END IF;

    IF p_bucket_kind = 'TENANT_EXPORTS' THEN
      IF inventory_object_key NOT LIKE
        'tenants/' || deletion_request.tenant_id::text || '/exports/%' THEN
        RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH' USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.managed_object_versions object_version
        WHERE object_version.tenant_id = deletion_request.tenant_id
          AND object_version.object_key = inventory_object_key
          AND object_version.object_version_id = inventory_object_version_id
      ) THEN
        SELECT COALESCE(deletion_request.workspace_id,
          (SELECT workspace.id FROM public.workspaces workspace
           WHERE workspace.tenant_id = deletion_request.tenant_id
           ORDER BY workspace.created_at, workspace.id LIMIT 1))
        INTO inventory_workspace_id;
        IF inventory_workspace_id IS NULL THEN RETURN 'INVALID_LEASE'; END IF;
        INSERT INTO public.privacy_orphan_object_versions (
          deletion_request_id, bucket_kind, object_key, object_version_id,
          disposition, discovered_at
        ) VALUES (
          deletion_request.id, p_bucket_kind, inventory_object_key,
          inventory_object_version_id, 'DELETE_REQUIRED', database_now
        ) ON CONFLICT DO NOTHING;
        INSERT INTO public.managed_object_versions (
          id, tenant_id, workspace_id, object_class, object_ref, object_key,
          object_version_id, checksum, content_type, byte_length, is_delete_marker,
          lifecycle_state,
          created_at, expires_at, locked_until, deletion_request_id, deleted_at
        ) VALUES (
          gen_random_uuid(), deletion_request.tenant_id, inventory_workspace_id,
          'TENANT_EXPORT', 's3-inventory://' || encode(sha256(convert_to(
            inventory_object_key || ':' || inventory_object_version_id, 'UTF8')), 'hex'),
          inventory_object_key, inventory_object_version_id, repeat('0', 64),
          'application/octet-stream', 0, inventory_is_delete_marker, 'ACTIVE',
          COALESCE(NULLIF(entry->>'createdAt', '')::timestamptz, database_now),
          NULL, NULL, NULL, NULL
        ) ON CONFLICT (tenant_id, object_key, object_version_id) DO NOTHING;
      END IF;
    ELSIF p_bucket_kind = 'AUDIT_EVIDENCE' THEN
      IF inventory_object_key NOT LIKE
        'tenants/' || deletion_request.tenant_id::text || '/audit-digests/%' THEN
        RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH' USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.managed_object_versions object_version
        WHERE object_version.tenant_id = deletion_request.tenant_id
          AND object_version.object_key = inventory_object_key
          AND object_version.object_version_id = inventory_object_version_id
      ) THEN
        INSERT INTO public.privacy_orphan_object_versions (
          deletion_request_id, bucket_kind, object_key, object_version_id,
          disposition, discovered_at
        ) VALUES (
          deletion_request.id, p_bucket_kind, inventory_object_key,
          inventory_object_version_id, 'RETAINED_AUDIT', database_now
        ) ON CONFLICT DO NOTHING;
      END IF;
    ELSE
      IF inventory_object_key !~ ('^tenants/' || deletion_request.tenant_id::text ||
        '/workspaces/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/.+')
         OR split_part(inventory_object_key, '/', 4)
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH' USING ERRCODE = '22023';
      END IF;
      inventory_workspace_id := split_part(inventory_object_key, '/', 4)::uuid;
      IF (entry->>'workspaceId') IS NOT NULL
         AND (entry->>'workspaceId')::uuid IS DISTINCT FROM inventory_workspace_id THEN
        RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH' USING ERRCODE = '22023';
      END IF;
      IF deletion_request.scope_kind = 'WORKSPACE'
         AND inventory_workspace_id IS DISTINCT FROM deletion_request.workspace_id THEN
        RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH' USING ERRCODE = '22023';
      END IF;
      PERFORM 1 FROM public.workspaces workspace
      WHERE workspace.tenant_id = deletion_request.tenant_id
        AND workspace.id = inventory_workspace_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PRIVACY_OBJECT_INVENTORY_SCOPE_MISMATCH' USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.managed_object_versions object_version
        WHERE object_version.tenant_id = deletion_request.tenant_id
          AND object_version.object_key = inventory_object_key
          AND object_version.object_version_id = inventory_object_version_id
      ) THEN
        inventory_checksum := entry->>'checksum';
        inventory_content_type := entry->>'contentType';
        inventory_byte_length := NULLIF(entry->>'byteLength', '')::bigint;
        inventory_created_at := NULLIF(entry->>'createdAt', '')::timestamptz;
        SELECT write_intent.* INTO intent
        FROM public.workload_object_write_intents write_intent
        WHERE write_intent.tenant_id = deletion_request.tenant_id
          AND write_intent.workspace_id = inventory_workspace_id
          AND write_intent.object_key = inventory_object_key;
        IF inventory_is_delete_marker THEN
          inventory_class := 'ACTIVE_TENANT_DATA';
          inventory_checksum := NULL;
          inventory_content_type := 'application/x-s3-delete-marker';
          inventory_byte_length := 0;
          inventory_created_at := COALESCE(inventory_created_at, database_now);
        ELSIF FOUND
           AND inventory_checksum = intent.checksum
           AND inventory_content_type = intent.content_type
           AND inventory_byte_length = intent.byte_length
           AND inventory_created_at IS NOT NULL THEN
          inventory_class := intent.kind;
        ELSE
          inventory_class := 'ACTIVE_TENANT_DATA';
          inventory_checksum := NULL;
          inventory_content_type := COALESCE(inventory_content_type, 'application/octet-stream');
          inventory_byte_length := COALESCE(inventory_byte_length, 0);
          inventory_created_at := COALESCE(inventory_created_at, database_now);
        END IF;
        INSERT INTO public.privacy_orphan_object_versions (
          deletion_request_id, bucket_kind, object_key, object_version_id,
          disposition, discovered_at
        ) VALUES (
          deletion_request.id, p_bucket_kind, inventory_object_key,
          inventory_object_version_id, 'DELETE_REQUIRED', database_now
        ) ON CONFLICT DO NOTHING;
        INSERT INTO public.managed_object_versions (
          id, tenant_id, workspace_id, object_class, object_ref, object_key,
          object_version_id, checksum, content_type, byte_length, is_delete_marker,
          lifecycle_state,
          created_at, expires_at, locked_until, deletion_request_id, deleted_at
        ) VALUES (
          gen_random_uuid(), deletion_request.tenant_id, inventory_workspace_id,
          inventory_class, 's3-inventory://' || encode(sha256(convert_to(
            inventory_object_key || ':' || inventory_object_version_id, 'UTF8')), 'hex'),
          inventory_object_key, inventory_object_version_id, inventory_checksum,
          inventory_content_type, inventory_byte_length, inventory_is_delete_marker,
          'ACTIVE', inventory_created_at,
          inventory_created_at + CASE WHEN inventory_class = 'CRAWL_SNAPSHOT'
            THEN interval '180 days' ELSE interval '30 days' END,
          NULL, NULL, NULL
        ) ON CONFLICT (tenant_id, object_key, object_version_id) DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  page_count := jsonb_array_length(p_versions);
  IF p_bucket_kind = 'TENANT_EXPORTS' THEN
    UPDATE public.privacy_object_inventory_page_progress page
    SET export_cursor = p_next_cursor,
        export_complete = p_next_cursor IS NULL,
        export_version_count = page.export_version_count + page_count,
        updated_at = database_now
    WHERE page.deletion_request_id = deletion_request.id;
  ELSIF p_bucket_kind = 'AUDIT_EVIDENCE' THEN
    UPDATE public.privacy_object_inventory_page_progress page
    SET audit_cursor = p_next_cursor,
        audit_complete = p_next_cursor IS NULL,
        audit_version_count = page.audit_version_count + page_count,
        updated_at = database_now
    WHERE page.deletion_request_id = deletion_request.id;
  ELSE
    UPDATE public.privacy_object_inventory_page_progress page
    SET workload_cursor = p_next_cursor,
        workload_complete = p_next_cursor IS NULL,
        workload_version_count = page.workload_version_count + page_count,
        updated_at = database_now
    WHERE page.deletion_request_id = deletion_request.id;
  END IF;

  SELECT page.export_complete AND page.audit_complete AND page.workload_complete
  INTO all_complete
  FROM public.privacy_object_inventory_page_progress page
  WHERE page.deletion_request_id = deletion_request.id;
  IF NOT all_complete THEN RETURN 'PROGRESS'; END IF;

  -- With no active pre-freeze lease, every version is now either inventoried or
  -- absent. Retire stale metadata-only intents so they can never write later.
  UPDATE public.workload_object_write_intents write_intent
  SET status = 'CANCELLED', updated_at = database_now,
      work_lease_token = NULL, work_lease_expires_at = NULL,
      last_error = 'DELETION_INVENTORY_CANCELLED'
  WHERE write_intent.tenant_id = deletion_request.tenant_id
    AND write_intent.status = 'PENDING'
    AND (write_intent.work_lease_expires_at IS NULL
      OR write_intent.work_lease_expires_at <= database_now)
    AND (deletion_request.scope_kind = 'TENANT'
      OR write_intent.workspace_id = deletion_request.workspace_id);
  UPDATE public.workload_object_write_outbox outbox
  SET dispatched_at = database_now
  WHERE outbox.operation_id IN (
    SELECT write_intent.operation_id
    FROM public.workload_object_write_intents write_intent
    WHERE write_intent.tenant_id = deletion_request.tenant_id
      AND write_intent.status = 'CANCELLED'
      AND (deletion_request.scope_kind = 'TENANT'
        OR write_intent.workspace_id = deletion_request.workspace_id)
  );
  UPDATE public.privacy_object_inventory_page_progress page
  SET completed_at = database_now, updated_at = database_now
  WHERE page.deletion_request_id = deletion_request.id;
  INSERT INTO public.privacy_object_inventory_checkpoints (
    deletion_request_id, scanned_at, export_version_count, audit_version_count
  ) SELECT page.deletion_request_id, database_now,
      page.export_version_count, page.audit_version_count
    FROM public.privacy_object_inventory_page_progress page
    WHERE page.deletion_request_id = deletion_request.id
  ON CONFLICT (deletion_request_id) DO UPDATE
    SET scanned_at = EXCLUDED.scanned_at,
        export_version_count = EXCLUDED.export_version_count,
        audit_version_count = EXCLUDED.audit_version_count;
  RETURN 'COMPLETE';
END
$function$;

-- Propagate the exact S3 version kind to the physical-deletion boundary. A
-- DeleteMarker has no HEAD-able payload metadata but is still an independently
-- addressable version that must be deleted by its VersionId.
DROP FUNCTION list_due_deletion_object_versions(uuid, uuid, integer);
CREATE FUNCTION list_due_deletion_object_versions(
  p_request_id uuid,
  p_lease_token uuid,
  p_limit integer
)
RETURNS TABLE (
  tenant_id uuid,
  object_class text,
  object_key text,
  object_version_id text,
  legal_hold boolean,
  is_delete_marker boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
  deletion_request public.deletion_requests%ROWTYPE;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'DELETION_OBJECT_WORK_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT request.* INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id
    AND request.finalization_lease_token = p_lease_token
    AND request.finalization_lease_expires_at > database_now;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINALIZATION_LEASE_INVALID' USING ERRCODE = '42501';
  END IF;

  IF deletion_request.state = 'FROZEN'
     AND deletion_request.active_delete_by <= database_now THEN
    RETURN QUERY
    SELECT object_version.tenant_id, object_version.object_class,
      object_version.object_key, object_version.object_version_id, false,
      object_version.is_delete_marker
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
    ORDER BY object_version.object_class, object_version.object_key,
      object_version.object_version_id
    LIMIT p_limit + 1;
    RETURN;
  END IF;

  IF deletion_request.state IN ('ACTIVE_DATA_DELETED', 'BLOCKED_BY_LEGAL_HOLD')
     AND deletion_request.active_deleted_at IS NOT NULL THEN
    RETURN QUERY
    SELECT object_version.tenant_id, object_version.object_class,
      object_version.object_key, object_version.object_version_id, false,
      object_version.is_delete_marker
    FROM public.managed_object_versions object_version
    WHERE object_version.tenant_id = deletion_request.tenant_id
      AND object_version.deletion_request_id = p_request_id
      AND object_version.lifecycle_state = 'DELETE_DUE'
    ORDER BY object_version.object_class, object_version.object_key,
      object_version.object_version_id
    LIMIT p_limit + 1;
    RETURN;
  END IF;

  RAISE EXCEPTION 'FINALIZATION_LEASE_INVALID' USING ERRCODE = '42501';
END
$function$;

REVOKE ALL ON FUNCTION list_due_deletion_object_versions(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_due_deletion_object_versions(uuid, uuid, integer)
  FROM aeostudio_runtime;
GRANT EXECUTE ON FUNCTION list_due_deletion_object_versions(uuid, uuid, integer)
  TO aeostudio_lifecycle_worker;

-- Runtime deletion must use the three-prefix, page-checkpointed path.
REVOKE EXECUTE ON FUNCTION record_deletion_object_inventory(uuid, uuid, jsonb, jsonb)
  FROM aeostudio_lifecycle_worker;
REVOKE ALL ON privacy_object_inventory_page_progress,
  privacy_object_inventory_seen_cursors FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_workload_object_claim_after_freeze() FROM PUBLIC;
REVOKE ALL ON FUNCTION get_deletion_object_inventory_page_target(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_deletion_object_inventory_page(
  uuid, uuid, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_deletion_object_inventory_page_target(uuid, uuid)
  TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION record_deletion_object_inventory_page(
  uuid, uuid, text, text, text, jsonb
) TO aeostudio_lifecycle_worker;

-- Older privacy-object functions predate strict SQL NULL lease validation.
-- Keep their bodies immutable, hide them behind latest-migration wrappers, and
-- validate every worker/runtime control input before delegating.
ALTER FUNCTION claim_privacy_object_write_intent(uuid, uuid, uuid)
  RENAME TO claim_privacy_object_write_intent_legacy_impl;
REVOKE ALL ON FUNCTION claim_privacy_object_write_intent_legacy_impl(uuid, uuid, uuid)
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker;
CREATE FUNCTION claim_privacy_object_write_intent(
  p_operation_id uuid,
  p_tenant_id uuid,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_WRITE_LEASE_TOKEN_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN public.claim_privacy_object_write_intent_legacy_impl(
    p_operation_id, p_tenant_id, p_lease_token
  );
END
$function$;
REVOKE ALL ON FUNCTION claim_privacy_object_write_intent(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_privacy_object_write_intent(uuid, uuid, uuid)
  TO aeostudio_runtime;

ALTER FUNCTION claim_pending_privacy_object_write_intents(uuid, integer)
  RENAME TO claim_pending_privacy_object_write_intents_legacy_impl;
REVOKE ALL ON FUNCTION claim_pending_privacy_object_write_intents_legacy_impl(uuid, integer)
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker;
CREATE FUNCTION claim_pending_privacy_object_write_intents(
  p_lease_token uuid,
  p_limit integer
)
RETURNS TABLE (
  operation_id uuid,
  kind text,
  tenant_id uuid,
  workspace_id uuid,
  object_key text,
  canonical_payload bytea,
  checksum text,
  content_type text,
  locked_until timestamptz,
  sealed_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_lease_token IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_WRITE_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT *
  FROM public.claim_pending_privacy_object_write_intents_legacy_impl(
    p_lease_token, p_limit
  );
END
$function$;
REVOKE ALL ON FUNCTION claim_pending_privacy_object_write_intents(uuid, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_pending_privacy_object_write_intents(uuid, integer)
  TO aeostudio_lifecycle_worker;

ALTER FUNCTION complete_privacy_object_write_intent(
  uuid, uuid, text, text, text, text, text, bigint, timestamptz, timestamptz
) RENAME TO complete_privacy_object_write_intent_legacy_impl;
REVOKE ALL ON FUNCTION complete_privacy_object_write_intent_legacy_impl(
  uuid, uuid, text, text, text, text, text, bigint, timestamptz, timestamptz
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker;
CREATE FUNCTION complete_privacy_object_write_intent(
  p_operation_id uuid,
  p_lease_token uuid,
  p_object_ref text,
  p_object_key text,
  p_object_version_id text,
  p_checksum text,
  p_content_type text,
  p_byte_length bigint,
  p_object_created_at timestamptz,
  p_locked_until timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_lease_token IS NULL THEN RETURN false; END IF;
  RETURN public.complete_privacy_object_write_intent_legacy_impl(
    p_operation_id, p_lease_token, p_object_ref, p_object_key,
    p_object_version_id, p_checksum, p_content_type, p_byte_length,
    p_object_created_at, p_locked_until
  );
END
$function$;
REVOKE ALL ON FUNCTION complete_privacy_object_write_intent(
  uuid, uuid, text, text, text, text, text, bigint, timestamptz, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_privacy_object_write_intent(
  uuid, uuid, text, text, text, text, text, bigint, timestamptz, timestamptz
) TO aeostudio_runtime, aeostudio_lifecycle_worker;

ALTER FUNCTION claim_due_deletion_requests(uuid, integer)
  RENAME TO claim_due_deletion_requests_legacy_impl;
REVOKE ALL ON FUNCTION claim_due_deletion_requests_legacy_impl(uuid, integer)
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker;
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
BEGIN
  IF p_lease_token IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'DELETION_WORK_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT *
  FROM public.claim_due_deletion_requests_legacy_impl(p_lease_token, p_limit);
END
$function$;
REVOKE ALL ON FUNCTION claim_due_deletion_requests(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_deletion_requests(uuid, integer)
  TO aeostudio_lifecycle_worker;

ALTER FUNCTION claim_due_secret_deletions(uuid, integer)
  RENAME TO claim_due_secret_deletions_legacy_impl;
REVOKE ALL ON FUNCTION claim_due_secret_deletions_legacy_impl(uuid, integer)
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker;
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
BEGIN
  IF p_lease_token IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'SECRET_DELETION_WORK_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT *
  FROM public.claim_due_secret_deletions_legacy_impl(p_lease_token, p_limit);
END
$function$;
REVOKE ALL ON FUNCTION claim_due_secret_deletions(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_secret_deletions(uuid, integer)
  TO aeostudio_lifecycle_worker;

ALTER FUNCTION claim_pending_legal_hold_reconciliations(uuid, integer)
  RENAME TO claim_pending_legal_hold_reconciliations_legacy_impl;
REVOKE ALL ON FUNCTION claim_pending_legal_hold_reconciliations_legacy_impl(uuid, integer)
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker;
CREATE FUNCTION claim_pending_legal_hold_reconciliations(
  p_lease_token uuid,
  p_limit integer
)
RETURNS TABLE (
  tenant_id uuid,
  object_class text,
  object_key text,
  object_version_id text,
  desired_status text,
  desired_revision bigint,
  lease_token uuid,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_lease_token IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'LEGAL_HOLD_RECONCILIATION_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT *
  FROM public.claim_pending_legal_hold_reconciliations_legacy_impl(
    p_lease_token, p_limit
  );
END
$function$;
REVOKE ALL ON FUNCTION claim_pending_legal_hold_reconciliations(uuid, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_pending_legal_hold_reconciliations(uuid, integer)
  TO aeostudio_lifecycle_worker;

ALTER FUNCTION finalize_deletion(uuid, uuid, timestamptz, uuid, uuid)
  RENAME TO finalize_deletion_legacy_impl;
REVOKE ALL ON FUNCTION finalize_deletion_legacy_impl(
  uuid, uuid, timestamptz, uuid, uuid
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker;
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
  stored_lease_token uuid;
BEGIN
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION 'DELETION_FINALIZATION_LEASE_INVALID' USING ERRCODE = '42501';
  END IF;
  SELECT request.finalization_lease_token INTO stored_lease_token
  FROM public.deletion_requests request
  WHERE request.id = p_request_id;
  IF FOUND AND stored_lease_token IS NULL THEN
    RAISE EXCEPTION 'DELETION_FINALIZATION_LEASE_INVALID' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.finalize_deletion_legacy_impl(
    p_request_id, p_lease_token, p_effective_at, p_tombstone_id, p_audit_event_id
  );
END
$function$;
REVOKE ALL ON FUNCTION finalize_deletion(uuid, uuid, timestamptz, uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finalize_deletion(uuid, uuid, timestamptz, uuid, uuid)
  TO aeostudio_lifecycle_worker;

ALTER FUNCTION get_backup_deletion_verification_target(uuid, uuid)
  RENAME TO get_backup_deletion_verification_target_legacy_impl;
REVOKE ALL ON FUNCTION get_backup_deletion_verification_target_legacy_impl(uuid, uuid)
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker;
CREATE FUNCTION get_backup_deletion_verification_target(
  p_request_id uuid,
  p_lease_token uuid
)
RETURNS TABLE (request_id uuid, source_deleted_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  stored_lease_token uuid;
BEGIN
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION 'DELETION_FINALIZATION_LEASE_INVALID' USING ERRCODE = '42501';
  END IF;
  SELECT request.finalization_lease_token INTO stored_lease_token
  FROM public.deletion_requests request
  WHERE request.id = p_request_id;
  IF FOUND AND stored_lease_token IS NULL THEN
    RAISE EXCEPTION 'DELETION_FINALIZATION_LEASE_INVALID' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT *
  FROM public.get_backup_deletion_verification_target_legacy_impl(
    p_request_id, p_lease_token
  );
END
$function$;
REVOKE ALL ON FUNCTION get_backup_deletion_verification_target(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_backup_deletion_verification_target(uuid, uuid)
  TO aeostudio_lifecycle_worker;

ALTER FUNCTION record_backup_deletion_verification(
  uuid, uuid, timestamptz, timestamptz, text, text
) RENAME TO record_backup_deletion_verification_legacy_impl;
REVOKE ALL ON FUNCTION record_backup_deletion_verification_legacy_impl(
  uuid, uuid, timestamptz, timestamptz, text, text
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker;
CREATE FUNCTION record_backup_deletion_verification(
  p_request_id uuid,
  p_lease_token uuid,
  p_source_deleted_at timestamptz,
  p_verified_at timestamptz,
  p_evidence_canonical_json text,
  p_evidence_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  stored_lease_token uuid;
BEGIN
  IF p_lease_token IS NULL THEN RETURN false; END IF;
  SELECT request.finalization_lease_token INTO stored_lease_token
  FROM public.deletion_requests request
  WHERE request.id = p_request_id;
  IF FOUND AND stored_lease_token IS NULL THEN RETURN false; END IF;
  RETURN public.record_backup_deletion_verification_legacy_impl(
    p_request_id, p_lease_token, p_source_deleted_at, p_verified_at,
    p_evidence_canonical_json, p_evidence_hash
  );
END
$function$;
REVOKE ALL ON FUNCTION record_backup_deletion_verification(
  uuid, uuid, timestamptz, timestamptz, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_backup_deletion_verification(
  uuid, uuid, timestamptz, timestamptz, text, text
) TO aeostudio_lifecycle_worker;
