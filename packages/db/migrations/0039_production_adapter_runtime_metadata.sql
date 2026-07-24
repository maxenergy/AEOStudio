-- Production transports are installed in the Worker image, but activation remains a separate
-- governance decision. Keep every Adapter disabled and review-required while making the durable
-- Registry descriptor exactly match the executable runtime that will be used after approval.

UPDATE adapter_versions
SET
  provider_api_version = '2026-03-10',
  enabled = false,
  terms_status = 'REVIEW_REQUIRED',
  disabled_reason =
    'Production GitHub runtime is installed; Provider terms and operator approval are still required.',
  capabilities = ARRAY['PREVIEW','PUBLISH','RECONCILE','ROLLBACK','PULL_REQUEST_STATUS'],
  required_scopes = ARRAY['contents:write','pull_requests:write','metadata:read'],
  terms_version = 'git-provider-terms-v1',
  processing_region = 'Provider-controlled; authorization policy required.',
  retention_policy = 'Git Provider repository and pull-request retention policy applies.',
  training_policy = 'No training is permitted.',
  subprocessors = '[]'::jsonb,
  rate_policy = '{"mode":"provider-rate-limits"}'::jsonb
WHERE adapter_key = 'git-pull-request' AND adapter_version = '1.0.0';

UPDATE adapter_versions
SET
  provider_api_version = NULL,
  enabled = false,
  terms_status = 'REVIEW_REQUIRED',
  disabled_reason =
    'Production WordPress runtime is installed; Provider terms and operator approval are still required.',
  capabilities = ARRAY['PREVIEW','PUBLISH','RECONCILE','ROLLBACK','DRAFT'],
  required_scopes =
    ARRAY['media:write','pages:write','posts:write','woocommerce:products:write'],
  terms_version = 'wordpress-provider-terms-v1',
  processing_region = 'Tenant-owned site region; authorization policy required.',
  retention_policy = 'Tenant-owned WordPress or WooCommerce retention policy applies.',
  training_policy = 'No training is permitted.',
  subprocessors = '[]'::jsonb,
  rate_policy = '{"mode":"site-rate-limits"}'::jsonb
WHERE adapter_key = 'wordpress-woocommerce-draft' AND adapter_version = '1.0.0';

UPDATE adapter_versions
SET
  provider_api_version = '2026-07',
  enabled = false,
  terms_status = 'REVIEW_REQUIRED',
  disabled_reason =
    'Production Shopify runtime is installed; Provider terms and operator approval are still required.',
  capabilities = ARRAY['PREVIEW','PUBLISH','RECONCILE','ROLLBACK','DRAFT'],
  required_scopes = ARRAY['write_content','write_products'],
  terms_version = 'shopify-provider-terms-v1',
  processing_region = 'Provider-controlled; authorization policy required.',
  retention_policy = 'Shopify Admin API and merchant store retention policy applies.',
  training_policy = 'No training is permitted.',
  subprocessors = '[]'::jsonb,
  rate_policy = '{"mode":"graphql-cost-throttle","providerApiVersion":"2026-07"}'::jsonb
WHERE adapter_key = 'shopify-draft' AND adapter_version = '1.0.0';

UPDATE adapter_versions
SET
  provider_api_version = NULL,
  enabled = false,
  terms_status = 'REVIEW_REQUIRED',
  disabled_reason =
    'Production signed-webhook runtime is installed; receiver terms and operator approval are still required.',
  capabilities = ARRAY['PREVIEW','PUBLISH','RECONCILE'],
  required_scopes = ARRAY['webhook:deliver'],
  terms_version = 'signed-webhook-contract-v1',
  processing_region = 'Verified receiver region; authorization policy required.',
  retention_policy =
    'Only verified receipts and audit hashes may be retained; approved request bodies are not retained by the Adapter.',
  training_policy = 'No training is permitted.',
  subprocessors = '[]'::jsonb,
  rate_policy =
    '{"mode":"receiver-rate-limits","contractVersion":"1.0.0","signatureProfile":"aeostudio-signed-webhook-v1"}'::jsonb
WHERE adapter_key = 'signed-webhook' AND adapter_version = '1.0.0';
