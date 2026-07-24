-- Task 18: narrow production archive completion boundary. The runtime role
-- remains unable to update tenant_exports directly; this function can only
-- transition its current Tenant's pending export to one exact stored version.
CREATE FUNCTION complete_tenant_export_archive(
  p_tenant_id uuid,
  p_export_id uuid,
  p_object_ref text,
  p_object_key text,
  p_object_version_id text,
  p_checksum text,
  p_content_type text,
  p_byte_length bigint,
  p_created_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  export_record public.tenant_exports%ROWTYPE;
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid
       IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_EXPORT_CONTEXT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF p_object_ref IS NULL OR length(p_object_ref) NOT BETWEEN 1 AND 2048
     OR p_object_key IS NULL
     OR p_object_key NOT LIKE 'tenants/' || p_tenant_id::text || '/exports/%'
     OR length(p_object_key) NOT BETWEEN 1 AND 2048
     OR p_object_version_id IS NULL
     OR length(p_object_version_id) NOT BETWEEN 1 AND 1024
     OR p_checksum !~ '^[a-f0-9]{64}$'
     OR p_content_type IS NULL OR length(btrim(p_content_type)) NOT BETWEEN 1 AND 255
     OR p_byte_length < 0 OR p_created_at IS NULL THEN
    RAISE EXCEPTION 'TENANT_EXPORT_ARCHIVE_METADATA_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO export_record
  FROM public.tenant_exports export
  WHERE export.tenant_id = p_tenant_id AND export.id = p_export_id
  FOR UPDATE;
  IF NOT FOUND OR export_record.status <> 'ARCHIVE_PENDING'
     OR p_created_at < export_record.requested_at THEN
    RETURN false;
  END IF;

  UPDATE public.tenant_exports
  SET status = 'ARCHIVE_READY', object_ref = p_object_ref,
    object_version_id = p_object_version_id, object_checksum = p_checksum,
    completed_at = p_created_at
  WHERE tenant_id = p_tenant_id AND id = p_export_id;

  INSERT INTO public.managed_object_versions (
    id, tenant_id, workspace_id, object_class, object_ref, object_key,
    object_version_id, checksum, content_type, byte_length, lifecycle_state,
    created_at, expires_at, locked_until, deletion_request_id, deleted_at
  ) VALUES (
    p_export_id, p_tenant_id, export_record.workspace_id, 'TENANT_EXPORT',
    p_object_ref, p_object_key, p_object_version_id, p_checksum, p_content_type,
    p_byte_length, 'ACTIVE', p_created_at, NULL, NULL, NULL, NULL
  );
  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION complete_tenant_export_archive(
  uuid, uuid, text, text, text, text, text, bigint, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_tenant_export_archive(
  uuid, uuid, text, text, text, text, text, bigint, timestamptz
) TO aeostudio_runtime;
