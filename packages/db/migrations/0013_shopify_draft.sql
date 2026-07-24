-- A Provider API version is first-class Registry governance. Null remains valid for unversioned
-- Adapters; versioned Adapters must repeat it in their executable descriptor. A Provider-published
-- support cutoff is separate, typed governance and must not be hidden in open rate-policy JSON.
ALTER TABLE adapter_versions
  ADD COLUMN provider_api_version text,
  ADD COLUMN provider_api_supported_until timestamptz;

ALTER TABLE adapter_versions
  ADD CONSTRAINT adapter_versions_provider_api_version_length_check
  CHECK (
    provider_api_version IS NULL
    OR length(provider_api_version) BETWEEN 1 AND 80
  );

ALTER TABLE adapter_versions
  ADD CONSTRAINT adapter_versions_provider_api_support_requires_version_check
  CHECK (provider_api_supported_until IS NULL OR provider_api_version IS NOT NULL);

-- Production remains export-only until an approved OAuth transport, rotating token lifecycle and
-- reviewed terms are installed. Test/dev composition is separately forbidden in production.
INSERT INTO channel_definitions
  (id, channel_key, display_name, status, unavailable_reason,
    package_transformer_key, package_schema_version)
VALUES
  ('00000000-0000-7000-8000-000000001030', 'shopify-draft',
    'Shopify Draft', 'AVAILABLE', NULL, 'generic-web-package', '1.0.0');

INSERT INTO adapter_versions
  (id, channel_definition_id, adapter_key, adapter_version, provider_api_version,
    provider_api_supported_until,
    enabled, disabled_reason, capabilities, required_scopes, terms_version, terms_status,
    processing_region, retention_policy, training_policy, subprocessors, rate_policy)
VALUES
  ('00000000-0000-7000-8000-000000001031',
    '00000000-0000-7000-8000-000000001030',
    'shopify-draft', '1.0.0', '2026-07', '2027-07-16T15:00:00Z', false,
    'Production Shopify OAuth/Admin GraphQL runtime is not installed; reviewed package export remains available.',
    ARRAY['PREVIEW','PUBLISH','RECONCILE','ROLLBACK','DRAFT'],
    ARRAY['write_content','write_products'],
    'shopify-provider-terms-v1', 'REVIEW_REQUIRED',
    'Provider-configured; no production runtime installed.',
    'No Provider retention policy is asserted until a production runtime is approved.',
    'No training is permitted.', '[]'::jsonb,
    '{"mode":"not-configured","providerApiVersion":"2026-07","supportedUntil":"2027-07-16T15:00:00Z"}'::jsonb);
