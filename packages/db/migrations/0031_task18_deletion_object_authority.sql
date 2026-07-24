-- Carry the deletion request's exact database-selected scope and the managed
-- ledger's metadata trust decision to the lifecycle worker. Object keys remain
-- selectors and are never used by the worker to derive Broker authority.
ALTER TABLE public.managed_object_versions
  ADD COLUMN storage_class text;
ALTER TABLE public.managed_object_versions
  ADD CONSTRAINT managed_object_storage_class_check
  CHECK (storage_class IN (
    'TENANT_EXPORTS', 'AUDIT_EVIDENCE', 'WORKLOAD_OBJECTS'
  ));

-- Existing canonical rows can be classified by the pre-0031 placement helper,
-- which cross-checks class, workspace, and key. Ambiguous historical rows stop
-- the migration instead of silently acquiring a bucket authority.
ALTER TABLE public.managed_object_versions
  DISABLE TRIGGER managed_object_lifecycle_transition_guard;
UPDATE public.managed_object_versions object_version
SET storage_class =
  public.tenant_data_managed_object_storage_class_private(object_version)
WHERE object_version.storage_class IS NULL;
ALTER TABLE public.managed_object_versions
  ENABLE TRIGGER managed_object_lifecycle_transition_guard;

DO $storage_class_backfill$
DECLARE
  ambiguous_count bigint;
BEGIN
  SELECT count(*) INTO ambiguous_count
  FROM public.managed_object_versions object_version
  WHERE object_version.storage_class IS NULL;
  IF ambiguous_count <> 0 THEN
    RAISE EXCEPTION
      'MANAGED_OBJECT_STORAGE_CLASS_BACKFILL_REQUIRED:%',
      ambiguous_count
      USING ERRCODE = '23514';
  END IF;
END
$storage_class_backfill$;

ALTER TABLE public.managed_object_versions
  ALTER COLUMN storage_class SET NOT NULL;

CREATE FUNCTION public.assign_managed_object_storage_class()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.storage_class IS NULL THEN
    NEW.storage_class := CASE
      WHEN NEW.object_class IN (
        'CRAWL_SNAPSHOT', 'ARTIFACT_PAYLOAD', 'CHANNEL_PACKAGE'
      ) THEN 'WORKLOAD_OBJECTS'
      WHEN NEW.object_class = 'ACTIVE_TENANT_DATA'
        AND NEW.object_ref LIKE 's3-inventory://%'
        THEN 'WORKLOAD_OBJECTS'
      WHEN NEW.object_class = 'TENANT_EXPORT' THEN 'TENANT_EXPORTS'
      WHEN NEW.object_class = 'AUDIT_DIGEST' THEN 'AUDIT_EVIDENCE'
      ELSE NULL
    END;
  END IF;

  IF NEW.storage_class = 'WORKLOAD_OBJECTS' THEN
    IF NEW.object_class NOT IN (
         'ACTIVE_TENANT_DATA', 'BACKUP_COPY', 'RAW_PROMPT_RESPONSE',
         'CRAWL_SNAPSHOT', 'SCREENSHOT', 'APPLICATION_LOG',
         'ARTIFACT_PAYLOAD', 'CHANNEL_PACKAGE', 'EVIDENCE_SNAPSHOT'
       ) THEN
      RAISE EXCEPTION 'MANAGED_OBJECT_WORKLOAD_CLASS_INVALID'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.workspace_id IS NULL
       OR NEW.object_key NOT LIKE
         'tenants/' || NEW.tenant_id::text || '/workspaces/' ||
         NEW.workspace_id::text || '/%' THEN
      RAISE EXCEPTION 'MANAGED_OBJECT_WORKLOAD_PLACEMENT_INVALID'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.storage_class = 'TENANT_EXPORTS' THEN
    IF NEW.object_class <> 'TENANT_EXPORT'
       OR NEW.object_key NOT LIKE
         'tenants/' || NEW.tenant_id::text || '/exports/%' THEN
      RAISE EXCEPTION 'MANAGED_OBJECT_EXPORT_PLACEMENT_INVALID'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.storage_class = 'AUDIT_EVIDENCE' THEN
    IF NEW.object_class <> 'AUDIT_DIGEST'
       OR NEW.object_key NOT LIKE
         'tenants/' || NEW.tenant_id::text || '/audit-digests/%' THEN
      RAISE EXCEPTION 'MANAGED_OBJECT_AUDIT_PLACEMENT_INVALID'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'MANAGED_OBJECT_STORAGE_CLASS_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER managed_object_storage_class_insert_guard
