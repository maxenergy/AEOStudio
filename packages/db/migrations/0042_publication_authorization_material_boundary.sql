-- The API/runtime role may manage authorization commands and consume eligibility metadata, but
-- it must never read either recoverable secret references or credential fingerprints.
REVOKE SELECT ON public.channel_authorizations FROM aeostudio_runtime;
GRANT SELECT (
  id,
  tenant_id,
  workspace_id,
  adapter_version_id,
  status,
  granted_scopes,
  accepted_terms_version,
  target,
  expires_at,
  validation_status,
  validation_actual_target,
  validation_actual_scopes,
  validation_terms_version,
  validated_at,
  validation_valid_until,
  validation_failure_code,
  created_by_user_id,
  created_at,
  updated_at
) ON public.channel_authorizations TO aeostudio_runtime;

-- Authorization creation may submit only the browser-owned request fields. Provider-observed
-- validation state is Worker-owned and must not be forgeable through a direct runtime INSERT.
REVOKE INSERT ON public.channel_authorizations FROM aeostudio_runtime;
GRANT INSERT (
  id,
  tenant_id,
  workspace_id,
  adapter_version_id,
  status,
  secret_arn,
  granted_scopes,
  accepted_terms_version,
  target,
  expires_at,
  created_by_user_id,
  created_at,
  updated_at
) ON public.channel_authorizations TO aeostudio_runtime;

-- Provider validation reads connector credentials through the Tenant Data Broker. Its capability
-- is rooted in the exact leased validation command, never in a caller-selected secret ARN.
ALTER TABLE public.tenant_data_capabilities
  DROP CONSTRAINT tenant_data_capabilities_source_kind_check;
ALTER TABLE public.tenant_data_capabilities
  ADD CONSTRAINT tenant_data_capabilities_source_kind_check CHECK (source_kind IN (
    'ACTIVE_PUBLICATION_JOB', 'CHANNEL_AUTHORIZATION_VALIDATION',
    'CONNECTOR_DELETION_INTENT', 'WORKLOAD_WRITE_INTENT', 'PRIVACY_WRITE_INTENT',
    'ACTIVE_JOB_OBJECT_READ', 'AUTHENTICATED_OBJECT_READ',
    'DELETION_INVENTORY_INTENT', 'DELETION_OBJECT_INTENT',
    'LEGAL_HOLD_RECONCILIATION_INTENT'
  ));

