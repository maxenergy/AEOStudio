-- WordPress authorization covers a site while each publication selects its own content target.
-- Preserve both values so slug/category/product choices never broaden credential authority.
ALTER TABLE publication_records ADD COLUMN authorization_target text;

UPDATE publication_records SET authorization_target = target;

ALTER TABLE publication_records
  ALTER COLUMN authorization_target SET NOT NULL,
  ADD CONSTRAINT publication_records_authorization_target_length_check
    CHECK (length(authorization_target) BETWEEN 1 AND 2048);

DO $block$
DECLARE
  authorization_foreign_key text;
BEGIN
  SELECT constraint_row.conname
    INTO authorization_foreign_key
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'publication_records'::regclass
    AND constraint_row.confrelid = 'channel_authorizations'::regclass
    AND constraint_row.contype = 'f';

  IF authorization_foreign_key IS NULL THEN
    RAISE EXCEPTION 'PUBLICATION_AUTHORIZATION_FOREIGN_KEY_MISSING';
  END IF;
  EXECUTE format(
    'ALTER TABLE publication_records DROP CONSTRAINT %I',
    authorization_foreign_key
  );
END
$block$;

ALTER TABLE publication_records
  ADD CONSTRAINT publication_records_authorization_coverage_fkey
  FOREIGN KEY (
    tenant_id,
    workspace_id,
    channel_authorization_id,
    adapter_version_id,
    authorization_target
  ) REFERENCES channel_authorizations(
    tenant_id,
    workspace_id,
    id,
    adapter_version_id,
    target
  ) ON DELETE RESTRICT;

CREATE FUNCTION reject_publication_authorization_target_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.authorization_target IS DISTINCT FROM OLD.authorization_target THEN
    RAISE EXCEPTION 'PUBLICATION_AUTHORIZATION_TARGET_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER publication_authorization_target_immutable_guard
BEFORE UPDATE OF authorization_target ON publication_records
FOR EACH ROW EXECUTE FUNCTION reject_publication_authorization_target_mutation();

REVOKE ALL ON FUNCTION reject_publication_authorization_target_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reject_publication_authorization_target_mutation()
  TO aeostudio_runtime;

-- Production remains disabled until a real secret-backed Provider transport is installed and its
-- terms are reviewed. Fake composition is test/dev-only and separately forbidden in production.
INSERT INTO channel_definitions
  (id, channel_key, display_name, status, unavailable_reason,
    package_transformer_key, package_schema_version)
VALUES
  ('00000000-0000-7000-8000-000000001020', 'wordpress-woocommerce-draft',
    'WordPress / WooCommerce Draft', 'AVAILABLE', NULL, 'generic-web-package', '1.0.0');

INSERT INTO adapter_versions
  (id, channel_definition_id, adapter_key, adapter_version, enabled, disabled_reason,
    capabilities, required_scopes, terms_version, terms_status, processing_region,
    retention_policy, training_policy, subprocessors, rate_policy)
VALUES
  ('00000000-0000-7000-8000-000000001021',
    '00000000-0000-7000-8000-000000001020',
    'wordpress-woocommerce-draft', '1.0.0', false,
    'Production WordPress Provider runtime is not installed; reviewed package export remains available.',
    ARRAY['PREVIEW','PUBLISH','RECONCILE','ROLLBACK','DRAFT'],
    ARRAY['media:write','pages:write','posts:write','woocommerce:products:write'],
    'wordpress-provider-terms-v1', 'REVIEW_REQUIRED',
    'Provider-configured; no production runtime installed.',
    'No Provider retention policy is asserted until a production runtime is approved.',
    'No training is permitted.', '[]'::jsonb,
    '{"mode":"not-configured"}'::jsonb);
