-- Production remains disabled until an approved outbound transport, endpoint verification
-- workflow, Secrets Manager key ring and reviewed receiver terms are installed. The explicit
-- test/fake composition enables the same immutable contract identity separately.
INSERT INTO channel_definitions
  (id, channel_key, display_name, status, unavailable_reason,
    package_transformer_key, package_schema_version)
VALUES
  ('00000000-0000-7000-8000-000000001040', 'signed-webhook',
    'Signed Webhook', 'AVAILABLE', NULL, 'generic-web-package', '1.0.0');

INSERT INTO adapter_versions
  (id, channel_definition_id, adapter_key, adapter_version,
    enabled, disabled_reason, capabilities, required_scopes, terms_version, terms_status,
    processing_region, retention_policy, training_policy, subprocessors, rate_policy)
VALUES
  ('00000000-0000-7000-8000-000000001041',
    '00000000-0000-7000-8000-000000001040',
    'signed-webhook', '1.0.0', false,
    'Production signed-webhook transport and endpoint verification are not installed; reviewed package export remains available.',
    ARRAY['PREVIEW','PUBLISH','RECONCILE'],
    ARRAY['webhook:deliver'],
    'signed-webhook-contract-v1', 'REVIEW_REQUIRED',
    'Provider-configured; no production runtime installed.',
    'Only verified receipts and audit hashes may be retained; approved request bodies are not retained by the Adapter.',
    'No training is permitted.', '[]'::jsonb,
    '{"mode":"not-configured","contractVersion":"1.0.0","signatureProfile":"aeostudio-signed-webhook-v1"}'::jsonb);

