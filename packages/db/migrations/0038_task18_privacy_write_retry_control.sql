-- Task 18: background poison work receives a bounded retry delay, while a
-- foreground Put whose database acknowledgement failed remains immediately
-- recoverable from its durable immutable payload.
CREATE FUNCTION public.release_privacy_object_write_intent_lease(
  p_operation_id uuid,
  p_lease_token uuid,
  p_error text,
  p_retry_delay_seconds integer
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
  IF p_operation_id IS NULL
     OR p_lease_token IS NULL
     OR p_retry_delay_seconds IS NULL
     OR p_retry_delay_seconds NOT BETWEEN 0 AND 300 THEN
    RAISE EXCEPTION 'PRIVACY_OBJECT_WRITE_RELEASE_INPUT_INVALID'
      USING ERRCODE = '22023';
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
  SET available_at = CASE
    WHEN p_retry_delay_seconds = 0 THEN outbox.available_at
    ELSE GREATEST(
      outbox.available_at,
      database_now + make_interval(secs => p_retry_delay_seconds)
    )
  END
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

CREATE OR REPLACE FUNCTION public.release_privacy_object_write_intent_lease(
  p_operation_id uuid,
  p_lease_token uuid,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT public.release_privacy_object_write_intent_lease(
    p_operation_id,
    p_lease_token,
    p_error,
    0
  )
$function$;

REVOKE ALL ON FUNCTION public.release_privacy_object_write_intent_lease(
  uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_privacy_object_write_intent_lease(
  uuid, uuid, text, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_privacy_object_write_intent_lease(
  uuid, uuid, text
) TO aeostudio_runtime, aeostudio_lifecycle_worker;
GRANT EXECUTE ON FUNCTION public.release_privacy_object_write_intent_lease(
  uuid, uuid, text, integer
) TO aeostudio_runtime, aeostudio_lifecycle_worker;
