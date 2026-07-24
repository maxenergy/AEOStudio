-- A publication records the exact Adapter scopes selected for its target/package at command time.
-- Existing rows predate dynamic scope selection, so conservatively bind them to the complete
-- Registry declaration. Raw/legacy insert paths receive the same conservative fallback.
CREATE FUNCTION public.valid_publication_required_scopes(p_scopes text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT p_scopes IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(p_scopes) scope(value)
      WHERE scope.value IS NULL
         OR scope.value <> btrim(scope.value)
         OR length(scope.value) NOT BETWEEN 1 AND 200
    )
    AND cardinality(p_scopes) = (
      SELECT count(DISTINCT scope.value)
      FROM unnest(p_scopes) scope(value)
    )
$function$;

REVOKE ALL ON FUNCTION public.valid_publication_required_scopes(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_publication_required_scopes(text[]) TO aeostudio_runtime;

ALTER TABLE public.publication_records
  ADD COLUMN required_scopes_snapshot text[];

UPDATE public.publication_records publication
SET required_scopes_snapshot = adapter.required_scopes
FROM public.adapter_versions adapter
WHERE adapter.id = publication.adapter_version_id;

ALTER TABLE public.publication_records
  ALTER COLUMN required_scopes_snapshot SET NOT NULL,
  ADD CONSTRAINT publication_records_required_scopes_snapshot_check
    CHECK (public.valid_publication_required_scopes(required_scopes_snapshot));

CREATE FUNCTION public.initialize_publication_required_scopes_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  declared_scopes text[];
BEGIN
  SELECT adapter.required_scopes
  INTO declared_scopes
  FROM public.adapter_versions adapter
  WHERE adapter.id = NEW.adapter_version_id;

  IF declared_scopes IS NULL THEN
    RAISE EXCEPTION 'PUBLICATION_ADAPTER_VERSION_NOT_FOUND' USING ERRCODE = '23503';
  END IF;

  IF NEW.required_scopes_snapshot IS NULL THEN
    NEW.required_scopes_snapshot := declared_scopes;
  END IF;

  IF NOT public.valid_publication_required_scopes(NEW.required_scopes_snapshot)
     OR NOT NEW.required_scopes_snapshot <@ declared_scopes THEN
    RAISE EXCEPTION 'PUBLICATION_REQUIRED_SCOPES_INVALID' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.initialize_publication_required_scopes_snapshot() FROM PUBLIC;

CREATE TRIGGER publication_required_scopes_snapshot_initializer
BEFORE INSERT ON public.publication_records
FOR EACH ROW EXECUTE FUNCTION public.initialize_publication_required_scopes_snapshot();

CREATE FUNCTION public.reject_publication_required_scopes_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.required_scopes_snapshot IS DISTINCT FROM OLD.required_scopes_snapshot THEN
    RAISE EXCEPTION 'PUBLICATION_REQUIRED_SCOPES_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.reject_publication_required_scopes_snapshot_mutation() FROM PUBLIC;

CREATE TRIGGER publication_required_scopes_snapshot_immutable_guard
BEFORE UPDATE OF required_scopes_snapshot ON public.publication_records
FOR EACH ROW EXECUTE FUNCTION public.reject_publication_required_scopes_snapshot_mutation();

-- Replace the lifecycle-only material reader so a target-scoped publication is checked against
-- its durable exact scope snapshot, not the Adapter Registry's complete capability superset.
CREATE OR REPLACE FUNCTION public.read_publication_authorization_material(
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
    AND publication.required_scopes_snapshot <@ adapter.required_scopes
    AND publication.required_scopes_snapshot <@ auth_row.granted_scopes
    AND publication.required_scopes_snapshot <@ auth_row.validation_actual_scopes
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

-- Package creation has no Publication row yet. Give its current-Artifact fence the same
-- append-only row locking boundary, scoped to the runtime transaction's tenant/workspace GUCs.
CREATE FUNCTION public.guard_current_approved_artifact_basis(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_artifact_id uuid,
  p_artifact_revision_id uuid,
  p_revision integer,
  p_content_hash text,
  p_effective_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  expected_evidence_count integer;
  locked_evidence_count bigint;
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant_id
     OR NULLIF(current_setting('app.workspace_id', true), '')::uuid
       IS DISTINCT FROM p_workspace_id
     OR p_revision < 1
     OR p_content_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM public.artifacts artifact
  JOIN public.artifact_revisions revision
    ON revision.tenant_id = artifact.tenant_id
   AND revision.workspace_id = artifact.workspace_id
   AND revision.artifact_id = artifact.id
   AND revision.id = p_artifact_revision_id
   AND revision.revision = p_revision
   AND revision.content_hash = p_content_hash
   AND revision.status = 'APPROVED'
  JOIN public.artifact_reviews review
    ON review.tenant_id = revision.tenant_id
   AND review.workspace_id = revision.workspace_id
   AND review.artifact_id = revision.artifact_id
   AND review.artifact_revision_id = revision.id
   AND review.revision = revision.revision
   AND review.content_hash = revision.content_hash
   AND review.decision = 'APPROVE'
  JOIN public.briefs brief
    ON brief.tenant_id = revision.tenant_id
   AND brief.workspace_id = revision.workspace_id
   AND brief.id = revision.brief_id
   AND brief.status = 'APPROVED'
  JOIN public.content_plans plan
    ON plan.tenant_id = brief.tenant_id
   AND plan.workspace_id = brief.workspace_id
   AND plan.id = brief.content_plan_id
   AND plan.status = 'READY'
  JOIN public.profile_revisions profile_revision
    ON profile_revision.tenant_id = plan.tenant_id
   AND profile_revision.workspace_id = plan.workspace_id
   AND profile_revision.id::text = plan.input_snapshot ->> 'profileRevisionId'
   AND profile_revision.profile_id::text = plan.input_snapshot #>> '{profile,id}'
   AND profile_revision.revision::text = plan.input_snapshot #>> '{profile,revision}'
  JOIN public.offering_revisions offering_revision
    ON offering_revision.tenant_id = plan.tenant_id
   AND offering_revision.workspace_id = plan.workspace_id
   AND offering_revision.id::text = plan.input_snapshot ->> 'offeringRevisionId'
   AND offering_revision.offering_id::text = plan.input_snapshot #>> '{offering,id}'
   AND offering_revision.revision::text = plan.input_snapshot #>> '{offering,revision}'
   AND offering_revision.profile_id = profile_revision.profile_id
  JOIN public.prompt_revisions prompt_revision
    ON prompt_revision.tenant_id = plan.tenant_id
   AND prompt_revision.workspace_id = plan.workspace_id
   AND prompt_revision.id::text = plan.input_snapshot ->> 'promptRevisionId'
   AND prompt_revision.status = 'APPROVED'
  JOIN public.prompt_sets prompt_set
    ON prompt_set.tenant_id = prompt_revision.tenant_id
   AND prompt_set.workspace_id = prompt_revision.workspace_id
   AND prompt_set.id = prompt_revision.prompt_set_id
   AND prompt_set.id::text = plan.input_snapshot ->> 'promptSetId'
   AND prompt_set.current_revision = prompt_revision.revision
  JOIN public.measurement_scenarios scenario
    ON scenario.tenant_id = prompt_revision.tenant_id
   AND scenario.workspace_id = prompt_revision.workspace_id
   AND scenario.prompt_revision_id = prompt_revision.id
   AND scenario.version = prompt_revision.revision
   AND scenario.registry_status = 'AVAILABLE'
  JOIN public.prompt_approvals prompt_approval
    ON prompt_approval.tenant_id = prompt_revision.tenant_id
   AND prompt_approval.workspace_id = prompt_revision.workspace_id
   AND prompt_approval.prompt_revision_id = prompt_revision.id
   AND prompt_approval.scenario_id = scenario.id
   AND prompt_approval.prompt_content_hash = prompt_revision.content_hash
   AND prompt_approval.scenario_content_hash = scenario.content_hash
  JOIN public.crawl_runs crawl
    ON crawl.tenant_id = plan.tenant_id
   AND crawl.workspace_id = plan.workspace_id
   AND crawl.id::text = plan.input_snapshot ->> 'baselineId'
   AND crawl.status IN ('COMPLETE', 'PARTIAL')
  JOIN public.sites site
    ON site.tenant_id = crawl.tenant_id
   AND site.workspace_id = crawl.workspace_id
   AND site.id = crawl.site_id
   AND site.profile_id = profile_revision.profile_id
  WHERE artifact.tenant_id = p_tenant_id
    AND artifact.workspace_id = p_workspace_id
    AND artifact.id = p_artifact_id
    AND artifact.current_revision = revision.revision
    AND artifact.status = 'APPROVED'
  FOR SHARE OF review, profile_revision, offering_revision, scenario, prompt_approval;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.artifact_revisions revision
    CROSS JOIN LATERAL jsonb_array_elements(revision.claim_bindings) claim_binding(value)
    CROSS JOIN LATERAL jsonb_array_elements(claim_binding.value -> 'evidence') evidence(value)
    WHERE revision.tenant_id = p_tenant_id
      AND revision.workspace_id = p_workspace_id
      AND revision.artifact_id = p_artifact_id
      AND revision.id = p_artifact_revision_id
      AND revision.revision = p_revision
      AND revision.content_hash = p_content_hash
    GROUP BY
      claim_binding.value ->> 'claimRevisionId',
      evidence.value ->> 'sourceId',
      evidence.value ->> 'snapshotId',
      evidence.value ->> 'sourceHash'
    HAVING count(*) > 1
  ) THEN
    RETURN false;
  END IF;

  SELECT COALESCE(sum(jsonb_array_length(binding.value -> 'evidence')), 0)::integer
  INTO expected_evidence_count
  FROM public.artifact_revisions revision
  CROSS JOIN LATERAL jsonb_array_elements(revision.claim_bindings) binding(value)
  WHERE revision.tenant_id = p_tenant_id
    AND revision.workspace_id = p_workspace_id
    AND revision.artifact_id = p_artifact_id
    AND revision.id = p_artifact_revision_id
    AND revision.revision = p_revision
    AND revision.content_hash = p_content_hash;

  IF expected_evidence_count IS NULL OR expected_evidence_count < 1 THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM public.artifact_revisions revision
  CROSS JOIN LATERAL jsonb_array_elements(revision.claim_bindings) claim_binding(value)
  CROSS JOIN LATERAL jsonb_array_elements(claim_binding.value -> 'evidence') evidence(value)
  JOIN public.claim_revisions claim_revision
    ON claim_revision.tenant_id = revision.tenant_id
   AND claim_revision.workspace_id = revision.workspace_id
   AND claim_revision.id = (claim_binding.value ->> 'claimRevisionId')::uuid
   AND claim_revision.claim_id = (claim_binding.value ->> 'claimId')::uuid
   AND claim_revision.content_hash = claim_binding.value ->> 'claimContentHash'
   AND claim_revision.statement = claim_binding.value ->> 'claimStatement'
   AND claim_revision.status = 'APPROVED'
   AND claim_revision.expires_at IS NOT NULL
   AND claim_revision.expires_at > p_effective_at
  JOIN public.claims claim
    ON claim.tenant_id = claim_revision.tenant_id
   AND claim.workspace_id = claim_revision.workspace_id
   AND claim.id = claim_revision.claim_id
   AND claim.current_revision = claim_revision.revision
  JOIN public.claim_reviews claim_review
    ON claim_review.tenant_id = claim_revision.tenant_id
   AND claim_review.workspace_id = claim_revision.workspace_id
   AND claim_review.claim_revision_id = claim_revision.id
   AND claim_review.decision = 'APPROVE'
   AND claim_review.content_hash = claim_revision.content_hash
  JOIN public.claim_evidence_links claim_link
    ON claim_link.tenant_id = claim_revision.tenant_id
   AND claim_link.workspace_id = claim_revision.workspace_id
   AND claim_link.claim_revision_id = claim_revision.id
   AND claim_link.snippet IS NOT NULL
  JOIN public.evidence_snapshots snapshot
    ON snapshot.tenant_id = claim_link.tenant_id
   AND snapshot.workspace_id = claim_link.workspace_id
   AND snapshot.id = claim_link.snapshot_id
   AND snapshot.id = (evidence.value ->> 'snapshotId')::uuid
   AND snapshot.source_id = (evidence.value ->> 'sourceId')::uuid
   AND snapshot.content_hash = evidence.value ->> 'sourceHash'
   AND claim_link.source_hash = evidence.value ->> 'sourceHash'
  JOIN public.evidence_sources evidence_source
    ON evidence_source.tenant_id = snapshot.tenant_id
   AND evidence_source.workspace_id = snapshot.workspace_id
   AND evidence_source.id = snapshot.source_id
   AND evidence_source.current_snapshot_id = snapshot.id
  JOIN public.artifact_claim_links artifact_link
    ON artifact_link.tenant_id = revision.tenant_id
   AND artifact_link.workspace_id = revision.workspace_id
   AND artifact_link.artifact_revision_id = revision.id
   AND artifact_link.claim_revision_id = claim_revision.id
   AND artifact_link.snapshot_id = snapshot.id
   AND artifact_link.source_id = snapshot.source_id
   AND artifact_link.source_hash = snapshot.content_hash
  WHERE revision.tenant_id = p_tenant_id
    AND revision.workspace_id = p_workspace_id
    AND revision.artifact_id = p_artifact_id
    AND revision.id = p_artifact_revision_id
    AND revision.revision = p_revision
    AND revision.content_hash = p_content_hash
  FOR SHARE OF claim, claim_review, claim_link, snapshot, artifact_link;

  GET DIAGNOSTICS locked_evidence_count = ROW_COUNT;
  RETURN locked_evidence_count = expected_evidence_count;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_current_approved_artifact_basis(
  uuid, uuid, uuid, uuid, integer, text, timestamptz
) FROM PUBLIC, aeostudio_lifecycle_worker, aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION public.guard_current_approved_artifact_basis(
  uuid, uuid, uuid, uuid, integer, text, timestamptz
) TO aeostudio_runtime;

-- Lock every append-only row whose contents participate in the publish currentness predicate.
-- This function is deliberately not executable by runtime; it is reached only from the
-- lease/material/attempt-bound boolean guard below, and its locks live until that transaction ends.
CREATE FUNCTION public.guard_publication_currentness_basis(
  p_tenant_id uuid,
  p_workspace_id uuid,
  p_publication_id uuid,
  p_job_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  expected_evidence_count integer;
  locked_evidence_count bigint;
BEGIN
  PERFORM 1
  FROM public.publication_records publication
  JOIN public.channel_packages package
    ON package.tenant_id = publication.tenant_id
   AND package.workspace_id = publication.workspace_id
   AND package.id = publication.channel_package_id
   AND package.package_checksum = publication.package_checksum
   AND package.artifact_revision_id = publication.artifact_revision_id
   AND package.artifact_content_hash = publication.artifact_content_hash
  JOIN public.artifacts artifact
    ON artifact.tenant_id = package.tenant_id
   AND artifact.workspace_id = package.workspace_id
   AND artifact.id = package.artifact_id
   AND artifact.current_revision = package.artifact_revision
  JOIN public.artifact_revisions revision
    ON revision.tenant_id = package.tenant_id
   AND revision.workspace_id = package.workspace_id
   AND revision.artifact_id = package.artifact_id
   AND revision.id = package.artifact_revision_id
   AND revision.revision = package.artifact_revision
   AND revision.content_hash = package.artifact_content_hash
   AND revision.status = 'APPROVED'
  JOIN public.artifact_reviews review
    ON review.tenant_id = revision.tenant_id
   AND review.workspace_id = revision.workspace_id
   AND review.artifact_id = revision.artifact_id
   AND review.artifact_revision_id = revision.id
   AND review.revision = revision.revision
   AND review.content_hash = revision.content_hash
   AND review.decision = 'APPROVE'
  JOIN public.briefs brief
    ON brief.tenant_id = revision.tenant_id
   AND brief.workspace_id = revision.workspace_id
   AND brief.id = revision.brief_id
   AND brief.status = 'APPROVED'
  JOIN public.content_plans plan
    ON plan.tenant_id = brief.tenant_id
   AND plan.workspace_id = brief.workspace_id
   AND plan.id = brief.content_plan_id
   AND plan.status = 'READY'
  JOIN public.profile_revisions profile_revision
    ON profile_revision.tenant_id = plan.tenant_id
   AND profile_revision.workspace_id = plan.workspace_id
   AND profile_revision.id::text = plan.input_snapshot ->> 'profileRevisionId'
   AND profile_revision.profile_id::text = plan.input_snapshot #>> '{profile,id}'
   AND profile_revision.revision::text = plan.input_snapshot #>> '{profile,revision}'
  JOIN public.offering_revisions offering_revision
    ON offering_revision.tenant_id = plan.tenant_id
   AND offering_revision.workspace_id = plan.workspace_id
   AND offering_revision.id::text = plan.input_snapshot ->> 'offeringRevisionId'
   AND offering_revision.offering_id::text = plan.input_snapshot #>> '{offering,id}'
   AND offering_revision.revision::text = plan.input_snapshot #>> '{offering,revision}'
   AND offering_revision.profile_id = profile_revision.profile_id
  JOIN public.prompt_revisions prompt_revision
    ON prompt_revision.tenant_id = plan.tenant_id
   AND prompt_revision.workspace_id = plan.workspace_id
   AND prompt_revision.id::text = plan.input_snapshot ->> 'promptRevisionId'
   AND prompt_revision.status = 'APPROVED'
  JOIN public.prompt_sets prompt_set
    ON prompt_set.tenant_id = prompt_revision.tenant_id
   AND prompt_set.workspace_id = prompt_revision.workspace_id
   AND prompt_set.id = prompt_revision.prompt_set_id
   AND prompt_set.id::text = plan.input_snapshot ->> 'promptSetId'
   AND prompt_set.current_revision = prompt_revision.revision
  JOIN public.measurement_scenarios scenario
    ON scenario.tenant_id = prompt_revision.tenant_id
   AND scenario.workspace_id = prompt_revision.workspace_id
   AND scenario.prompt_revision_id = prompt_revision.id
   AND scenario.version = prompt_revision.revision
   AND scenario.registry_status = 'AVAILABLE'
  JOIN public.prompt_approvals prompt_approval
    ON prompt_approval.tenant_id = prompt_revision.tenant_id
   AND prompt_approval.workspace_id = prompt_revision.workspace_id
   AND prompt_approval.prompt_revision_id = prompt_revision.id
   AND prompt_approval.scenario_id = scenario.id
   AND prompt_approval.prompt_content_hash = prompt_revision.content_hash
   AND prompt_approval.scenario_content_hash = scenario.content_hash
  JOIN public.crawl_runs crawl
    ON crawl.tenant_id = plan.tenant_id
   AND crawl.workspace_id = plan.workspace_id
   AND crawl.id::text = plan.input_snapshot ->> 'baselineId'
   AND crawl.status IN ('COMPLETE', 'PARTIAL')
  JOIN public.sites site
    ON site.tenant_id = crawl.tenant_id
   AND site.workspace_id = crawl.workspace_id
   AND site.id = crawl.site_id
   AND site.profile_id = profile_revision.profile_id
  WHERE publication.tenant_id = p_tenant_id
    AND publication.workspace_id = p_workspace_id
    AND publication.id = p_publication_id
    AND publication.job_id = p_job_id
    AND publication.status = 'RUNNING'
  FOR SHARE OF review, profile_revision, offering_revision, scenario, prompt_approval;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.publication_records publication
    JOIN public.channel_packages package
      ON package.tenant_id = publication.tenant_id
     AND package.workspace_id = publication.workspace_id
     AND package.id = publication.channel_package_id
     AND package.package_checksum = publication.package_checksum
     AND package.artifact_revision_id = publication.artifact_revision_id
     AND package.artifact_content_hash = publication.artifact_content_hash
    JOIN public.artifact_revisions revision
      ON revision.tenant_id = package.tenant_id
     AND revision.workspace_id = package.workspace_id
     AND revision.artifact_id = package.artifact_id
     AND revision.id = package.artifact_revision_id
     AND revision.revision = package.artifact_revision
     AND revision.content_hash = package.artifact_content_hash
    CROSS JOIN LATERAL jsonb_array_elements(revision.claim_bindings) claim_binding(value)
    CROSS JOIN LATERAL jsonb_array_elements(claim_binding.value -> 'evidence') evidence(value)
    WHERE publication.tenant_id = p_tenant_id
      AND publication.workspace_id = p_workspace_id
      AND publication.id = p_publication_id
      AND publication.job_id = p_job_id
      AND publication.status = 'RUNNING'
    GROUP BY
      claim_binding.value ->> 'claimRevisionId',
      evidence.value ->> 'sourceId',
      evidence.value ->> 'snapshotId',
      evidence.value ->> 'sourceHash'
    HAVING count(*) > 1
  ) THEN
    RETURN false;
  END IF;

  SELECT COALESCE(sum(jsonb_array_length(expected_binding.value -> 'evidence')), 0)::integer
  INTO expected_evidence_count
  FROM public.publication_records publication
  JOIN public.channel_packages package
    ON package.tenant_id = publication.tenant_id
   AND package.workspace_id = publication.workspace_id
   AND package.id = publication.channel_package_id
   AND package.package_checksum = publication.package_checksum
   AND package.artifact_revision_id = publication.artifact_revision_id
   AND package.artifact_content_hash = publication.artifact_content_hash
  JOIN public.artifact_revisions revision
    ON revision.tenant_id = package.tenant_id
   AND revision.workspace_id = package.workspace_id
   AND revision.artifact_id = package.artifact_id
   AND revision.id = package.artifact_revision_id
   AND revision.revision = package.artifact_revision
   AND revision.content_hash = package.artifact_content_hash
  CROSS JOIN LATERAL jsonb_array_elements(revision.claim_bindings) expected_binding(value)
  WHERE publication.tenant_id = p_tenant_id
    AND publication.workspace_id = p_workspace_id
    AND publication.id = p_publication_id
    AND publication.job_id = p_job_id
    AND publication.status = 'RUNNING';

  IF expected_evidence_count IS NULL OR expected_evidence_count < 1 THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM public.publication_records publication
  JOIN public.channel_packages package
    ON package.tenant_id = publication.tenant_id
   AND package.workspace_id = publication.workspace_id
   AND package.id = publication.channel_package_id
   AND package.package_checksum = publication.package_checksum
   AND package.artifact_revision_id = publication.artifact_revision_id
   AND package.artifact_content_hash = publication.artifact_content_hash
  JOIN public.artifact_revisions revision
    ON revision.tenant_id = package.tenant_id
   AND revision.workspace_id = package.workspace_id
   AND revision.artifact_id = package.artifact_id
   AND revision.id = package.artifact_revision_id
   AND revision.revision = package.artifact_revision
   AND revision.content_hash = package.artifact_content_hash
  CROSS JOIN LATERAL jsonb_array_elements(revision.claim_bindings) claim_binding(value)
  CROSS JOIN LATERAL jsonb_array_elements(claim_binding.value -> 'evidence') evidence(value)
  JOIN public.claim_revisions claim_revision
    ON claim_revision.tenant_id = revision.tenant_id
   AND claim_revision.workspace_id = revision.workspace_id
   AND claim_revision.id = (claim_binding.value ->> 'claimRevisionId')::uuid
   AND claim_revision.claim_id = (claim_binding.value ->> 'claimId')::uuid
   AND claim_revision.content_hash = claim_binding.value ->> 'claimContentHash'
   AND claim_revision.statement = claim_binding.value ->> 'claimStatement'
   AND claim_revision.status = 'APPROVED'
   AND claim_revision.expires_at IS NOT NULL
   AND claim_revision.expires_at > clock_timestamp()
  JOIN public.claims claim
    ON claim.tenant_id = claim_revision.tenant_id
   AND claim.workspace_id = claim_revision.workspace_id
   AND claim.id = claim_revision.claim_id
   AND claim.current_revision = claim_revision.revision
  JOIN public.claim_reviews claim_review
    ON claim_review.tenant_id = claim_revision.tenant_id
   AND claim_review.workspace_id = claim_revision.workspace_id
   AND claim_review.claim_revision_id = claim_revision.id
   AND claim_review.decision = 'APPROVE'
   AND claim_review.content_hash = claim_revision.content_hash
  JOIN public.claim_evidence_links claim_link
    ON claim_link.tenant_id = claim_revision.tenant_id
   AND claim_link.workspace_id = claim_revision.workspace_id
   AND claim_link.claim_revision_id = claim_revision.id
   AND claim_link.snippet IS NOT NULL
  JOIN public.evidence_snapshots snapshot
    ON snapshot.tenant_id = claim_link.tenant_id
   AND snapshot.workspace_id = claim_link.workspace_id
   AND snapshot.id = claim_link.snapshot_id
   AND snapshot.id = (evidence.value ->> 'snapshotId')::uuid
   AND snapshot.source_id = (evidence.value ->> 'sourceId')::uuid
   AND snapshot.content_hash = evidence.value ->> 'sourceHash'
   AND claim_link.source_hash = evidence.value ->> 'sourceHash'
  JOIN public.evidence_sources evidence_source
    ON evidence_source.tenant_id = snapshot.tenant_id
   AND evidence_source.workspace_id = snapshot.workspace_id
   AND evidence_source.id = snapshot.source_id
   AND evidence_source.current_snapshot_id = snapshot.id
  JOIN public.artifact_claim_links artifact_link
    ON artifact_link.tenant_id = revision.tenant_id
   AND artifact_link.workspace_id = revision.workspace_id
   AND artifact_link.artifact_revision_id = revision.id
   AND artifact_link.claim_revision_id = claim_revision.id
   AND artifact_link.snapshot_id = snapshot.id
   AND artifact_link.source_id = snapshot.source_id
   AND artifact_link.source_hash = snapshot.content_hash
  WHERE publication.tenant_id = p_tenant_id
    AND publication.workspace_id = p_workspace_id
     AND publication.id = p_publication_id
     AND publication.job_id = p_job_id
     AND publication.status = 'RUNNING'
  FOR SHARE OF claim, claim_review, claim_link, snapshot, artifact_link;

  GET DIAGNOSTICS locked_evidence_count = ROW_COUNT;
  RETURN locked_evidence_count = expected_evidence_count;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_publication_currentness_basis(
  uuid, uuid, uuid, uuid
) FROM PUBLIC, aeostudio_runtime, aeostudio_lifecycle_worker, aeostudio_tenant_data_broker;

DROP FUNCTION public.guard_publication_authorization_material(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text
);

-- Runtime receives only the final boolean and must present the Worker-computed exact dynamic
-- scopes. Set equality against the immutable snapshot prevents an empty/subset parameter bypass.
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
  p_expected_credential_fingerprint text,
  p_expected_required_scopes text[]
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
     OR p_expected_credential_fingerprint !~ '^[a-f0-9]{64}$'
     OR NOT public.valid_publication_required_scopes(p_expected_required_scopes) THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
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
         AND publication.required_scopes_snapshot <@ adapter.required_scopes
         AND publication.required_scopes_snapshot <@ auth_row.granted_scopes
         AND publication.required_scopes_snapshot <@ auth_row.validation_actual_scopes
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
          AND publication.required_scopes_snapshot <@ p_expected_required_scopes
          AND p_expected_required_scopes <@ publication.required_scopes_snapshot
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
  ) THEN
    RETURN false;
  END IF;

  IF p_operation = 'PUBLISH' THEN
    RETURN public.guard_publication_currentness_basis(
      p_tenant_id,
      p_workspace_id,
      p_publication_id,
      p_job_id
    );
  END IF;

  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_publication_authorization_material(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text[]
) FROM PUBLIC, aeostudio_lifecycle_worker, aeostudio_tenant_data_broker;
GRANT EXECUTE ON FUNCTION public.guard_publication_authorization_material(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text[]
) TO aeostudio_runtime;

-- Replace the original broad 0003/0006/0007 DML grants with the Store operations that actually
-- exist. Historical/lineage children remain SELECT/INSERT-only; mutable parents expose only their
-- projection pointer or reviewed status. Lifecycle deletion uses its separate SECURITY DEFINER
-- path and does not depend on runtime DELETE.
REVOKE UPDATE, DELETE ON TABLE
  public.profiles,
  public.profile_revisions,
  public.offerings,
  public.offering_revisions,
  public.offering_attribute_definitions,
  public.offering_attribute_values,
  public.evidence_sources,
  public.evidence_snapshots,
  public.claims,
  public.claim_revisions,
  public.claim_evidence_links,
  public.claim_reviews,
  public.prompt_sets,
  public.prompt_revisions,
  public.measurement_scenarios,
  public.prompt_approvals
FROM aeostudio_runtime;

GRANT UPDATE (current_revision) ON TABLE
  public.profiles,
  public.offerings,
  public.prompt_sets
TO aeostudio_runtime;
GRANT UPDATE (current_snapshot_id) ON TABLE public.evidence_sources TO aeostudio_runtime;
GRANT UPDATE (status) ON TABLE
  public.claim_revisions,
  public.prompt_revisions
TO aeostudio_runtime;
