-- Task 18: a permanently failing privacy-object write must not monopolize the
-- oldest page of the durable outbox. Releasing an exact lease atomically moves
-- that operation behind currently available work.
CREATE OR REPLACE FUNCTION release_privacy_object_write_intent_lease(
  p_operation_id uuid,
  p_lease_token uuid,
  p_error text DEFAULT NULL
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
  IF p_operation_id IS NULL OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_WRITE_RELEASE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE public.privacy_object_write_intents intent
  SET work_lease_token = NULL,
      work_lease_expires_at = NULL,
      updated_at = database_now,
      last_error = CASE
        WHEN p_error IS NULL THEN intent.last_error
        ELSE left(p_error, 500)
      END
  WHERE intent.operation_id = p_operation_id
    AND intent.status = 'PENDING'
    AND intent.work_lease_token = p_lease_token;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 0 THEN
    RETURN false;
  END IF;

  UPDATE public.privacy_object_write_outbox outbox
  SET available_at = GREATEST(
    outbox.available_at,
    database_now + interval '30 seconds'
  )
  WHERE outbox.operation_id = p_operation_id
    AND outbox.dispatched_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_WRITE_OUTBOX_INVARIANT_VIOLATION'
      USING ERRCODE = '23514';
  END IF;

  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION release_privacy_object_write_intent_lease(uuid, uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_privacy_object_write_intent_lease(uuid, uuid, text)
  TO aeostudio_runtime, aeostudio_lifecycle_worker;
