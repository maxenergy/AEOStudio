CREATE FUNCTION aeostudio_backup_evidence_canonical_json(value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
DECLARE
  value_kind text := jsonb_typeof(value);
  result text;
  entry record;
  first_entry boolean := true;
BEGIN
  IF value_kind = 'number' THEN
    RETURN public.aeostudio_canonical_number(value);
  END IF;
  IF value_kind IN ('null', 'string', 'boolean') THEN
    RETURN value::text;
  END IF;
  IF value_kind = 'array' THEN
    result := '[';
    FOR entry IN
      SELECT item
      FROM jsonb_array_elements(value) WITH ORDINALITY AS items(item, ordinal)
      ORDER BY ordinal
    LOOP
      IF NOT first_entry THEN result := result || ','; END IF;
      result := result || public.aeostudio_backup_evidence_canonical_json(entry.item);
      first_entry := false;
    END LOOP;
    RETURN result || ']';
  END IF;
  IF value_kind = 'object' THEN
    result := '{';
    FOR entry IN
      SELECT key, item
      FROM jsonb_each(value) AS items(key, item)
      ORDER BY public.aeostudio_utf16_code_units(key)
    LOOP
      IF NOT first_entry THEN result := result || ','; END IF;
      result := result || to_jsonb(entry.key)::text || ':'
        || public.aeostudio_backup_evidence_canonical_json(entry.item);
      first_entry := false;
    END LOOP;
    RETURN result || '}';
  END IF;
  RAISE EXCEPTION 'BACKUP_EVIDENCE_CANONICAL_JSON_INVALID' USING ERRCODE = 'P0001';
END
$function$;

ALTER TABLE deletion_requests
  ADD COLUMN backup_verification_source_deleted_at timestamptz,
  ADD COLUMN backup_verified_at timestamptz,
  ADD COLUMN backup_evidence_hash text CHECK (
    backup_evidence_hash IS NULL OR backup_evidence_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN backup_evidence_canonical_json text CHECK (
    backup_evidence_canonical_json IS NULL
    OR octet_length(backup_evidence_canonical_json) BETWEEN 2 AND 1048576
  ),
  ADD COLUMN backup_verification_lease_token uuid,
  ADD CONSTRAINT deletion_requests_backup_verification_complete CHECK (
    (backup_verification_source_deleted_at IS NULL
      AND backup_verified_at IS NULL
      AND backup_evidence_hash IS NULL
      AND backup_evidence_canonical_json IS NULL
      AND backup_verification_lease_token IS NULL)
    OR
    (backup_verification_source_deleted_at IS NOT NULL
      AND backup_verified_at IS NOT NULL
      AND backup_evidence_hash IS NOT NULL
      AND backup_evidence_canonical_json IS NOT NULL
      AND backup_verification_lease_token IS NOT NULL
      AND backup_verified_at >= backup_verification_source_deleted_at)
  );

ALTER TABLE deletion_tombstones
  ADD COLUMN evidence_verified_at timestamptz,
  ADD COLUMN evidence_source_deleted_at timestamptz,
  ADD COLUMN evidence_canonical_json text CHECK (
    evidence_canonical_json IS NULL
    OR octet_length(evidence_canonical_json) BETWEEN 2 AND 1048576
  );

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
  deletion_request public.deletion_requests%ROWTYPE;
  database_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id
  FOR UPDATE;

  IF deletion_request.id IS NULL
     OR deletion_request.finalization_lease_token IS DISTINCT FROM p_lease_token
     OR deletion_request.finalization_lease_expires_at IS NULL
     OR deletion_request.finalization_lease_expires_at <= database_now THEN
    RAISE EXCEPTION 'DELETION_FINALIZATION_LEASE_INVALID' USING ERRCODE = '42501';
  END IF;
  IF deletion_request.state NOT IN ('ACTIVE_DATA_DELETED', 'BLOCKED_BY_LEGAL_HOLD')
     OR deletion_request.active_deleted_at IS NULL
     OR deletion_request.backup_delete_by > database_now THEN
    RAISE EXCEPTION 'DELETION_BACKUP_NOT_DUE' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT deletion_request.id,
    date_trunc('milliseconds', deletion_request.active_deleted_at);
END
$function$;

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
  deletion_request public.deletion_requests%ROWTYPE;
  database_now timestamptz := clock_timestamp();
  parsed_evidence jsonb;
  canonical_evidence text;
  parsed_source_deleted_at timestamptz;
  parsed_verified_at timestamptz;
BEGIN
  SELECT * INTO deletion_request
  FROM public.deletion_requests request
  WHERE request.id = p_request_id
  FOR UPDATE;

  IF deletion_request.id IS NULL
     OR deletion_request.finalization_lease_token IS DISTINCT FROM p_lease_token
     OR deletion_request.finalization_lease_expires_at IS NULL
     OR deletion_request.finalization_lease_expires_at <= database_now THEN
    RETURN false;
  END IF;
  IF p_evidence_canonical_json IS NULL
     OR octet_length(p_evidence_canonical_json) NOT BETWEEN 2 AND 1048576
     OR p_evidence_hash !~ '^[a-f0-9]{64}$'
     OR encode(sha256(convert_to(p_evidence_canonical_json, 'UTF8')), 'hex')
       IS DISTINCT FROM p_evidence_hash THEN
    RETURN false;
  END IF;
  BEGIN
    parsed_evidence := p_evidence_canonical_json::jsonb;
    canonical_evidence := public.aeostudio_backup_evidence_canonical_json(parsed_evidence);
    parsed_source_deleted_at := (parsed_evidence ->> 'sourceDeletedAt')::timestamptz;
    parsed_verified_at := (parsed_evidence ->> 'verifiedAt')::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  IF deletion_request.state NOT IN ('ACTIVE_DATA_DELETED', 'BLOCKED_BY_LEGAL_HOLD')
     OR deletion_request.active_deleted_at IS NULL
     OR deletion_request.backup_delete_by > database_now
     OR p_source_deleted_at IS DISTINCT FROM
       date_trunc('milliseconds', deletion_request.active_deleted_at)
     OR p_verified_at < p_source_deleted_at
     OR p_verified_at > database_now
     OR p_verified_at < database_now - interval '5 minutes'
     OR jsonb_typeof(parsed_evidence) <> 'object'
     OR canonical_evidence IS DISTINCT FROM p_evidence_canonical_json
     OR parsed_evidence ->> 'inventoryMethod'
       IS DISTINCT FROM 'ListRecoveryPointsByResource'
     OR parsed_evidence -> 'managedByAWSBackupOnly' IS DISTINCT FROM 'false'::jsonb
     OR parsed_evidence ->> 'requestId' IS DISTINCT FROM lower(p_request_id::text)
     OR parsed_evidence ->> 'schemaVersion' IS DISTINCT FROM '2.0.0'
     OR parsed_source_deleted_at IS DISTINCT FROM p_source_deleted_at
     OR parsed_verified_at IS DISTINCT FROM p_verified_at THEN
    RETURN false;
  END IF;

  UPDATE public.deletion_requests request
  SET backup_verification_source_deleted_at = p_source_deleted_at,
      backup_verified_at = p_verified_at,
      backup_evidence_hash = p_evidence_hash,
      backup_evidence_canonical_json = p_evidence_canonical_json,
      backup_verification_lease_token = p_lease_token
  WHERE request.id = deletion_request.id;
  RETURN true;
END
$function$;

CREATE FUNCTION guard_backup_deletion_verification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  parsed_evidence jsonb;
BEGIN
  IF NEW.state = 'BACKUP_DELETED' AND OLD.state <> 'BACKUP_DELETED' THEN
    BEGIN
      parsed_evidence := OLD.backup_evidence_canonical_json::jsonb;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'BACKUP_RECOVERY_POINT_PROOF_REQUIRED' USING ERRCODE = 'P0001';
    END;
    IF OLD.finalization_lease_token IS NULL
       OR OLD.backup_verification_lease_token IS DISTINCT FROM OLD.finalization_lease_token
       OR OLD.backup_verification_source_deleted_at IS DISTINCT FROM
         date_trunc('milliseconds', OLD.active_deleted_at)
       OR OLD.backup_verified_at IS NULL
       OR OLD.backup_verified_at < clock_timestamp() - interval '5 minutes'
       OR OLD.backup_evidence_hash !~ '^[a-f0-9]{64}$'
       OR OLD.backup_evidence_canonical_json IS NULL
       OR encode(sha256(convert_to(OLD.backup_evidence_canonical_json, 'UTF8')), 'hex')
         IS DISTINCT FROM OLD.backup_evidence_hash
       OR public.aeostudio_backup_evidence_canonical_json(parsed_evidence)
         IS DISTINCT FROM OLD.backup_evidence_canonical_json
       OR parsed_evidence ->> 'inventoryMethod'
         IS DISTINCT FROM 'ListRecoveryPointsByResource'
       OR parsed_evidence -> 'managedByAWSBackupOnly' IS DISTINCT FROM 'false'::jsonb
       OR parsed_evidence ->> 'requestId' IS DISTINCT FROM lower(OLD.id::text)
       OR parsed_evidence ->> 'schemaVersion' IS DISTINCT FROM '2.0.0'
       OR (parsed_evidence ->> 'sourceDeletedAt')::timestamptz
         IS DISTINCT FROM OLD.backup_verification_source_deleted_at
       OR (parsed_evidence ->> 'verifiedAt')::timestamptz
         IS DISTINCT FROM OLD.backup_verified_at THEN
      RAISE EXCEPTION 'BACKUP_RECOVERY_POINT_PROOF_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER deletion_request_backup_verification_guard
BEFORE UPDATE OF state ON deletion_requests
FOR EACH ROW EXECUTE FUNCTION guard_backup_deletion_verification();

CREATE FUNCTION bind_backup_deletion_tombstone_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  proof public.deletion_requests%ROWTYPE;
  parsed_evidence jsonb;
BEGIN
  IF NEW.plane <> 'BACKUP' OR NEW.status <> 'COMPLETED' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO proof
  FROM public.deletion_requests request
  WHERE request.tenant_id = NEW.tenant_id
    AND request.id = NEW.deletion_request_id;
  BEGIN
    parsed_evidence := proof.backup_evidence_canonical_json::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'BACKUP_RECOVERY_POINT_PROOF_REQUIRED' USING ERRCODE = 'P0001';
  END;
  IF proof.id IS NULL
     OR proof.state <> 'BACKUP_DELETED'
     OR proof.backup_verification_source_deleted_at IS DISTINCT FROM
       date_trunc('milliseconds', proof.active_deleted_at)
     OR proof.backup_verified_at IS NULL
     OR proof.backup_evidence_hash !~ '^[a-f0-9]{64}$'
     OR proof.backup_evidence_canonical_json IS NULL
     OR encode(sha256(convert_to(proof.backup_evidence_canonical_json, 'UTF8')), 'hex')
       IS DISTINCT FROM proof.backup_evidence_hash
     OR public.aeostudio_backup_evidence_canonical_json(parsed_evidence)
       IS DISTINCT FROM proof.backup_evidence_canonical_json
     OR parsed_evidence ->> 'inventoryMethod'
       IS DISTINCT FROM 'ListRecoveryPointsByResource'
     OR parsed_evidence -> 'managedByAWSBackupOnly' IS DISTINCT FROM 'false'::jsonb
     OR parsed_evidence ->> 'requestId' IS DISTINCT FROM lower(proof.id::text)
     OR parsed_evidence ->> 'schemaVersion' IS DISTINCT FROM '2.0.0'
     OR (parsed_evidence ->> 'sourceDeletedAt')::timestamptz
       IS DISTINCT FROM proof.backup_verification_source_deleted_at
     OR (parsed_evidence ->> 'verifiedAt')::timestamptz
       IS DISTINCT FROM proof.backup_verified_at THEN
    RAISE EXCEPTION 'BACKUP_RECOVERY_POINT_PROOF_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  NEW.evidence_hash := proof.backup_evidence_hash;
  NEW.evidence_verified_at := proof.backup_verified_at;
  NEW.evidence_source_deleted_at := proof.backup_verification_source_deleted_at;
  NEW.evidence_canonical_json := proof.backup_evidence_canonical_json;
  RETURN NEW;
END
$function$;

CREATE TRIGGER deletion_tombstone_backup_evidence_binding
BEFORE INSERT ON deletion_tombstones
FOR EACH ROW EXECUTE FUNCTION bind_backup_deletion_tombstone_evidence();

REVOKE ALL ON FUNCTION get_backup_deletion_verification_target(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION aeostudio_backup_evidence_canonical_json(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_backup_deletion_verification(
  uuid, uuid, timestamptz, timestamptz, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_backup_deletion_verification_target(uuid, uuid)
  FROM aeostudio_runtime;
REVOKE ALL ON FUNCTION record_backup_deletion_verification(
  uuid, uuid, timestamptz, timestamptz, text, text
) FROM aeostudio_runtime;
GRANT EXECUTE ON FUNCTION get_backup_deletion_verification_target(uuid, uuid)
  TO aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION record_backup_deletion_verification(
  uuid, uuid, timestamptz, timestamptz, text, text
) TO aeostudio_lifecycle_worker;