CREATE FUNCTION public.issue_channel_authorization_validation_secret_read_capability(
  p_command_id uuid,
  p_authorization_id uuid,
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
  source record;
  derived_resource jsonb;
BEGIN
  IF p_command_id IS NULL OR p_authorization_id IS NULL
     OR p_lease_token IS NULL OR p_capability_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT validation_command.id AS command_id,
         validation_command.attempt_count,
         validation_command.lease_expires_at,
         auth_row.id AS authorization_id,
         auth_row.tenant_id,
         auth_row.workspace_id,
         auth_row.secret_arn,
         LEAST(
           validation_command.lease_expires_at,
           COALESCE(auth_row.expires_at, validation_command.lease_expires_at)
         ) AS authority_expires_at
    INTO source
  FROM public.channel_authorization_validation_commands validation_command
  JOIN public.channel_authorizations auth_row
    ON auth_row.tenant_id = validation_command.tenant_id
   AND auth_row.workspace_id = validation_command.workspace_id
   AND auth_row.id = validation_command.authorization_id
  JOIN public.adapter_versions adapter
    ON adapter.id = auth_row.adapter_version_id
   AND adapter.enabled
   AND adapter.terms_status = 'ALLOWED'
   AND adapter.terms_version = auth_row.accepted_terms_version
   AND auth_row.granted_scopes <@ adapter.required_scopes
   AND (
     adapter.provider_api_supported_until IS NULL
     OR adapter.provider_api_supported_until > database_now
   )
  JOIN public.channel_definitions channel
    ON channel.id = adapter.channel_definition_id
   AND channel.status = 'AVAILABLE'
  JOIN public.tenants tenant
    ON tenant.id = auth_row.tenant_id
   AND tenant.lifecycle_state = 'ACTIVE'
  JOIN public.workspaces workspace
    ON workspace.tenant_id = auth_row.tenant_id
   AND workspace.id = auth_row.workspace_id
   AND workspace.lifecycle_state = 'ACTIVE'
  WHERE validation_command.id = p_command_id
    AND validation_command.authorization_id = p_authorization_id
    AND validation_command.status = 'LEASED'
    AND validation_command.lease_token = p_lease_token
    AND validation_command.lease_expires_at > database_now
    AND auth_row.status = 'ACTIVE'
    AND auth_row.validation_status = 'PENDING_VALIDATION'
    AND auth_row.secret_arn IS NOT NULL
    AND (
      auth_row.expires_at IS NULL
      OR auth_row.expires_at > database_now
    )
  FOR SHARE OF validation_command, auth_row, tenant, workspace;
  IF NOT FOUND THEN RETURN NULL; END IF;

  derived_resource := jsonb_build_object(
    'kind', 'CONNECTOR_SECRET',
    'secretArn', source.secret_arn
  );
  RETURN public.tenant_data_issue_capability_private(
    p_capability_id,
    'CHANNEL_AUTHORIZATION_VALIDATION',
    source.command_id::text,
    source.attempt_count,
    p_lease_token,
    'CHANNEL_AUTHORIZATION_VALIDATION_SECRET_READ:' ||
      source.command_id::text || ':' || source.attempt_count::text,
    'CHANNEL_AUTHORIZATION_VALIDATION',
    source.authorization_id::text,
    'WORKSPACE',
    source.tenant_id,
    source.workspace_id,
    'READ_CONNECTOR_SECRET',
    derived_resource,
    source.authority_expires_at
  );
END
$function$;

REVOKE ALL ON FUNCTION
  public.issue_channel_authorization_validation_secret_read_capability(
    uuid, uuid, uuid, uuid
  )
  FROM PUBLIC, aeostudio_runtime, aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION
  public.issue_channel_authorization_validation_secret_read_capability(
    uuid, uuid, uuid, uuid
  )
  TO aeostudio_lifecycle_worker;

-- Extend the Broker's live-source validator without weakening any pre-existing authority.
ALTER FUNCTION public.tenant_data_capability_source_lease_expires_at(
  public.tenant_data_capabilities, uuid, timestamptz
) RENAME TO tenant_data_capability_source_lease_expires_at_pre0042;

CREATE FUNCTION public.tenant_data_capability_source_lease_expires_at(
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
  source_lease_expires_at :=
    public.tenant_data_capability_source_lease_expires_at_pre0042(
      p_capability, p_lease_token, p_database_now
    );
  IF source_lease_expires_at IS NOT NULL THEN
    RETURN source_lease_expires_at;
  END IF;
  IF p_lease_token IS NULL
     OR p_database_now IS NULL
     OR p_capability.source_kind IS DISTINCT FROM
       'CHANNEL_AUTHORIZATION_VALIDATION'
     OR p_capability.authority_kind IS DISTINCT FROM
       'CHANNEL_AUTHORIZATION_VALIDATION'
     OR p_capability.operation IS DISTINCT FROM 'READ_CONNECTOR_SECRET'
     OR p_capability.scope_kind IS DISTINCT FROM 'WORKSPACE'
     OR p_capability.workspace_id IS NULL
     OR p_capability.lease_token_sha256 IS DISTINCT FROM encode(
       sha256(convert_to(p_lease_token::text, 'UTF8')), 'hex'
     ) THEN
    RETURN NULL;
  END IF;

  SELECT LEAST(
           validation_command.lease_expires_at,
           COALESCE(auth_row.expires_at, validation_command.lease_expires_at)
         )
    INTO source_lease_expires_at
  FROM public.channel_authorization_validation_commands validation_command
  JOIN public.channel_authorizations auth_row
    ON auth_row.tenant_id = validation_command.tenant_id
   AND auth_row.workspace_id = validation_command.workspace_id
   AND auth_row.id = validation_command.authorization_id
  JOIN public.adapter_versions adapter
    ON adapter.id = auth_row.adapter_version_id
   AND adapter.enabled
   AND adapter.terms_status = 'ALLOWED'
   AND adapter.terms_version = auth_row.accepted_terms_version
   AND auth_row.granted_scopes <@ adapter.required_scopes
   AND (
     adapter.provider_api_supported_until IS NULL
     OR adapter.provider_api_supported_until > p_database_now
   )
  JOIN public.channel_definitions channel
    ON channel.id = adapter.channel_definition_id
   AND channel.status = 'AVAILABLE'
  JOIN public.tenants tenant
    ON tenant.id = auth_row.tenant_id
   AND tenant.lifecycle_state = 'ACTIVE'
  JOIN public.workspaces workspace
    ON workspace.tenant_id = auth_row.tenant_id
   AND workspace.id = auth_row.workspace_id
   AND workspace.lifecycle_state = 'ACTIVE'
  WHERE validation_command.id::text = p_capability.source_reference
    AND validation_command.authorization_id::text =
      p_capability.authority_reference
    AND validation_command.tenant_id = p_capability.tenant_id
    AND validation_command.workspace_id = p_capability.workspace_id
    AND validation_command.attempt_count = p_capability.source_revision
    AND validation_command.status = 'LEASED'
    AND validation_command.lease_token = p_lease_token
    AND validation_command.lease_expires_at > p_database_now
    AND auth_row.status = 'ACTIVE'
    AND auth_row.validation_status = 'PENDING_VALIDATION'
    AND auth_row.secret_arn IS NOT NULL
    AND (
      auth_row.expires_at IS NULL
      OR auth_row.expires_at > p_database_now
    )
    AND p_capability.effect_identity =
      'CHANNEL_AUTHORIZATION_VALIDATION_SECRET_READ:' ||
      validation_command.id::text || ':' ||
      validation_command.attempt_count::text
    AND p_capability.resource = jsonb_build_object(
      'kind', 'CONNECTOR_SECRET',
      'secretArn', auth_row.secret_arn
    );
  RETURN source_lease_expires_at;
END
$function$;

REVOKE ALL ON FUNCTION public.tenant_data_capability_source_lease_expires_at(
  public.tenant_data_capabilities, uuid, timestamptz
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker,
  aeostudio_tenant_data_broker;

-- The irreversible publication path receives both sensitive values only through a lease-bound,
-- fresh-authorization check owned by the offline migration principal. The lifecycle login merely
-- receives EXECUTE and never receives table/column access to the material itself.
CREATE FUNCTION public.read_publication_authorization_material(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_publication_id uuid,
  p_job_id uuid,
  p_message_id uuid,
  p_lease_token uuid
)
RETURNS TABLE (
  secret_reference text,
  credential_fingerprint text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  database_now timestamptz := clock_timestamp();
BEGIN
  RETURN QUERY
  SELECT auth_row.secret_arn,
         auth_row.validation_credential_fingerprint
  FROM public.tenants tenant
  JOIN public.workspaces workspace
    ON workspace.tenant_id = tenant.id
   AND workspace.id = p_workspace_id
  JOIN public.jobs job
    ON job.tenant_id = tenant.id
   AND job.workspace_id = workspace.id
   AND job.id = p_job_id
  JOIN public.outbox_messages outbox
    ON outbox.tenant_id = tenant.id
   AND outbox.workspace_id = workspace.id
   AND outbox.id = p_message_id
   AND outbox.aggregate_id = job.id
   AND outbox.message_type = 'JOB_QUEUED'
   AND outbox.payload ->> 'jobId' = job.id::text
   AND outbox.payload ->> 'tenantId' = tenant.id::text
   AND outbox.payload ->> 'workspaceId' = workspace.id::text
   AND outbox.payload ->> 'schemaVersion' = '1.0.0'
  JOIN public.inbox_messages inbox
    ON inbox.tenant_id = outbox.tenant_id
   AND inbox.workspace_id = outbox.workspace_id
   AND inbox.message_id = outbox.id
   AND inbox.consumer = 'publish-workload-v1'
   AND inbox.status = 'PROCESSING'
  JOIN public.publication_records publication
    ON publication.tenant_id = tenant.id
   AND publication.workspace_id = workspace.id
   AND publication.id = p_publication_id
   AND publication.job_id = job.id
  JOIN public.channel_authorizations auth_row
    ON auth_row.tenant_id = publication.tenant_id
   AND auth_row.workspace_id = publication.workspace_id
   AND auth_row.id = publication.channel_authorization_id
   AND auth_row.adapter_version_id = publication.adapter_version_id
   AND auth_row.target = publication.authorization_target
  JOIN public.adapter_versions adapter
    ON adapter.id = publication.adapter_version_id
  JOIN public.channel_definitions channel
    ON channel.id = adapter.channel_definition_id
  WHERE tenant.id = p_tenant_id
    AND tenant.lifecycle_state = 'ACTIVE'
    AND workspace.lifecycle_state = 'ACTIVE'
    AND job.job_type = 'PUBLICATION'
    AND job.aggregate_id = publication.id
    AND job.status = 'RUNNING'
    AND job.lease_token = p_lease_token
    AND job.lifecycle_frozen_at IS NULL
    AND job.lease_expires_at >= database_now + interval '1 second'
    AND publication.status IN ('RUNNING', 'RECONCILING')
    AND (
      (publication.status = 'RUNNING' AND 'PUBLISH' = ANY(adapter.capabilities))
      OR
      (publication.status = 'RECONCILING' AND 'RECONCILE' = ANY(adapter.capabilities))
    )
    AND adapter.enabled
    AND adapter.terms_status = 'ALLOWED'
    AND (
      adapter.provider_api_supported_until IS NULL
      OR adapter.provider_api_supported_until > database_now
    )
    AND channel.status = 'AVAILABLE'
    AND auth_row.status = 'ACTIVE'
    AND auth_row.secret_arn IS NOT NULL
    AND auth_row.accepted_terms_version = adapter.terms_version
    AND auth_row.validation_status = 'VERIFIED'
    AND auth_row.validation_actual_target = publication.authorization_target
    AND auth_row.validation_terms_version = adapter.terms_version
    AND auth_row.validation_actual_scopes IS NOT NULL
    AND auth_row.granted_scopes <@ auth_row.validation_actual_scopes
    AND adapter.required_scopes <@ auth_row.validation_actual_scopes
    AND auth_row.validation_credential_fingerprint ~ '^[a-f0-9]{64}$'
    AND auth_row.validation_valid_until > database_now
    AND (
      auth_row.expires_at IS NULL
      OR auth_row.expires_at > database_now
    )
  LIMIT 1
  FOR SHARE OF tenant, workspace, job, outbox, inbox, publication, auth_row;
END
$function$;

REVOKE ALL ON FUNCTION public.read_publication_authorization_material(
  uuid, uuid, uuid, uuid, uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_publication_authorization_material(
  uuid, uuid, uuid, uuid, uuid, uuid
) FROM aeostudio_runtime;
GRANT EXECUTE ON FUNCTION public.read_publication_authorization_material(
  uuid, uuid, uuid, uuid, uuid, uuid
) TO aeostudio_lifecycle_worker;