BEFORE INSERT ON public.managed_object_versions
FOR EACH ROW EXECUTE FUNCTION public.assign_managed_object_storage_class();

CREATE FUNCTION public.reject_managed_object_storage_class_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.storage_class IS DISTINCT FROM OLD.storage_class THEN
    RAISE EXCEPTION 'MANAGED_OBJECT_STORAGE_CLASS_IMMUTABLE'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER managed_object_storage_class_update_guard
BEFORE UPDATE OF storage_class ON public.managed_object_versions
FOR EACH ROW EXECUTE FUNCTION public.reject_managed_object_storage_class_update();

CREATE OR REPLACE FUNCTION public.tenant_data_managed_object_storage_class_private(
  p_object public.managed_object_versions
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT p_object.storage_class
$function$;

REVOKE ALL ON FUNCTION public.assign_managed_object_storage_class()
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION public.reject_managed_object_storage_class_update()
  FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
    aeostudio_tenant_data_broker;
REVOKE ALL ON FUNCTION public.tenant_data_managed_object_storage_class_private(
  public.managed_object_versions
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;

DROP FUNCTION public.list_due_deletion_object_versions(uuid, uuid, integer);

CREATE FUNCTION public.list_due_deletion_object_versions(
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
  is_delete_marker boolean,
  scope_kind text,
  workspace_id uuid,
  storage_class text,
  head_eligible boolean
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
      object_version.is_delete_marker,
      CASE WHEN authority.storage_class = 'WORKLOAD_OBJECTS'
        THEN deletion_request.scope_kind ELSE 'TENANT' END,
      CASE
        WHEN authority.storage_class = 'WORKLOAD_OBJECTS'
          AND deletion_request.scope_kind = 'WORKSPACE'
          THEN deletion_request.workspace_id
        ELSE NULL
      END,
      authority.storage_class,
      COALESCE(
        NOT object_version.is_delete_marker
          AND object_version.checksum ~ '^[a-f0-9]{64}$'
          AND object_version.byte_length BETWEEN 1 AND 2147483648
          AND object_version.content_type IS NOT NULL
          AND length(object_version.content_type) BETWEEN 3 AND 255
          AND object_version.content_type ~
            '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(;[ -~]+)?$',
        false
      )
    FROM public.managed_object_versions object_version
    CROSS JOIN LATERAL (
      SELECT public.tenant_data_managed_object_storage_class_private(
        object_version
      ) AS storage_class
    ) authority
    WHERE object_version.tenant_id = deletion_request.tenant_id
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
      object_version.is_delete_marker,
      CASE WHEN authority.storage_class = 'WORKLOAD_OBJECTS'
        THEN deletion_request.scope_kind ELSE 'TENANT' END,
      CASE
        WHEN authority.storage_class = 'WORKLOAD_OBJECTS'
          AND deletion_request.scope_kind = 'WORKSPACE'
          THEN deletion_request.workspace_id
        ELSE NULL
      END,
      authority.storage_class,
      COALESCE(
        NOT object_version.is_delete_marker
          AND object_version.checksum ~ '^[a-f0-9]{64}$'
          AND object_version.byte_length BETWEEN 1 AND 2147483648
          AND object_version.content_type IS NOT NULL
          AND length(object_version.content_type) BETWEEN 3 AND 255
          AND object_version.content_type ~
            '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(;[ -~]+)?$',
        false
      )
    FROM public.managed_object_versions object_version
    CROSS JOIN LATERAL (
      SELECT public.tenant_data_managed_object_storage_class_private(
        object_version
      ) AS storage_class
    ) authority
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

REVOKE ALL ON FUNCTION public.list_due_deletion_object_versions(
  uuid, uuid, integer
) FROM PUBLIC, aeostudio_runtime;
GRANT EXECUTE ON FUNCTION public.list_due_deletion_object_versions(
  uuid, uuid, integer
) TO aeostudio_lifecycle_worker;
