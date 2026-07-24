-- The runtime publication transaction needs a yes/no freshness check without gaining read access
-- to connector secret references or credential fingerprints. The nested lifecycle-only function
-- owns the sensitive read and holds its row locks until the caller's transaction ends.
CREATE FUNCTION public.guard_publication_authorization_material(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_publication_id uuid,
  p_job_id uuid,
  p_message_id uuid,
  p_lease_token uuid,
  p_attempt_id uuid,
  p_operation text,
  p_expected_secret_reference text,
  p_expected_credential_fingerprint text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_operation NOT IN ('PUBLISH', 'RECONCILE')
     OR p_expected_secret_reference IS NULL
     OR length(p_expected_secret_reference) NOT BETWEEN 1 AND 2048
     OR p_expected_credential_fingerprint IS NULL
     OR p_expected_credential_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.read_publication_authorization_material(
      p_tenant_id,
      p_workspace_id,
      p_publication_id,
      p_job_id,
      p_message_id,
      p_lease_token
    ) material
    WHERE material.secret_reference = p_expected_secret_reference
      AND material.credential_fingerprint = p_expected_credential_fingerprint
      AND EXISTS (
        SELECT 1
        FROM public.publication_records publication
        JOIN public.channel_authorizations auth_row
          ON auth_row.tenant_id = publication.tenant_id
         AND auth_row.workspace_id = publication.workspace_id
         AND auth_row.id = publication.channel_authorization_id
         AND auth_row.adapter_version_id = publication.adapter_version_id
         AND auth_row.target = publication.authorization_target
        JOIN public.adapter_versions adapter
          ON adapter.id = publication.adapter_version_id
         AND adapter.enabled
         AND adapter.terms_status = 'ALLOWED'
         AND adapter.terms_version = auth_row.accepted_terms_version
         AND adapter.required_scopes <@ auth_row.granted_scopes
         AND adapter.required_scopes <@ auth_row.validation_actual_scopes
         AND (
           adapter.provider_api_supported_until IS NULL
           OR adapter.provider_api_supported_until > clock_timestamp()
         )
         AND (
           (p_operation = 'PUBLISH' AND 'PUBLISH' = ANY(adapter.capabilities))
           OR
           (p_operation = 'RECONCILE' AND 'RECONCILE' = ANY(adapter.capabilities))
         )
        JOIN public.channel_definitions channel
          ON channel.id = adapter.channel_definition_id
         AND channel.status = 'AVAILABLE'
        WHERE publication.tenant_id = p_tenant_id
          AND publication.workspace_id = p_workspace_id
          AND publication.id = p_publication_id
          AND publication.job_id = p_job_id
        FOR SHARE OF adapter, channel
      )
      AND EXISTS (
        SELECT 1
        FROM public.publication_attempts attempt
        JOIN public.publication_records publication
          ON publication.tenant_id = attempt.tenant_id
         AND publication.workspace_id = attempt.workspace_id
         AND publication.id = attempt.publication_id
        WHERE attempt.tenant_id = p_tenant_id
          AND attempt.workspace_id = p_workspace_id
          AND attempt.publication_id = p_publication_id
          AND attempt.id = p_attempt_id
          AND attempt.operation = p_operation
          AND attempt.outcome = 'STARTED'
          AND publication.job_id = p_job_id
          AND (
            (p_operation = 'PUBLISH' AND publication.status = 'RUNNING')
            OR
            (p_operation = 'RECONCILE' AND publication.status = 'RECONCILING')
          )
        FOR SHARE OF attempt
      )
  );
END
$function$;

REVOKE ALL ON FUNCTION public.guard_publication_authorization_material(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text
) FROM PUBLIC, aeostudio_lifecycle_worker, aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION public.guard_publication_authorization_material(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text
) TO aeostudio_runtime;
