CREATE TABLE channel_profiles (
  id uuid PRIMARY KEY,
  channel_definition_id uuid NOT NULL
    REFERENCES channel_definitions(id) ON DELETE RESTRICT,
  channel text NOT NULL
    CHECK (channel ~ '^[a-z0-9][a-z0-9._-]{0,159}$'),
  profile_version text NOT NULL CHECK (length(profile_version) BETWEEN 1 AND 80),
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  field_requirements jsonb NOT NULL CHECK (
    jsonb_typeof(field_requirements) = 'array'
    AND jsonb_array_length(field_requirements) BETWEEN 1 AND 100
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_definition_id, id),
  UNIQUE (channel_definition_id, profile_version),
  UNIQUE (channel_definition_id, profile_hash)
);

ALTER TABLE channel_definitions
  ADD COLUMN current_channel_profile_id uuid,
  ADD CONSTRAINT channel_definition_current_profile_fk
    FOREIGN KEY (id, current_channel_profile_id)
    REFERENCES channel_profiles(channel_definition_id, id)
    ON DELETE RESTRICT;

CREATE FUNCTION reject_channel_profile_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'CHANNEL_PROFILE_IMMUTABLE' USING ERRCODE = 'P0001';
END
$function$;

CREATE TRIGGER channel_profile_immutable_guard
BEFORE UPDATE OR DELETE ON channel_profiles
FOR EACH ROW EXECUTE FUNCTION reject_channel_profile_mutation();

REVOKE ALL ON channel_profiles FROM PUBLIC;
GRANT SELECT ON channel_profiles TO aeostudio_runtime;

-- These are Registry data, not code branches. Each destination remains review/export-only because
-- no Adapter version is registered for it.
INSERT INTO channel_definitions
  (id, channel_key, display_name, status, unavailable_reason,
    package_transformer_key, package_schema_version)
VALUES
  ('00000000-0000-7000-8000-000000001050', 'third-party-site-handoff',
    'Third-party Site Handoff', 'AVAILABLE', NULL, 'generic-web-package', '1.1.0'),
  ('00000000-0000-7000-8000-000000001060', 'social-channel-handoff',
    'Social Channel Handoff', 'AVAILABLE', NULL, 'generic-web-package', '1.1.0'),
  ('00000000-0000-7000-8000-000000001070', 'directory-handoff',
    'Directory Handoff', 'AVAILABLE', NULL, 'generic-web-package', '1.1.0');

INSERT INTO channel_profiles
  (id, channel_definition_id, channel, profile_version, profile_hash, field_requirements)
VALUES
  (
    '00000000-0000-7000-8000-000000001051',
    '00000000-0000-7000-8000-000000001050',
    'third-party-site-handoff',
    '1.0.0',
    '47105ddd224e542a047fc4b28ce127ef0ddeef13ebbbdad79ba60a1e3037ab9b',
    '[
      {"field":"title","sourcePointer":"/title","required":true,"minLength":1,"maxLength":180,"format":"plain-text"},
      {"field":"summary","sourcePointer":"/summary","required":true,"minLength":1,"maxLength":2000,"format":"plain-text"},
      {"field":"disclosure","sourcePointer":"/disclosure","required":true,"minLength":1,"maxLength":800,"format":"plain-text"}
    ]'::jsonb
  ),
  (
    '00000000-0000-7000-8000-000000001061',
    '00000000-0000-7000-8000-000000001060',
    'social-channel-handoff',
    '1.0.0',
    '56bda296dfc9287991e75505bd05c61a4b417a2c864003f6710cb925e21d0bb4',
    '[
      {"field":"post","sourcePointer":"/summary","required":true,"minLength":1,"maxLength":280,"format":"plain-text"},
      {"field":"disclosure","sourcePointer":"/disclosure","required":true,"minLength":1,"maxLength":300,"format":"plain-text"}
    ]'::jsonb
  ),
  (
    '00000000-0000-7000-8000-000000001071',
    '00000000-0000-7000-8000-000000001070',
    'directory-handoff',
    '1.0.0',
    '29f453d7023f06932d0fc0a0087e7ef2b0a63792923f19c04ba5bde28c71cce0',
    '[
      {"field":"name","sourcePointer":"/title","required":true,"minLength":1,"maxLength":160,"format":"plain-text"},
      {"field":"description","sourcePointer":"/summary","required":true,"minLength":1,"maxLength":2000,"format":"plain-text"},
      {"field":"disclosure","sourcePointer":"/disclosure","required":true,"minLength":1,"maxLength":800,"format":"plain-text"}
    ]'::jsonb
  );

UPDATE channel_definitions
SET current_channel_profile_id = CASE channel_key
  WHEN 'third-party-site-handoff' THEN '00000000-0000-7000-8000-000000001051'::uuid
  WHEN 'social-channel-handoff' THEN '00000000-0000-7000-8000-000000001061'::uuid
  WHEN 'directory-handoff' THEN '00000000-0000-7000-8000-000000001071'::uuid
END
WHERE channel_key IN (
  'third-party-site-handoff',
  'social-channel-handoff',
  'directory-handoff'
);

ALTER TABLE channel_packages
  ADD COLUMN channel_profile_hash text,
  ADD CONSTRAINT channel_package_profile_manifest_binding CHECK (
    (
      channel_profile_hash IS NULL
      AND NOT (manifest ? 'channelProfile')
    )
    OR
    (
      channel_profile_hash ~ '^[a-f0-9]{64}$'
      AND manifest ? 'channelProfile'
      AND manifest->'channelProfile'->>'profileHash' = channel_profile_hash
    )
  );

DO $block$
DECLARE
  identity_constraint text;
BEGIN
  SELECT candidate.conname
  INTO identity_constraint
  FROM pg_constraint candidate
  WHERE candidate.conrelid = 'channel_packages'::regclass
    AND candidate.contype = 'u'
    AND (
      SELECT array_agg(attribute.attname::text ORDER BY key.ordinality)
      FROM unnest(candidate.conkey) WITH ORDINALITY AS key(attnum, ordinality)
      JOIN pg_attribute attribute
        ON attribute.attrelid = candidate.conrelid
       AND attribute.attnum = key.attnum
    ) = ARRAY[
      'tenant_id',
      'workspace_id',
      'artifact_revision_id',
      'artifact_content_hash',
      'channel_definition_id',
      'transformer_key',
      'transformer_version',
      'package_schema_version'
    ]::text[];

  IF identity_constraint IS NULL THEN
    RAISE EXCEPTION 'CHANNEL_PACKAGE_BUILD_IDENTITY_CONSTRAINT_NOT_FOUND';
  END IF;
  EXECUTE format('ALTER TABLE channel_packages DROP CONSTRAINT %I', identity_constraint);
END
$block$;

ALTER TABLE channel_packages
  ADD CONSTRAINT channel_packages_build_identity_unique
  UNIQUE NULLS NOT DISTINCT (
    tenant_id,
    workspace_id,
    artifact_revision_id,
    artifact_content_hash,
    channel_definition_id,
    transformer_key,
    transformer_version,
    package_schema_version,
    channel_profile_hash
  );