-- Keep the original four-key lifecycle state valid. A fifth key is accepted only for a bounded,
-- receiver-authenticated signed-webhook receipt. The existing publication mutation guard permits
-- the first RUNNING/RECONCILING -> REMOTE_APPLIED write but has no mutable lifecycle transition
-- for DELIVERED, so this evidence cannot subsequently be replaced or removed.
CREATE OR REPLACE FUNCTION publication_remote_state_is_valid(candidate jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $function$
  SELECT
    jsonb_typeof(candidate) = 'object'
    AND (SELECT count(*) IN (4, 5) FROM jsonb_object_keys(candidate))
    AND candidate ?& ARRAY['status', 'number', 'isProductionLive', 'rollbackHandle']::text[]
    AND jsonb_typeof(candidate -> 'status') = 'string'
    AND (candidate ->> 'status') ~ '^[A-Z][A-Z0-9_]{0,63}$'
    AND CASE jsonb_typeof(candidate -> 'number')
      WHEN 'null' THEN true
      WHEN 'number' THEN
        (candidate ->> 'number')::numeric > 0
        AND (candidate ->> 'number')::numeric <= 9007199254740991
        AND (candidate ->> 'number')::numeric = trunc((candidate ->> 'number')::numeric)
      ELSE false
    END
    AND jsonb_typeof(candidate -> 'isProductionLive') = 'boolean'
    AND CASE jsonb_typeof(candidate -> 'rollbackHandle')
      WHEN 'null' THEN true
      WHEN 'object' THEN
        (SELECT count(*) BETWEEN 1 AND 16
         FROM jsonb_object_keys(candidate -> 'rollbackHandle'))
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_each(candidate -> 'rollbackHandle') AS entry(key, value)
          WHERE entry.key !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
            OR CASE jsonb_typeof(entry.value)
              WHEN 'string' THEN NOT (
                length(entry.value #>> '{}') BETWEEN 1 AND 512
                AND (entry.value #>> '{}') !~ '[[:cntrl:]]'
              )
              WHEN 'number' THEN NOT (
                (entry.value #>> '{}')::numeric >= 0
                AND (entry.value #>> '{}')::numeric <= 9007199254740991
                AND (entry.value #>> '{}')::numeric = trunc((entry.value #>> '{}')::numeric)
              )
              WHEN 'boolean' THEN false
              ELSE true
            END
        )
      ELSE false
    END
    AND CASE WHEN candidate ? 'receiptEvidence' THEN
      (SELECT count(*) = 5 FROM jsonb_object_keys(candidate))
      AND candidate ->> 'status' = 'DELIVERED'
      AND jsonb_typeof(candidate -> 'number') = 'null'
      AND candidate -> 'isProductionLive' = 'false'::jsonb
      AND jsonb_typeof(candidate -> 'rollbackHandle') = 'null'
      AND jsonb_typeof(candidate -> 'receiptEvidence') = 'object'
      AND (
        SELECT count(*) = 8
        FROM jsonb_object_keys(candidate -> 'receiptEvidence')
      )
      AND (candidate -> 'receiptEvidence') ?& ARRAY[
        'schemaVersion', 'receiptId', 'deliveryId', 'receiverEffectId',
        'requestBodySha256', 'verifiedKeyId', 'verifiedAlgorithm', 'receivedAt'
      ]::text[]
      AND jsonb_typeof(candidate #> '{receiptEvidence,schemaVersion}') = 'string'
      AND candidate #>> '{receiptEvidence,schemaVersion}' =
        'signed-webhook-receipt-evidence.v1'
      AND jsonb_typeof(candidate #> '{receiptEvidence,receiptId}') = 'string'
      AND length(candidate #>> '{receiptEvidence,receiptId}') BETWEEN 1 AND 500
      AND (candidate #>> '{receiptEvidence,receiptId}') !~ '[[:cntrl:]]'
      AND jsonb_typeof(candidate #> '{receiptEvidence,deliveryId}') = 'string'
      AND (candidate #>> '{receiptEvidence,deliveryId}') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND jsonb_typeof(candidate #> '{receiptEvidence,receiverEffectId}') = 'string'
      AND length(candidate #>> '{receiptEvidence,receiverEffectId}') BETWEEN 1 AND 500
      AND (candidate #>> '{receiptEvidence,receiverEffectId}') !~ '[[:cntrl:]]'
      AND jsonb_typeof(candidate #> '{receiptEvidence,requestBodySha256}') = 'string'
      AND (candidate #>> '{receiptEvidence,requestBodySha256}') ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(candidate #> '{receiptEvidence,verifiedKeyId}') = 'string'
      AND length(candidate #>> '{receiptEvidence,verifiedKeyId}') BETWEEN 1 AND 120
      AND (candidate #>> '{receiptEvidence,verifiedKeyId}') ~
        '^[A-Za-z0-9][A-Za-z0-9._-]*$'
      AND jsonb_typeof(candidate #> '{receiptEvidence,verifiedAlgorithm}') = 'string'
      AND candidate #>> '{receiptEvidence,verifiedAlgorithm}' IN ('HMAC_SHA256', 'ED25519')
      AND jsonb_typeof(candidate #> '{receiptEvidence,receivedAt}') = 'string'
      AND length(candidate #>> '{receiptEvidence,receivedAt}') BETWEEN 20 AND 35
      AND (candidate #>> '{receiptEvidence,receivedAt}') ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      AND pg_input_is_valid(
        candidate #>> '{receiptEvidence,receivedAt}',
        'timestamp with time zone'
      )
    ELSE
      (SELECT count(*) = 4 FROM jsonb_object_keys(candidate))
    END
    AND octet_length(candidate::text) <= 4096
$function$;

REVOKE ALL ON FUNCTION publication_remote_state_is_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publication_remote_state_is_valid(jsonb) TO aeostudio_runtime;

ALTER TABLE publication_records
  ADD CONSTRAINT publication_records_receipt_delivery_lineage_check CHECK (
    remote_state IS NULL
    OR NOT (remote_state ? 'receiptEvidence')
    OR (
      jsonb_typeof(remote_state -> 'receiptEvidence') = 'object'
      AND remote_state #>> '{receiptEvidence,deliveryId}' = id::text
    )
  );
